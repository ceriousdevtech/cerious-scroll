/**
 * @fileoverview CeriousScroll - Refactored Main Class
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 * 
 * This is the main entry point for CeriousScroll, now refactored into modular components
 * for better maintainability, testing, and code organization.
 */

import { 
  ElementHeightCalculator, 
  ElementRenderer, 
  ScrollResult, 
  MeasuredViewportRange, 
  CeriousScrollOptions,
  TouchNavigationOptions,
  WheelNavigationOptions
} from './types/index.js';
import { PerformanceCache } from './core/performance-cache.js';
import { NativeScrollbar } from './features/native-scrollbar.js';
import { ViewportRenderer } from './features/viewport-renderer.js';
import { NavigationEngine } from './engine/navigation-engine.js';
import { ViewportStateCalculator } from './core/viewport-state.js';
import { WheelController } from './controllers/wheel-controller.js';
import { TouchController } from './controllers/touch-controller.js';
import { ContentObserverManager } from './observers/content-observer.js';
import { KeyboardController } from './controllers/keyboard-controller.js';
import { ResizeController } from './controllers/resize-controller.js';

/**
 * CeriousScroll - High-Performance Virtual Scrolling Implementation
 *
 * A framework-agnostic virtual scrolling solution optimized for large datasets with variable element heights.
 * This class provides precise scroll calculations, viewport management, and efficient rendering strategies
 * for lists containing thousands of elements while maintaining smooth 60fps+ performance.
 * 
 * @example
 * ```typescript
 * const container = document.getElementById('scrollContainer');
 * const scroller = new CeriousScroll(
 *   container,    // Auto-detects height and attaches scrollbar
 *   data.length,  // Total number of elements
 *   40            // Default element height (optional)
 * );
 * 
 * container.addEventListener('wheel', (e) => {
 *   e.preventDefault();
 *   const { element, offset } = scroller.scroll(e.deltaY, container.clientHeight);
 *   
 *   // Use renderViewport for DOM measurement and rendering
 *   const viewport = scroller.renderViewport(container.clientHeight, container, (index, elementContainer) => {
 *     elementContainer.innerHTML = `<div class="item">${data[index].content}</div>`;
 *     return elementContainer.offsetHeight; // Return measured height
 *   });
 * });
 * ```
 */
export class CeriousScroll {
  // ===== CONFIGURATION =====
  totalElements!: number;
  viewportHeight!: number; 
  windowHeight!: number;
  showDebug = false;

  // ===== CONSTANTS =====
  private static readonly VIRTUAL_TRACK_HEIGHT = 15000;
  private static readonly DEFAULT_ELEMENT_HEIGHT = 40;
  private static readonly VIEWPORT_BUFFER_SIZE = 50;
  private static readonly NEAR_END_THRESHOLD = 100;
  private static readonly OVERSCAN_BUFFER_SIZE = 5;

  // ===== SCROLL STATE =====  
  currentElement = 0;
  scrollOffset = 0;
  scrollPercentage = 0;
  viewportTop = 0;
  startElement = 0;
  endElement = 0;
  totalContentHeight = 0;

  // ===== MODULE INSTANCES =====
  private performanceCache: PerformanceCache;
  private nativeScrollbar: NativeScrollbar;
  private viewportRenderer: ViewportRenderer;
  private navigationEngine: NavigationEngine;
  private keyboardController: KeyboardController;
  private resizeController: ResizeController;
  private viewportStateCalculator: ViewportStateCalculator;
  private wheelController: WheelController;
  private touchController: TouchController;
  private contentObserverManager: ContentObserverManager;

  // ===== ELEMENT HEIGHT CALCULATOR =====
  getElementHeight!: ElementHeightCalculator;

  // ===== EVENT HANDLER CLEANUP =====
  private keyboardCleanup?: () => void;
  private wheelCleanup?: () => void;
  private touchCleanup?: () => void;
  private resizeCleanup?: () => void;
  private contentObserverCleanup?: () => void;

