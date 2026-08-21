/**
 * @fileoverview Tests for the authoritative HeightProvider path.
 *
 * Two things must hold at once: a provider must fully replace the measured
 * cache, and its presence must change nothing when it is absent.
 */

import { describe, it, expect } from 'vitest';
import { PerformanceCache } from '../../src/core/performance-cache.js';
import type { HeightProvider } from '../../src/types/index.js';

const SEGMENTS = 400;
const segHeight = (i: number) => 24000 + (i % 7) * 100;

function makeProvider(extra: Partial<HeightProvider> = {}): HeightProvider {
  return {
    height: segHeight,
    cumulativeHeight: (n) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += segHeight(i);
      return sum;
    },
    ...extra
  };
}

describe('PerformanceCache with a HeightProvider', () => {
  it('never prunes: every index still reports its true height after seeding all of them', () => {
    // The regression this exists for: seeding 400 segment heights through the
    // measured cache left 170, and the rest silently reported the default.
    const cache = new PerformanceCache(segHeight, makeProvider());
    cache.setTotalElements(SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) cache.setMeasuredHeight(i, segHeight(i));

    for (const i of [0, 50, 100, 199, 250, 399]) {
      expect(cache.hasMeasuredHeight(i)).toBe(true);
      expect(cache.getMeasuredHeight(i)).toBe(segHeight(i));
    }
  });

  it('treats setMeasuredHeight as a no-op — the provider is the source of truth', () => {
    const cache = new PerformanceCache(segHeight, makeProvider());
    cache.setMeasuredHeight(5, 999999);
    expect(cache.getMeasuredHeight(5)).toBe(segHeight(5));
  });

  it('suppresses uniform-height detection', () => {
    const flat: HeightProvider = { height: () => 40 };
    const cache = new PerformanceCache(() => 40, flat);
    for (let i = 0; i < 50; i++) cache.setMeasuredHeight(i, 40);
    // Uniform detection exists to skip offsetHeight; with a provider there is
    // no measurement to skip, and claiming uniformity would let the engine
    // extrapolate positions from a single height.
    expect(cache.getUniformHeightHint()).toBeUndefined();
  });

  it('uses the provider cumulativeHeight when supplied', () => {
    const cache = new PerformanceCache(segHeight, makeProvider());
    let expected = 0;
    for (let i = 0; i < 137; i++) expected += segHeight(i);
    expect(cache.getCumulativeHeight(137)).toBe(expected);
  });

  it('falls back to summing height() when cumulativeHeight is absent', () => {
    const cache = new PerformanceCache(segHeight, { height: segHeight });
    let expected = 0;
    for (let i = 0; i < 10; i++) expected += segHeight(i);
    expect(cache.getCumulativeHeight(10)).toBe(expected);
  });

  it('uses the provider rowAtPosition when supplied', () => {
    const cache = new PerformanceCache(segHeight, makeProvider({
      rowAtPosition: () => ({ element: 42, offset: 7 })
    }));
    expect(cache.findRowFromScrollPosition(123456)).toEqual({ element: 42, offset: 7 });
  });

  it('reports the provider total height', () => {
    const cache = new PerformanceCache(segHeight, makeProvider({ totalHeight: () => 10_047_153 }));
    expect(cache.getProvidedTotalHeight()).toBe(10_047_153);
    expect(cache.hasHeightProvider).toBe(true);
  });
});

describe('PerformanceCache without a HeightProvider (default path unchanged)', () => {
  it('still prunes to its bounded window', () => {
    const cache = new PerformanceCache(() => 40);
    cache.setTotalElements(5000);
    for (let i = 0; i < 3000; i++) cache.setMeasuredHeight(i, 40 + (i % 3));
    const stats = cache.getCacheStats();
    expect(stats.measuredElements).toBeLessThan(400);
  });

  it('still detects uniform heights', () => {
    const cache = new PerformanceCache(() => 40);
    for (let i = 0; i < 20; i++) cache.setMeasuredHeight(i, 40);
    expect(cache.getUniformHeightHint()).toBe(40);
  });

  it('still reports no provider', () => {
    const cache = new PerformanceCache(() => 40);
    expect(cache.hasHeightProvider).toBe(false);
    expect(cache.getProvidedTotalHeight()).toBeUndefined();
  });

  it('still returns undefined for an unmeasured index', () => {
    const cache = new PerformanceCache(() => 40);
    expect(cache.hasMeasuredHeight(9)).toBe(false);
    expect(cache.getMeasuredHeight(9)).toBeUndefined();
  });
});
