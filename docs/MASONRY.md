# Masonry

**Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.**

## Usage

```js
const scroller = new CeriousScroll(host, 200000, {
  layout: 'masonry',
  masonry: {
    // Must be PURE. Called for cards that are not in the DOM.
    getItemHeight: (i, columnWidth) => Math.round(columnWidth / ratio(i)) + 44,
    renderItem: (i, el) => { el.innerHTML = card(i); },
    gap: 14,
    targetColumnWidth: 280
  },
  onScroll: () => scroller.renderViewport(host.clientHeight, host, () => {})
});
```

`totalElements` is the **card** count. `jumpToItem(index)` navigates in card
space; `itemCount` reports cards. Column count is responsive by default
(`targetColumnWidth`, `minColumns`, `maxColumns`) or fixed via `columns`.

`renderItem` populates a card once per mount, not per frame. The `renderElement`
argument to `renderViewport` is ignored in this mode.

## Determinism: two modes, two guarantees

Masonry ships as two variants with **different determinism guarantees**. They are
two products, not a feature and its degraded fallback, and the choice between
them is a property of your CONTENT rather than a preference.

| | **Oracle** — `canonical` | **Dynamic** — `local` |
|---|---|---|
| selected by | supplying `getItemHeight` | omitting it |
| a card's column is a function of | the dataset | the dataset **and the route taken** |
| card N reached two ways | same column, always | may differ |
| random access | O(n) — walks every card before it | **O(1)** — lands and starts level |
| persistent state | O(n / segmentSize) | O(n / segmentSize), smaller K |
| heights from | your function | the DOM |

Query it at runtime rather than inferring it:

```js
scroller.masonryDeterminism   // 'canonical' | 'local' | null (not masonry)
```

### Canonical (oracle)

Every card has one true position, derived from the whole dataset. Card N sits in
the same column no matter how the viewer arrived, so a position is shareable,
linkable and reproducible across sessions and users.

Paid for with preprocessing. The column frontier is walked from card 0, and
reaching a distant card evaluates a height for every card before it — pure
arithmetic, no DOM, but O(n). Measured: locating card 4,000,000 of 5,000,000
costs 4,000,500 height evaluations. In practice that walk happens once, early,
because the engine's own true-bottom probe reaches the last segment on the first
render.

Choose it when a card's position is part of the product: deep links, shared
coordinates, screenshot-stable layouts — or simply when height is known from
intrinsic dimensions.

### Locally deterministic (dynamic)

Heights come from the DOM, so no card can be priced without being built, and
pricing four million cards to reach the four-millionth is not an option. Random
access is constant-time instead: a landing far from anything already laid out
starts a fresh run with level columns.

The layout is deterministic **within a run** and always a valid masonry —
uniform gutters, balanced columns, nothing overlapping. What it does not promise
is that card N's column is independent of how you got there. Measured: jumping
straight to card 4,000,000 of 5,000,000 touches 95 cards and takes 7.3ms.

Choose it when height is only knowable by rendering, which is most text.

**Consequence worth designing around:** under `'local'`, a feature that treats a
position as shareable — a deep link to a card, a saved scroll coordinate, a
pixel-comparison test — is not sound. Branch on `masonryDeterminism` rather than
assuming.

## Two height modes

| | oracle | dynamic |
|---|---|---|
| `getItemHeight` | supplied | **omitted** |
| heights from | your function | the DOM |
| far jump to unvisited | exact | lands on level columns |
| layout reads in scroll path | none | one per newly measured card |
| scrollbar strip | sized in pixels | sized by card count |
| suits | media with known aspect ratio | text, lists, anything |

```js
// Dynamic: no getItemHeight at all.
new CeriousScroll(host, 50000, {
  layout: 'masonry',
  masonry: {
    renderItem: (i, el) => { el.innerHTML = card(i); },
    gap: 14,
    targetColumnWidth: 300,
    segmentSize: 100,        // smaller: a segment is the re-measure unit
    estimatedItemHeight: 260 // only for segments the camera has not reached
  }
});
```

### How dynamic mode measures

A card is measured **before** it is placed, never guessed. Heights are taken in
an offscreen probe exactly one column wide, so the value is the height the card
will have once positioned — and the visible tree is never disturbed, which
matters because measurement happens while the frontier is being computed, before
anything is drawn.

`estimatedItemHeight` never affects a drawn card. It is used only for the height
of segments the camera has not reached, in the same way an unmeasured row
reports a default today.

Measured heights are cached with a bounded, oldest-first eviction. Evicting is
safe: a stored frontier is a SUM, so it stays valid — only placing cards inside
a segment needs the individual values, and those are re-measured on return. A
width change clears the cache outright, because a text card reflows when its
column narrows.

