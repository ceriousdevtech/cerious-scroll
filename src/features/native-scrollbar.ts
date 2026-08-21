/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * Sibling strip whose scrollTop is a percentage of the virtual range.
 * Bidirectional sync; programmatic writes are matched by position so their
 * echo isn't treated as a user drag.
 */

import { NavigationEngine } from '../engine/navigation-engine.js';

export class NativeScrollbar {
  private static readonly DEFAULT_SCROLLBAR_WIDTH = 17;
  /**
   * Marks a host whose padding WE widened, and by how much, as
   * `paddingLeft:8` / `paddingRight:15`.
   *
   * Recorded on the element rather than on the instance so that detach can undo
   * the exact amount even when it runs from a different instance than the one
   * that attached — the orphan-strip cleanup path does exactly that.
   */
  private static readonly RESERVED_ATTR = 'data-cerious-scrollbar-reserved';
  private static readonly DEFAULT_Z_INDEX = 10;
  private static readonly ELEMENT_HEIGHT_MULTIPLIER = 10;
  // Browsers clamp element height (Chrome ~33.5M px). Stay well under it: past
  // the cap the strip silently stops growing and the mapping compresses again.
  private static readonly MAX_STRIP_HEIGHT_PX = 30_000_000;
  // Tolerance (px) for recognising the async echo of a programmatic scrollTop
  // write. The browser may clamp/round our written value, so the echo's
  // scrollTop can differ from the target by a sub-pixel; a small window
  // absorbs that without misclassifying a genuine user drag.
  private static readonly PROGRAMMATIC_SCROLL_TOLERANCE_PX = 2;
  private static readonly BOTTOM_THRESHOLD_PERCENTAGE = 99;
  private static readonly PERCENTAGE_MAX = 100;
  // Window (ms) after a genuine user scroll on the strip during which an
  // engine→scrollbar sync defers to the user. On desktop the user drags the
  // REAL native OS scrollbar (no custom thumb / `_thumbDrag` on non-touch), so
  // the only signal that they are mid-drag is the stream of non-echo scroll
  // events the drag produces. Native drag events fire ~per frame, so a window
  // comfortably wider than a frame bridges the gaps for the whole gesture and
  // then lapses on release. See `syncNativeScrollbar`.
  private static readonly USER_SCROLL_DEFER_MS = 150;
  // Custom thumb tuning. Sibling-driver strip is fixed width; the thumb
  // floats over the right edge of the host container and is visually
  // independent of that strip width.
  private static readonly THUMB_MIN_HEIGHT_PX = 24;
  private static readonly THUMB_FADE_DELAY_MS = 800;
  // One stylesheet for all CeriousScroll instances. Injected lazily on the
  // first scrollbar creation so SSR / non-DOM environments stay clean.
  private static _stylesInjected = false;

  private _scrollbarContainer: HTMLElement | null = null;
  private _thumbElement: HTMLElement | null = null;
  // Transparent overlay on the right edge of the container (touch only) that
  // makes the whole sibling-scrollbar strip a drag target — so a tap anywhere
  // in the column jumps the thumb and starts a drag, instead of requiring the
  // user to land on the slim painted thumb.
  private _thumbHitZone: HTMLElement | null = null;
  private _thumbHitZoneDown: ((e: PointerEvent) => void) | null = null;
  private _thumbFadeTimer: number | null = null;
  // Active drag state. Captured on pointerdown for the thumb; cleared on
  // pointerup/cancel. We drive scroll by writing to the sibling container's
  // `scrollTop`, which the existing scroll listener already maps to the
  // virtual position — so all scroll math stays in one place.
  private _thumbDrag: {
    pointerId: number;
    startClientY: number;
    startScrollTop: number;
    trackPx: number;
  } | null = null;
  private _syncingScrollbar = false;
  // Last scrollTop value we wrote programmatically (wheel/touch/keyboard sync,
  // reflow, resize). The scroll listener compares the live scrollTop against
  // this: a match (within tolerance) means the event is the async echo of our
  // own write and is ignored; a difference means the user moved the strip and
  // we process it. This is robust to scroll-event coalescing — the browser may
  // collapse many rapid programmatic writes into FEWER scroll events, so a
  // per-write *counter* leaks a positive residual that then swallows the
  // user's subsequent real drags (a "dead zone" until enough events drain it).
  // Matching on the actual position carries no such residual. `null` means
  // "no programmatic write to reconcile yet".
  private _lastProgrammaticScrollTop: number | null = null;
  private _contentHeightSource: (() => number | undefined) | null = null;
  // Timestamp (ms) of the last GENUINE user scroll on the strip — i.e. a scroll
  // event that was NOT the echo of our own programmatic write. On desktop the
  // user drags the real native OS scrollbar (there is no custom thumb, so
  // `_thumbDrag` stays null), and the only evidence they are mid-drag is this
  // stream of real scroll events. `syncNativeScrollbar` reads it to defer
  // engine→scrollbar writes while the user is driving. See USER_SCROLL_DEFER_MS.
  private _lastUserScrollTs = 0;
  // Scroll→render coalescing. A native-scrollbar drag can fire several scroll
  // events per animation frame; rendering each one synchronously did 2-3× the
  // work per frame and dropped frames. We instead remember the latest scrollTop
  // and run the map+render ONCE on the next frame (the wheel path is already
  // rAF-driven, which is why it stays smooth). `_scrollRafId` is the pending
  // frame (null = none scheduled); `_pendingScrollTop` is the position to render.
  private _scrollRafId: number | null = null;
  private _pendingScrollTop = 0;
  private _cachedScrollbarWidth: number | undefined = undefined;
  // True when the platform uses OVERLAY scrollbars (macOS trackpad default,
  // mobile): the OS paints a thin auto-hiding bar OVER content and reserves no
  // layout width. Measured as a 0-width difference on a probe element. We must
  // not reserve a gutter in that case, or it leaves a dead gap with no visible
  // scrollbar. Cached alongside the width measurement.
  private _cachedOverlayScrollbars: boolean | undefined = undefined;
  private _lastScrollTop: number = 0;
  private _lastRenderedElement: number = -1;
  private _lastRenderedOffset: number = -1;
  // Track scroll-event listeners so we can remove them on detach to prevent
  // listener leaks when the scrollbar is recreated.
  private _scrollListener: ((e: Event) => void) | null = null;
  // Bound pointer handlers, retained so we can remove them on detach.
  private _thumbPointerDown: ((e: PointerEvent) => void) | null = null;
  private _thumbPointerMove: ((e: PointerEvent) => void) | null = null;
  private _thumbPointerUp: ((e: PointerEvent) => void) | null = null;

