/**
 * Native touch scrolling without making the virtual content itself the scroll
 * range. A hidden, local overflow surface receives the trusted browser gesture;
 * its scrollTop deltas are forwarded to the existing navigation engine.
 */

import { ScrollResult, TouchNavigationOptions } from '../types/index.js';

interface NativeTouchControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

export class NativeTouchController {
  private static readonly SURFACE_HEIGHT_PX = 2_000_000;
  private static readonly PROGRAMMATIC_TOLERANCE_PX = 2;
  private static readonly IDLE_MS = 180;
  private static _stylesInjected = false;

  private proxy: HTMLElement | null = null;
  private driving = false;
  private syncProxyPosition: (() => void) | null = null;

  private readonly eventDetail: {
    percentage: number;
    currentElement: number;
    scrollOffset: number;
    result: ScrollResult;
  } = {
    percentage: 0,
    currentElement: 0,
    scrollOffset: 0,
    result: { element: 0, offset: 0 },
  };

  constructor(private readonly deps: NativeTouchControllerDeps) {}

  private static ensureStylesInjected(): void {
    if (this._stylesInjected || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.setAttribute('data-cerious-native-touch-styles', '');
    style.textContent = `
[data-cerious-native-touch-proxy] {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
[data-cerious-native-touch-proxy]::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
`;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  /**
   * Attach a real overflow scroller around the dedicated content element.
   * The content remains the hit-test target, so mouse/pointer/click behavior is
   * unchanged; the proxy is merely its native scrollable ancestor.
   */
  attach(
    container: HTMLElement,
    onScroll?: (result: ScrollResult) => void,
    _options?: TouchNavigationOptions
  ): () => void {
    NativeTouchController.ensureStylesInjected();

    const content = container.querySelector<HTMLElement>(
      '[data-cerious-scroll-content], [data-cerious-masonry="content"]'
    );
    if (!content || content.parentElement !== container) {
      throw new Error(
        "CeriousScroll: touch.mode 'native-proxy' requires a direct child " +
        '[data-cerious-scroll-content] element (Masonry supplies its own viewport)'
      );
    }

    const originalContainerPosition = container.style.position;
    const originalContentPosition = content.style.position;
    const originalContentTop = content.style.top;
    const originalContentZIndex = content.style.zIndex;
    const originalContentTouchAction = content.style.touchAction;

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const proxy = document.createElement('div');
    proxy.setAttribute('data-cerious-native-touch-proxy', '');
    proxy.style.cssText = `
      position: absolute;
      inset: 0;
      overflow-y: scroll;
      overflow-x: hidden;
      touch-action: auto;
      overflow-anchor: none;
      -webkit-overflow-scrolling: touch;
    `;

    const surface = document.createElement('div');
    surface.setAttribute('data-cerious-native-touch-surface', '');
    surface.style.cssText = `
      width: 1px;
      height: ${NativeTouchController.SURFACE_HEIGHT_PX}px;
      pointer-events: none;
    `;

    // The proxy takes the content element's exact former slot. Moving the
    // content does not invalidate references retained by framework wrappers.
    container.insertBefore(proxy, content);
    proxy.appendChild(content);
    proxy.appendChild(surface);
    this.proxy = proxy;

    // Keep the virtual viewport stationary while the browser scrolls the
    // invisible surface beneath it. Rows remain normal descendants and keep
    // receiving mouse, pointer, click, focus, and touch events.
    content.style.position = 'sticky';
    content.style.top = '0px';
    content.style.zIndex = originalContentZIndex || '1';
    content.style.touchAction = 'auto';
    const originalContentOverflowAnchor = content.style.overflowAnchor;
    content.style.overflowAnchor = 'none';

    let lastScrollTop = 0;
    let ignoredScrollTop: number | null = null;
    let pendingDelta = 0;
    let rafId: number | null = null;
    let idleTimer: number | null = null;
    // Native scroll events do not identify their cause. Safari may adjust a
    // scroll container after a focused/changed descendant (scroll anchoring),
    // and forwarding that adjustment makes the changed card become a false
    // virtual boundary. Observe touch lifecycle passively so only an actual
    // pan and its subsequent momentum are allowed to drive the engine.
    let touchActive = false;
    let touchMovedScroll = false;
    let momentumActive = false;

    const viewportHeight = (): number => {
      const h = content.clientHeight;
      return h > 0 ? h : (container.clientHeight || container.offsetHeight);
    };

    const raf = (cb: () => void): number => {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
      return setTimeout(cb, 16) as unknown as number;
    };
    const caf = (id: number): void => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
      else clearTimeout(id);
    };

    const emit = (result: ScrollResult): void => {
      this.eventDetail.percentage = this.deps.calculateScrollPercentage();
      this.eventDetail.currentElement = this.deps.getCurrentElement();
      this.eventDetail.scrollOffset = this.deps.getScrollOffset();
      this.eventDetail.result = result;
      container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
        detail: this.eventDetail,
      }));
      onScroll?.(result);
    };

    const flush = (): void => {
      rafId = null;
      const delta = pendingDelta;
      pendingDelta = 0;
      if (delta === 0) return;
      emit(this.deps.scroll(delta, viewportHeight()));
    };

    const writeProxyPosition = (next: number): void => {
      const max = Math.max(0, proxy.scrollHeight - proxy.clientHeight);
      const clamped = Math.max(0, Math.min(max, next));
      if (Math.abs(proxy.scrollTop - clamped) <= 1) {
        lastScrollTop = proxy.scrollTop;
        return;
      }
      ignoredScrollTop = clamped;
      proxy.scrollTop = clamped;
      // Read back because browsers may round or clamp the assigned value.
      ignoredScrollTop = proxy.scrollTop;
      lastScrollTop = proxy.scrollTop;
    };

    const finishGesture = (): void => {
      if (!this.driving) return;
      if (rafId !== null) {
        caf(rafId);
        flush();
      }
      this.driving = false;
      momentumActive = false;
      this.syncPosition();
    };

    const scheduleIdle = (): void => {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        finishGesture();
      }, NativeTouchController.IDLE_MS);
    };

    const handleScroll = (): void => {
      // Safari exposes elastic overscroll through scrollTop: it can go below 0
      // at the top or above maxScroll at the bottom, then animate back into the
      // legal range. Forwarding that rebound would move the virtual camera in
      // the opposite direction (most visibly pulling the last rows back up just
      // after the user reached the bottom). Clamp observations to the native
      // range so both the outward stretch and its rebound are zero engine
      // movement once the physical boundary has been reached.
      const max = Math.max(0, proxy.scrollHeight - proxy.clientHeight);
      const current = Math.max(0, Math.min(max, proxy.scrollTop));
      if (
        ignoredScrollTop !== null &&
        Math.abs(current - ignoredScrollTop) <= NativeTouchController.PROGRAMMATIC_TOLERANCE_PX
      ) {
        ignoredScrollTop = null;
        lastScrollTop = current;
        return;
      }

      ignoredScrollTop = null;
      const delta = current - lastScrollTop;
      lastScrollTop = current;
      if (delta === 0) return;

      // A real touch pan is the only owner of this local scroll surface. Focus,
      // scroll anchoring, scrollIntoView, and other browser adjustments must be
      // rebased back to the engine position rather than interpreted as input.
      if (!touchActive && !momentumActive) {
        this.syncPosition();
        return;
      }

      this.driving = true;
      if (touchActive) touchMovedScroll = true;
      pendingDelta += delta;
      if (rafId === null) rafId = raf(flush);
      scheduleIdle();
    };

    const handleTouchStart = (): void => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
      // A fresh finger stops any previous momentum. Preserve its final pending
      // pixels before transferring ownership to the new gesture.
      if (rafId !== null) {
        caf(rafId);
        flush();
      }
      this.driving = false;
      momentumActive = false;
      touchActive = true;
      touchMovedScroll = false;
      const max = Math.max(0, proxy.scrollHeight - proxy.clientHeight);
      lastScrollTop = Math.max(0, Math.min(max, proxy.scrollTop));
    };

    const handleTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length > 0) return;
      touchActive = false;
      if (touchMovedScroll) {
        // Scroll events after touchend are browser-owned momentum. The normal
        // scrollend/idle path closes this window.
        momentumActive = true;
        scheduleIdle();
      } else {
        // It was a tap. Close ownership BEFORE the synthesized click mutates or
        // focuses content, so any resulting anchoring scroll cannot move the
        // virtual camera.
        momentumActive = false;
        this.driving = false;
        this.syncPosition();
      }
    };

    const handleTouchCancel = (): void => {
      touchActive = false;
      momentumActive = false;
      if (rafId !== null) {
        caf(rafId);
        flush();
      }
      this.driving = false;
      this.syncPosition();
    };

    proxy.addEventListener('scroll', handleScroll, { passive: true });
    proxy.addEventListener('scrollend', finishGesture, { passive: true });
    proxy.addEventListener('touchstart', handleTouchStart, { passive: true });
    proxy.addEventListener('touchend', handleTouchEnd, { passive: true });
    proxy.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    this.syncProxyPosition = () => {
      if (this.driving || !this.proxy) return;
      const percentage = this.deps.calculateScrollPercentage();
      const max = Math.max(0, proxy.scrollHeight - proxy.clientHeight);
      const middle = Math.round(max / 2);
      // calculateScrollPercentage() is already clamped and reports exact 0/100
      // at the dataset boundaries. Do not use a fuzzy percentage threshold
      // here: on a very large dataset even 0.01% can represent thousands of
      // pixels. Snapping that valid near-top position to physical scrollTop 0
      // leaves the next upward finger drag rubber-banding at a false boundary.
      writeProxyPosition(percentage <= 0 ? 0 : percentage >= 100 ? max : middle);
    };
    this.syncPosition();

    return () => {
      proxy.removeEventListener('scroll', handleScroll);
      proxy.removeEventListener('scrollend', finishGesture);
      proxy.removeEventListener('touchstart', handleTouchStart);
      proxy.removeEventListener('touchend', handleTouchEnd);
      proxy.removeEventListener('touchcancel', handleTouchCancel);
      if (rafId !== null) caf(rafId);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      pendingDelta = 0;
      this.driving = false;
      this.syncProxyPosition = null;
      this.proxy = null;

      content.style.position = originalContentPosition;
      content.style.top = originalContentTop;
      content.style.zIndex = originalContentZIndex;
      content.style.touchAction = originalContentTouchAction;
      content.style.overflowAnchor = originalContentOverflowAnchor;

      // Reinsert immediately before the proxy, which is precisely where the
      // content lived before attachment, then discard the private surface.
      container.insertBefore(content, proxy);
      proxy.remove();
      container.style.position = originalContainerPosition;
    };
  }

  /** Align the local surface after keyboard, scrollbar, or programmatic jumps. */
  syncPosition(): void {
    this.syncProxyPosition?.();
  }
}
