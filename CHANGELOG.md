# Changelog

All notable changes to CeriousScroll will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.3] - 2026-08-25

### Added

- Native-proxy touch scrolling. A hidden native overflow ancestor supplies
  platform touch momentum while forwarding pixel deltas through the existing
  virtual navigation engine. Interactive content remains the browser's real
  hit-test target.

### Changed

- Native-proxy touch is now the default for hosts with a dedicated content
  element. Legacy hosts without one automatically retain the manual controller;
  use `touch.mode: 'manual'` to opt out explicitly.

### Fixed

- Native-proxy touch now clamps Safari's elastic `scrollTop` values to the
  physical range, preventing bottom/top rubber-band rebound from being applied
  to the virtual camera as reverse scrolling.
- Scrollbar-driven jumps now realign the native-touch proxy as part of the
  scrollbar render path, preventing a stale physical top/bottom boundary from
  appearing in the middle of the dataset.
- Native-proxy scroll events now require ownership by an observed touch pan or
  its momentum. Safari focus/scroll-anchoring adjustments after tapping mutable
  content are rebased instead of moving the virtual camera and creating a false
  boundary at the tapped card.
- Native-proxy boundary synchronization now uses exact dataset boundaries, so
  tiny nonzero percentages in very large datasets do not snap the physical
  proxy to its top and rubber-band in the middle of the content.
- Appending or removing rows with `updateTotalElements()` now re-anchors the
  native scrollbar and touch proxy to the unchanged logical camera, preventing
  a resized native surface from moving the viewport.

## [1.1.2] - 2026-08-23

### Fixed

- **The package could not be imported in Node.** `dist/types/index.js` re-exported
  its siblings without file extensions, and Node's ESM resolver does not add
  them, so `import ... from '@ceriousdevtech/cerious-scroll'` failed with
  `ERR_MODULE_NOT_FOUND` on `dist/types/callback-types`. This also took down the
  React, Vue, and Angular wrappers, which import this package regardless of how
  they bundle themselves. Bundlers such as Vite and webpack resolve extensionless
  specifiers, which is why the demos and test suite never saw it.

### Added

- A packaging test asserting every relative specifier in `src` carries a `.js`
  extension, so the same defect cannot reach a release again.

## [1.1.1] - 2026-08-23

### Added

- **`masonryColumnWidth` and `masonryColumns`** on `CeriousScroll`, reporting the
  live column geometry, or `null` outside Masonry. Card content routinely needs
  the column width — to request a CDN image at the size actually displayed, to
  pick a `srcset` candidate, or to decide how much text to render — and it
  changes with the container.

### Fixed

- The bundled Masonry demos reported `currentElement` as a card index. In Masonry
  mode that value is a SEGMENT index, so the figure shown was wrong by the
  segment size. They now report the topmost card actually on screen.

### Documentation

- New guide section on real content: reserving space for images, using component
  libraries and utility CSS inside recycled cards, and handling interaction
  through delegated events with per-card state kept outside the element.
- Guidance on making images arrive sooner, including why `loading="lazy"` should
  not be combined with virtualization, and how prefetch windows must be bounded
  and deprioritised to avoid starving the images actually on screen.
- Corrected the resize section: dynamic mode anchors at the camera's segment
  rather than slicing a rebuild across frames.
- Added `masonry-gallery-demo.html`, a real-content gallery with network images,
  utility-CSS component cards, and per-card carousels.

## [1.1.0] - 2026-08-22

### Added

- **Virtualized Masonry layout** with `layout: 'masonry'`. Cards flow into the
  shortest responsive column while only the visible window and overscan are
  mounted. Fixed column counts and responsive sizing through
  `targetColumnWidth`, `minColumns`, and `maxColumns` are supported.
- **Two Masonry height modes with explicit determinism guarantees.** Supplying
  a pure `getItemHeight(index, columnWidth)` selects canonical mode, where a
  card has one reproducible column. Omitting it selects dynamic mode, where card
  heights are measured from the DOM and far random access establishes a local
  layout without measuring the entire preceding dataset.
- **Card-oriented Masonry APIs:** `jumpToItem(index, screenOffset)`, `itemCount`,
  and `masonryDeterminism`. The new `MasonryOptions` and
  `MasonryDeterminism` types are included in the public TypeScript declarations.
