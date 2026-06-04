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
  /**
   * Optional resolver for a sibling element that owns horizontal native scroll
   * (i.e. `overflow-x: scroll`). When provided, the controller performs axis
   * detection on the first significant touch movement; if the gesture is
   * horizontal-dominant, deltaX is forwarded to the returned element's
   * scrollLeft (instead of vertical scrolling), enabling mobile horizontal
   * scrolling without disabling vertical touch.
   */
  getHorizontalScrollTarget?: () => HTMLElement | null | undefined;
  /**
   * Pixel distance the touch must travel before the controller locks the
   * gesture to an axis. Default: 8.
   */
  axisLockThreshold?: number;
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

  /**
   * Animate wheel deltas over multiple frames instead of applying them
   * instantly. Matches the smooth feel of native browser overflow scrolling,
   * where one wheel notch eases over ~150ms. Default: true.
   *
   * Back-compat: `smooth: false` is equivalent to `wheelBehavior: 'immediate'`.
   * When `wheelBehavior` is set, it takes precedence over `smooth`.
   */
  smooth?: boolean;

  /**
   * Per-frame interpolation factor for smooth wheel scrolling (0-1). Larger
   * values consume the remaining delta faster (snappier); smaller values feel
   * gentler. Default: 0.22 (~tracks native macOS feel).
   */
  smoothFactor?: number;

  /**
   * How wheel/trackpad input is applied to the scroll engine.
   *
   * - `'auto'` (default): classify each event as trackpad or mouse wheel. Trackpad
   *   input is applied immediately (its OS already adds momentum, so layering
   *   custom smoothing on top causes delayed overscroll). Mouse wheel input
   *   is animated for smooth motion across each ~100px notch.
   * - `'immediate'`: never smooth. Every event is applied synchronously.
   * - `'smooth'`: always smooth, regardless of input device.
   */
  wheelBehavior?: 'auto' | 'immediate' | 'smooth';
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