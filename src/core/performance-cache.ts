/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * Sliding-window height map. Writes prune; reads do not. Tail indices are
 * pinned so true-bottom survives a prune while the camera is at the top.
 */

import { ElementHeightCalculator, HeightProvider } from '../types/index.js';

export class PerformanceCache {
  private static readonly MAX_MEASURED_HEIGHTS_CACHE = 200;
  private static readonly CACHE_PRUNE_THRESHOLD = 250;
  // True-bottom walks backward from the last row. If those heights are
  // pruned while the camera is at the top, the renderer remounts ~50
  // sentinel rows every frame. Pin a small tail so that cannot happen.
  private static readonly TAIL_PIN_COUNT = 80;

  private _isUniformHeight: boolean | undefined = undefined;
  private _uniformHeightValue: number | undefined = undefined;
  private _measuredHeights = new Map<number, number>();
  private _lastAccessedIndex: number = 0;
  // Upper bound on element count, used to keep linear walks bounded. 0 means
  // "unknown"; in that case the cache falls back to its previous behavior.
  private _totalElements = 0;

  /**
   * @param getElementHeight Height lookup used when a row has no measured value
   *   (walks such as {@link findRowFromScrollPosition}).
   * @param provider Optional authoritative height source. When supplied, the
   *   measured-height map and its pruning are bypassed entirely — heights are
   *   computed, not observed, so evicting them would be lossy rather than
   *   merely cold. See {@link HeightProvider}.
   */
  constructor(
    private getElementHeight: ElementHeightCalculator,
    private readonly provider?: HeightProvider
  ) {}

  /**
   * Tell the cache how many elements exist in the dataset. Used to bound
   * linear walks (e.g. findRowFromScrollPosition) so a malformed scroll
   * position can never spin past the dataset.
   *
   * @param totalElements Dataset length. Ignored if not a finite >= 0 number.
   */
  setTotalElements(totalElements: number): void {
    if (!Number.isFinite(totalElements) || totalElements < 0) return;
    this._totalElements = Math.floor(totalElements);
  }

  /**
   * @param index Dataset index.
   * @param height Pixels. Non-finite / negative becomes 1px (detached-node `offsetHeight`).
   */
  setMeasuredHeight(index: number, height: number): void {
    // A provider is the source of truth; DOM measurements are advisory noise.
    if (this.provider) return;
    // NaN/Infinity would poison total-height math for the rest of the session.
    if (!Number.isFinite(index) || index < 0) {
      return;
    }
    if (!Number.isFinite(height) || height < 0) {
      // Fall back to a 1px placeholder rather than throwing; the caller is
      // typically `offsetHeight` which can occasionally yield 0 during
      // measurement of detached/zero-height nodes.
      height = 1;
    }

    this._measuredHeights.set(index, height);
    this._lastAccessedIndex = index;

    this._pruneOldCacheEntries();

    if (this._isUniformHeight === undefined && this._measuredHeights.size >= 10) {
      // Don't Array.from the map just to compare values.
      let firstHeight: number | undefined;
      let allSame = true;
      for (const height of this._measuredHeights.values()) {
        if (firstHeight === undefined) {
          firstHeight = height;
        } else if (height !== firstHeight) {
          allSame = false;
          break;
        }
      }
      
      // 1px placeholders are measurement failures, not real uniform rows.
      if (allSame && firstHeight !== undefined && firstHeight > 1) {
        this._isUniformHeight = true;
        this._uniformHeightValue = firstHeight;
      } else if (!allSame) {
        this._isUniformHeight = false;
      }
    }
  }

  /**
   * @param index Dataset index.
   * @returns Whether a real measurement exists (not an estimate).
   */
  hasMeasuredHeight(index: number): boolean {
    if (this.provider) return true; // every index has a computable height
    return this._measuredHeights.has(index);
  }

  /**
   * Detected uniform row height, or undefined. Lets the renderer skip
   * offsetHeight on new rows during fast scroll.
   *
   * @returns Height in pixels, or `undefined` if rows are not known to be uniform.
   */
  getUniformHeightHint(): number | undefined {
    // The hint lets the renderer skip offsetHeight. With a provider there is no
    // offsetHeight read to skip, and claiming uniformity would make the engine
    // extrapolate positions arithmetically from one height.
    if (this.provider) return undefined;
    return this._isUniformHeight === true ? this._uniformHeightValue : undefined;
  }

  /**
   * Hot path: Map.get only. Prune on write, not here.
   *
   * @param index Dataset index.
   * @returns Measured height in pixels, or `undefined` if never measured.
   */
  getMeasuredHeight(index: number): number | undefined {
    if (this.provider) return this.provider.height(index);
    return this._measuredHeights.get(index);
  }
  
