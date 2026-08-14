/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * How a row reaches its y-coordinate. ViewportRenderer owns measure/pool;
 * this owns the DOM writes. The per-frame shift is local (overscan +
 * partial-row offset), never a sum from row 0 — so neither strategy hits
 * the browser max-element-height ceiling.
 *
 * - {@link AbsolutePlacement}: out-of-flow `top`. No compositor layer.
 * - {@link TableFlowPlacement}: real `<tr>`/`<td>` in one table; one
 *   `translateY` on `<tbody>` for column sync. Opt-in GPU layer.
 */

/**
 * Which logical region of a frame a row belongs to.
 *
 * - `'window'`: visible / overscan, contiguous with the camera.
 * - `'bottom'`: tail row mounted only to measure height. Absolute mode
 *   parks these far down via `top`; table mode measures them offscreen
 *   so they don't occupy the window's flow.
 */
export type PlacementRegion = 'window' | 'bottom';

/**
 * Strategy that decides how a rendered row element is created, inserted,
 * positioned, and removed for a single virtual-scroll frame.
 *
 * The renderer owns the algorithm and element pool; the strategy owns every DOM
 * mutation that is specific to a placement model. Methods are called in this
 * order per frame: {@link prepare} once, then for each rendered row
 * {@link createRow}/{@link initRow} (on miss) + {@link attach} + {@link position},
 * then {@link detach} for evicted rows, then {@link commit} once.
 */
export interface RowPlacement {
  /**
   * Per-frame container preparation, called before any rows are placed.
   * AbsolutePlacement uses this to make the container visible and positioned.
   *
   * @param container Host rows are attached to.
   */
  prepare(container: HTMLElement): void;

  /**
   * Drop all live rows from the DOM (the big-jump rebuild path). Equivalent to
   * the old `container.innerHTML = ''`, but routed through the strategy so it
   * controls *where* rows live (the container itself vs. an inner wrapper).
   *
   * @param container Host whose live rows should be removed.
   */
  clear(container: HTMLElement): void;

  /**
   * Create a fresh, empty row element with its static (non-positional) styles
   * already applied. AbsolutePlacement returns a `<div>`.
   *
   * @returns Empty row element.
   */
  createRow(): HTMLElement;

  /**
   * Re-apply static styles to a recycled element pulled from the pool. Called
   * instead of {@link createRow} when a pooled element is reused.
   *
   * @param el Pooled row element.
   */
  initRow(el: HTMLElement): void;

  /**
   * Insert a row element (new or recycled) into the live view so it can be
   * rendered and measured. AbsolutePlacement appends to the container; DOM order
   * is irrelevant because each row carries its own `top`. A flow strategy routes
   * the row to the window group or the offscreen measure group per `region` and
   * fixes ordering later in {@link commit}.
   *
   * @param container Host.
   * @param el Row element.
   * @param index Logical dataset index.
   * @param region `'window'` or `'bottom'` (tail measure).
   */
  attach(container: HTMLElement, el: HTMLElement, index: number, region: PlacementRegion): void;

  /**
   * Position a single row at its cumulative top (px from the frame origin).
   * AbsolutePlacement writes `el.style.top`. A flow strategy treats this as a
   * no-op for vertical placement (the whole window is shifted once in
   * {@link commit}) but uses `region` to relocate a reused row whose group
   * changed since the last frame (e.g. a tail row that scrolled into the window).
   *
   * @param el Row element.
   * @param top Pixels from the frame origin.
   * @param region `'window'` or `'bottom'`.
   */
  position(el: HTMLElement, top: number, region: PlacementRegion): void;

  /**
   * Remove a row element from the DOM so it can be recycled.
   *
   * @param container Host.
   * @param el Row element to detach.
   */
  detach(container: HTMLElement, el: HTMLElement): void;

  /**
   * Finalize the frame after all visible/overscan rows are placed.
   * `firstRowTop` is the cumulative top of the first rendered row (the
   * most-negative value, `-offset - bufferAboveHeight`). AbsolutePlacement is a
   * no-op; a flow strategy sets its single wrapper transform here.
   *
   * @param container Host.
   * @param firstRowTop Cumulative top of the first rendered row.
   */
  commit(container: HTMLElement, firstRowTop: number): void;

  /**
   * Optional: drop a cached {@link getTopInset} value (container resize, header
   * content change). No-op for placements without a top inset.
   */
  invalidateTopInset?(): void;

  /**
   * Optional: vertical space at the top of the container that is NOT part of the
   * scrollable viewport (e.g. a header row that sits above the rows). The host
   * subtracts this from the measured viewport height so scroll math and
   * true-bottom account for the header. Defaults to 0 when unimplemented.
   *
   * @returns Header height in pixels.
   */
  getTopInset?(): number;
}

