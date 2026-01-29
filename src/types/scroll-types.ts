/**
 * @fileoverview Scroll-related Type Definitions for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 */

/**
 * Type definition for scroll position result
 * @interface ScrollResult
 * @property {number} element - Current element index
 * @property {number} offset - Pixel offset within the element
 */
export interface ScrollResult {
  element: number;
  offset: number;
}

/**
 * Type definition for measured viewport range with actual rendered elements
 * @interface MeasuredViewportRange
 * @property {number} startElement - First visible element index (inclusive)
 * @property {number} endElement - Last visible element index (inclusive)
 * @property {number} scrollPercentage - Current scroll position percentage (0-100)
 * @property {number} viewportElements - Total number of elements visible in viewport
 * @property {Array<{index: number, height: number}>} renderedElements - Array of rendered elements with measured heights (no DOM references)
 * @property {number} totalRenderedHeight - Sum of all rendered element heights
 */
export interface MeasuredViewportRange {
  startElement: number;
  endElement: number;
  scrollPercentage: number;
  viewportElements: number;
  renderedElements: Array<{index: number, height: number}>;
  totalRenderedHeight: number;
}