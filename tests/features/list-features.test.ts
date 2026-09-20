/**
 * @fileoverview ARIA, infinite loading, snapping, sticky headers, RTL and SSR
 * hydration.
 *
 * Each of these is opt-in, so every block also pins the OFF case. A feature
 * that quietly changes the default behaviour of a scroller that never asked for
 * it is worse than one that is missing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';

const ROW_H = 40;

function host(h = 400, w = 300): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: h });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: w });
  document.body.appendChild(el);
  return el;
}

/** jsdom lays nothing out, so rows report a fixed height. */
function stubHeights(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.elementIndex !== undefined ? ROW_H : 0;
    }
  });
}

const render = (i: number, el: HTMLElement) => { el.textContent = 'row ' + i; };
const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-element-index]')] as HTMLElement[];

beforeEach(() => { document.body.innerHTML = ''; stubHeights(); });
afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  vi.unstubAllGlobals();
});

describe('aria', () => {
  it('states the real size and position, not the rendered window', () => {
    // The defect this repairs: a reader counting the DOM announces "3 of 12"
    // for a dataset of half a million.
    const el = host();
    const s = new CeriousScroll(el, 500_000, {
      attachScrollbar: false,
      aria: { enabled: true, label: 'People' }
    });
    s.renderViewport(400, el, render);

    expect(el.getAttribute('role')).toBe('list');
    expect(el.getAttribute('aria-label')).toBe('People');
    const drawn = rows(el);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(500_000);
    for (const row of drawn) {
      const index = Number(row.dataset.elementIndex);
      expect(row.getAttribute('role')).toBe('listitem');
      expect(row.getAttribute('aria-setsize')).toBe('500000');
      expect(row.getAttribute('aria-posinset')).toBe(String(index + 1));
    }
    s.dispose();
  });

  it('leaves real table semantics alone and uses row indices instead', () => {
    // <tr> already means row. Layering role="listitem" over it would replace
    // correct semantics with worse ones.
    const el = host();
    const s = new CeriousScroll(el, 9000, {
      attachScrollbar: false,
      layout: 'table',
      aria: { enabled: true }
    });
    s.renderViewport(400, el, render);

    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-rowcount')).toBe('9000');
    for (const row of rows(el)) {
      const index = Number(row.dataset.elementIndex);
      expect(row.getAttribute('role')).toBeNull();
      expect(row.getAttribute('aria-setsize')).toBeNull();
      // 1-based and counting the header, as a real table does.
      expect(row.getAttribute('aria-rowindex')).toBe(String(index + 2));
    }
    s.dispose();
  });

  it('keeps aria-rowcount truthful as the dataset grows', () => {
    const el = host();
    const s = new CeriousScroll(el, 100, {
      attachScrollbar: false, layout: 'table', aria: { enabled: true }
    });
    s.renderViewport(400, el, render);
    expect(el.getAttribute('aria-rowcount')).toBe('100');
    s.updateTotalElements(250);
    expect(el.getAttribute('aria-rowcount')).toBe('250');
    s.dispose();
  });

  it('adds nothing at all when not asked', () => {
    const el = host();
    const s = new CeriousScroll(el, 100, { attachScrollbar: false });
    s.renderViewport(400, el, render);
    expect(el.getAttribute('role')).toBeNull();
    expect(rows(el)[0].getAttribute('aria-posinset')).toBeNull();
    s.dispose();
  });
});

