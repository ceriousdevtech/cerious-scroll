/**
 * @fileoverview Wheel interaction controller for CeriousScroll
 *
 * Normalizes wheel input handling and DOM event dispatching to keep the
 * main CeriousScroll class slim.
 */

import { ScrollResult, WheelNavigationOptions } from '../types/index.js';

/**
 * Minimum per-event pixel delta we treat as a discrete mouse-wheel notch.
 * Mouse wheels emit large, quantized steps (commonly ~100-120px/notch);
 * trackpads emit small, high-frequency, often fractional pixel deltas.
 */
const MOUSE_WHEEL_NOTCH_MIN_PX = 100;

/**
 * Heuristic: is this wheel event from a trackpad (continuous, inertial) rather
 * than a discrete mouse-wheel notch? There is no definitive browser API, so we
 * classify by the *magnitude* of the pixel delta:
 *
 * - `deltaMode` of line/page granularity is always a mouse wheel.
 * - In pixel mode, only SMALL deltas are trackpad-like (worth easing); a large
 *   step is a wheel notch and must apply instantly, like the OS.
 *
 * Magnitude is checked first on purpose: some mice (free-spin / "hyperscroll"
 * wheels) emit large *fractional* pixel deltas, so a fractional value is NOT a
 * reliable trackpad signal — a 500px step is a wheel notch whether or not it is
 * a round number. Inertial smoothing must only apply to trackpads; a mouse wheel
 * that keeps gliding after the user stops feels wrong, so we err toward "wheel".
 */
function isLikelyTrackpad(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return false;                 // DOM_DELTA_LINE / _PAGE => wheel
  return Math.abs(e.deltaY) < MOUSE_WHEEL_NOTCH_MIN_PX; // small px => trackpad, large => wheel
}

