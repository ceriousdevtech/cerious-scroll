/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
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
import { RowPlacement, AbsolutePlacement, TableFlowPlacement } from './features/row-placement.js';
import { MasonryRenderer } from './features/masonry-renderer.js';
import type { MasonryDeterminism } from './types/index.js';
import { NavigationEngine } from './engine/navigation-engine.js';
import { ViewportStateCalculator } from './core/viewport-state.js';
import { WheelController } from './controllers/wheel-controller.js';
import { TouchController } from './controllers/touch-controller.js';
import { ContentObserverManager } from './observers/content-observer.js';
import { KeyboardController } from './controllers/keyboard-controller.js';
import { ResizeController } from './controllers/resize-controller.js';

/**
 * Virtual list: position is (element index, pixel offset into that element).
 * Only the visible window is in the DOM. Call `renderViewport` from `onScroll`.
 *
 * @example
 * ```ts
 * const scroller = new CeriousScroll(container, data.length, {
 *   onScroll: () => {
 *     scroller.renderViewport(container.clientHeight, container, (i, el) => {
 *       el.textContent = data[i].label;
 *     });
 *   },
 * });
 * scroller.renderViewport(container.clientHeight, container, (i, el) => {
 *   el.textContent = data[i].label;
 * });
 * ```
 */
export class CeriousScroll {
  /** Dataset length. Finite integer >= 1. */
  totalElements!: number;
  /** Usable viewport height in pixels (header inset already subtracted). */
  viewportHeight!: number;
  /** Alias of {@link viewportHeight}. */
  windowHeight!: number;
  showDebug = false;

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

  /**
   * Measure the scrollable viewport height, less any top inset the placement
   * reserves (e.g. the `<thead>` in table mode). Subtracting the header keeps
   * the row count, scroll percentage, and true-bottom math correct so the last
   * row lands flush with the container bottom instead of behind the header.
   */
  private measureViewport(container: HTMLElement): number {
    const raw = CeriousScroll.measureViewportHeight(container);
    const inset = this.placement.getTopInset ? this.placement.getTopInset() : 0;
    return Math.max(0, raw - inset);
  }

  /** Camera row index. */
  currentElement = 0;
  /** Pixels into {@link currentElement}. */
  scrollOffset = 0;
  /** `0`–`100` along the measured range. */
  scrollPercentage = 0;
  /** Virtual-track `top` in pixels (percentage mapped onto the track). */
  viewportTop = 0;
  /** First visible index (inclusive), from the last {@link updateDisplay}. */
  startElement = 0;
  /** Last visible index (inclusive), from the last {@link updateDisplay}. */
  endElement = 0;

  private placement: RowPlacement;
  /** Non-null only in `layout: 'masonry'`. Owns the card DOM. */
  private masonry: MasonryRenderer | null = null;
  /** Card count in masonry mode; `totalElements` holds the SEGMENT count. */
  private totalItems = 0;
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

  /**
   * Height lookup used by the engine.
   *
   * @param index Dataset index.
   * @returns Measured height, or the 40px default if never measured.
   */
  getElementHeight!: ElementHeightCalculator;

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
   * @param container Host element. Height is read from it, or from an inner
   *   `[data-cerious-scroll-content]` when present (framework wrappers).
   * @param totalElements Dataset length. Finite integer >= 1.
   * @param options Optional. Put `renderViewport` in `onScroll` so every
   *   input path (including native scrollbar) re-renders.
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

    this.placement = this.options.layout === 'table'
      ? new TableFlowPlacement(this.options.table)
      : new AbsolutePlacement();

    // Masonry scrolls over SEGMENTS, not cards. The constructor's
    // `totalElements` is a card count in that mode, so translate it here and
    // keep the rest of the engine unaware of the distinction.
    if (this.options.layout === 'masonry') {
      if (!this.options.masonry) {
        throw new Error("CeriousScroll: layout 'masonry' requires the `masonry` option");
      }
      if (this.options.heightProvider) {
        throw new Error(
          "CeriousScroll: layout 'masonry' installs its own heightProvider; remove yours"
        );
      }
      this.totalItems = this.totalElements;
      this.masonry = new MasonryRenderer(container, this.totalItems, this.options.masonry);
      this.totalElements = this.masonry.segmentCount;
    }

