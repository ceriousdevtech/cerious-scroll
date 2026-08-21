/**
 * @fileoverview Tests for the hooks an external layout model needs.
 *
 * These are the four seams that let a consumer drive its own DOM (masonry, a
 * timeline, any computed layout) while CeriousScroll remains the scroll engine.
 * Each test also pins the default so the hook cannot regress normal behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';
import type { HeightProvider } from '../../src/types/index.js';

function host(height = 1000, width = 800): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  document.body.appendChild(el);
  return el;
}

const SEG_H = 25000;
const provider: HeightProvider = {
  height: () => SEG_H,
  cumulativeHeight: (n) => n * SEG_H,
  rowAtPosition: (px) => ({ element: Math.floor(px / SEG_H), offset: px % SEG_H }),
  totalHeight: () => 400 * SEG_H
};

describe('heightProvider option', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('answers getElementHeight from the provider, not the 40px default', () => {
    const s = new CeriousScroll(host(), 400, { heightProvider: provider, attachScrollbar: false });
    expect(s.getElementHeight(0)).toBe(SEG_H);
    expect(s.getElementHeight(399)).toBe(SEG_H);
    s.dispose();
  });

  it('keeps the 40px default when no provider is given', () => {
    const s = new CeriousScroll(host(), 400, { attachScrollbar: false });
    expect(s.getElementHeight(0)).toBe(40);
    s.dispose();
  });

  it('resolves scroll percentage across the whole range, not just the cached window', () => {
    // Without the provider path, cumulative height collapsed past the cache
    // window and every percentage under ~60% resolved to element 0.
    const s = new CeriousScroll(host(), 400, { heightProvider: provider, attachScrollbar: false });
    const seen: number[] = [];
    for (const pct of [10, 25, 50, 75, 90]) {
      s.handleScrollPercentage(pct);
      seen.push(s.currentElement);
    }
    expect(seen[0]).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    s.dispose();
  });
});

describe('jumpToPosition', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('lands on an exact element AND offset', () => {
    const s = new CeriousScroll(host(), 400, { heightProvider: provider, attachScrollbar: false });
    s.jumpToPosition(137, 4321);
    expect(s.currentElement).toBe(137);
    expect(s.scrollOffset).toBe(4321);
    s.dispose();
  });

  it('rejects non-finite input rather than corrupting the camera', () => {
    const s = new CeriousScroll(host(), 400, { heightProvider: provider, attachScrollbar: false });
    expect(() => s.jumpToPosition(NaN, 0)).toThrow();
    expect(() => s.jumpToPosition(1, Infinity)).toThrow();
    s.dispose();
  });
});

describe('syncViewportHeight', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('adopts a new host height without a renderViewport call', () => {
    // The regression: a consumer driving its own DOM never calls renderViewport,
    // so the engine kept its construction-time height and true-bottom clamped
    // short by exactly the drift.
    const el = host(1127);
    const s = new CeriousScroll(el, 400, { heightProvider: provider, attachScrollbar: false });
    expect(s.viewportHeight).toBe(1127);

    Object.defineProperty(el, 'clientHeight', { value: 1020, configurable: true });
    expect(s.syncViewportHeight(1020)).toBe(1020);
    expect(s.viewportHeight).toBe(1020);
    s.dispose();
  });

  it('ignores non-positive and non-finite heights', () => {
    const s = new CeriousScroll(host(900), 400, { heightProvider: provider, attachScrollbar: false });
    expect(s.syncViewportHeight(0)).toBe(900);
    expect(s.syncViewportHeight(NaN)).toBe(900);
    expect(s.viewportHeight).toBe(900);
    s.dispose();
  });
});

describe('wheel notchThresholdPx', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  function countFrames(el: HTMLElement, s: CeriousScroll, threshold?: number): number {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    s.setupWheelHandler(el, () => {}, {
      smooth: true,
      ...(threshold !== undefined ? { notchThresholdPx: threshold } : {})
    });
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, cancelable: true }));
    const calls = raf.mock.calls.length;
    raf.mockRestore();
    return calls;
  }

  it('applies a 120px notch instantly by default (no easing frames scheduled)', () => {
    const el = host();
    const s = new CeriousScroll(el, 400, { attachScrollbar: false, wheel: { enabled: false } });
    expect(countFrames(el, s)).toBe(0);
    s.dispose();
  });

  it('eases the same notch once the threshold is raised above it', () => {
    const el = host();
    const s = new CeriousScroll(el, 400, { attachScrollbar: false, wheel: { enabled: false } });
    expect(countFrames(el, s, 500)).toBeGreaterThan(0);
    s.dispose();
  });
});

describe('scrollbar strip sizing', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  function stripHeight(el: HTMLElement): number {
    const content = el.querySelector('[data-cerious-scrollbar="content"]') as HTMLElement | null;
    return content ? parseFloat(content.style.height) : -1;
  }

  it('sizes by content height when the provider reports one', () => {
    // Regression: the creation path computed its own height from element count,
    // so a content source only affected later re-sizes and the strip kept a
    // 4,010px surface for 10M px of content — ~3,360 content px per track px.
    const el = host();
    const s = new CeriousScroll(el, 400, { heightProvider: provider });
    expect(stripHeight(el)).toBe(400 * SEG_H);
    s.dispose();
  });

  it('sizes by element count when there is no provider', () => {
    const el = host();
    const s = new CeriousScroll(el, 400, {});
    expect(stripHeight(el)).toBe(401 * 10);
    s.dispose();
  });

  it('refreshScrollbarMetrics picks up a height change with a fixed element count', () => {
    const el = host();
    let total = 400 * SEG_H;
    const s = new CeriousScroll(el, 400, {
      heightProvider: { ...provider, totalHeight: () => total }
    });
    expect(stripHeight(el)).toBe(total);

    total = 900 * SEG_H;                 // relayout: same segments, taller content
    s.updateTotalElements(400);          // count unchanged -> no-op
    expect(stripHeight(el)).toBe(400 * SEG_H);

    s.refreshScrollbarMetrics();
    expect(stripHeight(el)).toBe(900 * SEG_H);
    s.dispose();
  });
});
