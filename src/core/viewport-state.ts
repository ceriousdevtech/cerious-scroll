/** Derived display fields (visible range, percentage, virtual-track top). */

import { ElementHeightCalculator } from '../types/index.js';

export interface ViewportSnapshot {
  startElement: number;
  endElement: number;
  scrollPercentage: number;
  viewportTop: number;
}

interface ViewportStateDeps {
  totalElements: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
  getElementHeight: ElementHeightCalculator;
  getWindowHeight: () => number;
  calculateScrollPercentage: () => number;
  bufferSize: number;
  nearEndThreshold: number;
  virtualTrackHeight: number;
}

export class ViewportStateCalculator {
  /**
   * @param deps Live getters for camera, heights, and viewport size.
   */
  constructor(private readonly deps: ViewportStateDeps) {}

  /**
   * @returns Visible range (plus overscan), scroll percentage, and virtual-track top.
   */
  calculate(): ViewportSnapshot {
    const totalElements = Math.max(0, this.deps.totalElements());
    const currentElement = Math.min(Math.max(this.deps.getCurrentElement(), 0), Math.max(totalElements - 1, 0));
    const scrollOffset = this.deps.getScrollOffset();
    const windowHeight = Math.max(0, this.deps.getWindowHeight());

    let startElement = currentElement;
    let offset = scrollOffset;
    let accHeight = -offset;
    let endElement = startElement;

    while (endElement < totalElements && accHeight < windowHeight) {
      accHeight += this.deps.getElementHeight(endElement);
      endElement++;
    }

    endElement = Math.max(0, Math.min(totalElements - 1, endElement - 1));

    let bufferedEndElement = Math.min(totalElements - 1, endElement + this.deps.bufferSize);
    const elementsFromEnd = Math.max(0, totalElements - 1 - currentElement);
    if (elementsFromEnd <= this.deps.nearEndThreshold) {
      bufferedEndElement = Math.max(0, totalElements - 1);
    }

    const scrollPercentage = this.deps.calculateScrollPercentage();
    const trackRange = Math.max(this.deps.virtualTrackHeight - windowHeight, 0);
    const viewportTop = (scrollPercentage / 100) * trackRange;

    return {
      startElement,
      endElement: bufferedEndElement,
      scrollPercentage,
      viewportTop
    };
  }
}
