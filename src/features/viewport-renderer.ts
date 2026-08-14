/**
 * @fileoverview Viewport Renderer Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
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
import { RowPlacement, AbsolutePlacement } from './row-placement.js';

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
  private _bufferHeightArray: number[] = [];
  private _defensiveRemoveArray: number[] = [];
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
    private getMeasuredHeight: (index: number) => number,
    // Optional: when rows are known to be uniform-height, return that height
    // so the renderer can skip the per-new-row `offsetHeight` read (each one
    // forces a synchronous layout and dominates fast-scroll frame time).
    private getUniformHeightHint?: () => number | undefined,
    // Placement strategy: decides how a row reaches its y-coordinate. Defaults
    // to AbsolutePlacement (out-of-flow `top`), CeriousScroll's original model.
    private placement: RowPlacement = new AbsolutePlacement()
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
   * Re-invoke the renderer callback for every currently-rendered element and
   * re-measure each one's height into the cache. Use this when row content
   * (and therefore height) has changed in place — e.g. expand/collapse, an
   * async image finished loading. The plain renderViewport pass skips the
   * renderer for indices already in currentlyRendered and falls through to
   * reading offsetHeight, so external state changes that haven't been pushed
   * to the DOM yet would silently no-op.
   *
   * Call render() afterwards to reposition rows and refresh derived display
   * state from the new heights.
   */
  refreshVisible(renderElement: ElementRenderer): void {
    if (this.currentlyRendered.size === 0) return;
    for (const [index, element] of this.currentlyRendered) {
      renderElement(index, element);
      const height = element.offsetHeight;
      this.setMeasuredHeight(index, height);
    }
    this.invalidateTrueBottomCache();
  }

  /**
   * Resolve a reused element's height. Prefer the cached measurement (avoids a
   * synchronous layout on every scroll frame); on a cache miss, read
   * `offsetHeight` AND write it back to the cache. Re-caching the miss-read is
   * what keeps the height cache, total content height, "true bottom", and scroll
   * percentage correct after a row changes height in place (e.g. expand/collapse)
   * or after `clearAllCaches()` — without it, a reused row's new height is never
   * recorded until the element is destroyed and recreated (scrolled out and back).
   */
  private measureReused(index: number, element: HTMLElement): number {
    if (this.hasMeasuredHeight(index)) {
      return this.getMeasuredHeight(index);
    }
    const hint = this.getUniformHeightHint?.();
    if (hint !== undefined) {
      this.setMeasuredHeight(index, hint);
      return hint;
    }
    const height = element.offsetHeight;
    this.setMeasuredHeight(index, height);
    return height;
  }

  /**
   * Acquire a row element for a not-yet-rendered index: reuse a detached element
   * from the pool (cleared + re-styled) or create a fresh one via the placement
   * strategy. Updates lifecycle counters. The caller is responsible for setting
   * `dataset.elementIndex`, attaching, positioning, and rendering content.
   */
  private acquireRow(): HTMLElement {
    const pooled = this.recycledElements.pop();
    if (pooled) {
      this.reusedElementsTotal++;
      this.lastFrameReused++;
      pooled.textContent = '';
      this.placement.initRow(pooled);
      return pooled;
    }
    const created = this.placement.createRow();
    this.createdElementsTotal++;
    this.lastFrameCreated++;
    return created;
  }

  /**
   * Measure a freshly-rendered row and write the result into the height cache.
   * Honors the uniform-height hint to skip the synchronous `offsetHeight` read,
   * and bumps the bottom-measurement version when the index is in the watched
   * tail range (keeps the true-bottom cache correct).
   */
  private measureNew(index: number, element: HTMLElement): number {
    const hint = this.getUniformHeightHint?.();
    if (hint !== undefined) {
      this.setMeasuredHeight(index, hint);
      if (this.shouldTrackIndexForBottom(index)) {
        this.bumpBottomMeasurementVersion();
      }
      return hint;
    }

    // Reuse a previously-measured height instead of forcing a synchronous
    // layout. The row was just rendered for `index`, and content is
    // index-addressed — any remap clears the cache (clearAllCaches /
    // recalculate) — so the cached value is the correct height. This skips the
    // per-row `offsetHeight` read whose read-after-write layout dominates fast
    // scrollbar-drag frames (a row that was overscan last frame is already
    // cached). measureReused trusts the cache the same way; the cached value is
    // unchanged, so the true-bottom version need not bump.
    if (this.hasMeasuredHeight(index)) {
      return this.getMeasuredHeight(index);
    }

    const height = element.offsetHeight;
    this.setMeasuredHeight(index, height);
    if (this.shouldTrackIndexForBottom(index)) {
      this.bumpBottomMeasurementVersion();
    }
    return height;
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
      // Salvage the live window into the recycle pool BEFORE tearing it down, so
      // the rebuild below reuses these elements instead of allocating a fresh
      // window on every far jump (Step 5 recycles evicted rows the same way;
      // this shortcut previously skipped that and leaked the whole window).
      // clear() only detaches the nodes from the DOM — the references we push
      // here stay valid, and the rebuild pops them straight back, so the pool
      // stays bounded at ~one window.
      this.currentlyRendered.forEach((element) => {
        this.recycledElements.push(element);
      });
      this.placement.clear(container);
      this.currentlyRendered.clear();
    }

    // Let the placement strategy prepare the container (visibility/positioning
    // for absolute mode; wrapper/scaffold setup for a flow strategy).
    this.placement.prepare(container);

    // STEP 1: Render overscan buffer ABOVE the viewport
    // We need to know the heights of buffer elements to position startElement correctly
    const bufferStart = Math.max(0, startElement - ViewportRenderer.OVERSCAN_BUFFER);
    let bufferAboveHeight = 0;
    const bufferHeights = this._bufferHeightArray;
    bufferHeights.length = 0;
    
    for (let i = bufferStart; i < startElement; i++) {
      this._shouldBeVisibleSet.add(i);

      let elementToRender: HTMLElement;
      let measuredHeight: number;

      if (this.currentlyRendered.has(i)) {
        // Element already rendered - reuse it. Prefer the cached measurement
        // over a fresh offsetHeight read to avoid forcing a synchronous
        // layout on every scroll. The cache is invalidated by the content
        // observer when DOM mutations resize an element, so this is safe.
        elementToRender = this.currentlyRendered.get(i)!;
        measuredHeight = this.measureReused(i, elementToRender);
      } else {
        elementToRender = this.acquireRow();
        elementToRender.dataset.elementIndex = String(i);

        // Position will be set after we know all buffer heights.
        this.placement.attach(container, elementToRender, i, 'window');
        renderElement(i, elementToRender);
        measuredHeight = this.measureNew(i, elementToRender);

        this.currentlyRendered.set(i, elementToRender);
      }

      bufferHeights.push(measuredHeight);
      bufferAboveHeight += measuredHeight;
    }

    // STEP 2: Position buffer elements above startElement
    let cumulativeTop = -offset - bufferAboveHeight;
    // First rendered row's top (most-negative); a flow strategy shifts the whole
    // window by this in commit() instead of positioning each row.
    const firstRowTop = cumulativeTop;
    for (let i = bufferStart; i < startElement; i++) {
      const element = this.currentlyRendered.get(i)!;
      this.placement.position(element, cumulativeTop, 'window');
      cumulativeTop += bufferHeights[i - bufferStart];
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
        // Element already rendered - reuse it. See note above on cached
        // offsetHeight reads.
        elementToRender = this.currentlyRendered.get(elementIndex)!;
        this.placement.position(elementToRender, cumulativeTop, 'window');
        measuredHeight = this.measureReused(elementIndex, elementToRender);
      } else {
        elementToRender = this.acquireRow();
        elementToRender.dataset.elementIndex = String(elementIndex);

        this.placement.attach(container, elementToRender, elementIndex, 'window');
        this.placement.position(elementToRender, cumulativeTop, 'window');
        renderElement(elementIndex, elementToRender);
        measuredHeight = this.measureNew(elementIndex, elementToRender);

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
        // Element already rendered - reuse it. See note above on cached
        // offsetHeight reads.
        elementToRender = this.currentlyRendered.get(i)!;
        this.placement.position(elementToRender, cumulativeTop, 'window');
        measuredHeight = this.measureReused(i, elementToRender);
      } else {
        elementToRender = this.acquireRow();
        elementToRender.dataset.elementIndex = String(i);

        this.placement.attach(container, elementToRender, i, 'window');
        this.placement.position(elementToRender, cumulativeTop, 'window');
        renderElement(i, elementToRender);
        measuredHeight = this.measureNew(i, elementToRender);

        this.currentlyRendered.set(i, elementToRender);
      }

      cumulativeTop += measuredHeight;
    }
    
    const endElement = Math.min(elementIndex - 1, this.totalElements - 1);

    // PRE-STEP 6: Compute bottom boundary indices. These exist only so true-bottom
    // math has real measured heights for the tail. Once those heights are cached
    // (and pinned by PerformanceCache), keeping ~50 extra DOM nodes — and
    // repositioning them every frame — is wasted work, so we drop them from the
    // live set and let Step 5 recycle them.
    const datasetLastIndex = this.totalElements - 1;
    const bottomElementsToRender = this._bottomElementsToRenderArray;
    bottomElementsToRender.length = 0;
    if (datasetLastIndex >= 0 && endElement < datasetLastIndex) {
      let bottomAccumulatedHeight = 0;
      const MAX_BOTTOM_ELEMENTS = 50;
      let missingMeasurement = false;
      for (let i = datasetLastIndex; i >= 0; i--) {
        if (i <= endElement) break;
        if (bottomElementsToRender.length >= MAX_BOTTOM_ELEMENTS) break;
        bottomElementsToRender.push(i);
        if (this.hasMeasuredHeight(i)) {
          bottomAccumulatedHeight += this.getMeasuredHeight(i);
          if (bottomAccumulatedHeight >= windowHeight) break;
        } else {
          missingMeasurement = true;
        }
      }
      bottomElementsToRender.reverse();
      if (missingMeasurement) {
        // Still need DOM nodes to measure. Keep them alive across Step 5.
        for (let i = 0; i < bottomElementsToRender.length; i++) {
          this._shouldBeVisibleSet.add(bottomElementsToRender[i]);
        }
      } else {
        // Tail is fully measured — do not keep sentinel rows in the live window.
        bottomElementsToRender.length = 0;
      }
    }

    // STEP 5: Remove elements that are no longer visible
    this._toRemoveArray.length = 0;
    this.currentlyRendered.forEach((element, index) => {
      if (!this._shouldBeVisibleSet.has(index)) {
        this._toRemoveArray.push(index);
        this.placement.detach(container, element);
        this.recycledElements.push(element);
      }
    });
    
    this._toRemoveArray.forEach(index => this.currentlyRendered.delete(index));
    
    // Update tracking
    this.lastStartElement = startElement;
    this.lastEndElement = endElement;
    
    // STEP 6: Render bottom boundary elements for precise end-of-scroll detection
    // only while any tail height is still unknown. After the first measure, the
    // cache (pinned tail) is enough and these nodes are recycled in Step 5.
    this._lastRenderedElement = this.currentlyRendered.get(datasetLastIndex) ?? null;

    if (datasetLastIndex >= 0 && endElement < datasetLastIndex && bottomElementsToRender.length > 0) {
      for (const elemIndex of bottomElementsToRender) {
        let bottomElement: HTMLElement;
        let bottomHeight: number;
        
        if (this.currentlyRendered.has(elemIndex)) {
          // Already in currentlyRendered (kept alive by PRE-STEP 6 marking it visible).
          bottomElement = this.currentlyRendered.get(elemIndex)!;
          this.placement.position(bottomElement, cumulativeTop, 'bottom');
          bottomHeight = this.measureReused(elemIndex, bottomElement);
        } else {
          // First time rendering this bottom boundary row.
          bottomElement = this.acquireRow();
          bottomElement.dataset.elementIndex = String(elemIndex);

          this.placement.attach(container, bottomElement, elemIndex, 'bottom');
          this.placement.position(bottomElement, cumulativeTop, 'bottom');
          renderElement(elemIndex, bottomElement);
          bottomHeight = this.measureNew(elemIndex, bottomElement);

          this.currentlyRendered.set(elemIndex, bottomElement);
        }

        cumulativeTop += bottomHeight;

        if (elemIndex === datasetLastIndex) {
          this._lastRenderedElement = bottomElement;
        }
      }
    }

    // Finalize the frame: a flow strategy shifts the whole window here via a
    // single transform; AbsolutePlacement is a no-op (rows carry their own top).
    this.placement.commit(container, firstRowTop);

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