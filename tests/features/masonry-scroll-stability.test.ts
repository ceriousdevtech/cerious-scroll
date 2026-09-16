/**
 * @fileoverview Dynamic masonry must not re-lay-out itself while the viewer scrolls.
 *
 * Every test here is a flicker: something on the scroll path invalidates the
 * layout, the columns re-pack, and cards visibly jump under the reader. The
 * assertions are all about STABILITY — the same camera must draw the same grid.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MasonryRenderer, MasonryHost } from '../../src/features/masonry-renderer.js';
import { MasonryLayout } from '../../src/features/masonry-layout.js';

const GAP = 16;
/** Wildly uneven, so any re-pack shows up as a column change. */
const LIVE_H = (i: number) => 60 + ((i * 53) % 11) * 47;

let frames: FrameRequestCallback[] = [];
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function flushFrames(max = 2000): number {
  let rounds = 0;
  while (frames.length && rounds < max) {
    const batch = frames;
    frames = [];
    for (const cb of batch) cb(0);
    rounds++;
  }
  return rounds;
}

function makeHost() {
  const state = { currentElement: 0, scrollOffset: 0, jumps: [] as number[][] };
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
    refreshScrollbarMetrics() { /* noop */ },
    updateDisplay() { /* noop */ }
  };
  return { host, state };
}

function container(width = 620, height = 900): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** Heights the fake DOM reports, so a test can make a card genuinely grow. */
let liveHeights: Map<number, number>;

function stubMeasurement(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const index = Number(this.dataset.liveIndex);
      if (!Number.isInteger(index)) return 0;
      return liveHeights.get(index) ?? LIVE_H(index);
    }
  });
}

/** Captures the ResizeObserver callback so a test can deliver observations. */
function stubResizeObserver(): { fire: (targets: HTMLElement[]) => void } {
  let cb: ResizeObserverCallback | null = null;
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) { cb = callback; }
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  return {
    fire(targets: HTMLElement[]) {
      cb?.(targets.map((t) => ({ target: t }) as ResizeObserverEntry), {} as ResizeObserver);
    }
  };
}

function dynamicRenderer(el: HTMLElement, total = 5000, over: Record<string, unknown> = {}) {
  return new MasonryRenderer(el, total, {
    // No getItemHeight -> heights come from the DOM.
    renderItem: (i: number, node: HTMLElement) => { node.dataset.liveIndex = String(i); },
    gap: GAP,
    columns: 2,
    segmentSize: 8,
    estimatedItemHeight: 120,
    ...over
  } as never);
}

/**
 * Walk the camera forward a segment at a time, drawing each step.
 *
 * Jumping straight to a deep camera is NOT the same situation: the chain has no
 * history there, so the layout anchors level at the landing and a later
 * re-anchor reproduces it exactly. Scrolling builds a real chain from item 0,
 * which is what makes a mid-scroll re-anchor visible as a re-pack.
 */
function scrollToSegment(
  r: MasonryRenderer,
  el: HTMLElement,
  host: MasonryHost,
  state: { currentElement: number; scrollOffset: number },
  segment: number
): void {
  for (let s = 0; s <= segment; s++) {
    state.currentElement = s;
    state.scrollOffset = 0;
    r.render(900, el, host);
  }
}

/** index -> [x, y] for every mounted card. A frame's grid, comparably. */
function grid(el: HTMLElement): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  for (const node of el.querySelectorAll('[data-element-index]')) {
    const card = node as HTMLElement;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(card.style.transform);
    if (m) out.set(Number(card.dataset.elementIndex), [parseFloat(m[1]), parseFloat(m[2])]);
  }
  return out;
}

/**
 * Cards whose position RELATIVE to the rest of the grid changed.
 *
 * Scrolling moves every card by the same amount, which is not a re-pack. What
 * matters is whether the cards moved with respect to each other, so one common
 * card is used as the origin and the rest are measured against it.
 */
function repacked(
  a: Map<number, [number, number]>,
  b: Map<number, [number, number]>
): number[] {
  const common = [...b.keys()].filter((i) => a.has(i)).sort((x, y) => x - y);
  // Comparing two frames that share no cards proves nothing; a test that lets
  // that through passes for the wrong reason.
  if (common.length < 2) throw new Error('frames share no cards to compare');
  const ref = common[0];
  const shift = b.get(ref)![1] - a.get(ref)![1];
  const out: number[] = [];
  for (const index of common) {
    const [ax, ay] = a.get(index)!;
    const [bx, by] = b.get(index)!;
    if (ax !== bx || Math.abs(by - ay - shift) > 0.5) out.push(index);
  }
  return out;
}

/** Cards present in both frames whose column or y moved. */
function moved(a: Map<number, [number, number]>, b: Map<number, [number, number]>): number[] {
  const out: number[] = [];
  b.forEach(([bx, by], index) => {
    const prev = a.get(index);
    if (!prev) return;
    if (prev[0] !== bx || Math.abs(prev[1] - by) > 0.5) out.push(index);
  });
  return out;
}

