/** Delta / jump / percentage → (element, offset). Side effects go through deps. */

import { ScrollResult } from '../types/index.js';
import { BoundaryGuardian } from './boundary-guardian.js';

export interface NavigationEngineDeps {
  totalElements: number;
  viewportHeight: number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
  getElementHeight: (index: number) => number;
  hasMeasuredHeight: (index: number) => boolean;
  getLastRenderedElement: () => HTMLElement | null;
  getElementViewportPosition: (index: number) => { top: number; bottom: number; isVisible: boolean };
  getCalculateScrollPercentage: () => number;
  updateScrollPosition: (element: number, offset: number) => void;
  requestDisplayUpdate: () => void;
  syncScrollbar: () => void;
  getTrueBottomPosition?: () => { element: number; offset: number } | null;
}

export class NavigationEngine {
  private totalElements: number;
  private viewportHeight: number;
  private readonly guardian: BoundaryGuardian;
  
  // Returned from scroll(); mutated in place — copy if you stash it.
  private readonly _scrollResult: ScrollResult = { element: 0, offset: 0 };

  /**
   * @param deps Camera, height, and scrollbar callbacks.
   */
  constructor(private readonly deps: NavigationEngineDeps) {
    this.totalElements = deps.totalElements;
    this.viewportHeight = deps.viewportHeight;
    this.guardian = new BoundaryGuardian({
      getViewportHeight: () => this.viewportHeight,
      getTotalElements: () => this.totalElements,
      getElementViewportPosition: deps.getElementViewportPosition,
      getElementHeight: deps.getElementHeight
    });
  }

  /**
   * @param totalElements Dataset length.
   * @param viewportHeight Usable height in pixels (header inset already subtracted).
   */
  updateConfig(totalElements: number, viewportHeight: number): void {
    this.totalElements = totalElements;
    this.viewportHeight = viewportHeight;
  }

