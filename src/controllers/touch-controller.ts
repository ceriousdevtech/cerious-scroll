/**
 * @fileoverview Touch interaction controller for CeriousScroll
 *
 * Handles touch gesture translation, including optional momentum scrolling,
 * so that CeriousScroll can remain focused on data/state orchestration.
 */

import { ScrollResult, TouchNavigationOptions } from '../types/index.js';

interface TouchControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

export class TouchController {
  // GC optimization: Reuse event detail object to avoid allocations
  private readonly _eventDetail: {
    percentage: number;
    currentElement: number;
    scrollOffset: number;
    result: ScrollResult;
  } = {
    percentage: 0,
    currentElement: 0,
    scrollOffset: 0,
    result: { element: 0, offset: 0 }
  };

  constructor(private readonly deps: TouchControllerDeps) {}

  attach(
    container: HTMLElement,
    onScroll?: (result: ScrollResult) => void,
    options?: TouchNavigationOptions
  ): () => void {
    const opts = {
      enableMomentum: true,
      momentumFriction: 0.95,
      momentumThreshold: 0.1,
      ...options
    };

    const originalTouchAction = container.style.touchAction;
    const styleId = 'cerious-touch-action-style';
    let addedStyleElement: HTMLStyleElement | null = null;

    if (!document.getElementById(styleId)) {
      addedStyleElement = document.createElement('style');
      addedStyleElement.id = styleId;
      addedStyleElement.textContent = `
        [data-cerious-touch] * {
          touch-action: none !important;
        }
      `;
      document.head.appendChild(addedStyleElement);
    }

    container.style.touchAction = 'none';
    container.setAttribute('data-cerious-touch', 'true');

    let lastTouchY = 0;
    let lastTouchTime = 0;
    let velocityY = 0;
    let momentumAnimationId: number | null = null;
    let activeTouchId: number | null = null;

    const getViewportHeight = () => container.clientHeight || container.offsetHeight;

    const handleTouchStart = (event: TouchEvent) => {
      if (this.isScrollbarTouch(event.target)) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      if (momentumAnimationId !== null) {
        cancelAnimationFrame(momentumAnimationId);
        momentumAnimationId = null;
      }

      if (activeTouchId === null && event.touches.length > 0) {
        const touch = event.touches[0];
        activeTouchId = touch.identifier;
        lastTouchY = touch.clientY;
        lastTouchTime = Date.now();
        velocityY = 0;
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (this.isScrollbarTouch(event.target)) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      let touch: Touch | null = null;
      for (let i = 0; i < event.touches.length; i++) {
        if (event.touches[i].identifier === activeTouchId) {
          touch = event.touches[i];
          break;
        }
      }

      if (!touch) {
        return;
      }

      const currentY = touch.clientY;
      const currentTime = Date.now();
      const deltaY = lastTouchY - currentY;
      const deltaTime = currentTime - lastTouchTime;

      if (deltaTime > 0) {
        velocityY = deltaY / deltaTime;
      }

      if (Math.abs(deltaY) > 0) {
        const result = this.deps.scroll(deltaY, getViewportHeight());
        // GC optimization: Reuse event detail object instead of creating new one
        this._eventDetail.percentage = this.deps.calculateScrollPercentage();
        this._eventDetail.currentElement = this.deps.getCurrentElement();
        this._eventDetail.scrollOffset = this.deps.getScrollOffset();
        this._eventDetail.result = result;

        container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
          detail: this._eventDetail
        }));
        onScroll?.(result);
      }

      lastTouchY = currentY;
      lastTouchTime = currentTime;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (this.isScrollbarTouch(event.target)) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      let isTrackedTouchEnding = false;
      for (let i = 0; i < event.changedTouches.length; i++) {
        if (event.changedTouches[i].identifier === activeTouchId) {
          isTrackedTouchEnding = true;
          break;
        }
      }

      if (!isTrackedTouchEnding) {
        return;
      }

      if ('releasePointerCapture' in container && (event as any).pointerId !== undefined) {
        try {
          container.releasePointerCapture((event as any).pointerId);
        } catch {
          // Ignore release failures (already released or not captured)
        }
      }

      activeTouchId = null;
      onScroll?.({ element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() });

      if (opts.enableMomentum && Math.abs(velocityY) >= (opts.momentumThreshold ?? 0)) {
        let currentVelocity = velocityY;

        const applyMomentum = () => {
          currentVelocity *= opts.momentumFriction ?? 0.95;

          if (Math.abs(currentVelocity) < 0.01) {
            momentumAnimationId = null;
            return;
          }

          const deltaY = currentVelocity * 16;
          const result = this.deps.scroll(deltaY, getViewportHeight());

          // GC optimization: Reuse event detail object instead of creating new one
          this._eventDetail.percentage = this.deps.calculateScrollPercentage();
          this._eventDetail.currentElement = this.deps.getCurrentElement();
          this._eventDetail.scrollOffset = this.deps.getScrollOffset();
          this._eventDetail.result = result;

          container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
            detail: this._eventDetail
          }));

          onScroll?.(result);
          momentumAnimationId = requestAnimationFrame(applyMomentum);
        };

        momentumAnimationId = requestAnimationFrame(applyMomentum);
      }
    };

    const handleTouchCancel = () => {
      activeTouchId = null;
      onScroll?.({ element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() });

      if (momentumAnimationId !== null) {
        cancelAnimationFrame(momentumAnimationId);
        momentumAnimationId = null;
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: false, capture: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart, true);
      container.removeEventListener('touchmove', handleTouchMove, true);
      container.removeEventListener('touchend', handleTouchEnd, true);
      container.removeEventListener('touchcancel', handleTouchCancel, true);

      if (momentumAnimationId !== null) {
        cancelAnimationFrame(momentumAnimationId);
        momentumAnimationId = null;
      }

      container.style.touchAction = originalTouchAction;
      container.removeAttribute('data-cerious-touch');

      if (addedStyleElement) {
        addedStyleElement.remove();
      }
    };
  }

  private isScrollbarTouch(target: EventTarget | null): boolean {
    return Boolean(
      target instanceof HTMLElement && (
        target.classList.contains('cerious-scrollbar-container') ||
        target.closest('.cerious-scrollbar-container')
      )
    );
  }
}
