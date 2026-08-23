# Cerious Scroll™

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/%40ceriousdevtech%2Fcerious-scroll.svg)](https://www.npmjs.com/package/@ceriousdevtech/cerious-scroll)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://ceriousdevtech.github.io/cerious-scroll/)

High-performance virtual scrolling for variable-height lists, native tables,
and Masonry grids. Cerious Scroll keeps only the visible window and its
overscan in the DOM, so DOM usage stays bounded as the dataset grows.

Typical uses include data grids, chat, log viewers, media galleries, trading
tickers, analytics tables, and other interfaces that cannot mount every item at
once.

## Features

- Bounded DOM and measurement-cache usage, including datasets with millions of items.
- Variable-height rows measured on demand; no full-dataset prefix sum required.
- Three layout modes: absolute rows, native tables, and responsive Masonry grids.
- Native scrollbar, wheel, touch, and keyboard navigation.
- Responsive resize handling and stable content anchoring.
- Framework-agnostic TypeScript API, with React, Vue, and Angular wrappers.

## Installation

```bash
npm install @ceriousdevtech/cerious-scroll
```

The package includes ES modules and TypeScript declarations. A browser bundle
is also available from a CDN:

```html
<script src="https://unpkg.com/@ceriousdevtech/cerious-scroll@latest/dist/cerious-scroll.min.js"></script>
```

## Quick start

Create a fixed-height host, construct the scroller with the item count, and
render once initially and again from `onScroll`. The engine measures each row
after the render callback; the callback does not return a height.

```html
<div id="scroll-container" style="height: 600px; overflow: hidden"></div>
```

```js
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const data = Array.from({ length: 10_000 }, (_, index) => ({
  id: index,
  label: `Item ${index}`
}));
const container = document.querySelector('#scroll-container');

let scroller;

function render() {
  scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      element.textContent = data[index].label;
    }
  );
}

scroller = new CeriousScroll(container, data.length, { onScroll: render });
render();
```

Use `jumpToElement(index)` or `handleScrollPercentage(percent)` for programmatic
navigation, `updateTotalElements(count)` after changing a list's size, and
`dispose()` when the scroller is no longer needed. Programmatic navigation does
not call `onScroll`, so call your render function afterwards.

## Layouts

| Layout | Configuration | Best for |
| --- | --- | --- |
| Absolute (default) | omit `layout` or use `layout: 'absolute'` | Lists and variable-height rows |
| Table | `layout: 'table'` | Native `<table>` semantics and aligned columns |
| Masonry | `layout: 'masonry'` | Virtualized cards flowing into the shortest column |

### Masonry layout

In Masonry mode, the constructor count and `jumpToItem(index)` both refer to
cards. Card DOM is owned by `masonry.renderItem`; the callback passed to
`renderViewport` is required by the shared API but ignored.

```js
const cards = getCards();
let scroller;

function render() {
  scroller.renderViewport(host.clientHeight, host, () => {});
}

scroller = new CeriousScroll(host, cards.length, {
  layout: 'masonry',
  masonry: {
    renderItem: (index, element) => {
      element.className = 'card';
      element.textContent = cards[index].title;
    },
    getItemHeight: (index, columnWidth) => {
      const card = cards[index];
      return columnWidth * (card.imageHeight / card.imageWidth) + 48;
    },
    gap: 16,
    targetColumnWidth: 280
  },
  onScroll: render
});

render();
```

Masonry has two height and positioning guarantees:

| Mode | Select it by | Height source | Position guarantee | Far random access |
| --- | --- | --- | --- | --- |
| Canonical | Supply `getItemHeight` | Pure height function | A card always occupies the same column | O(n) arithmetic preprocessing |
| Local | Omit `getItemHeight` | DOM measurement | Column may depend on the route taken | O(1) landing |

Use canonical mode for media with known dimensions, deep links, shared
positions, or screenshot-stable layouts. Use local mode when card height is
only knowable after rendering, such as rich text. At runtime,
`masonryDeterminism` is `'canonical'`, `'local'`, or `null` outside Masonry.

For dynamic heights, omit `getItemHeight` and optionally provide an estimate:

```js
masonry: {
  renderItem: renderCard,
  estimatedItemHeight: 260,
  targetColumnWidth: 300,
  gap: 16
}
```

Add matching outer gutters with padding on the generated content element:

```css
#scroll-container [data-cerious-masonry="content"] {
  padding: 16px 16px 0;
}
```

Cards are recycled, and the engine sizes a card before the browser lays it out.
That places three requirements on real content — reserve space for images from
intrinsic dimensions, keep `renderItem` idempotent, and delegate events rather
than binding per card. The [real-content demo](https://ceriousdevtech.github.io/cerious-scroll/masonry-gallery-demo.html)
shows all three with network images, Tailwind-styled cards, and per-card
carousels over 50,000 items.

See the [Masonry guide](docs/MASONRY.md) for both modes, the full option
reference, rendering rules, navigation, resize behavior, and performance
tradeoffs. Also try the [canonical demo](https://ceriousdevtech.github.io/cerious-scroll/masonry-demo.html)
and [dynamic-height demo](https://ceriousdevtech.github.io/cerious-scroll/masonry-dynamic-demo.html).

### Table layout

Table mode renders real `<tr>` and `<td>` elements in one shared table, keeping
the header and body columns aligned while virtualizing the body rows.

```js
const scroller = new CeriousScroll(container, rows.length, {
  layout: 'table',
  table: {
    tableClassName: 'my-table',
    header: (thead) => {
      thead.innerHTML = '<tr><th>ID</th><th>Name</th><th>Email</th></tr>';
    },
    autoSizeColumns: true
  },
  onScroll: render
});

function render() {
  scroller.renderViewport(container.clientHeight, container, (index, tr) => {
    const row = rows[index];
    tr.innerHTML = `<td>${row.id}</td><td>${row.name}</td><td>${row.email}</td>`;
  });
}

render();
```

Use `border-collapse: separate` and give the generated `<thead>` an opaque
background. `autoSizeColumns: true` measures the first window and pins its
widths; `columnWidths` can provide explicit widths instead.

## Documentation

- [Implementation guide](docs/IMPLEMENTATION_GUIDE.md) — setup, options,
  rendering, navigation, events, integrations, and troubleshooting.
- [Masonry guide](docs/MASONRY.md) — canonical and dynamic Masonry behavior,
  options, styling, navigation, and tuning.
- [Architecture](docs/ARCHITECTURE.md) — positioning model, controllers,
  observers, caches, and layout internals.
- [Live demos](https://ceriousdevtech.github.io/cerious-scroll/) — examples for
  lists, grids, chat, logs, tables, Masonry, and more.

Framework wrappers have their own usage guides:

- [React wrapper](https://github.com/ceriousdevtech/react-cerious-scroll)
- [Vue wrapper](https://github.com/ceriousdevtech/vue-cerious-scroll)
- [Angular wrapper](https://github.com/ceriousdevtech/ngx-cerious-scroll)

## Local development

```bash
npm install
npm run build
npm test
npx http-server . -p 8080
```

Then open `http://localhost:8080/`.

## Contributing

Contributions are welcome. By submitting a pull request, you agree to the
[Contributor License Agreement](CONTRIBUTING.md).

## License

Cerious Scroll™ is licensed under the [MIT License](LICENSE) by Cerious DevTech
LLC. Questions can be sent to info@ceriousdevtech.com.

Copyright © 2024–2026 Cerious DevTech LLC. All rights reserved.
