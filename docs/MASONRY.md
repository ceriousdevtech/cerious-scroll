# Masonry layout

Masonry mode virtualizes a card collection while placing each card in the
currently shortest column. It supports responsive column counts, variable card
heights, bounded DOM usage, native scrollbar navigation, and content-anchored
resizing.

## Contents

- [Quick start](#quick-start)
- [Choose a height mode](#choose-a-height-mode)
- [Rendering contract](#rendering-contract)
- [Sizing and gutters](#sizing-and-gutters)
- [Navigation and public state](#navigation-and-public-state)
- [Options](#options)
- [Resize behavior](#resize-behavior)
- [Performance model](#performance-model)
- [Troubleshooting](#troubleshooting)
- [How segmentation works](#how-segmentation-works)

## Quick start

Set `layout: 'masonry'` and provide a `masonry.renderItem` callback. In this
mode, the constructor's second argument is the number of cards.

```js
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const host = document.querySelector('#gallery');
const cards = getCards();
let scroller;

function render() {
  // Masonry uses renderItem below. This callback is intentionally empty.
  scroller.renderViewport(host.clientHeight, host, () => {});
}

scroller = new CeriousScroll(host, cards.length, {
  layout: 'masonry',
  masonry: {
    renderItem: (index, element) => {
      const card = cards[index];
      element.className = 'card';
      element.innerHTML = `<img src="${card.src}" alt="${card.alt}">`;
    },
    // Canonical mode: calculate the complete card height without using the DOM.
    getItemHeight: (index, columnWidth) => {
      const card = cards[index];
      return columnWidth * (card.imageHeight / card.imageWidth) + 44;
    },
    gap: 16,
    targetColumnWidth: 280
  },
  onScroll: render
});

render();
```

The host must have a nonzero height and be in the DOM before construction:

```css
#gallery {
  height: 70vh;
  overflow: hidden;
}
```

Try the [canonical demo](https://ceriousdevtech.github.io/cerious-scroll/masonry-demo.html)
and [dynamic-height demo](https://ceriousdevtech.github.io/cerious-scroll/masonry-dynamic-demo.html),
or browse the [live demo index](https://ceriousdevtech.github.io/cerious-scroll/).

## Choose a height mode

The presence of `getItemHeight` selects the mode. This choice changes both how
heights are obtained and what a card position means.

| | Canonical (oracle) | Local (dynamic) |
| --- | --- | --- |
| Select by | Supply `getItemHeight` | Omit `getItemHeight` |
| Height source | Your pure function | DOM measurement |
| Card column depends on | Dataset and container geometry | Dataset, geometry, and navigation route |
| Same card reached by two routes | Same column | May use a different column |
| Far random access | O(n) arithmetic walk | O(1) landing with local layout |
| Default `segmentSize` | 500 | 24 |
| Best for | Images/media with intrinsic sizes, reproducible positions | Text and content whose height requires layout |

Read the active guarantee rather than inferring it:

```js
scroller.masonryDeterminism; // 'canonical' | 'local' | null
```

### Canonical heights

`getItemHeight(index, columnWidth)` must be pure and must return the complete
card height in pixels. It can be called for cards that have never been mounted,
so it must not read or measure the DOM.

```js
function getItemHeight(index, columnWidth) {
  const item = cards[index];
  const mediaHeight = columnWidth * item.mediaHeight / item.mediaWidth;
  return mediaHeight + 48; // caption, padding, and borders
}
```

Canonical mode walks the height function from card 0 to build the column
frontier. That preprocessing is O(n), but it is arithmetic only: offscreen cards
are not mounted or measured. Once calculated, a card has one reproducible
column for a given dataset and container geometry.

Choose canonical mode when you need deep links, saved positions, shared
coordinates, or stable visual snapshots.

### Dynamic heights

Omit `getItemHeight` when the browser must lay out the card to know its height:

```js
const scroller = new CeriousScroll(host, cards.length, {
  layout: 'masonry',
  masonry: {
    renderItem: renderCard,
    estimatedItemHeight: 260,
    targetColumnWidth: 300,
    gap: 16
  },
  onScroll: render
});
```

Before placing a new card, dynamic mode renders it into an invisible offscreen
probe that is exactly one column wide and reads its height. The estimate is used
only for unvisited segment scroll metrics; a visible card is measured before it
is positioned.

A far jump cannot measure every preceding card without becoming O(n). Instead,
dynamic mode starts a local run with level columns when the target is farther
than `maxChainSegments` from known layout. The result remains a valid balanced
Masonry layout, but the target card's column can depend on the route used to
reach it. Do not treat local-mode pixel positions or columns as shareable IDs.

## Rendering contract

Masonry owns the card elements and populates them with `masonry.renderItem`.
Continue to call `renderViewport()` on initial render and from `onScroll`, but
pass an empty third callback because the normal row callback is ignored.

```js
function render() {
  scroller.renderViewport(host.clientHeight, host, () => {});
}
```

`renderItem(index, element)` should be deterministic and idempotent:

- Replace or reset stale content and classes because elements may be recycled.
- Do not attach global listeners or perform network requests from the callback.
- In dynamic mode, expect calls for both offscreen measurement and visible
  mounts. Do not use element identity or callback count as application state.
- Make asynchronous media dimensions predictable. Reserve space with an aspect
  ratio, or rebuild the scroller when content changes the card's measured size.
- In canonical mode, ensure the visual card fits the height returned by
  `getItemHeight`.

Only the visible cards plus `overscan` are mounted. `renderItem` is not called
once per animation frame for cards that remain mounted.

## Sizing and gutters

Omit `columns` for responsive columns. The renderer derives the count from
`targetColumnWidth`, constrained by `minColumns` and `maxColumns`. Supplying
`columns` fixes the count and takes precedence over the responsive settings.

The renderer accounts for padding on its generated content box. To make the
outer gutter match a `16px` inner `gap`, add:

```css
#gallery [data-cerious-masonry="content"] {
  padding: 16px 16px 0;
}
```

Card width and position are managed by Cerious Scroll. Style the card's
appearance and contents, but do not override its positioning styles.

## Navigation and public state

Use card-oriented APIs in Masonry mode:

```js
scroller.jumpToItem(12_500);      // place card at the viewport top
scroller.jumpToItem(12_500, 80);  // place it 80px below the top
render();                         // programmatic navigation does not call onScroll

console.log(scroller.itemCount);
console.log(scroller.masonryDeterminism);
```

`jumpToItem` is available only in Masonry mode. Do not use `jumpToElement` for
cards: the engine's internal elements are card segments in this layout.
`handleScrollPercentage(percent)` remains available, but call `render()` after
it as shown above.

The `MeasuredViewportRange` returned by `renderViewport()` describes internal
segments, not a card-index range. Track card-level state in `renderItem` or in
your own data model.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderItem` | `(index, element) => void` | required | Populate a card element. |
| `getItemHeight` | `(index, columnWidth) => number` | omitted | Pure full-height function; supplying it selects canonical mode. |
| `estimatedItemHeight` | `number` | `300` | Dynamic mode estimate for unvisited segment scroll metrics. |
| `gap` | `number` | `16` | Horizontal and vertical gutter in pixels. |
| `columns` | `number` | responsive | Fixed column count; overrides responsive settings. |
| `targetColumnWidth` | `number` | `280` | Preferred width used to derive a responsive column count. |
| `minColumns` | `number` | `1` | Minimum responsive column count. |
| `maxColumns` | `number` | `8` | Maximum responsive column count. |
| `segmentSize` | `number` | `500` canonical, `24` dynamic | Cards per frontier segment. |
| `maxChainSegments` | `number` | `4` | Dynamic mode distance that may be measured before starting a local run. |
| `overscan` | `number` | `400` | Extra rendered pixels above and below the viewport. |
| `rebuildSliceMs` | `number` | `6` | Per-frame work budget for rebuilding after a relayout. |

Start with the defaults. Change `segmentSize`, `maxChainSegments`, or
`rebuildSliceMs` only after profiling representative data and navigation.

## Resize behavior

A width change can alter the column count, column width, and every card height.
Masonry therefore rebuilds its layout. It tracks the card nearest the viewport
top and restores that card at the same screen offset after the rebuild.

Rebuild work is split across animation frames using `rebuildSliceMs`. Existing
cards stay mounted until the replacement layout is ready, avoiding a blank
viewport during a large canonical rebuild. In dynamic mode, width changes also
clear measured heights because text and other flow content can rewrap.

## Performance model

- DOM use is bounded by the viewport, `overscan`, and recycled card pool.
- Canonical mode stores a column-frontier snapshot per segment and evaluates
  heights sequentially to reach cold positions.
- Dynamic mode stores bounded measured heights and can establish a new local
  frontier for constant-time far jumps.
- Larger canonical segments reduce snapshot memory but increase replay work.
- Larger dynamic segments increase the number of cards that may need offscreen
  measurement for a landing; the default is intentionally small.
- Increasing `overscan` can hide fast-scroll mounting but creates more DOM work.

For large media cards, a wheel notch can move most of a viewport. If that feels
abrupt, opt into smoothing for all wheel deltas:

```js
wheel: {
  smooth: true,
  notchThresholdPx: Infinity
}
```

## Troubleshooting

### The gallery is blank

- Confirm the host has a nonzero computed height and is attached to the DOM.
- Call `renderViewport()` once after constructing the scroller.
- Ensure `masonry.renderItem` is present and does not throw.

### Cards overlap or clip

- In canonical mode, include every border, padding, caption, and fixed-height
  region in `getItemHeight`.
- Do not override the card element's engine-managed width, height, or transform.
- Reserve space for images or other content that loads asynchronously.

### A card changes columns after a far jump

This is expected in dynamic mode (`masonryDeterminism === 'local'`). Supply a
pure `getItemHeight` to select canonical mode when a card must have a globally
reproducible column.

### Dynamic rendering performs duplicate work

Dynamic mode invokes `renderItem` in an offscreen probe to measure uncached
cards, then uses it for visible mounts. Keep the callback cheap and free of
side effects; cache expensive application-level formatting outside the DOM
callback when needed.

### The scrollbar or viewport does not update after a jump

`jumpToItem()` and `handleScrollPercentage()` update navigation state but do
not invoke `onScroll`. Call the same render function you use for `onScroll`.

## How segmentation works

Greedy Masonry is path-dependent: placing the next card requires the current
height of every column. Keeping that state for every card would make memory
grow linearly with the dataset.

Cerious Scroll instead lets the engine navigate over segments while the
Masonry renderer mounts individual cards. It stores column-frontier snapshots
at segment boundaries. In canonical mode those snapshots reproduce the same
layout as one greedy pass from card 0 without mounting offscreen cards. In
dynamic mode snapshots cover locally measured runs, allowing far navigation
without rendering all preceding content.

The segment abstraction is internal. Application code should continue to use
card counts, `renderItem`, `jumpToItem`, and `itemCount`.

---

Copyright © 2024–2026 Cerious DevTech LLC. All rights reserved.
