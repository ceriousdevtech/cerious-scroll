/**
 * @fileoverview Unit tests for ViewportStateCalculator module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ViewportStateCalculator } from '../../src/core/viewport-state.js';
import { createElementHeights, createMockHeightCalculator } from '../helpers/test-helpers.js';

describe('ViewportStateCalculator', () => {
  describe('Basic Viewport Calculation', () => {
    it('should calculate viewport range for start position', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      let currentElement = 0;
      let scrollOffset = 0;
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => currentElement,
        getScrollOffset: () => scrollOffset,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(0);
      expect(snapshot.scrollPercentage).toBe(0);
      expect(snapshot.viewportTop).toBe(0);
      // With 600px viewport and 50px elements, should show ~12 elements
      expect(snapshot.endElement).toBeGreaterThan(10);
    });

    it('should calculate viewport range for middle position', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      let currentElement = 50;
      let scrollOffset = 0;
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => currentElement,
        getScrollOffset: () => scrollOffset,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 50,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(50);
      expect(snapshot.scrollPercentage).toBe(50);
      // End element should be start + visible elements + buffer
      expect(snapshot.endElement).toBeGreaterThan(50);
    });

    it('should handle partial scroll offset', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      let currentElement = 10;
      let scrollOffset = 25; // Halfway through element
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => currentElement,
        getScrollOffset: () => scrollOffset,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 10,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(10);
      // Should account for partial visibility
      expect(snapshot.endElement).toBeGreaterThan(10);
    });
  });

  describe('Buffer Zone Handling', () => {
    it('should apply buffer to end element', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 20,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // With 600px viewport and 50px elements: 12 visible + 20 buffer = 32
      // But also constrained by dataset size
      expect(snapshot.endElement).toBeGreaterThanOrEqual(12);
    });

    it('should use larger buffer near end of dataset', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 90, // Near end
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 90,
        bufferSize: 20,
        nearEndThreshold: 100, // Within 100 elements of end
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Near end, should extend to last element
      expect(snapshot.endElement).toBe(99);
    });

    it('should respect dataset boundaries', () => {
      const heights = createElementHeights(20, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 20,
        getCurrentElement: () => 10,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 50,
        bufferSize: 100, // Large buffer
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Should not exceed dataset
      expect(snapshot.endElement).toBeLessThanOrEqual(19);
    });
  });

  describe('Variable Height Elements', () => {
    it('should handle variable height elements correctly', () => {
      const heights = createElementHeights(100, 50, {
        10: 100, // Tall element
        11: 150, // Very tall
        12: 200, // Extra tall
        13: 50,  // Normal
      });
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 10,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 10,
        bufferSize: 10,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(10);
      // With large elements, fewer should fit in viewport
      // Elements 10-13 total 500px, leaving room for 2 more normal elements
      expect(snapshot.endElement).toBeGreaterThanOrEqual(13);
    });

    it('should calculate correct accumulated height with variable heights', () => {
      const heights = createElementHeights(100, 50, {
        0: 100,
        1: 50,
        2: 75,
        3: 125,
      });
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 300,
        calculateScrollPercentage: () => 0,
        bufferSize: 5,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // 100 + 50 + 75 + 125 = 350px for first 4 elements
      // Should show elements 0-3 (350px > 300px viewport)
      expect(snapshot.endElement).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Scroll Percentage and Viewport Top', () => {
    it('should calculate viewport top based on scroll percentage', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      expect(snapshot.viewportTop).toBe(0);
    });

    it('should calculate viewport top at 50% scroll', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 50,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 50,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // At 50%, viewport top should be 50% of (virtualTrackHeight - windowHeight)
      const expectedTop = 0.5 * (15000 - 600);
      expect(snapshot.viewportTop).toBeCloseTo(expectedTop, 0);
    });

    it('should calculate viewport top at 100% scroll', () => {
      const heights = createElementHeights(100, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 99,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 100,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // At 100%, viewport top should be (virtualTrackHeight - windowHeight)
      const expectedTop = 15000 - 600;
      expect(snapshot.viewportTop).toBeCloseTo(expectedTop, 0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty dataset', () => {
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 0,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: () => 50,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(0);
      expect(snapshot.endElement).toBe(0);
      expect(snapshot.scrollPercentage).toBe(0);
    });

    it('should handle single element dataset', () => {
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 1,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: () => 50,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      expect(snapshot.startElement).toBe(0);
      expect(snapshot.endElement).toBe(0);
    });

    it('should handle viewport larger than all content', () => {
      const heights = createElementHeights(10, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 10,
        getCurrentElement: () => 0,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 10000, // Very large viewport
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Should show all elements
      expect(snapshot.endElement).toBe(9);
    });

    it('should handle negative current element (boundary case)', () => {
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => -5, // Invalid but should be clamped
        getScrollOffset: () => 0,
        getElementHeight: () => 50,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 0,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Should clamp to valid range
      expect(snapshot.startElement).toBeGreaterThanOrEqual(0);
    });

    it('should handle current element beyond dataset', () => {
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 150, // Beyond dataset
        getScrollOffset: () => 0,
        getElementHeight: () => 50,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 100,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Should clamp to dataset bounds
      expect(snapshot.startElement).toBeLessThanOrEqual(99);
    });

    it('should handle zero window height', () => {
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 100,
        getCurrentElement: () => 50,
        getScrollOffset: () => 0,
        getElementHeight: () => 50,
        getWindowHeight: () => 0,
        calculateScrollPercentage: () => 50,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const snapshot = stateCalc.calculate();
      
      // Should handle gracefully without crashing
      expect(snapshot.startElement).toBe(50);
    });
  });

  describe('Performance', () => {
    it('should calculate efficiently for large datasets', () => {
      const heights = createElementHeights(1000000, 50);
      const calculator = createMockHeightCalculator(heights);
      
      const stateCalc = new ViewportStateCalculator({
        totalElements: () => 1000000,
        getCurrentElement: () => 500000,
        getScrollOffset: () => 0,
        getElementHeight: calculator,
        getWindowHeight: () => 600,
        calculateScrollPercentage: () => 50,
        bufferSize: 50,
        nearEndThreshold: 100,
        virtualTrackHeight: 15000,
      });
      
      const start = performance.now();
      const snapshot = stateCalc.calculate();
      const duration = performance.now() - start;
      
      // Should complete quickly even for large dataset
      expect(duration).toBeLessThan(10); // milliseconds
      expect(snapshot.startElement).toBe(500000);
    });
  });
});
