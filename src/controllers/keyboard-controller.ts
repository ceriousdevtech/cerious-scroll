/**
 * @fileoverview Dedicated keyboard navigation controller.
 */

import { KeyboardNavigationOptions, ScrollResult } from '../types/index.js';

interface KeyboardControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  jumpToElement: (index: number) => ScrollResult;
  getViewportHeight: () => number;
  getScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

export class KeyboardController {
  // GC optimization: Reuse event detail object to avoid allocations
  private readonly _eventDetail: {
    percentage: number;
    currentElement: number;
    scrollOffset: number;
  } = {
    percentage: 0,
    currentElement: 0,
    scrollOffset: 0
  };

  constructor(private readonly deps: KeyboardControllerDeps) {}

  attach(
    container: HTMLElement,
    keyboardOptions?: KeyboardNavigationOptions,
    onViewportChange?: (detail: any) => void
  ): () => void {
    const options = {
      enabled: true,
      arrowKeySpeed: 120,
      pageKeySpeed: 1.0,
      ...keyboardOptions
    };

    if (!options.enabled) {
      return () => {};
    }

    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '0');
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (options.onKeyDown && options.onKeyDown(event, null)) {
        return;
      }

      let handled = false;
      switch (event.key) {
        case 'ArrowUp':
          this.deps.scroll(-options.arrowKeySpeed!, this.deps.getViewportHeight());
          handled = true;
          break;
        case 'ArrowDown':
          this.deps.scroll(options.arrowKeySpeed!, this.deps.getViewportHeight());
          handled = true;
          break;
        case 'PageUp':
          this.deps.scroll(-this.deps.getViewportHeight() * options.pageKeySpeed!, this.deps.getViewportHeight());
          handled = true;
          break;
        case 'PageDown':
          this.deps.scroll(this.deps.getViewportHeight() * options.pageKeySpeed!, this.deps.getViewportHeight());
          handled = true;
          break;
        case 'Home':
          this.deps.jumpToElement(0);
          handled = true;
          break;
        case 'End':
          this.deps.jumpToElement(Number.MAX_SAFE_INTEGER);
          handled = true;
          break;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        
        // GC optimization: Reuse event detail object instead of creating new one
        this._eventDetail.percentage = this.deps.getScrollPercentage();
        this._eventDetail.currentElement = this.deps.getCurrentElement();
        this._eventDetail.scrollOffset = this.deps.getScrollOffset();

        if (onViewportChange) {
          onViewportChange(this._eventDetail);
        }

        container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
          detail: this._eventDetail
        }));
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }
}