    this.viewportHeight = this.measureViewport(container);
    this.windowHeight = this.viewportHeight;

    const heightProvider = this.masonry
      ? this.masonry.heightProvider()
      : this.options.heightProvider;
    this.getElementHeight = heightProvider
      ? (index: number) => heightProvider.height(index)
      : (index: number) => {
          // Do not cache the default. Writing it would make hasMeasuredHeight()
          // true for a row that was never measured, so a later prune/reflow would
          // skip offsetHeight and keep the fake 40px.
          const measuredHeight = this.performanceCache.getMeasuredHeight(index);
          return measuredHeight !== undefined ? measuredHeight : CeriousScroll.DEFAULT_ELEMENT_HEIGHT;
        };

    this.performanceCache = new PerformanceCache(this.getElementHeight, heightProvider);
    // Caps linear walks (findRowFromScrollPosition) so a bad scrollPixel
    // cannot iterate past the dataset.
    this.performanceCache.setTotalElements(this.totalElements);

    // Engine is constructed below; setScrollHandlers() wires it without a
    // `null as any` placeholder that could NPE if a scroll event fired first.
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
      () => {
        this.options.onScroll?.();
      }
    );

    // With a computed height source, size the strip by CONTENT. Element-count
    // sizing assumes an element is roughly a row; when it is not, the track
    // loses resolution and the scroll position quantizes.
    if (heightProvider?.totalHeight) {
      this.nativeScrollbar.setContentHeightSource(() => this.performanceCache.getProvidedTotalHeight());
    }

    this.viewportRenderer = new ViewportRenderer(
      this.totalElements,
      () => this.currentElement,
      () => this.scrollOffset,
      () => this.calculateScrollPercentage(),
      (index: number, height: number) => this.performanceCache.setMeasuredHeight(index, height),
      (index: number) => this.performanceCache.hasMeasuredHeight(index),
      (index: number) => this.performanceCache.getMeasuredHeight(index),
      () => this.performanceCache.getUniformHeightHint(),
      this.placement
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
      // In-place height change (expand/collapse). Reflow so callers don't
      // have to remember recalculate() — same path for every framework.
      onResize: () => this.reflow()
    });

    this.nativeScrollbar.setScrollHandlers(this.navigationEngine);

    this.updateDisplay();

    // Playwright / field diagnostics. Gated on ?debugScroll= so production
    // stays inert. Registry is keyed by instance so a second scroller does
    // not overwrite the first hook.
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
      // SSR / tests have no location
    }

    if (this.options.attachScrollbar !== false) {
      this.nativeScrollbar.attachNativeScrollbar(container);
    }

    if (this.options.keyboard?.enabled !== false) {
      this.keyboardCleanup = this.keyboardController.attach(
        container,
        this.options.keyboard,
        () => {
          this.options.onScroll?.();
        }
      );
    }

    if (this.options.wheel?.enabled !== false) {
      this.wheelCleanup = this.setupWheelHandler(container, () => {
        this.options.onScroll?.();
      }, this.options.wheel);
    }

    if (this.options.touch?.enabled !== false) {
      this.touchCleanup = this.touchController.attach(
        container,
        () => {
          this.options.onScroll?.();
        },
        this.options.touch
      );
    }
    
    if (this.masonry) {
      // Masonry owns its own resize: a width change invalidates the whole
      // layout, which needs a re-anchor and a sliced rebuild, not a re-measure.
      const onRender = () => { this.options.onScroll?.(); };
      // Re-measure now that the scrollbar strip exists. The renderer's geometry
      // was computed in its constructor, before the strip was attached, so the
      // last column would otherwise be sized against space the strip occupies.
      // Waiting for a resize observation is not enough: when the host is reused
      // it already carries the strip's padding, so the content box never changes
      // size and no observation ever arrives.
      this.masonry.remeasure(this, onRender);
      this.resizeCleanup = this.masonry.observeResize(this, onRender);
      this.masonry.scheduleTailChain(this);
    } else if (this.options.autoResize !== false) {
      this.resizeCleanup = this.setupAutoResizeHandling(container);
    }

    if (this.options.observeContentChanges !== false) {
      this.contentObserverCleanup = this.contentObserverManager.observe(container);
    }
  }

  /** Last row from the dataset currently in the DOM, if any. */
  get lastRenderedElement(): HTMLElement | null {
    return this.viewportRenderer.lastRenderedElement;
  }

  /**
   * Indices currently mounted in the viewport (visible + overscan).
   * @returns Sorted or insertion-order indices; do not mutate.
   */
  getRenderedIndices(): number[] {
    return this.viewportRenderer.getRenderedIndices();
  }

  /**
   * @param index Dataset index.
   * @returns The live row element, or `null` if that index is not mounted.
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
   * Without this, a follow-up `renderViewport()` call would skip the renderer
   * for already-rendered indices and re-read the stale `offsetHeight`, so the
   * mutation would silently no-op.
   *
   * @param renderElement Same callback you pass to `renderViewport`.
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
   * Record a measured row height.
   * @param index Dataset index in `[0, totalElements)`.
   * @param height Height in pixels (non-negative finite).
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

  /**
   * Apply a pixel delta. Positive is down. `viewportHeight` should be the
   * host/content height; table header inset is subtracted here.
   *
   * @param deltaY Pixels to move (positive = down, negative = up).
   * @param viewportHeight Host or content `clientHeight` in pixels.
   * @returns Camera after the move: `{ element, offset }`.
   */
  scroll(deltaY: number, viewportHeight: number): ScrollResult {
    if (!Number.isFinite(deltaY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      return { element: this.currentElement, offset: this.scrollOffset };
    }
    // Callers (wheel/touch controllers, consumers) pass the raw container/content
    // height. Subtract any placement top inset (e.g. the table header) so the
    // boundary guardian compares the last row against the true scrollable area —
    // otherwise it sees a phantom header-height overshoot at the bottom and
    // clamps one row short, clipping the final row. Mirrors renderViewport.
    const inset = this.placement.getTopInset ? this.placement.getTopInset() : 0;
    const effectiveViewportHeight = Math.max(1, viewportHeight - inset);
    return this.navigationEngine.scroll(deltaY, effectiveViewportHeight);
  }

  /**
   * Position of a row relative to the current viewport (not from dataset origin).
   *
   * @param elementIndex Dataset index.
   * @returns `top` / `bottom` in px from the viewport top (negative = above);
   *   `isVisible` if the row intersects the viewport.
   */
  getElementViewportPosition(elementIndex: number): { top: number; bottom: number; isVisible: boolean } {
    if (elementIndex < 0 || elementIndex >= this.totalElements) {
      throw new Error(`Element index ${elementIndex} is out of bounds (0-${this.totalElements - 1})`);
    }

    // Walk from the camera, not from row 0. Uniform rows are O(1).
    const uniform = this.performanceCache.getUniformHeightHint();
    let elementRelativeTop = -this.scrollOffset;

    if (elementIndex === this.currentElement) {
      // origin of the relative walk
    } else if (uniform !== undefined && uniform > 0) {
      elementRelativeTop += (elementIndex - this.currentElement) * uniform;
    } else if (elementIndex >= this.currentElement) {
      for (let i = this.currentElement; i < elementIndex; i++) {
        elementRelativeTop += this.getElementHeight(i);
      }
    } else {
      for (let i = this.currentElement - 1; i >= elementIndex; i--) {
        elementRelativeTop -= this.getElementHeight(i);
      }
    }

    const elementHeight = this.getElementHeight(elementIndex);
    const elementRelativeBottom = elementRelativeTop + elementHeight;
    const isVisible = elementRelativeBottom > 0 && elementRelativeTop < this.viewportHeight;

    return {
      top: elementRelativeTop,
      bottom: elementRelativeBottom,
      isVisible
    };
  }

  /**
   * Jump to a percentage along the measured range.
   *
   * @param percentage `0` = top, `100` = true bottom. Clamped.
   * @returns Camera after the jump: `{ element, offset }`.
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
   * Jump to a row at offset 0. Out-of-range indices are clamped.
   * `Number.MAX_SAFE_INTEGER` is the End-key sentinel (last row / true bottom).
   *
   * @param elementIndex Zero-based target index.
   * @returns Camera after the jump. Offset is 0 unless clamped to true bottom.
   */
  /**
   * Jump to an exact camera position.
   *
   * {@link jumpToElement} always lands at offset 0, which is enough when an
   * element is a row. It is not enough for re-anchoring after a relayout, where
   * the goal is to put a specific piece of content back at a specific screen
   * position — that needs a sub-element offset.
   *
   * @param elementIndex Target element.
   * @param offset Pixels into that element.
   * @param skipScrollbarSync Leave the strip alone (the caller will sync).
   * @returns Camera after the jump.
   */
  jumpToPosition(elementIndex: number, offset: number, skipScrollbarSync = false): ScrollResult {
    if (!Number.isFinite(elementIndex) || !Number.isFinite(offset)) {
      throw new Error(
        `CeriousScroll.jumpToPosition: elementIndex and offset must be finite, got ${elementIndex}, ${offset}`
      );
    }
    return this.navigationEngine.jumpToPosition(elementIndex, offset, skipScrollbarSync);
  }

  jumpToElement(elementIndex: number): ScrollResult {
    if (!Number.isFinite(elementIndex)) {
      throw new Error(
        `CeriousScroll.jumpToElement: elementIndex must be finite, got ${elementIndex}`
      );
    }
    return this.navigationEngine.jumpToElement(elementIndex);
  }

  /**
   * Grow or shrink the dataset without reconstructing the scroller.
   *
   * Recreating mid-drag tears down the strip the user is holding (thumb
   * freezes). A sliding window with a moving last index also makes the
   * bottom bounce. Growing in place keeps index 0 stable.
   *
   * Heights are keyed by index. A prepend that shifts every row needs
   * `clearAllCaches()` first. This call does not move the camera or render.
   *
   * @param totalElements New length. Finite integer >= 1.
   */
  updateTotalElements(totalElements: number): void {
    if (!Number.isFinite(totalElements) || totalElements < 1) {
      throw new Error('CeriousScroll.updateTotalElements: totalElements must be >= 1 (finite integer required)');
    }
    const next = Math.floor(totalElements);
    if (next === this.totalElements) return;

    this.totalElements = next;
    this.performanceCache.setTotalElements(next);
    this.navigationEngine.updateConfig(next, this.viewportHeight);
    this.viewportRenderer.updateTotalElements(next);
    this.nativeScrollbar.updateNativeScrollbarHeight(next);
  }

  /** Reset camera to element 0, offset 0. */
  reset(): void {
    this.navigationEngine.reset();
  }

  /**
   * Mount the visible window and measure rows. Call from `onScroll` (and once
   * after construct). The callback fills the element; the engine reads
   * `offsetHeight` — returning a height is ignored.
   *
   * @param windowHeight Viewport height in pixels (typically `container.clientHeight`).
   * @param container Host (or inner content) element rows are attached to.
   * @param renderElement `(index, element) => void` — populate `element` for `index`.
   * @returns Snapshot of the pass. `renderedElements` is reused; do not retain it.
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
    // Subtract any placement top inset (e.g. the table header) from the area the
    // renderer fills, so rows stop at the container bottom rather than running
    // the header's height past it. Invalidate first so we don't reuse a stale
    // header height; the value measured after this pass is cached for scroll()
    // so wheel/touch don't force getBoundingClientRect every event.
    if (this.masonry) {
      // Masonry mounts CARDS, not one node per virtual element. `renderElement`
      // is ignored: cards are populated by `masonry.renderItem`, which runs once
      // per mount rather than once per frame.
      const usable = this.syncViewportHeight(windowHeight);
      this.masonry.render(usable, container, this);
      return this.masonryRange();
    }

    this.placement.invalidateTopInset?.();
    const insetBefore = this.placement.getTopInset ? this.placement.getTopInset() : 0;
    const effectiveWindowHeight = Math.max(1, windowHeight - insetBefore);
    const range = this.viewportRenderer.renderViewport(effectiveWindowHeight, container, renderElement);

    // Re-sync the engine's viewport height to the area rows actually fill
    // (`windowHeight` minus the current inset). We compare against the live
    // viewportHeight, not just `insetBefore`, because the inset can change
    // *between* renders — e.g. a framework wrapper mounts the <thead> content
    // asynchronously after the engine first measured an empty header. Without
    // this, the true-bottom math is off by the header height and the last row
    // never quite renders.
    this.syncViewportHeight(windowHeight);
    this.updateDisplay();
    return range;
  }

  /**
   * Re-sync the engine's cached viewport height to the host.
   *
   * The engine measures the host once at construction and normally re-syncs
   * here, from inside {@link renderViewport}. A consumer that drives its own DOM
   * — anything that does not call `renderViewport` — must call this instead, or
   * the engine keeps its construction-time height forever. True-bottom is
   * derived from that height, so a stale value silently clamps the scroll short
   * of the end by exactly the drift.
   *
   * @param observedHeight Host height in pixels, before any placement top inset.
   * @returns The usable height the engine now holds.
   */
  syncViewportHeight(observedHeight: number): number {
    if (!Number.isFinite(observedHeight) || observedHeight <= 0) return this.viewportHeight;
    this.placement.invalidateTopInset?.();
    const inset = this.placement.getTopInset ? this.placement.getTopInset() : 0;
    const synced = Math.max(1, observedHeight - inset);
    if (synced !== this.viewportHeight) {
      this.viewportHeight = synced;
      this.windowHeight = synced;
      this.navigationEngine.updateConfig(this.totalElements, this.viewportHeight);
      this.viewportRenderer.invalidateTrueBottomCache();
    }
    return this.viewportHeight;
  }

  /**
   * @returns Scroll position from `0` (top) to `100` (measured true bottom).
   */
  calculateScrollPercentage(): number {
    const trueBottom = this.viewportRenderer.calculateTrueBottomPosition(this.viewportHeight);

    let currentPosition = this.currentElement;
    if (this.scrollOffset > 0 && this.currentElement < this.totalElements - 1) {
      const elementHeight = this.getElementHeight(this.currentElement);
      const offsetFraction = elementHeight > 0 ? this.scrollOffset / elementHeight : 0;
      currentPosition += offsetFraction;
    }
    
    if (trueBottom) {
      const trueBottomElementHeight = this.getElementHeight(trueBottom.element);
      const trueBottomPosition = trueBottom.element + (trueBottomElementHeight > 0 ? trueBottom.offset / trueBottomElementHeight : 0);

      if (trueBottomPosition <= 0) return 0;

      if (currentPosition >= trueBottomPosition - 0.01) {
        return 100;
      }

      const percentage = (currentPosition / trueBottomPosition) * 100;
      return Math.max(0, Math.min(100, percentage));
    }

    // Tail not measured yet (first frames).
    const totalPositions = this.totalElements - 1;
    if (totalPositions <= 0) return 0;
    
    const percentage = (currentPosition / totalPositions) * 100;
    return Math.max(0, Math.min(100, percentage));
  }

  /**
   * Sum of measured heights from row 0 up to, but not including, `row`.
   *
   * @param row Exclusive end index.
   * @returns Pixels. Unmeasured rows contribute a 1px placeholder.
   */
  getCumulativeHeight(row: number): number {
    return this.performanceCache.getCumulativeHeight(row);
  }

  /**
   * Map an absolute pixel position onto `{ element, offset }`.
   *
   * @param scrollPixel Distance from the top of the dataset in pixels.
   * @returns Camera for that pixel. Unmeasured rows are treated as 1px.
   */
  findRowFromScrollPosition(scrollPixel: number): { element: number; offset: number } {
    return this.performanceCache.findRowFromScrollPosition(scrollPixel);
  }

  /** Drop derived caches (uniform-height hint, true-bottom, header inset). Measured heights stay. */
  invalidateCache(): void {
    this.performanceCache.invalidateCache();
    this.viewportRenderer.invalidateTrueBottomCache();
    this.placement.invalidateTopInset?.();
  }

  /**
   * Drop measured heights as well — use when the dataset itself changed
   * (rows inserted/removed/reordered), not merely resized.
   */
  clearAllCaches(): void {
    this.performanceCache.clearAllCaches();
    this.viewportRenderer.invalidateTrueBottomCache();
    this.placement.invalidateTopInset?.();
  }

  /**
   * Viewport snapshot for masonry mode. `startElement`/`endElement` are SEGMENT
   * indices, matching the engine's element space; card-level detail belongs to
   * the caller's own render callback.
   */
  private masonryRange(): MeasuredViewportRange {
    this.updateDisplay();
    return {
      startElement: this.currentElement,
      endElement: this.currentElement,
      scrollPercentage: this.scrollPercentage,
      viewportElements: 1,
      renderedElements: [],
      totalRenderedHeight: this.viewportHeight
    };
  }

  /**
   * Scroll a specific CARD into view. Masonry mode only.
   *
   * {@link jumpToElement} takes a segment index in this mode, which is an
   * internal unit; this takes the card index the caller actually thinks in.
   *
   * @param index Card index.
   * @param screenOffset Pixels below the viewport top to place it. Default 0.
   */
  jumpToItem(index: number, screenOffset = 0): void {
    if (!this.masonry) {
      throw new Error("CeriousScroll.jumpToItem: only available with layout 'masonry'");
    }
    const pos = this.masonry.cameraForItem(index, screenOffset);
    if (!pos) return;
    this.navigationEngine.jumpToPosition(pos.segment, pos.offset);
  }

  /** Cards in the dataset. Masonry mode only; otherwise equals `totalElements`. */
  get itemCount(): number {
    return this.masonry ? this.totalItems : this.totalElements;
  }

  /**
   * Determinism guarantee of the current masonry layout, or `null` outside
   * masonry mode. See {@link MasonryDeterminism}.
   *
   * Worth branching on rather than assuming. Under `'local'` a card's column
   * depends on how the viewer reached it, so a feature that treats a position as
   * shareable — a deep link to a card, a saved scroll coordinate, a
   * pixel-comparison test — is only sound under `'canonical'`.
   */
  get masonryDeterminism(): MasonryDeterminism | null {
    return this.masonry ? this.masonry.determinism : null;
  }

  /**
   * Re-size the scrollbar strip and re-sync it, after total content height
   * changed without the element count changing.
   *
   * {@link updateTotalElements} covers the usual case, but a computed layout can
   * change its total height while the element count is fixed — a relayout, or a
   * progressive height calculation settling from estimate to exact. Without this
   * the strip keeps its stale surface and the thumb misreports the range.
   */
  refreshScrollbarMetrics(): void {
    this.nativeScrollbar.updateNativeScrollbarHeight(this.totalElements);
    this.syncScrollbar();
  }

  /** Refresh `startElement`, `endElement`, `scrollPercentage`, `viewportTop`. */
  updateDisplay(): void {
    const snapshot = this.viewportStateCalculator.calculate();
    this.startElement = snapshot.startElement;
    this.endElement = snapshot.endElement;
    this.scrollPercentage = snapshot.scrollPercentage;
    this.viewportTop = snapshot.viewportTop;
  }

  /**
   * Re-sync the native scrollbar after geometry changed without a scroll
   * event — typically `updateTotalElements()` + a re-render. Growing the
   * track leaves a bottom thumb stranded until this runs. Call after rows
   * are re-measured. No-op while the user is dragging (see NativeScrollbar).
   */
  syncScrollbar(): void {
    if (this.nativeScrollbar.container && !this.nativeScrollbar.isSyncing) {
      this.nativeScrollbar.syncNativeScrollbar();
    }
  }

  /**
   * Host size changed. Re-measures viewport height, invalidates header inset,
   * then reflows (re-anchor, scrollbar sync, `onScroll`).
   *
   * @param container The same host passed to the constructor.
   */
  handleViewportChange(container: HTMLElement): void {
    // Header height can change with the container; drop the cache so table
    // mode re-reads getBoundingClientRect once, not on every scroll.
    this.placement.invalidateTopInset?.();

    this.viewportHeight = this.measureViewport(container);
    this.windowHeight = this.viewportHeight;
    this.navigationEngine.updateConfig(this.totalElements, this.viewportHeight);

    // Does not recreate the strip — recreating reset scrollTop to 0 and
    // stranded echo-accounting on the discarded node (dead zone).
    this.nativeScrollbar.handleViewportChange(container, this.viewportHeight);
    this.reflow();
  }

  /**
   * Resize or in-place row height change with no explicit scroll. Re-anchor
   * if empty space appeared under the last row, sync the thumb (programmatic
   * marker swallows the echo so we don't jump to top), then `onScroll` so
   * the host re-renders. The engine does not own the row callback.
   */
  private reflow(): void {
    this.navigationEngine.reanchorBottom(this.viewportHeight);

    if (this.nativeScrollbar.container && !this.nativeScrollbar.isSyncing) {
      this.nativeScrollbar.syncNativeScrollbar();
    }

    this.updateDisplay();
    this.options.onScroll?.();
  }

  /**
   * Attach resize observers on `container` (and `window.resize`).
   *
   * @param container Host element.
   * @returns Detach function.
   */
  setupAutoResizeHandling(container: HTMLElement): () => void {
    return this.resizeController.attach(container);
  }

  /**
   * Remove the native scrollbar strip and restore padding.
   *
   * @param container Optional. Used to find an orphan strip if this instance
   *   is not tracking one.
   */
  detachScrollbar(container?: HTMLElement): void {
    this.nativeScrollbar.detachScrollbar(container);
  }

  /**
   * Attach wheel handling. The constructor already does this when
   * `wheel.enabled` is not `false`.
   *
   * @param container Host element.
   * @param onScroll Invoked after each applied delta with `{ element, offset }`.
   * @param wheelOptions Overrides constructor `wheel` options.
   * @returns Detach function.
   *
   * @example
   * ```ts
   * const cleanup = scroller.setupWheelHandler(container, () => {
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
   * Attach touch handling. The constructor already does this when
   * `touch.enabled` is not `false`.
   *
   * @param container Host element.
   * @param onScroll Invoked after each applied delta with `{ element, offset }`.
   * @param options Overrides constructor `touch` options.
   * @returns Detach function.
   *
   * @example
   * ```ts
   * const cleanup = scroller.setupTouchHandler(container, () => {
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

  /** Detach listeners, observers, and the debug hook. Call when the host leaves the DOM. */
  dispose(): void {
    this.masonry?.dispose();
    this.keyboardCleanup?.();
    this.keyboardCleanup = undefined;
    this.wheelCleanup?.();
    this.wheelCleanup = undefined;
    this.touchCleanup?.();
    this.touchCleanup = undefined;
    this.resizeCleanup?.();
    this.resizeCleanup = undefined;
    this.contentObserverCleanup?.();
    this.contentObserverCleanup = undefined;

    if (this.debugCleanup) {
      try { this.debugCleanup(); } catch { /* noop */ }
      this.debugCleanup = undefined;
    }

    this.clearAllCaches();
  }
}
