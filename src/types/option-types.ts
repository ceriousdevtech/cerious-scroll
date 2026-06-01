/**
 * @fileoverview Configuration Option Types for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 */

/**
 * Configuration options for CeriousScroll keyboard navigation
 */
export interface KeyboardNavigationOptions {
  /** Enable/disable keyboard navigation (default: true) */
  enabled?: boolean;
  /** Custom keyboard event handler - return true to prevent default behavior */
  onKeyDown?: (event: KeyboardEvent, scroller: any) => boolean;
  /** Scroll speed for arrow keys in pixels (default: 120) */
  arrowKeySpeed?: number;
  /** Scroll speed for page keys as viewport fraction (default: 1.0) */
  pageKeySpeed?: number;
}

/**
 * Configuration options for touch navigation
 */
export interface TouchNavigationOptions {
  /** Enable/disable touch navigation (default: true) */
  enabled?: boolean;
  /** Enable momentum/inertia scrolling (default: true) */
  enableMomentum?: boolean;
  /** Friction coefficient for momentum decay (0-1, default: 0.95) */
  momentumFriction?: number;
  /** Minimum velocity to trigger momentum in px/ms (default: 0.1) */
  momentumThreshold?: number;
}

/**
 * Configuration options for wheel navigation
 */
export interface WheelNavigationOptions {
  /** Enable/disable wheel navigation (default: true) */
  enabled?: boolean;

  /**
   * Emit the 'cerious-viewport-change' CustomEvent on the container.
   * Default: true (keeps existing behavior).
   */
  emitViewportChangeEvent?: boolean;

  /**
   * Coalesce multiple wheel events into a single viewport-change event per animation frame.
   * Reduces allocation and event dispatch overhead under heavy wheel input.
   * Default: false (keeps existing timing semantics).
   */
  coalesceViewportChangeEvent?: boolean;
}

/**
 * Configuration options for CeriousScroll
 */
export interface CeriousScrollOptions {
  /** Keyboard navigation configuration */
  keyboard?: KeyboardNavigationOptions;
  /** Touch navigation configuration */
  touch?: TouchNavigationOptions;
  /** Wheel navigation configuration */
  wheel?: WheelNavigationOptions;
  /** Enable/disable automatic native scrollbar attachment (default: true) */
  attachScrollbar?: boolean;
  /** Enable/disable automatic resize handling (default: true) */
  autoResize?: boolean;
  /** Enable/disable automatic detection of content changes that affect element heights (default: true) */
  observeContentChanges?: boolean;
  /** Callback invoked after each scroll event for rendering */
  onScroll?: () => void;
}