# Changelog

All notable changes to CeriousScroll will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Planned Features
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
[Unreleased]: https://github.com/ceriousdevtech/cerious-scroll/compare/v1.0.0...HEAD
