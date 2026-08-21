/**
 * @fileoverview Tests for masonry relayout and the sliced chain rebuild.
 *
 * These paths were previously only verified in a browser. jsdom has no
 * ResizeObserver and no real layout, but neither is actually needed: the
 * observer is plumbing, and the logic under test is driven by
 * `handleResize` + a frame queue. Two levers make it deterministic —
 * `clientWidth` is defined per-test, and `rebuildSliceMs: 0` forces the chain to
 * yield after exactly one segment per frame.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MasonryRenderer, MasonryHost } from '../../src/features/masonry-renderer.js';

const GAP = 16;
const heightOf = (i: number) => 120 + ((i * 37) % 9) * 45;

let frames: FrameRequestCallback[] = [];

/** Run queued frames until the queue drains. Returns how many rounds it took. */
function flushFrames(max = 500): number {
  let rounds = 0;
  while (frames.length && rounds < max) {
    const batch = frames;
    frames = [];
    for (const cb of batch) cb(0);
    rounds++;
  }
  return rounds;
}

/** Minimal engine stand-in: records what the renderer asks of it. */
function makeHost() {
  const state = { currentElement: 0, scrollOffset: 0, refreshes: 0, jumps: [] as number[][] };
  const host: MasonryHost = {
    get currentElement() { return state.currentElement; },
    get scrollOffset() { return state.scrollOffset; },
    jumpToPosition(element: number, offset: number) {
      state.currentElement = element;
      state.scrollOffset = offset;
      state.jumps.push([element, offset]);
      return null;
    },
    syncViewportHeight: (h: number) => h,
    refreshScrollbarMetrics() { state.refreshes++; },
    updateDisplay() { /* noop */ }
  };
  return { host, state };
}

function container(width: number, height = 900): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

function setWidth(el: HTMLElement, width: number): void {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
}

function makeRenderer(el: HTMLElement, over: Record<string, unknown> = {}) {
  return new MasonryRenderer(el, 4000, {
    getItemHeight: (i: number) => heightOf(i),
    renderItem: (i: number, node: HTMLElement) => { node.textContent = String(i); },
    gap: GAP,
    targetColumnWidth: 280,
    segmentSize: 100,
    ...over
  } as never);
}

const cardsIn = (el: HTMLElement) => el.querySelectorAll('[data-element-index]').length;
const screenYof = (el: HTMLElement, index: number): number | null => {
  const node = el.querySelector(`[data-element-index="${index}"]`) as HTMLElement | null;
  if (!node) return null;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform);
  return m ? parseFloat(m[2]) : null;
};

beforeEach(() => {
  document.body.innerHTML = '';
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { /* noop */ });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MasonryRenderer resize', () => {
  it('relayouts on a width change and leaves the column count responsive', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host } = makeHost();
    expect(r.columns).toBe(4);

    setWidth(el, 620);
    r.handleResize(host, () => r.render(900, el, host));
    flushFrames();
    expect(r.columns).toBe(2);
    expect(r.columnWidth).toBeGreaterThan(0);
  });

  it('ignores a height-only change without rebuilding', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host } = makeHost();
    r.render(900, el, host);
    const before = r.columns;

    let rendered = 0;
    r.handleResize(host, () => { rendered++; });
    expect(r.columns).toBe(before);
    expect(rendered).toBe(1);      // re-rendered, not rebuilt
    expect(frames.length).toBe(0); // no rebuild scheduled
  });

  it('holds its anchor card at the same screen position across a relayout', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host, state } = makeHost();
    host.jumpToPosition(12, 400);
    r.render(900, el, host);

    // Only the ANCHOR is guaranteed to hold — every other card moves, because
    // the columns are re-flowed. Asserting on an arbitrary mounted card passes
    // vacuously when it is culled, and fails by ~200px when it is not.
    const before = r.anchorItem;
    expect(before).not.toBeNull();

    setWidth(el, 900);
    r.handleResize(host, () => r.render(900, el, host));
    flushFrames();

    // Compare in content space so the check does not depend on the card
    // happening to be remounted.
    const found = r.locateItem(before!.index);
    expect(found).not.toBeNull();
    const cameraY = r.segmentOrigin(state.currentElement) + state.scrollOffset;
    expect(found!.y - cameraY).toBeCloseTo(before!.screenY, 0);
  });

  it('recycles every mounted card rather than leaking them', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host } = makeHost();
    host.jumpToPosition(8, 200);
    r.render(900, el, host);
    const before = cardsIn(el);
    expect(before).toBeGreaterThan(0);

    setWidth(el, 700);
    r.handleResize(host, () => r.render(900, el, host));
    flushFrames();

    // Bounded after, and no orphans left behind from the old geometry.
    expect(cardsIn(el)).toBeGreaterThan(0);
    expect(cardsIn(el)).toBeLessThan(before + 60);
    expect(r.mountedCount).toBe(cardsIn(el));
  });

  it('re-sizes the scrollbar after the layout changes', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host, state } = makeHost();
    r.render(900, el, host);
    const before = state.refreshes;

    setWidth(el, 640);
    r.handleResize(host, () => r.render(900, el, host));
    flushFrames();
    expect(state.refreshes).toBeGreaterThan(before);
  });
});