interface WheelControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
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
    const options: Required<Pick<WheelNavigationOptions, 'enabled' | 'emitViewportChangeEvent' | 'coalesceViewportChangeEvent' | 'smooth' | 'smoothFactor'>> = {
      enabled: wheelOptions?.enabled !== false,
      emitViewportChangeEvent: wheelOptions?.emitViewportChangeEvent !== false,
      coalesceViewportChangeEvent: wheelOptions?.coalesceViewportChangeEvent === true,
      smooth: wheelOptions?.smooth !== false,
      smoothFactor: typeof wheelOptions?.smoothFactor === 'number' && wheelOptions.smoothFactor > 0 && wheelOptions.smoothFactor <= 1
        ? wheelOptions.smoothFactor
        : 0.22,
    };

    if (!options.enabled) {
      return () => {};
    }

    let rafId: number | null = null;
    let pendingPercentage = 0;
    let pendingCurrentElement = 0;
    let pendingScrollOffset = 0;
    let pendingResult: ScrollResult = { element: 0, offset: 0 };
    let cachedInner: HTMLElement | null = null;

    const getInner = (): HTMLElement | null => {
      if (cachedInner && cachedInner.isConnected) return cachedInner;
      cachedInner = container.querySelector<HTMLElement>('[data-cerious-scroll-content]');
      return cachedInner;
    };

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
      // Resolve the inner content element once per gesture. Framework wrappers
      // (Vue/React/Angular) put rows into [data-cerious-scroll-content] and
      // that's where overflow-x: auto lives for wide content (e.g.
      // spreadsheet). When present, horizontal wheel deltas are forwarded
      // to its scrollLeft so trackpad two-finger sideways and shift+wheel
      // work; if the gesture is dominantly horizontal we skip the vertical
      // engine scroll. We also use the inner element's clientHeight as the
      // viewport so the engine accounts for the h-scrollbar gutter.
      const inner = getInner();
      const dx = event.deltaX;
      const dy = event.deltaY;
      const hTarget: HTMLElement =
        inner && inner.scrollWidth > inner.clientWidth
          ? inner
          : (container.scrollWidth > container.clientWidth ? container : null!) as HTMLElement;
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

      // Apply inertial smoothing ONLY to trackpad input. Discrete mouse-wheel
      // notches go through the instant path so they stop the moment the wheel
      // stops — matching native OS behavior — even when `smooth` is enabled.
      if (!options.smooth || !isLikelyTrackpad(event)) {
        const result = this.deps.scroll(dy, viewportHeight);
        emitChange(result);
        onScroll?.(result);
        return;
      }

      // Smooth path: accumulate the delta into `targetDy` and let the
      // animation loop ease `smoothedDy` toward it (see the loop below). A
      // wheel notch arrives as one large event (~100px); applying it in a
      // single paint reads as a snap, so we spread it over a short exponential
      // follow that matches the feel of native inertial scrolling. Continuous
      // spinning or trackpad flicking simply keeps growing the target, and the
      // follow tracks it without stalling mid-gesture or hopping at the end.
      //
      // Boundary short-circuit: if the engine is already pinned at the top and
      // the delta pushes further up, drop it so held-at-edge input can't build
      // a queue that lurches when the user reverses direction.
      const atTop = this.deps.getCurrentElement() === 0 && this.deps.getScrollOffset() === 0;
      if (atTop && dy < 0 && targetDy <= 0) {
        return;
      }

      targetDy += dy;
      smoothViewportHeight = viewportHeight;
      // Start the loop on a fresh gesture. Seed `lastFrameTime` to now so the
      // first frame's dt is the real inter-frame gap (not a huge value), and
      // deliberately do NOT touch the clock on subsequent events — that is what
      // lets continuous input accumulate without resetting the follow's
      // progress (the old timeline reset stalled motion until input stopped,
      // then released it as one burst).
      if (smoothRafId == null) {
        lastFrameTime = performance.now();
        smoothRafId = requestAnimationFrame(animateSmoothScroll);
      }
    };

    // Smooth-scroll state. We model the rendered position as a value that
    // exponentially chases an accumulating target — the principle behind native
    // inertial scrolling: each frame closes a fixed fraction of the remaining
    // gap, scaled by real elapsed time so the feel is frame-rate independent.
    // New deltas grow the target without resetting any clock, so continuous
    // input tracks closely and, when input stops, the position eases onto the
    // target and snaps the sub-pixel remainder — no end-of-scroll jump.
    let targetDy = 0;          // accumulated wheel distance to cover (float px)
    let smoothedDy = 0;        // current eased position (float px)
    let emittedDy = 0;         // whole px already handed to the engine
    let lastFrameTime = 0;     // timestamp of the previous animation frame
    let smoothViewportHeight = 0;
    let smoothRafId: number | null = null;

    const FRAME_MS = 1000 / 60;
    // Time constant (ms) of the exponential follow, derived from the public
    // `smoothFactor` (treated as its 60fps-equivalent per-frame catch-up
    // fraction) so the option keeps its meaning while motion stays frame-rate
    // independent. smoothFactor >= 1 ⇒ tau 0 ⇒ instant follow.
    const tau =
      options.smoothFactor >= 1 ? 0 : -FRAME_MS / Math.log(1 - options.smoothFactor);
    // Below this remaining gap the motion is visually complete: snap and stop
    // so the exponential tail can't dribble sub-pixel steps for hundreds of ms.
    const SETTLE_PX = 0.5;
    // Clamp the per-frame timestep so returning to a backgrounded tab (a single
    // huge dt) can't collapse the whole glide into one jump.
    const MAX_FRAME_MS = 50;

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

      const now = performance.now();
      let dt = now - lastFrameTime;
      lastFrameTime = now;
      if (!(dt > 0)) dt = FRAME_MS;          // first frame / clock anomalies
      if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;

      const gap = targetDy - smoothedDy;
      // Frame-rate-independent exponential approach: close `alpha` of the gap
      // this frame, where alpha rises toward 1 with elapsed time. Fast input
      // keeps the gap large so steps stay big (tracks the finger/notch); when
      // input stops the gap decays smoothly to zero.
      if (Math.abs(gap) <= SETTLE_PX) {
        smoothedDy = targetDy;               // snap the imperceptible remainder
      } else {
        const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
        smoothedDy += gap * alpha;
      }

      // Hand the engine the whole-pixel delta accumulated since the last frame.
      // Math.round (not floor/ceil) keeps the tail monotonic instead of
      // stranding frames at 0 then landing a 1px correction.
      const intStep = Math.round(smoothedDy) - emittedDy;
      if (intStep !== 0) {
        const prevElement = this.deps.getCurrentElement();
        const prevOffset = this.deps.getScrollOffset();
        const result = this.deps.scroll(intStep, smoothViewportHeight);
        emittedDy += intStep;
        emitChange(result);
        onScroll?.(result);

        // Boundary clamp: the engine refused to move (pinned at an edge), so
        // wipe the gesture. A residual target would otherwise keep replaying
        // against the edge and then lurch when the user reverses direction.
        if (
          this.deps.getCurrentElement() === prevElement &&
          this.deps.getScrollOffset() === prevOffset
        ) {
          targetDy = 0;
          smoothedDy = 0;
          emittedDy = 0;
          return; // loop stops; the next wheel event restarts it
        }
      }

      if (Math.abs(targetDy - smoothedDy) > SETTLE_PX) {
        smoothRafId = requestAnimationFrame(animateSmoothScroll);
      } else {
        // Settled on target — reset the gesture baseline for the next one.
        targetDy = 0;
        smoothedDy = 0;
        emittedDy = 0;
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
      smoothedDy = 0;
      emittedDy = 0;
      container.removeEventListener('wheel', handleWheel);
    };
  }
}