  /**
   * Create a new CeriousScroll instance with automatic measurement and viewport detection
   */
  constructor(
    container: HTMLElement,
    totalElements: number, 
    options: CeriousScrollOptions = {}
  ) {
    this.totalElements = totalElements;
    
    // Auto-detect viewport height from container
    this.viewportHeight = container.clientHeight || container.offsetHeight || 600;
    this.windowHeight = this.viewportHeight; // Keep in sync
    
    if (totalElements < 1) {
      throw new Error('CeriousScroll: totalElements must be >= 1');
    }
    if (!container) {
      throw new Error('CeriousScroll: container element is required for automatic viewport detection');
    }

    // Create measurement-only height calculator - uses just-in-time measurement
    this.getElementHeight = (index: number) => {
      // Use measured height if available
      const measuredHeight = this.performanceCache.getMeasuredHeight(index);
      if (measuredHeight !== undefined) {
        return measuredHeight;
      }
      
      // For unmeasured elements, return default height
      // Store it temporarily to maintain consistency during scroll calculations
      this.performanceCache.setMeasuredHeight(index, CeriousScroll.DEFAULT_ELEMENT_HEIGHT);
      
      return CeriousScroll.DEFAULT_ELEMENT_HEIGHT;
    };
    
    // Initialize performance cache
    this.performanceCache = new PerformanceCache(this.getElementHeight);

    // Initialize native scrollbar (note: scrollHandlers will be passed after it's created)
    this.nativeScrollbar = new NativeScrollbar(
      this.totalElements,
      () => this.calculateScrollPercentage(),
      this.getElementHeight,
      (element: number, offset: number) => {
        this.currentElement = element;
        this.scrollOffset = offset;
      },
      null as any, // scrollHandlers - will be set after initialization
      () => this.viewportHeight,
      () => this.currentElement,
      () => this.scrollOffset,
      () => this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight),
      CeriousScroll.VIRTUAL_TRACK_HEIGHT,
      (result) => {
        // Trigger render when scrollbar position changes
        if (options.onScroll) {
          options.onScroll();
        }
      }
    );

    // Initialize viewport renderer
    this.viewportRenderer = new ViewportRenderer(
      this.totalElements,
      () => this.currentElement,
      () => this.scrollOffset,
      () => this.calculateScrollPercentage(),
      (index: number, height: number) => this.performanceCache.setMeasuredHeight(index, height),
      (index: number) => this.performanceCache.hasMeasuredHeight(index),
      (index: number) => this.performanceCache.getMeasuredHeight(index)
    );

