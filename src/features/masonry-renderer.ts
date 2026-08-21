/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * DOM half of `layout: 'masonry'`.
 *
 * The default renderer mounts one node per virtual element. Masonry cannot use
 * it: its virtual element is a SEGMENT of hundreds of cards, so one node per
 * element would be one node per segment. This mounts cards instead, and takes
 * the camera from the engine rather than computing one.
 *
 * The split is what keeps masonry off everyone else's hot path — the engine's
 * own render loop is untouched and gains no branches.
 */

import type { MasonryOptions, HeightProvider, MasonryDeterminism } from '../types/index.js';
import { MasonryLayout, PlacedItem } from './masonry-layout.js';

/** Engine surface this renderer drives. Kept narrow so the coupling is visible. */
export interface MasonryHost {
  readonly currentElement: number;
  readonly scrollOffset: number;
  jumpToPosition(element: number, offset: number, skipScrollbarSync?: boolean): unknown;
  syncViewportHeight(observedHeight: number): number;
  refreshScrollbarMetrics(): void;
  updateDisplay(): void;
}

export class MasonryRenderer {
  private readonly layout: MasonryLayout;
  private readonly gap: number;
  private readonly overscan: number;
  private readonly sliceMs: number;

  private content: HTMLElement | null = null;
  private mounted = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];

  private lastWidth = 0;
  private resizeRaf: number | null = null;

  /** Topmost card still intersecting the viewport, and where it sat. */
  private anchor: { index: number; screenY: number } | null = null;

  private rebuilding = false;
  private rebuildRaf: number | null = null;
  private pendingAnchor: { index: number; screenY: number } | null = null;
  private tailRaf: number | null = null;

  /**
   * Cached padding of the content box. Read once per geometry change — never
   * per frame, since getComputedStyle forces a layout.
   */
  private pad = { left: 0, right: 0, top: 0 };
  /**
   * Half the width left over after flooring the column width. Columns are
   * integer-width, so `usable - (columns * w + gap * (columns - 1))` is usually
   * a pixel or two; without this it all lands on the right and the outer gutters
   * are visibly unequal.
   */
  private centerOffset = 0;

  /**
   * Dynamic-height mode only. Measured card heights, bounded like the row
   * engine's cache. Evicting is safe: a stored frontier is a SUM, so it stays
   * valid — only placing cards inside a segment needs the individual values,
   * and those are re-measured on revisit.
   */
  private heights: Map<number, number> | null = null;
  private heightOrder: number[] = [];
  private static readonly HEIGHT_CACHE_MAX = 1200;
  /** Ceiling on segments swept for one frame, so coverage can never run away. */
  private static readonly MAX_WINDOW_SEGMENTS = 12;
  /** Segments before the end kept real, so tail corrections use real heights. */
  private static readonly TAIL_REAL_SEGMENTS = 4;
  /** Offscreen element used to measure a card without disturbing the view. */
  private probe: HTMLElement | null = null;
  private readonly dynamic: boolean;
  private readonly estimatedHeight: number;
  private readonly maxChainSegments: number;

  private buf: PlacedItem[] = [];
  private needed = new Set<number>();
  private evict: number[] = [];

  /**
   * @param host Container whose width drives the column geometry.
   * @param totalItems Number of cards.
   * @param options Masonry configuration.
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly totalItems: number,
    private readonly options: MasonryOptions
  ) {
    this.gap = options.gap ?? 16;
    this.overscan = options.overscan ?? 400;
    this.sliceMs = options.rebuildSliceMs ?? 6;
    this.dynamic = typeof options.getItemHeight !== 'function';
    this.estimatedHeight = options.estimatedItemHeight ?? 300;
    this.maxChainSegments = options.maxChainSegments ?? 4;
    if (this.dynamic) this.heights = new Map();

    // Create the content box up front so width is measured from the element the
    // cards actually live in, not from the host.
    this.ensureContent(host);
    this.measurePadding();
    this.lastWidth = this.availableWidth();
    const geo = this.geometryFor(this.lastWidth);
    this.setCenterOffset(this.lastWidth, geo.columns, geo.columnWidth);
    this.layout = new MasonryLayout({
      totalItems,
      columns: geo.columns,
      columnWidth: geo.columnWidth,
      gap: this.gap,
      // Dynamic mode uses MUCH smaller segments. A segment is laid out in full
      // whenever it is touched — its end frontier depends on every card in it —
      // so K is the measurement quantum, and measuring is the expensive thing
      // here. K=100 meant ~300 measurements to draw ~25 cards on every landing;
      // at this size the overhead is roughly one measurement per card drawn,
      // which is the same rate the row engine measures at.
      segmentSize: options.segmentSize ?? (this.dynamic ? 24 : 500),
      getItemHeight: this.dynamic
        ? (index, columnWidth) => this.measuredHeight(index, columnWidth)
        : options.getItemHeight!
    });
  }

  /** Segment count — this is what the engine uses as its element count. */
  get segmentCount(): number {
    return this.layout.segmentCount();
  }

  get columns(): number { return this.layout.columns; }
  get columnWidth(): number { return this.layout.columnWidth; }

  /** Cards currently in the DOM. Debug/telemetry. */
  get mountedCount(): number { return this.mounted.size; }

  /**
   * The card this renderer will hold in place across a relayout, and where it
   * currently sits relative to the viewport top.
   *
   * This is the reading position: a relayout re-derives the camera from it, so
   * it is the one card guaranteed not to move. Null before the first render.
   */
  get anchorItem(): { index: number; screenY: number } | null {
    return this.anchor ? { index: this.anchor.index, screenY: this.anchor.screenY } : null;
  }

  /**
   * Absolute y of a segment's top. Mirrors {@link segmentAtY}; together they
   * convert between the engine's camera and content coordinates.
   *
   * @param segment Segment index.
   * @returns Pixels from the top of the dataset.
   */
  segmentOrigin(segment: number): number {
    return this.layout.segmentOrigin(segment);
  }

  /** Whether heights come from the DOM rather than from an oracle. */
  get isDynamic(): boolean { return this.dynamic; }

  /**
   * The determinism guarantee this layout provides. See {@link MasonryDeterminism}.
   *
   * `'canonical'` when an oracle prices cards, so a card's column is a function
   * of the dataset. `'local'` when heights are measured, so a card's column is a
   * function of the dataset AND how the viewer reached it.
   */
  get determinism(): MasonryDeterminism {
    return this.dynamic ? 'local' : 'canonical';
  }

  /**
   * Height lookups the engine installs in place of its own measured cache.
   *
   * Oracle mode answers everything exactly, including a total content height, so
   * the scrollbar strip can be sized in real pixels.
   *
   * Dynamic mode deliberately answers less. `totalHeight` is omitted, which
   * leaves the strip sized by element COUNT — the engine's existing behavior,
   * and the reason a dataset with nothing measured still maps the thumb
   * correctly. `cumulativeHeight` is likewise not offered, because summing to a
   * distant segment would mean measuring every card on the way there. Neither is
   * needed: position is expressed as (segment, offset) and the thumb as a
   * fraction of the card count.
   */
  heightProvider(): HeightProvider {
    const L = this.layout;
    const base = {
      height: (segment: number) => this.segmentHeight(segment)
    };
    if (this.dynamic) return base;
    return {
      ...base,
      cumulativeHeight: (segment: number) => L.segmentOrigin(segment),
      rowAtPosition: (pixels: number) => {
        const r = L.segmentAtY(pixels);
        return { element: r.segment, offset: r.offset };
      },
      totalHeight: () => L.totalHeight().height
    };
  }

  /**
   * Height of a segment, estimated when the camera has not reached it.
   *
   * Mirrors how an unmeasured row reports a default today: the value is only
   * used for segments the engine has not learned, and is replaced by the real
   * one the moment the camera arrives and the cards are measured.
   */
  private segmentHeight(segment: number): number {
    if (!this.dynamic) return this.layout.getSegmentHeight(segment);

    // A HEIGHT QUERY MUST NEVER MUTATE LAYOUT STATE. Asking the layout for a
    // segment outside the established range makes it anchor there, which
    // re-bases the range and discards the window the camera is using. The
    // engine queries heights constantly — the boundary guardian and the
    // true-bottom walk both probe the LAST segment — so a single unguarded read
    // re-anchors to the end of the dataset on every frame and every card gets
    // re-measured. Both ends of the span must be in range before trusting it.
    if (this.layout.hasFrontier(segment) && this.layout.hasFrontier(segment + 1)) {
      return this.layout.getSegmentHeight(segment);
    }
    const perRow = this.estimatedHeight + this.gap;
    return (this.layout.segmentSize / Math.max(1, this.layout.columns)) * perRow;
  }

  /**
   * Height of one card, measuring it offscreen if it has not been seen.
   *
   * The probe is a detached-but-laid-out box of exactly one column's width, so
   * the height it reports is the height the card will have once placed. It never
   * touches the visible tree, which matters because this runs while the frontier
   * is being computed — before anything is positioned.
   */
  private measuredHeight(index: number, columnWidth: number): number {
    const cached = this.heights!.get(index);
    if (cached !== undefined) return cached;

    let height = this.estimatedHeight;
    const probe = this.ensureProbe();
    if (probe) {
      probe.style.width = columnWidth + 'px';
      probe.textContent = '';
      this.options.renderItem(index, probe);
      const h = probe.offsetHeight;
      if (h > 0) height = h;
      probe.textContent = '';
    }

    this.heights!.set(index, height);
    this.heightOrder.push(index);
    if (this.heightOrder.length > MasonryRenderer.HEIGHT_CACHE_MAX) {
      // Oldest-first eviction. Safe: frontiers already folded these into a sum.
      const drop = this.heightOrder.splice(0, this.heightOrder.length >> 1);
      for (let i = 0; i < drop.length; i++) this.heights!.delete(drop[i]);
    }
    return height;
  }

  private ensureProbe(): HTMLElement | null {
    if (this.probe) return this.probe;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.setAttribute('data-cerious-masonry', 'probe');
    el.setAttribute('aria-hidden', 'true');
    // Laid out (so it has a height) but out of flow, invisible, inert.
    el.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
    (this.content ?? this.host).appendChild(el);
    this.probe = el;
    return el;
  }

  /**
   * Make sure the camera's segment has a frontier to lay out from.
   *
   * Ordinary scrolling walks forward a segment at a time, which is a short chain
   * and worth paying for. A jump into content the chain has never reached is
   * not: honouring it would mean measuring every card in between. Past
   * `maxChainSegments` the landing segment is anchored level instead.
   */
  private ensureWindowFrontier(
    camera: number,
    segments: number,
    windowHeight: number,
    offset: number
  ): number {
    if (!this.dynamic) return Math.min(segments - 1, camera + 1);

    // Establish ONE contiguous range covering the whole drawn window, lowest
    // segment first. Doing it piecemeal thrashes: the neighbour above the camera
    // sits below the current range base, so laying it out re-anchors backwards,
    // which discards the range the camera was just using — and every frame pays
    // to measure it all again.
    let first = Math.max(0, camera - 1);

    // Near the end, cover a few segments back from the LAST one rather than
    // just the camera's neighbour. The engine's bottom-boundary correction walks
    // the tail, and it walks it through getElementHeight — which answers with an
    // estimate for anything outside the range. Correcting against an estimate is
    // what drags the camera off the end: measured, a camera placed at the final
    // segment came back two segments earlier with an offset larger than the
    // segment is tall, leaving the viewport empty.
    const tailGuard = MasonryRenderer.TAIL_REAL_SEGMENTS;
    if (camera >= segments - 1 - tailGuard) {
      first = Math.max(0, Math.min(first, segments - 1 - tailGuard));
    }

    if (!this.layout.hasFrontier(first)) {
      const reach = this.layout.frontierReach;
      const withinReach =
        reach >= 0 && first >= this.layout.frontierBase && first - reach <= this.maxChainSegments;
      if (withinReach) this.layout.chainAhead(first, this.sliceMs);
      if (!this.layout.hasFrontier(first)) this.layout.anchorFlushAt(first);
    }

    // Walk forward until the window is actually covered, rather than stopping at
    // a fixed neighbour. Segment heights vary with content, so a fixed count
    // sometimes falls short of the viewport and leaves the bottom blank.
    //
    // UNBUDGETED on purpose: a budgeted chain that runs out leaves the segment
    // without a frontier, and a segment without a frontier is skipped — which is
    // the blank band this is fixing. The span is bounded instead, so the work is
    // bounded without ever stopping halfway.
    // Coverage is measured in SCREEN space, so it starts at the camera's own
    // origin (-offset), not at the top of the camera's segment. Ignoring the
    // offset over-reports how far the content reaches and stops the sweep early
    // — precisely the blank band being fixed.
    const need = windowHeight + this.overscan;
    let covered = -offset;
    let last = camera;
    for (let guard = 0; guard < MasonryRenderer.MAX_WINDOW_SEGMENTS; guard++) {
      if (!this.layout.hasFrontier(last)) {
        this.layout.chainAhead(last, Number.POSITIVE_INFINITY);
        if (!this.layout.hasFrontier(last)) break;
      }
      covered += this.segmentHeight(last);
      if (covered >= need || last >= segments - 1) break;
      last++;
    }
    // One past the covered span, so a card overhanging the boundary is drawn —
    // and note this reaches `segments`, the PAST-THE-END boundary, not
    // `segments - 1`. A segment's height is the delta between its own frontier
    // and the next one, so the final segment has no real height until the
    // boundary after it exists. Without that the camera settles against an
    // estimate at the end of the dataset and the viewport comes up empty.
    const tail = Math.min(segments, last + 1);
    if (!this.layout.hasFrontier(tail)) {
      this.layout.chainAhead(tail, Number.POSITIVE_INFINITY);
    }
    return Math.min(segments - 1, this.layout.hasFrontier(tail) ? tail : last);
  }

  /**
   * Width the cards may actually occupy.
   *
   * NOT `host.clientWidth`: attaching the native scrollbar puts a
   * `padding-right` on the host for the strip, and `clientWidth` INCLUDES
   * padding. Measuring the host therefore counts space the cards cannot use, and
   * the rightmost column renders underneath the strip and is clipped — by
   * exactly the strip width.
   *
   * The content box already excludes it, so measure that instead.
   */
  private availableWidth(): number {
    const el = this.content;
    if (!el) return this.host.clientWidth;

    // Measure to the scrollbar strip when one is present, not to the content
    // box. The host reserves padding for the strip, but that reservation is not
    // required to equal the strip's rendered width — here it is 17px of padding
    // for a 15px strip — so the content box's right edge sits a couple of pixels
    // short of the strip. Measuring the real distance keeps the last gutter
    // equal to the others instead of inheriting that slack.
    let span = el.clientWidth;
    const strip = this.host.querySelector('[data-cerious-scrollbar="container"]') as HTMLElement | null;
    if (strip && typeof el.getBoundingClientRect === 'function') {
      const gap = strip.getBoundingClientRect().left - el.getBoundingClientRect().left;
      if (gap > 0) span = gap;
    }

    const inner = span - this.pad.left - this.pad.right;
    return inner > 0 ? inner : this.host.clientWidth;
  }

  /**
   * Read the content box's padding so cards can be inset from its edges.
   *
   * Rows can be full-bleed; cards cannot — a card flush against the container
   * edge reads as clipped. Honouring CSS padding here means a gutter is styled
   * normally, with no extra option. `clientWidth` INCLUDES padding, and an
   * absolutely positioned child is laid out against the padding box rather than
   * the content box, so both the available width and each card's x must account
   * for it explicitly.
   */
  private measurePadding(): void {
    if (!this.content || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(this.content);
    this.pad.left = parseFloat(cs.paddingLeft) || 0;
    this.pad.right = parseFloat(cs.paddingRight) || 0;
    this.pad.top = parseFloat(cs.paddingTop) || 0;
  }

  /** Recompute the centering offset for a resolved geometry. */
  private setCenterOffset(usable: number, columns: number, columnWidth: number): void {
    const grid = columns * columnWidth + this.gap * (columns - 1);
    this.centerOffset = Math.max(0, Math.floor((usable - grid) / 2));
  }

  private geometryFor(width: number) {
    return MasonryLayout.geometryFor(
      width,
      this.gap,
      this.options.columns,
      this.options.targetColumnWidth ?? 280,
      this.options.minColumns ?? 1,
      this.options.maxColumns ?? 8
    );
  }

  /** Positioned wrapper the cards live in, created on first render. */
  private ensureContent(container: HTMLElement): HTMLElement {
    if (this.content && this.content.parentNode === container) return this.content;
    const el = document.createElement('div');
    el.setAttribute('data-cerious-masonry', 'content');
    el.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';
    container.appendChild(el);
    this.content = el;
    return el;
  }

  /**
   * Mount the cards covering the viewport and recycle the rest.
   *
   * Cards overhang segment boundaries — a segment's height is a frontier delta,
   * not a bounding box — so the neighbouring segments are swept too.
   *
   * @param windowHeight Usable viewport height.
   * @param container Host element.
   * @param host Engine surface.
   */
  render(windowHeight: number, container: HTMLElement, host: MasonryHost): void {
    if (this.rebuilding) return; // layout invalidated; hold the current view

    const content = this.ensureContent(container);
    let camera = host.currentElement;
    let offset = host.scrollOffset;
    const segments = this.layout.segmentCount();

    this.needed.clear();
    let anchorIndex = -1;
    let anchorY = Number.POSITIVE_INFINITY;

    let lastSeg = this.ensureWindowFrontier(camera, segments, windowHeight, offset);

    // Settle against the end of the dataset.
    //
    // The camera's offset was chosen from ESTIMATED segment heights — that is
    // what lets the engine navigate content it has never measured. Once the
    // final segment is actually measured, the estimate that put the camera there
    // is usually wrong, and if it was too large the window sits past every card
    // and the viewport is blank. Re-clamp against the real height, then re-read:
    // the camera moved.
    if (this.dynamic && camera >= segments - 1 && this.layout.hasFrontier(camera)) {
      const realHeight = this.segmentHeight(camera);
      const maxOffset = Math.max(0, realHeight - windowHeight);
      if (offset > maxOffset + 0.5) {
        host.jumpToPosition(camera, maxOffset, true);
        camera = host.currentElement;
        offset = host.scrollOffset;
        lastSeg = this.ensureWindowFrontier(camera, segments, windowHeight, offset);
      }
    }

    for (let seg = camera - 1; seg <= lastSeg; seg++) {
      if (seg < 0 || seg >= segments) continue;
      // Never draw a segment whose frontier is outside the established range:
      // asking for it would silently re-anchor and invalidate the window
      // mid-frame.
      if (this.dynamic && !this.layout.hasFrontier(seg)) continue;
      const origin = this.screenOriginOf(seg, camera, offset);
      if (!Number.isFinite(origin)) continue;

      // Skip a neighbour that cannot reach the window. Laying one out costs a
      // full segment of measurements in dynamic mode, so paying for a segment
      // that contributes nothing is the difference between a smooth drag and a
      // stalled one.
      if (seg !== camera) {
        const extent = this.segmentHeight(seg);
        if (origin + extent < -this.overscan) continue;
        if (origin > windowHeight + this.overscan) continue;
      }

      const items = this.layout.itemsInWindow(
        seg, -this.overscan - origin, windowHeight + this.overscan * 2, this.buf
      );

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const screenY = origin + it.y;
        if (screenY + it.height < -this.overscan) continue;
        if (screenY > windowHeight + this.overscan) continue;

        if (screenY + it.height > 0 && screenY < anchorY) {
          anchorY = screenY;
          anchorIndex = it.index;
        }

        this.needed.add(it.index);
        let el = this.mounted.get(it.index);
        if (!el) {
          el = this.pool.pop() ?? this.createCard();
          el.dataset.elementIndex = String(it.index);
          this.options.renderItem(it.index, el);
          content.appendChild(el);
          this.mounted.set(it.index, el);
        }
        // No offsetHeight read: the oracle already supplied the height.
        this.write(el, it, screenY + this.pad.top);
      }
    }

    this.evict.length = 0;
    this.mounted.forEach((_, index) => {
      if (!this.needed.has(index)) this.evict.push(index);
    });
    for (let i = 0; i < this.evict.length; i++) {
      const index = this.evict[i];
      const el = this.mounted.get(index)!;
      if (el.parentNode) el.parentNode.removeChild(el);
      this.pool.push(el);
      this.mounted.delete(index);
    }

    this.anchor = anchorIndex >= 0 ? { index: anchorIndex, screenY: anchorY } : null;
    host.updateDisplay();
  }

  private write(el: HTMLElement, it: PlacedItem, screenY: number): void {
    const transform = `translate(${it.x + this.pad.left + this.centerOffset}px, ${screenY}px)`;
    if (el.style.transform !== transform) el.style.transform = transform;
    const h = it.height + 'px';
    if (el.style.height !== h) el.style.height = h;
    const w = it.width + 'px';
    if (el.style.width !== w) el.style.width = w;
  }

  private createCard(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:0;left:0;will-change:transform';
    return el;
  }

  /**
   * Screen y of a segment's origin for the current camera.
   *
   * Sums forward rather than special-casing a single neighbour: the window may
   * span several segments when their content is short, and stopping at
   * `camera + 1` is what leaves a blank band under the last drawn card.
   *
   * Always via {@link segmentHeight}, never the layout directly — see the
   * warning there about reads that mutate.
   */
  private screenOriginOf(segment: number, camera: number, offset: number): number {
    if (segment === camera) return -offset;
    if (segment === camera - 1) return -offset - this.segmentHeight(camera - 1);
    if (segment > camera) {
      let y = -offset;
      for (let s = camera; s < segment; s++) y += this.segmentHeight(s);
      return y;
    }
    return NaN;
  }

  /**
   * Watch for width changes. Returns a detach function.
   *
   * Observes the CONTENT box rather than the host: the scrollbar strip attaches
   * after construction and squeezes the content without changing the host's own
   * size, so a host observer would never fire for it and the first layout would
   * stay one strip-width too wide.
   */
  observeResize(host: MasonryHost, onRender: () => void): () => void {
    if (typeof ResizeObserver === 'undefined') return () => {};
    const target = this.content ?? this.host;


    const ro = new ResizeObserver(() => {
      // A drag-resize fires continuously and a width change costs a relayout.
      if (this.resizeRaf !== null) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = null;
        this.handleResize(host, onRender);
      });
    });
    ro.observe(target);
    return () => ro.disconnect();
  }

  /**
   * Recompute geometry against the current container, whether or not the width
   * changed since the last measurement.
   *
   * Used once after the scrollbar strip attaches: the constructor necessarily
   * measured before it existed, and a resize observation cannot be relied on to
   * correct that — on a reused host the padding is already present, so the
   * content box never changes size and nothing fires.
   *
   * @param host Engine surface.
   * @param onRender Called when the new geometry is ready to draw.
   */
  remeasure(host: MasonryHost, onRender: () => void): void {
    const width = this.availableWidth();
    if (width <= 0) return;

    // With cards on screen this is an ordinary relayout: hold the view, preserve
    // the reading position, rebuild in slices.
    if (this.mounted.size > 0) {
      this.lastWidth = -1;
      this.handleResize(host, onRender);
      return;
    }

    // Nothing has been drawn yet, so there is no view to hold and no camera to
    // preserve. Settle the geometry in place and return WITHOUT rendering:
    // this runs from the engine's constructor, and the usual consumer shape is
    //   scroller = new CeriousScroll(host, n, { onScroll: () => scroller.render... })
    // so invoking the callback here would reach a binding that does not exist
    // yet. The caller's first render picks up the corrected geometry.
    this.lastWidth = width;
    this.measurePadding();
    const geo = this.geometryFor(width);
    if (!this.layout.resize(geo.columns, geo.columnWidth)) return;
    this.setCenterOffset(width, geo.columns, geo.columnWidth);
  }

  /**
   * Host resized. A height change just re-syncs; a WIDTH change rebuilds the
   * layout, because every height is a function of column width.
   *
   * The camera cannot survive that — it is `(segment, offset)` in the old
   * geometry — so the re-anchor is on CONTENT: the card nearest the viewport top
   * is put back at the same screen position afterwards.
   */
  handleResize(host: MasonryHost, onRender: () => void): void {
    const width = this.availableWidth();
    if (width <= 0 || width === this.lastWidth) {
      if (!this.rebuilding) onRender();
      return;
    }

    this.lastWidth = width;
    this.measurePadding();
    const geo = this.geometryFor(width);
    if (!this.layout.resize(geo.columns, geo.columnWidth)) {
      onRender();
      return;
    }
    this.setCenterOffset(width, geo.columns, geo.columnWidth);
    // Every measured height was taken at the previous column width and is now
    // wrong; a text card reflows when its column narrows.
    this.heights?.clear();
    this.heightOrder.length = 0;

    this.pendingAnchor = this.anchor;
    this.rebuilding = true;
    this.scheduleRebuild(host, onRender);
  }

  /**
   * Rebuild the frontier chain in slices, holding the current view meanwhile.
   *
   * Chaining to the camera is one pass over everything above it and cannot be
   * shortened. In a single call that is a long frame on a large dataset; sliced,
   * each frame still has room to paint. The old cards stay mounted throughout so
   * the page holds a stale-but-coherent view rather than blanking.
   */
  private scheduleRebuild(host: MasonryHost, onRender: () => void): void {
    if (this.dynamic) {
      // Dynamic mode must NOT chain here. A resize invalidates every frontier,
      // so chaining to the camera means measuring every card above it: after
      // scrolling to card 400,000 a relayout measured 500,010 cards across 384
      // frames. Anchor at the camera's segment instead — the same policy a far
      // jump uses, and for the same reason.
      const target = this.pendingAnchor
        ? Math.min(
            Math.floor(this.pendingAnchor.index / this.layout.segmentSize),
            Math.max(0, this.layout.segmentCount() - 1)
          )
        : 0;
      this.layout.anchorFlushAt(target);
      this.finishRebuild(host, onRender);
      return;
    }
    if (this.rebuildRaf !== null) return;
    this.rebuildRaf = requestAnimationFrame(() => {
      this.rebuildRaf = null;
      const target = this.pendingAnchor
        ? Math.floor(this.pendingAnchor.index / this.layout.segmentSize)
        : 0;
      if (!this.layout.chainAhead(target, this.sliceMs)) {
        this.scheduleRebuild(host, onRender);
        return;
      }
      this.finishRebuild(host, onRender);
    });
  }

  private finishRebuild(host: MasonryHost, onRender: () => void): void {
    const anchor = this.pendingAnchor;
    this.pendingAnchor = null;
    this.rebuilding = false;

    this.mounted.forEach((el) => {
      if (el.parentNode) el.parentNode.removeChild(el);
      this.pool.push(el);
    });
    this.mounted.clear();

    if (anchor) {
      // Via cameraForItem, never locateItem + segmentAtY: that pair binary
      // searches segment ORIGINS, and every probe outside the range anchors and
      // re-bases. It is the same trap that made jumpToItem take 8.6 seconds.
      const pos = this.cameraForItem(anchor.index, anchor.screenY);
      if (pos) host.jumpToPosition(pos.segment, pos.offset, true);
    }

    host.refreshScrollbarMetrics();
    onRender();
    this.scheduleTailChain(host);
  }

  /**
   * Chain to the very end in the background so the scrollbar stops being an
   * estimate. Smaller slice: this competes with real scrolling, and nothing
   * depends on it finishing.
   */
  scheduleTailChain(host: MasonryHost): void {
    if (this.tailRaf !== null) return;
    this.tailRaf = requestAnimationFrame(() => {
      this.tailRaf = null;
      if (!this.layout.chainAhead(this.layout.segmentCount(), 3)) {
        this.scheduleTailChain(host);
        return;
      }
      host.refreshScrollbarMetrics();
    });
  }

  /**
   * Absolute y of a card, for `jumpToItem`.
   *
   * In dynamic mode the target segment is anchored FIRST when it is far from the
   * current range. Without that, locating a card walks the frontier all the way
   * to it, measuring every card on the way: jumping to card 400,000 of 500,000
   * took 2.9s and 437,472 measurements — a locked-up tab.
   */
  /**
   * Camera position that puts a card at `screenOffset` from the viewport top.
   *
   * Deliberately avoids absolute y in dynamic mode. Going through
   * `locateItem` + `segmentAtY` means a binary search over segment ORIGINS, and
   * every probe asks for a frontier the range does not hold — so each step
   * anchors, re-bases, and re-measures. Jumping to card 400,000 that way took
   * 8.6 seconds. The segment a card belongs to is pure arithmetic; only its
   * offset inside that segment needs the layout.
   *
   * @param index Card index.
   * @param screenOffset Pixels below the viewport top to place it.
   * @returns `{ segment, offset }`, or null if the card is out of range.
   */
  cameraForItem(index: number, screenOffset: number): { segment: number; offset: number } | null {
    if (!this.dynamic) {
      const found = this.layout.locateItem(index);
      if (!found) return null;
      const r = this.layout.segmentAtY(Math.max(0, found.y - screenOffset));
      return { segment: r.segment, offset: r.offset };
    }

    const segment = Math.min(
      Math.floor(index / this.layout.segmentSize),
      Math.max(0, this.layout.segmentCount() - 1)
    );
    if (segment < 0) return null;

    if (!this.layout.hasFrontier(segment)) {
      const reach = this.layout.frontierReach;
      const near =
        reach >= 0 && segment >= this.layout.frontierBase &&
        segment - reach <= this.maxChainSegments;
      if (near) this.layout.chainAhead(segment, Number.POSITIVE_INFINITY);
      if (!this.layout.hasFrontier(segment)) this.layout.anchorFlushAt(segment);
    }

    // y here is relative to the segment's own origin, which is all the camera
    // needs — (segment, offset) never refers to a global pixel space.
    let within = 0;
    for (const it of this.layout.getSegment(segment)) {
      if (it.index === index) { within = it.y; break; }
    }
    return { segment, offset: Math.max(0, within - screenOffset) };
  }

  locateItem(index: number) {
    if (this.dynamic) {
      const segment = Math.min(
        Math.floor(index / this.layout.segmentSize),
        Math.max(0, this.layout.segmentCount() - 1)
      );
      if (!this.layout.hasFrontier(segment)) {
        const reach = this.layout.frontierReach;
        const near =
          reach >= 0 && segment >= this.layout.frontierBase &&
          segment - reach <= this.maxChainSegments;
        if (near) this.layout.chainAhead(segment, Number.POSITIVE_INFINITY);
        if (!this.layout.hasFrontier(segment)) this.layout.anchorFlushAt(segment);
      }
    }
    return this.layout.locateItem(index);
  }

  segmentAtY(y: number) {
    return this.layout.segmentAtY(y);
  }

  dispose(): void {
    if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
    if (this.rebuildRaf !== null) cancelAnimationFrame(this.rebuildRaf);
    if (this.tailRaf !== null) cancelAnimationFrame(this.tailRaf);
    this.mounted.forEach((el) => { if (el.parentNode) el.parentNode.removeChild(el); });
    this.mounted.clear();
    this.pool.length = 0;
    if (this.probe && this.probe.parentNode) this.probe.parentNode.removeChild(this.probe);
    this.probe = null;
    this.heights?.clear();
    this.heightOrder.length = 0;
    if (this.content && this.content.parentNode) {
      this.content.parentNode.removeChild(this.content);
    }
    this.content = null;
  }
}
