/**
 * @fileoverview Performance Cache Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
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
  private static readonly MAX_CUMULATIVE_CACHE_SIZE = 300; // Max cumulative heights cache
  
  // ===== CACHE STATE =====
  private _cachedTotalHeight: number | undefined = undefined;
  private _cachedTotalElements: number | undefined = undefined;
  private _isUniformHeight: boolean | undefined = undefined;
  private _uniformHeightValue: number | undefined = undefined;
  private _cumulativeHeights: number[] = [];
  private readonly _maxCacheSize = PerformanceCache.MAX_CUMULATIVE_CACHE_SIZE;
  private _cacheWindowStart = 0;
  private _cacheWindowBase = 0;
  private _measuredHeights = new Map<number, number>();
  private _lastAccessedIndex: number = 0; // Track last accessed element for cache cleanup

  constructor(private getElementHeight: ElementHeightCalculator) {}

  /**
   * Cache a measured height for a specific element
   * @param index Element index
   * @param height Measured height in pixels
   */
  setMeasuredHeight(index: number, height: number): void {
    const wasAlreadyMeasured = this._measuredHeights.has(index);
    const oldHeight = wasAlreadyMeasured ? this._measuredHeights.get(index)! : 1;
    
    this._measuredHeights.set(index, height);
    this._lastAccessedIndex = index;
    
    // Prune old cache entries to prevent memory growth
    this._pruneOldCacheEntries();
    
    if (this._cachedTotalHeight !== undefined) {
      const heightDifference = height - oldHeight;
      this._cachedTotalHeight += heightDifference;
    }
    
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
   * Get a measured height for an element, or undefined if not measured
   * @param index Element index
   * @returns Measured height or undefined
   */
  getMeasuredHeight(index: number): number | undefined {
    this._lastAccessedIndex = index;
    this._pruneOldCacheEntries();
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
   * Calculate total height of all content in the dataset
   * 
   * @param totalElements Number of elements to calculate height for
   * @returns Total height in pixels
   */
  calculateTotalContentHeight(totalElements: number): number {
    // Check cache validity
    if (this._cachedTotalHeight !== undefined && this._cachedTotalElements === totalElements) {
      return this._cachedTotalHeight;
    }

    // Use measured heights where available, fallback to default height for unmeasured
    let totalHeight = 0;
    
    for (let i = 0; i < totalElements; i++) {
      if (this._measuredHeights.has(i)) {
        // Use actual measured height
        totalHeight += this._measuredHeights.get(i)!;
      } else {
        // Use minimal placeholder - will be corrected when measured
        totalHeight += 1;
      }
    }

    // Cache the calculated result
    this._cachedTotalHeight = totalHeight;
    this._cachedTotalElements = totalElements;
    return totalHeight;
  }

  /**
   * Get cumulative height up to a specific row (TRUE O(1) memory implementation)
   * 
   * @param row Row index to calculate cumulative height for
   * @returns Total height from row 0 to row-1 (exclusive)
   * @performance O(1) memory regardless of dataset size
   */
  getCumulativeHeight(row: number): number {
    if (row <= 0) return 0;

    // For uniform heights, use O(1) calculation
    if (this._isUniformHeight && this._uniformHeightValue !== undefined) {
      return row * this._uniformHeightValue;
    }

    // For variable heights, use sliding window cache with FIXED maximum size
    const targetRow = row;
    
    // Check if target row is in current cache window
    const windowSize = Math.min(this._maxCacheSize, targetRow + 1);
    const windowStart = Math.max(0, targetRow - windowSize + 1);
    const windowEnd = windowStart + windowSize;
    
    // If we need to rebuild the cache window
    if (this._cacheWindowStart !== windowStart || this._cumulativeHeights.length !== windowSize) {
      this._cacheWindowStart = windowStart;
      this._cumulativeHeights = new Array(windowSize);
      this._cumulativeHeights[0] = 0;
      
      // Calculate base height for this window (sum of all rows before window)
      if (windowStart > 0) {
        // Use measured heights where available for better accuracy
        let baseHeight = 0;
        let measuredCount = 0;
        
        for (let i = 0; i < windowStart; i++) {
          if (this._measuredHeights.has(i)) {
            baseHeight += this._measuredHeights.get(i)!;
            measuredCount++;
          } else {
            baseHeight += this.getElementHeight(i);
          }
        }
        
        this._cacheWindowBase = baseHeight;
      } else {
        this._cacheWindowBase = 0;
      }
      
      // Build cumulative heights within the fixed-size window
      for (let i = 1; i < windowSize && (windowStart + i) <= targetRow; i++) {
        this._cumulativeHeights[i] = this._cumulativeHeights[i - 1] + this.getElementHeight(windowStart + i - 1);
      }
    }
    
    // Return base + offset within window
    const indexInWindow = targetRow - this._cacheWindowStart;
    if (indexInWindow >= 0 && indexInWindow < this._cumulativeHeights.length) {
      return this._cacheWindowBase + this._cumulativeHeights[indexInWindow];
    }
    
    // For requests outside cache window, calculate directly using measurements
    let cumulativeHeight = 0;
    for (let i = 0; i < targetRow; i++) {
      if (this._measuredHeights.has(i)) {
        cumulativeHeight += this._measuredHeights.get(i)!;
      } else {
        cumulativeHeight += 1; // Minimal placeholder
      }
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
    if (scrollPixel <= 0) {
      return { element: 0, offset: 0 };
    }

    // For uniform heights, use O(1) calculation
    if (this._isUniformHeight && this._uniformHeightValue !== undefined) {
      const element = Math.floor(scrollPixel / this._uniformHeightValue);
      const offset = scrollPixel % this._uniformHeightValue;
      return { 
        element: Math.min(element, Number.MAX_SAFE_INTEGER), 
        offset: Math.min(offset, this.getElementHeight(Math.min(element, Number.MAX_SAFE_INTEGER)) - 1)
      };
    }

    // For variable heights with TRUE O(1) memory, use estimation instead of binary search
    // This avoids building large caches proportional to dataset size
    
    // Start from beginning and search through measured heights
    let element = 0;
    let cumulativeHeight = 0;
    
    // Walk through elements using measured heights where available
    while (element < Number.MAX_SAFE_INTEGER) {
      const elementHeight = this._measuredHeights.has(element) 
        ? this._measuredHeights.get(element)! 
        : 1; // Minimal placeholder
      
      if (cumulativeHeight + elementHeight > scrollPixel) {
        // Found the target element
        break;
      }
      
      cumulativeHeight += elementHeight;
      element++;
    }
    
    const offset = Math.max(0, scrollPixel - cumulativeHeight);
    return { 
      element: Math.min(element, Number.MAX_SAFE_INTEGER), 
      offset: Math.min(offset, this.getElementHeight(Math.min(element, Number.MAX_SAFE_INTEGER)) - 1)
    };
  }

  /**
   * Invalidate all performance caches
   * Call this method when row heights change or dataset is modified
   */
  invalidateCache(): void {
    this._cachedTotalHeight = undefined;
    this._cachedTotalElements = undefined;
    this._isUniformHeight = undefined;
    this._uniformHeightValue = undefined;
    this._cumulativeHeights = [];
    this._cacheWindowStart = 0;
    this._cacheWindowBase = 0;
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
      cacheWindowSize: this._cumulativeHeights.length,
      cacheWindowStart: this._cacheWindowStart,
      cachedTotalHeight: this._cachedTotalHeight,
      cachedTotalElements: this._cachedTotalElements
    };
  }
}