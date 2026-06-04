/**
 * @fileoverview CeriousScroll - Refactored Main Class
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
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

  /**
   * Measure the usable vertical rendering area inside `container`.
   *
   * Framework wrappers (Vue/React/Angular) create an inner
   * `[data-cerious-scroll-content]` element sized to `height: 100%` of the
   * container. When that inner element opts into horizontal scrolling
   * (e.g. `overflow-x: auto` for a wide spreadsheet), its own
   * `clientHeight` shrinks by the horizontal scrollbar's gutter, while the
   * container's stays unchanged. Reading from the inner element first means
   * the engine renders the right number of rows and the last row stays
   * clear of the scrollbar.
   */
  private static measureViewportHeight(container: HTMLElement): number {
    const inner = container.querySelector<HTMLElement>('[data-cerious-scroll-content]');
    if (inner) {
      const h = inner.clientHeight;
      if (h > 0) return h;
    }
    return container.clientHeight || container.offsetHeight || 600;
  }

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
  private debugCleanup?: () => void;

  // Frozen, deep-cloned options. Mutating the caller's options object after
  // construction must never alter library behavior.
  private readonly options: Readonly<CeriousScrollOptions>;

  /**
   * Create a new CeriousScroll instance with automatic measurement and viewport detection
   */
  constructor(
    container: HTMLElement,
    totalElements: number, 
    options: CeriousScrollOptions = {}
  ) {
    if (!Number.isFinite(totalElements) || totalElements < 1) {
      throw new Error('CeriousScroll: totalElements must be >= 1 (finite integer required)');
    }
    if (!container) {
      throw new Error('CeriousScroll: container element is required for automatic viewport detection');
    }

    // Deep-clone + freeze caller-supplied options. Each nested object is
    // frozen separately so library code (and consumers) cannot accidentally
    // mutate live configuration.
    const frozenOptions: CeriousScrollOptions = {
      ...options,
      keyboard: options.keyboard ? Object.freeze({ ...options.keyboard }) : undefined,
      touch: options.touch ? Object.freeze({ ...options.touch }) : undefined,
      wheel: options.wheel ? Object.freeze({ ...options.wheel }) : undefined,
    };
    this.options = Object.freeze(frozenOptions);

    this.totalElements = Math.floor(totalElements);
    
    // Auto-detect viewport height from container
    this.viewportHeight = CeriousScroll.measureViewportHeight(container);
    this.windowHeight = this.viewportHeight; // Keep in sync

    // Create measurement-only height calculator - uses just-in-time measurement
    this.getElementHeight = (index: number) => {
      // Use the measured height if available, otherwise fall back to the default
      // estimate. Do NOT write the default into the cache: that would make
      // `hasMeasuredHeight(index)` report true for a row that was never actually
      // measured, so the renderer would trust the fake default instead of reading
      // the row's real `offsetHeight` (e.g. after a reflow that touched far-away
      // indices and pruned the real measurements). Estimating without caching
      // keeps "measured" meaning measured.
      const measuredHeight = this.performanceCache.getMeasuredHeight(index);
      return measuredHeight !== undefined ? measuredHeight : CeriousScroll.DEFAULT_ELEMENT_HEIGHT;
    };
    
    // Initialize performance cache
    this.performanceCache = new PerformanceCache(this.getElementHeight);
    // Bound linear walks (e.g. findRowFromScrollPosition) by the dataset size
    // to defend against malformed scroll positions causing runaway loops.
    this.performanceCache.setTotalElements(this.totalElements);

    // Initialize native scrollbar. The navigation engine is constructed below
    // and injected via setScrollHandlers() to avoid the previous `null as any`
    // cast and the NPE risk it created.
    this.nativeScrollbar = new NativeScrollbar(
      this.totalElements,
      () => this.calculateScrollPercentage(),
      this.getElementHeight,
      (element: number, offset: number) => {
        this.currentElement = element;
        this.scrollOffset = offset;
      },
      null, // scrollHandlers - set after NavigationEngine construction
      () => this.viewportHeight,
      () => this.currentElement,
      () => this.scrollOffset,
      () => this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight),
      CeriousScroll.VIRTUAL_TRACK_HEIGHT,
      (result) => {
        // Trigger render when scrollbar position changes
        if (this.options.onScroll) {
          this.options.onScroll();
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
      (index: number) => this.performanceCache.getMeasuredHeight(index),
      () => this.performanceCache.getUniformHeightHint()
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
      invalidateCache: () => this.invalidateCache(),
      // A rendered row changed height in place (e.g. expand/collapse, density
      // switch). Reflow so positions, total height, scroll percentage and the
      // scrollbar update — and the consumer re-renders — without anyone having
      // to call recalculate(). Identical behavior across all frameworks.
      onResize: () => this.reflow()
    });
    
    // Now set scrollHandlers on nativeScrollbar via the typed setter
    this.nativeScrollbar.setScrollHandlers(this.navigationEngine);
    
    this.totalContentHeight = 0;
    this.updateDisplay();

    // Optional debug hook for automated harnesses (e.g., Playwright) and field diagnostics.
    // Enabled only when the URL includes ?debugScroll=1 (or debugScroll=true), so this stays
    // inert in normal usage. Multiple instances share a registry keyed by id
    // so the global hook from one instance never overwrites another.
    try {
      const params = new URLSearchParams(globalThis.location?.search ?? '');
      const enabled = params.has('debugScroll') && params.get('debugScroll') !== '0' && params.get('debugScroll') !== 'false';
      if (enabled) {
        const g = globalThis as any;
        const registry: Map<string, () => any> = g.__ceriousScrollDebugRegistry instanceof Map
          ? g.__ceriousScrollDebugRegistry
          : (g.__ceriousScrollDebugRegistry = new Map());

        const debugId = `cerious-scroll-${(g.__ceriousScrollDebugCounter = (g.__ceriousScrollDebugCounter ?? 0) + 1)}`;
        const snapshot = () => {
          const trueBottom = this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight);
          return {
            version: 'cerious-scroll-debug-v1',
            id: debugId,
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
        registry.set(debugId, snapshot);

        // The default hook returns the most recently created instance for
        // backward compatibility, and accepts an optional id to address a
        // specific instance.
        g.__ceriousScrollDebug = (id?: string) => {
          if (id) return registry.get(id)?.();
          return snapshot();
        };
        g.__ceriousScrollDebug.list = () => Array.from(registry.keys());

        this.debugCleanup = () => {
          registry.delete(debugId);
          if (registry.size === 0) {
            try { delete g.__ceriousScrollDebug; } catch { g.__ceriousScrollDebug = undefined; }
          }
        };
      }
    } catch {
      // Ignore environments without URL/location (SSR/tests)
    }

    // Conditionally attach native scrollbar (default: true)
    if (this.options.attachScrollbar !== false) {
      this.nativeScrollbar.attachNativeScrollbar(container);
    }
    
    // Set up keyboard navigation if enabled (default: true)
    if (this.options.keyboard?.enabled !== false) {
      this.keyboardCleanup = this.keyboardController.attach(
        container,
        this.options.keyboard,
        () => {
          this.options.onScroll?.();
        }
      );
    }

    // Set up wheel navigation if enabled (default: true)
    if (this.options.wheel?.enabled !== false) {
      this.wheelCleanup = this.setupWheelHandler(container, () => {
        this.options.onScroll?.();
      }, this.options.wheel);
    }

    // Set up touch navigation if enabled (default: true)
    if (this.options.touch?.enabled !== false) {
      this.touchCleanup = this.touchController.attach(
        container,
        () => {
          this.options.onScroll?.();
        },
        this.options.touch
      );
    }
    
    // Set up automatic resize handling (default: enabled)
    // This ensures the scroller adapts when browser window or container is resized
    if (this.options.autoResize !== false) {
      this.resizeCleanup = this.setupAutoResizeHandling(container);
    }
    
    // Set up automatic content change detection (default: enabled)
    // This detects when rendered elements change size and invalidates height caches
    if (this.options.observeContentChanges !== false) {
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
   * Re-invoke the renderer callback for every currently-rendered element and
   * re-measure each one's height. Use after in-place row mutations whose new
   * height the engine cannot otherwise observe — e.g. expand/collapse driven
   * by external state, an async image that finished loading and grew its row.
   *
   * Without this, a follow-up renderViewport() call would skip the renderer
   * for already-rendered indices and re-read the stale offsetHeight, so the
   * mutation would silently no-op.
   *
   * Typical usage:
   * ```
   * scroller.refreshVisible(renderCallback);
   * scroller.renderViewport(container.clientHeight, container, renderCallback);
   * ```
   */
  refreshVisible(renderElement: ElementRenderer): void {
    if (typeof renderElement !== 'function') {
      throw new Error('CeriousScroll.refreshVisible: renderElement must be a function');
    }
    this.viewportRenderer.refreshVisible(renderElement);
  }

  /**
   * Cache a measured height for a specific element
   * @param index Element index
   * @param height Measured height in pixels
   */
  setMeasuredHeight(index: number, height: number): void {
    if (!Number.isFinite(index) || index < 0 || index >= this.totalElements) {
      throw new Error(
        `CeriousScroll.setMeasuredHeight: index ${index} out of range (0..${this.totalElements - 1})`
      );
    }
    if (!Number.isFinite(height) || height < 0) {
      throw new Error(
        `CeriousScroll.setMeasuredHeight: height must be a non-negative finite number, got ${height}`
      );
    }
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
    if (!Number.isFinite(deltaY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      return { element: this.currentElement, offset: this.scrollOffset };
    }
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
    if (!Number.isFinite(percentage)) {
      throw new Error(
        `CeriousScroll.handleScrollPercentage: percentage must be finite, got ${percentage}`
      );
    }
    return this.navigationEngine.handleScrollPercentage(percentage);
  }

  /**
   * Jump directly to a specific element index
   * 
   * @param elementIndex Zero-based index of the target element
   * @returns Object containing the final element and offset (offset will be 0)
   */
  jumpToElement(elementIndex: number): ScrollResult {
    if (!Number.isFinite(elementIndex)) {
      throw new Error(
        `CeriousScroll.jumpToElement: elementIndex must be finite, got ${elementIndex}`
      );
    }
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
    if (!Number.isFinite(windowHeight) || windowHeight <= 0) {
      throw new Error(
        `CeriousScroll.renderViewport: windowHeight must be a positive finite number, got ${windowHeight}`
      );
    }
    if (!container || typeof (container as any).appendChild !== 'function') {
      throw new Error('CeriousScroll.renderViewport: container must be an HTMLElement');
    }
    if (typeof renderElement !== 'function') {
      throw new Error('CeriousScroll.renderViewport: renderElement must be a function');
    }
    const range = this.viewportRenderer.renderViewport(windowHeight, container, renderElement);
    // Refresh derived display state (scroll percentage, visible range) so it
    // reflects the heights just measured this pass. This keeps the percentage in
    // sync after a row's height changes in place and is re-measured (e.g. an
    // expand/collapse followed by a re-render), without waiting for the next
    // scroll event.
    this.updateDisplay();
    return range;
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
    this.viewportHeight = CeriousScroll.measureViewportHeight(container);
    this.windowHeight = this.viewportHeight;

    // Update modules with new viewport height
    this.navigationEngine.updateConfig(this.totalElements, this.viewportHeight);

    // Handle scrollbar viewport change (this re-attaches the native scrollbar,
    // which creates a fresh element whose scrollTop is 0).
    this.nativeScrollbar.handleViewportChange(container, this.viewportHeight);

    // Re-anchor, re-sync the scrollbar thumb, refresh display state, and ask the
    // consumer to re-render — see reflow().
    this.reflow();
  }

  /**
   * Reflow after the content/viewport changed without an explicit scroll: a
   * container resize, or a rendered row changing height in place (expand/
   * collapse, density switch — detected by the content observer). Centralised in
   * the engine so every consumer/framework behaves identically.
   *
   * 1. Re-anchor to the bottom if there is now empty space below the last
   *    element ("at the bottom stays at the bottom"; no-op otherwise).
   * 2. Re-sync the native scrollbar thumb to the current position (the
   *    programmatic-update marker makes the resulting scroll event a no-op, so
   *    the position is preserved rather than reset to the top).
   * 3. Refresh derived display state (percentage, visible range).
   * 4. Ask the consumer to re-render via the same `onScroll` hook used for
   *    wheel/touch/scrollbar navigation (the engine doesn't own the row-render
   *    callback). This keeps resize/height-change handling inside the engine —
   *    consumers and the framework wrappers don't need their own observers or
   *    manual `recalculate()` calls.
   */
  private reflow(): void {
    this.navigationEngine.reanchorBottom(this.viewportHeight);

    if (this.nativeScrollbar.container && !this.nativeScrollbar.isSyncing) {
      this.nativeScrollbar.updateLastProgrammaticUpdate();
      this.nativeScrollbar.syncNativeScrollbar();
    }

    this.updateDisplay();
    this.options.onScroll?.();
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

    // Remove debug hook from the global registry
    if (this.debugCleanup) {
      try { this.debugCleanup(); } catch { /* noop */ }
      this.debugCleanup = undefined;
    }
    
    // Clear all caches
    this.clearAllCaches();
  }
}