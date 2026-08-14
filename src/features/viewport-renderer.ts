/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * Mounts the visible window, measures rows, pools nodes. Positioning is
 * delegated to RowPlacement. Heights come from the DOM (or the uniform hint).
 */

import { ElementRenderer, MeasuredViewportRange } from '../types/index.js';
import { RowPlacement, AbsolutePlacement } from './row-placement.js';

export class ViewportRenderer {
  private static readonly OVERSCAN_BUFFER = 5;
  private static readonly TRUE_BOTTOM_WATCH_RANGE = 400;

  private _lastRenderedElement: HTMLElement | null = null;
  private currentlyRendered = new Map<number, HTMLElement>();
  // Detached nodes reused on the next miss. Content is always re-rendered.
  private recycledElements: HTMLElement[] = [];
  private createdElementsTotal = 0;
  private reusedElementsTotal = 0;
  private lastFrameCreated = 0;
  private lastFrameReused = 0;
  private lastStartElement = -1;
  private lastEndElement = -1;
  private _shouldBeVisibleSet = new Set<number>();
  private _toRemoveArray: number[] = [];
  private _sortedIndicesArray: number[] = [];

  // Reused every frame; the returned snapshot aliases this array.
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

  /** Debug harness only. */
  get renderedElementCount(): number {
    return this.currentlyRendered.size;
  }

  /** Debug harness only. */
  get lastRenderedRange(): { startElement: number; endElement: number } {
    return { startElement: this.lastStartElement, endElement: this.lastEndElement };
  }

  /**
   * @param totalElements Dataset length.
   * @param getCurrentElement Camera row index.
   * @param getScrollOffset Pixels into the camera row.
   * @param getCalculateScrollPercentage Current `0`–`100` position.
   * @param setMeasuredHeight Write a measured row height.
   * @param hasMeasuredHeight Whether a real measurement exists.
   * @param getMeasuredHeight Read a cached height (undefined if missing).
   * @param getUniformHeightHint Detected uniform height, or undefined.
   * @param placement How rows are created and positioned. Default: absolute `top`.
   */
  constructor(
    private totalElements: number,
    private getCurrentElement: () => number,
    private getScrollOffset: () => number,
    private getCalculateScrollPercentage: () => number,
    private setMeasuredHeight: (index: number, height: number) => void,
    private hasMeasuredHeight: (index: number) => boolean,
    private getMeasuredHeight: (index: number) => number,
    // Uniform rows: skip the per-new-row offsetHeight (forced layout).
    private getUniformHeightHint?: () => number | undefined,
    private placement: RowPlacement = new AbsolutePlacement()
  ) {}

  /** Last row from the dataset currently in the DOM, if any. */
  get lastRenderedElement(): HTMLElement | null {
    return this._lastRenderedElement;
  }

  /** Drop mounted-index tracking and the recycle pool. Call when the dataset identity changes. */
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
   * Indices currently mounted.
   * @returns Dataset indices in the live window.
   */
  getRenderedIndices(): number[] {
    return Array.from(this.currentlyRendered.keys());
  }

  /**
   * @param index Dataset index.
   * @returns Live row element, or `null` if not mounted.
   */
  getRenderedElement(index: number): HTMLElement | null {
    return this.currentlyRendered.get(index) || null;
  }

