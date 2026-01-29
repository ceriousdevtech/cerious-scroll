/**
 * @fileoverview Viewport Renderer Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 * 
 * This module handles DOM viewport rendering and element measurement for virtual scrolling.
 * Provides high-performance rendering with element reuse and measurement optimization.
 */

import { ElementRenderer, MeasuredViewportRange } from '../types/index.js';

/**
 * Viewport Renderer for CeriousScroll
 * 
 * Manages DOM rendering, element measurement, and viewport calculations
 * with optimized element reuse and performance characteristics.
 */
export class ViewportRenderer {
  // Constants for rendering behavior
  private static readonly OVERSCAN_BUFFER = 5;
  private static readonly DEFAULT_ESTIMATED_HEIGHT = 50;
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
   * Calculate the range of elements currently visible in the viewport using actual DOM rendering and measurement
   * 
   * This method uses a high-performance approach that minimizes DOM operations by only rendering
   * the exact elements needed and reusing existing elements without expensive repositioning.
   * 
   * @param windowHeight Height of the viewport window in pixels
   * @param container The DOM container element where elements will be rendered and measured
   * @param renderElement Callback function that renders an element and returns its measured height
   * @returns Object containing viewport information with measured heights
   * 
   * @performance Optimized to minimize DOM operations and layout thrashing
   * @precision Stops rendering exactly when windowHeight is exceeded, based on actual measurements
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
    
    let startElement = currentElement;
    let offset = scrollOffset;
    let accHeight = -offset; // Start with negative offset to account for partial top element
    let elementIndex = startElement;

    // Reuse the same rendered rows array + entry objects to avoid per-frame allocations.
    // NOTE: Consumers should treat returned snapshots as ephemeral.
    const renderedRows = this._renderedRowsArray;
    let renderedRowsCount = 0;
    let totalRenderedHeight = 0;
    
    // INCREMENTAL DOM UPDATE APPROACH
    // Keep a buffer of elements above and below the viewport to prevent touch gesture interruption
    
    // First pass: determine which elements should be visible (including buffer)
    // Reuse existing Set to avoid allocations
    this._shouldBeVisibleSet.clear();
    
    // Add buffer above viewport
    const bufferStart = Math.max(0, startElement - ViewportRenderer.OVERSCAN_BUFFER);
    for (let i = bufferStart; i < startElement; i++) {
      this._shouldBeVisibleSet.add(i);
    }
    
    // Add visible elements
    let tempIndex = startElement;
    let tempHeight = -offset;
    
    while (tempIndex < this.totalElements && tempHeight < windowHeight) {
      this._shouldBeVisibleSet.add(tempIndex);
      const height = this.hasMeasuredHeight(tempIndex) 
        ? this.getMeasuredHeight(tempIndex) 
        : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
      tempHeight += height;
      tempIndex++;
    }
    
    // Add buffer below viewport
    const bufferEnd = Math.min(this.totalElements - 1, tempIndex + ViewportRenderer.OVERSCAN_BUFFER);
    for (let i = tempIndex; i <= bufferEnd; i++) {
      this._shouldBeVisibleSet.add(i);
    }
    
    // Second pass: remove elements that are outside the buffer zone
    // Reuse array to avoid allocations
    this._toRemoveArray.length = 0;
    this.currentlyRendered.forEach((element, index) => {
      if (!this._shouldBeVisibleSet.has(index)) {
        this._toRemoveArray.push(index);
        // Check if element is actually a child before removing
        if (element.parentNode === container) {
          container.removeChild(element);
        }
        // Keep in pool for reuse rather than letting it be GC'd.
        // NOTE: we do not keep any index association here.
        this.recycledElements.push(element);
      }
    });
    
    // Remove from tracking map
    this._toRemoveArray.forEach(index => this.currentlyRendered.delete(index));
    
    // MEMORY OPTIMIZATION: If we jumped far away from last position, clear all and rebuild
    // This prevents memory accumulation from DOM element references
    if (Math.abs(startElement - this.lastStartElement) > 100) {
      // Clear everything and rebuild from scratch for true O(1) memory
      container.innerHTML = '';
      this.currentlyRendered.clear();
      // Keep the pool intact; we'll reuse its elements after a large jump.
    }
    
    // ADDITIONAL CLEANUP: Periodically verify Map doesn't grow unbounded
    // If Map is significantly larger than what we're rendering, do a full cleanup
    if (this.currentlyRendered.size > this._shouldBeVisibleSet.size * 2) {
      // Defensive cleanup: remove any elements not in the should-be-visible set
      this._defensiveRemoveArray.length = 0;
      this.currentlyRendered.forEach((element, index) => {
        if (!this._shouldBeVisibleSet.has(index)) {
          this._defensiveRemoveArray.push(index);
          // Element already has parentNode check - keep it
          if (element.parentNode === container) {
            container.removeChild(element);
          }
        }
      });
      this._defensiveRemoveArray.forEach(index => this.currentlyRendered.delete(index));
    }
    
    // Third pass: render all elements that should be visible (including buffer)
    // Calculate positions relative to the viewport:
    // - startElement begins at -offset (partially scrolled)
    // - Earlier elements are positioned above (negative positions)
    // - Later elements are positioned below
    