  private _pruneOldCacheEntries(): void {
    const tailStart = this._totalElements > 0
      ? Math.max(0, this._totalElements - PerformanceCache.TAIL_PIN_COUNT)
      : Number.POSITIVE_INFINITY;
    const tailBudget = this._totalElements > 0 ? PerformanceCache.TAIL_PIN_COUNT : 0;

    if (this._measuredHeights.size <= PerformanceCache.CACHE_PRUNE_THRESHOLD + tailBudget) {
      return;
    }

    const keepWindow = PerformanceCache.MAX_MEASURED_HEIGHTS_CACHE / 2;
    const minKeep = Math.max(0, this._lastAccessedIndex - keepWindow);
    const maxKeep = this._lastAccessedIndex + keepWindow;
    
    for (const [index] of this._measuredHeights) {
      if (index >= tailStart) continue;
      if (index < minKeep || index > maxKeep) {
        this._measuredHeights.delete(index);
      }
    }
    
    const maxSize = PerformanceCache.MAX_MEASURED_HEIGHTS_CACHE + tailBudget;
    if (this._measuredHeights.size > maxSize) {
      const entries: Array<[number, number]> = [];
      for (const entry of this._measuredHeights.entries()) {
        entries.push(entry);
      }
      
      entries.sort((a, b) => {
        const aTail = a[0] >= tailStart ? 0 : 1;
        const bTail = b[0] >= tailStart ? 0 : 1;
        if (aTail !== bTail) return aTail - bTail;
        const distA = Math.abs(a[0] - this._lastAccessedIndex);
        const distB = Math.abs(b[0] - this._lastAccessedIndex);
        return distA - distB;
      });
      
      this._measuredHeights.clear();
      for (let i = 0; i < maxSize && i < entries.length; i++) {
        this._measuredHeights.set(entries[i][0], entries[i][1]);
      }
    }
  }

  /**
   * Sum of heights from row 0 up to, but not including, `row`.
   *
   * @param row Exclusive end index.
   * @returns Pixels. Unmeasured rows contribute 1px.
   */
  getCumulativeHeight(row: number): number {
    if (row <= 0) return 0;

    if (this.provider) {
      if (this.provider.cumulativeHeight) return this.provider.cumulativeHeight(row);
      let sum = 0;
      for (let i = 0; i < row; i++) sum += this.provider.height(i);
      return sum;
    }

    if (this._isUniformHeight && this._uniformHeightValue !== undefined) {
      return row * this._uniformHeightValue;
    }

    let cumulativeHeight = 0;
    for (let i = 0; i < row; i++) {
      const measured = this._measuredHeights.get(i);
      cumulativeHeight += measured !== undefined ? measured : 1;
    }
    return cumulativeHeight;
  }

  /**
   * @param scrollPixel Distance from the top of the dataset in pixels.
   * @returns `{ element, offset }` for that pixel. Unmeasured rows are 1px.
   */
  findRowFromScrollPosition(scrollPixel: number): { element: number; offset: number } {
    if (!Number.isFinite(scrollPixel) || scrollPixel <= 0) {
      return { element: 0, offset: 0 };
    }

    if (this.provider?.rowAtPosition) {
      return this.provider.rowAtPosition(scrollPixel);
    }

    // Upper bound for any walk. Without an explicit total we fall back to the
    // largest known measured index; if even that's unknown we cap at a
    // generous-but-bounded value so a malformed input can never hot-loop.
    const maxElementIndex = this._totalElements > 0
      ? this._totalElements - 1
      : (this._measuredHeights.size > 0
          ? Math.max(...this._measuredHeights.keys()) + 1
          : 1_000_000);

    if (this._isUniformHeight && this._uniformHeightValue !== undefined && this._uniformHeightValue > 0) {
      let element = Math.floor(scrollPixel / this._uniformHeightValue);
      element = Math.min(element, maxElementIndex);
      const offset = scrollPixel - element * this._uniformHeightValue;
      const clampedOffset = Math.max(
        0,
        Math.min(offset, Math.max(1, this.getElementHeight(element)) - 1)
      );
      return { element, offset: clampedOffset };
    }

    let element = 0;
    let cumulativeHeight = 0;
    while (element <= maxElementIndex) {
      const elementHeight = this._measuredHeights.has(element)
        ? this._measuredHeights.get(element)!
        : 1;

      if (cumulativeHeight + elementHeight > scrollPixel) {
        break;
      }

      cumulativeHeight += elementHeight;
      element++;
    }

    if (element > maxElementIndex) {
      element = maxElementIndex;
    }

    const elementHeight = Math.max(1, this.getElementHeight(element));
    const offset = Math.max(0, Math.min(scrollPixel - cumulativeHeight, elementHeight - 1));
    return { element, offset };
  }

  invalidateCache(): void {
    this._isUniformHeight = undefined;
    this._uniformHeightValue = undefined;
    // Heights stay — they are still valid measurements.
  }

  /** Dataset identity changed, not just a resize. */
  clearAllCaches(): void {
    this.invalidateCache();
    this._measuredHeights.clear();
  }

  /** Whether an authoritative height source replaced DOM measurement. */
  get hasHeightProvider(): boolean {
    return this.provider !== undefined;
  }

  /**
   * Total content height from the provider, if it knows one.
   * @returns Pixels, or `undefined`.
   */
  getProvidedTotalHeight(): number | undefined {
    return this.provider?.totalHeight ? this.provider.totalHeight() : undefined;
  }

  /**
   * @returns Debug snapshot of cache size and uniform-height detection.
   */
  getCacheStats() {
    return {
      measuredElements: this._measuredHeights.size,
      isUniformHeight: this._isUniformHeight,
      uniformHeightValue: this._uniformHeightValue,
      cacheWindowSize: 0,
      cacheWindowStart: 0
    };
  }
}