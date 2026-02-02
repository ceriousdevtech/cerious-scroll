/**
 * @fileoverview Viewport Renderer Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 * 
 * This module handles DOM viewport rendering and element measurement for virtual scrolling.
 * Implements a pure measurement-driven incremental rendering approach that eliminates the
 * need for estimated heights. Elements are rendered one-by-one and measured immediately,
 * ensuring pixel-perfect positioning without correction passes or height assumptions.
 * 
 * Key Features:
 * - Incremental rendering: Add element → measure → check if viewport filled → repeat
 * - No estimated heights: All positioning based on actual DOM measurements
 * - Element pooling: Reuse DOM elements to reduce GC pressure
 * - Overscan buffering: Pre-render elements above/below viewport for smooth scrolling
 * - O(1) memory complexity: Number of DOM elements independent of dataset size
 */

import { ElementRenderer, MeasuredViewportRange } from '../types/index.js';

/**
 * Viewport Renderer for CeriousScroll
 * 
 * Manages DOM rendering, element measurement, and viewport calculations using
 * a measurement-driven incremental approach. Provides O(1) memory complexity
 * and O(k) rendering complexity where k = visible elements (typically 10-30).
 */
export class ViewportRenderer {
  // Constants for rendering behavior
  private static readonly OVERSCAN_BUFFER = 5;
  private static readonly TRUE_BOTTOM_WATCH_RANGE = 400;

  private _lastRenderedElement: HTMLElement | null = null;
  // Track currently rendered elements by index
  private currentlyRendered = new Map<number, HTMLElement>();
  // Simple pooling to reduce DOM churn / GC: detached elements get reused.
  // Note: elements are still re-rendered via renderElement(index, el) when reused.
  private recycledElements: HTMLElement[] = [];
  private createdElementsTotal = 0;
  private reusedElementsTotal = 0;
  private lastFrameCreated = 0;
  private lastFrameReused = 0;
  private lastStartElement = -1;
  private lastEndElement = -1;
  // Reusable data structures to reduce allocations
  private _shouldBeVisibleSet = new Set<number>();
  private _toRemoveArray: number[] = [];
  private _sortedIndicesArray: number[] = [];

  // GC optimization: reuse arrays/objects created every renderViewport call.
  private _renderedRowsArray: Array<{ index: number; height: number }> = [];
  private _bottomElementsToRenderArray: number[] = [];
  private _defensiveRemoveArray: number[] = [];
  // GC-FRIENDLY: Cache common CSS values to avoid string allocations
  private _styleCache = {
    position: 'absolute',
    left: '0px',
    right: '0px',
    visible: 'visible',
    width: '100%'
  };
  // GC optimization: Reuse string buffer for style.top to avoid template literal allocations
  private _topStyleBuffer = '';
  private bottomMeasurementVersion = 0;
  private trueBottomCache: {
    viewportHeight: number;
    totalElements: number;
    measurementVersion: number;
    value: { element: number; offset: number } | null;
  } | null = null;

  /**
   * Debug-only: how many DOM row containers we currently have attached/rendered.
   *
   * This is intended for automated harnesses (Playwright) and should not be used
   * for core logic.
   */
  get renderedElementCount(): number {
    return this.currentlyRendered.size;
  }

  /**
   * Debug-only: last rendered viewport range.
   */
  get lastRenderedRange(): { startElement: number; endElement: number } {
    return { startElement: this.lastStartElement, endElement: this.lastEndElement };
  }

  constructor(
    private totalElements: number,
    private getCurrentElement: () => number,
    private getScrollOffset: () => number,
    private getCalculateScrollPercentage: () => number,
    private setMeasuredHeight: (index: number, height: number) => void,
    private hasMeasuredHeight: (index: number) => boolean,
    private getMeasuredHeight: (index: number) => number
  ) {}

  /**
   * Get the last rendered element from the dataset
   */
  get lastRenderedElement(): HTMLElement | null {
    return this._lastRenderedElement;
  }

  /**
   * Clear tracking of rendered elements (useful when data changes)
   */
  clearRenderTracking(): void {
    this.currentlyRendered.clear();
    this.recycledElements.length = 0;
    this.lastFrameCreated = 0;
    this.lastFrameReused = 0;
    this.lastStartElement = -1;
    this.lastEndElement = -1;
    this._shouldBeVisibleSet.clear();
    this._toRemoveArray.length = 0;
    this._sortedIndicesArray.length = 0;
    this.invalidateTrueBottomCache();
  }