    // Reuse array to avoid allocation - populate from Set
    this._sortedIndicesArray.length = 0;
    for (const idx of this._shouldBeVisibleSet) {
      this._sortedIndicesArray.push(idx);
    }
    this._sortedIndicesArray.sort((a, b) => a - b);
    const sortedIndices = this._sortedIndicesArray;
    
    // Calculate cumulative position for each element
    // Start by calculating the position of startElement
    let startElementTop = -offset;
    
    // Calculate positions for buffer elements before startElement
    // Track if we used any estimated heights that might cause positioning issues
    let usedEstimatedHeights = false;
    for (let i = startElement - 1; i >= bufferStart; i--) {
      const height = this.hasMeasuredHeight(i) 
        ? this.getMeasuredHeight(i) 
        : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
      if (!this.hasMeasuredHeight(i)) {
        usedEstimatedHeights = true;
      }
      startElementTop -= height;
    }
    
    // Now we know where the first element in our render range should be positioned
    let cumulativeTop = startElementTop;
    
    // Track if we created any new elements (which means we got new measurements)
    let createdNewElements = false;
    
    for (const idx of sortedIndices) {
      const hadMeasurement = this.hasMeasuredHeight(idx);
      let elementToRender: HTMLElement;
      let measuredHeight: number = hadMeasurement
        ? this.getMeasuredHeight(idx)
        : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
      
      // Check if element already exists
      if (this.currentlyRendered.has(idx)) {
        // Element already rendered - just update its position
        elementToRender = this.currentlyRendered.get(idx)!;
        // Ensure position: absolute is set (renderElement callback might change className/styles)
        elementToRender.style.position = this._styleCache.position;
        // GC optimization: Reuse string buffer instead of template literal
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        
        // Measure actual height to ensure positioning accuracy
        const actualHeight = elementToRender.offsetHeight;
        if (actualHeight !== measuredHeight) {
          measuredHeight = actualHeight;
          this.setMeasuredHeight(idx, measuredHeight);
          if (this.shouldTrackIndexForBottom(idx)) {
            this.bumpBottomMeasurementVersion();
          }
        }
      } else {
        createdNewElements = true;
        // Reuse from pool if available; otherwise create.
        const pooled = this.recycledElements.pop();
        if (pooled) {
          elementToRender = pooled;
          this.reusedElementsTotal++;
          this.lastFrameReused++;
          // Clear old content; renderElement will populate.
          elementToRender.textContent = '';
        } else {
          elementToRender = document.createElement('div');
          this.createdElementsTotal++;
          this.lastFrameCreated++;
        }
        // GC-FRIENDLY: Use dataset instead of setAttribute to reduce string allocations
        elementToRender.dataset.elementIndex = String(idx);
        // GC-FRIENDLY: Use cached strings to avoid allocations
        elementToRender.style.position = this._styleCache.position;

        if (container.style.visibility === 'hidden') {
            container.style.visibility = this._styleCache.visible;
            container.style.position = this._styleCache.position;
            container.style.left = this._styleCache.left;
            container.style.top = this._styleCache.left; // 0px
            container.style.width = this._styleCache.width;
        }
        
        // Apply pixel-perfect positioning
        // GC optimization: Reuse string buffer instead of template literal
        this._topStyleBuffer = cumulativeTop + 'px';
        elementToRender.style.top = this._topStyleBuffer;
        elementToRender.style.left = this._styleCache.left;
        elementToRender.style.right = this._styleCache.right;
        
        // Add to DOM
        container.appendChild(elementToRender);
        
        // Render the element
        renderElement(idx, elementToRender);
        
        // Measure height after rendering and adding to DOM
        const newMeasuredHeight = elementToRender.offsetHeight;
        const sizeChanged = newMeasuredHeight !== measuredHeight;
        const measurementChanged = !hadMeasurement || sizeChanged;

        if (sizeChanged) {
          usedEstimatedHeights = true;
          measuredHeight = newMeasuredHeight;
        } else if (!hadMeasurement) {
          measuredHeight = newMeasuredHeight;
        }

        if (measurementChanged && this.shouldTrackIndexForBottom(idx)) {
          this.bumpBottomMeasurementVersion();
        }

        // Cache the measured height for future calculations
        this.setMeasuredHeight(idx, measuredHeight);
        
        // Track it
        this.currentlyRendered.set(idx, elementToRender);
      }
      
      // Track in renderedRows for visible elements only (not buffer above)
      if (idx >= startElement) {
        const entry = renderedRows[renderedRowsCount] ?? (renderedRows[renderedRowsCount] = { index: 0, height: 0 });
        entry.index = idx;
        entry.height = measuredHeight;
        renderedRowsCount++;
        
        // Only accumulate height for truly visible elements
        if (idx >= startElement && accHeight < windowHeight) {
          totalRenderedHeight += measuredHeight;
          accHeight += measuredHeight;
        }
      }
      
      cumulativeTop += measuredHeight;
    }
    
