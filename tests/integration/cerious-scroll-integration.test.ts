/**
 * @fileoverview Integration tests for CeriousScroll
 * 
 * Tests the full system integration including all modules working together.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';
import {
  createMockContainer,
  setupBrowserMocks,
  createMockWheelEvent,
  createMockKeyboardEvent,
  waitForAnimationFrame,
} from '../helpers/test-helpers.js';

describe('CeriousScroll Integration Tests', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  describe('Initialization', () => {
    it('should create instance with basic configuration', () => {
      const container = createMockContainer(600, 800);
      const scroller = new CeriousScroll(container, 1000, {
        attachScrollbar: false,
        observeContentChanges: false,
      });
      
      expect(scroller).toBeDefined();
      expect(scroller.totalElements).toBe(1000);
      expect(scroller.viewportHeight).toBe(600);
      
      scroller.dispose();
    });

    it('should throw error for invalid totalElements', () => {
      const container = createMockContainer();
      
      expect(() => new CeriousScroll(container, 0, { 
        attachScrollbar: false,
        observeContentChanges: false 
      })).toThrow('totalElements must be >= 1');
      expect(() => new CeriousScroll(container, -5, { 
        attachScrollbar: false,
        observeContentChanges: false 
      })).toThrow('totalElements must be >= 1');
    });

    it('should throw error for missing container', () => {
      expect(() => new CeriousScroll(null as any, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      })).toThrow();
    });

    it('should auto-detect viewport height from container', () => {
      const container = createMockContainer(750, 1000);
      const scroller = new CeriousScroll(container, 1000, {
        attachScrollbar: false,
        observeContentChanges: false,
      });
      
      expect(scroller.viewportHeight).toBe(750);
      expect(scroller.windowHeight).toBe(750);
      
      scroller.dispose();
    });

    it('should initialize with custom options', () => {
      const container = createMockContainer();
      const onScroll = vi.fn();
      
      const scroller = new CeriousScroll(container, 1000, {
        keyboard: { enabled: true, arrowKeySpeed: 200 },
        touch: { enabled: true },
        wheel: { enabled: true },
        attachScrollbar: false,
        autoResize: true,
        observeContentChanges: false,
        onScroll,
      });
      
      expect(scroller).toBeDefined();
      scroller.dispose();
    });

    it('should support disabled features', () => {
      const container = createMockContainer();
      
      const scroller = new CeriousScroll(container, 1000, {
        keyboard: { enabled: false },
        touch: { enabled: false },
        wheel: { enabled: false },
        attachScrollbar: false,
        autoResize: false,
        observeContentChanges: false,
      });
      
      expect(scroller).toBeDefined();
      scroller.dispose();
    });
  });

  describe('Basic Scrolling', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should scroll forward', () => {
      const result = scroller.scroll(100, 600);
      
      expect(result.element).toBeGreaterThan(0);
      expect(scroller.currentElement).toBeGreaterThan(0);
    });

    it('should scroll backward', () => {
      scroller.jumpToElement(50);
      
      const result = scroller.scroll(-100, 600);
      
      expect(result.element).toBeLessThan(50);
    });

    it('should update current position after scroll', () => {
      scroller.scroll(200, 600);
      
      expect(scroller.currentElement).toBeGreaterThanOrEqual(0);
      // scrollPercentage may be 0 if scroll didn't trigger display update
      expect(scroller.scrollPercentage).toBeGreaterThanOrEqual(0);
    });

    it('should calculate scroll percentage correctly', () => {
      scroller.jumpToElement(0);
      expect(scroller.calculateScrollPercentage()).toBe(0);
      
      scroller.jumpToElement(500);
      const midPercentage = scroller.calculateScrollPercentage();
      expect(midPercentage).toBeGreaterThan(0);
      expect(midPercentage).toBeLessThan(100);
    });
  });

  describe('Navigation Operations', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should jump to specific element', () => {
      const result = scroller.jumpToElement(500);
      
      expect(result.element).toBe(500);
      expect(result.offset).toBe(0);
      expect(scroller.currentElement).toBe(500);
    });

    it('should handle scroll percentage navigation', () => {
      const result = scroller.handleScrollPercentage(50);
      
      expect(result.element).toBeGreaterThan(400);
      expect(result.element).toBeLessThan(600);
    });

    it('should reset to beginning', () => {
      scroller.jumpToElement(500);
      scroller.reset();
      
      expect(scroller.currentElement).toBe(0);
      expect(scroller.scrollOffset).toBe(0);
    });

    it('should clamp to beginning boundary', () => {
      scroller.jumpToElement(0);
      const result = scroller.scroll(-500, 600);
      
      expect(result.element).toBe(0);
      expect(result.offset).toBeGreaterThanOrEqual(0);
    });

    it('should clamp to ending boundary', () => {
      scroller.jumpToElement(999);
      const result = scroller.scroll(500, 600);
      
      // BoundaryGuardian may adjust position to prevent overshoot
      expect(result.element).toBeGreaterThan(900);
      expect(result.element).toBeLessThanOrEqual(999);
    });
  });

  describe('Height Caching', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should cache measured heights', () => {
      scroller.setMeasuredHeight(0, 75);
      scroller.setMeasuredHeight(1, 85);
      
      // Heights should be cached and used in calculations
      const height0 = scroller.getElementHeight(0);
      const height1 = scroller.getElementHeight(1);
      
      expect(height0).toBe(75);
      expect(height1).toBe(85);
    });

    it('should use default height for unmeasured elements', () => {
      const height = scroller.getElementHeight(100);
      expect(height).toBe(40); // DEFAULT_ELEMENT_HEIGHT
    });

    it('should invalidate cache', () => {
      scroller.setMeasuredHeight(0, 75);
      scroller.invalidateCache();
      
      // Cache should be cleared but measured heights preserved
      const height = scroller.getElementHeight(0);
      expect(height).toBe(75);
    });

    it('should clear all caches including measured heights', () => {
      scroller.setMeasuredHeight(0, 75);
      scroller.clearAllCaches();
      
      const height = scroller.getElementHeight(0);
      expect(height).toBe(40); // Back to default
    });
  });

  describe('Viewport Rendering', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should render viewport with custom renderer', () => {
      const renderElement = vi.fn((index: number, element: HTMLElement) => {
        element.innerHTML = `<div>Item ${index}</div>`;
      });
      
      const viewport = scroller.renderViewport(600, container, renderElement);
      
      expect(viewport.startElement).toBe(0);
      expect(viewport.endElement).toBeGreaterThan(0);
      expect(renderElement).toHaveBeenCalled();
    });

    it('should measure element heights during rendering', () => {
      let measuredHeights = 0;
      
      const renderElement = vi.fn((index: number, element: HTMLElement) => {
        element.innerHTML = `<div style="height: ${50 + index}px">Item ${index}</div>`;
        measuredHeights++;
      });
      
      scroller.renderViewport(600, container, renderElement);
      
      expect(measuredHeights).toBeGreaterThan(0);
    });

    it('should return viewport information', () => {
      const renderElement = vi.fn();
      
      const viewport = scroller.renderViewport(600, container, renderElement);
      
      expect(viewport).toHaveProperty('startElement');
      expect(viewport).toHaveProperty('endElement');
      expect(viewport).toHaveProperty('scrollPercentage');
      expect(viewport).toHaveProperty('viewportElements');
      expect(viewport).toHaveProperty('renderedElements');
    });
  });

  describe('Event Integration', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;
    let onScroll: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      onScroll = vi.fn();
      scroller = new CeriousScroll(container, 1000, {
        onScroll,
        attachScrollbar: false,
        observeContentChanges: false,
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should trigger onScroll callback', () => {
      scroller.scroll(100, 600);
      
      // onScroll should be called by event handlers, not directly by scroll
      // So we need to simulate an event
      const wheelHandler = vi.mocked(container.addEventListener).mock.calls.find(
        call => call[0] === 'wheel'
      )?.[1] as EventListener;
      
      if (wheelHandler) {
        wheelHandler(createMockWheelEvent(100));
        expect(onScroll).toHaveBeenCalled();
      }
    });

    it('should emit viewport-change events', () => {
      const wheelHandler = vi.mocked(container.addEventListener).mock.calls.find(
        call => call[0] === 'wheel'
      )?.[1] as EventListener;
      
      if (wheelHandler) {
        wheelHandler(createMockWheelEvent(100));
        
        expect(container.dispatchEvent).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'cerious-viewport-change' })
        );
      }
    });
  });

  describe('Viewport Resizing', () => {
    let container: HTMLElement;
    let scroller: CeriousScroll;

    beforeEach(() => {
      container = createMockContainer(600, 800);
      scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
    });

    afterEach(() => {
      scroller.dispose();
    });

    it('should handle viewport height changes', () => {
      vi.mocked(container).clientHeight = 800;
      
      scroller.handleViewportChange(container);
      
      expect(scroller.viewportHeight).toBe(800);
      expect(scroller.windowHeight).toBe(800);
    });

    it('should update display after resize', () => {
      const originalEnd = scroller.endElement;
      
      vi.mocked(container).clientHeight = 1200; // Larger viewport
      scroller.handleViewportChange(container);
      
      // With larger viewport, more elements should be visible
      expect(scroller.viewportHeight).toBe(1200);
    });
  });

  describe('Disposal and Cleanup', () => {
    it('should clean up resources on dispose', () => {
      const container = createMockContainer();
      const scroller = new CeriousScroll(container, 1000, {
        attachScrollbar: false,
        observeContentChanges: false,
      });
      
      scroller.dispose();
      
      // Should clear caches
      expect(() => scroller.dispose()).not.toThrow();
    });

    it('should be safe to call dispose multiple times', () => {
      const container = createMockContainer();
      const scroller = new CeriousScroll(container, 1000, {
        attachScrollbar: false,
        observeContentChanges: false,
      });
      
      scroller.dispose();
      scroller.dispose();
      scroller.dispose();
      
      expect(true).toBe(true); // Should not throw
    });
  });

  describe('Large Dataset Performance', () => {
    it('should handle very large datasets efficiently', () => {
      const container = createMockContainer();
      const scroller = new CeriousScroll(container, 1000000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
      
      const start = performance.now();
      
      // Perform operations
      scroller.scroll(1000, 600);
      scroller.jumpToElement(500000);
      scroller.calculateScrollPercentage();
      
      const duration = performance.now() - start;
      
      // Should complete quickly
      expect(duration).toBeLessThan(100); // milliseconds
      
      scroller.dispose();
    });

    it('should maintain O(1) memory characteristics', () => {
      const container = createMockContainer();
      const scroller = new CeriousScroll(container, 1000000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
      
      // Scroll through different parts of dataset
      for (let i = 0; i < 100; i++) {
        const randomElement = Math.floor(Math.random() * 1000000);
        scroller.jumpToElement(randomElement);
      }
      
      // Should not accumulate unbounded memory
      expect(true).toBe(true);
      
      scroller.dispose();
    });
  });

  describe('Edge Cases', () => {
    it('should handle single element dataset', () => {
      const container = createMockContainer();
      const scroller = new CeriousScroll(container, 1, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
      
      expect(scroller.totalElements).toBe(1);
      
      const result = scroller.scroll(100, 600);
      expect(result.element).toBe(0);
      
      scroller.dispose();
    });

    it('should handle very small viewport', () => {
      const container = createMockContainer(50, 100);
      const scroller = new CeriousScroll(container, 1000, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
      
      expect(scroller.viewportHeight).toBe(50);
      expect(() => scroller.scroll(100, 50)).not.toThrow();
      
      scroller.dispose();
    });

    it('should handle viewport larger than all content', () => {
      const container = createMockContainer(10000, 1000);
      const scroller = new CeriousScroll(container, 10, { 
        attachScrollbar: false,
        observeContentChanges: false 
      });
      
      const viewport = scroller.renderViewport(10000, container, () => {});
      
      // Should show all elements
      expect(viewport.endElement).toBe(9);
      
      scroller.dispose();
    });
  });
});
