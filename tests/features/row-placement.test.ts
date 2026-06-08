/**
 * @fileoverview Tests for row placement strategies (absolute vs table flow).
 *
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AbsolutePlacement,
  TableFlowPlacement
} from '../../src/features/row-placement.js';
import { CeriousScroll } from '../../src/cerious-scroll.js';

/** Build a real (jsdom) container attached to the document. */
function realContainer(): HTMLElement {
  const el = document.createElement('div');
  el.style.height = '600px';
  document.body.appendChild(el);
  return el;
}

describe('AbsolutePlacement', () => {
  let placement: AbsolutePlacement;
  let container: HTMLElement;

  beforeEach(() => {
    placement = new AbsolutePlacement();
    container = realContainer();
  });

  it('creates out-of-flow <div> rows', () => {
    const row = placement.createRow();
    expect(row.tagName).toBe('DIV');
    expect(row.style.position).toBe('absolute');
  });

  it('appends rows to the container and positions them via top', () => {
    const row = placement.createRow();
    placement.attach(container, row, 0, 'window');
    placement.position(row, 120, 'window');
    expect(row.parentElement).toBe(container);
    expect(row.style.top).toBe('120px');
  });

  it('detach removes a row from the container', () => {
    const row = placement.createRow();
    placement.attach(container, row, 0, 'window');
    placement.detach(container, row);
    expect(row.parentElement).toBeNull();
  });

  it('does not expose a top inset', () => {
    expect(placement.getTopInset).toBeUndefined();
  });
});

describe('TableFlowPlacement', () => {
  let placement: TableFlowPlacement;
  let container: HTMLElement;

  beforeEach(() => {
    placement = new TableFlowPlacement();
    container = realContainer();
    placement.prepare(container);
  });

  it('builds a body table (no thead without a header) plus an offscreen measure table', () => {
    const tables = container.querySelectorAll('table');
    // One visible table + one offscreen measure table.
    expect(tables.length).toBe(2);
    const main = tables[0];
    // No header populator was given, so there must be NO <thead> — that keeps the
    // body free of a top inset so the bottom lands exactly.
    expect(main.querySelector('thead')).toBeNull();
    expect(main.querySelector('tbody')).not.toBeNull();
  });

  it('reports zero top inset when there is no in-table header', () => {
    expect(placement.getTopInset()).toBe(0);
  });

  it('applies columnWidths as a <colgroup> on the body and measure tables', () => {
    const c = realContainer();
    const p = new TableFlowPlacement({ columnWidths: ['110px', '', '90px'] });
    p.prepare(c);
    const tables = c.querySelectorAll('table');
    for (const t of tables) {
      const cols = t.querySelectorAll('colgroup col');
      expect(cols.length).toBe(3);
      expect((cols[0] as HTMLElement).style.width).toBe('110px');
      expect((cols[1] as HTMLElement).style.width).toBe(''); // auto-distributed
      expect((cols[2] as HTMLElement).style.width).toBe('90px');
    }
  });

  it('prepare is idempotent (no duplicate scaffold on re-render)', () => {
    placement.prepare(container);
    placement.prepare(container);
    expect(container.querySelectorAll('table').length).toBe(2);
  });

  it('creates real <tr> rows', () => {
    expect(placement.createRow().tagName).toBe('TR');
  });

  it('routes window rows to the body tbody and bottom rows offscreen', () => {
    const bodyTbody = container.querySelectorAll('table')[0].querySelector('tbody')!;
    const measureTbody = container.querySelectorAll('table')[1].querySelector('tbody')!;

    const windowRow = placement.createRow();
    windowRow.dataset.elementIndex = '3';
    placement.attach(container, windowRow, 3, 'window');

    const tailRow = placement.createRow();
    tailRow.dataset.elementIndex = '990';
    placement.attach(container, tailRow, 990, 'bottom');

    expect(windowRow.parentElement).toBe(bodyTbody);
    expect(tailRow.parentElement).toBe(measureTbody);
  });

  it('relocates a reused row when its region changes', () => {
    const bodyTbody = container.querySelectorAll('table')[0].querySelector('tbody')!;
    const measureTbody = container.querySelectorAll('table')[1].querySelector('tbody')!;

    const row = placement.createRow();
    row.dataset.elementIndex = '950';
    placement.attach(container, row, 950, 'bottom');
    expect(row.parentElement).toBe(measureTbody);

    // Scrolled into the window: position() with the new region should move it.
    placement.position(row, 0, 'window');
    expect(row.parentElement).toBe(bodyTbody);
  });

  it('commit orders body rows by index and sets a single tbody transform', () => {
    const bodyTbody = container.querySelectorAll('table')[0].querySelector('tbody')!;

    // Attach out of order to force a reorder.
    for (const i of [5, 2, 8, 1]) {
      const row = placement.createRow();
      row.dataset.elementIndex = String(i);
      placement.attach(container, row, i, 'window');
    }

    placement.commit(container, -42);

    const order = Array.from(bodyTbody.children).map(
      (r) => (r as HTMLElement).dataset.elementIndex
    );
    expect(order).toEqual(['1', '2', '5', '8']);
    expect(bodyTbody.style.transform).toBe('translateY(-42px)');
  });

  it('autoSizeColumns measures cells once and pins them (colgroup + fixed layout)', () => {
    Object.defineProperty(HTMLTableCellElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return 50; },
    });
    try {
      const c = realContainer();
      const ap = new TableFlowPlacement({
        autoSizeColumns: true,
        header: (thead) => { thead.innerHTML = '<tr><th>A</th><th>B</th></tr>'; },
      });
      ap.prepare(c);
      for (let i = 0; i < 2; i++) {
        const tr = ap.createRow();
        tr.dataset.elementIndex = String(i);
        tr.innerHTML = '<td>x</td><td>y</td>';
        ap.attach(c, tr, i, 'window');
      }
      ap.commit(c, 0);

      const mainTable = c.querySelectorAll('table')[0];
      expect(mainTable.style.tableLayout).toBe('fixed');
      const cols = mainTable.querySelectorAll('colgroup col');
      expect(cols.length).toBe(2);
      expect((cols[0] as HTMLElement).style.width).toBe('50px');
      // The offscreen measure table is pinned the same way (matching heights).
      expect(c.querySelectorAll('table')[1].style.tableLayout).toBe('fixed');
    } finally {
      // @ts-expect-error remove the stubbed getter
      delete HTMLTableCellElement.prototype.offsetWidth;
    }
  });

  it('invokes the header populator exactly once', () => {
    const header = vi.fn((thead: HTMLTableSectionElement) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<th>Name</th><th>Email</th>';
      thead.appendChild(tr);
    });
    const c = realContainer();
    const p = new TableFlowPlacement({ header });
    p.prepare(c);
    p.prepare(c); // second call must not re-run the header
    expect(header).toHaveBeenCalledTimes(1);
    expect(c.querySelectorAll('thead th').length).toBe(2);
  });
});

