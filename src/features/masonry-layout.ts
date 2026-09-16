/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * Column geometry for `layout: 'masonry'`.
 *
 * Serves both determinism modes (see `MasonryDeterminism`). The difference is
 * not in this file's algorithm but in how far the caller lets the frontier chain
 * run: canonical mode chains from card 0 so a position is a function of the
 * dataset, while local mode anchors at the landing so random access is constant
 * time. {@link anchorFlushAt} is the primitive that expresses that choice.
 *
 * Masonry is path-dependent: which column an item lands in depends on the
 * column frontier left by every item before it. Storing that per item is O(n)
 * memory, which the scroller refuses. Storing it per *segment* is not: this
 * keeps the real column frontier every K items — `columns` floats per snapshot
 * — and resumes the next run from it.
 *
 * The result is bit-identical to laying out every item in one pass from index
 * 0, so there is no seam anywhere and every gutter is exactly `gap`. The costs
 * are a snapshot table of `columns * (n / segmentSize)` floats (~12KB for 1M
 * items at the default K) and a sequential walk to reach a cold position, which
 * {@link MasonryLayout.chainAhead} spreads across frames.
 *
 * Heights come from {@link MasonryOptions.getItemHeight}, never from the DOM.
 * Segment replay must price items that were never mounted — a scrollbar drag
 * landing mid-dataset — so measuring is not available to it. In exchange the
 * scroll path performs no layout reads at all.
 */

import type { MasonryOptions } from '../types/index.js';

/** Geometry for one placed card, relative to its segment's origin. */
export interface PlacedItem {
  /** Dataset index. */
  index: number;
  /** Zero-based column. */
  column: number;
  /** Pixels from the left of the content box. */
  x: number;
  /** Pixels from the segment origin, NOT from the dataset origin. */
  y: number;
  width: number;
  height: number;
}

/** Resolved column geometry for a given container width. */
export interface ColumnGeometry {
  columns: number;
  columnWidth: number;
}

interface ResolvedOptions {
  totalItems: number;
  columns: number;
  columnWidth: number;
  gap: number;
  segmentSize: number;
  getItemHeight: (index: number, columnWidth: number) => number;
}

export class MasonryLayout {
  private static readonly ITEM_CACHE_LIMIT = 3;

  private readonly opts: ResolvedOptions;

  /** Column frontier scratch. Reused; never allocated per frame. */
  private colH: number[];
  /** Separate frontier for {@link chainAhead}, which runs between renders. */
  private chainColH: number[];
  /** Return buffer for {@link segmentOrigin}-style lookups. */
  private frontierOut: number[];

  /**
   * Real column frontier at each segment boundary, `columns` floats per entry.
   * This is the whole memory cost of having no seam, and it doubles as a
   * prefix-sum table — {@link segmentOrigin} is a lookup, not a walk.
   */
  private frontiers: number[] = [];
  /**
   * Frontiers are known for the CONTIGUOUS range [chainBase, frontierKnown].
   *
   * A single high-water mark is not enough once {@link anchorFlushAt} exists:
   * anchoring jumps forward without filling the gap behind it, so a bare
   * "known up to N" would claim segments that were never written and hand back
   * undefined. The pair states the real invariant.
   */
  private frontierKnown = -1;
  private chainBase = 0;
  /**
   * Segments below this were packed UPWARD by {@link extendBack} and must be
   * read back the same way. `0` means the whole range is ordinary forward work.
   */
  private reverseBelow = 0;

  /** Full geometry for the few segments actually being drawn. */
  private itemCache = new Map<number, PlacedItem[]>();

  constructor(options: {
    totalItems: number;
    columns: number;
    columnWidth: number;
    gap: number;
    segmentSize: number;
    getItemHeight: (index: number, columnWidth: number) => number;
  }) {
    this.opts = {
      ...options,
      segmentSize: Math.max(1, Math.floor(options.segmentSize))
    };
    this.colH = new Array(this.opts.columns).fill(0);
    this.chainColH = new Array(this.opts.columns).fill(0);
    this.frontierOut = new Array(this.opts.columns).fill(0);
  }