describe('infinite', () => {
  function setup(over: Record<string, unknown> = {}) {
    const el = host();
    const onLoadMore = vi.fn();
    const s = new CeriousScroll(el, 60, {
      attachScrollbar: false,
      infinite: { onLoadMore, threshold: 10, ...over }
    });
    return { el, s, onLoadMore, draw: () => s.renderViewport(400, el, render) };
  }

  it('asks once as the end approaches', () => {
    const { el, s, onLoadMore, draw } = setup();
    draw();
    expect(onLoadMore).not.toHaveBeenCalled();

    s.jumpToElement(55);
    draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(onLoadMore.mock.calls[0][0]).toMatchObject({ direction: 'end', total: 60 });

    // Still near the end: must NOT ask again, or a callback that appends
    // nothing spins once per frame.
    draw();
    draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    s.dispose();
    void el;
  });

  it('re-arms once the window leaves the threshold', () => {
    const { s, onLoadMore, draw } = setup();
    s.jumpToElement(55); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    s.jumpToElement(0); draw();      // away
    s.jumpToElement(55); draw();     // back
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it('waits for an async load before asking again', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const onLoadMore = vi.fn(() => pending);
    const el = host();
    const s = new CeriousScroll(el, 60, {
      attachScrollbar: false,
      infinite: { onLoadMore, threshold: 10 }
    });
    const draw = () => s.renderViewport(400, el, render);

    s.jumpToElement(55); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // Dataset grew, window moved away and back — but the first load is still
    // in flight, so nothing further is asked.
    s.updateTotalElements(120);
    s.jumpToElement(0); draw();
    s.jumpToElement(115); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    release();
    await pending;
    s.jumpToElement(0); draw();
    s.jumpToElement(115); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it('re-arms when the dataset grows, not only when the window moves', () => {
    // A viewer parked at the bottom never leaves the threshold, so growth is
    // the only signal that the previous ask is stale.
    const { s, onLoadMore, draw } = setup();
    s.jumpToElement(55); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    s.updateTotalElements(120);
    s.jumpToElement(115); draw();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it('watches the start only when asked', () => {
    const a = setup();
    a.s.jumpToElement(0); a.draw();
    expect(a.onLoadMore).not.toHaveBeenCalled();
    a.s.dispose();

    const b = setup({ edges: 'both' });
    b.s.jumpToElement(0); b.draw();
    expect(b.onLoadMore).toHaveBeenCalledWith(expect.objectContaining({ direction: 'start' }));
    b.s.dispose();
  });
});

describe('snap', () => {
  /** Reach the settle hook the native surface calls when motion stops. */
  const settle = (s: CeriousScroll) =>
    (s as unknown as { snapToBoundary(): void }).snapToBoundary();

  it('settles onto the nearer row boundary', () => {
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false, snap: { enabled: true } });
    s.renderViewport(400, el, render);

    s.jumpToPosition(10, 30);      // 30 of 40px: past halfway
    settle(s);
    expect([s.currentElement, s.scrollOffset]).toEqual([11, 0]);

    s.jumpToPosition(10, 8);       // 8 of 40px: nearer the top
    settle(s);
    expect([s.currentElement, s.scrollOffset]).toEqual([10, 0]);
    s.dispose();
  });

  it("align: 'start' always settles backwards", () => {
    const el = host();
    const s = new CeriousScroll(el, 500, {
      attachScrollbar: false, snap: { enabled: true, align: 'start' }
    });
    s.renderViewport(400, el, render);
    s.jumpToPosition(10, 30);
    settle(s);
    expect([s.currentElement, s.scrollOffset]).toEqual([10, 0]);
    s.dispose();
  });

  it('leaves a camera that already landed alone', () => {
    // Without the tolerance a scroll that finished on a boundary would nudge
    // itself afterwards, which reads as a glitch rather than a snap.
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false, snap: { enabled: true } });
    s.renderViewport(400, el, render);
    s.jumpToPosition(10, 1);
    settle(s);
    expect([s.currentElement, s.scrollOffset]).toEqual([10, 1]);
    s.dispose();
  });

  it('does nothing when not enabled', () => {
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false });
    s.renderViewport(400, el, render);
    s.jumpToPosition(10, 30);
    settle(s);
    expect([s.currentElement, s.scrollOffset]).toEqual([10, 30]);
    s.dispose();
  });
});

