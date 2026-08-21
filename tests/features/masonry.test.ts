/**
 * @fileoverview Tests for `layout: 'masonry'`.
 *
 * Two properties matter and are easy to lose: the layout must be identical to a
 * single greedy pass from item 0 (no seam, uniform gutter), and the DOM must
 * stay bounded no matter where the camera is.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';
import { MasonryLayout } from '../../src/features/masonry-layout.js';

const GAP = 16;
const COLS = 3;
const COL_W = 300;
const heightOf = (i: number) => 120 + ((i * 37) % 9) * 45;

function makeLayout(totalItems = 5000, segmentSize = 200) {
  return new MasonryLayout({
    totalItems, columns: COLS, columnWidth: COL_W, gap: GAP, segmentSize,
    getItemHeight: (i) => heightOf(i)
  });
}

/** Ground truth: one greedy pass over the whole dataset. */
function greedy(totalItems: number) {
  const colH = new Array(COLS).fill(0);
  const col: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < totalItems; i++) {
    let c = 0;
    for (let k = 1; k < COLS; k++) if (colH[k] < colH[c]) c = k;
    col.push(c); y.push(colH[c]);
    colH[c] += heightOf(i) + GAP;
  }
  return { col, y };
}

describe('MasonryLayout', () => {
  it('matches a single greedy pass exactly — no seam at any boundary', () => {
    const TOTAL = 5000;
    const layout = makeLayout(TOTAL);
    const truth = greedy(TOTAL);

    let checked = 0;
    for (let s = 0; s * layout.segmentSize < TOTAL; s++) {
      const origin = layout.segmentOrigin(s);
      for (const it of layout.getSegment(s)) {
        expect(it.column).toBe(truth.col[it.index]);
        expect(origin + it.y).toBeCloseTo(truth.y[it.index], 6);
        checked++;
      }
    }
    expect(checked).toBe(TOTAL);
  });

  it('leaves every gutter exactly `gap`, including across segment boundaries', () => {
    const TOTAL = 3000;
    const layout = makeLayout(TOTAL, 100);
    const lastBottom: (number | null)[] = [null, null, null];
    const gaps = new Set<number>();

    for (let s = 0; s * layout.segmentSize < TOTAL; s++) {
      const origin = layout.segmentOrigin(s);
      for (const it of layout.getSegment(s)) {
        const top = origin + it.y;
        const prev = lastBottom[it.column];
        if (prev !== null) gaps.add(Math.round((top - prev) * 100) / 100);
        lastBottom[it.column] = top + it.height;
      }
    }
    expect([...gaps]).toEqual([GAP]);
  });

  it('measures the final segment to its deepest column so the tail is reachable', () => {
    // Interior segments measure to the shallowest column; the last one has
    // nothing after it to absorb the overhang, so cards would sit below the
    // reported end of the dataset.
    const TOTAL = 1000;
    const layout = makeLayout(TOTAL, 200);
    const last = layout.segmentCount() - 1;
    const origin = layout.segmentOrigin(last);
    const total = layout.segmentOrigin(layout.segmentCount());
    let deepest = 0;
    for (const it of layout.getSegment(last)) {
      deepest = Math.max(deepest, origin + it.y + it.height);
    }
    expect(total).toBeGreaterThanOrEqual(deepest);
  });

  it('chainAhead is resumable and reaches the same answer as one pass', () => {
    const sliced = makeLayout(4000);
    let guard = 0;
    while (!sliced.chainAhead(sliced.segmentCount(), 0) && guard++ < 1000) { /* slice */ }
    const whole = makeLayout(4000);
    expect(sliced.segmentOrigin(sliced.segmentCount()))
      .toBeCloseTo(whole.segmentOrigin(whole.segmentCount()), 6);
  });

  it('reports an estimated total before the chain lands, exact after', () => {
    const layout = makeLayout(4000);
    expect(layout.totalHeight().exact).toBe(false);
    layout.chainAhead(layout.segmentCount(), Number.POSITIVE_INFINITY);
    const after = layout.totalHeight();
    expect(after.exact).toBe(true);
    expect(after.height).toBeCloseTo(layout.segmentOrigin(layout.segmentCount()), 6);
  });

  it('resize discards derived state and relocates items', () => {
    const layout = makeLayout(2000);
    const before = layout.locateItem(900)!;
    expect(layout.resize(5, 200)).toBe(true);
    const after = layout.locateItem(900)!;
    expect(layout.columns).toBe(5);
    expect(after.y).not.toBe(before.y);
    expect(layout.resize(5, 200)).toBe(false); // no-op when unchanged
  });

  it('derives a responsive column count from the target width', () => {
    expect(MasonryLayout.geometryFor(1200, 16, undefined, 280, 1, 8).columns).toBe(4);
    expect(MasonryLayout.geometryFor(600, 16, undefined, 280, 1, 8).columns).toBe(2);
    expect(MasonryLayout.geometryFor(1200, 16, 3, 280, 1, 8).columns).toBe(3); // fixed wins
  });
});

describe("CeriousScroll layout: 'masonry'", () => {
  function host(h = 900, w = 948): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
    document.body.appendChild(el);
    return el;
  }
  const opts = (over = {}) => ({
    layout: 'masonry' as const,
    attachScrollbar: false,
    masonry: {
      getItemHeight: (i: number) => heightOf(i),
      renderItem: (i: number, el: HTMLElement) => { el.textContent = String(i); },
      gap: GAP, columns: COLS, segmentSize: 200,
      ...over
    }
  });

  beforeEach(() => { document.body.innerHTML = ''; });

  it('treats totalElements as CARDS and scrolls over segments', () => {
    const s = new CeriousScroll(host(), 5000, opts());
    expect(s.itemCount).toBe(5000);
    expect(s.totalElements).toBe(25); // 5000 / 200
    s.dispose();
  });

  it('requires the masonry option, and rejects a competing heightProvider', () => {
    expect(() => new CeriousScroll(host(), 100, { layout: 'masonry' })).toThrow(/requires/);
    expect(() => new CeriousScroll(host(), 100, {
      ...opts(), heightProvider: { height: () => 10 }
    })).toThrow(/heightProvider/);
  });

  it('keeps the DOM bounded across the whole dataset', () => {
    const el = host();
    const s = new CeriousScroll(el, 5000, opts());
    let peak = 0;
    for (const pct of [0, 20, 40, 60, 80, 100]) {
      s.handleScrollPercentage(pct);
      s.renderViewport(900, el, () => {});
      peak = Math.max(peak, el.querySelectorAll('[data-element-index]').length);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(120); // vs 5000 cards
    s.dispose();
  });

  it('jumpToItem lands on the requested card', () => {
    const el = host();
    const s = new CeriousScroll(el, 5000, opts());
    s.jumpToItem(3200);
    s.renderViewport(900, el, () => {});
    const mounted = [...el.querySelectorAll('[data-element-index]')]
      .map((n) => Number((n as HTMLElement).dataset.elementIndex));
    expect(mounted).toContain(3200);
    s.dispose();
  });

  it('jumpToItem is rejected outside masonry mode', () => {
    const s = new CeriousScroll(host(), 100, { attachScrollbar: false });
    expect(() => s.jumpToItem(5)).toThrow(/masonry/);
    s.dispose();
  });
});
