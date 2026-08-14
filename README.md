# Cerious Scroll™

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/%40ceriousdevtech%2Fcerious-scroll.svg)](https://www.npmjs.com/package/@ceriousdevtech/cerious-scroll)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://ceriousdevtech.github.io/cerious-scroll/)

Virtual scrolling for lists too large to keep in the DOM. Position is an element index plus a pixel offset into that row — not a pixel from the top of the dataset — so variable heights don’t need a prefix-sum of every row. Memory stays bounded: only the visible window (plus overscan) is mounted, and measured heights live in a sliding cache.

Typical uses: data grids, chat, log viewers, trading tickers, analytics tables.

---

## Demo

**[Live demos →](https://ceriousdevtech.github.io/cerious-scroll/)** — basic virtual scroll, data grid, chat, log viewer, code viewer, e-commerce, finance ticker, git history, SQL results, and a side-by-side bake-off against Clusterize.js.

To run locally:

```bash
npm install
npm run build
npx http-server . -p 8080   # then open http://localhost:8080/
```

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — engine internals, the element-based positioning algorithm, and the controller/observer model.
- [Implementation Guide](docs/IMPLEMENTATION_GUIDE.md) — step-by-step usage, options, lifecycle, and integration patterns.

---

## Features

- **True O(1) Memory Usage**  
  Constant memory regardless of dataset size (tested with 100M+ elements)

- **Consistent 60 FPS+ Performance**  
  Sub-millisecond scroll calculations under real-world load

- **Native Variable Height Support**  
  No pre-calculation required — automatic, on-demand measurement

- **Native `<table>` Layout (opt-in)**  
  `layout: 'table'` renders real `<tr>`/`<td>` rows in one shared table — frozen header, native column alignment, auto-sized columns — while staying O(1). See [Table Layout](#table-layout-layout-table).

- **Framework Agnostic**  
  Works with Vanilla JS, Angular, React, Vue, or any framework

- **Native Scrollbar Integration**  
  Familiar UX with accurate bidirectional synchronization

- **Element-Based Positioning Algorithm**  
  Eliminates fragile pixel-math approaches

- **No GPU Transforms (default mode)**  
  The default `<div>` mode uses pure DOM positioning — no `translate3d` hacks. (The opt-in table layout uses a single `<tbody>` transform.)

- **TypeScript Support**  
  Full type definitions included

---

## Installation

### npm
```bash
npm install @ceriousdevtech/cerious-scroll
```

### From Source
```bash
# Clone the repository
git clone https://github.com/ceriousdevtech/cerious-scroll.git
cd cerious-scroll

# Install dependencies and build
npm install
npm run build

# Use the built files from dist/
```

### Direct Download
Download the latest release from [GitHub Releases](https://github.com/ceriousdevtech/cerious-scroll/releases) and include:
```html
<script src="path/to/cerious-scroll.bundle.js"></script>
```

Or via CDN:
```html
<script src="https://unpkg.com/@ceriousdevtech/cerious-scroll@latest/dist/cerious-scroll.min.js"></script>
```

---

## Quick Start

Constructor is `(container, totalElements, options?)`. There is no default-height argument. Drive rendering from `onScroll` — it runs for wheel, touch, keyboard, scrollbar, and resize. The engine measures `offsetHeight` after your callback; you do not need to return a height.

```javascript
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const data = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  content: `Item ${i}`
}));

const container = document.getElementById('scroll-container');

function render() {
  scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      element.innerHTML = `<div class="item">${data[index].content}</div>`;
    }
  );
}

const scroller = new CeriousScroll(container, data.length, {
  onScroll: render,
});

render();
```

Jump with `jumpToElement(i)` or `handleScrollPercentage(n)`. Grow the dataset with `updateTotalElements(n)` rather than constructing a new scroller mid-drag. Tear down with `dispose()`.

---

## Table Layout (`layout: 'table'`)

By default, rows are absolutely-positioned `<div>`s. Opt into **real HTML tables** — `<table>` / `<tr>` / `<td>` with native column alignment and a frozen header — by passing `layout: 'table'`:

```javascript
const scroller = new CeriousScroll(container, data.length, {
  layout: 'table',
  table: {
    tableClassName: 'my-table',
    // Build the header row once into the engine's <thead> (it stays frozen).
    header: (thead) => {
      thead.innerHTML = '<tr><th>ID</th><th>Name</th><th>Email</th></tr>';
    },
    // Measure column widths from the first window, then pin them: auto-sized
    // but stable (no scroll jitter). Omit for plain `table-layout: auto`.
    autoSizeColumns: true,
  },
});

// renderElement now receives a real <tr> — fill it with <td>s:
scroller.renderViewport(container.clientHeight, container, (index, tr) => {
  const row = data[index];
  tr.innerHTML = `<td>${row.id}</td><td>${row.name}</td><td>${row.email}</td>`;
});
```

**How it works**

- **One shared `<table>`.** The `<thead>` and the virtualized `<tbody>` live in the same table, so header and body columns align natively. The header is frozen automatically — only the `<tbody>` is transformed.
- **Still O(1).** Only the visible window (~25 rows) is in the DOM regardless of dataset size. The window is shifted with a single `transform: translateY()` on the `<tbody>` — the one place table mode uses a GPU transform.
- **Variable row heights** work exactly as in the default mode: each `<tr>` is measured, never estimated.

**Column widths**

- `table-layout: auto` (default) sizes columns to content, but widths can shift slightly as wide content scrolls into the window (only the visible rows are measurable).
- `autoSizeColumns: true` measures column widths once from the first window and pins them — auto-sized **and** stable, with no manual widths.
- Or pass explicit `columnWidths: ['120px', '', '200px']` (`''` lets that column take the remainder).

**`table` options**

| option | type | description |
| --- | --- | --- |
| `header` | `(thead) => void` | Populate the engine-created `<thead>` once (e.g. `thead.innerHTML = …`). It stays frozen. |
| `autoSizeColumns` | `boolean` | Measure column widths once from the first window, then pin them (auto-sized + stable). |
| `columnWidths` | `string[]` | Explicit fixed widths per column. `''`/`'auto'` distributes the remainder. |
| `tableClassName` / `theadClassName` / `tbodyClassName` | `string` | Class hooks on the generated table elements. |

**CSS notes**

- Use `border-collapse: separate` — collapsed borders are painted by the (untransformed) `<table>` and would not move with the scrolling rows.
- Give the `<thead>` an **opaque** background so rows translating up underneath don't show through it.

> **Framework users:** the React, Vue, and Angular wrappers expose *declarative* headers (`tableHeader` prop / `#header` slot / `[ceriousScrollHeaderTemplate]`) that render into the engine's `<thead>`. See each wrapper's README.

---

## License

Cerious Scroll™ is licensed under the **MIT License** by **Cerious DevTech LLC**.

See [LICENSE](LICENSE) for details.

info@ceriousdevtech.com

---

## Contributing

By submitting a pull request, you agree to the **Contributor License Agreement (CLA)**.

---

## Copyright

Copyright © 2024–2026  
**Cerious DevTech LLC**  
All rights reserved.