  /**
   * Get the indices of currently rendered elements
   * @returns Array of element indices currently in the viewport
   */
  getRenderedIndices(): number[] {
    return Array.from(this.currentlyRendered.keys());
  }

  /**
   * Get a specific rendered element by index
   * @param index Element index
   * @returns The DOM element or null if not currently rendered
   */
  getRenderedElement(index: number): HTMLElement | null {
    return this.currentlyRendered.get(index) || null;
  }

  /**
   * Debug-only: renderer lifecycle counters.
   */
  get lifecycleStats(): {
    poolSize: number;
    createdTotal: number;
    reusedTotal: number;
    lastFrameCreated: number;
    lastFrameReused: number;
  } {
    return {
      poolSize: this.recycledElements.length,
      createdTotal: this.createdElementsTotal,
      reusedTotal: this.reusedElementsTotal,
      lastFrameCreated: this.lastFrameCreated,
      lastFrameReused: this.lastFrameReused
    };
  }

  /**
   * Render the visible viewport elements using incremental measurement-based rendering
   * 
   * This method implements a pure measurement-driven approach that eliminates the need for
   * estimated heights. Elements are rendered incrementally and measured immediately after
   * being added to the DOM, ensuring pixel-perfect positioning without correction passes.
   * 
   * Rendering Process:
   * 1. Render overscan buffer above viewport (5 elements) - measure each
   * 2. Render visible elements one-by-one until viewport is filled:
   *    - Add element to DOM → render content → measure actual height
   *    - Accumulate height and stop when windowHeight is exceeded
   * 3. Add overscan buffer below viewport (5 elements)
   * 4. Render bottom boundary elements (up to 50) for end-of-scroll detection
   * 5. Remove elements outside the visible + overscan range
   * 
   * @param windowHeight Height of the viewport window in pixels
   * @param container The DOM container element where elements will be rendered and measured
   * @param renderElement Callback function that renders element content (index, element) => void
   * @returns Object containing viewport information with actual measured heights
   * 
   * @performance 
   * - O(k) where k = visible elements (typically 10-30, not dataset size)
   * - No estimated heights or correction passes
   * - Element pooling reduces DOM creation overhead
   * - Incremental measurement prevents layout thrashing
   * 
   * @precision All positioning based on actual DOM measurements, no estimates
   */
  renderViewport(
    windowHeight: number, 
    container: HTMLElement, 
    renderElement: ElementRenderer
  ): MeasuredViewportRange {
    // Reset per-frame counters.
    this.lastFrameCreated = 0;
    this.lastFrameReused = 0;

    const currentElement = this.getCurrentElement();
    const scrollOffset = this.getScrollOffset();
    
    const startElement = currentElement;
    const offset = scrollOffset;

    // Reuse the same rendered rows array + entry objects to avoid per-frame allocations.
    // NOTE: Consumers should treat returned snapshots as ephemeral.
    const renderedRows = this._renderedRowsArray;
    let renderedRowsCount = 0;
    let totalRenderedHeight = 0;
    
    // Track which elements should be visible in this frame
    this._shouldBeVisibleSet.clear();
    
    // MEMORY OPTIMIZATION: If we jumped far away from last position, clear all and rebuild
    // This prevents memory accumulation from DOM element references
    if (Math.abs(startElement - this.lastStartElement) > 100) {
      container.innerHTML = '';
      this.currentlyRendered.clear();
      // Keep the pool intact; we'll reuse its elements after a large jump.
    }

    // Ensure container is visible and positioned
    if (container.style.visibility === 'hidden') {
      container.style.visibility = this._styleCache.visible;
      container.style.position = this._styleCache.position;
      container.style.left = this._styleCache.left;
      container.style.top = this._styleCache.left; // 0px
      container.style.width = this._styleCache.width;
    }
    
    // STEP 1: Render overscan buffer ABOVE the viewport
    // We need to know the heights of buffer elements to position startElement correctly
    const bufferStart = Math.max(0, startElement - ViewportRenderer.OVERSCAN_BUFFER);
    let bufferAboveHeight = 0;
    
    for (let i = bufferStart; i < startElement; i++) {
      this._shouldBeVisibleSet.add(i);
      
      let elementToRender: HTMLElement;
      let measuredHeight: number;
      
      if (this.currentlyRendered.has(i)) {
        // Element already rendered - reuse it
        elementToRender = this.currentlyRendered.get(i)!;
        measuredHeight = elementToRender.offsetHeight;
      } else {
        // Create or reuse from pool
        const pooled = this.recycledElements.pop();
        if (pooled) {
          elementToRender = pooled;
          this.reusedElementsTotal++;
          this.lastFrameReused++;
          elementToRender.textContent = '';
        } else {
          elementToRender = document.createElement('div');
          this.createdElementsTotal++;
          this.lastFrameCreated++;
        }
        
        elementToRender.dataset.elementIndex = String(i);
        elementToRender.style.position = this._styleCache.position;
        elementToRender.style.left = this._styleCache.left;
        elementToRender.style.right = this._styleCache.right;
        
        // Position will be set after we know all buffer heights
        container.appendChild(elementToRender);
        renderElement(i, elementToRender);
        
        // Measure actual height
        measuredHeight = elementToRender.offsetHeight;
        this.setMeasuredHeight(i, measuredHeight);
        
        if (this.shouldTrackIndexForBottom(i)) {
          this.bumpBottomMeasurementVersion();
        }
        
        this.currentlyRendered.set(i, elementToRender);
      }
      
      bufferAboveHeight += measuredHeight;
    }
    
    // STEP 2: Position buffer elements above startElement
    let cumulativeTop = -offset - bufferAboveHeight;
    for (let i = bufferStart; i < startElement; i++) {
      const element = this.currentlyRendered.get(i)!;
      this._topStyleBuffer = cumulativeTop + 'px';
      element.style.top = this._topStyleBuffer;
      element.style.position = this._styleCache.position;
      
      const height = element.offsetHeight;
      cumulativeTop += height;
    }
    
    // STEP 3: Render visible elements incrementally until viewport is filled
    // Start position for the first visible element
    cumulativeTop = -offset;
    let accumulatedViewportHeight = -offset; // Negative because first element is partially scrolled
    let elementIndex = startElement;
    
    // Render elements until we've filled the viewport
    while (elementIndex < this.totalElements && accumulatedViewportHeight < windowHeight) {
      this._shouldBeVisibleSet.add(elementIndex);
      
      let elementToRender: HTMLElement;
      let measuredHeight: number;
      
      if (this.currentlyRendered.has(elementIndex)) {
        // Element already rendered - reuse it
        elementToRender = this.currentlyRendered.get(elementIndex)!;
        elementToRender.style.position = this._styleCache.position;
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        
        measuredHeight = elementToRender.offsetHeight;
      } else {
        // Create or reuse from pool
        const pooled = this.recycledElements.pop();
        if (pooled) {
          elementToRender = pooled;
          this.reusedElementsTotal++;
          this.lastFrameReused++;
          elementToRender.textContent = '';
        } else {
          elementToRender = document.createElement('div');
          this.createdElementsTotal++;
          this.lastFrameCreated++;
        }
        
        elementToRender.dataset.elementIndex = String(elementIndex);
        elementToRender.style.position = this._styleCache.position;
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        elementToRender.style.left = this._styleCache.left;
        elementToRender.style.right = this._styleCache.right;
        
        // Add to DOM
        container.appendChild(elementToRender);
        
        // Render content
        renderElement(elementIndex, elementToRender);
        
        // NOW measure the actual height
        measuredHeight = elementToRender.offsetHeight;
        
        // Cache the measurement
        this.setMeasuredHeight(elementIndex, measuredHeight);
        
        if (this.shouldTrackIndexForBottom(elementIndex)) {
          this.bumpBottomMeasurementVersion();
        }
        
        this.currentlyRendered.set(elementIndex, elementToRender);
      }
      
      // Track in rendered rows
      const entry = renderedRows[renderedRowsCount] ?? (renderedRows[renderedRowsCount] = { index: 0, height: 0 });
      entry.index = elementIndex;
      entry.height = measuredHeight;
      renderedRowsCount++;
      
      totalRenderedHeight += measuredHeight;
      accumulatedViewportHeight += measuredHeight;
      cumulativeTop += measuredHeight;
      elementIndex++;
    }
    
    // STEP 4: Add overscan buffer BELOW the viewport
    const bufferEnd = Math.min(this.totalElements - 1, elementIndex + ViewportRenderer.OVERSCAN_BUFFER - 1);
    
    for (let i = elementIndex; i <= bufferEnd; i++) {
      this._shouldBeVisibleSet.add(i);
      
      let elementToRender: HTMLElement;
      let measuredHeight: number;
      
      if (this.currentlyRendered.has(i)) {
        // Element already rendered - reuse it
        elementToRender = this.currentlyRendered.get(i)!;
        elementToRender.style.position = this._styleCache.position;
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        
        measuredHeight = elementToRender.offsetHeight;
      } else {
        // Create or reuse from pool
        const pooled = this.recycledElements.pop();
        if (pooled) {
          elementToRender = pooled;
          this.reusedElementsTotal++;
          this.lastFrameReused++;
          elementToRender.textContent = '';
        } else {
          elementToRender = document.createElement('div');
          this.createdElementsTotal++;
          this.lastFrameCreated++;
        }
        
        elementToRender.dataset.elementIndex = String(i);
        elementToRender.style.position = this._styleCache.position;
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        elementToRender.style.left = this._styleCache.left;
        elementToRender.style.right = this._styleCache.right;
        
        container.appendChild(elementToRender);
        renderElement(i, elementToRender);
        
        measuredHeight = elementToRender.offsetHeight;
        this.setMeasuredHeight(i, measuredHeight);
        
        if (this.shouldTrackIndexForBottom(i)) {
          this.bumpBottomMeasurementVersion();
        }
        
        this.currentlyRendered.set(i, elementToRender);
      }
      
      cumulativeTop += measuredHeight;
    }
    
    // STEP 5: Remove elements that are no longer visible
    this._toRemoveArray.length = 0;
    this.currentlyRendered.forEach((element, index) => {
      if (!this._shouldBeVisibleSet.has(index)) {
        this._toRemoveArray.push(index);
        if (element.parentNode === container) {
          container.removeChild(element);
        }
        this.recycledElements.push(element);
      }
    });
    
    this._toRemoveArray.forEach(index => this.currentlyRendered.delete(index));
    
    const endElement = Math.min(elementIndex - 1, this.totalElements - 1);
    
    // Update tracking
    this.lastStartElement = startElement;
    this.lastEndElement = endElement;
    
    // STEP 6: Render bottom boundary elements for precise end-of-scroll detection
    this._lastRenderedElement = null;
    
    const datasetLastIndex = this.totalElements - 1;
    if (datasetLastIndex >= 0 && endElement < datasetLastIndex) {
      // Render elements from the end backwards until we have a viewport's worth
      // This enables accurate bottom boundary detection
      const bottomElementsToRender = this._bottomElementsToRenderArray;
      bottomElementsToRender.length = 0;
      let bottomAccumulatedHeight = 0;
      
      // Limit bottom elements to prevent rendering millions on initial load
      // Once measured, we'll stop when accumulated height >= viewport
      const MAX_BOTTOM_ELEMENTS = 50;
      
      // Build list of bottom elements to render (in reverse order)
      for (let i = datasetLastIndex; i >= 0; i--) {
        if (i <= endElement) {
          // Already rendered in the normal pass
          break;
        }
        
        // Safety limit: cap at maximum elements for boundary detection
        if (bottomElementsToRender.length >= MAX_BOTTOM_ELEMENTS) {
          break;
        }
        
        bottomElementsToRender.push(i);
        
        // Track accumulated height with actual measurements only
        if (this.hasMeasuredHeight(i)) {
          bottomAccumulatedHeight += this.getMeasuredHeight(i);
          
          // Stop once we have enough measured elements to fill the viewport
          if (bottomAccumulatedHeight >= windowHeight) {
            break;
          }
        }
      }

      // Reverse to get proper order (closest to viewport first)
      bottomElementsToRender.reverse();
      
      // Render these bottom elements
      for (const elemIndex of bottomElementsToRender) {
        this._shouldBeVisibleSet.add(elemIndex);
        
        let bottomElement: HTMLElement;
        let bottomHeight: number;
        
        if (this.currentlyRendered.has(elemIndex)) {
          // Already rendered (shouldn't happen, but handle it)
          bottomElement = this.currentlyRendered.get(elemIndex)!;
          bottomElement.style.position = this._styleCache.position;
          this._topStyleBuffer = cumulativeTop + 'px';
          bottomElement.style.top = this._topStyleBuffer;
          bottomHeight = bottomElement.offsetHeight;
        } else {
          // Create or reuse from pool
          const pooled = this.recycledElements.pop();
          if (pooled) {
            bottomElement = pooled;
            this.reusedElementsTotal++;
            this.lastFrameReused++;
            bottomElement.textContent = '';
          } else {
            bottomElement = document.createElement('div');
            this.createdElementsTotal++;
            this.lastFrameCreated++;
          }
          
          bottomElement.dataset.elementIndex = String(elemIndex);
          bottomElement.style.position = this._styleCache.position;
          this._topStyleBuffer = cumulativeTop + 'px';
          bottomElement.style.top = this._topStyleBuffer;
          bottomElement.style.left = this._styleCache.left;
          bottomElement.style.right = this._styleCache.right;
          
          container.appendChild(bottomElement);
          renderElement(elemIndex, bottomElement);

          // Measure actual height
          bottomHeight = bottomElement.offsetHeight;
          this.setMeasuredHeight(elemIndex, bottomHeight);
          
          if (this.shouldTrackIndexForBottom(elemIndex)) {
            this.bumpBottomMeasurementVersion();
          }
          
          this.currentlyRendered.set(elemIndex, bottomElement);
        }
        
        cumulativeTop += bottomHeight;
        
        // Track last element
        if (elemIndex === datasetLastIndex) {
          this._lastRenderedElement = bottomElement;
        }
      }
    }
    
    const scrollPercentage = this.getCalculateScrollPercentage();

    // Trim renderedRows to the number of entries we populated.
    renderedRows.length = renderedRowsCount;
    
    return { 
      startElement: startElement, 
      endElement: endElement,
      scrollPercentage, 
      viewportElements: endElement - startElement + 1,
      renderedElements: renderedRows,
      totalRenderedHeight
    };
  }