    // CRITICAL FIX: If we used estimated heights or created new elements, 
    // recalculate all positions now that we have accurate measurements
    if (usedEstimatedHeights && createdNewElements) {
      // Recalculate startElementTop with actual measured heights
      let correctedStartTop = -offset;
      for (let i = startElement - 1; i >= bufferStart; i--) {
        const height = this.hasMeasuredHeight(i) 
          ? this.getMeasuredHeight(i) 
          : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
        correctedStartTop -= height;
      }
      
      // Reposition all rendered elements with corrected positions
      let correctedTop = correctedStartTop;
      for (const idx of sortedIndices) {
        const element = this.currentlyRendered.get(idx);
        if (element) {
          // GC optimization: Reuse string buffer instead of template literal
          this._topStyleBuffer = correctedTop + 'px';
          element.style.top = this._topStyleBuffer;
          const height = this.getMeasuredHeight(idx);
          correctedTop += height;
        }
      }
    }
    
    // Update elementIndex to the last element we should have rendered
    elementIndex = sortedIndices[sortedIndices.length - 1] + 1;
    
    const endElement = Math.min(elementIndex - 1, this.totalElements - 1);
    
    // Update tracking
    this.lastStartElement = startElement;
    this.lastEndElement = endElement;
    
    // Render bottom elements for boundary detection
    // Render backwards from last element until we have enough to fill viewport
    this._lastRenderedElement = null;
    
    const datasetLastIndex = this.totalElements - 1;
    if (datasetLastIndex >= 0 && endElement < datasetLastIndex) {
      // Calculate which bottom elements we need to render to fill the viewport
      const bottomElementsToRender = this._bottomElementsToRenderArray;
      bottomElementsToRender.length = 0;
      let accumulatedHeight = 0;
      
      for (let i = datasetLastIndex; i >= 0 && accumulatedHeight < windowHeight; i--) {
        // Build in reverse order then reverse once (avoids O(n) unshift).
        bottomElementsToRender.push(i);
        
        const height = this.hasMeasuredHeight(i) 
          ? this.getMeasuredHeight(i) 
          : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
        accumulatedHeight += height;
        
        // Stop if we've filled the viewport or reached the end of our normal render range
        if (i <= endElement) {
          break;
        }
      }

      bottomElementsToRender.reverse();
      
      // Add bottom elements to the visible set so they don't get cleaned up
      for (let i = 0; i < bottomElementsToRender.length; i++) {
        this._shouldBeVisibleSet.add(bottomElementsToRender[i]);
      }
      
      // Render these bottom elements
      for (const elemIndex of bottomElementsToRender) {
        let bottomElement: HTMLElement;
        const hadMeasurement = this.hasMeasuredHeight(elemIndex);
        const previousHeight = hadMeasurement ? this.getMeasuredHeight(elemIndex) : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
        
        // Check if already rendered
        let bottomHeight: number;
        if (this.currentlyRendered.has(elemIndex)) {
          bottomElement = this.currentlyRendered.get(elemIndex)!;
          // Ensure position: absolute is set (renderElement might change className/styles)
          bottomElement.style.position = this._styleCache.position;
          // Update position
          // GC optimization: Reuse string buffer instead of template literal
          this._topStyleBuffer = cumulativeTop + 'px';
          bottomElement.style.top = this._topStyleBuffer;
          // Get measured height for position calculation
          bottomHeight = this.getMeasuredHeight(elemIndex);
        } else {
          // Reuse from pool if possible; otherwise create.
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
          // GC-FRIENDLY: Use dataset instead of setAttribute
          bottomElement.dataset.elementIndex = String(elemIndex);
          // GC-FRIENDLY: Use cached strings to avoid allocations
          bottomElement.style.position = this._styleCache.position;
          // Ensure position: absolute is set (renderElement might change className/styles)
          bottomElement.style.position = this._styleCache.position;
          // GC optimization: Reuse string buffer instead of template literal
          this._topStyleBuffer = cumulativeTop + 'px';
          bottomElement.style.top = this._topStyleBuffer;
          bottomElement.style.left = this._styleCache.left;
          bottomElement.style.right = this._styleCache.right;
          
          container.appendChild(bottomElement);
          
          renderElement(elemIndex, bottomElement);

          bottomHeight = bottomElement.offsetHeight;
          if (!hadMeasurement || bottomHeight !== previousHeight) {
            if (this.shouldTrackIndexForBottom(elemIndex)) {
              this.bumpBottomMeasurementVersion();
            }
          }
          this.setMeasuredHeight(elemIndex, bottomHeight);
          
          this.currentlyRendered.set(elemIndex, bottomElement);

          const entry = renderedRows[renderedRowsCount] ?? (renderedRows[renderedRowsCount] = { index: 0, height: 0 });
          entry.index = elemIndex;
          entry.height = bottomHeight;
          renderedRowsCount++;
          totalRenderedHeight += bottomHeight;
        }
        
        // CRITICAL: Increment cumulativeTop to prevent overlapping
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
      const height = this.hasMeasuredHeight(i) 
        ? this.getMeasuredHeight(i) 
        : ViewportRenderer.DEFAULT_ESTIMATED_HEIGHT;
      
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