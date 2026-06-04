/**
 * @fileoverview Wheel interaction controller for CeriousScroll
 *
 * Normalizes wheel input handling and DOM event dispatching to keep the
 * main CeriousScroll class slim.
 */

import { ScrollResult, WheelNavigationOptions } from '../types/index.js';

interface WheelControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

type WheelInputType = 'trackpad' | 'wheel';

/**
 * Walk from `start` up to (but not past) `root`, returning the first element
 * whose computed `overflow-x` is `auto` or `scroll` and that actually overflows
 * horizontally. Used to find which element should receive a horizontal wheel
 * delta when the marked content node isn't itself the scrollable one.
 */
function findHorizontalScrollTarget(start: HTMLElement, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = start;
  const stop = root.parentElement;
  while (el && el !== stop) {
    if (el.scrollWidth > el.clientWidth) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Heuristic classifier for distinguishing trackpad / free-scroll-mouse
 * gestures from ratcheted mouse-wheel notches. No browser API gives this
 * directly; we look at deltaMode, deltaY magnitude, and a short rolling
 * window of recent events.
 *
 * Rules (checked in order):
 *  1. Any horizontal component in the recent window  -> trackpad (mice rarely
 *     produce deltaX; trackpads do constantly).
 *  2. deltaMode != PIXEL (line/page units)           -> wheel (only mice emit
 *     non-pixel deltas in modern browsers).
 *  3. >= 5 events in the 120ms window                -> continuous input
 *     (trackpad OR free-scroll mouse wheel like the G502X). These have OS
 *     or hardware momentum already; layering our easing produces delayed
 *     overscroll, so treat as 'trackpad' (immediate-apply).
 *  4. Isolated event (only one in window)            -> wheel. A trackpad
 *     gesture cannot produce a single event in 120ms; it always streams.
 *     This catches small ratcheted notches (deltaY 30-50) that would
 *     otherwise fall through every magnitude check.
 *  5. |deltaY| >= 80                                 -> wheel (a single big
 *     ratcheted notch).
 *  6. Several small (<40px) deltas in the window     -> trackpad.
 *  7. Fallback                                       -> trackpad (safer to
 *     skip custom smoothing than to layer it on top of OS momentum).
 */
class WheelClassifier {
  private recent: { time: number; deltaX: number; deltaY: number }[] = [];

  classify(e: WheelEvent): WheelInputType {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.recent.push({ time: now, deltaX: e.deltaX, deltaY: e.deltaY });
    // Keep only events from the last 120ms.
    const cutoff = now - 120;
    while (this.recent.length > 0 && this.recent[0].time < cutoff) {
      this.recent.shift();
    }

    const absY = Math.abs(e.deltaY);
    const hasHorizontal = this.recent.some(x => Math.abs(x.deltaX) > 0);
    const smallDeltaCount = this.recent.reduce(
      (n, x) => n + (Math.abs(x.deltaY) > 0 && Math.abs(x.deltaY) < 40 ? 1 : 0),
      0,
    );

    if (hasHorizontal) return 'trackpad';
    if (e.deltaMode !== 0 /* DOM_DELTA_PIXEL */) return 'wheel';
    // Continuous high-rate input: trackpad or free-scroll mouse (e.g. Logitech
    // G502X with the wheel unlocked). Catch this BEFORE the magnitude check —
    // a fast free-spin can produce |deltaY| > 80 per event, which would
    // otherwise misclassify as a ratchet notch.
    if (this.recent.length >= 5) return 'trackpad';
    // Isolated event: trackpads always stream multiple events in 120ms,
    // so a single event in the window is a ratchet notch. This catches
    // small notches (Logitech mice often emit deltaY ~ 30-50) that would
    // otherwise fail the magnitude check below.
    if (this.recent.length === 1) return 'wheel';
    if (absY >= 80) return 'wheel';
    if (this.recent.length >= 4 && smallDeltaCount >= 3) return 'trackpad';
    return 'trackpad';
  }
}

export class WheelController {
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

  constructor(private readonly deps: WheelControllerDeps) {}

  attach(
    container: HTMLElement,
    onScroll?: (result: ScrollResult) => void,
    wheelOptions?: WheelNavigationOptions
  ): () => void {
    const options: Required<Pick<WheelNavigationOptions, 'enabled' | 'emitViewportChangeEvent' | 'coalesceViewportChangeEvent' | 'smooth' | 'smoothFactor' | 'wheelBehavior'>> = {
      enabled: wheelOptions?.enabled !== false,
      emitViewportChangeEvent: wheelOptions?.emitViewportChangeEvent !== false,
      coalesceViewportChangeEvent: wheelOptions?.coalesceViewportChangeEvent === true,
      smooth: wheelOptions?.smooth !== false,
      smoothFactor: typeof wheelOptions?.smoothFactor === 'number' && wheelOptions.smoothFactor > 0 && wheelOptions.smoothFactor <= 1
        ? wheelOptions.smoothFactor
        : 0.22,
      // wheelBehavior takes precedence; if unset, derive from legacy `smooth`.
      wheelBehavior: wheelOptions?.wheelBehavior
        ?? (wheelOptions?.smooth === false ? 'immediate' : 'auto'),
    };

    if (!options.enabled) {
      return () => {};
    }

    const classifier = new WheelClassifier();

    let rafId: number | null = null;
    let pendingPercentage = 0;
    let pendingCurrentElement = 0;
    let pendingScrollOffset = 0;
    let pendingResult: ScrollResult = { element: 0, offset: 0 };

    const dispatchViewportChange = () => {
      rafId = null;
      if (!options.emitViewportChangeEvent) return;

      // GC optimization: Reuse event detail object instead of creating new one
      this._eventDetail.percentage = pendingPercentage;
      this._eventDetail.currentElement = pendingCurrentElement;
      this._eventDetail.scrollOffset = pendingScrollOffset;
      this._eventDetail.result = pendingResult;

      container.dispatchEvent(
        new CustomEvent('cerious-viewport-change', {
          detail: this._eventDetail,
        })
      );
    };

    const handleWheel = (event: WheelEvent) => {
      // Resolve the inner content element once per event. Framework wrappers
      // (Vue/React/Angular) put rows into [data-cerious-scroll-content] and
      // that's where overflow-x: auto lives for wide content (e.g.
      // spreadsheet). When present, horizontal wheel deltas are forwarded
      // to whichever element actually owns the horizontal scroll so trackpad
      // two-finger sideways and shift+wheel work; if the gesture is
      // dominantly horizontal we skip the vertical engine scroll. We also
      // use the inner element's clientHeight as the viewport so the engine
      // accounts for the h-scrollbar gutter.
      const inner = container.querySelector<HTMLElement>('[data-cerious-scroll-content]');
      const dx = event.deltaX;
      const dy = event.deltaY;
      // Find the nearest ancestor (starting from the inner content node, or
      // the container if no inner exists) that actually has horizontal
      // overflow scrolling. Some demos put overflow-x:auto on
      // [data-cerious-scroll-content] directly (comparison, wrappers); others
      // put it on an ancestor with [data-cerious-scroll-content] as a
      // non-scrolling child (standalone grid/sql demos). Walking the chain
      // handles both layouts.
      const hTarget = findHorizontalScrollTarget(inner ?? container, container);
      if (hTarget && dx !== 0) {
        hTarget.scrollLeft += dx;
        if (Math.abs(dx) > Math.abs(dy)) {
          event.preventDefault();
          return;
        }
      }

      event.preventDefault();

      const innerH = inner?.clientHeight ?? 0;
      const viewportHeight = innerH > 0 ? innerH : (container.clientHeight || container.offsetHeight);

      // Decide whether to smooth this event. Trackpads have OS-level momentum
      // already, so layering our easing on top causes delayed overscroll and
      // a "sluggish" feel; apply trackpad deltas synchronously. Mouse-wheel
      // notches land as single large events that snap when applied raw, so
      // they benefit from our easing.
      let smoothThisEvent: boolean;
      if (options.wheelBehavior === 'immediate') {
        smoothThisEvent = false;
      } else if (options.wheelBehavior === 'smooth') {
        smoothThisEvent = true;
      } else {
        smoothThisEvent = classifier.classify(event) === 'wheel';
      }

      if (!smoothThisEvent) {
        // Cancel any in-flight smooth animation so a trackpad gesture
        // arriving mid-flight isn't stacked on top of leftover momentum.
        if (smoothRafId != null) {
          cancelAnimationFrame(smoothRafId);
          smoothRafId = null;
          targetDy = 0;
          animatedDy = 0;
          animFromDy = 0;
        }
        const result = this.deps.scroll(dy, viewportHeight);
        emitChange(result);
        onScroll?.(result);
        return;
      }

      // Smooth path: queue the delta into an animated easeOut from
      // `animatedDy` toward `targetDy`. A mouse wheel notch lands as one
      // large event (often ~100px). Applying it instantly is one
      // browser-paint frame, which reads as a snap. Spreading the same
      // distance across ~120ms with easeOutCubic matches the perceived
      // smoothness of native overflow scrolling. New events extend the
      // target so fast spinning compounds momentum.
      //
      // Boundary short-circuit: if the engine is already pinned at the
      // edge and the new delta pushes further into that edge, drop it
      // immediately. Without this, queued no-op deltas accumulate during
      // hold-at-boundary and cause a visible delay/jump when the user
      // reverses direction.
      const atTop = this.deps.getCurrentElement() === 0 && this.deps.getScrollOffset() === 0;
      if (atTop && dy < 0 && targetDy <= 0) {
        return;
      }

      targetDy += dy;
      smoothViewportHeight = viewportHeight;
      // Adaptive duration: a single notch eases over SMOOTH_DURATION_MS,
      // but fast spinning piles many notches into the queue. Without
      // shortening the ease, the long tail keeps animating after the
      // user stops the wheel ("ghost scroll"). Scale the duration down
      // toward SMOOTH_DURATION_MIN_MS as the pending distance grows past
      // a notch, so fast input flushes quickly while a slow tap still
      // feels smooth — and total distance is never capped (unlike a hard
      // queue limit, which made fast scrolls cover LESS than medium ones).
      const pending = Math.abs(targetDy - animatedDy);
      const NOTCH = 100;
      const scale = Math.max(SMOOTH_DURATION_MIN_MS / SMOOTH_DURATION_MS, NOTCH / Math.max(NOTCH, pending));
      animDuration = SMOOTH_DURATION_MS * scale;
      // Reset the timeline when a fresh gesture starts (queue cleared or
      // reversed direction), so a new notch always animates a full
      // duration instead of finishing in 1-2 frames.
      const now = performance.now();
      if (smoothRafId == null) {
        animStart = now;
        animFromDy = 0;
        animatedDy = 0;
        smoothRafId = requestAnimationFrame(animateSmoothScroll);
      } else {
        // Re-base on remaining distance so easing restarts smoothly from
        // current position toward the new target.
        animStart = now;
        animFromDy = animatedDy;
      }
    };

    let targetDy = 0;        // total accumulated wheel distance (px)
    let animatedDy = 0;      // amount already applied to engine
    let animFromDy = 0;      // animation start position
    let animStart = 0;       // timestamp animation started/restarted
    let animDuration = 150;  // current ease duration (adaptive, see below)
    const SMOOTH_DURATION_MS = 150;
    const SMOOTH_DURATION_MIN_MS = 40;
    let smoothViewportHeight = 0;
    let smoothRafId: number | null = null;

    const emitChange = (result: ScrollResult) => {
      if (options.emitViewportChangeEvent) {
        if (options.coalesceViewportChangeEvent) {
          pendingPercentage = this.deps.calculateScrollPercentage();
          pendingCurrentElement = this.deps.getCurrentElement();
          pendingScrollOffset = this.deps.getScrollOffset();
          pendingResult = result;
          if (rafId == null) {
            rafId = requestAnimationFrame(dispatchViewportChange);
          }
        } else {
          this._eventDetail.percentage = this.deps.calculateScrollPercentage();
          this._eventDetail.currentElement = this.deps.getCurrentElement();
          this._eventDetail.scrollOffset = this.deps.getScrollOffset();
          this._eventDetail.result = result;
          container.dispatchEvent(
            new CustomEvent('cerious-viewport-change', {
              detail: this._eventDetail,
            })
          );
        }
      }
    };

    const animateSmoothScroll = () => {
      smoothRafId = null;
      const elapsed = performance.now() - animStart;
      const t = Math.min(1, elapsed / animDuration);
      // When pending distance is large (fast/continuous spinning) use a
      // LINEAR curve so motion stays constant-velocity — easeOut would
      // re-front-load every time a new wheel event re-bases the ease,
      // producing visible "skip on each notch" stutter. For a small
      // single-notch motion easeOutQuad still gives the gentle settle
      // that reads as smooth.
      const linearBlend = Math.min(1, Math.abs(targetDy - animFromDy) / 400);
      const easedQuad = 1 - (1 - t) * (1 - t);
      const eased = easedQuad + (t - easedQuad) * linearBlend;
      const desiredDy = animFromDy + (targetDy - animFromDy) * eased;
      let step = desiredDy - animatedDy;

      if (t >= 1) {
        // Finish exactly on target to avoid sub-pixel residual.
        step = targetDy - animatedDy;
      }

      // Round step to whole pixels. The tail of the easing curve produces
      // tiny per-frame deltas (sub-pixel); Math.floor/ceil there would
      // strand most frames at 0 then land a 1-px correction, which reads
      // as a jitter just before the animation completes. Math.round keeps
      // the motion monotonic.
      const intStep = Math.round(step);
      if (intStep !== 0) {
        const prevElement = this.deps.getCurrentElement();
        const prevOffset = this.deps.getScrollOffset();
        const result = this.deps.scroll(intStep, smoothViewportHeight);
        animatedDy += intStep;
        emitChange(result);
        onScroll?.(result);

        // Boundary clamp: engine refused to move → wipe the queue so the
        // next wheel event (possibly in the reverse direction) starts from
        // a clean baseline instead of replaying a residual animation.
        if (
          this.deps.getCurrentElement() === prevElement &&
          this.deps.getScrollOffset() === prevOffset
        ) {
          targetDy = 0;
          animatedDy = 0;
          animFromDy = 0;
          return;
        }
      }

      if (t < 1 || animatedDy !== targetDy) {
        smoothRafId = requestAnimationFrame(animateSmoothScroll);
      } else {
        // Animation complete: reset the queue.
        targetDy = 0;
        animatedDy = 0;
        animFromDy = 0;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (smoothRafId != null) {
        cancelAnimationFrame(smoothRafId);
        smoothRafId = null;
      }
      targetDy = 0;
      animatedDy = 0;
      animFromDy = 0;
      container.removeEventListener('wheel', handleWheel);
    };
  }
}