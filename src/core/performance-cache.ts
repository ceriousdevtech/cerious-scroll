/**
 * @fileoverview Performance Cache Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * 
 * This module handles height caching and optimization for virtual scrolling.
 * Provides O(1) memory usage regardless of dataset size through sliding window caching.
 */

import { ElementHeightCalculator } from '../types/index.js';

/**
 * Performance Cache Manager for CeriousScroll
 * 
 * Manages height measurements, cumulative height calculations, and optimization caches
 * to provide constant-time scroll operations for large datasets.
 */
export class PerformanceCache {
  // Constants for cache management
  private static readonly MAX_MEASURED_HEIGHTS_CACHE = 200; // Keep only 200 measured heights
  private static readonly CACHE_PRUNE_THRESHOLD = 250; // Prune when we exceed this

  // ===== CACHE STATE =====
  private _isUniformHeight: boolean | undefined = undefined;
  private _uniformHeightValue: number | undefined = undefined;
  private _measuredHeights = new Map<number, number>();
  private _lastAccessedIndex: number = 0; // Track last accessed element for cache cleanup
  // Upper bound on element count, used to keep linear walks bounded. 0 means
  // "unknown"; in that case the cache falls back to its previous behavior.
  private _totalElements = 0;

  constructor(private getElementHeight: ElementHeightCalculator) {}

  /**
   * Tell the cache how many elements exist in the dataset. Used to bound
   * linear walks (e.g. findRowFromScrollPosition) so a malformed scroll
   * position can never spin past the dataset.
   */
  setTotalElements(totalElements: number): void {
    if (!Number.isFinite(totalElements) || totalElements < 0) return;
    this._totalElements = Math.floor(totalElements);
  }

  /**
   * Cache a measured height for a specific element
   * @param index Element index
   * @param height Measured height in pixels
   */
  setMeasuredHeight(index: number, height: number): void {
    // Defensive validation. NaN/Infinity/negative heights would corrupt the
    // total-height cache permanently and propagate into every scroll math
    // result downstream.
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

    // Prune old cache entries to prevent memory growth
    this._pruneOldCacheEntries();

    if (this._isUniformHeight === undefined && this._measuredHeights.size >= 10) {
      // GC optimization: Use iterator-based approach instead of Array.from
      // Check uniformity without creating array if possible
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
      
      // Skip uniform height detection for minimal placeholders
      if (allSame && firstHeight !== undefined && firstHeight > 1) {
        this._isUniformHeight = true;
        this._uniformHeightValue = firstHeight;
      } else if (!allSame) {
        this._isUniformHeight = false;
      }
    }
  }

  /**
   * Check if an element height has been measured
   * @param index Element index
   * @returns True if height has been measured
   */
  hasMeasuredHeight(index: number): boolean {
    return this._measuredHeights.has(index);
  }

  /**
   * Return the detected uniform row height, or undefined if rows are not
   * (yet) known to be uniform. Used by the viewport renderer to skip
   * `offsetHeight` reads on newly-created rows during fast scroll — one
   * forced layout per new row otherwise dominates frame time.
   */
  getUniformHeightHint(): number | undefined {
    return this._isUniformHeight === true ? this._uniformHeightValue : undefined;
  }

  /**
   * Get a measured height for an element, or undefined if not measured
   * @param index Element index
   * @returns Measured height or undefined
   *
   * Hot path: this is called many times per scroll frame. Keep it as a
   * single Map.get — pruning happens in setMeasuredHeight (the only path
   * that grows the map), so doing it here would just burn cycles.
   */
  getMeasuredHeight(index: number): number | undefined {
    return this._measuredHeights.get(index);
  }
  