  /**
   * Update the total number of elements
   * @param totalElements New total element count
   */
  updateTotalElements(totalElements: number): void {
    if (this.totalElements !== totalElements) {
      this.totalElements = totalElements;
      this.bumpBottomMeasurementVersion();
    } else {
      this.totalElements = totalElements;
    }
  }

  /**
   * Calculate the true bottom scroll position based on measured bottom elements
   * 
   * Returns the element index and offset where the last element's bottom would
   * align with the viewport bottom, using actual measured heights.
   * 
   * @param viewportHeight Height of the viewport in pixels
   * @returns Object with element index and offset, or null if not calculable
   */
  calculateTrueBottomPosition(viewportHeight: number): { element: number; offset: number } | null {
    if (
      this.trueBottomCache &&
      this.trueBottomCache.viewportHeight === viewportHeight &&
      this.trueBottomCache.totalElements === this.totalElements &&
      this.trueBottomCache.measurementVersion === this.bottomMeasurementVersion
    ) {
      // GC optimization: Return cached value directly instead of spreading (caller should not mutate)
      return this.trueBottomCache.value;
    }

    const value = this.computeTrueBottomPosition(viewportHeight);
    // GC optimization: Store value directly instead of spreading
    this.trueBottomCache = {
      viewportHeight,
      totalElements: this.totalElements,
      measurementVersion: this.bottomMeasurementVersion,
      value: value
    };
    return value;
  }