beforeEach(() => {
  document.body.innerHTML = '';
  frames = [];
  liveHeights = new Map();
  stubMeasurement();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { /* noop */ });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  }
});

describe('dynamic masonry scroll stability', () => {
  it('does not chain to the end of the dataset in the background', () => {
    // Chaining a dynamic layout means MEASURING every card on the way, forever,
    // in slices that land in the frames the viewer is scrolling through.
    const el = container();
    let measured = 0;
    const r = dynamicRenderer(el, 5000, {
      renderItem: (i: number, node: HTMLElement) => {
        node.dataset.liveIndex = String(i);
        measured++;
      }
    });
    const { host } = makeHost();
    r.render(900, el, host);
    const afterFirstDraw = measured;

    r.scheduleTailChain(host);
    flushFrames();

    expect(frames.length).toBe(0);
    expect(measured).toBe(afterFirstDraw);
    r.dispose();
  });

  it('still chains to the end when an oracle prices the cards', () => {
    // The tail chain is free in oracle mode and the scrollbar wants it, so the
    // dynamic-mode bail-out must not disable it there.
    const el = container();
    const r = new MasonryRenderer(el, 5000, {
      getItemHeight: (i: number) => LIVE_H(i),
      renderItem: (i: number, node: HTMLElement) => { node.dataset.liveIndex = String(i); },
      gap: GAP,
      columns: 2,
      segmentSize: 8
    } as never);
    const { host } = makeHost();
    r.render(900, el, host);

    r.scheduleTailChain(host);
    expect(frames.length).toBeGreaterThan(0);
    flushFrames();
    r.dispose();
  });

  it('treats an evicted height as unknown, not as a card that grew', () => {
    // The height cache is bounded. A card that remounts after its entry was
    // evicted has NOT changed size, and rebuilding for it re-packs the columns
    // mid-scroll.
    const el = container();
    const ro = stubResizeObserver();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    r.observeResize(host, () => r.render(900, el, host));
    // Deep enough that a re-anchor re-packs the columns rather than
    // reproducing the same layout from a level start.
    scrollToSegment(r, el, host, state, 40);
    state.scrollOffset = 30;
    r.render(900, el, host);

    const before = grid(el);
    expect(before.size).toBeGreaterThan(0);

    // Simulate the eviction: the values are gone, the cards have not moved.
    (r as unknown as { heights: Map<number, number> }).heights.clear();
    ro.fire([...el.querySelectorAll('[data-element-index]')] as HTMLElement[]);
    flushFrames();

    expect(moved(before, grid(el))).toEqual([]);
    r.dispose();
  });

  it('still relayouts when a card genuinely changes height', () => {
    const el = container();
    const ro = stubResizeObserver();
    const r = dynamicRenderer(el);
    const { host } = makeHost();
    r.observeResize(host, () => r.render(900, el, host));
    r.render(900, el, host);

    const before = grid(el);
    const target = [...before.keys()].sort((a, b) => a - b)[1];
    const card = el.querySelector(`[data-element-index="${target}"]`) as HTMLElement;

    liveHeights.set(target, LIVE_H(target) + 400);
    ro.fire([card]);
    flushFrames();

    expect(moved(before, grid(el)).length).toBeGreaterThan(0);
    r.dispose();
  });

  it('keeps the reading position fixed when a card BELOW it resizes', () => {
    // A rebuild anchors the chain at the reading position, and the very next
    // render sweeps from `camera - 1`. If the anchor sits AT the camera that
    // neighbour is out of range, so drawing it re-anchors, re-bases, and
    // discards the frontier the camera's offset was just computed against —
    // and the card the reader was looking at jumps.
    const el = container();
    const ro = stubResizeObserver();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    r.observeResize(host, () => r.render(900, el, host));

    // Scroll well inside the dataset, so `camera - 1` is a real, CHAINED segment.
    scrollToSegment(r, el, host, state, 40);
    state.scrollOffset = 40;
    r.render(900, el, host);

    const anchor = r.anchorItem!;
    expect(anchor).not.toBeNull();

    // Grow a card near the BOTTOM of the window. Nothing above it may move.
    const drawn = [...grid(el).keys()].sort((a, b) => a - b);
    const target = drawn[drawn.length - 1];
    expect(target).toBeGreaterThan(anchor.index);

    // Count every re-anchor the relayout causes, including the redraw it ends
    // with. A rebuild needs exactly ONE: a second means the redraw threw away
    // the frontier the camera's offset was just computed against.
    const anchors = vi.spyOn(MasonryLayout.prototype, 'anchorFlushAt');

    liveHeights.set(target, LIVE_H(target) + 300);
    ro.fire([el.querySelector(`[data-element-index="${target}"]`) as HTMLElement]);
    flushFrames();

    expect(anchors.mock.calls.length).toBe(1);
    // ...and it must sit at or above `camera - 1`, which is where render()
    // starts its sweep.
    expect(anchors.mock.calls[0][0]).toBeLessThanOrEqual(state.currentElement - 1);
    anchors.mockRestore();

    const after = grid(el).get(anchor.index);
    expect(after).toBeDefined();
    expect(Math.abs(after![1] - anchor.screenY)).toBeLessThanOrEqual(0.5);

    // And the camera is settled: further frames redraw the same grid.
    const settled = grid(el);
    r.render(900, el, host);
    expect(moved(settled, grid(el))).toEqual([]);
    r.dispose();
  });

  it('scrolling up out of an anchored range leaves the drawn grid alone', () => {
    // A far landing anchors the chain at the camera, so there is no history
    // behind it. Scrolling up used to re-anchor at the new low segment, which
    // re-bases the range and re-packs the columns the reader is looking at.
    // Three columns, so a re-pack has somewhere to go — a two-column toy layout
    // often reproduces itself by luck. Segments deliberately shorter than the
    // viewport, so stepping one still leaves cards on screen to compare.
    const el = container(940);
    const r = dynamicRenderer(el, 5000, { columns: 3, segmentSize: 6 });
    const { host, state } = makeHost();

    // Land deep with no chain behind us — a scrollbar drag, not a scroll.
    state.currentElement = 60;
    state.scrollOffset = 0;
    r.render(900, el, host);
    const landed = grid(el);
    expect(landed.size).toBeGreaterThan(0);

    // Now scroll UP through the seam. Cards still on screen may travel with the
    // scroll, but must not move with respect to one another.
    state.currentElement = 59;
    r.render(900, el, host);
    expect(repacked(landed, grid(el))).toEqual([]);

    // And keep going: each further step must hold the previous frame's grid.
    for (let seg = 58; seg >= 55; seg--) {
      const previous = grid(el);
      state.currentElement = seg;
      r.render(900, el, host);
      expect(repacked(previous, grid(el))).toEqual([]);
    }
    r.dispose();
  });

  it('keeps every gutter exact across the seam it grows back from', () => {
    const el = container();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    state.currentElement = 60;
    r.render(900, el, host);

    // Walk up through the seam and well into the prepended block.
    for (let s = 59; s >= 50; s--) {
      state.currentElement = s;
      r.render(900, el, host);

      const byColumn = new Map<number, { y: number; h: number }[]>();
      for (const node of el.querySelectorAll('[data-element-index]')) {
        const card = node as HTMLElement;
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(card.style.transform)!;
        const x = Math.round(parseFloat(m[1]));
        const list = byColumn.get(x) ?? [];
        list.push({ y: parseFloat(m[2]), h: card.offsetHeight });
        byColumn.set(x, list);
      }
      const gaps = new Set<number>();
      for (const col of byColumn.values()) {
        col.sort((a, b) => a.y - b.y);
        for (let i = 1; i < col.length; i++) {
          gaps.add(Math.round((col[i].y - (col[i - 1].y + col[i - 1].h)) * 100) / 100);
        }
      }
      expect([...gaps]).toEqual([GAP]);
    }
    r.dispose();
  });

  it('grows backwards in chunks rather than once per segment', () => {
    const el = container();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    state.currentElement = 60;
    r.render(900, el, host);

    const anchors = vi.spyOn(MasonryLayout.prototype, 'anchorFlushAt');
    for (let s = 59; s >= 50; s--) {
      state.currentElement = s;
      r.render(900, el, host);
    }
    // Ten segments of scrolling up, and not one re-anchor.
    expect(anchors).not.toHaveBeenCalled();
    anchors.mockRestore();
    r.dispose();
  });

  it('still anchors rather than measuring back across a long jump', () => {
    // Backwards growth costs a measurement per card. A viewer who JUMPED over
    // that content never looked at it, so it must not be paid for.
    const el = container();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    state.currentElement = 900;
    r.render(900, el, host);

    const anchors = vi.spyOn(MasonryLayout.prototype, 'anchorFlushAt');
    state.currentElement = 100;
    r.render(900, el, host);
    expect(anchors).toHaveBeenCalled();
    anchors.mockRestore();
    r.dispose();
  });

  it('draws an unchanged grid across repeated renders at one camera', () => {
    const el = container();
    const r = dynamicRenderer(el);
    const { host, state } = makeHost();
    scrollToSegment(r, el, host, state, 30);
    state.scrollOffset = 55;
    r.render(900, el, host);

    const first = grid(el);
    for (let i = 0; i < 5; i++) {
      r.render(900, el, host);
      expect(moved(first, grid(el))).toEqual([]);
    }
    r.dispose();
  });
});
