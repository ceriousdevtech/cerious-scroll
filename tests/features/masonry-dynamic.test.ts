/**
 * @fileoverview Tests for dynamic-height masonry (no `getItemHeight`).
 *
 * The defining property is that a card's drawn height comes from the DOM, never
 * from a guess — the estimate may only ever influence segments the camera has
 * not reached, exactly as an unmeasured row does today.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';

const GAP = 16;

/** Wildly unpredictable content heights, in the spirit of the table demo. */
const CONTENT_H = (i: number) => 60 + ((i * 53) % 11) * 47;
/**
 * Short cards, used where a segment must NOT cover the viewport on its own.
 * With the tall default a single segment spans ~2,400px, so a sweep that stops
 * early still fills an 800px viewport and the bug hides.
 */
const SHORT_H = (i: number) => 18 + ((i * 29) % 7) * 9;

function host(h = 800, w = 900): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  document.body.appendChild(el);
  return el;
}

/**
 * jsdom performs no layout, so `offsetHeight` is 0 for everything. Stand in for
 * it: a card reports the height its own content implies, which is what a real
 * browser would compute. This is what makes "measured, not guessed" testable.
 */
function stubMeasurement() {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const idx = this.getAttribute('data-measure-index');
      if (idx === null) return 0;
      const short = this.getAttribute('data-short') !== null;
      return short ? SHORT_H(Number(idx)) : CONTENT_H(Number(idx));
    }
  });
}

function makeScroller(total = 5000, over: Record<string, unknown> = {}) {
  const el = host();
  const s = new CeriousScroll(el, total, {
    layout: 'masonry',
    attachScrollbar: true,
    masonry: {
      // No getItemHeight -> dynamic mode.
      renderItem: (i: number, node: HTMLElement) => {
        node.setAttribute('data-measure-index', String(i));
        node.textContent = 'card ' + i;
      },
      gap: GAP,
      columns: 3,
      segmentSize: 50,
      estimatedItemHeight: 300,
      ...over
    }
  });
  return { el, s };
}

const cards = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-element-index]')] as HTMLElement[];

beforeEach(() => { document.body.innerHTML = ''; stubMeasurement(); });
afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  vi.unstubAllGlobals();
});