- **Authoritative height providers** through the public `heightProvider` option.
  Computed layouts can provide element heights, cumulative heights, inverse
  pixel lookup, and total content height without entering the DOM measurement
  cache.
- **External-layout integration hooks:** `jumpToPosition`,
  `syncViewportHeight`, and `refreshScrollbarMetrics` allow computed renderers
  to share the existing navigation and scrollbar engine.
- **Responsive content anchoring for Masonry.** Width changes rebuild column
  geometry in animation-frame slices while holding the card nearest the
  viewport top at the same screen offset.
- **Canonical and dynamic Masonry demos**, a dedicated Masonry guide, expanded
  architecture documentation, and regression coverage for placement,
  determinism, far jumps, resizing, height providers, and scrollbar behavior.

### Changed

- Vertical touch movement is coalesced to one render per animation frame while
  preserving the full finger delta. The pending movement is flushed before
  momentum starts so a flick begins from the final touch position.
- True-bottom measurements now retain a small bounded tail cache instead of
  repeatedly mounting sentinel rows. Already-measured tail rows no longer stay
  in the live DOM window.
- Uniform-height position lookups use direct arithmetic, avoiding a row-by-row
  walk from the current viewport.
- Inner content-element and table-header measurements are cached and invalidated
  only when their geometry can change, reducing layout reads during scrolling.
- The README is organized around installation, quick start, layout selection,
  framework resources, and local development; Masonry behavior and tuning now
  live in a focused user guide.

### Fixed

- Prevented pre-render navigation on very large datasets from walking to the
  final row on every scroll before its height was measured.
- Prevented repeated true-bottom correction walks after an authoritative bottom
  position was already known.
- Hardened dynamic Masonry jumps and reverse navigation so locally anchored
  frontier ranges do not read unwritten state or remeasure the whole dataset.
- Preserved the visible Masonry card and its screen offset across responsive
  relayouts, including sliced rebuilds for multi-million-card datasets.

## [1.0.8] - 2026-06-24

### Changed
- **Native-scrollbar drags now render once per animation frame.** A fast drag on the native scrollbar can fire several `scroll` events within a single frame; each one previously ran the full map-to-position-and-render synchronously, doing 2–3× the work per frame and dropping frames. The cheap, must-stay-synchronous bookkeeping (echo rejection, the user-scroll timestamp, thumb visuals) still runs on every event, but the expensive map + viewport render is now coalesced to one run on the next frame at the latest `scrollTop` — matching the wheel path's rAF cadence. The full viewport is still rendered every frame (no extra blank rows), at the cost of at most ~1 frame of added latency. A pending frame is cancelled on detach, and an rAF fallback keeps the coalescing working in non-DOM/SSR environments.

### Fixed
- **Eliminated per-row layout thrash during fast scrollbar drags.** `ViewportRenderer.measureNew` no longer forces a synchronous `offsetHeight` read for a row whose height is already cached (or covered by the uniform-height hint). Content is index-addressed and any remap clears the cache (`clearAllCaches`/`recalculate`), so the cached value is the correct height — reusing it skips the read-after-write layout that dominated fast-drag frames. New rows with no cached height are still measured exactly as before.

## [1.0.7] - 2026-06-11

### Fixed
- **Dragging the scrollbar thumb could stop a few rows short of where it pointed** — most visibly, dragging to the very top would "eventually" land on row ~70 instead of row 0. The native scrollbar ignores the asynchronous *echo* of its own programmatic `scrollTop` writes by matching against a saved marker (introduced in 1.0.x to fix the "wheel-then-drag dead zone"). That marker was only ever refreshed by programmatic syncs and **never by a scrollbar drag** (drags go through `jumpToPosition(skipScrollbarSync)`), so once you dragged away from a synced position it went stale — and a later drag back to that exact `scrollTop` (`scrollTop: 0` at the top being the obvious case) was wrongly dropped as the engine's own echo, leaving the position a few rows off. The marker is now invalidated the moment a genuine user move is processed; the real echo of a programmatic write still arrives first and is still suppressed, so `scrollTop: 0` now always resolves to row 0. No change to the wheel/touch/keyboard paths.

## [1.0.6] - 2026-06-08

