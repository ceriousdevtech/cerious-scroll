/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 */

import type { TableFlowOptions } from '../features/row-placement.js';

/**
 * Row layout / placement mode.
 *
 * - `'absolute'` (default): each row is an out-of-flow `position: absolute`
 *   element positioned by its own `top`. No GPU transforms. CeriousScroll's
 *   original model.
 * - `'table'`: rows render as real `<tr>`/`<td>` in one shared `<table>` and the
 *   window is shifted with a single `transform: translateY()` on the `<tbody>`.
 *   Enables native column synchronization (and a shared-column header) at the
 *   cost of an opt-in GPU compositor layer. Pair with {@link CeriousScrollOptions.table}.
 * - `'masonry'`: cards flow into the shortest of N columns, each keeping its own
 *   height. The engine scrolls over segments while the DOM mounts individual
 *   cards. Comes in two variants with DIFFERENT determinism guarantees — see
 *   {@link MasonryDeterminism}. Pair with {@link CeriousScrollOptions.masonry}.
 */
export type RowLayoutMode = 'absolute' | 'table' | 'masonry';

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
   */
  smooth?: boolean;

  /**
   * Pixel delta at or above which a wheel event is treated as a discrete mouse
   * notch and applied INSTANTLY, bypassing `smooth`. Default: 100.
   *
   * The default exists because a mouse wheel that keeps gliding after the user
   * stops feels wrong, and one notch is only a few 40px rows. When rows are
   * large — a masonry card, a media tile — a notch moves most of a viewport and
   * reads as a teleport. Raise this (or set `Infinity`) to ease every delta.
   */
  notchThresholdPx?: number;
  /**
   * Per-frame interpolation factor for smooth wheel scrolling (0-1). Larger
   * values consume the remaining delta faster (snappier); smaller values feel
   * gentler. Default: 0.22 (~tracks native macOS feel).
   */
  smoothFactor?: number;
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
  /**
   * Row placement mode (default: `'absolute'`). Set to `'table'` to render rows
   * as native `<tr>`/`<td>` in one shared `<table>` with auto-synced columns.
   * @see RowLayoutMode
   */
  layout?: RowLayoutMode;
  /**
   * Options for `layout: 'table'` mode (header populator, class names). Ignored
   * when `layout` is `'absolute'`.
   */
  table?: TableFlowOptions;
  /**
   * Replace DOM measurement with a computed height source. See
   * {@link HeightProvider}. Leave unset for normal measured-row behavior.
   *
   * Set automatically by `layout: 'masonry'`; supplying both is an error.
   */
  heightProvider?: HeightProvider;
  /**
   * Options for `layout: 'masonry'`. Required in that mode, ignored otherwise.
   */
  masonry?: MasonryOptions;
}

/**
 * Which determinism guarantee a masonry layout provides.
 *
 * These are two different products, not a feature and its degraded fallback.
 * Choosing between them is choosing which property matters more, and the answer
 * is a property of your CONTENT, not of your taste.
 *
 * - `'canonical'` — ORACLE mode, selected by supplying
 *   {@link MasonryOptions.getItemHeight}. Every card has one true position,
 *   derived from the whole dataset. Card N is in the same column no matter how
 *   the viewer arrived, so positions are shareable, linkable and reproducible
 *   across sessions and across users. Paid for with preprocessing: the column
 *   frontier is walked from card 0, and reaching a distant card evaluates a
 *   height for every card before it. That walk is pure arithmetic and touches no
 *   DOM, but it is O(n) and its state is O(n / segmentSize).
 *
 * - `'local'` — DYNAMIC mode, selected by OMITTING `getItemHeight`. Heights come
 *   from the DOM, so no card can be priced without being built, and pricing
 *   every card before a distant one is not an option. Random access is instead
 *   constant-time: a landing far from anything already laid out starts a fresh
 *   run with level columns. The layout is deterministic within a run and always
 *   a valid masonry — uniform gutters, balanced columns, no overlap — but which
 *   column a given card occupies may depend on how the viewer got there. Two
 *   viewers reaching card N by different routes can legitimately see it in
 *   different columns.
 *
 * Pick `'canonical'` when a card's position is part of your product — deep
 *   links, shared coordinates, screenshot-stable layouts, or content whose height
 *   is known from intrinsic dimensions.
 * Pick `'local'` when height is only knowable by rendering, which is most text.
 */
export type MasonryDeterminism = 'canonical' | 'local';

/**
 * Configuration for `layout: 'masonry'`.
 *
 * In this mode the constructor's `totalElements` is the number of CARDS. The
 * engine internally scrolls over segments of {@link segmentSize} cards, but that
 * is not visible through the API: {@link CeriousScrollOptions.onScroll},
 * `renderViewport`, and `jumpToItem` all speak in card indices.
 */
