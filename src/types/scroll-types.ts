/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 */

/**
 * Camera position: row index plus pixels into that row (not a pixel from the
 * dataset origin).
 *
 * @property element Zero-based dataset index.
 * @property offset Pixels into that row, in `[0, height - 1]`.
 */
export interface ScrollResult {
  element: number;
  offset: number;
}

/**
 * Snapshot from the last `renderViewport` pass.
 *
 * @property startElement First visible index (inclusive).
 * @property endElement Last visible index (inclusive), including overscan.
 * @property scrollPercentage `0`–`100` along the measured range.
 * @property viewportElements Count of indices in the live window.
 * @property renderedElements `{ index, height }` for this pass. Reused array —
 *   do not retain it across frames.
 * @property totalRenderedHeight Sum of measured heights in this pass.
 */
export interface MeasuredViewportRange {
  startElement: number;
  endElement: number;
  scrollPercentage: number;
  viewportElements: number;
  renderedElements: Array<{index: number, height: number}>;
  totalRenderedHeight: number;
}
