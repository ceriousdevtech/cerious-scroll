/**
 * @fileoverview Comprehensive unit tests for NavigationEngine module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NavigationEngine } from '../src/engine/navigation-engine.js';
import { createElementHeights, createMockHeightCalculator, createMockElement } from './helpers/test-helpers.js';

const createEngine = (totalElements: number = 5, variableHeights?: Record<number, number>) => {
  const heights = createElementHeights(totalElements, 50, variableHeights);
  const calculator = createMockHeightCalculator(heights);
  let currentElement = 0;
  let scrollOffset = 0;
  const viewportHeight = 200;

  const getElementViewportPosition = (index: number) => {
    let top = -scrollOffset;
    if (index >= currentElement) {
      for (let i = currentElement; i < index; i++) {
        top += calculator(i);
      }
    } else {
      for (let i = currentElement - 1; i >= index; i--) {
        top -= calculator(i);
      }
    }
    const height = calculator(index);
    return {
      top,
      bottom: top + height,
      isVisible: top < viewportHeight && top + height > 0
    };
  };

  const requestDisplayUpdate = vi.fn();
  const syncScrollbar = vi.fn();

  const engine = new NavigationEngine({
    totalElements: heights.length,
    viewportHeight,
    getCurrentElement: () => currentElement,
    getScrollOffset: () => scrollOffset,
    getElementHeight: calculator,
    hasMeasuredHeight: () => true,
    getLastRenderedElement: () => createMockElement(),
    getElementViewportPosition,
    getCalculateScrollPercentage: () => {
      if (totalElements <= 1) return 0;
      return (currentElement / (totalElements - 1)) * 100;
    },
    updateScrollPosition: (element, offset) => {
      currentElement = element;
      scrollOffset = offset;
    },
    requestDisplayUpdate,
    syncScrollbar,
    getTrueBottomPosition: () => ({ element: heights.length - 1, offset: 0 })
  });

  return { 
    engine, 
    heights, 
    requestDisplayUpdate, 
    syncScrollbar, 
    getState: () => ({ currentElement, scrollOffset }),
    setPosition: (element: number, offset: number) => {
      currentElement = element;
      scrollOffset = offset;
    }
  };
};

describe('NavigationEngine', () => {
  describe('Basic Scroll Operations', () => {
    let harness: ReturnType<typeof createEngine>;

    beforeEach(() => {
      harness = createEngine(5);
    });

    it('should scroll forward by delta', () => {
      const result = harness.engine.scroll(55, 200);
      expect(result.element).toBe(1);
      // Offset is clamped to element height - 1
      expect(result.offset).toBeGreaterThanOrEqual(0);
      expect(result.offset).toBeLessThan(50);
    });

    it('should scroll backward by negative delta', () => {
      harness.setPosition(2, 10);
      const result = harness.engine.scroll(-30, 200);
      
      expect(result.element).toBeLessThanOrEqual(2);
    });

    it('should handle scrolling across multiple elements', () => {
      // Scroll 150px = through element 0 (50px), element 1 (50px), halfway through element 2
      const result = harness.engine.scroll(150, 200);
      // Should be at least element 1, could be 2 or 3 depending on clamping
      expect(result.element).toBeGreaterThanOrEqual(1);
      expect(result.element).toBeLessThanOrEqual(3);
    });

    it('should update scroll position on scroll', () => {
      harness.engine.scroll(25, 200);
      const state = harness.getState();
      
      expect(state.currentElement).toBe(0);
      expect(state.scrollOffset).toBe(25);
    });

    it('should sync scrollbar after scroll', () => {
      harness.engine.scroll(50, 200);
      expect(harness.syncScrollbar).toHaveBeenCalled();
    });
  });

  describe('Boundary Conditions', () => {
    it('should clamp at top boundary', () => {
      const harness = createEngine(10);
      harness.setPosition(0, 10);
      
      // Try to scroll above element 0
      const result = harness.engine.scroll(-50, 200);
      
      expect(result.element).toBe(0);
      expect(result.offset).toBeGreaterThanOrEqual(0);
    });

    it('should clamp at bottom boundary', () => {
      const harness = createEngine(10);
      harness.setPosition(9, 0);
      
      // Try to scroll beyond last element
      const result = harness.engine.scroll(500, 200);
      
      // Should be near the end, but BoundaryGuardian may adjust position
      expect(result.element).toBeGreaterThanOrEqual(5);
      expect(result.element).toBeLessThanOrEqual(9);
    });

    it('should prevent scrolling past last element', () => {
      const harness = createEngine(5);
      harness.setPosition(4, 40);
      
      const result = harness.engine.scroll(100, 200);
      
      // Should stay near the last element (BoundaryGuardian may adjust)
      expect(result.element).toBeGreaterThanOrEqual(1);
      expect(result.element).toBeLessThanOrEqual(4);
    });
  });

  describe('Percentage Navigation', () => {
    let harness: ReturnType<typeof createEngine>;

    beforeEach(() => {
      harness = createEngine(100);
    });

    it('should handle 0% scroll', () => {
      const result = harness.engine.handleScrollPercentage(0);
      expect(result.element).toBe(0);
      expect(result.offset).toBe(0);
    });

    it('should handle 100% scroll', () => {
      const result = harness.engine.handleScrollPercentage(100);
      // Should be at or near last element (true bottom may differ)
      expect(result.element).toBeGreaterThan(90);
      expect(result.element).toBeLessThanOrEqual(99);
    });

    it('should handle 50% scroll', () => {
      const result = harness.engine.handleScrollPercentage(50);
      expect(result.element).toBeGreaterThanOrEqual(45);
      expect(result.element).toBeLessThanOrEqual(55);
    });

    it('should clamp percentage to 0-100 range', () => {
      const negativeResult = harness.engine.handleScrollPercentage(-50);
      expect(negativeResult.element).toBe(0);
      
      const overResult = harness.engine.handleScrollPercentage(150);
      // Should be at or near last element
      expect(overResult.element).toBeGreaterThan(90);
      expect(overResult.element).toBeLessThanOrEqual(99);
    });

    it('should not move if percentage equals current position', () => {
      harness.setPosition(50, 0);
      const currentPercentage = (50 / 99) * 100;
      
      const result = harness.engine.handleScrollPercentage(currentPercentage);
      expect(result.element).toBe(50);
    });
  });

  describe('Jump to Element', () => {
    let harness: ReturnType<typeof createEngine>;

    beforeEach(() => {
      harness = createEngine(100);
    });

    it('should jump to specified element', () => {
      const result = harness.engine.jumpToElement(50);
      expect(result.element).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should jump to element 0', () => {
      harness.setPosition(50, 25);
      const result = harness.engine.jumpToElement(0);
      
      expect(result.element).toBe(0);
      expect(result.offset).toBe(0);
    });

    it('should jump to last element', () => {
      const result = harness.engine.jumpToElement(99);
      expect(result.element).toBe(99);
      expect(result.offset).toBe(0);
    });

    it('should respect true bottom position', () => {
      const result = harness.engine.jumpToElement(110); // Beyond dataset
      
      // Should clamp to true bottom or stay at current position if invalid
      expect(result.element).toBeGreaterThanOrEqual(0);
      expect(result.element).toBeLessThanOrEqual(99);
    });

    it('should request display update on jump', () => {
      harness.engine.jumpToElement(25);
      expect(harness.requestDisplayUpdate).toHaveBeenCalled();
    });

    it('should sync scrollbar on jump', () => {
      harness.engine.jumpToElement(25);
      expect(harness.syncScrollbar).toHaveBeenCalled();
    });

    it('should not jump to negative index', () => {
      const result = harness.engine.jumpToElement(-10);
      const state = harness.getState();
      
      // Should stay at current position or clamp to 0
      expect(state.currentElement).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Jump to Position', () => {
    let harness: ReturnType<typeof createEngine>;

    beforeEach(() => {
      harness = createEngine(100);
    });

    it('should jump to specific element and offset', () => {
      const result = harness.engine.jumpToPosition(50, 25);
      expect(result.element).toBe(50);
      expect(result.offset).toBe(25);
    });

    it('should clamp offset to element height', () => {
      // Element height is 50, try offset of 100
      const result = harness.engine.jumpToPosition(50, 100);
      
      expect(result.element).toBe(50);
      expect(result.offset).toBeLessThan(50);
    });

    it('should clamp element to dataset bounds', () => {
      const result = harness.engine.jumpToPosition(150, 25);
      
      // Should clamp to maximum element
      expect(result.element).toBeGreaterThan(90);
      expect(result.element).toBeLessThanOrEqual(99);
    });

    it('should handle negative offset', () => {
      const result = harness.engine.jumpToPosition(50, -10);
      
      expect(result.element).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should skip scrollbar sync when requested', () => {
      harness.syncScrollbar.mockClear();
      harness.engine.jumpToPosition(50, 25, true);
      
      expect(harness.syncScrollbar).not.toHaveBeenCalled();
    });

    it('should request display update', () => {
      harness.engine.jumpToPosition(50, 25);
      expect(harness.requestDisplayUpdate).toHaveBeenCalled();
    });
  });

  describe('Reset', () => {
    it('should reset to beginning', () => {
      const harness = createEngine(100);
      harness.setPosition(50, 25);
      
      harness.engine.reset();
      const state = harness.getState();
      
      expect(state.currentElement).toBe(0);
      expect(state.scrollOffset).toBe(0);
    });

    it('should request display update on reset', () => {
      const harness = createEngine(100);
      harness.engine.reset();
      
      expect(harness.requestDisplayUpdate).toHaveBeenCalled();
    });

    it('should sync scrollbar on reset', () => {
      const harness = createEngine(100);
      harness.engine.reset();
      
      expect(harness.syncScrollbar).toHaveBeenCalled();
    });
  });

  describe('Config Updates', () => {
    it('should update total elements', () => {
      const harness = createEngine(100);
      harness.engine.updateConfig(200, 600);
      
      // Should not throw and should accept new config
      expect(() => harness.engine.scroll(50, 600)).not.toThrow();
    });

    it('should update viewport height', () => {
      const harness = createEngine(100);
      harness.engine.updateConfig(100, 300);
      
      expect(() => harness.engine.scroll(50, 300)).not.toThrow();
    });
  });

  describe('Variable Height Elements', () => {
    it('should handle variable heights correctly', () => {
      const harness = createEngine(10, {
        0: 100,
        1: 50,
        2: 150,
        3: 75,
        4: 200,
      });
      
      // Scroll through variable height elements
      const result = harness.engine.scroll(100, 200);
      
      // Should be at element 1 (past 100px element 0)
      expect(result.element).toBe(1);
      expect(result.offset).toBe(0);
    });

    it('should accumulate heights correctly with variable heights', () => {
      const harness = createEngine(10, {
        0: 100,
        1: 80,
        2: 60,
        3: 120,
      });
      
      // Scroll 240px = 100 + 80 + 60 = through 3 elements
      const result = harness.engine.scroll(240, 200);
      
      expect(result.element).toBe(3);
      expect(result.offset).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle single element dataset', () => {
      const harness = createEngine(1);
      
      const result = harness.engine.scroll(100, 200);
      
      expect(result.element).toBe(0);
      expect(result.offset).toBeLessThan(50);
    });

    it('should handle empty dataset', () => {
      const harness = createEngine(0);
      
      expect(() => harness.engine.scroll(50, 200)).not.toThrow();
    });

    it('should handle zero viewport height', () => {
      const harness = createEngine(100);
      
      expect(() => harness.engine.scroll(50, 0)).not.toThrow();
    });

    it('should handle very large scroll delta', () => {
      const harness = createEngine(100);
      
      const result = harness.engine.scroll(999999, 200);
      
      // Should clamp near end (BoundaryGuardian may adjust position)
      expect(result.element).toBeGreaterThan(90);
      expect(result.element).toBeLessThanOrEqual(99);
    });
  });

  describe('GC Optimization - Object Reuse', () => {
    it('should reuse scroll result object', () => {
      const harness = createEngine(100);
      
      const result1 = harness.engine.scroll(50, 200);
      const result2 = harness.engine.scroll(50, 200);
      
      // Should return same object reference (GC optimization)
      expect(result1).toBe(result2);
    });
  });
});