  /**
   * Re-anchor to the bottom after a viewport size change. If growing the
   * viewport (e.g. a container resize) revealed empty space below the last
   * element, pull the scroll position up so the content stays anchored to the
   * bottom ("if I'm at the bottom, stay at the bottom on resize"). Applies a
   * full correction. Returns the corrected position, or null if none was needed
   * (i.e. not scrolled near the bottom). Does not touch the scrollbar — the
   * caller re-syncs it after.
   *
   * @param viewportHeight Usable height in pixels after the resize.
   * @returns Corrected `{ element, offset }`, or `null` if no pull was needed.
   */
  reanchorBottom(viewportHeight: number): ScrollResult | null {
    if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
      this.viewportHeight = viewportHeight;
    }
    const element = this.deps.getCurrentElement();
    const offset = this.deps.getScrollOffset();
    const correction = this.guardian.correctBottomOvershoot(element, offset, 1);
    if (!correction) return null;
    this.deps.updateScrollPosition(correction.element, correction.offset);
    this._scrollResult.element = correction.element;
    this._scrollResult.offset = correction.offset;
    return this._scrollResult;
  }

  /**
   * @param deltaY Pixels to move (positive = down).
   * @param viewportHeight Usable height in pixels.
   * @returns Camera after the move. Same object each call — copy if you stash it.
   */
  scroll(deltaY: number, viewportHeight: number): ScrollResult {
    // Validate inputs. NaN/Infinity here would propagate into offset and
    // permanently corrupt scroll state, so refuse them with a no-op result
    // returning the current position.
    if (!Number.isFinite(deltaY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      this._scrollResult.element = this.deps.getCurrentElement();
      this._scrollResult.offset = this.deps.getScrollOffset();
      return this._scrollResult;
    }

    this.viewportHeight = viewportHeight;
    let element = this.deps.getCurrentElement();
    let offset = this.deps.getScrollOffset() + deltaY;

    while (true) {
      const elementHeight = this.deps.getElementHeight(element);

      if (offset >= elementHeight && element < this.totalElements - 1) {
        offset -= elementHeight;
        element++;
        continue;
      }

      if (offset < 0 && element > 0) {
        element--;
        const prevHeight = this.deps.getElementHeight(element);
        offset = prevHeight + offset;
        continue;
      }

      break;
    }

    offset = Math.max(0, Math.min(offset, this.deps.getElementHeight(element) - 1));

    if (element >= this.totalElements - 1) {
      element = Math.max(0, this.totalElements - 1);
      const lastHeight = Math.max(1, this.deps.getElementHeight(element));
      offset = Math.max(0, Math.min(offset, lastHeight - 1));
    }

    const lastIndex = this.totalElements - 1;
    if (!this.deps.hasMeasuredHeight(lastIndex)) {
      // First frames: last row isn't measured yet. Only walk to it when it
      // could actually sit in the viewport — a full-dataset walk on every
      // pre-render scroll is O(n) for million-row lists.
      if (lastIndex - element <= 100 && deltaY > 0) {
        const lastElementPosition = this.deps.getElementViewportPosition(lastIndex);
        if (lastElementPosition.bottom <= this.viewportHeight) {
          element = this.deps.getCurrentElement();
          offset = this.deps.getScrollOffset();
        }
      }
    } else if (element <= 0) {
      element = 0;
      offset = Math.max(0, offset);
    } else {
      const elementHeight = this.deps.getElementHeight(element);
      offset = Math.max(0, Math.min(offset, elementHeight - 1));
    }

    const shouldClamp = this.guardian.shouldClamp(element);
    let positionUpdated = false;

    if (shouldClamp && deltaY > 0) {
      // If we've scrolled to or past the measured true bottom, snap to it
      // EXACTLY so the last row sits flush against the viewport bottom. The
      // damped overshoot correction below closes only a fraction of the gap per
      // call, which leaves a residual gap when a wheel/touch burst ends near the
      // bottom (most visible with a top inset / on fractional-scale displays).
      const trueBottom = this.deps.getTrueBottomPosition?.();
      const atOrPastBottom = !!trueBottom && (
        element > trueBottom.element ||
        (element === trueBottom.element && offset >= trueBottom.offset)
      );
      if (atOrPastBottom) {
        element = trueBottom!.element;
        offset = trueBottom!.offset;
        this.deps.updateScrollPosition(element, offset);
        positionUpdated = true;
      } else {
        this.deps.updateScrollPosition(element, offset);
        positionUpdated = true;
        // trueBottom already tells us we are NOT past the end. The overshoot
        // walk (getElementViewportPosition(last)) is O(distance) and a no-op
        // in this branch — skip it. Keep the walk only before the tail has
        // been measured (first frames / short content).
        if (!trueBottom) {
          const correction = this.guardian.correctBottomOvershoot(element, offset);
          if (correction) {
            element = correction.element;
            offset = correction.offset;
            this.deps.updateScrollPosition(element, offset);
          }
        }
      }
    }

    // Snap offset to integer pixels. Sub-pixel drift accumulates over many
    // small wheel/touch deltas (browsers commonly emit fractional deltaY) and
    // eventually produces visible mis-alignment with the scrollbar thumb. The
    // outer position math has already clamped against the element height so
    // rounding cannot push past the boundary here.
    offset = Math.round(offset);
    const finalHeight = Math.max(1, this.deps.getElementHeight(element));
    if (offset >= finalHeight) {
      offset = finalHeight - 1;
    }
    if (offset < 0) offset = 0;

    if (!positionUpdated) {
      this.deps.updateScrollPosition(element, offset);
    }

    this.deps.syncScrollbar();
    
    // Same _scrollResult instance every call.
    this._scrollResult.element = element;
    this._scrollResult.offset = offset;
    return this._scrollResult;
  }

  /**
   * @param percentage `0` = top, `100` = bottom. Clamped.
   * @returns Camera after the jump.
   */
  handleScrollPercentage(percentage: number): ScrollResult {
    if (!Number.isFinite(percentage)) {
      return { element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() };
    }
    const clamped = Math.max(0, Math.min(100, percentage));

    if (clamped >= 99.99) {
      this.deps.updateScrollPosition(this.totalElements - 1, 0);
      this.scroll(Number.MAX_SAFE_INTEGER, this.viewportHeight);
      // scroll() corrects the bottom overshoot with smooth damping (~0.9), which
      // leaves a fraction of the gap on a one-shot jump. Finish with a FULL
      // re-anchor so the last row lands flush against the viewport bottom.
      const anchored = this.reanchorBottom(this.viewportHeight);
      if (anchored) return anchored;
      this._scrollResult.element = this.deps.getCurrentElement();
      this._scrollResult.offset = this.deps.getScrollOffset();
      return this._scrollResult;
    }

    if (clamped <= 0.01) {
      return this.jumpToElement(0);
    }

    const targetElement = Math.floor((clamped / 100) * (this.totalElements - 1));
    const currentElement = this.deps.getCurrentElement();

    if (targetElement === currentElement) {
      return { element: currentElement, offset: this.deps.getScrollOffset() };
    }

    const elementDelta = targetElement - currentElement;
    const estimatedHeight = this.deps.getElementHeight(currentElement);
    const approximatePixelDelta = elementDelta * estimatedHeight;
    return this.scroll(approximatePixelDelta, this.viewportHeight);
  }

  /**
   * @param elementIndex Target index. Clamped. `Number.MAX_SAFE_INTEGER` = end.
   * @returns Camera after the jump (offset 0, or true-bottom if past the last visible row).
   */
  jumpToElement(elementIndex: number): ScrollResult {
    // Validate input - non-finite values are programmer errors that would
    // otherwise silently no-op.
    if (!Number.isFinite(elementIndex)) {
      return { element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() };
    }

    // Clamp instead of silently returning current position; surface the clamp
    // so consumers can detect bad indices in development.
    const total = this.totalElements;
    if (total <= 0) {
      return { element: 0, offset: 0 };
    }
    const target = Math.max(0, Math.min(Math.floor(elementIndex), total - 1));
    if (target !== elementIndex && elementIndex !== Number.MAX_SAFE_INTEGER) {
      // MAX_SAFE_INTEGER is the documented "jump to end" sentinel used by the
      // keyboard controller, so suppress the warning for that case only.
      console.warn(
        `CeriousScroll.jumpToElement: index ${elementIndex} out of range (0..${total - 1}); clamped to ${target}`
      );
    }

    const trueBottom = this.deps.getTrueBottomPosition?.();
    if (trueBottom && target >= trueBottom.element) {
      this.deps.updateScrollPosition(trueBottom.element, trueBottom.offset);
      this.deps.requestDisplayUpdate();
      this.deps.syncScrollbar();
      return { element: trueBottom.element, offset: trueBottom.offset };
    }

    this.deps.updateScrollPosition(target, 0);
    this.deps.requestDisplayUpdate();
    this.deps.syncScrollbar();
    return { element: target, offset: 0 };
  }

  /**
   * @param elementIndex Target index. Clamped.
   * @param offset Pixels into that row. Clamped to `[0, height - 1]`.
   * @param skipScrollbarSync When true, do not write the native strip (thumb-drag path).
   * @returns Camera after the jump.
   */
  jumpToPosition(elementIndex: number, offset: number, skipScrollbarSync = false): ScrollResult {
    if (!Number.isFinite(elementIndex) || !Number.isFinite(offset)) {
      return { element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() };
    }
    let element = Math.max(0, Math.min(Math.floor(elementIndex), this.totalElements - 1));
    const elementHeight = Math.max(1, this.deps.getElementHeight(element));
    // Snap to integer pixels for consistency with scroll(); see comment there.
    let clampedOffset = Math.max(0, Math.min(Math.round(offset), elementHeight - 1));

    this.deps.updateScrollPosition(element, clampedOffset);
    this.deps.requestDisplayUpdate();

    if (this.guardian.shouldClamp(element)) {
      this.deps.requestDisplayUpdate();
      const correction = this.guardian.correctBottomOvershoot(element, clampedOffset);
      if (correction) {
        element = correction.element;
        clampedOffset = correction.offset;
        this.deps.updateScrollPosition(element, clampedOffset);
        this.deps.requestDisplayUpdate();
      }
    }

    if (!skipScrollbarSync) {
      this.deps.syncScrollbar();
    }

    return { element, offset: clampedOffset };
  }

  /** Camera to element 0, offset 0. */
  reset(): void {
    this.deps.updateScrollPosition(0, 0);
    this.deps.requestDisplayUpdate();
    this.deps.syncScrollbar();
  }
}