### Two invariants dynamic mode depends on

**Frontiers are known for a contiguous RANGE, not "up to N".** A single
high-water mark was correct while sequential chaining was the only way to
advance it; anchoring breaks that, because it jumps the mark forward without
filling the gap behind. Dragging back then reads an unwritten slot and puts NaN
into every derived position — seen as the view snapping to somewhere unrelated.
The layout tracks `[frontierBase, frontierReach]` and re-anchors when a target
falls outside it.

**A height query must never mutate the layout.** Asking the layout for a segment
outside the range makes it anchor there, re-basing the range the camera is using.
The engine probes heights constantly — the boundary guardian and the true-bottom
walk both reach for the LAST segment — so one unguarded read re-anchors to the
end of the dataset every frame and re-measures everything. `segmentHeight()`
returns an estimate unless both ends of the span are already in range.

Measured: with that guard removed, a single `handleScrollPercentage(40)` on
200,000 cards measured all 200,066 of them.

### Segment size is the measurement quantum

A segment is laid out in full whenever it is touched, because its end frontier
depends on every card in it. So `segmentSize` sets how much measuring a landing
costs, and the dynamic default (24) is much smaller than the oracle one (500):
it puts the overhead at roughly one measurement per card drawn, the same rate
the row engine measures at. At 100 it was ~300 measurements to draw ~25 cards.

Neighbouring segments that cannot reach the window are skipped for the same
reason — laying one out costs a full segment of measurements for nothing.

### What a jump looks like

The scrollbar is indexed by **card, not by pixel** — the strip is sized from the
card count and the thumb is a fraction of the dataset. That is why a dataset
with nothing measured still maps the thumb correctly, and it is unchanged from
how the row engine has always worked.

So a jump is: percentage -> card index -> camera. No heights involved.

The one thing masonry needs beyond that is the column frontier at the landing
card. Ordinary scrolling walks forward a segment at a time and measures as it
goes, so the frontier is real. A drag into never-visited content is different:
chaining there honestly would mean measuring every card in between. Past
`maxChainSegments` the landing segment starts from level columns instead.

That flush is not the periodic seam this design exists to avoid. It happens once,
at a card the viewer teleported to, with nothing above it on screen — they never
scrolled across it. The residual: two viewers who reach the same card by
different routes can see it in different columns.

## Why segments

Masonry is path-dependent: which column a card lands in depends on the column
frontier left by every card before it. Storing that per card is O(n) memory,
which the scroller refuses.

The engine therefore scrolls over **segments** of `segmentSize` cards while the
DOM mounts individual **cards**. `MasonryLayout` stores the real column frontier
every K cards — `columns` floats per snapshot — and resumes the next run from it.
The layout is bit-identical to one greedy pass from card 0: no seam anywhere,
every gutter exactly `gap`.

- Memory: `columns * (n / segmentSize)` floats — ~12KB for 1M cards at the default K.
- The frontier table doubles as a prefix-sum table, so `getCumulativeHeight` is
  an O(1) lookup rather than a walk.
- Reaching a cold position is one sequential pass over everything above it;
  `chainAhead(target, budgetMs)` spreads that across frames.

Heights come from `getItemHeight`, never from the DOM — segment replay must
price cards that were never mounted (a scrollbar drag landing mid-dataset). In
exchange the scroll path performs no layout reads at all. If a height is only
knowable by measuring, masonry mode is the wrong tool.

### What a far jump actually costs

Jumping to card 4,000,000 **does** visit cards 0-3,999,999 — there is no way
around it, because a column frontier IS the running state of every card before
it. What it does not do is touch the DOM: the visit is arithmetic (pick the
shortest of N columns, add a height), so nothing is created, measured, or laid
out. Only the cards in view are mounted.

Measured on a 5M-card dataset, 4 columns, K=500:

| target card | first jump | later jumps nearby | snapshot table |
|---|---|---|---|
| 100,000 | 4.4 ms | 0.116 ms | 6 KB |
| 1,000,000 | 14.1 ms | 0.059 ms | 63 KB |
| 4,000,000 | 51.3 ms | 0.068 ms | 250 KB |

The cost is paid once. Afterwards the frontier table answers by lookup, so
nearby jumps are ~0.07ms regardless of depth. And `chainAhead` splits the walk
across frames — reaching card 4,000,000 takes 9 slices at a 6.1ms worst case,
so nothing blocks.

## Why not a seam

The obvious alternative is to flush the columns level every K cards, making each
segment self-contained. Seven strategies for doing that were built and measured;
all were rejected. A boundary is a discontinuity by construction, and closing it
costs one of three things — dead space, uniform gutters, or card size:

| strategy | dead space | uniform gutters | worst card distortion |
|---|---|---|---|
| hard flush | 306px | 100% | 0% |
| reflow tail columns | 89px | 100% | 0% |
| probe for a level boundary | 38px | 100% | 0% |
| resize trailing cards | 28px | 100% | 10.7% (2.3% of cards) |
| widen trailing gaps | 2px | **93%** | 0% |

*(photo aspect ratios, 3 columns, K=200)*

Worse, minimizing dead space makes the columns end level, which turns the seam
into a crisp horizontal rule across every column — the most visible artifact of
the three, and one no seam metric captures.

Two related dead ends, both measured:

- **Reconstructing the layout from a local probe.** Greedy masonry contracts in
  frontier SHAPE but not in column IDENTITY — the same heights end up on
  different physical columns. 65% column mismatch, flat across probe depths from
  100 to 2400 cards. Segments are mandatory.
- **Chained boundary search.** Adaptive-grade seams, but 19ms cold jumps and an
  O(n/K) boundary cache.

## Resize

A width change alters `columnWidth`, which every height depends on and therefore
every frontier. Nothing survives; `MasonryLayout.resize()` drops it all.

The camera cannot survive either — it is `(segment, offset)` in the old geometry.
The renderer re-anchors on **content**: it tracks the card nearest the viewport
top on every render and puts that same card back at the same screen position
afterwards. It is the one card guaranteed not to move.

The rebuild is sliced. Chaining to the camera is irreducibly sequential, so it
is spread across frames at `rebuildSliceMs` (default 6ms) rather than blocking:

| cards | segments | one blocking rebuild | worst 6ms slice | slices |
|---|---|---|---|---|
| 200K | 100 | 4.3 ms | 4.5 ms | 1 |
| 1M | 500 | 11.9 ms | 6.1 ms | 2 |
| 5M | 2,500 | 58.1 ms | 6.0 ms | 10 |
| 20M | 10,000 | **229.0 ms** | **6.1 ms** | 38 |

Total work is unchanged; it stops landing in one frame. Progress is durable —
each completed segment is written to the table — so an abandoned rebuild costs
nothing. The old cards stay mounted throughout and are swapped atomically, so the
page holds a stale-but-coherent view rather than blanking.

`totalHeight()` extrapolates from the chained prefix until a background pass
reaches the end, because sizing the scrollbar would otherwise force the full walk.

## Engine hooks this mode uses

Masonry composes on the engine rather than forking the renderer. `ViewportRenderer`'s
loop gains no branches, and `NavigationEngine`, `BoundaryGuardian`,
`NativeScrollbar` and the four input controllers are unchanged and unaware.

| hook | purpose |
|---|---|
| `heightProvider` | authoritative heights — bypasses the measured cache and its pruning |
| content-sized scrollbar strip | element-count sizing quantizes when an element is not row-sized |
| `jumpToPosition(el, offset)` | re-anchoring needs a sub-element offset |
| `syncViewportHeight(h)` | consumers that drive their own DOM never call `renderViewport` |
| `refreshScrollbarMetrics()` | total height can change while element count does not |
| `wheel.notchThresholdPx` | large cards make instant wheel notches read as teleports |

All are public and independently useful; masonry sets them up automatically.

## Gutters and container width

The renderer honours CSS padding on its own content box, so an outer gutter that
matches the inner ones is just CSS:

```css
#scroll [data-cerious-masonry="content"] { padding: 14px 14px 0; }
```

Three details make that come out even rather than approximately even:

- **Width is measured to the scrollbar strip**, not to the content box. The host
  reserves padding for the strip, and that reservation need not equal the
  strip's rendered width (17px of padding for a 15px strip is typical), so the
  content box stops short of it. Measuring the real distance keeps the last
  gutter equal to the rest.
- **Column width is fractional.** Flooring leaves a remainder that has to land
  somewhere, and wherever it lands one outer gutter is wider than the others.
- **Geometry is re-measured once after the scrollbar attaches.** The renderer is
  constructed before the strip exists, so its first measurement is necessarily
  too wide. A resize observation cannot be relied on to correct it — on a reused
  host the padding is already present, the content box never changes size, and
  nothing fires.

## Tuning

- **`segmentSize`** (default 500) trades snapshot memory against the cost of
  reaching a cold position. Larger means fewer snapshots and a longer chain.
- **`overscan`** (default 400px) is the margin rendered beyond the viewport.
- **`rebuildSliceMs`** (default 6) is the per-frame budget during a relayout.
  Lower keeps frames free at the cost of a longer rebuild.