export interface MasonryOptions {
  /**
   * Height of a card at a given column width — the ORACLE mode.
   *
   * Must be PURE: it is called for cards that are not in the DOM, including
   * cards far from the viewport, so it cannot measure. Suits media with a known
   * intrinsic aspect ratio, where this is `(h / w) * columnWidth + chrome`.
   *
   * OMIT IT to get DYNAMIC-HEIGHT mode, where heights are measured from the DOM
   * exactly like the default row engine. That mode places no constraint on
   * content, at the cost described in {@link maxChainSegments}.
   *
   * @param index Card index.
   * @param columnWidth Current column width in pixels.
   * @returns Height in pixels.
   */
  getItemHeight?: (index: number, columnWidth: number) => number;
  /**
   * Dynamic-height mode only. Height assumed for a card that has not been
   * measured yet, used for segments the camera has not reached. Default: 300.
   *
   * Only ever affects segment heights the engine has not learned, in the same
   * way an unmeasured row does today. It never affects a card's drawn position:
   * a card is measured before it is placed.
   */
  estimatedItemHeight?: number;
  /**
   * Dynamic-height mode only. How far the column frontier may be chained
   * forward to reach a segment that has not been laid out yet. Default: 4.
   *
   * Chaining costs one measurement per card crossed, so it is affordable across
   * a few segments (ordinary scrolling) and not across thousands (a scrollbar
   * drag into never-visited content). Beyond this distance the landing segment
   * starts from level columns instead — see the note on jumps in
   * `docs/MASONRY.md`.
   */
  maxChainSegments?: number;
  /** Populate a card element. Called once per mount, not per frame. */
  renderItem: (index: number, element: HTMLElement) => void;
  /** Gutter between cards, both axes. Default: 16. */
  gap?: number;
  /** Fixed column count. Omit for a responsive count from {@link targetColumnWidth}. */
  columns?: number;
  /** Preferred column width driving the responsive count. Default: 280. */
  targetColumnWidth?: number;
  /** Lower bound for the responsive column count. Default: 1. */
  minColumns?: number;
  /** Upper bound for the responsive column count. Default: 8. */
  maxColumns?: number;
  /**
   * Cards per segment. Trades snapshot memory against the cost of reaching a
   * cold position: larger means fewer snapshots and a longer chain. Default: 500.
   */
  segmentSize?: number;
  /** Extra pixels rendered above and below the viewport. Default: 400. */
  overscan?: number;
  /**
   * Milliseconds of chain rebuilding per frame after a relayout. Lower keeps
   * frames free at the cost of a longer rebuild. Default: 6.
   */
  rebuildSliceMs?: number;
}
/**
 * Authoritative height source, replacing the measured-height cache.
 *
 * The default engine measures rows from the DOM and keeps a bounded sliding
 * window of what it saw — correct when heights are only knowable by measuring,
 * and when there are far more rows than fit in a cache. A layout model that can
 * COMPUTE heights (masonry from intrinsic aspect ratios, a virtualized
 * timeline, anything with a formula) wants the opposite: heights are exact,
 * cheap, and must never be evicted.
 *
 * Supplying this puts {@link PerformanceCache} in authoritative mode — no map,
 * no pruning, no uniform-height detection, and `setMeasuredHeight` becomes a
 * no-op because the DOM is no longer the source of truth.
 */
export interface HeightProvider {
  /**
   * @param index Element index.
   * @returns Height in pixels. Must be finite and > 0.
   */
  height(index: number): number;
  /**
   * Sum of heights for `[0, index)`. Optional but strongly recommended: without
   * it the engine falls back to summing `height()` from 0, which is O(n) on
   * every scrollbar sync. Models that keep prefix sums can answer in O(1).
   *
   * @param index Exclusive end index.
   * @returns Pixels from the top of the dataset.
   */
  cumulativeHeight?(index: number): number;
  /**
   * Inverse of {@link cumulativeHeight}. Optional; falls back to a linear walk.
   *
   * @param pixels Distance from the top of the dataset.
   * @returns Element containing that pixel, and the offset into it.
   */
  rowAtPosition?(pixels: number): { element: number; offset: number };
  /**
   * Total scrollable content height, if known. Used to size the native
   * scrollbar strip by CONTENT rather than by element count — necessary when an
   * "element" is much larger than a row, or the strip loses resolution and the
   * scroll position quantizes.
   *
   * @returns Pixels, or undefined to keep element-count sizing.
   */
  totalHeight?(): number | undefined;
}