describe('CeriousScroll table layout integration', () => {
  let container: HTMLElement;
  let scroller: CeriousScroll;

  beforeEach(() => {
    // Give rows a real height so the window does not swallow the whole dataset
    // (jsdom reports 0 otherwise), leaving tail rows for the offscreen measurer.
    Object.defineProperty(HTMLTableRowElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return 30; }
    });
    container = realContainer();
    scroller = new CeriousScroll(container, 1000, {
      attachScrollbar: false,
      observeContentChanges: false,
      autoResize: false,
      layout: 'table',
      table: {
        header: (thead) => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<th>#</th><th>Value</th>';
          thead.appendChild(tr);
        }
      }
    });
  });

  afterEach(() => {
    scroller.dispose();
    // @ts-expect-error cleanup the stubbed getter
    delete HTMLTableRowElement.prototype.offsetHeight;
  });

  it('renders native <tr>/<td> rows inside a shared table with a header', () => {
    scroller.renderViewport(600, container, (index, row) => {
      row.innerHTML = `<td>${index}</td><td>row ${index}</td>`;
    });

    const table = container.querySelector('table')!;
    expect(table).not.toBeNull();
    expect(table.querySelectorAll('thead th').length).toBe(2);

    const bodyRows = table.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBeGreaterThan(0);
    // Real table cells.
    expect(bodyRows[0].querySelectorAll('td').length).toBe(2);
  });

  it('keeps the body window contiguous and parks tail rows offscreen', () => {
    scroller.renderViewport(600, container, (index, row) => {
      row.innerHTML = `<td>${index}</td>`;
    });

    const tables = container.querySelectorAll('table');
    const bodyRows = Array.from(tables[0].querySelectorAll('tbody tr')) as HTMLElement[];
    const indices = bodyRows.map((r) => Number(r.dataset.elementIndex));

    // Window is contiguous and ascending.
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
    // Tail/bottom rows (index 999 etc.) must NOT be in the visible body flow.
    expect(indices).not.toContain(999);

    // The offscreen measure table holds the tail rows instead.
    const measureRows = tables[1].querySelectorAll('tbody tr');
    expect(measureRows.length).toBeGreaterThan(0);
  });

  it('applies a single transform to the body tbody, not per-row tops', () => {
    scroller.scroll(300, 600);
    scroller.renderViewport(600, container, (index, row) => {
      row.innerHTML = `<td>${index}</td>`;
    });

    const tbody = container.querySelector('tbody')!;
    expect(tbody.style.transform).toContain('translateY(');

    const firstRow = tbody.querySelector('tr') as HTMLElement;
    // Flow rows carry no inline top.
    expect(firstRow.style.top).toBe('');
  });
});