  get columns(): number { return this.opts.columns; }
  get columnWidth(): number { return this.opts.columnWidth; }
  get gap(): number { return this.opts.gap; }
  get segmentSize(): number { return this.opts.segmentSize; }

  /** Number of segments the dataset divides into. */
  segmentCount(): number {
    return Math.max(1, Math.ceil(this.opts.totalItems / this.opts.segmentSize));
  }

  /** First item index of a segment. Pure arithmetic — no chaining required. */
  segmentStart(segment: number): number {
    return Math.min(segment * this.opts.segmentSize, this.opts.totalItems);
  }

  /**
   * Vertical extent of a segment, as the scroll engine consumes it.
   *
   * Interior segments measure to the SHALLOWEST column: the next segment's
   * cards resume from each column's real frontier and absorb the overhang, so
   * the segments tile exactly. The FINAL segment has nothing after it to absorb
   * anything, so it measures to the deepest column — otherwise the last cards
   * sit below where the engine believes the dataset ends and cannot be reached.
   *
   * @param segment Segment index.
   * @returns Height in pixels.
   */
  getSegmentHeight(segment: number): number {
    const origin = this.segmentOrigin(segment);
    return this.segmentOrigin(segment + 1) - origin;
  }

  /**
   * Absolute y of a segment's top, from the start of the dataset.
   *
   * O(1) once the chain has reached `segment`, because the frontier table is
   * already a prefix-sum table. Reaching an unchained segment walks there.
   *
   * @param segment Segment index. `segmentCount()` is the past-the-end boundary.
   * @returns Pixels from the top of the dataset.
   */
  segmentOrigin(segment: number): number {
    // Not an unconditional 0: a backwards extension gives segment 0 a real
    // origin above the anchor, which is negative in the range's own coordinates.
    if (segment <= 0) return this.hasFrontier(0) ? this.readOrigin(0) : 0;
    const clamped = Math.min(segment, this.segmentCount());
    this.ensureFrontier(clamped);
    return this.readOrigin(clamped);
  }

  /**
   * Fold a stored frontier into a single origin.
   *
   * Past-the-end uses the DEEPEST column so total height covers the ragged tail;
   * interior boundaries use the shallowest, which is what tiles exactly.
   */
  private readOrigin(segment: number): number {
    const off = segment * this.opts.columns;
    const atEnd = segment >= this.segmentCount();
    let v = this.frontiers[off];
    for (let c = 1; c < this.opts.columns; c++) {
      const o = this.frontiers[off + c];
      if (atEnd ? o > v : o < v) v = o;
    }
    return v;
  }