    this.navigationEngine = new NavigationEngine({
      totalElements: this.totalElements,
      viewportHeight: this.viewportHeight,
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset,
      getElementHeight: (index: number) => this.getElementHeight(index),
      hasMeasuredHeight: (index: number) => this.performanceCache.hasMeasuredHeight(index),
      getLastRenderedElement: () => this.viewportRenderer.lastRenderedElement,
      getElementViewportPosition: (index: number) => this.getElementViewportPosition(index),
      getCalculateScrollPercentage: () => this.calculateScrollPercentage(),
      updateScrollPosition: (element: number, offset: number) => {
        this.currentElement = element;
        this.scrollOffset = offset;
      },
      requestDisplayUpdate: () => this.updateDisplay(),
      syncScrollbar: () => {
        if (this.nativeScrollbar.container && !this.nativeScrollbar.isSyncing) {
          this.nativeScrollbar.updateLastProgrammaticUpdate();
          this.nativeScrollbar.syncNativeScrollbar();
        }
      },
      getTrueBottomPosition: () => this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight)
    });

    this.keyboardController = new KeyboardController({
      scroll: (deltaY: number, viewportHeight: number) => this.navigationEngine.scroll(deltaY, viewportHeight),
      jumpToElement: (index: number) => this.navigationEngine.jumpToElement(index),
      getViewportHeight: () => this.viewportHeight,
      getScrollPercentage: () => this.calculateScrollPercentage(),
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset
    });

    this.resizeController = new ResizeController((containerEl) => {
      this.handleViewportChange(containerEl);
    });
    
    this.viewportStateCalculator = new ViewportStateCalculator({
      totalElements: () => this.totalElements,
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset,
      getElementHeight: (index: number) => this.getElementHeight(index),
      getWindowHeight: () => this.windowHeight,
      calculateScrollPercentage: () => this.calculateScrollPercentage(),
      bufferSize: CeriousScroll.VIEWPORT_BUFFER_SIZE,
      nearEndThreshold: CeriousScroll.NEAR_END_THRESHOLD,
      virtualTrackHeight: CeriousScroll.VIRTUAL_TRACK_HEIGHT
    });
    
    this.wheelController = new WheelController({
      scroll: (deltaY: number, viewportHeight: number) => this.scroll(deltaY, viewportHeight),
      calculateScrollPercentage: () => this.calculateScrollPercentage(),
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset
    });
    
    this.touchController = new TouchController({
      scroll: (deltaY: number, viewportHeight: number) => this.scroll(deltaY, viewportHeight),
      calculateScrollPercentage: () => this.calculateScrollPercentage(),
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset
    });

    this.contentObserverManager = new ContentObserverManager({
      getMeasuredHeight: (index: number) => this.performanceCache.getMeasuredHeight(index),
      setMeasuredHeight: (index: number, height: number) => this.performanceCache.setMeasuredHeight(index, height),
      invalidateCache: () => this.invalidateCache()
    });
    
    // Now set scrollHandlers on nativeScrollbar
    (this.nativeScrollbar as any).scrollHandlers = this.navigationEngine;
    
    this.totalContentHeight = 0;
    this.updateDisplay();

    // Optional debug hook for automated harnesses (e.g., Playwright) and field diagnostics.
    // Enabled only when the URL includes ?debugScroll=1 (or debugScroll=true), so this stays
    // inert in normal usage.
    try {
      const params = new URLSearchParams(globalThis.location?.search ?? '');
      const enabled = params.has('debugScroll') && params.get('debugScroll') !== '0' && params.get('debugScroll') !== 'false';
      if (enabled) {
        (globalThis as any).__ceriousScrollDebug = () => {
          const trueBottom = this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight);
          return {
            version: 'cerious-scroll-debug-v1',
            totalElements: this.totalElements,
            viewportHeight: this.viewportHeight,
            currentElement: this.currentElement,
            scrollOffset: this.scrollOffset,
            scrollPercentage: this.calculateScrollPercentage(),
            lastRenderedRange: this.viewportRenderer.lastRenderedRange,
            renderedElementCount: this.viewportRenderer.renderedElementCount,
            renderer: this.viewportRenderer.lifecycleStats,
            trueBottom,
          };
        };
      }
    } catch {
      // Ignore environments without URL/location (SSR/tests)
    }

    // Conditionally attach native scrollbar (default: true)
    if (options.attachScrollbar !== false) {
      this.nativeScrollbar.attachNativeScrollbar(container);
    }
    
    // Set up keyboard navigation if enabled (default: true)
    if (options.keyboard?.enabled !== false) {
      this.keyboardCleanup = this.keyboardController.attach(
        container,
        options.keyboard,
        () => {
          if (options.onScroll) {
            options.onScroll();
          }
        }
      );
    }

    // Set up wheel navigation if enabled (default: true)
    if (options.wheel?.enabled !== false) {
      this.wheelCleanup = this.setupWheelHandler(container, () => {
        if (options.onScroll) {
          options.onScroll();
        }
      }, options.wheel);
    }

    // Set up touch navigation if enabled (default: true)
    if (options.touch?.enabled !== false) {
      this.touchCleanup = this.touchController.attach(
        container,
        () => {
          if (options.onScroll) {
            options.onScroll();
          }
        },
        options.touch
      );
    }
    
    // Set up automatic resize handling (default: enabled)
    // This ensures the scroller adapts when browser window or container is resized
    if (options.autoResize !== false) {
      this.resizeCleanup = this.setupAutoResizeHandling(container);
    }
    
    // Set up automatic content change detection (default: enabled)
    // This detects when rendered elements change size and invalidates height caches
    if (options.observeContentChanges !== false) {
      this.contentObserverCleanup = this.contentObserverManager.observe(container);
    }
  }

  /**
   * Get the last rendered element from the dataset
   */
  get lastRenderedElement(): HTMLElement | null {
    return this.viewportRenderer.lastRenderedElement;
  }

  /**
   * Get the indices of all currently rendered elements in the viewport
   * @returns Array of element indices currently rendered
   */
  getRenderedIndices(): number[] {
    return this.viewportRenderer.getRenderedIndices();
  }

  /**
   * Get a specific rendered element's container by index
   * @param index Element index
   * @returns The DOM container element or null if not currently rendered
   */
  getRenderedElement(index: number): HTMLElement | null {
    return this.viewportRenderer.getRenderedElement(index);
  }

  /**
   * Cache a measured height for a specific element
   * @param index Element index
   * @param height Measured height in pixels
   */
  setMeasuredHeight(index: number, height: number): void {
    this.performanceCache.setMeasuredHeight(index, height);
  }

  // ===== SCROLL EVENT HANDLING =====

  /**
   * Process mouse wheel scroll events with variable element height support
   * 
   * @param deltaY Scroll delta in pixels (positive = scroll down, negative = scroll up)
   * @param viewportHeight Current viewport height for boundary calculations
   * @returns Object containing the new element index and pixel offset
   */
  scroll(deltaY: number, viewportHeight: number): ScrollResult {
    return this.navigationEngine.scroll(deltaY, viewportHeight);
  }

  /**
   * Get an element's position relative to the viewport
   * 
   * @param elementIndex The index of the element to get position for
   * @returns Object with top and bottom positions relative to viewport
   */
  getElementViewportPosition(elementIndex: number): { top: number; bottom: number; isVisible: boolean } {
    if (elementIndex < 0 || elementIndex >= this.totalElements) {
      throw new Error(`Element index ${elementIndex} is out of bounds (0-${this.totalElements - 1})`);
    }

    // OPTIMIZED: Calculate position relative to current viewport instead of from element 0
    let elementRelativeTop = -this.scrollOffset; // Start from current viewport position
    
    if (elementIndex >= this.currentElement) {
      // Element is at or after current element - sum forward
      for (let i = this.currentElement; i < elementIndex; i++) {
        elementRelativeTop += this.getElementHeight(i);
      }
    } else {
      // Element is before current element - sum backward  
      for (let i = this.currentElement - 1; i >= elementIndex; i--) {
        elementRelativeTop -= this.getElementHeight(i);
      }
    }

    // Calculate element bottom position
    const elementHeight = this.getElementHeight(elementIndex);
    const elementRelativeBottom = elementRelativeTop + elementHeight;

    // Check if element is visible in viewport
    const isVisible = elementRelativeBottom > 0 && elementRelativeTop < this.viewportHeight;

    return {
      top: elementRelativeTop,
      bottom: elementRelativeBottom,
      isVisible
    };
  }

  /**
   * Navigate to a specific scroll percentage position
   * 
   * @param percentage Scroll position as percentage (0.0 = top, 100.0 = bottom)
   * @returns Object containing the calculated element index and pixel offset
   */
  handleScrollPercentage(percentage: number): ScrollResult {
    return this.navigationEngine.handleScrollPercentage(percentage);
  }

  /**
   * Jump directly to a specific element index
   * 
   * @param elementIndex Zero-based index of the target element
   * @returns Object containing the final element and offset (offset will be 0)
   */
  jumpToElement(elementIndex: number): ScrollResult {
    return this.navigationEngine.jumpToElement(elementIndex);
  }

  /**
   * Reset scroll position to the beginning
   */
  reset(): void {
    this.navigationEngine.reset();
  }

  // ===== VIEWPORT CALCULATION METHODS =====

  /**
   * Calculate the range of elements currently visible in the viewport using actual DOM rendering and measurement
   * 
   * @param windowHeight Height of the viewport window in pixels
   * @param container The DOM container element where elements will be rendered and measured
   * @param renderElement Callback function that renders an element and returns its measured height
   * @returns Object containing viewport information with measured heights
   */
  renderViewport(
    windowHeight: number, 
    container: HTMLElement, 
    renderElement: ElementRenderer
  ): MeasuredViewportRange {
    return this.viewportRenderer.renderViewport(windowHeight, container, renderElement);
  }

  /**
   * Calculate current scroll position as a percentage
   * 
   * @returns Scroll percentage from 0.0 (top) to 100.0 (bottom)
   */
  calculateScrollPercentage(): number {
    // Get the true bottom position based on measured elements
    const trueBottom = this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight);
    
    // Calculate current position as a scalar value
    let currentPosition = this.currentElement;
    if (this.scrollOffset > 0 && this.currentElement < this.totalElements - 1) {
      const elementHeight = this.getElementHeight(this.currentElement);
      const offsetFraction = elementHeight > 0 ? this.scrollOffset / elementHeight : 0;
      currentPosition += offsetFraction;
    }
    
    // If we have a true bottom position, use it as the maximum
    if (trueBottom) {
      const trueBottomElementHeight = this.getElementHeight(trueBottom.element);
      const trueBottomPosition = trueBottom.element + (trueBottomElementHeight > 0 ? trueBottom.offset / trueBottomElementHeight : 0);
      
      if (trueBottomPosition <= 0) return 0;
      
      // If we're at or past the true bottom position, return 100%
      if (currentPosition >= trueBottomPosition - 0.01) {
        return 100;
      }
      
      const percentage = (currentPosition / trueBottomPosition) * 100;
      return Math.max(0, Math.min(100, percentage));
    }
    
    // Fallback to old calculation if true bottom not available
    const totalPositions = this.totalElements - 1;
    if (totalPositions <= 0) return 0;
    
    const percentage = (currentPosition / totalPositions) * 100;
    return Math.max(0, Math.min(100, percentage));
  }

  /**
   * Calculate total height of all content in the dataset
   * 
   * @param totalElements Number of elements to calculate height for
   * @returns Total height in pixels
   */
  calculateTotalContentHeight(totalElements: number): number {
    return this.performanceCache.calculateTotalContentHeight(totalElements);
  }

  /**
   * Get cumulative height up to a specific row
   * 
   * @param row Row index to calculate cumulative height for
   * @returns Total height from row 0 to row-1 (exclusive)
   */
  getCumulativeHeight(row: number): number {
    return this.performanceCache.getCumulativeHeight(row);
  }

  /**
   * Find row and offset from absolute scroll position
   * 
   * @param scrollPixel Absolute scroll position in pixels
   * @returns Object with row index and pixel offset within that row
   */
  findRowFromScrollPosition(scrollPixel: number): { element: number; offset: number } {
    return this.performanceCache.findRowFromScrollPosition(scrollPixel);
  }

  /**
   * Invalidate all performance caches
   */
  invalidateCache(): void {
    this.performanceCache.invalidateCache();
    this.viewportRenderer.invalidateTrueBottomCache();
  }

  /**
   * Clear all caches including measured heights when dataset changes
   */
  clearAllCaches(): void {
    this.performanceCache.clearAllCaches();
    this.viewportRenderer.invalidateTrueBottomCache();
  }

  // ===== DISPLAY STATE MANAGEMENT =====

  /**
   * Update all calculated display properties
   */
  updateDisplay(): void {
    const snapshot = this.viewportStateCalculator.calculate();
    this.startElement = snapshot.startElement;
    this.endElement = snapshot.endElement;
    this.scrollPercentage = snapshot.scrollPercentage;
    this.viewportTop = snapshot.viewportTop;
  }

  // ===== NATIVE SCROLLBAR INTEGRATION =====

  /**
   * Handle viewport changes that might affect scrollbar width
   * 
   * @param container The container element with the scrollbar
   */
  handleViewportChange(container: HTMLElement): void {
    // Update viewport height from container
    this.viewportHeight = container.clientHeight || container.offsetHeight || 600;
    this.windowHeight = this.viewportHeight;
    
    // Update modules with new viewport height
    this.navigationEngine.updateConfig(this.totalElements, this.viewportHeight);
    
    // Handle scrollbar viewport change
    this.nativeScrollbar.handleViewportChange(container, this.viewportHeight);
  }

  /**
   * Set up automatic handling of viewport changes
   * 
   * @param container The container element with the scrollbar
   * @returns A cleanup function to remove the resize listener
   */
  setupAutoResizeHandling(container: HTMLElement): () => void {
    return this.resizeController.attach(container);
  }

  /**
   * Detach and remove the native scrollbar from the container
   * 
   * @param container The container to remove the scrollbar from
   */
  detachScrollbar(container?: HTMLElement): void {
    this.nativeScrollbar.detachScrollbar(container);
  }

  /**
   * Set up automatic wheel event handling on the container
   * 
   * This attaches a wheel event listener that automatically calls scroll
   * and dispatches viewport-change events for rendering updates.
   * 
   * @param container The container element to attach the wheel listener to
   * @param onScroll Optional callback invoked after each scroll with scroll result
   * @returns Cleanup function to remove the wheel listener
   * 
   * @example
   * ```typescript
   * const cleanup = scroller.setupWheelHandler(container, (result) => {
   *   // Re-render viewport
   *   scroller.renderViewport(container.clientHeight, container, renderCallback);
   * });
   * ```
   */
  setupWheelHandler(
    container: HTMLElement,
    onScroll?: (result: ScrollResult) => void,
    wheelOptions?: WheelNavigationOptions
  ): () => void {
    return this.wheelController.attach(container, onScroll, wheelOptions);
  }

  /**
   * Set up automatic touch event handling on the container
   * 
   * This attaches touch event listeners that translate touch gestures into scroll
   * operations, with momentum/inertia support.
   * 
   * @param container The container element to attach touch listeners to
   * @param onScroll Optional callback invoked after each scroll with scroll result
   * @param options Touch navigation options
   * @returns Cleanup function to remove touch listeners
   * 
   * @example
   * ```typescript
   * const cleanup = scroller.setupTouchHandler(container, (result) => {
   *   scroller.renderViewport(container.clientHeight, container, renderCallback);
   * });
   * ```
   */
  setupTouchHandler(
    container: HTMLElement,
    onScroll?: (result: ScrollResult) => void,
    options?: TouchNavigationOptions
  ): () => void {
    return this.touchController.attach(container, onScroll, options);
  }

  /**
   * Cleanup method - call when disposing of the CeriousScroll instance
   */
  dispose(): void {
    // Clean up keyboard navigation
    if (this.keyboardCleanup) {
      this.keyboardCleanup();
      this.keyboardCleanup = undefined;
    }

    // Clean up wheel navigation
    if (this.wheelCleanup) {
      this.wheelCleanup();
      this.wheelCleanup = undefined;
    }

    // Clean up touch navigation
    if (this.touchCleanup) {
      this.touchCleanup();
      this.touchCleanup = undefined;
    }
    
    // Clean up resize handling
    if (this.resizeCleanup) {
      this.resizeCleanup();
      this.resizeCleanup = undefined;
    }
    
    if (this.contentObserverCleanup) {
      this.contentObserverCleanup();
      this.contentObserverCleanup = undefined;
    }
    
    // Clear all caches
    this.clearAllCaches();
  }
}