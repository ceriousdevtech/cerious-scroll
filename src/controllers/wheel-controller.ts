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
    const options: Required<Pick<WheelNavigationOptions, 'enabled' | 'emitViewportChangeEvent' | 'coalesceViewportChangeEvent'>> = {
      enabled: wheelOptions?.enabled !== false,
      emitViewportChangeEvent: wheelOptions?.emitViewportChangeEvent !== false,
      coalesceViewportChangeEvent: wheelOptions?.coalesceViewportChangeEvent === true,
    };

    if (!options.enabled) {
      return () => {};
    }

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
      event.preventDefault();

      const viewportHeight = container.clientHeight || container.offsetHeight;
      const result = this.deps.scroll(event.deltaY, viewportHeight);

      // Optional event dispatch for framework integrations.
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
          // GC optimization: Reuse event detail object instead of creating new one
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

      onScroll?.(result);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      container.removeEventListener('wheel', handleWheel);
    };
  }
}
