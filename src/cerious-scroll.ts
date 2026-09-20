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
  WheelNavigationOptions,
  ScrollDirection
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
import { NativeTouchController } from './controllers/native-touch-controller.js';
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
  /**
   * Settle on a writing direction.
   *
   * `'auto'` asks the DOM rather than the option, because direction is almost
   * always inherited — from `<html dir>`, a locale wrapper, a CSS rule — and a
   * host that has to restate it in JavaScript will eventually disagree with the
   * page around it.
   */
  private static resolveDirection(
    container: HTMLElement,
    requested?: ScrollDirection
  ): 'ltr' | 'rtl' {
    if (requested === 'ltr' || requested === 'rtl') return requested;
    try {
      return getComputedStyle(container).direction === 'rtl' ? 'rtl' : 'ltr';
    } catch {
      return 'ltr'; // no computed styles (SSR, bare jsdom)
    }
  }

  /** Writing direction the engine resolved for this host. */
  get direction(): 'ltr' | 'rtl' {
    return this.resolvedDirection;
  }

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
  /**
   * A content element this engine created because the host had none, and the
   * host it was created for. Rows render into it instead of the host.
   */
  private ownedContent: HTMLElement | null = null;
  private ownedContentHost: HTMLElement | null = null;
  /** The host this engine is attached to, once it is known. */
  private attachedContainer: HTMLElement | null = null;
  private serverRowsRelocated = false;
  /** Writing direction in force, resolved once the host is known. */
  private resolvedDirection: 'ltr' | 'rtl' = 'ltr';
  /** The pinned header element and the index it is currently showing. */
  private stickyElement: HTMLElement | null = null;
  private stickyIndex: number | null = null;
  /** Pinned header height, measured once per hand-off rather than per frame. */
  private stickyHeight = 0;
  /** Edge already asked about, cleared when the window moves away from it. */
  private infiniteArmed: 'start' | 'end' | null = null;
  private infiniteBusy = false;
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
  private nativeTouchController?: NativeTouchController;
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
        // Scrollbar drags use jumpToPosition(..., skipScrollbarSync=true), so
        // they deliberately bypass NavigationEngine's normal sync callback.
        // Keep the independent native-touch surface aligned here; otherwise a
        // scrollbar jump away from the top leaves the proxy at physical
        // scrollTop 0 and the next touch can rubber-band in mid-dataset.
        this.nativeTouchController?.syncPosition();
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
    this.viewportRenderer.hydrate = this.options.ssr?.hydrate === true;

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
        this.nativeTouchController?.syncPosition();
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

    this.nativeTouchController = new NativeTouchController({
      scroll: (deltaY: number, viewportHeight: number) => this.scroll(deltaY, viewportHeight),
      calculateScrollPercentage: () => this.calculateScrollPercentage(),
      getCurrentElement: () => this.currentElement,
      getScrollOffset: () => this.scrollOffset,
      onSettle: () => this.snapToBoundary()
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

    this.attachedContainer = container;
    this.resolvedDirection = CeriousScroll.resolveDirection(container, this.options.direction);
    if (this.masonry) this.masonry.rtl = this.resolvedDirection === 'rtl';
    this.installAria(container);

    if (this.options.attachScrollbar !== false) {
      // A right-to-left reader expects the bar on the left, the same way the
      // browser moves its own.
      this.nativeScrollbar.attachNativeScrollbar(
        container,
        this.resolvedDirection === 'rtl' ? 'left' : 'right'
      );
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

    // Give the host a content element if it has none. The native surface needs
    // one element it can hold still while it scrolls beneath, and a host that
    // renders rows straight into itself offers nothing to hold. Creating it
    // here is what makes native scrolling the default for EVERY host rather
    // than only the ones whose markup happens to suit it — a plain
    // `new CeriousScroll(div, n)` used to fall back to the JavaScript path
    // silently, which is the worst way for a default to not apply.
    //
    // Masonry is exempt: its renderer builds and owns its own viewport.
    if (!this.masonry && !container.querySelector('[data-cerious-scroll-content]')) {
      const owned = document.createElement('div');
      owned.setAttribute('data-cerious-scroll-content', '');
      // Matches what the framework wrappers build, so the engine measures and
      // lays out identically however the element got there.
      owned.style.cssText = 'position:relative;width:100%;height:100%;overflow-y:clip;overflow-x:auto';
      container.appendChild(owned);
      this.ownedContent = owned;
      this.ownedContentHost = container;
    }

    const nativeContent = container.querySelector<HTMLElement>(
      '[data-cerious-scroll-content], [data-cerious-masonry="content"]'
    );
    // Native touch is the default for the dedicated content structure used
    // by the framework bindings, demo bootstrap, and Masonry. Legacy direct
    // hosts without that structure retain manual touch automatically; an
    // explicit native-proxy request still reaches attach() and its useful
    // validation error.
    // Depth does not matter: the surface wraps whichever host child contains
    // the content element, so a host may nest it (a horizontal-scroll wrapper
    // around a wide grid) and still get native scrolling.
    const canUseNativeProxy = !!nativeContent;

    const requestedTouchMode = this.options.touch?.mode;
    const touchEnabled = this.options.touch?.enabled !== false;
    const useNativeProxyTouch = touchEnabled && (
      requestedTouchMode === 'native-proxy' ||
      (requestedTouchMode !== 'manual' && canUseNativeProxy)
    );

    // The wheel scrolls the native surface. Not a mode, not a preference: the
    // browser's own physics is the platform's, and reproducing it from raw
    // deltas was only ever an approximation of one platform at a time.
    //
    // `canUseNativeProxy` is effectively always true now — the engine builds the
    // element the surface needs when a host has none — but it is still checked,
    // because the alternative to a JavaScript fallback in some DOM nobody
    // anticipated is a list that does not scroll at all.
    const wheelEnabled = this.options.wheel?.enabled !== false;
    const useNativeProxyWheel = wheelEnabled && canUseNativeProxy;

    if (wheelEnabled) {
      // Resolved HERE, not in the controller: only this scope knows whether the
      // surface can exist, and the controller is told rather than guessing.
      this.wheelCleanup = this.wheelController.attach(
        container,
        () => { this.options.onScroll?.(); },
        this.options.wheel,
        useNativeProxyWheel
      );
    }

    // One surface, either driver. Wheel needs it even when touch does not want
    // it (or is switched off entirely), so attachment is driven by the union.
    if (useNativeProxyTouch || useNativeProxyWheel) {
      this.touchCleanup = this.nativeTouchController.attach(container, () => {
        this.options.onScroll?.();
      }, this.options.touch, { acceptWheel: useNativeProxyWheel });
    } else if (touchEnabled) {
      this.touchCleanup = this.touchController.attach(container, () => {
        this.options.onScroll?.();
      }, this.options.touch);
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
    // New rows arrived, so "I already asked about this edge" is stale. Without
    // this a viewer parked at the very bottom is stuck after one page: the
    // window never leaves the threshold, so the re-arm never fires and they
    // would have to scroll away and back to get the next one.
    this.infiniteArmed = null;
    this.syncAriaTotals();
    this.performanceCache.setTotalElements(next);
    this.navigationEngine.updateConfig(next, this.viewportHeight);
    this.viewportRenderer.updateTotalElements(next);
    this.nativeScrollbar.updateNativeScrollbarHeight(next);
    // Resizing a native scroll surface changes the meaning of its existing
    // scrollTop. Re-anchor both native input surfaces immediately to the
    // unchanged logical camera so an asynchronous browser scroll event cannot
    // reinterpret the old pixel position and move the viewport. Each surface
    // already defers its write while its own gesture is active.
    this.syncScrollbar();
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
      // per visible mount rather than once per frame. Dynamic mode may also use
      // it to populate the offscreen measurement probe.
      const usable = this.syncViewportHeight(windowHeight);
      this.masonry.render(usable, container, this);
      return this.masonryRange();
    }

    this.placement.invalidateTopInset?.();
    const insetBefore = this.placement.getTopInset ? this.placement.getTopInset() : 0;
    const effectiveWindowHeight = Math.max(1, windowHeight - insetBefore);
    let target = this.renderTarget(container);
    const rowRenderer = renderElement;
    this.relocateServerRows(container, target);
    const range = this.viewportRenderer.renderViewport(
      effectiveWindowHeight, target, rowRenderer
    );

    // Re-sync the engine's viewport height to the area rows actually fill
    // (`windowHeight` minus the current inset). We compare against the live
    // viewportHeight, not just `insetBefore`, because the inset can change
    // *between* renders — e.g. a framework wrapper mounts the <thead> content
    // asynchronously after the engine first measured an empty header. Without
    // this, the true-bottom math is off by the header height and the last row
    // never quite renders.
    this.syncViewportHeight(windowHeight);
    this.updateDisplay();

    // Rows have just been measured, so this is the first moment the strip can know whether the
    // dataset actually overflows. The strip is built before any render, when no tail height is
    // known, and must assume it does — leaving a short list with a bar it never needed until some
    // later resize happened to correct it.
    this.nativeScrollbar.refreshScrollRange();

    this.syncSticky(this.renderTarget(container), range, renderElement);
    this.checkInfinite(range);
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
  /**
   * Move server-rendered rows into whatever the renderer actually fills.
   *
   * A server cannot know about the content element the engine builds for
   * itself — that element does not exist until the client runs — so its rows
   * land in the host. Left there they would be neither adopted nor recycled,
   * and the client would render a second copy of every one of them beside the
   * originals. Runs once, before the first frame.
   */
  private relocateServerRows(container: HTMLElement, target: HTMLElement): void {
    if (this.options.ssr?.hydrate !== true) return;
    if (this.serverRowsRelocated) return;
    this.serverRowsRelocated = true;
    if (target === container) return;

    const stray = container.querySelectorAll<HTMLElement>(':scope > [data-element-index]');
    for (let i = 0; i < stray.length; i++) target.appendChild(stray[i]);
  }

  /**
   * Keep a section header pinned above the recycled window.
   *
   * Mounted OUTSIDE the recycler on purpose. A pinned row has to stay on screen
   * while the rows it heads scroll past, and the recycler's whole job is to
   * unmount anything that leaves the window — so a sticky row drawn as a normal
   * row is guaranteed to vanish at exactly the wrong moment. It is a separate,
   * long-lived element that the engine re-renders only when the resolved index
   * changes.
   *
   * @param container Host rows were rendered into.
   * @param range What the frame actually drew.
   * @param renderElement The caller's row renderer, reused so a header looks
   *   like the row it is.
   */
  private syncSticky(
    container: HTMLElement,
    range: MeasuredViewportRange,
    renderElement: ElementRenderer
  ): void {
    const sticky = this.options.sticky;
    if (!sticky || typeof sticky.resolve !== 'function') return;

    const index = sticky.resolve(range.startElement);
    if (index === null || index === undefined || !Number.isFinite(index) ||
        index < 0 || index >= this.totalElements) {
      this.stickyElement?.remove();
      this.stickyElement = null;
      this.stickyIndex = null;
      this.stickyHeight = 0;
      return;
    }

    if (!this.stickyElement) {
      const el = document.createElement('div');
      el.setAttribute('data-cerious-sticky', '');
      // Above the rows, inert to the pointer so the row underneath stays
      // clickable at the edges, and out of the recycler's reach.
      // Logical inset, so the gutter the strip reserves is subtracted from
      // whichever side the strip is actually on.
      el.style.cssText =
        'position:absolute;top:0;inset-inline-start:0;' +
        'inset-inline-end:var(--cerious-gutter, 0px);z-index:2;';
      if (sticky.className) el.className = sticky.className;
      container.appendChild(el);
      this.stickyElement = el;
      this.stickyIndex = null;
    } else if (this.stickyElement.parentElement !== container) {
      container.appendChild(this.stickyElement);
    }

    if (this.stickyIndex !== index) {
      this.stickyElement.textContent = '';
      renderElement(index, this.stickyElement);
      // Deliberately NOT `data-element-index`: the pinned header is a copy of a
      // row, not a member of the rendered window, and answering row queries
      // would make it look like one to the recycler, to consumers, and to any
      // test counting what is on screen.
      this.stickyElement.dataset.stickyIndex = String(index);
      this.stickyIndex = index;
      // Read once per HAND-OFF, not per frame. This is a write-then-read and so
      // forces a synchronous layout, which is only acceptable because a section
      // change is rare; doing it every frame is the mistake that cost the grid
      // its frame budget.
      this.stickyHeight = this.stickyElement.offsetHeight;
    }

    // The next section's header pushes this one out rather than sliding under
    // it. Without this the pinned header sits at `top: 0` with a higher
    // z-index, so the incoming header disappears behind it and the content
    // swaps abruptly the instant `resolve` flips.
    const push = this.stickyPush(range, sticky.resolve, index);
    this.stickyElement.style.transform = push ? `translateY(${push}px)` : '';
  }

  /**
   * How far to lift the pinned header so the incoming one displaces it.
   *
   * Returns a negative pixel offset while the next section's header is inside
   * the pinned header's band, and 0 otherwise. At the extreme the pinned
   * header's bottom edge lands exactly on the incoming header's top edge, so
   * the two never overlap and the hand-off reads as a push rather than a swap.
   *
   * Computed from the heights the renderer just reported and the camera's own
   * offset, NOT from the DOM: this runs on every frame of a scroll, and a
   * geometry read here would force a synchronous layout over everything just
   * mounted.
   */
  private stickyPush(
    range: MeasuredViewportRange,
    resolve: (index: number) => number | null,
    current: number
  ): number {
    const height = this.stickyHeight;
    if (height <= 0) return 0;

    const rows = range.renderedElements;
    // `renderedElements` is ascending and begins at the first visible row, so
    // the running total is that row's top edge once the camera offset is taken
    // off it.
    let top = -this.scrollOffset;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.index > range.startElement) {
        // Past the band: no boundary close enough to push anything.
        if (top >= height) return 0;
        // A row belonging to a different section is that section's header.
        if (resolve(row.index) !== current) return top - height;
      }
      top += row.height;
    }
    return 0;
  }

  /**
   * Settle the camera onto a row boundary once scrolling has stopped.
   *
   * Nearly free in this engine: the camera is already `(element, offset)`, so a
   * snap is `offset -> 0` on one row or the next. CSS `scroll-snap-type` cannot
   * do this job — the surface the browser scrolls is a featureless spacer with
   * no snap targets — so it is applied here, on the settle signal the native
   * surface provides.
   *
   * A no-op unless `snap.enabled`, and skipped when the camera is already
   * within `tolerance` of a boundary, which keeps a scroll that had effectively
   * landed from visibly nudging itself afterwards.
   */
  private snapToBoundary(): void {
    const snap = this.options.snap;
    if (!snap?.enabled) return;
    if (this.masonry) return; // a card grid has no single row boundary to land on

    const offset = this.scrollOffset;
    const tolerance = Math.max(0, snap.tolerance ?? 2);
    if (offset <= tolerance) return;

    const element = this.currentElement;
    const height = this.getElementHeight(element);
    if (!Number.isFinite(height) || height <= 0) return;
    if (offset >= height - tolerance) {
      // Already all but past this row: forward is the near boundary.
      this.jumpToElement(Math.min(element + 1, this.totalElements - 1));
      this.options.onScroll?.();
      return;
    }

    const forward = snap.align === 'start' ? false : offset > height / 2;
    const target = forward ? Math.min(element + 1, this.totalElements - 1) : element;
    this.jumpToElement(target);
    this.options.onScroll?.();
  }

  /**
   * Apply screen-reader semantics, if asked.
   *
   * The numbers are the point. A virtualized list mounts a window, so a reader
   * left to count the DOM says "3 of 12" for a dataset of a million;
   * `aria-setsize` and `aria-posinset` state the truth independently of what
   * happens to be rendered, and the engine is the only thing that knows both.
   *
   * Roles are layout-dependent and deliberately conservative: `table` layout
   * emits real `<tr>`/`<td>`, which already mean row and cell, so the engine
   * adds only the virtualization numbers and leaves the semantics alone.
   */
  private installAria(container: HTMLElement): void {
    const aria = this.options.aria;
    if (!aria?.enabled) return;

    const isTable = this.options.layout === 'table';

    if (aria.label) container.setAttribute('aria-label', aria.label);
    if (aria.labelledBy) container.setAttribute('aria-labelledby', aria.labelledBy);

    const containerRole = aria.role ?? (isTable ? undefined : 'list');
    if (containerRole) container.setAttribute('role', containerRole);

    if (isTable) {
      // The correct ARIA for a virtualized table: the real row count, so the
      // reader does not infer it from the mounted window.
      container.setAttribute('aria-rowcount', String(this.totalElements));
    }

    const itemRole = aria.itemRole ?? (isTable ? undefined : 'listitem');

    this.viewportRenderer.decorateRow = (el: HTMLElement, index: number) => {
      if (itemRole) el.setAttribute('role', itemRole);
      if (isTable) {
        // 1-based, and counting the header row, as a real table does.
        el.setAttribute('aria-rowindex', String(index + 2));
      } else {
        el.setAttribute('aria-setsize', String(this.totalElements));
        el.setAttribute('aria-posinset', String(index + 1));
      }
    };
  }

  /** Keep `aria-rowcount` truthful when the dataset grows or shrinks. */
  private syncAriaTotals(): void {
    if (!this.options.aria?.enabled) return;
    if (this.options.layout !== 'table') return;
    this.attachedContainer?.setAttribute('aria-rowcount', String(this.totalElements));
  }

  /**
   * Ask for more rows when the rendered window nears an edge.
   *
   * Re-arms only when the window leaves the threshold, so a load that appends
   * nothing cannot spin; an in-flight promise also holds the gate, because the
   * common shape is an async fetch and the next frame would otherwise fire
   * again before the first returned.
   */
  private checkInfinite(range: MeasuredViewportRange): void {
    const infinite = this.options.infinite;
    if (!infinite || typeof infinite.onLoadMore !== 'function') return;
    if (this.infiniteBusy) return;

    const threshold = Math.max(0, infinite.threshold ?? 20);
    const total = this.totalElements;

    let direction: 'start' | 'end' | null = null;
    if (range.endElement >= total - 1 - threshold) direction = 'end';
    else if (infinite.edges === 'both' && range.startElement <= threshold) direction = 'start';

    if (direction === null) {
      // Out of range again: the next approach is a new one.
      this.infiniteArmed = null;
      return;
    }
    if (this.infiniteArmed === direction) return;

    this.infiniteArmed = direction;
    this.infiniteBusy = true;
    const release = () => { this.infiniteBusy = false; };
    try {
      const result = infinite.onLoadMore({
        direction,
        first: range.startElement,
        last: range.endElement,
        total
      });
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(release, release);
      } else {
        release();
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Where rows actually go.
   *
   * A caller that hands us the host is describing WHERE it wants rows, not
   * demanding a particular node. When this engine created the content element
   * the host lacked, that intent is served by the element inside — and it has
   * to be, because the native surface holds that element still and anything
   * left outside it would not move with the rows. A caller that names some
   * other element is being specific, and is left alone.
   */
  private renderTarget(container: HTMLElement): HTMLElement {
    if (this.ownedContent && container === this.ownedContentHost) return this.ownedContent;
    return container;
  }

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
   * Current column width in pixels, or `null` outside masonry mode.
   *
   * Exposed because real cards need it: requesting a CDN image at the column's
   * actual width, choosing a `srcset` candidate, or deciding how much text to
   * render all depend on it, and it changes with the container.
   */
  get masonryColumnWidth(): number | null {
    return this.masonry ? this.masonry.columnWidth : null;
  }

  /** Current column count, or `null` outside masonry mode. */
  get masonryColumns(): number | null {
    return this.masonry ? this.masonry.columns : null;
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
    this.nativeTouchController?.syncPosition();
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
    // Standalone use cannot assume the native surface is mounted around this
    // container, so it gets the self-contained path.
    return this.wheelController.attach(container, onScroll, wheelOptions, false);
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

    // After the controllers have detached — the surface puts the content element
    // back where it found it, and only then is this safe to remove.
    this.stickyElement?.remove();
    this.stickyElement = null;
    this.stickyIndex = null;
    this.stickyHeight = 0;

    if (this.ownedContent?.parentNode) this.ownedContent.parentNode.removeChild(this.ownedContent);
    this.ownedContent = null;
    this.ownedContentHost = null;

    this.clearAllCaches();
  }
}