### Added
- **Native table layout** (`layout: 'table'`). Rows render as real `<tr>`/`<td>` inside one shared `<table>` — native column alignment and real table semantics — while keeping O(1) virtualization (~25 DOM rows for millions). Row positioning is now behind a pluggable `RowPlacement` strategy: `AbsolutePlacement` (the original out-of-flow `<div>` model) remains the default and is unchanged; `TableFlowPlacement` shifts the visible window with a single `transform: translateY()` on the `<tbody>`. A `<thead>` built via the `table.header(thead)` hook is frozen automatically (only the `<tbody>` transforms), and the true-bottom tail rows are measured in a separate offscreen table (since flow rows can't be flung down by `top`). Still max-height-safe — no full-height spacer — verified at 1,000,000 rows.
- **`table.autoSizeColumns`** option. Measures each column's content width once from the first rendered window (plus the header), then pins it via a generated `<colgroup>` + `table-layout: fixed`: columns are auto-sized to content but **stable** (no scroll jitter), with no manual widths.
- **`table.columnWidths`** (explicit fixed widths) and `table.tableClassName` / `theadClassName` / `tbodyClassName` styling hooks.

### Changed
- **Wheel inertia is now trackpad-only.** Each wheel event is classified by the shape of its delta: line-mode or large pixel deltas are discrete mouse-wheel notches (applied instantly), small pixel deltas are trackpad input (eased). Magnitude is checked first, so free-spin / "hyperscroll" mice that emit large *fractional* pixel deltas are correctly treated as a wheel and stop the moment the wheel stops. `wheel: { smooth: false }` still forces instant input everywhere.
- The engine's viewport height now re-syncs to the actual rendered area on **every** render (not only when the placement inset changes), so a header whose content mounts asynchronously (the framework wrappers) no longer leaves the last row one short.

### Fixed
- **Overlay scrollbars** (e.g. macOS trackpad, where the OS scrollbar reserves no layout width) no longer reserve a gutter — eliminating a dead, empty strip on the right edge. Classic fixed-width scrollbars still reserve their gutter as before.
- **Bottom clamp** snaps to the exact measured true-bottom, so the last row lands flush against the viewport bottom for wheel, touch, scrollbar drag, and `handleScrollPercentage(100)` — previously it could stop one row short or leave a small gap on fractional-scale (Retina) displays.

## [1.0.5] - 2026-06-04

### Added
- **Wheel input classifier** in `WheelController`. Each event is classified as `trackpad` or `wheel` from a 120ms rolling window: horizontal motion -> trackpad, non-pixel `deltaMode` -> wheel, ≥5 events in window -> trackpad (catches free-scroll mice like the Logitech G502X Lightspeed), isolated event in window -> wheel (catches small ratcheted notches with `deltaY` ~ 30–50), `|deltaY| ≥ 80` -> wheel, otherwise trackpad. Trackpad / free-scroll input now bypasses the smooth-scroll RAF and is applied synchronously, so OS- or hardware-level momentum is no longer layered on top of our easing (which had read as delayed overscroll and sluggish trackpad feel).
- **`wheel.wheelBehavior`** option: `'auto' | 'immediate' | 'smooth'` (default `'auto'`). `'immediate'` disables smoothing for every event; `'smooth'` smooths every event regardless of device. The legacy `wheel.smooth: false` continues to work as an alias for `'immediate'`.

### Fixed
- **Horizontal wheel forwarding** now walks ancestor elements from `[data-cerious-scroll-content]` up to the container looking for the first element whose computed `overflow-x` is `auto`/`scroll` AND that actually overflows horizontally, instead of assuming the marked content node is itself the horizontal scroller. Layouts that put `overflow-x: auto` on an ancestor of `[data-cerious-scroll-content]` (e.g. a sticky-header grid wrapper) now respond to trackpad two-finger and shift+wheel horizontally.
- Trackpad gestures arriving mid-flight in a smooth wheel animation now cancel the in-flight RAF and reset the queue, preventing leftover momentum from being applied on top of the trackpad delta.

## [1.0.4] - 2026-06-03

### Added
- **Smooth wheel scrolling** in `WheelController`. Wheel events are accumulated into a target offset and eased over ~150ms via rAF using a quad/linear blend (gentle for single notches, near-linear for sustained fast spins so motion stays constant-velocity instead of re-front-loading on every event). Per-frame step uses `Math.round` to avoid sub-pixel jitter on the easing tail; the loop short-circuits at the top boundary and resets cleanly when the engine refuses to advance. Disable via `wheel: { smooth: false }`.
- **`measureViewportHeight()`** helper on `CeriousScroll`. The engine now reads viewport height from an inner `[data-cerious-scroll-content]` element when present, so a wrapper that hosts a horizontal scrollbar on the inner element transparently shrinks the engine's row budget by the gutter and the last row clears the bar without consumer math.

### Changed
- `WheelController` and `TouchController` prefer the inner `[data-cerious-scroll-content]` as the horizontal scroll target when its `scrollWidth > clientWidth`, so trackpad two-finger and shift+wheel forward to the same axis that hosts the visual h-scrollbar.

## [1.0.3] - 2026-06-03

### Added
- **Horizontal momentum** in `TouchController`. When `touch.getHorizontalScrollTarget` is provided, horizontal flicks now decay with the same iOS-style cubic-bezier easing already used for vertical scrolling, including boundary-hit early-exit so momentum stops cleanly at the left/right edges instead of burning frames.
- **Custom scrollbar thumb** in `NativeScrollbar`. The sibling-driver strip now renders a styled thumb that floats over the host container's right edge. Touch hit zone covers the full strip so a tap anywhere in the column starts a drag. Appearance is themable via CSS variables on the scroll host: `--cerious-thumb-color`, `--cerious-thumb-color-active`, `--cerious-thumb-width`, `--cerious-thumb-width-active`. One stylesheet is injected lazily on first use; SSR/non-DOM environments are unaffected.

### Changed
- Renamed the internal `velocityY` velocity accumulator to `velocity` and made it axis-aware so the same momentum pipeline can drive vertical engine scroll or horizontal `scrollLeft` writes.

## [1.0.2] - 2026-06-01

### Changed

#### Hardening & Input Validation
- `totalElements` now validated with `Number.isFinite` and floored via `Math.floor()` — fractional or non-finite values are rejected with a clear error message
- `container` validated as an HTMLElement (must have `appendChild`) on `renderViewport()` calls
- `renderElement` validated as a function on `renderViewport()` calls
- Constructor options are now deep-cloned and frozen (`Object.freeze`) on construction — mutating the caller's config object after construction no longer affects library behavior

#### Performance Cache
- New `setTotalElements()` method bounds all linear walks (e.g. `findRowFromScrollPosition`) by dataset size, preventing runaway loops on malformed scroll positions
- Defensive validation rejects NaN, Infinity, and negative heights — uses a 1px placeholder rather than poisoning the cache
- Cumulative height cache is invalidated correctly when an in-window measurement is updated

#### Navigation Engine
- `scrollByDelta` now guards against non-finite `deltaY` or zero/negative `viewportHeight`
- `scrollToElement` clamps index to valid range `[0, totalElements-1]` and emits a console warning when clamping occurs
- `jumpToPercentage` and `jumpToElement` guard against non-finite inputs with safe fallback to current position
- Scroll offset clamped to `[0, elementHeight - 1]` to prevent scroll position escaping element bounds
- Object reuse for `_scrollResult` eliminates per-scroll allocations on the hot path

#### Native Scrollbar
- Replaced `null as any` initialization cast with a proper typed `setScrollHandlers(engine)` setter
- Programmatic scroll events tracked via `_pendingProgrammaticEvents` counter to prevent event feedback loops
- Scroll listener stored as typed field (`_scrollListener`) for reliable removal

#### Resize Controller
- Added `ResizeObserver` integration alongside the existing `window.resize` listener
- Skips the first `ResizeObserver` callback to avoid spurious reflows on initial attach
- Only triggers viewport recalculation when width or height actually changes
- Multiple cleanup handlers composed into a single returned cleanup function

#### Touch Controller
- Replaced unbounded velocity array with a fixed-size ring buffer (`Float64Array`, 16 slots) for O(1) velocity sampling regardless of gesture length
- More accurate momentum calculation under high frame rates (240Hz+)

#### Event Emitter
- New `setErrorHandler(handler)` method — errors thrown by event listeners are routed to the handler instead of being silently swallowed or crashing the emitter
- Falls back to `console.error` when no error handler is set

#### Content Observer
- Reference-counted observation via `WeakMap` — the same container element can be observed multiple times safely; the underlying observer is only disconnected when all callers release it
- Guards against non-finite or negative heights from `ResizeObserver` entries
- Defensive try/catch around individual `observe`/`unobserve` calls for detached nodes

## [1.0.1] - 2026-02-02

### Changed

#### Core Rendering
- **Breaking architectural improvement**: Refactored viewport rendering to use pure measurement-driven incremental approach
- Elements are now rendered one-by-one and measured immediately (add → measure → check → repeat)
- Eliminated all estimated heights and default height constants
- Removed position correction passes (no longer needed with accurate measurements)

#### Performance
- Reduced complexity: Rendering now stops exactly when viewport is filled based on actual measurements
- Eliminated correction pass overhead
- More predictable rendering behavior with pixel-perfect positioning from first render

#### Documentation
- Updated ARCHITECTURE.md to reflect measurement-first rendering approach
- Updated IMPLEMENTATION_GUIDE.md to remove default height parameter references
- Clarified that all positioning is based on actual DOM measurements

### Fixed
- Potential lockup on initial load with large datasets (added safety limit for bottom boundary elements)
- Position calculation now uses actual measurements instead of estimates

### Technical Details
- Removed `DEFAULT_ESTIMATED_HEIGHT` constant (no longer needed)
- `renderViewport()` now uses 5-step incremental process: overscan above → incremental visible → overscan below → bottom boundary → cleanup
- Bottom boundary elements limited to 50 maximum to prevent initial load issues
- `computeTrueBottomPosition()` returns null when measurements unavailable (initial state)

## [1.0.0] - 2026-01-28

### 🎉 Initial Release

First public release of CeriousScroll - high-performance virtual scrolling library.

### Added

#### Core Features
- Element-based positioning system for O(1) memory usage
- Variable height support with automatic on-demand measurement
- Native scrollbar integration with bidirectional sync
- Incremental DOM updates (no repositioning or GPU transforms)
- Performance cache with automatic pruning
- Boundary guardian for edge case handling

#### Controllers
- Wheel scroll controller with momentum and coalescing support
- Touch controller with momentum/inertia scrolling
- Keyboard navigation controller (arrow keys, Page Up/Down, Home/End)
- Resize controller with automatic viewport recalculation

#### Features
- Native scrollbar attachment and synchronization
- Content change observer for automatic height updates
- Viewport renderer with overscan buffering
- Custom event system (`cerious-viewport-change`)

#### Developer Experience
- Full TypeScript support with type definitions
- Comprehensive test suite with Vitest
- Framework integration examples (Vue, Angular)
- 9 production-ready demo applications
- Complete documentation (Implementation + Architecture guides)

#### Performance
- O(1) constant memory usage regardless of dataset size
- Consistent 60fps+ scrolling performance
- Sub-millisecond scroll latency
- Tested with 100M+ elements
- Memory efficient caching with automatic cleanup

### Documentation
- Implementation Guide with Quick Start
- Architecture documentation with technical deep dive
- Framework integration examples (Vue 3, Angular)
- 9 demo applications showcasing real-world use cases
- GitHub Pages setup for live demos

### Legal
- MIT License

---

## Roadmap

### Planned features
- React integration examples
- Svelte integration examples
- Accessibility improvements (ARIA labels, keyboard focus)
- RTL (Right-to-Left) language support
- Horizontal scrolling mode
- Performance profiling tools
- DevTools browser extension

---

## Version History

### Versioning Strategy

CeriousScroll follows [Semantic Versioning](https://semver.org/):
- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions
- **PATCH** version for backwards-compatible bug fixes

### Pre-release Versions
- Alpha releases: `1.0.0-alpha.x` - Early testing, unstable API
- Beta releases: `1.0.0-beta.x` - Feature complete, API stable, testing phase
- Release candidates: `1.0.0-rc.x` - Production ready, final testing

---

## Migration Guides

### From 0.x to 1.0.0
N/A - This is the initial public release.

---

## Support

For questions about upgrading or changes in specific versions:
- Email: info@ceriousdevtech.com
- Issues: https://github.com/ceriousdevtech/cerious-scroll/issues

---

## Copyright

Copyright © 2024-2026 Cerious DevTech LLC. All rights reserved.

[1.0.0]: https://github.com/ceriousdevtech/cerious-scroll/releases/tag/v1.0.0
[1.1.3]: https://github.com/ceriousdevtech/cerious-scroll/compare/v1.1.2...v1.1.3
[Unreleased]: https://github.com/ceriousdevtech/cerious-scroll/compare/v1.1.3...HEAD