export class AbsolutePlacement implements RowPlacement {
  private readonly _style = {
    position: 'absolute',
    left: '0px',
    right: '0px',
    visible: 'visible',
    width: '100%'
  };
  private _topBuffer = '';

  prepare(container: HTMLElement): void {
    if (container.style.visibility === 'hidden') {
      container.style.visibility = this._style.visible;
      container.style.position = this._style.position;
      container.style.left = this._style.left;
      container.style.top = this._style.left; // 0px
      container.style.width = this._style.width;
    }
  }

  clear(container: HTMLElement): void {
    container.innerHTML = '';
  }

  createRow(): HTMLElement {
    const el = document.createElement('div');
    el.style.position = this._style.position;
    el.style.left = this._style.left;
    el.style.right = this._style.right;
    return el;
  }

  initRow(el: HTMLElement): void {
    el.style.position = this._style.position;
    el.style.left = this._style.left;
    el.style.right = this._style.right;
  }

  attach(container: HTMLElement, el: HTMLElement, _index: number, _region: PlacementRegion): void {
    container.appendChild(el);
  }

  position(el: HTMLElement, top: number, _region: PlacementRegion): void {
    // createRow/initRow already set position:absolute. Rewriting it every
    // frame for every visible row was wasted style invalidation. Only write
    // `top` when the pixel value actually changed (reflow-without-scroll).
    this._topBuffer = top + 'px';
    if (el.style.top !== this._topBuffer) {
      el.style.top = this._topBuffer;
    }
  }

  detach(container: HTMLElement, el: HTMLElement): void {
    if (el.parentNode === container) {
      container.removeChild(el);
    }
  }

  commit(_container: HTMLElement, _firstRowTop: number): void {}
}

/**
 * Configuration for {@link TableFlowPlacement}.
 */
export interface TableFlowOptions {
  /**
   * One-time header populator. Receives the live `<thead>` so the caller can
   * append a header `<tr>` of `<th>`s. The header then lives in the same
   * `<table>` as the body rows.
   *
   * NOTE: an in-table header occupies viewport space above the rows, so the
   * engine must reserve a top inset for it (see {@link TableFlowPlacement.getTopInset}).
   * For pixel-exact bottom alignment across displays, prefer rendering the header
   * as a SEPARATE element above the scroll host and leaving this unset — the body
   * then has no inset and uses the exact same scroll math as the default mode.
   * Use {@link columnWidths} to keep the external header's columns aligned.
   */
  header?: (thead: HTMLTableSectionElement) => void;
  /**
   * Fixed column widths applied to the body (and offscreen measure) table via a
   * `<colgroup>`. Each entry is a CSS width (e.g. `'120px'`) or `''`/`'auto'` to
   * let `table-layout: fixed` distribute the remaining space. Pair with the same
   * widths on an external header table so its columns line up with the rows.
   */
  columnWidths?: string[];
  /**
   * Auto-size columns to content, ONCE. With `table-layout: auto` (the default),
   * columns can shift as wide content scrolls into the window because only the
   * windowed rows are in the DOM. Set this to measure each column's natural width
   * from the first rendered window (+ header) and then pin those widths via a
   * `<colgroup>` + `table-layout: fixed` — so columns are content-sized but
   * STABLE (no scroll jitter), with no manual widths. Content wider than the
   * measured width is clipped by the cell's own overflow rules. Ignored when
   * {@link columnWidths} is provided. Measured once per scroller instance —
   * recreate the scroller to re-measure (e.g. after a column or dataset change).
   */
  autoSizeColumns?: boolean;
  /** Optional class applied to the generated `<table>` for styling. */
  tableClassName?: string;
  /** Optional class applied to the generated `<thead>`. */
  theadClassName?: string;
  /** Optional class applied to the body `<tbody>` that holds the virtual rows. */
  tbodyClassName?: string;
}

/** Real `<tr>` in one table; `translateY` on tbody. DOM order and offscreen tail measure live here. */
export class TableFlowPlacement implements RowPlacement {
  private container: HTMLElement | null = null;
  private table: HTMLTableElement | null = null;
  private measureTable: HTMLTableElement | null = null;
  private thead: HTMLTableSectionElement | null = null;
  private tbodyMain: HTMLTableSectionElement | null = null;
  private tbodyMeasure: HTMLTableSectionElement | null = null;

  // autoSizeColumns: pinned after the first window is measured; reset on clear()
  // of the dataset so a data reset re-measures.
  private _columnsSized = false;
  private _cachedTopInset: number | undefined;

  // Reused buffers to avoid per-frame allocations.
  private _transformBuffer = '';
  private _sortBuffer: HTMLElement[] = [];
  private _colWidthBuffer: number[] = [];

  /**
   * @param options Table scaffold / column-sizing options.
   */
  constructor(private readonly options: TableFlowOptions = {}) {}

