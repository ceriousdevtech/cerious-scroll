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

    // Velocity tracking via fixed-size ring buffer to avoid Array.shift() in
    // the hot touchmove path (O(n) per move) and unbounded growth on slow
    // devices.
    const VELOCITY_SAMPLE_MS = 100; // Track last 100ms of movement
    const VELOCITY_RING_SIZE = 16;  // Plenty for 100ms even at 240Hz
    const velocityRingValues = new Float64Array(VELOCITY_RING_SIZE);
    const velocityRingTimes = new Float64Array(VELOCITY_RING_SIZE);
    let velocityRingHead = 0;       // Next write position
    let velocityRingCount = 0;      // Number of valid samples (<= ring size)

    const resetVelocityHistory = () => {
      velocityRingHead = 0;
      velocityRingCount = 0;
    };
    const recordVelocitySample = (velocity: number, time: number) => {
      velocityRingValues[velocityRingHead] = velocity;
      velocityRingTimes[velocityRingHead] = time;
      velocityRingHead = (velocityRingHead + 1) % VELOCITY_RING_SIZE;
      if (velocityRingCount < VELOCITY_RING_SIZE) velocityRingCount++;
    };

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
        resetVelocityHistory();
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
        const instantVelocity = deltaY / deltaTime;

        // Record into ring buffer (O(1)).
        recordVelocitySample(instantVelocity, currentTime);

        // Compute time-weighted average over the trailing window. We iterate
        // newest-to-oldest (so we can early-exit when samples fall outside
        // the window) and weight by recency.
        let totalWeight = 0;
        let weightedSum = 0;
        let weight = velocityRingCount; // newest gets highest weight
        for (let i = 0; i < velocityRingCount; i++) {
          const idx = (velocityRingHead - 1 - i + VELOCITY_RING_SIZE) % VELOCITY_RING_SIZE;
          const sampleTime = velocityRingTimes[idx];
          if (currentTime - sampleTime > VELOCITY_SAMPLE_MS) break;
          weightedSum += velocityRingValues[idx] * weight;
          totalWeight += weight;
          weight--;
        }
        velocityY = totalWeight > 0 ? weightedSum / totalWeight : 0;
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
        // iOS-style momentum: use exponential decay with cubic-bezier easing
        const initialVelocity = velocityY;
        const startTime = performance.now();
        let lastFrameTime = startTime;
        
        // Momentum duration scales with initial velocity (faster swipe = longer momentum)
        const maxDuration = 2000; // Maximum 2 seconds of momentum
        const minDuration = 300;  // Minimum 300ms
        const duration = Math.min(maxDuration, minDuration + Math.abs(initialVelocity) * 200);

        const applyMomentum = () => {
          const now = performance.now();
          const elapsed = now - startTime;
          const progress = Math.min(elapsed / duration, 1);
          
          // Cubic-bezier easing out (0.25, 0.46, 0.45, 0.94) - iOS-like deceleration
          const easeOutCubic = (t: number): number => {
            const t1 = t - 1;
            return t1 * t1 * t1 + 1;
          };
          
          // Apply easing - velocity decreases smoothly following the curve
          const easedProgress = easeOutCubic(progress);
          const remainingVelocity = 1 - easedProgress;
          const currentVelocity = initialVelocity * remainingVelocity;

          if (progress >= 1 || Math.abs(currentVelocity) < 0.01) {
            momentumAnimationId = null;
            return;
          }

          // Use the actual time since the last frame so momentum stays
          // visually consistent across 60Hz / 120Hz / 240Hz displays and
          // under main-thread contention. Clamp to a sane range to avoid
          // huge first-frame deltas after long pauses.
          const rawFrameTime = now - lastFrameTime;
          const frameTime = rawFrameTime > 0 && rawFrameTime < 100 ? rawFrameTime : 16;
          lastFrameTime = now;

          const deltaY = currentVelocity * frameTime;
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