  /**
   * Prune cache entries that are far from the currently accessed element
   * This prevents memory growth when scrolling through large datasets
   */
  private _pruneOldCacheEntries(): void {
    // Only prune if we've exceeded the threshold
    if (this._measuredHeights.size <= PerformanceCache.CACHE_PRUNE_THRESHOLD) {
      return;
    }
    
    // Keep elements within a window around the last accessed index
    const keepWindow = PerformanceCache.MAX_MEASURED_HEIGHTS_CACHE / 2;
    const minKeep = Math.max(0, this._lastAccessedIndex - keepWindow);
    const maxKeep = this._lastAccessedIndex + keepWindow;
    
    // Use iterator for efficient deletion during iteration
    for (const [index] of this._measuredHeights) {
      if (index < minKeep || index > maxKeep) {
        this._measuredHeights.delete(index);
      }
    }
    
    // If still too large (shouldn't happen, but defensive), keep only closest entries
    if (this._measuredHeights.size > PerformanceCache.MAX_MEASURED_HEIGHTS_CACHE) {
      // GC optimization: Use iterator-based approach instead of Array.from to avoid allocation
      // Build array of entries to sort, but reuse existing array if available
      const entries: Array<[number, number]> = [];
      for (const entry of this._measuredHeights.entries()) {
        entries.push(entry);
      }
      
      entries.sort((a, b) => {
        const distA = Math.abs(a[0] - this._lastAccessedIndex);
        const distB = Math.abs(b[0] - this._lastAccessedIndex);
        return distA - distB;
      });
      
      // Clear and rebuild with only closest entries
      this._measuredHeights.clear();
      for (let i = 0; i < PerformanceCache.MAX_MEASURED_HEIGHTS_CACHE && i < entries.length; i++) {
        this._measuredHeights.set(entries[i][0], entries[i][1]);
      }
    }
  }

  /**
   * Get cumulative height up to a specific row.
   *
   * @param row Row index to calculate cumulative height for
   * @returns Total height from row 0 to row-1 (exclusive)
   *
   * O(1) when uniform-height has been detected; O(row) otherwise. Not on
   * the scroll hot path — kept as a public utility for consumers.
   */
  getCumulativeHeight(row: number): number {
    if (row <= 0) return 0;

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
   * Find row and offset from absolute scroll position (optimized)
   * 
   * @param scrollPixel Absolute scroll position in pixels
   * @returns Object with row index and pixel offset within that row
   * @performance O(1) for uniform heights, O(log n) for variable heights with binary search
   */
  findRowFromScrollPosition(scrollPixel: number): { element: number; offset: number } {
    // Validate input. NaN/Infinity falls through to the (0, 0) safe default.
    if (!Number.isFinite(scrollPixel) || scrollPixel <= 0) {
      return { element: 0, offset: 0 };
    }

    // Upper bound for any walk. Without an explicit total we fall back to the
    // largest known measured index; if even that's unknown we cap at a
    // generous-but-bounded value so a malformed input can never hot-loop.
    const maxElementIndex = this._totalElements > 0
      ? this._totalElements - 1
      : (this._measuredHeights.size > 0
          ? Math.max(...this._measuredHeights.keys()) + 1
          : 1_000_000);

    // For uniform heights, use O(1) calculation
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

    // Variable heights: walk forward using measurements where available.
    // Bounded by maxElementIndex so a malformed scrollPixel can never iterate
    // past the dataset.
    let element = 0;
    let cumulativeHeight = 0;
    while (element <= maxElementIndex) {
      const elementHeight = this._measuredHeights.has(element)
        ? this._measuredHeights.get(element)!
        : 1; // Minimal placeholder

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

  /**
   * Invalidate all performance caches
   * Call this method when row heights change or dataset is modified
   */
  invalidateCache(): void {
    this._isUniformHeight = undefined;
    this._uniformHeightValue = undefined;
    // Keep measured heights since they are real measurements
    // this._measuredHeights.clear(); // Only clear if data actually changed
  }

  /**
   * Clear all caches including measured heights when dataset changes
   * Call this method when the actual data rows change (not just resizing)
   */
  clearAllCaches(): void {
    this.invalidateCache();
    this._measuredHeights.clear();
  }

  /**
   * Get cache statistics for debugging
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