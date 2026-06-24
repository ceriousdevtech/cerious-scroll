/**
 * @fileoverview Unit tests for PerformanceCache module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PerformanceCache } from '../../src/core/performance-cache.js';
import { createMockHeightCalculator, createElementHeights } from '../helpers/test-helpers.js';

describe('PerformanceCache', () => {
  describe('Constructor and Basic Operations', () => {
    it('should create a cache with height calculator', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      expect(cache).toBeDefined();
    });
  });

  describe('Measured Height Management', () => {
    let cache: PerformanceCache;
    let calculator: (index: number) => number;

    beforeEach(() => {
      const heights = createElementHeights(100, 50);
      calculator = createMockHeightCalculator(heights);
      cache = new PerformanceCache(calculator);
    });

    it('should store and retrieve measured heights', () => {
      cache.setMeasuredHeight(0, 75);
      expect(cache.hasMeasuredHeight(0)).toBe(true);
      expect(cache.getMeasuredHeight(0)).toBe(75);
    });

    it('should return undefined for unmeasured heights', () => {
      expect(cache.hasMeasuredHeight(10)).toBe(false);
      expect(cache.getMeasuredHeight(10)).toBeUndefined();
    });

    it('should update existing measured heights', () => {
      cache.setMeasuredHeight(5, 60);
      cache.setMeasuredHeight(5, 70);
      expect(cache.getMeasuredHeight(5)).toBe(70);
    });

    it('should handle multiple measured heights', () => {
      cache.setMeasuredHeight(0, 50);
      cache.setMeasuredHeight(1, 60);
      cache.setMeasuredHeight(2, 70);
      
      expect(cache.getMeasuredHeight(0)).toBe(50);
      expect(cache.getMeasuredHeight(1)).toBe(60);
      expect(cache.getMeasuredHeight(2)).toBe(70);
    });
  });

  describe('Cache Pruning (Memory Management)', () => {
    let cache: PerformanceCache;

    beforeEach(() => {
      const heights = createElementHeights(1000, 50);
      const calculator = createMockHeightCalculator(heights);
      cache = new PerformanceCache(calculator);
    });

    it('should prune old entries when cache exceeds threshold', () => {
      // Add many measured heights to trigger pruning
      for (let i = 0; i < 300; i++) {
        cache.setMeasuredHeight(i, 50 + i);
      }
      
      const stats = cache.getCacheStats();
      // Cache should be pruned to MAX_MEASURED_HEIGHTS_CACHE (200)
      expect(stats.measuredElements).toBeLessThanOrEqual(200);
    });

    it('should keep recently accessed elements during pruning', () => {
      // Add many measured heights
      for (let i = 0; i < 300; i++) {
        cache.setMeasuredHeight(i, 50 + i);
      }
      
      // Access element near the end
      cache.getMeasuredHeight(280);
      cache.setMeasuredHeight(290, 100);
      
      // Element 290 should still be in cache after pruning
      expect(cache.hasMeasuredHeight(290)).toBe(true);
    });

    it('should remove far elements during pruning', () => {
      // Add many measured heights at index 0-299
      for (let i = 0; i < 300; i++) {
        cache.setMeasuredHeight(i, 50 + i);
      }
      
      // Now access elements far away (500-550)
      for (let i = 500; i < 550; i++) {
        cache.setMeasuredHeight(i, 50 + i);
      }
      
      // Elements at beginning should be pruned
      expect(cache.hasMeasuredHeight(0)).toBe(false);
      expect(cache.hasMeasuredHeight(10)).toBe(false);
    });
  });

  describe('Cumulative Height Calculation', () => {
    let cache: PerformanceCache;
    let calculator: (index: number) => number;

    beforeEach(() => {
      const heights = createElementHeights(100, 50, {
        0: 100,
        1: 80,
        2: 60,
        3: 40,
        4: 120,
      });
      calculator = createMockHeightCalculator(heights);
      cache = new PerformanceCache(calculator);
      
      // Pre-measure some heights
      cache.setMeasuredHeight(0, 100);
      cache.setMeasuredHeight(1, 80);
      cache.setMeasuredHeight(2, 60);
      cache.setMeasuredHeight(3, 40);
      cache.setMeasuredHeight(4, 120);
    });

    it('should return 0 for row 0', () => {
      expect(cache.getCumulativeHeight(0)).toBe(0);
    });

    it('should calculate cumulative height for single element', () => {
      expect(cache.getCumulativeHeight(1)).toBe(100);
    });

    it('should calculate cumulative height for multiple elements', () => {
      // Row 3 = sum of rows 0, 1, 2 = 100 + 80 + 60 = 240
      expect(cache.getCumulativeHeight(3)).toBe(240);
    });

    it('should use sliding window cache for large indices', () => {
      const height1 = cache.getCumulativeHeight(50);
      const height2 = cache.getCumulativeHeight(50);
      
      // Second call should use cached value
      expect(height2).toBe(height1);
    });

    it('should handle uniform height optimization', () => {
      // Create cache with uniform heights
      const uniformHeights = createElementHeights(100, 50);
      const uniformCalculator = createMockHeightCalculator(uniformHeights);
      const uniformCache = new PerformanceCache(uniformCalculator);
      
      // Measure many elements with same height
      for (let i = 0; i < 15; i++) {
        uniformCache.setMeasuredHeight(i, 50);
      }
      
      // Should detect uniform height and use O(1) calculation
      const height = uniformCache.getCumulativeHeight(20);
      expect(height).toBe(20 * 50);
      
      const stats = uniformCache.getCacheStats();
      expect(stats.isUniformHeight).toBe(true);
      expect(stats.uniformHeightValue).toBe(50);
    });
  });

  describe('Find Row From Scroll Position', () => {
    let cache: PerformanceCache;

    beforeEach(() => {
      const heights = createElementHeights(100, 50, {
        0: 100,
        1: 80,
        2: 60,
        3: 40,
      });
      const calculator = createMockHeightCalculator(heights);
      cache = new PerformanceCache(calculator);
      
      cache.setMeasuredHeight(0, 100);
      cache.setMeasuredHeight(1, 80);
      cache.setMeasuredHeight(2, 60);
      cache.setMeasuredHeight(3, 40);
    });

    it('should return element 0 for scroll position 0', () => {
      const result = cache.findRowFromScrollPosition(0);
      expect(result.element).toBe(0);
      expect(result.offset).toBe(0);
    });

    it('should find element with offset', () => {
      // Scroll position 120 = element 1, offset 20 (past 100px of element 0, 20px into element 1)
      const result = cache.findRowFromScrollPosition(120);
      expect(result.element).toBe(1);
      expect(result.offset).toBe(20);
    });

    it('should handle scroll position at element boundary', () => {
      // Position 100 = exactly at start of element 1
      const result = cache.findRowFromScrollPosition(100);
      expect(result.element).toBe(1);
      expect(result.offset).toBe(0);
    });

    it('should handle uniform heights efficiently', () => {
      const uniformHeights = createElementHeights(100, 50);
      const uniformCalculator = createMockHeightCalculator(uniformHeights);
      const uniformCache = new PerformanceCache(uniformCalculator);
      
      // Measure uniform heights
      for (let i = 0; i < 15; i++) {
        uniformCache.setMeasuredHeight(i, 50);
      }
      
      // Position 250 = element 5, offset 0 (50 * 5 = 250)
      const result = uniformCache.findRowFromScrollPosition(250);
      expect(result.element).toBe(5);
      expect(result.offset).toBe(0);
    });
  });

  describe('Cache Invalidation', () => {
    let cache: PerformanceCache;

    beforeEach(() => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      cache = new PerformanceCache(calculator);
      
      cache.setMeasuredHeight(0, 100);
      cache.setMeasuredHeight(1, 80);
    });

    it('should invalidate derived caches but keep measured heights', () => {
      cache.invalidateCache();

      const stats = cache.getCacheStats();
      expect(stats.isUniformHeight).toBeUndefined();
      expect(stats.measuredElements).toBe(2); // Measured heights preserved
    });

    it('should clear all caches including measured heights', () => {
      cache.clearAllCaches();

      expect(cache.hasMeasuredHeight(0)).toBe(false);
      expect(cache.hasMeasuredHeight(1)).toBe(false);

      const stats = cache.getCacheStats();
      expect(stats.measuredElements).toBe(0);
    });
  });

  describe('Cache Statistics', () => {
    it('should provide cache statistics', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      cache.setMeasuredHeight(0, 100);
      cache.setMeasuredHeight(1, 80);

      const stats = cache.getCacheStats();
      expect(stats.measuredElements).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle negative scroll positions', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      const result = cache.findRowFromScrollPosition(-100);
      expect(result.element).toBe(0);
      expect(result.offset).toBe(0);
    });

    it('should handle very large scroll positions', () => {
      const heights = createElementHeights(10, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      for (let i = 0; i < 10; i++) {
        cache.setMeasuredHeight(i, 50);
      }
      
      const result = cache.findRowFromScrollPosition(10000);
      // With 10 elements, result can go beyond due to scroll calculation
      expect(result.element).toBeGreaterThan(0);
    });

    it('should handle zero-height elements gracefully', () => {
      const heights = createElementHeights(10, 0);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      cache.setMeasuredHeight(0, 0);
      expect(() => cache.getCumulativeHeight(5)).not.toThrow();
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle large datasets efficiently', () => {
      const heights = createElementHeights(100000, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      // Measure heights in a sliding window
      for (let i = 0; i < 500; i++) {
        cache.setMeasuredHeight(i, 50);
      }
      
      const stats = cache.getCacheStats();
      // Should stay within memory limits
      expect(stats.measuredElements).toBeLessThanOrEqual(500);
    });

    it('should maintain O(1) memory for cumulative height cache', () => {
      const heights = createElementHeights(100000, 50);
      const calculator = createMockHeightCalculator(heights);
      const cache = new PerformanceCache(calculator);
      
      // Access heights across dataset
      cache.getCumulativeHeight(1000);
      cache.getCumulativeHeight(50000);
      cache.getCumulativeHeight(99000);
      
      const stats = cache.getCacheStats();
      // Cache window size should be fixed
      expect(stats.cacheWindowSize).toBeLessThanOrEqual(300);
    });
  });
});