  prepare(container: HTMLElement): void {
    if (this.table && this.container === container) return; // scaffold already built

    this.container = container;
    // Clip rows translated outside the viewport, and establish a positioning
    // context for the offscreen measure table. Don't clobber an overflow the
    // host already manages (e.g. a content element with `overflow-y: clip` and
    // `overflow-x: auto` for horizontal scrolling).
    const s = container.style;
    if (!s.overflow && !s.overflowY && !s.overflowX) s.overflow = 'hidden';
    if (typeof getComputedStyle === 'function' &&
        getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Single shared table: <thead> + body <tbody>. One formatting context => the
    // browser auto-aligns header and body columns, like any normal table.
    const table = document.createElement('table');
    table.style.width = '100%';
    // Note: table-layout / border-collapse are left to CSS. Prefer
    // `border-collapse: separate` in table mode — collapsed borders are painted
    // by the (untransformed) table, so they would NOT move with the tbody
    // transform during scroll. `table-layout: fixed` also avoids a horizontal
    // scrollbar from content-sized columns.
    if (this.options.tableClassName) table.className = this.options.tableClassName;

    // Fixed column widths shared with an (optional) external header table.
    const bodyColgroup = this.buildColgroup();
    if (bodyColgroup) table.appendChild(bodyColgroup);

    // Only build an in-table header when a populator is given. Omitting it keeps
    // the body free of a top inset (see class doc) so the scroll math matches the
    // default placement exactly — the recommended setup for a frozen header.
    let thead: HTMLTableSectionElement | null = null;
    if (this.options.header) {
      thead = document.createElement('thead');
      if (this.options.theadClassName) thead.className = this.options.theadClassName;
      // Keep the header painting above body rows that translate up under it.
      thead.style.position = 'relative';
      thead.style.zIndex = '1';
      this.options.header(thead);
      table.appendChild(thead);
    }

    const tbodyMain = document.createElement('tbody');
    if (this.options.tbodyClassName) tbodyMain.className = this.options.tbodyClassName;
    // Hint the compositor: the body is the one element we transform each frame.
    tbodyMain.style.willChange = 'transform';
    table.appendChild(tbodyMain);

    container.appendChild(table);

    // Offscreen, non-interactive table whose only job is to hold tail rows long
    // enough to measure their heights for true-bottom math. It carries the SAME
    // class as the visible table so column layout (and therefore measured row
    // heights) match, and so it can't widen the scroll region differently than
    // the real one.
    const measureTable = document.createElement('table');
    measureTable.setAttribute('aria-hidden', 'true');
    if (this.options.tableClassName) measureTable.className = this.options.tableClassName;
    measureTable.style.cssText =
      'position:absolute;top:0;left:0;width:100%;' +
      'visibility:hidden;pointer-events:none;';
    const measureColgroup = this.buildColgroup();
    if (measureColgroup) measureTable.appendChild(measureColgroup);
    const tbodyMeasure = document.createElement('tbody');
    measureTable.appendChild(tbodyMeasure);
    container.appendChild(measureTable);

    this.table = table;
    this.measureTable = measureTable;
    this.thead = thead;
    this.tbodyMain = tbodyMain;
    this.tbodyMeasure = tbodyMeasure;
  }

  /** Build a `<colgroup>` from `columnWidths`, or null if none configured. */
  private buildColgroup(): HTMLTableColElement | null {
    const widths = this.options.columnWidths;
    if (!widths || widths.length === 0) return null;
    const colgroup = document.createElement('colgroup');
    for (const w of widths) {
      const col = document.createElement('col');
      if (w && w !== 'auto') col.style.width = w;
      colgroup.appendChild(col);
    }
    return colgroup as HTMLTableColElement;
  }

  clear(_container: HTMLElement): void {
    if (this.tbodyMain) this.tbodyMain.textContent = '';
    if (this.tbodyMeasure) this.tbodyMeasure.textContent = '';
    this._cachedTopInset = undefined;
  }

  createRow(): HTMLElement {
    return document.createElement('tr');
  }

  initRow(_el: HTMLElement): void {}

  attach(_container: HTMLElement, el: HTMLElement, _index: number, region: PlacementRegion): void {
    // Attach immediately so the row is in a <table> and measurable right after
    // renderElement. Final ordering of the window is fixed in commit().
    const tbody = region === 'bottom' ? this.tbodyMeasure! : this.tbodyMain!;
    tbody.appendChild(el);
  }

  position(el: HTMLElement, _top: number, region: PlacementRegion): void {
    // Vertical placement is handled once per frame by the tbody transform in
    // commit(); there is no per-row `top`. The only work here is relocating a
    // reused row whose region changed since the last frame (e.g. a tail row that
    // scrolled into the window, or vice versa).
    const tbody = region === 'bottom' ? this.tbodyMeasure! : this.tbodyMain!;
    if (el.parentNode !== tbody) tbody.appendChild(el);
  }

  detach(_container: HTMLElement, el: HTMLElement): void {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  commit(_container: HTMLElement, firstRowTop: number): void {
    const tbody = this.tbodyMain;
    if (!tbody) return;

    this.reorder(tbody);
    this.maybeAutoSizeColumns();
    this._transformBuffer = 'translateY(' + firstRowTop + 'px)';
    tbody.style.transform = this._transformBuffer;
  }

  /**
   * If `autoSizeColumns` is on and not yet applied, measure each column's natural
   * content width from the first rendered window (header + body cells) and pin it
   * via a `<colgroup>` + `table-layout: fixed`. Runs once: thereafter columns are
   * stable. Skipped when explicit `columnWidths` were given.
   */
  private maybeAutoSizeColumns(): void {
    if (!this.options.autoSizeColumns || this._columnsSized) return;
    if (this.options.columnWidths && this.options.columnWidths.length) return;
    const tbody = this.tbodyMain;
    const table = this.table;
    if (!tbody || !table || tbody.children.length === 0) return;

    // Query <td>/<th> rather than direct children: framework wrappers may nest
    // cells inside a `display: contents` element, so the cells are descendants of
    // the <tr>, not its immediate children.
    const colCount = (tbody.children[0] as HTMLElement).querySelectorAll('td').length;
    if (colCount === 0) return;

    // Measure max natural cell width per column. The table is still auto-layout
    // here, so each cell's offsetWidth is its content-driven width.
    const widths = this._colWidthBuffer;
    widths.length = 0;
    for (let i = 0; i < colCount; i++) widths.push(0);
    const measureCells = (cells: NodeListOf<HTMLElement>): void => {
      for (let i = 0; i < colCount && i < cells.length; i++) {
        const w = cells[i].offsetWidth;
        if (w > widths[i]) widths[i] = w;
      }
    };
    const headRow = this.thead?.querySelector('tr');
    if (headRow) measureCells(headRow.querySelectorAll<HTMLElement>('th'));
    for (let r = 0; r < tbody.children.length; r++) {
      measureCells((tbody.children[r] as HTMLElement).querySelectorAll<HTMLElement>('td'));
    }

    // Pin the widths and switch to fixed layout (stable from now on). Apply to
    // the offscreen measure table too so tail row heights stay consistent.
    this.applyMeasuredColgroup(table, widths);
    if (this.measureTable) this.applyMeasuredColgroup(this.measureTable, widths);
    table.style.tableLayout = 'fixed';
    if (this.measureTable) this.measureTable.style.tableLayout = 'fixed';
    this._columnsSized = true;
  }

  /** Replace (or insert) a `<colgroup>` of fixed px widths at the top of a table. */
  private applyMeasuredColgroup(table: HTMLTableElement, widths: number[]): void {
    const existing = table.querySelector('colgroup');
    if (existing) existing.remove();
    const colgroup = document.createElement('colgroup');
    for (const w of widths) {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      colgroup.appendChild(col);
    }
    table.insertBefore(colgroup, table.firstChild);
  }

  getTopInset(): number {
    // Use the sub-pixel-accurate rendered height, not offsetHeight (which rounds
    // to an integer). On fractional-scale displays (Retina) a rounded inset
    // throws off the body-area height by up to ~1px, which accumulates into the
    // true-bottom anchor and clips the last row. getBoundingClientRect is exact.
    // Cache the result: scroll() and renderViewport() used to force a layout on
    // every wheel/touch event. Don't cache 0 — an async header may still mount.
    if (this._cachedTopInset !== undefined) return this._cachedTopInset;
    if (!this.thead) return 0;
    const h = this.thead.getBoundingClientRect().height;
    const inset = h > 0 ? h : this.thead.offsetHeight;
    if (inset > 0) this._cachedTopInset = inset;
    return inset;
  }

  invalidateTopInset(): void {
    this._cachedTopInset = undefined;
  }

  /**
   * DOM order drifts after recycle; normalize by `data-element-index`.
   */
  private reorder(tbody: HTMLTableSectionElement): void {
    const children = tbody.children;
    const n = children.length;
    if (n < 2) return;

    const arr = this._sortBuffer;
    arr.length = 0;
    for (let i = 0; i < n; i++) arr.push(children[i] as HTMLElement);
    arr.sort(
      (a, b) => (+(a.dataset.elementIndex ?? 0)) - (+(b.dataset.elementIndex ?? 0))
    );

    let ordered = true;
    for (let i = 0; i < n; i++) {
      if (children[i] !== arr[i]) { ordered = false; break; }
    }
    if (ordered) return;

    for (let i = 0; i < arr.length; i++) tbody.appendChild(arr[i]);
  }
}