  invalidateTrueBottomCache(): void {
    this.trueBottomCache = null;
  }

  private computeTrueBottomPosition(viewportHeight: number): { element: number; offset: number } | null {
    const lastIndex = this.totalElements - 1;
    if (lastIndex < 0) return null;
    
    // Work backwards from the last element, accumulating heights until we fill the viewport
    // We want to find the scroll position where the last element's bottom touches the viewport bottom
    let accumulatedHeight = 0;
    let targetElement = lastIndex;
    let targetOffset = 0;
    
    for (let i = lastIndex; i >= 0; i--) {
      // Bottom elements should be measured by renderViewport before this is called
      // If not measured, it means renderViewport hasn't been called yet (initial state)
      // In that case, we can't calculate accurately, so return null to indicate no bottom yet
      if (!this.hasMeasuredHeight(i)) {
        // No measurements available - return null to indicate we can't calculate yet
        return null;
      }
      
      const height = this.getMeasuredHeight(i);
      
      if (accumulatedHeight + height >= viewportHeight) {
        // This element is where we need to be scrolled to
        // The offset is how far down in this element we need to scroll
        targetElement = i;
        // We've accumulated too much - need to back off
        // The offset into this element is the overshoot amount
        targetOffset = Math.max(0, accumulatedHeight + height - viewportHeight);
        break;
      }
      
      accumulatedHeight += height;
      
      // If we reach element 0 and haven't filled viewport, target is 0,0
      if (i === 0) {
        targetElement = 0;
        targetOffset = 0;
        break;
      }
    }
    
    return { element: targetElement, offset: targetOffset };
  }

  private shouldTrackIndexForBottom(index: number): boolean {
    const watchStart = Math.max(0, this.totalElements - ViewportRenderer.TRUE_BOTTOM_WATCH_RANGE);
    return index >= watchStart;
  }

  private bumpBottomMeasurementVersion(): void {
    this.bottomMeasurementVersion++;
    this.invalidateTrueBottomCache();
  }
}