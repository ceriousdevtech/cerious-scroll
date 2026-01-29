/**
 * @fileoverview Callback Type Definitions for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 */

/**
 * Type definition for element height calculation function
 * @callback ElementHeightCalculator
 * @param {number} index - Zero-based element index
 * @returns {number} Height in pixels for the specified element
 */
export type ElementHeightCalculator = (index: number) => number;

/**
 * Type definition for element rendering and measurement callback
 * @callback ElementRenderer
 * @param {number} index - Zero-based element index
 * @param {HTMLElement} container - Container element to render the element into
 */
export type ElementRenderer = (index: number, container: HTMLElement) => void;