  /**
   * Re-run the host renderer on live rows and re-measure. Needed when height
   * changed in place: the normal pass skips already-rendered indices and would
   * re-read the stale offsetHeight.
   *
   * @param renderElement Same callback passed to `renderViewport`.
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
   * Prefer the cache (avoids layout). On miss, read offsetHeight and write
   * it back — otherwise an in-place height change is lost until the row
   * scrolls out and back.
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
   * Measure a newly rendered row. Uniform hint skips offsetHeight. Cached
   * height is trusted here too (overscan last frame) — no version bump.
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

    // Already measured (was overscan last frame). Skip offsetHeight — that
    // read-after-write layout dominates fast scrollbar-drag frames.
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
   * Fill the window: overscan above, visible rows until height is covered,
   * overscan below. Tail rows are mounted only while their heights are unknown.
   *
   * @param windowHeight Usable viewport height in pixels.
   * @param container Host rows are attached to.
   * @param renderElement `(index, element) => void` — populate the row.
   * @returns Snapshot of the pass. `renderedElements` is reused; do not retain it.
   */
  renderViewport(
    windowHeight: number, 
    container: HTMLElement, 
    renderElement: ElementRenderer
  ): MeasuredViewportRange {
    this.lastFrameCreated = 0;
    this.lastFrameReused = 0;

    const currentElement = this.getCurrentElement();
    const scrollOffset = this.getScrollOffset();
    const startElement = currentElement;
    const offset = scrollOffset;

    // Returned snapshot aliases this array — treat it as ephemeral.
    const renderedRows = this._renderedRowsArray;
    let renderedRowsCount = 0;
    let totalRenderedHeight = 0;

    this._shouldBeVisibleSet.clear();

    if (Math.abs(startElement - this.lastStartElement) > 100) {
      // Pool the live window before clear(). Skipping this used to leak the
      // whole window on every far jump; clear() only detaches, so the
      // references we push stay valid and the rebuild pops them back.
      this.currentlyRendered.forEach((element) => {
        this.recycledElements.push(element);
      });
      this.placement.clear(container);
      this.currentlyRendered.clear();
    }

    this.placement.prepare(container);

    // Overscan above — heights needed to place startElement.
    const bufferStart = Math.max(0, startElement - ViewportRenderer.OVERSCAN_BUFFER);
    let bufferAboveHeight = 0;
    const bufferHeights = this._bufferHeightArray;
    bufferHeights.length = 0;
    
    for (let i = bufferStart; i < startElement; i++) {
      this._shouldBeVisibleSet.add(i);

      let elementToRender: HTMLElement;
      let measuredHeight: number;

      if (this.currentlyRendered.has(i)) {
        elementToRender = this.currentlyRendered.get(i)!;
        measuredHeight = this.measureReused(i, elementToRender);
      } else {
        elementToRender = this.acquireRow();
        elementToRender.dataset.elementIndex = String(i);

        // Position after all buffer heights are known.
        this.placement.attach(container, elementToRender, i, 'window');
        renderElement(i, elementToRender);
        measuredHeight = this.measureNew(i, elementToRender);

        this.currentlyRendered.set(i, elementToRender);
      }

      bufferHeights.push(measuredHeight);
      bufferAboveHeight += measuredHeight;
    }

    // Place buffer rows, then fill the window from startElement.
    let cumulativeTop = -offset - bufferAboveHeight;
    // Most-negative top; table mode applies this once in commit().
    const firstRowTop = cumulativeTop;
    for (let i = bufferStart; i < startElement; i++) {
      const element = this.currentlyRendered.get(i)!;
      this.placement.position(element, cumulativeTop, 'window');
      cumulativeTop += bufferHeights[i - bufferStart];
    }
    
    cumulativeTop = -offset;
    let accumulatedViewportHeight = -offset; // first row is partially scrolled
    let elementIndex = startElement;

    while (elementIndex < this.totalElements && accumulatedViewportHeight < windowHeight) {
      this._shouldBeVisibleSet.add(elementIndex);
      
      let elementToRender: HTMLElement;
      let measuredHeight: number;
      
      if (this.currentlyRendered.has(elementIndex)) {
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

      const entry = renderedRows[renderedRowsCount] ?? (renderedRows[renderedRowsCount] = { index: 0, height: 0 });
      entry.index = elementIndex;
      entry.height = measuredHeight;
      renderedRowsCount++;
      
      totalRenderedHeight += measuredHeight;
      accumulatedViewportHeight += measuredHeight;
      cumulativeTop += measuredHeight;
      elementIndex++;
    }
    
    const bufferEnd = Math.min(this.totalElements - 1, elementIndex + ViewportRenderer.OVERSCAN_BUFFER - 1);
    
    for (let i = elementIndex; i <= bufferEnd; i++) {
      this._shouldBeVisibleSet.add(i);
      
      let elementToRender: HTMLElement;
      let measuredHeight: number;
      
      if (this.currentlyRendered.has(i)) {
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

    // Tail heights exist only for true-bottom. Once cached (and pinned),
    // extra DOM sentinels are recycled rather than repositioned every frame.
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
        // Keep unmeasured tail rows alive through recycle.
        for (let i = 0; i < bottomElementsToRender.length; i++) {
          this._shouldBeVisibleSet.add(bottomElementsToRender[i]);
        }
      } else {
        bottomElementsToRender.length = 0;
      }
    }

    this._toRemoveArray.length = 0;
    this.currentlyRendered.forEach((element, index) => {
      if (!this._shouldBeVisibleSet.has(index)) {
        this._toRemoveArray.push(index);
        this.placement.detach(container, element);
        this.recycledElements.push(element);
      }
    });
    
    this._toRemoveArray.forEach(index => this.currentlyRendered.delete(index));
    
    this.lastStartElement = startElement;
    this.lastEndElement = endElement;

    this._lastRenderedElement = this.currentlyRendered.get(datasetLastIndex) ?? null;

    if (datasetLastIndex >= 0 && endElement < datasetLastIndex && bottomElementsToRender.length > 0) {
      for (const elemIndex of bottomElementsToRender) {
        let bottomElement: HTMLElement;
        let bottomHeight: number;
        
        if (this.currentlyRendered.has(elemIndex)) {
          bottomElement = this.currentlyRendered.get(elemIndex)!;
          this.placement.position(bottomElement, cumulativeTop, 'bottom');
          bottomHeight = this.measureReused(elemIndex, bottomElement);
        } else {
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

    this.placement.commit(container, firstRowTop);

    const scrollPercentage = this.getCalculateScrollPercentage();
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
   * @param totalElements New dataset length.
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
   * Camera position where the last row's bottom meets the viewport bottom.
   * Null until the tail has been measured.
   *
   * @param viewportHeight Usable height in pixels.
   * @returns `{ element, offset }` or `null` if the tail is unmeasured.
   */
  calculateTrueBottomPosition(viewportHeight: number): { element: number; offset: number } | null {
    if (
      this.trueBottomCache &&
      this.trueBottomCache.viewportHeight === viewportHeight &&
      this.trueBottomCache.totalElements === this.totalElements &&
      this.trueBottomCache.measurementVersion === this.bottomMeasurementVersion
    ) {
      return this.trueBottomCache.value;
    }

    const value = this.computeTrueBottomPosition(viewportHeight);
    this.trueBottomCache = {
      viewportHeight,
      totalElements: this.totalElements,
      measurementVersion: this.bottomMeasurementVersion,
      value: value
    };
    return value;
  }

  /**
   * Drop the cached true-bottom camera. Next {@link calculateTrueBottomPosition}
   * recomputes from measured tail heights.
   */
  invalidateTrueBottomCache(): void {
    this.trueBottomCache = null;
  }

  private computeTrueBottomPosition(viewportHeight: number): { element: number; offset: number } | null {
    const lastIndex = this.totalElements - 1;
    if (lastIndex < 0) return null;
    
    let accumulatedHeight = 0;
    let targetElement = lastIndex;
    let targetOffset = 0;

    for (let i = lastIndex; i >= 0; i--) {
      if (!this.hasMeasuredHeight(i)) {
        return null;
      }

      const height = this.getMeasuredHeight(i);

      if (accumulatedHeight + height >= viewportHeight) {
        targetElement = i;
        targetOffset = Math.max(0, accumulatedHeight + height - viewportHeight);
        break;
      }

      accumulatedHeight += height;

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