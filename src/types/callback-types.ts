/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 */

/**
 * Resolve a row's height in pixels.
 *
 * @param index Zero-based dataset index.
 * @returns Height in pixels for that row.
 */
export type ElementHeightCalculator = (index: number) => number;

/**
 * Fill `container` for `index`. The engine measures `offsetHeight` after you
 * return — a returned height is ignored.
 *
 * @param index Zero-based dataset index.
 * @param container Row element to populate.
 */
export type ElementRenderer = (index: number, container: HTMLElement) => void;