describe('sticky', () => {
  // Section header every 25 rows.
  const resolve = (index: number) => Math.floor(index / 25) * 25;

  /**
   * The pinned header is deliberately not `data-element-index`, so the shared
   * height stub returns 0 for it and no push can be computed. Give it the same
   * height a header row has.
   */
  function stubStickyHeight(px = ROW_H): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute('data-cerious-sticky')) return px;
        return this.dataset.elementIndex !== undefined ? ROW_H : 0;
      }
    });
  }

  it('is pushed out by the incoming header instead of covering it', () => {
    stubStickyHeight();
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false, sticky: { resolve } });
    const draw = () => s.renderViewport(400, el, render);
    const pinned = () => el.querySelector('[data-cerious-sticky]') as HTMLElement;

    // Row 25 starts the next section. Parked on row 24 with no offset, it sits
    // exactly one row down — outside the pinned header's band, nothing to do.
    s.jumpToPosition(24, 0);
    draw();
    expect(pinned().style.transform).toBe('');

    // Creeping forward brings row 25 into the band. The pinned header lifts by
    // exactly the overlap, so its bottom edge lands on the incoming header's
    // top edge and the two never overlap. Before this, it stayed at top:0 with
    // a higher z-index and the incoming header vanished behind it.
    for (const offset of [10, 25, 39]) {
      s.jumpToPosition(24, offset);
      draw();
      expect(pinned().style.transform).toBe(`translateY(${-offset}px)`);
    }
    s.dispose();
  });

  it('drops the push once the incoming header has taken over', () => {
    stubStickyHeight();
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false, sticky: { resolve } });
    const draw = () => s.renderViewport(400, el, render);
    const pinned = () => el.querySelector('[data-cerious-sticky]') as HTMLElement;

    s.jumpToPosition(24, 30);
    draw();
    expect(pinned().style.transform).not.toBe('');

    s.jumpToPosition(25, 0);
    draw();
    expect(pinned().dataset.stickyIndex).toBe('25');
    expect(pinned().style.transform).toBe('');
    s.dispose();
  });

  it('pins the section header and swaps it at the boundary', () => {
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false, sticky: { resolve } });
    s.renderViewport(400, el, render);

    const pinned = () => el.querySelector('[data-cerious-sticky]') as HTMLElement | null;
    expect(pinned()?.dataset.stickyIndex).toBe('0');

    s.jumpToElement(30);
    s.renderViewport(400, el, render);
    expect(pinned()?.dataset.stickyIndex).toBe('25');
    expect(pinned()?.textContent).toBe('row 25');
    s.dispose();
  });

  it('survives the recycler, which is the whole point', () => {
    // A header drawn as an ordinary row is unmounted the moment it leaves the
    // window — exactly when it is needed. It must live outside the recycler.
    const el = host();
    const s = new CeriousScroll(el, 500, {
      attachScrollbar: false,
      // One header for the whole list, so it is unambiguously far behind.
      sticky: { resolve: () => 0 }
    });
    s.jumpToElement(200);
    s.renderViewport(400, el, render);

    const pinned = el.querySelector('[data-cerious-sticky]') as HTMLElement;
    expect(pinned.dataset.stickyIndex).toBe('0');
    expect(pinned.textContent).toBe('row 0');
    // And it is not mistaken for a rendered row.
    expect(pinned.hasAttribute('data-element-index')).toBe(false);

    // The recycled window is nowhere near row 0, which is exactly the case a
    // header rendered as an ordinary row cannot survive.
    const drawn = rows(el).map(r => Number(r.dataset.elementIndex));
    expect(Math.min(...drawn)).toBeGreaterThan(100);
    s.dispose();
  });

  it('removes the header when the resolver returns null', () => {
    const el = host();
    const s = new CeriousScroll(el, 500, {
      attachScrollbar: false,
      sticky: { resolve: (i) => (i < 100 ? 0 : null) }
    });
    s.renderViewport(400, el, render);
    expect(el.querySelector('[data-cerious-sticky]')).not.toBeNull();

    s.jumpToElement(200);
    s.renderViewport(400, el, render);
    expect(el.querySelector('[data-cerious-sticky]')).toBeNull();
    s.dispose();
  });

  it('adds nothing when not configured, and cleans up on dispose', () => {
    const el = host();
    const s = new CeriousScroll(el, 500, { attachScrollbar: false });
    s.renderViewport(400, el, render);
    expect(el.querySelector('[data-cerious-sticky]')).toBeNull();
    s.dispose();

    const el2 = host();
    const s2 = new CeriousScroll(el2, 500, { attachScrollbar: false, sticky: { resolve } });
    s2.renderViewport(400, el2, render);
    s2.dispose();
    expect(el2.querySelector('[data-cerious-sticky]')).toBeNull();
  });
});