describe('dynamic-height masonry', () => {
  it('draws every card at its MEASURED height, never the estimate', () => {
    const { el, s } = makeScroller();
    s.renderViewport(800, el, () => {});

    const drawn = cards(el);
    expect(drawn.length).toBeGreaterThan(0);
    for (const node of drawn) {
      const i = Number(node.dataset.elementIndex);
      // 300 is the configured estimate; every drawn card must beat it.
      expect(parseFloat(node.style.height)).toBe(CONTENT_H(i));
    }
    s.dispose();
  });

  it('keeps the gutter exact even though heights were unknown up front', () => {
    const { el, s } = makeScroller();
    s.renderViewport(800, el, () => {});

    const byColumn = new Map<number, { y: number; h: number }[]>();
    for (const node of cards(el)) {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform)!;
      const x = Math.round(parseFloat(m[1]));
      (byColumn.get(x) ?? byColumn.set(x, []).get(x)!).push({
        y: parseFloat(m[2]), h: parseFloat(node.style.height)
      });
    }
    const gaps = new Set<number>();
    for (const col of byColumn.values()) {
      col.sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        gaps.add(Math.round((col[i].y - (col[i - 1].y + col[i - 1].h)) * 100) / 100);
      }
    }
    expect([...gaps]).toEqual([GAP]);
    s.dispose();
  });

  it('maps the scrollbar by card count, with no height knowledge at all', () => {
    // The whole point: the thumb is a fraction of the dataset, not of a pixel
    // total nobody can compute yet.
    const { el, s } = makeScroller(5000);
    const strip = el.querySelector('[data-cerious-scrollbar="content"]') as HTMLElement;
    const segments = s.totalElements;
    expect(parseFloat(strip.style.height)).toBe((segments + 1) * 10);

    for (const pct of [25, 50, 75]) {
      s.handleScrollPercentage(pct);
      const landed = (s.currentElement / segments) * 100;
      expect(Math.abs(landed - pct)).toBeLessThan(3);
    }
    s.dispose();
  });

  it('anchors a far jump instead of measuring everything in between', () => {
    // Counts renderItem from construction and NEVER resets: the failure being
    // guarded against front-loads its cost into the first paint, so a counter
    // reset after that paint would hide exactly the bug this exists to catch.
    let rendered = 0;
    const el = host();
    const s = new CeriousScroll(el, 200_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          rendered++;
          node.setAttribute('data-measure-index', String(i));
        },
        gap: GAP, columns: 3, segmentSize: 24, estimatedItemHeight: 300
      }
    });

    // 200,000 cards at 24 per segment = ~8,334 segments. Landing at 40% means
    // segment ~3,333; chaining there would measure ~80,000 cards.
    s.handleScrollPercentage(40);
    s.renderViewport(800, el, () => {});
    expect(cards(el).length).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(500);

    // Landing somewhere else must not accumulate either.
    s.handleScrollPercentage(85);
    s.renderViewport(800, el, () => {});
    expect(rendered).toBeLessThan(1000);
    s.dispose();
  });

  it('extends the chain by ordinary scrolling rather than anchoring', () => {
    const { el, s } = makeScroller(5000);
    s.renderViewport(800, el, () => {});
    const startSegment = s.currentElement;

    for (let i = 0; i < 40; i++) {
      s.scroll(400, 800);
      s.renderViewport(800, el, () => {});
    }
    expect(s.currentElement).toBeGreaterThan(startSegment);
    // Still measured, still exact, after crossing many segment boundaries.
    for (const node of cards(el)) {
      const i = Number(node.dataset.elementIndex);
      expect(parseFloat(node.style.height)).toBe(CONTENT_H(i));
    }
    s.dispose();
  });

  it('re-measures after a width change, since heights were width-dependent', () => {
    const { el, s } = makeScroller(5000, { columns: undefined, targetColumnWidth: 280 });
    s.renderViewport(800, el, () => {});
    const before = cards(el).length;
    expect(before).toBeGreaterThan(0);
    // Heights taken at the old column width must not survive a reflow.
    Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
    s.renderViewport(800, el, () => {});
    expect(cards(el).length).toBeGreaterThan(0);
    s.dispose();
  });

  it('survives dragging BACK past a far landing', () => {
    // Regression: the frontier used a single high-water mark, which anchoring
    // advanced without filling the gap behind it. Dragging back then read an
    // unwritten slot -> undefined -> NaN positions, seen as the view snapping.
    const { el, s } = makeScroller(200_000);
    const seen: number[] = [];
    for (const pct of [90, 10, 70, 25, 95, 5]) {
      s.handleScrollPercentage(pct);
      s.renderViewport(800, el, () => {});
      const nodes = cards(el);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform)!;
        expect(Number.isNaN(parseFloat(m[2]))).toBe(false);
        expect(Number.isNaN(parseFloat(node.style.height))).toBe(false);
      }
      seen.push(nodes.length);
    }
    expect(seen.every((n) => n > 0)).toBe(true);
    s.dispose();
  });

  it('never lets a height query trigger measurement', () => {
    // Regression: querying a segment outside the established range made the
    // layout anchor there and lay it out, re-basing the range the camera was
    // using. The engine probes the LAST segment for true-bottom every frame, so
    // this measured the whole dataset — a hard freeze at scale.
    let rendered = 0;
    const el = host();
    const s = new CeriousScroll(el, 200_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          rendered++;
          node.setAttribute('data-measure-index', String(i));
        },
        gap: GAP, columns: 3, segmentSize: 24, estimatedItemHeight: 300
      }
    });

    // Probe every extreme the engine itself reaches for, counting from the
    // start so a cost front-loaded into the first paint still registers.
    const last = s.totalElements - 1;
    for (const seg of [0, 1, last, last - 1, Math.floor(last / 2)]) {
      expect(Number.isFinite(s.getElementHeight(seg))).toBe(true);
    }
    s.renderViewport(800, el, () => {});
    for (const seg of [0, last, Math.floor(last / 3)]) {
      expect(Number.isFinite(s.getElementHeight(seg))).toBe(true);
    }
    expect(rendered).toBeLessThan(500);
    s.dispose();
  });

  it('jumpToItem resolves without measuring the dataset', () => {
    // Regression: jumpToItem went through locateItem + segmentAtY, which binary
    // searches segment ORIGINS. Every probe asked for a frontier the range did
    // not hold, so each step anchored, re-based and re-measured — 8.6s to reach
    // card 400,000 of 500,000. The segment a card is in is pure arithmetic.
    let rendered = 0;
    const el = host();
    const s = new CeriousScroll(el, 500_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          rendered++;
          node.setAttribute('data-measure-index', String(i));
        },
        gap: GAP, columns: 3, segmentSize: 24, estimatedItemHeight: 300
      }
    });
    s.renderViewport(800, el, () => {});
    s.jumpToItem(400_000);
    s.renderViewport(800, el, () => {});

    const drawn = cards(el).map((n) => Number(n.dataset.elementIndex));
    expect(drawn.length).toBeGreaterThan(0);
    expect(Math.max(...drawn)).toBeGreaterThan(399_000);
    expect(rendered).toBeLessThan(1000);
    s.dispose();
  });

  it('fills the viewport rather than leaving a blank band', () => {
    // Regression: the sweep stopped at camera+1 and skipped any segment whose
    // frontier a BUDGETED chain had not finished. Uses SHORT cards so a segment
    // spans far less than the viewport — with tall cards one segment covers the
    // fold by itself and an early-stopping sweep looks fine.
    const el = host();
    const s = new CeriousScroll(el, 200_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          node.setAttribute('data-measure-index', String(i));
          node.setAttribute('data-short', '');
        },
        gap: GAP, columns: 3, segmentSize: 24, estimatedItemHeight: 40
      }
    });

    for (const pct of [12, 37, 58, 74]) {
      s.handleScrollPercentage(pct);
      s.renderViewport(800, el, () => {});

      const deepest = new Map<number, number>();
      for (const node of cards(el)) {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform)!;
        const x = Math.round(parseFloat(m[1]));
        deepest.set(x, Math.max(deepest.get(x) ?? -Infinity,
          parseFloat(m[2]) + parseFloat(node.style.height)));
      }
      expect(deepest.size).toBeGreaterThan(0);
      // Mid-dataset there is no ragged tail to excuse a short column.
      for (const bottom of deepest.values()) expect(bottom).toBeGreaterThanOrEqual(800);
    }
    s.dispose();
  });

  it('reaches the true bottom even when the estimate is badly wrong', () => {
    // Regression: the final segment has no real height until the PAST-THE-END
    // frontier exists, so the camera settled against an ESTIMATE. The estimate
    // here is ~10x the real card height, which is what makes the camera land
    // beyond every card and the viewport come up empty.
    const el = host();
    const s = new CeriousScroll(el, 200_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          node.setAttribute('data-measure-index', String(i));
          node.setAttribute('data-short', '');
        },
        gap: GAP, columns: 3, segmentSize: 24, estimatedItemHeight: 500
      }
    });

    s.handleScrollPercentage(100);
    s.renderViewport(800, el, () => {});

    const drawn = cards(el);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.some((n) => Number(n.dataset.elementIndex) === 199_999)).toBe(true);
    s.dispose();
  });

  it('resizes after a deep scroll without re-measuring the dataset', () => {
    // Regression: a resize invalidates every frontier, and the rebuild then
    // chained from segment 0 up to the camera. After scrolling to card 400,000
    // that measured 500,010 cards across 384 frames — the browser appearing to
    // lock up, then "catch up" slowly. Dynamic mode must anchor at the camera's
    // segment instead, exactly as a far jump does.
    const raf: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => raf.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => { /* noop */ });

    let built = 0;
    const el = host();
    Object.defineProperty(el, 'clientWidth', { value: 1200, configurable: true });
    const s = new CeriousScroll(el, 500_000, {
      layout: 'masonry',
      attachScrollbar: false,
      masonry: {
        renderItem: (i: number, node: HTMLElement) => {
          built++;
          node.setAttribute('data-measure-index', String(i));
        },
        gap: GAP, targetColumnWidth: 300, estimatedItemHeight: 300
      }
    });
    s.renderViewport(800, el, () => {});
    s.jumpToItem(400_000);
    s.renderViewport(800, el, () => {});

    const renderer = (s as unknown as { masonry: {
      handleResize: (h: unknown, cb: () => void) => void; columns: number;
    } }).masonry;
    const shim = {
      get currentElement() { return s.currentElement; },
      get scrollOffset() { return s.scrollOffset; },
      jumpToPosition: (a: number, b: number, c?: boolean) => s.jumpToPosition(a, b, c),
      syncViewportHeight: (h: number) => s.syncViewportHeight(h),
      refreshScrollbarMetrics: () => s.refreshScrollbarMetrics(),
      updateDisplay: () => s.updateDisplay()
    };

    raf.length = 0;
    built = 0;
    Object.defineProperty(el, 'clientWidth', { value: 700, configurable: true });
    renderer.handleResize(shim, () => { s.renderViewport(800, el, () => {}); });
    let rounds = 0;
    while (raf.length && rounds < 2000) { raf.splice(0).forEach((cb) => cb(0)); rounds++; }

    // A couple of segments' worth, not the dataset.
    expect(built).toBeLessThan(2000);

    // And scrolling afterwards must be immediate, not a long catch-up.
    built = 0;
    for (let i = 0; i < 20; i++) { s.scroll(500, 800); s.renderViewport(800, el, () => {}); }
    expect(built).toBeLessThan(2000);

    // The reading position survived the relayout.
    const drawn = cards(el).map((n) => Number(n.dataset.elementIndex));
    expect(Math.min(...drawn)).toBeGreaterThan(380_000);
    s.dispose();
  });

  it('still supports oracle mode when getItemHeight IS supplied', () => {
    const el = host();
    const s = new CeriousScroll(el, 5000, {
      layout: 'masonry',
      attachScrollbar: true,
      masonry: {
        getItemHeight: () => 250,
        renderItem: (i: number, n: HTMLElement) => { n.textContent = String(i); },
        gap: GAP, columns: 3, segmentSize: 50
      }
    });
    s.renderViewport(800, el, () => {});
    for (const node of cards(el)) expect(parseFloat(node.style.height)).toBe(250);
    // Oracle mode knows a real total, so the strip is sized in pixels.
    const strip = el.querySelector('[data-cerious-scrollbar="content"]') as HTMLElement;
    expect(parseFloat(strip.style.height)).toBeGreaterThan((s.totalElements + 1) * 10);
    s.dispose();
  });
});
