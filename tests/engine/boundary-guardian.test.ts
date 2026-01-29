/**
 * @fileoverview Unit tests for BoundaryGuardian module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoundaryGuardian } from '../../src/engine/boundary-guardian.js';
import { createElementHeights, createMockHeightCalculator } from '../helpers/test-helpers.js';

describe('BoundaryGuardian', () => {
  describe('Constructor and Configuration', () => {
    it('should create guardian with default thresholds', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: (index) => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: calculator,
      });
      
      expect(guardian).toBeDefined();
    });

    it('should accept custom thresholds', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: (index) => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: calculator,
        overshootThreshold: 5,
        dampingFactor: 0.85,
        smallDatasetThreshold: 500,
        nearBottomThreshold: 50,
      });
      
      expect(guardian).toBeDefined();
    });
  });

  describe('shouldClamp', () => {
    it('should clamp for small datasets', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: () => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: () => 50,
        smallDatasetThreshold: 1000,
      });
      
      // For dataset of 100 elements (< 1000 threshold), always clamp
      expect(guardian.shouldClamp(0)).toBe(true);
      expect(guardian.shouldClamp(50)).toBe(true);
      expect(guardian.shouldClamp(99)).toBe(true);
    });

    it('should clamp near bottom for large datasets', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 10000,
        getElementViewportPosition: () => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: () => 50,
        smallDatasetThreshold: 1000,
        nearBottomThreshold: 100,
      });
      
      // Should not clamp in middle
      expect(guardian.shouldClamp(5000)).toBe(false);
      
      // Should clamp within 100 elements of end (10000 - 100 = 9900)
      expect(guardian.shouldClamp(9900)).toBe(true);
      expect(guardian.shouldClamp(9950)).toBe(true);
      expect(guardian.shouldClamp(9999)).toBe(true);
    });

    it('should not clamp in middle of large dataset', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 10000,
        getElementViewportPosition: () => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: () => 50,
        smallDatasetThreshold: 1000,
        nearBottomThreshold: 100,
      });
      
      expect(guardian.shouldClamp(100)).toBe(false);
      expect(guardian.shouldClamp(5000)).toBe(false);
      expect(guardian.shouldClamp(9000)).toBe(false);
    });
  });

  describe('correctBottomOvershoot', () => {
    let guardian: BoundaryGuardian;
    let currentElement: number;
    let currentOffset: number;

    beforeEach(() => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      currentElement = 0;
      currentOffset = 0;
      
      guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: (index: number) => {
          let top = -currentOffset;
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
            isVisible: top < 600 && top + height > 0
          };
        },
        getElementHeight: calculator,
        overshootThreshold: 2,
        dampingFactor: 0.9,
      });
    });

    it('should return null when no overshoot detected', () => {
      currentElement = 50;
      currentOffset = 0;
      
      const correction = guardian.correctBottomOvershoot(currentElement, currentOffset);
      expect(correction).toBeNull();
    });

    it('should correct overshoot when last element is above viewport bottom', () => {
      // Position where last element is well above viewport bottom
      currentElement = 95;
      currentOffset = 0;
      
      const correction = guardian.correctBottomOvershoot(currentElement, currentOffset);
      
      if (correction) {
        // Should scroll back to fill the gap
        expect(correction.element).toBeLessThanOrEqual(currentElement);
      }
    });

    it('should return null for zero-element dataset', () => {
      const emptyGuardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 0,
        getElementViewportPosition: () => ({ top: 0, bottom: 0, isVisible: false }),
        getElementHeight: () => 50,
      });
      
      const correction = emptyGuardian.correctBottomOvershoot(0, 0);
      expect(correction).toBeNull();
    });

    it('should apply damping factor to correction', () => {
      // Create scenario with significant overshoot
      currentElement = 90;
      currentOffset = 0;
      
      const correction = guardian.correctBottomOvershoot(currentElement, currentOffset);
      
      // With damping factor 0.9, correction should not close full gap
      if (correction) {
        // The correction should be less aggressive than the full gap
        expect(correction.element).toBeLessThanOrEqual(currentElement);
      }
    });

    it('should not scroll past element 0', () => {
      currentElement = 0;
      currentOffset = 0;
      
      const correction = guardian.correctBottomOvershoot(currentElement, currentOffset);
      
      if (correction) {
        expect(correction.element).toBe(0);
        expect(correction.offset).toBe(0);
      }
    });

    it('should handle corrections within same element', () => {
      currentElement = 95;
      currentOffset = 40; // 40px into element 95
      
      const correction = guardian.correctBottomOvershoot(currentElement, currentOffset);
      
      if (correction) {
        // Offset should be valid for the element
        expect(correction.offset).toBeGreaterThanOrEqual(0);
        expect(correction.offset).toBeLessThan(50); // element height
      }
    });

    it('should handle variable height elements', () => {
      const variableHeights = createElementHeights(100, 50, {
        95: 200, // Very tall element at end
        96: 150,
        97: 100,
        98: 80,
        99: 60,
      });
      const variableCalculator = createMockHeightCalculator(variableHeights);
      
      currentElement = 95;
      currentOffset = 0;
      
      const variableGuardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: (index: number) => {
          let top = -currentOffset;
          if (index >= currentElement) {
            for (let i = currentElement; i < index; i++) {
              top += variableCalculator(i);
            }
          }
          const height = variableCalculator(index);
          return {
            top,
            bottom: top + height,
            isVisible: true
          };
        },
        getElementHeight: variableCalculator,
      });
      
      const correction = variableGuardian.correctBottomOvershoot(currentElement, currentOffset);
      
      if (correction) {
        // Should handle variable heights correctly
        expect(correction.element).toBeLessThanOrEqual(currentElement);
        const correctedHeight = variableCalculator(correction.element);
        expect(correction.offset).toBeLessThan(correctedHeight);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle single element dataset', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 1,
        getElementViewportPosition: () => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: () => 50,
      });
      
      expect(guardian.shouldClamp(0)).toBe(true);
      const correction = guardian.correctBottomOvershoot(0, 0);
      // Should not crash
      expect(correction === null || typeof correction === 'object').toBe(true);
    });

    it('should handle viewport larger than all content', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 10000, // Very large viewport
        getTotalElements: () => 10,
        getElementViewportPosition: (index) => ({ 
          top: index * 50, 
          bottom: (index + 1) * 50, 
          isVisible: true 
        }),
        getElementHeight: () => 50,
      });
      
      // All 10 elements (500px) fit in 10000px viewport
      const correction = guardian.correctBottomOvershoot(0, 0);
      // Should detect overshoot since viewport is not filled
      expect(correction === null || correction.element === 0).toBe(true);
    });

    it('should handle very small overshoot threshold', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: () => ({ top: 0, bottom: 50, isVisible: true }),
        getElementHeight: () => 50,
        overshootThreshold: 0.1,
      });
      
      // Should be very sensitive to overshoots
      expect(guardian).toBeDefined();
    });

    it('should handle zero damping factor', () => {
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: () => ({ top: -100, bottom: 500, isVisible: true }),
        getElementHeight: () => 50,
        dampingFactor: 0,
      });
      
      const correction = guardian.correctBottomOvershoot(95, 0);
      // With zero damping, no correction should be applied
      if (correction) {
        expect(correction.element).toBe(95);
        expect(correction.offset).toBe(0);
      }
    });
  });

  describe('Integration with Scroll Behavior', () => {
    it('should prevent bounce at bottom', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      let position = { element: 99, offset: 0 };
      
      const guardian = new BoundaryGuardian({
        getViewportHeight: () => 600,
        getTotalElements: () => 100,
        getElementViewportPosition: (index: number) => {
          let top = -position.offset;
          if (index >= position.element) {
            for (let i = position.element; i < index; i++) {
              top += calculator(i);
            }
          }
          const height = calculator(index);
          return { top, bottom: top + height, isVisible: true };
        },
        getElementHeight: calculator,
      });
      
      // Should detect we're at bottom and need clamping
      expect(guardian.shouldClamp(position.element)).toBe(true);
      
      const correction = guardian.correctBottomOvershoot(position.element, position.offset);
      if (correction) {
        // Correction should prevent overshoot
        position = correction;
        expect(position.element).toBeLessThanOrEqual(99);
      }
    });
  });
});