  /**
   * Segment containing an absolute pixel position, and the offset into it.
   *
   * @param y Pixels from the top of the dataset.
   * @returns `{ segment, offset }`.
   */
  segmentAtY(y: number): { segment: number; offset: number } {
    if (!(y > 0)) return { segment: 0, offset: 0 };
    let lo = 0;
    let hi = this.segmentCount() - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segmentOrigin(mid) <= y) lo = mid; else hi = mid - 1;
    }
    return { segment: lo, offset: Math.max(0, y - this.segmentOrigin(lo)) };
  }

  /**
   * Total content height. Exact once the chain reaches the end, extrapolated
   * from the chained prefix before that.
   *
   * The scrollbar needs a total immediately, but chaining to the last segment is
   * the full sequential walk. Segment heights cluster tightly (each holds the
   * same item count), so the mean of what is known is a good stand-in until a
   * background pass finishes.
   *
   * @returns Height in pixels, and whether it is exact yet.
   */
  totalHeight(): { height: number; exact: boolean } {
    const segments = this.segmentCount();
    if (this.frontierKnown >= segments) {
      return { height: this.segmentOrigin(segments), exact: true };
    }
    if (this.frontierKnown <= 0) {
      return { height: this.getSegmentHeight(0) * segments, exact: false };
    }
    const known = this.frontierKnown;
    return { height: (this.segmentOrigin(known) / known) * segments, exact: false };
  }

  /**
   * Cards in a segment, positioned relative to that segment's origin.
   *
   * @param segment Segment index.
   * @returns Cached array — read it, do not mutate or retain it.
   */
  getSegment(segment: number): PlacedItem[] {
    const hit = this.itemCache.get(segment);
    if (hit) return hit;

    const items: PlacedItem[] = [];
    this.layoutSegment(segment, items);
    this.itemCache.set(segment, items);
    if (this.itemCache.size > MasonryLayout.ITEM_CACHE_LIMIT) {
      const oldest = this.itemCache.keys().next().value as number;
      this.itemCache.delete(oldest);
    }
    return items;
  }

  /**
   * Cards in a segment that intersect a pixel window.
   *
   * @param segment Segment index.
   * @param offset Window top, in pixels from the segment origin.
   * @param windowHeight Window height in pixels.
   * @param out Reused output array.
   * @returns `out`, filled with intersecting cards.
   */
  itemsInWindow(
    segment: number,
    offset: number,
    windowHeight: number,
    out: PlacedItem[]
  ): PlacedItem[] {
    out.length = 0;
    const items = this.getSegment(segment);
    const bottom = offset + windowHeight;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.y + it.height >= offset && it.y <= bottom) out.push(it);
    }
    return out;
  }

  /**
   * Absolute y of a single card, for re-anchoring across a relayout.
   *
   * @param index Item index.
   * @returns `{ segment, y }` with `y` absolute, or null if out of range.
   */
  locateItem(index: number): { segment: number; y: number } | null {
    if (!Number.isFinite(index) || index < 0 || index >= this.opts.totalItems) return null;
    const segment = Math.min(
      Math.floor(index / this.opts.segmentSize),
      this.segmentCount() - 1
    );
    const items = this.getSegment(segment);
    for (let i = 0; i < items.length; i++) {
      if (items[i].index === index) {
        return { segment, y: this.segmentOrigin(segment) + items[i].y };
      }
    }
    return null;
  }

  /**
   * Change column geometry and discard everything derived from it.
   *
   * Every height depends on `columnWidth` (the oracle takes it) and every
   * frontier depends on those heights, so nothing survives a width change. The
   * caller must re-anchor afterwards: the camera is expressed in the old
   * geometry, and item N now lives somewhere else entirely.
   *
   * Segment count is unaffected, so the engine's element count does not change.
   *
   * @param columns New column count (>= 1).
   * @param columnWidth New column width in pixels (> 0).
   * @returns Whether anything changed.
   */
  resize(columns: number, columnWidth: number): boolean {
    if (!Number.isFinite(columns) || columns < 1) return false;
    if (!Number.isFinite(columnWidth) || columnWidth <= 0) return false;
    if (columns === this.opts.columns && columnWidth === this.opts.columnWidth) return false;

    const sameCols = columns === this.opts.columns;
    this.opts.columns = columns;
    this.opts.columnWidth = columnWidth;
    if (!sameCols) {
      this.colH = new Array(columns).fill(0);
      this.chainColH = new Array(columns).fill(0);
      this.frontierOut = new Array(columns).fill(0);
    }
    this.invalidate();
    return true;
  }

  /** Drop every cached frontier and segment. */
  invalidate(): void {
    this.frontiers.length = 0;
    this.frontierKnown = -1;
    this.chainBase = 0;
    this.reverseBelow = 0;
    this.itemCache.clear();
  }

  /**
   * Declare a segment to be a fresh origin, with its columns level.
   *
   * Used when the camera lands somewhere the chain has never reached — a
   * scrollbar drag into never-visited content. Chaining there honestly costs one
   * height per card crossed, which in dynamic-height mode means mounting and
   * measuring every card in between. Starting level costs one flush line at the
   * landing card, which the viewer teleported to and so never scrolled across.
   *
   * No-op when the segment's frontier is already known — a real frontier always
   * beats an assumed one.
   *
   * @param segment Segment to anchor.
   * @returns Whether an anchor was placed.
   */
  anchorFlushAt(segment: number): boolean {
    if (segment < 0) return false;
    if (this.hasFrontier(segment)) return false;
    const { columns } = this.opts;
    const off = segment * columns;
    for (let c = 0; c < columns; c++) this.frontiers[off + c] = 0;
    // The anchor becomes the base of a NEW contiguous range. Everything the old
    // range covered is abandoned rather than silently claimed.
    this.chainBase = segment;
    this.frontierKnown = segment;
    // The old range is abandoned, and with it any block that was mirrored into
    // it. A fresh anchor starts ordinary forward work again.
    this.reverseBelow = 0;
    this.itemCache.clear();
    return true;
  }

  /**
   * Grow the contiguous range BACKWARDS, without moving anything already in it.
   *
   * Scrolling up out of an anchored range is the one case ordinary scrolling
   * cannot chain through: a frontier is a running total of everything ABOVE it,
   * so there is no history behind the base to extend from. Re-anchoring at the
   * new low point is what the caller would otherwise do, and it re-bases the
   * range — which throws away the frontier the camera's offset was computed
   * against and re-packs the columns the reader is looking at.
   *
   * This packs the missing segments UPWARD from the base instead: the mirror of
   * the ordinary algorithm, filling the column whose top edge hangs lowest and
   * growing away from the viewer. Mirroring is what makes the seam free —
   * placing cards against a known bottom edge means every column meets the base
   * frontier at exactly `gap`, where packing downward into it would leave all
   * but one column short. The raggedness that has to go somewhere ends up at
   * the TOP of the block, above everything drawn, where the next extension
   * consumes it just as exactly.
   *
   * Masonry stays locally deterministic either way: these segments have never
   * been placed under this range, so there is no earlier arrangement to
   * contradict. The difference is only that the viewer sees new content appear
   * above them rather than the grid they were reading re-flow.
   *
   * @param segments How many segments to prepend. Larger amortizes better: the
   *   work is one pass over the block, and a block is only ever built once.
   * @returns Whether the range grew.
   */
  extendBack(segments: number): boolean {
    const base = this.chainBase;
    if (base <= 0 || !this.hasFrontier(base)) return false;
    const span = Math.max(1, Math.floor(segments));
    const back = Math.max(0, base - span);
    if (back >= base) return false;

    const { columns, columnWidth, gap, segmentSize: K, totalItems, getItemHeight } = this.opts;
    const colTop = this.chainColH;
    const off = base * columns;
    for (let c = 0; c < columns; c++) colTop[c] = this.frontiers[off + c];

    for (let s = base - 1; s >= back; s--) {
      const lo = s * K;
      const hi = Math.min(lo + K, totalItems);
      for (let i = hi - 1; i >= lo; i--) {
        // Mirror of "shortest column": fill the one whose top hangs LOWEST,
        // because that is the one with the most room left above it.
        let c = 0;
        for (let k = 1; k < columns; k++) if (colTop[k] > colTop[c]) c = k;
        colTop[c] -= Math.max(1, getItemHeight(i, columnWidth)) + gap;
      }
      const o = s * columns;
      for (let c = 0; c < columns; c++) this.frontiers[o + c] = colTop[c];
    }

    // The block is packed the other way round, so replaying it forwards would
    // not reproduce it. Segments below this mark are read back through the
    // mirrored walk instead — see layoutSegment.
    if (base > this.reverseBelow) this.reverseBelow = base;
    this.chainBase = back;
    // Only the block's own geometry is stale; everything from the base down is
    // untouched and must stay cached, or the camera's segment pays to be
    // measured again for a layout that did not change.
    for (const seg of [...this.itemCache.keys()]) {
      if (seg < base) this.itemCache.delete(seg);
    }
    return true;
  }

  /** Whether a segment's frontier is actually written, not merely below the mark. */
  hasFrontier(segment: number): boolean {
    return segment >= this.chainBase && segment <= this.frontierKnown;
  }

  /** Deepest segment of the current contiguous range. `-1` if none. */
  get frontierReach(): number {
    return this.frontierKnown;
  }

  /** First segment of the current contiguous range. */
  get frontierBase(): number {
    return this.chainBase;
  }


  /**
   * Advance the frontier chain toward `targetSegment` within a time budget.
   *
   * The chain is irreducibly sequential — a frontier IS the running column
   * state — so reaching a deep position after an invalidation costs one pass
   * over everything above it. Done in a single call that is a long frame on a
   * large dataset; call this once per animation frame instead until it returns
   * true.
   *
   * Progress is durable: each completed segment is written to the table, so an
   * abandoned rebuild costs nothing and later lookups resume rather than restart.
   *
   * @param targetSegment Segment whose frontier is needed.
   * @param budgetMs Wall-clock budget for this slice.
   * @returns `true` once the chain has reached `targetSegment`.
   */
  chainAhead(targetSegment: number, budgetMs: number): boolean {
    const target = Math.max(0, Math.min(targetSegment, this.segmentCount()));
    if (this.hasFrontier(target)) return true;
    // Behind the current base: there is no history to extend, so this is a
    // re-anchor decision, not a chaining one.
    if (target < this.chainBase) return false;

    const { columns, columnWidth, gap, segmentSize: K, totalItems, getItemHeight } = this.opts;
    const colH = this.chainColH;
    this.seedChain(colH);

    const deadline = MasonryLayout.now() + budgetMs;
    let s = Math.max(this.chainBase, this.frontierKnown);

    while (s < target) {
      const lo = s * K;
      const hi = Math.min(lo + K, totalItems);
      for (let i = lo; i < hi; i++) {
        let c = 0;
        for (let k = 1; k < columns; k++) if (colH[k] < colH[c]) c = k;
        colH[c] += Math.max(1, getItemHeight(i, columnWidth)) + gap;
      }
      this.storeFrontier(s + 1, colH);
      s++;
      // Checked per segment: a frontier is only meaningful at a boundary, so
      // that is the smallest resumable unit.
      if (MasonryLayout.now() >= deadline) break;
    }
    return this.frontierKnown >= target;
  }

  /** How far the chain has been built, for progress reporting. */
  get chainProgress(): { known: number; total: number } {
    return { known: this.frontierKnown, total: this.segmentCount() };
  }

  /**
   * Resolve columns and column width for a container width.
   *
   * @param width Available content width in pixels.
   * @param gap Gutter in pixels.
   * @param fixedColumns Use exactly this many columns, ignoring `targetColumnWidth`.
   * @param targetColumnWidth Preferred column width when the count is responsive.
   * @param minColumns Lower bound for the responsive count.
   * @param maxColumns Upper bound for the responsive count.
   */
  static geometryFor(
    width: number,
    gap: number,
    fixedColumns: number | undefined,
    targetColumnWidth: number,
    minColumns: number,
    maxColumns: number
  ): ColumnGeometry {
    const columns = fixedColumns && fixedColumns > 0
      ? Math.floor(fixedColumns)
      : Math.max(minColumns, Math.min(maxColumns, Math.floor((width + gap) / (targetColumnWidth + gap))));
    // Deliberately NOT floored. Flooring leaves a few pixels of remainder that
    // have to go somewhere, and wherever they go one outer gutter ends up wider
    // than the rest. A fractional width divides the space exactly, which is what
    // CSS grid does for the same reason.
    return {
      columns,
      columnWidth: Math.max(1, (width - gap * (columns - 1)) / columns)
    };
  }

  private static now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /** Load the deepest known frontier into `colH`, seeding segment 0 if needed. */
  private seedChain(colH: number[]): void {
    const { columns } = this.opts;
    if (this.frontierKnown < 0) {
      for (let c = 0; c < columns; c++) colH[c] = 0;
      this.chainBase = 0;
      this.storeFrontier(0, colH);
      return;
    }
    const off = this.frontierKnown * columns;
    for (let c = 0; c < columns; c++) colH[c] = this.frontiers[off + c];
  }

  /**
   * Guarantee that `target` has a frontier to read.
   *
   * Chains forward when the target is ahead of the current range. When it is
   * BEHIND the range's base — the range having been re-based by an anchor — the
   * history to chain from no longer exists, so the target becomes a fresh
   * anchor. Reading an unwritten slot instead would return undefined and put
   * NaN into every position derived from it.
   */
  private ensureFrontier(target: number): void {
    if (this.hasFrontier(target)) return;
    if (target >= this.chainBase) {
      // Unbudgeted: callers that care about frame time use chainAhead().
      this.chainAhead(target, Number.POSITIVE_INFINITY);
      if (this.hasFrontier(target)) return;
    }
    this.anchorFlushAt(target);
  }

  private storeFrontier(segment: number, colH: number[]): void {
    const { columns } = this.opts;
    const off = segment * columns;
    for (let c = 0; c < columns; c++) this.frontiers[off + c] = colH[c];
    if (segment > this.frontierKnown) this.frontierKnown = segment;
  }

  /**
   * Place one segment's cards, continuing from the previous run's real frontier.
   * No flush, so the output matches a single pass from item 0 exactly.
   */
  private layoutSegment(segment: number, out: PlacedItem[]): void {
    const { columns, columnWidth, gap, segmentSize: K, totalItems, getItemHeight } = this.opts;

    this.ensureFrontier(segment);
    if (segment < this.reverseBelow) {
      this.layoutSegmentUpward(segment, out);
      return;
    }
    const colH = this.colH;
    const off = segment * columns;
    let originY = Number.POSITIVE_INFINITY;
    for (let c = 0; c < columns; c++) {
      colH[c] = this.frontiers[off + c];
      if (colH[c] < originY) originY = colH[c];
    }

    const start = segment * K;
    const end = Math.min(start + K, totalItems);
    for (let i = start; i < end; i++) {
      let c = 0;
      for (let k = 1; k < columns; k++) if (colH[k] < colH[c]) c = k;
      const h = Math.max(1, getItemHeight(i, columnWidth));
      out.push({
        index: i,
        column: c,
        x: c * (columnWidth + gap),
        y: colH[c] - originY,
        width: columnWidth,
        height: h
      });
      colH[c] += h + gap;
    }
    // Only when the boundary is not already established. Normally it is not and
    // this is the write that advances the chain — but a segment laid out at the
    // BOTTOM of a backwards extension ends against a frontier that was
    // deliberately preserved (see {@link extendBack}), and recomputing it there
    // would drag every segment below it, and the whole visible window with them.
    // Everywhere else the recomputed value is identical to the stored one: the
    // same heights from the same start produce the same sum.
    if (!this.hasFrontier(segment + 1)) this.storeFrontier(segment + 1, colH);
  }

  /**
   * Place one segment's cards by the mirrored walk {@link extendBack} used.
   *
   * Reads the boundary BELOW the segment and grows upward from it, so the cards
   * land exactly where the extension put them. Replaying such a segment forwards
   * would produce a different packing and a torn seam, which is the whole reason
   * `reverseBelow` exists.
   */
  private layoutSegmentUpward(segment: number, out: PlacedItem[]): void {
    const { columns, columnWidth, gap, segmentSize: K, totalItems, getItemHeight } = this.opts;

    const colTop = this.colH;
    const below = (segment + 1) * columns;
    for (let c = 0; c < columns; c++) colTop[c] = this.frontiers[below + c];

    const start = segment * K;
    const end = Math.min(start + K, totalItems);
    const first = out.length;
    for (let i = end - 1; i >= start; i--) {
      let c = 0;
      for (let k = 1; k < columns; k++) if (colTop[k] > colTop[c]) c = k;
      const h = Math.max(1, getItemHeight(i, columnWidth));
      const y = colTop[c] - gap - h;
      out.push({
        index: i,
        column: c,
        x: c * (columnWidth + gap),
        y,
        width: columnWidth,
        height: h
      });
      colTop[c] = y;
    }

    // Built bottom-up; hand it back in index order like every other segment.
    for (let lo = first, hi = out.length - 1; lo < hi; lo++, hi--) {
      const t = out[lo]; out[lo] = out[hi]; out[hi] = t;
    }

    // y is absolute so far — rebase it on the segment origin, which is the
    // topmost card, exactly as the forward walk reports it.
    let originY = Number.POSITIVE_INFINITY;
    for (let c = 0; c < columns; c++) if (colTop[c] < originY) originY = colTop[c];
    for (let i = first; i < out.length; i++) out[i].y -= originY;
  }
}
