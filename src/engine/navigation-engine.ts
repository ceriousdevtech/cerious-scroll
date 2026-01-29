/**
 * @fileoverview NavigationEngine delegates scroll math and position changes.
 */

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
  
  // GC optimization: Reuse ScrollResult object to avoid allocations during scroll
  private readonly _scrollResult: ScrollResult = { element: 0, offset: 0 };

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

  updateConfig(totalElements: number, viewportHeight: number): void {
    this.totalElements = totalElements;
    this.viewportHeight = viewportHeight;
  }

  scroll(deltaY: number, viewportHeight: number): ScrollResult {
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

    const lastRenderedElement = this.deps.getLastRenderedElement();
    if (!lastRenderedElement) {
      const lastElementPosition = this.deps.getElementViewportPosition(this.totalElements - 1);
      if (lastElementPosition.bottom <= this.viewportHeight && deltaY > 0) {
        element = this.deps.getCurrentElement();
        offset = this.deps.getScrollOffset();
      }
    } else if (element <= 0) {
      element = 0;
      offset = Math.max(0, offset);
    } else {
      const elementHeight = this.deps.getElementHeight(element);
      offset = Math.max(0, Math.min(offset, elementHeight - 1));
    }

    offset = Math.max(0, Math.min(offset, this.deps.getElementHeight(element) - 1));

    if (element >= this.totalElements - 1) {
      element = Math.max(0, this.totalElements - 1);
      const lastHeight = Math.max(1, this.deps.getElementHeight(element));
      offset = Math.max(0, Math.min(offset, lastHeight - 1));
    }

    const shouldClamp = this.guardian.shouldClamp(element);
    let positionUpdated = false;

    if (shouldClamp && deltaY > 0) {
      this.deps.updateScrollPosition(element, offset);
      positionUpdated = true;
      const correction = this.guardian.correctBottomOvershoot(element, offset);
      if (correction) {
        element = correction.element;
        offset = correction.offset;
        this.deps.updateScrollPosition(element, offset);
      }
    }

    if (!positionUpdated) {
      this.deps.updateScrollPosition(element, offset);
    }

    this.deps.syncScrollbar();
    
    // GC optimization: Reuse result object instead of creating new one
    this._scrollResult.element = element;
    this._scrollResult.offset = offset;
    return this._scrollResult;
  }

  handleScrollPercentage(percentage: number): ScrollResult {
    const clamped = Math.max(0, Math.min(100, percentage));

    if (clamped >= 99.99) {
      this.deps.updateScrollPosition(this.totalElements - 1, 0);
      return this.scroll(Number.MAX_SAFE_INTEGER, this.viewportHeight);
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

  jumpToElement(elementIndex: number): ScrollResult {
    if (elementIndex >= 0 && elementIndex < this.totalElements) {
      const trueBottom = this.deps.getTrueBottomPosition?.();
      if (trueBottom && elementIndex >= trueBottom.element) {
        this.deps.updateScrollPosition(trueBottom.element, trueBottom.offset);
        this.deps.requestDisplayUpdate();
        this.deps.syncScrollbar();
        return { element: trueBottom.element, offset: trueBottom.offset };
      }

      this.deps.updateScrollPosition(elementIndex, 0);
      this.deps.requestDisplayUpdate();
      this.deps.syncScrollbar();
      return { element: elementIndex, offset: 0 };
    }

    return { element: this.deps.getCurrentElement(), offset: this.deps.getScrollOffset() };
  }

  jumpToPosition(elementIndex: number, offset: number, skipScrollbarSync = false): ScrollResult {
    let element = Math.max(0, Math.min(elementIndex, this.totalElements - 1));
    const elementHeight = Math.max(1, this.deps.getElementHeight(element));
    let clampedOffset = Math.max(0, Math.min(offset, elementHeight - 1));

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

  reset(): void {
    this.deps.updateScrollPosition(0, 0);
    this.deps.requestDisplayUpdate();
    this.deps.syncScrollbar();
  }
}