describe('MasonryRenderer sliced rebuild', () => {
  it('spreads the rebuild across frames instead of one blocking pass', () => {
    const el = container(1200);
    // budget 0 => the chain yields after each segment, so slices are countable.
    const r = makeRenderer(el, { rebuildSliceMs: 0 });
    const { host } = makeHost();
    host.jumpToPosition(30, 0); // deep enough that the chain has real work
    r.render(900, el, host);

    setWidth(el, 700);
    r.handleResize(host, () => r.render(900, el, host));
    const rounds = flushFrames();
    // Camera is at segment 30, so the chain has 30 segments to walk and yields
    // after each. A single round would mean the budget was ignored.
    expect(rounds).toBeGreaterThanOrEqual(10);
  });

  it('holds the previous view while rebuilding, then swaps', () => {
    const el = container(1200);
    const r = makeRenderer(el, { rebuildSliceMs: 0 });
    const { host } = makeHost();
    host.jumpToPosition(25, 0);
    r.render(900, el, host);
    const heldCards = cardsIn(el);
    expect(heldCards).toBeGreaterThan(0);

    setWidth(el, 700);
    r.handleResize(host, () => r.render(900, el, host));

    // Mid-rebuild: render is a no-op and the old cards are still mounted, so the
    // page shows a stale-but-coherent view rather than blanking.
    r.render(900, el, host);
    expect(cardsIn(el)).toBe(heldCards);

    flushFrames();
    expect(cardsIn(el)).toBeGreaterThan(0);
  });

  it('runs the background tail chain so total height settles to exact', () => {
    const el = container(1200);
    const r = makeRenderer(el, { rebuildSliceMs: 0 });
    const { host, state } = makeHost();
    r.render(900, el, host);

    r.scheduleTailChain(host);
    const rounds = flushFrames();
    expect(rounds).toBeGreaterThan(0);
    // The chain reaching the end triggers a final scrollbar re-size.
    expect(state.refreshes).toBeGreaterThan(0);
  });

  it('observeResize is a no-op when ResizeObserver is unavailable', () => {
    const el = container(1200);
    const r = makeRenderer(el);
    const { host } = makeHost();
    const saved = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    vi.stubGlobal('ResizeObserver', undefined);
    const detach = r.observeResize(host, () => {});
    expect(typeof detach).toBe('function');
    detach();
    if (saved) vi.stubGlobal('ResizeObserver', saved);
  });

  it('dispose clears the DOM and cancels pending frames', () => {
    const el = container(1200);
    const r = makeRenderer(el, { rebuildSliceMs: 0 });
    const { host } = makeHost();
    r.render(900, el, host);
    expect(cardsIn(el)).toBeGreaterThan(0);

    setWidth(el, 700);
    r.handleResize(host, () => r.render(900, el, host)); // leaves a frame pending
    r.dispose();

    expect(cardsIn(el)).toBe(0);
    expect(r.mountedCount).toBe(0);
    expect(() => flushFrames()).not.toThrow();
  });
});