describe('direction', () => {
  it('reads the host rather than requiring the option', () => {
    // Direction is nearly always inherited, and a host that has to restate it
    // in JavaScript will eventually disagree with the page around it.
    const el = host();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      { direction: 'rtl' } as unknown as CSSStyleDeclaration
    );
    const s = new CeriousScroll(el, 100, { attachScrollbar: false });
    expect(s.direction).toBe('rtl');
    s.dispose();
    vi.restoreAllMocks();
  });

  it('takes an explicit option over the computed value', () => {
    const el = host();
    const s = new CeriousScroll(el, 100, { attachScrollbar: false, direction: 'rtl' });
    expect(s.direction).toBe('rtl');
    s.dispose();
  });

  it('puts the scrollbar strip on the left in RTL', () => {
    const el = host();
    const s = new CeriousScroll(el, 5000, { direction: 'rtl' });
    const strip = el.querySelector('[data-cerious-scrollbar="container"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.style.left).toBe('0px');
    expect(strip.style.right).toBe('');
    s.dispose();
  });

  it('defaults to ltr with the strip on the right', () => {
    const el = host();
    const s = new CeriousScroll(el, 5000, {});
    const strip = el.querySelector('[data-cerious-scrollbar="container"]') as HTMLElement;
    expect(s.direction).toBe('ltr');
    expect(strip.style.right).toBe('0px');
    s.dispose();
  });
});

describe('ssr', () => {
  it('adopts server-rendered rows instead of discarding them', () => {
    const el = host();
    // What a server emitted: real rows, already carrying their identity.
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.dataset.elementIndex = String(i);
      row.textContent = 'server ' + i;
      row.setAttribute('data-from-server', '');
      el.appendChild(row);
    }
    const serverNodes = [...el.children];

    const s = new CeriousScroll(el, 500, { attachScrollbar: false, ssr: { hydrate: true } });
    s.renderViewport(400, el, render);

    // The same ELEMENTS are still in the tree — not replacements that happen to
    // look alike, which is what a flash of re-rendered content would be.
    for (const node of serverNodes) {
      expect(node.isConnected).toBe(true);
      expect(node.hasAttribute('data-from-server')).toBe(true);
    }
    s.dispose();
  });

  it('leaves server markup stranded when hydration is off', () => {
    // The failure hydration exists to prevent, stated plainly: the renderer has
    // no record of markup it did not create, so it builds its own row for the
    // same index and the page ends up with two of them.
    const el = host();
    const stale = document.createElement('div');
    stale.dataset.elementIndex = '0';
    stale.setAttribute('data-from-server', '');
    el.appendChild(stale);

    const s = new CeriousScroll(el, 500, { attachScrollbar: false });
    s.renderViewport(400, el, render);
    expect(el.querySelectorAll('[data-element-index="0"]').length).toBe(2);
    s.dispose();
  });

  it('adopts rather than duplicating, which is the difference', () => {
    const el = host();
    const stale = document.createElement('div');
    stale.dataset.elementIndex = '0';
    stale.setAttribute('data-from-server', '');
    el.appendChild(stale);

    const s = new CeriousScroll(el, 500, { attachScrollbar: false, ssr: { hydrate: true } });
    s.renderViewport(400, el, render);
    expect(el.querySelectorAll('[data-element-index="0"]').length).toBe(1);
    expect(el.querySelector('[data-from-server]')).not.toBeNull();
    s.dispose();
  });
});
