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
      axisLockThreshold: 8,
      ...options
    };

    const getHorizontalTarget = opts.getHorizontalScrollTarget;

    // Auto-fallback: if no resolver was supplied, look for a horizontally-
    // scrollable element to use as the touch swipe target. Prefer the inner
    // [data-cerious-scroll-content] (where framework wrappers put rows and
    // typically apply overflow-x: auto for wide content), then fall back to
    // the container itself.
    const resolveHorizontalTarget = (): HTMLElement | null => {
      const explicit = getHorizontalTarget?.();
      if (explicit) return explicit;
      const inner = container.querySelector<HTMLElement>('[data-cerious-scroll-content]');
      if (inner && inner.scrollWidth > inner.clientWidth) return inner;
      if (container.scrollWidth > container.clientWidth) return container;
      return null;
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
    // Velocity in the currently-locked axis (px/ms). Sign matches the
    // direction the engine/scrollLeft moves (drag finger up → positive vertical;
    // drag finger left → positive horizontal).
    let velocity = 0;
    let momentumAnimationId: number | null = null;
    let activeTouchId: number | null = null;

    // Axis-lock state. Until the gesture exceeds `axisLockThreshold` we don't
    // know whether the user intends a vertical or horizontal scroll. We
    // accumulate raw deltas from the touchstart point and lock once one
    // dimension wins, so subsequent moves are routed to the right consumer.
    let startTouchX = 0;
    let startTouchY = 0;
    let lastTouchX = 0;
    let axis: 'unknown' | 'vertical' | 'horizontal' = 'unknown';
    let horizontalTarget: HTMLElement | null = null;

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

    const getViewportHeight = () => {
      const inner = container.querySelector<HTMLElement>('[data-cerious-scroll-content]');
      const h = inner?.clientHeight ?? 0;
      return h > 0 ? h : (container.clientHeight || container.offsetHeight);
    };

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
        lastTouchX = touch.clientX;
        startTouchX = touch.clientX;
        startTouchY = touch.clientY;
        axis = 'unknown';
        horizontalTarget = resolveHorizontalTarget();
        lastTouchTime = Date.now();
        velocity = 0;
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
      const currentX = touch.clientX;
      const currentTime = Date.now();
      const deltaY = lastTouchY - currentY;
      const deltaX = lastTouchX - currentX;
      const deltaTime = currentTime - lastTouchTime;

      // Axis lock: once the gesture leaves the dead-zone, pick the dominant
      // direction and stay with it for the rest of the gesture.
      if (axis === 'unknown') {
        const totalDx = Math.abs(currentX - startTouchX);
        const totalDy = Math.abs(currentY - startTouchY);
        if (Math.max(totalDx, totalDy) >= opts.axisLockThreshold) {
          if (totalDx > totalDy && horizontalTarget) {
            axis = 'horizontal';
          } else {
            axis = 'vertical';
          }
        }
      }

      if (axis === 'horizontal' && horizontalTarget) {
        // Forward horizontal delta to the native overflow-x scroller and
        // track velocity so we can run momentum on touchend (matches the
        // iOS-style flick behavior used for vertical scrolling).
        if (deltaX !== 0) {
          horizontalTarget.scrollLeft += deltaX;
        }
        if (deltaTime > 0) {
          recordVelocitySample(deltaX / deltaTime, currentTime);
          let totalWeight = 0;
          let weightedSum = 0;
          let weight = velocityRingCount;
          for (let i = 0; i < velocityRingCount; i++) {
            const idx = (velocityRingHead - 1 - i + VELOCITY_RING_SIZE) % VELOCITY_RING_SIZE;
            const sampleTime = velocityRingTimes[idx];
            if (currentTime - sampleTime > VELOCITY_SAMPLE_MS) break;
            weightedSum += velocityRingValues[idx] * weight;
            totalWeight += weight;
            weight--;
          }
          velocity = totalWeight > 0 ? weightedSum / totalWeight : 0;
        }
        lastTouchY = currentY;
        lastTouchX = currentX;
        lastTouchTime = currentTime;
        return;
      }

      // axis === 'vertical' (or still unknown but trending vertical): run the
      // existing velocity tracking + vertical engine scroll.
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
        velocity = totalWeight > 0 ? weightedSum / totalWeight : 0;
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
      lastTouchX = currentX;
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

      const lockedAxis = axis;
      const momentumTarget = lockedAxis === 'horizontal' ? horizontalTarget : null;
      if (opts.enableMomentum && Math.abs(velocity) >= (opts.momentumThreshold ?? 0) &&
          (lockedAxis === 'vertical' || (lockedAxis === 'horizontal' && momentumTarget))) {
        // iOS-style momentum: use exponential decay with cubic-bezier easing
        const initialVelocity = velocity;
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

          const delta = currentVelocity * frameTime;

          if (lockedAxis === 'horizontal' && momentumTarget) {
            // Stop momentum once we hit a horizontal boundary so it doesn't
            // burn frames trying to scroll past the edge.
            const before = momentumTarget.scrollLeft;
            momentumTarget.scrollLeft = before + delta;
            if (momentumTarget.scrollLeft === before) {
              momentumAnimationId = null;
              return;
            }
            momentumAnimationId = requestAnimationFrame(applyMomentum);
            return;
          }

          const result = this.deps.scroll(delta, getViewportHeight());

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
    if (!(target instanceof Element)) return false;
    // Recognize both the legacy class-based selector (kept for backwards
    // compatibility) and the data-attribute used by the current
    // NativeScrollbar (strip and overlay thumb). When the touch lands on the
    // overlay thumb the controller must yield so pointer events drive the
    // custom drag handler instead of being preventDefault'd here.
    return Boolean(
      target.closest('[data-cerious-scrollbar]') ||
      target.closest('.cerious-scrollbar-container')
    );
  }
}