  /**
   * Inject the one-time stylesheet that hides the native OS scrollbar on
   * the sibling driver and styles our custom thumb. Done once per document
   * because every CeriousScroll instance uses the same selectors.
   *
   * Consumers can override the thumb appearance via CSS variables on the
   * scroll host (`--cerious-thumb-color`, `--cerious-thumb-color-active`,
   * `--cerious-thumb-width`, `--cerious-thumb-width-active`).
   */
  private static ensureStylesInjected(): void {
    if (this._stylesInjected) return;
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.setAttribute('data-cerious-scrollbar-styles', '');
    style.textContent = `
[data-cerious-scrollbar="container"][data-touch="true"] { scrollbar-width: none; -ms-overflow-style: none; }
[data-cerious-scrollbar="container"][data-touch="true"]::-webkit-scrollbar { width: 0; height: 0; display: none; }
[data-cerious-scrollbar="thumb"] {
  position: absolute;
  right: 2px;
  width: var(--cerious-thumb-width, 5px);
  min-height: ${NativeScrollbar.THUMB_MIN_HEIGHT_PX}px;
  border-radius: 999px;
  background: var(--cerious-thumb-color, rgba(0, 0, 0, 0.45));
  opacity: 0;
  transition: opacity 200ms ease, width 120ms ease, background-color 120ms ease;
  pointer-events: auto;
  touch-action: none;
  /* Expand the touch hit target without changing the painted size: a
   * transparent pseudo-element extends the pointer area ~10px in each
   * direction so a fingertip reliably grabs the slim pill. */
  will-change: top, height, opacity;
  z-index: ${NativeScrollbar.DEFAULT_Z_INDEX + 1};
}
[data-cerious-scrollbar="thumb"]::before {
  content: "";
  position: absolute;
  top: -8px;
  bottom: -8px;
  left: -12px;
  right: -12px;
}
[data-cerious-scrollbar="thumb"][data-visible="true"] { opacity: 1; }
[data-cerious-scrollbar="thumb"][data-active="true"] {
  width: var(--cerious-thumb-width-active, 8px);
  background: var(--cerious-thumb-color-active, rgba(0, 0, 0, 0.7));
  opacity: 1;
}
@media (prefers-color-scheme: dark) {
  [data-cerious-scrollbar="thumb"] { background: var(--cerious-thumb-color, rgba(255, 255, 255, 0.5)); }
  [data-cerious-scrollbar="thumb"][data-active="true"] { background: var(--cerious-thumb-color-active, rgba(255, 255, 255, 0.75)); }
}
`;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  /**
   * Detect a touch-primary device (mobile/tablet). The custom thumb only
   * applies here — desktop browsers keep the native OS scrollbar on the
   * sibling strip because it works correctly and matches platform chrome.
   */
  private static isTouchPrimary(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  /** Monotonic-ish timestamp in ms, with a fallback for non-DOM environments. */
  private static _now(): number {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /**
   * Schedule a callback for the next animation frame. Falls back to a 16ms
   * timer when requestAnimationFrame is unavailable (non-DOM / SSR), so the
   * scroll→render coalescing keeps working everywhere. Returns a cancel handle.
   */
  private static _raf(cb: () => void): number {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    return setTimeout(cb, 16) as unknown as number;
  }

  /** Cancel a handle from {@link _raf}. */
  private static _caf(handle: number): void {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else clearTimeout(handle);
  }

  /**
   * @param totalElements Dataset length (sets virtual track height).
   * @param getScrollPercentage Current `0`–`100` position.
   * @param getElementHeight Height lookup for a dataset index.
   * @param onScrollPositionChange Called when the strip drives the camera.
   * @param scrollHandlers Navigation engine, or `null` until {@link setScrollHandlers}.
   * @param getViewportHeight Usable height in pixels.
   * @param getCurrentElement Camera row index.
   * @param getScrollOffset Pixels into the camera row.
   * @param getTrueBottomPosition Measured true-bottom camera, or `null`.
   * @param virtualTrackHeight Pixel height of the virtual track. Default 10_000_000.
   * @param onRender Optional. Invoked after a user-driven strip scroll so the host re-renders.
   */
  constructor(
    private totalElements: number,
    private getScrollPercentage: () => number,
    private getElementHeight: (index: number) => number,
    private onScrollPositionChange: (element: number, offset: number) => void,
    private scrollHandlers: NavigationEngine | null,
    private getViewportHeight: () => number,
    private getCurrentElement: () => number,
    private getScrollOffset: () => number,
    private getTrueBottomPosition: () => { element: number; offset: number } | null,
    private virtualTrackHeight: number = 10000000,
    private onRender?: (result: any) => void
  ) {}

  /**
   * Inject the navigation engine after construction. NativeScrollbar is
   * created before the engine exists in CeriousScroll's bootstrap order, so
   * a deferred setter avoids the previous `null as any` cast and the
   * accompanying NPE risk if a scroll event fires before assignment.
   *
   * @param handlers Navigation engine instance.
   */
  /**
   * Height of the strip's scrollable surface.
   *
   * Single source of truth for both the creation path and later re-sizes —
   * they used to compute this independently, so installing a content-height
   * source only affected re-sizes and the strip kept its element-count height
   * from creation.
   *
   * @param container Strip element (its clientHeight sets the floor).
   * @returns Pixels.
   */
  private computeSurfaceHeight(container: HTMLElement): number {
    // Exceed the container so the thumb renders even for small lists.
    const minHeight = container.clientHeight + NativeScrollbar.ELEMENT_HEIGHT_MULTIPLIER;
    const contentHeight = this._contentHeightSource ? this._contentHeightSource() : undefined;
    const surface = (contentHeight !== undefined && Number.isFinite(contentHeight) && contentHeight > 0)
      ? Math.min(contentHeight, NativeScrollbar.MAX_STRIP_HEIGHT_PX)
      // Element count is the right proxy when an element is roughly a row.
      : (this.totalElements + 1) * NativeScrollbar.ELEMENT_HEIGHT_MULTIPLIER;
    return Math.max(Math.round(surface), minHeight);
  }

  /**
   * Size the strip by CONTENT height instead of element count.
   *
   * The default is `totalElements * 10px`, which is right when an element is
   * roughly a row: ten track pixels per row is ample resolution. When an element
   * is much larger than a row, that ratio collapses — 400 elements addressing
   * 10M px of content leaves ~3,360 content px per track px, so the position
   * quantizes and scrolling snaps.
   *
   * @param source Returns total content height, or undefined to keep element sizing.
   */
  setContentHeightSource(source: (() => number | undefined) | null): void {
    this._contentHeightSource = source;
  }

  setScrollHandlers(handlers: NavigationEngine): void {
    this.scrollHandlers = handlers;
  }

  /**
   * Attached sibling strip, or `null` if none.
   */
  get container(): HTMLElement | null {
    return this._scrollbarContainer;
  }

  /**
   * True while a programmatic `scrollTop` write is in flight. Callers skip
   * re-sync so the echo cannot loop.
   */
  get isSyncing(): boolean {
    return this._syncingScrollbar;
  }

  private getScrollbarWidth(): number {
    if (this._cachedScrollbarWidth !== undefined) {
      return this._cachedScrollbarWidth;
    }

    const outer = document.createElement('div');
    outer.style.cssText = 'visibility:hidden;width:100px;height:100px;overflow:scroll;position:absolute;top:-9999px;';
    document.body.appendChild(outer);
    
    const scrollbarWidth = outer.offsetWidth - outer.clientWidth;
    document.body.removeChild(outer);

    // A 0-width difference means the platform uses overlay scrollbars (they
    // float over content and reserve no space). Record that so the gutter is
    // skipped; the strip itself still gets a usable width (the default) so the
    // OS can paint its overlay bar over the content's right edge on scroll.
    this._cachedOverlayScrollbars = scrollbarWidth === 0;

    this._cachedScrollbarWidth = scrollbarWidth || NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH;
    return this._cachedScrollbarWidth;
  }

  /**
   * Whether the platform uses overlay scrollbars (no reserved width). Triggers
   * the measurement lazily if needed.
   */
  private hasOverlayScrollbars(): boolean {
    if (this._cachedOverlayScrollbars === undefined) {
      this.getScrollbarWidth(); // populates _cachedOverlayScrollbars
    }
    return this._cachedOverlayScrollbars ?? false;
  }

  /** Drop cached OS scrollbar width (zoom / display change). */
  clearScrollbarWidthCache(): void {
    this._cachedScrollbarWidth = undefined;
    this._cachedOverlayScrollbars = undefined;
  }

  /**
   * @param container Host the strip is attached to.
   * @param viewportHeight New host height in pixels (unused for layout; strip is `height: 100%`).
   */
  handleViewportChange(container: HTMLElement, viewportHeight: number): void {
    this.clearScrollbarWidthCache();

    // Do not recreate the strip. It is height:100% so it tracks the host,
    // and recreating reset scrollTop to 0 — a stray scroll event then jumped
    // the viewport to the top, and echo-accounting stayed on the discarded
    // node (dead zone until enough events drained). Caller reflow() re-syncs
    // the thumb; clear the programmatic marker so a resize cannot eat the
    // next genuine scroll.
    this._syncingScrollbar = false;
    this._lastProgrammaticScrollTop = null;
  }

  /**
   * @param container Host element.
   * @param onViewportChange Called on window resize.
   * @returns Detach function.
   */
  setupAutoResizeHandling(
    container: HTMLElement, 
    onViewportChange: (container: HTMLElement) => void
  ): () => void {
    const resizeHandler = () => onViewportChange(container);
    window.addEventListener('resize', resizeHandler);
    return () => {
      window.removeEventListener('resize', resizeHandler);
    };
  }

  /**
   * Attach the sibling strip (and touch overlay thumb when appropriate).
   * @param container Host element.
   */
  attachNativeScrollbar(container: HTMLElement): void {
    const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
    if (existingScrollbar) {
      existingScrollbar.remove();
    }

    const detectedWidth = this.getScrollbarWidth();

    // On touch-primary devices the OS won't paint a scrollbar on this
    // sibling strip (the user's finger drags content, not the strip), so we
    // collapse the strip to zero width and draw our own overlay thumb on top
    // of the content. On desktop the strip carries the real native OS
    // scrollbar, which already adapts to the platform AND the input device
    // (e.g. macOS draws a thin auto-hiding overlay for a trackpad and a wider
    // persistent bar for a mouse) and to the host's `color-scheme`.
    //
    // Crucially we keep the strip fully transparent and borderless: painting
    // our own background/border over it (the previous `#f0f0f0` + `1px #ccc`)
    // drew a fake light "track" that masked the native scrollbar — looking
    // wrong on dark UIs and defeating the device adaptation. Leaving it bare
    // lets the genuine OS scrollbar show through unchanged.
    const touch = NativeScrollbar.isTouchPrimary();

    this._scrollbarContainer = this.createNativeScrollbar(container, {
      width: touch ? '0px' : `${detectedWidth}px`,
      position: 'right',
      style: {
        background: 'transparent',
        borderLeft: 'none',
        zIndex: String(NativeScrollbar.DEFAULT_Z_INDEX)
      }
    });
  }

  /**
   * Create and attach a native scrollbar that drives virtual scrolling.
   *
   * @param container Host to attach the strip to.
   * @param options Strip width, side, and extra CSS.
   * @param options.width Strip CSS width. Default: measured OS scrollbar width.
   * @param options.position `'left'` or `'right'` (default `'right'`).
   * @param options.style Extra CSS properties written onto the strip.
   * @returns The strip element.
   */
  createNativeScrollbar(container: HTMLElement, options: {
    width?: string;
    position?: 'left' | 'right';
    style?: Record<string, string>;
  } = {}): HTMLElement {
    NativeScrollbar.ensureStylesInjected();

    // Remove any existing scrollbar first since we need to create one with current data
    const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
    if (existingScrollbar) {
      existingScrollbar.remove();
    }
    // Also remove any prior thumb so we don't leak elements across recreations.
    const existingThumb = container.querySelector('[data-cerious-scrollbar="thumb"]');
    if (existingThumb) existingThumb.remove();

    const { width = `${this.getScrollbarWidth()}px`, position = 'right', style = {} } = options;

    // Touch-primary devices get the overlay thumb path. We tag the strip so
    // the scoped stylesheet hides its (otherwise-present) native scrollbar.
    const touch = NativeScrollbar.isTouchPrimary();

    const scrollbarContainer = document.createElement('div');
    scrollbarContainer.setAttribute('data-cerious-scrollbar', 'container');
    if (touch) scrollbarContainer.setAttribute('data-touch', 'true');
    scrollbarContainer.style.cssText = `
      position: absolute;
      top: 0;
      ${position}: 0;
      width: ${width};
      height: 100%;
      overflow-y: scroll;
      overflow-x: hidden;
      z-index: ${style['zIndex'] || NativeScrollbar.DEFAULT_Z_INDEX};
      background: ${style['background'] || 'transparent'};
      border-left: ${style['borderLeft'] || 'none'};
      pointer-events: auto;
    `;

    // Create scrollable content (sets scroll range based on element count, not heights)
    // Add +1 to ensure scrollbar can reach 100% (accounts for rounding/boundary conditions)
    // Also ensure the surface always exceeds the container height so the thumb
    // renders even for small lists whose total element units would otherwise
    // fit within the viewport (e.g. paged datasets).
    const scrollableContent = document.createElement('div');
    scrollableContent.setAttribute('data-cerious-scrollbar', 'content');
    scrollableContent.style.cssText = `
      width: 1px;
      height: ${this.computeSurfaceHeight(container)}px;
      pointer-events: none;
    `;

    scrollbarContainer.appendChild(scrollableContent);

    // Position container relatively and ensure it can contain the scrollbar
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Add padding to container to make room for scrollbar and prevent overlap.
    // Skip on touch — the strip is zero-width and the overlay thumb floats over
    // content. Also skip for platform OVERLAY scrollbars (e.g. macOS trackpad):
    // they float over content and reserve no width, so reserving a gutter would
    // leave a dead gap with no visible bar. The strip keeps a usable width so
    // the OS still paints its overlay bar over the content's right edge.
    const overlay = this.hasOverlayScrollbars();
    const reserveGutter = !touch && !overlay;

    // Mount the strip BEFORE reserving space for it. The gutter has to match the
    // strip's RENDERED width, and only a mounted element reports that — the
    // configured width excludes any `borderLeft` the caller styled on. The strip
    // is absolutely positioned, so mounting it first cannot disturb layout.
    container.appendChild(scrollbarContainer);

    if (reserveGutter) {
      NativeScrollbar.reserveGutter(
        container,
        position === 'left' ? 'left' : 'right',
        scrollbarContainer.offsetWidth ||
          parseInt(width) ||
          NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH
      );
    }

    // The expensive half of a scroll: map the latest scrollTop to a virtual
    // position and render the viewport. Coalesced to ONE run per animation frame
    // (see `_scrollRafId`), so a fast native-scrollbar drag that fires several
    // scroll events in a frame renders only the final position — matching the
    // wheel path's rAF cadence. No extra blank rows (the full viewport is still
    // rendered every frame) and at most ~1 frame of added latency.
    const renderFromScroll = (): void => {
      this._scrollRafId = null;
      // The strip may have been torn down between scheduling and this frame.
      if (!this.scrollHandlers || !this._scrollbarContainer) return;

      const scrollTop = this._pendingScrollTop;
      const maxScroll = scrollbarContainer.scrollHeight - scrollbarContainer.clientHeight;

      // Calculate percentage based on scrollbar position. Add tolerance for when
      // the scrollbar is at/near bottom (the thumb has a minimum size).
      const BOTTOM_TOLERANCE_PX = 1; // pixels from bottom to treat as 100%
      let percentage: number;
      if (maxScroll > 0) {
        percentage = scrollTop >= maxScroll - BOTTOM_TOLERANCE_PX
          ? NativeScrollbar.PERCENTAGE_MAX // Treat as 100%
          : (scrollTop / maxScroll) * NativeScrollbar.PERCENTAGE_MAX;
      } else {
        percentage = 0;
      }

      this._syncingScrollbar = true;

      const trueBottom = this.getTrueBottomPosition();

      // Calculate target position based on percentage.
      // Map 0% to element 0 offset 0, and 100% to the true bottom position.
      let targetElement: number;
      let targetOffset: number;
      if (trueBottom) {
        // Linear interpolation between 0% (element 0, offset 0) and 100% (true
        // bottom). Convert true bottom to a scalar position for interpolation.
        const trueBottomPosition = trueBottom.element + (trueBottom.offset / this.getElementHeight(trueBottom.element));
        const targetPosition = (percentage / NativeScrollbar.PERCENTAGE_MAX) * trueBottomPosition;
        targetElement = Math.floor(targetPosition);
        const targetProgress = targetPosition - targetElement;
        targetOffset = Math.round(targetProgress * this.getElementHeight(targetElement));
      } else {
        // Fallback if true bottom is not available.
        const targetIndexPosition = (percentage / NativeScrollbar.PERCENTAGE_MAX) * (this.totalElements - 1);
        targetElement = Math.floor(targetIndexPosition);
        const targetProgress = targetIndexPosition - targetElement;
        targetOffset = Math.round(targetProgress * this.getElementHeight(targetElement));
      }

      // Check if position actually changed before doing expensive operations.
      const currentElement = this.getCurrentElement();
      const currentOffset = this.getScrollOffset();
      if (targetElement !== currentElement || targetOffset !== currentOffset) {
        const result = this.scrollHandlers.jumpToPosition(targetElement, targetOffset, true);
        this._lastRenderedElement = result.element;
        this._lastRenderedOffset = result.offset;
        container.dispatchEvent(new CustomEvent('viewport-change', {
          detail: { element: result.element, scrollOffset: result.offset, percentage }
        }));
        // Trigger render callback - this is what actually updates the DOM.
        if (this.onRender) this.onRender(result);
      }

      this._syncingScrollbar = false;
    };

    // Bind scroll events - map scrollbar position directly to element index. The
    // cheap, must-stay-synchronous bookkeeping (echo rejection, the user-scroll
    // timestamp, thumb visuals) runs here; the map+render is deferred to a frame.
    const scrollListener = (_e: Event) => {
      if (this._syncingScrollbar) return;
      // Bail out gracefully if the engine hasn't been wired up yet (this can
      // happen if a scroll event fires between scrollbar creation and the
      // CeriousScroll constructor finishing).
      if (!this.scrollHandlers) return;

      const scrollTop = scrollbarContainer.scrollTop;

      // Ignore the asynchronous echo of our own programmatic writes. We compare
      // the live scrollTop against the last value we wrote rather than counting
      // expected echoes: browsers coalesce rapid programmatic writes into fewer
      // scroll events, so a counter accumulates a positive residual that later
      // swallows the user's genuine drags (the wheel-then-drag "dead zone").
      // A position match has no residual, and still distinguishes a user move
      // (different scrollTop) from an echo (same scrollTop) even when a write
      // and a user move coalesce into one event — the live scrollTop then holds
      // the user's value, so it is correctly processed.
      if (
        this._lastProgrammaticScrollTop !== null &&
        Math.abs(scrollTop - this._lastProgrammaticScrollTop) <=
          NativeScrollbar.PROGRAMMATIC_SCROLL_TOLERANCE_PX
      ) {
        return;
      }

      // This event is a genuine user move (it did NOT match the programmatic
      // marker). Invalidate the marker now. It is only ever set by
      // syncNativeScrollbar (a programmatic write) and is NEVER refreshed by a
      // scrollbar drag — the drag path calls jumpToPosition(skipScrollbarSync).
      // So once the user drags away from a synced position the marker goes
      // stale, and a later drag that lands back on that exact value — most
      // visibly scrollTop 0 at the very top — would be wrongly dropped as our
      // own echo, leaving the engine a few rows short of row 0. The real echo of
      // a programmatic write is still caught above, because it fires before any
      // user move reaches this line.
      this._lastProgrammaticScrollTop = null;

      // Record that the user is actively driving the strip (native-scrollbar
      // drag, track click, or custom-thumb drag — all land here as non-echo
      // events). syncNativeScrollbar uses this to defer engine→scrollbar writes
      // for the duration of the gesture.
      this._lastUserScrollTs = NativeScrollbar._now();

      this._lastScrollTop = scrollTop;

      // Keep the custom thumb visually in sync with the strip position on
      // every user scroll (wheel, drag-on-sibling, touch-driven via
      // syncNativeScrollbar). Cheap: only top/height + a data attribute.
      this._updateThumbVisuals();

      // Coalesce the expensive map+render to one run on the next frame at the
      // LATEST scrollTop (see renderFromScroll).
      this._pendingScrollTop = scrollTop;
      if (this._scrollRafId === null) {
        this._scrollRafId = NativeScrollbar._raf(renderFromScroll);
      }
    };

    // Remove any previous listener (we recreate the scrollbar on resize)
    if (this._scrollListener && this._scrollbarContainer) {
      try {
        this._scrollbarContainer.removeEventListener('scroll', this._scrollListener);
      } catch { /* noop */ }
    }
    this._scrollListener = scrollListener;
    scrollbarContainer.addEventListener('scroll', scrollListener);

    // A brand-new element starts at scrollTop 0. Seed the programmatic marker
    // at 0 so a stray initial scroll event (the transient-0 read) is treated as
    // our own and ignored, while any real user drag — which moves scrollTop off
    // 0 — is still processed. This also drops any marker tied to the element we
    // just replaced.
    this._syncingScrollbar = false;
    this._lastProgrammaticScrollTop = 0;

    this._scrollbarContainer = scrollbarContainer;

    // Custom overlay thumb is touch-only. Desktop keeps the platform-native
    // scrollbar on the strip.
    if (touch) {
      this._createThumb(container, scrollbarContainer, position);
      this._updateThumbVisuals();
    }

    return scrollbarContainer;
  }

  /**
   * Synchronize native scrollbar position with virtual scroll position
   * 
   * @param scrollbarContainer Strip to write. Defaults to the attached strip.
   */
  syncNativeScrollbar(scrollbarContainer?: HTMLElement): void {
    const container = scrollbarContainer || this._scrollbarContainer;
    if (!container || this._syncingScrollbar) return;

    // Defer to a user who is actively driving the scrollbar. While they drag,
    // THEY own the scroll position — the drag moves scrollTop and the scroll
    // listener maps it to the engine. An engine→scrollbar sync here (e.g. a live
    // feed appending rows mid-drag, which re-anchors via jumpToElement) would
    // write scrollTop out from under the drag: it yanks the thumb, and re-arms
    // the programmatic-echo marker so the drag's own moves get swallowed as
    // echoes — the "thumb freezes / bounces while a row is appended" bug.
    //
    // Two signals, because the drag target differs by platform: the touch
    // custom-thumb sets `_thumbDrag`; the desktop native OS scrollbar sets none,
    // so we fall back to "a genuine strip scroll happened within the last frame
    // or two" (USER_SCROLL_DEFER_MS). Either way the next scroll event (or the
    // gesture's end) re-syncs from the final position.
    if (this._thumbDrag ||
        NativeScrollbar._now() - this._lastUserScrollTs < NativeScrollbar.USER_SCROLL_DEFER_MS) {
      return;
    }

    const percentage = this.getScrollPercentage();
    if (!Number.isFinite(percentage)) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) return;
    const targetScrollTop = (percentage / NativeScrollbar.PERCENTAGE_MAX) * maxScroll;

    if (Math.abs(container.scrollTop - targetScrollTop) > 1) {
      this._syncingScrollbar = true;
      container.scrollTop = targetScrollTop;
      // Record the value we actually wrote (read back, since the browser may
      // clamp/round our target) so the scroll listener recognises — and
      // ignores — the asynchronous echo this assignment triggers.
      this._lastProgrammaticScrollTop = container.scrollTop;
      this._lastScrollTop = this._lastProgrammaticScrollTop;
      this._syncingScrollbar = false;
    }

    // Reflect the new logical position on the custom thumb (touch-only;
    // no-op on desktop because _thumbElement is null). On touch this path
    // is what fires during touch-driven content scroll, where the OS will
    // never paint a thumb for the sibling strip.
    this._updateThumbVisuals();
  }

  /**
   * Resize the virtual track after the dataset length changes.
   *
   * @param totalElements New dataset length.
   * @param scrollbarContainer Optional strip; defaults to the attached one.
   */
  updateNativeScrollbarHeight(totalElements: number, scrollbarContainer?: HTMLElement): void {
    this.totalElements = totalElements;
    const container = scrollbarContainer || this._scrollbarContainer;
    if (!container) return;

    const scrollableContent = container.querySelector('[data-cerious-scrollbar="content"]') as HTMLElement;
    if (scrollableContent) {
      scrollableContent.style.height = this.computeSurfaceHeight(container) + 'px';
    }
  }

  /**
   * Remove the strip, thumb, and listeners.
   * @param container Optional host used to find an orphan strip.
   */
  detachScrollbar(container?: HTMLElement): void {
    if (this._scrollbarContainer) {
      const parentContainer = this._scrollbarContainer.parentElement;

      if (this._scrollListener) {
        try {
          this._scrollbarContainer.removeEventListener('scroll', this._scrollListener);
        } catch { /* noop */ }
        this._scrollListener = null;
      }

      // Cancel any coalesced scroll→render frame so it can't fire after teardown.
      if (this._scrollRafId !== null) {
        NativeScrollbar._caf(this._scrollRafId);
        this._scrollRafId = null;
      }

      // Tear down the custom thumb: pointer listeners (window-scoped during
      // an active drag), fade timer, and the element itself.
      this._teardownThumb();

      this._scrollbarContainer.remove();
      this._scrollbarContainer = null;
      
      // Give back exactly what was reserved — no more, and nothing at all if the
      // host's own padding already covered the strip and we never widened it.
      NativeScrollbar.releaseGutter(parentContainer);
    } else if (container) {
      // If no tracked scrollbar, try to find and remove any existing scrollbar
      const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
      if (existingScrollbar) {
        existingScrollbar.remove();
        NativeScrollbar.releaseGutter(container);
      }
      const orphanThumb = container.querySelector('[data-cerious-scrollbar="thumb"]');
      if (orphanThumb) orphanThumb.remove();
    }
  }

  /**
   * Create the custom thumb overlay on the host container.
   *
   * The thumb lives alongside the scrollbar strip (not inside it) so it is
   * not displaced by the strip's own `scrollTop`. We size and position it in
   * pixel space against the container's client rect.
   */
  private _createThumb(
    container: HTMLElement,
    scrollbarContainer: HTMLElement,
    position: 'left' | 'right'
  ): void {
    const thumb = document.createElement('div');
    thumb.setAttribute('data-cerious-scrollbar', 'thumb');
    // Honour left/right placement of the strip so the thumb tracks it.
    if (position === 'left') {
      thumb.style.left = '2px';
      thumb.style.right = 'auto';
    }
    container.appendChild(thumb);
    this._thumbElement = thumb;

    // Drag handling. We translate vertical pointer movement to a delta on the
    // sibling strip's `scrollTop`, which fires the existing scroll listener
    // and routes through the same true-bottom mapping the wheel/keyboard
    // paths use. This keeps scroll math in one place.
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== undefined && e.button !== 0) return;
      const sb = this._scrollbarContainer;
      if (!sb) return;
      const clientH = sb.clientHeight;
      const thumbH = thumb.getBoundingClientRect().height;
      const trackPx = Math.max(1, clientH - thumbH);
      this._thumbDrag = {
        pointerId: e.pointerId,
        startClientY: e.clientY,
        startScrollTop: sb.scrollTop,
        trackPx,
      };
      thumb.setAttribute('data-active', 'true');
      thumb.setAttribute('data-visible', 'true');
      try { thumb.setPointerCapture(e.pointerId); } catch { /* noop */ }
      // Suppress fade-out while actively dragging.
      if (this._thumbFadeTimer != null) {
        window.clearTimeout(this._thumbFadeTimer);
        this._thumbFadeTimer = null;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent): void => {
      const drag = this._thumbDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const sb = this._scrollbarContainer;
      if (!sb) return;
      const maxScroll = sb.scrollHeight - sb.clientHeight;
      if (maxScroll <= 0) return;
      const deltaPx = e.clientY - drag.startClientY;
      // Convert pixel travel of the thumb on its track into scrollTop. The
      // scroll listener handles the percentage → virtual position mapping.
      const scrollDelta = (deltaPx / drag.trackPx) * maxScroll;
      let next = drag.startScrollTop + scrollDelta;
      if (next < 0) next = 0;
      if (next > maxScroll) next = maxScroll;
      sb.scrollTop = next;
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent): void => {
      const drag = this._thumbDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      this._thumbDrag = null;
      thumb.removeAttribute('data-active');
      try { thumb.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      // Resume the normal fade-out sequence.
      this._scheduleThumbFade();
    };

    this._thumbPointerDown = onPointerDown;
    this._thumbPointerMove = onPointerMove;
    this._thumbPointerUp = onPointerUp;

    thumb.addEventListener('pointerdown', onPointerDown);
    // Listen on the thumb (pointer is captured) for move/up; covers both
    // mouse and touch via the unified Pointer Events API.
    thumb.addEventListener('pointermove', onPointerMove);
    thumb.addEventListener('pointerup', onPointerUp);
    thumb.addEventListener('pointercancel', onPointerUp);

    // Full-strip touch zone: a transparent column overlay along the right
    // edge (or left, mirroring `position`) so the entire scrollbar lane is a
    // tap/drag target. Tapping outside the thumb jumps it to the touch point
    // (page-jump) and immediately begins a drag from there; tapping on the
    // thumb behaves like a direct grab.
    const hit = document.createElement('div');
    hit.setAttribute('data-cerious-scrollbar', 'hit');
    hit.style.cssText = `
      position: absolute;
      top: 0;
      bottom: 0;
      ${position}: 0;
      width: 24px;
      background: transparent;
      z-index: ${NativeScrollbar.DEFAULT_Z_INDEX};
      touch-action: none;
      pointer-events: none;
    `;
    const onHitPointerDown = (e: PointerEvent): void => {
      if (e.button !== undefined && e.button !== 0) return;
      const sb = this._scrollbarContainer;
      if (!sb) return;
      const thumbRect = thumb.getBoundingClientRect();
      // If the touch landed within the thumb's vertical band, delegate —
      // the thumb's own pointerdown will run (the thumb sits on top of the
      // hit zone via z-index). For taps outside the thumb, jump the strip's
      // scrollTop so the thumb centers on the touch Y, then start a drag.
      if (e.clientY >= thumbRect.top && e.clientY <= thumbRect.bottom) return;
      const sbRect = sb.getBoundingClientRect();
      const clientH = sb.clientHeight;
      const thumbH = thumbRect.height;
      const trackPx = Math.max(1, clientH - thumbH);
      // Desired thumb-top so the thumb centers on the touch point, clamped.
      let desiredTop = (e.clientY - sbRect.top) - thumbH / 2;
      if (desiredTop < 0) desiredTop = 0;
      if (desiredTop > trackPx) desiredTop = trackPx;
      const maxScroll = sb.scrollHeight - sb.clientHeight;
      const newScrollTop = (desiredTop / trackPx) * maxScroll;
      sb.scrollTop = newScrollTop;
      // Begin a drag anchored at the new position so subsequent move events
      // pan smoothly from the jumped-to location.
      this._thumbDrag = {
        pointerId: e.pointerId,
        startClientY: e.clientY,
        startScrollTop: newScrollTop,
        trackPx,
      };
      thumb.setAttribute('data-active', 'true');
      thumb.setAttribute('data-visible', 'true');
      try { hit.setPointerCapture(e.pointerId); } catch { /* noop */ }
      if (this._thumbFadeTimer != null) {
        window.clearTimeout(this._thumbFadeTimer);
        this._thumbFadeTimer = null;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    hit.addEventListener('pointerdown', onHitPointerDown);
    // Re-use the thumb's move/up handlers so the same drag state machine
    // services both entry points.
    hit.addEventListener('pointermove', onPointerMove);
    hit.addEventListener('pointerup', onPointerUp);
    hit.addEventListener('pointercancel', onPointerUp);
    container.appendChild(hit);
    this._thumbHitZone = hit;
    this._thumbHitZoneDown = onHitPointerDown;

    // Keep `scrollbarContainer` referenced for symmetry with future variants
    // (e.g. clicking the strip background to page). Currently unused.
    void scrollbarContainer;
  }

  /**
   * Recompute the thumb's `top`/`height` from the strip's current scrollTop
   * and mark it visible. Cheap; called from the user-scroll listener and from
   * `syncNativeScrollbar` (the latter is what fires during touch-driven
   * content scroll on iOS).
   */
  private _updateThumbVisuals(): void {
    const thumb = this._thumbElement;
    const sb = this._scrollbarContainer;
    if (!thumb || !sb) return;
    const clientH = sb.clientHeight;
    const scrollH = sb.scrollHeight;
    if (clientH <= 0 || scrollH <= 0) return;
    // Thumb height reflects how much of the runway is currently in view.
    // Clamp to a usable grab target.
    const rawHeight = clientH * (clientH / scrollH);
    const thumbHeight = Math.max(NativeScrollbar.THUMB_MIN_HEIGHT_PX, Math.min(clientH, rawHeight));
    const maxScroll = scrollH - clientH;
    const pct = maxScroll > 0 ? sb.scrollTop / maxScroll : 0;
    const top = (clientH - thumbHeight) * pct;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.top = `${top}px`;
    thumb.setAttribute('data-visible', 'true');
    // Activate the full-strip touch hit zone only while the thumb is
    // visible. Before the first scroll (or after fade-out) the strip is
    // inert so it never intercepts taps on underlying content.
    if (this._thumbHitZone) this._thumbHitZone.style.pointerEvents = 'auto';
    this._scheduleThumbFade();
  }

  private _scheduleThumbFade(): void {
    if (typeof window === 'undefined') return;
    // Don't fade while a drag is in flight; pointerup will reschedule.
    if (this._thumbDrag) return;
    if (this._thumbFadeTimer != null) {
      window.clearTimeout(this._thumbFadeTimer);
    }
    this._thumbFadeTimer = window.setTimeout(() => {
      this._thumbFadeTimer = null;
      if (this._thumbDrag) return;
      const t = this._thumbElement;
      if (t) t.removeAttribute('data-visible');
      // Deactivate the strip hit zone alongside the fade so the column
      // returns to inert after a brief grace window.
      if (this._thumbHitZone) this._thumbHitZone.style.pointerEvents = 'none';
    }, NativeScrollbar.THUMB_FADE_DELAY_MS);
  }

  private _teardownThumb(): void {
    if (this._thumbFadeTimer != null && typeof window !== 'undefined') {
      window.clearTimeout(this._thumbFadeTimer);
      this._thumbFadeTimer = null;
    }
    const thumb = this._thumbElement;
    if (thumb) {
      if (this._thumbPointerDown) thumb.removeEventListener('pointerdown', this._thumbPointerDown);
      if (this._thumbPointerMove) thumb.removeEventListener('pointermove', this._thumbPointerMove);
      if (this._thumbPointerUp) {
        thumb.removeEventListener('pointerup', this._thumbPointerUp);
        thumb.removeEventListener('pointercancel', this._thumbPointerUp);
      }
      thumb.remove();
    }
    const hit = this._thumbHitZone;
    const hitDown = this._thumbHitZoneDown;
    const moveHandler = this._thumbPointerMove;
    const upHandler = this._thumbPointerUp;
    this._thumbElement = null;
    this._thumbDrag = null;
    this._thumbPointerDown = null;
    this._thumbPointerMove = null;
    this._thumbPointerUp = null;
    if (hit) {
      if (hitDown) hit.removeEventListener('pointerdown', hitDown);
      if (moveHandler) hit.removeEventListener('pointermove', moveHandler);
      if (upHandler) {
        hit.removeEventListener('pointerup', upHandler);
        hit.removeEventListener('pointercancel', upHandler);
      }
      hit.remove();
    }
    this._thumbHitZone = null;
    this._thumbHitZoneDown = null;
  }

  /**
   * Widen the host's padding so the strip does not overlap content, and record
   * the amount added.
   *
   * Reserves the strip's rendered width exactly. The previous implementation
   * reserved `width + 2` and removed a hard-coded 19 on detach, which was wrong
   * in three ways: the gutter was 2px wider than the strip (leaving a dead
   * sliver that a content-aware layout has to work around), detach removed more
   * than attach ever added whenever the strip was not 17px, and a host with its
   * own padding kept none of it after a detach.
   *
   * @param container Host element.
   * @param side Which edge the strip is pinned to.
   * @param renderedWidth Strip width in pixels, as measured after mounting.
   */
  private static reserveGutter(
    container: HTMLElement,
    side: 'left' | 'right',
    renderedWidth: number
  ): void {
    if (!(renderedWidth > 0)) return;
    const computed = getComputedStyle(container);
    const current = (side === 'left'
      ? parseFloat(computed.paddingLeft)
      : parseFloat(computed.paddingRight)) || 0;

    // A host that already reserves enough keeps its own value, and we record
    // nothing — so detach leaves that padding alone.
    const added = renderedWidth - current;
    if (added <= 0) return;

    if (side === 'left') container.style.paddingLeft = `${current + added}px`;
    else container.style.paddingRight = `${current + added}px`;

    const prop = side === 'left' ? 'paddingLeft' : 'paddingRight';
    container.setAttribute(NativeScrollbar.RESERVED_ATTR, `${prop}:${added}`);
  }

  /**
   * Undo {@link reserveGutter}, restoring the host's original padding.
   *
   * @param container Host element, or null.
   */
  private static releaseGutter(container: HTMLElement | null): void {
    if (!container) return;
    const record = container.getAttribute(NativeScrollbar.RESERVED_ATTR);
    if (!record) return;
    container.removeAttribute(NativeScrollbar.RESERVED_ATTR);

    const sep = record.indexOf(':');
    if (sep < 0) return;
    const prop = record.slice(0, sep);
    const added = parseFloat(record.slice(sep + 1));
    if (!Number.isFinite(added) || added <= 0) return;

    const computed = getComputedStyle(container);
    if (prop === 'paddingLeft') {
      const current = parseFloat(computed.paddingLeft) || 0;
      container.style.paddingLeft = `${Math.max(0, current - added)}px`;
    } else {
      const current = parseFloat(computed.paddingRight) || 0;
      container.style.paddingRight = `${Math.max(0, current - added)}px`;
    }
  }
}
