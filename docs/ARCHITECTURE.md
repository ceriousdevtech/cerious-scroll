# CeriousScroll Architecture Documentation

**Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.**

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [Architecture Components](#architecture-components)
4. [Virtual Scrolling Algorithm](#virtual-scrolling-algorithm)
5. [Performance Optimizations](#performance-optimizations)
6. [Input Handling](#input-handling)
7. [API Reference](#api-reference)
8. [Advanced Features](#advanced-features)

---

## Overview

CeriousScroll is a high-performance virtual scrolling library that enables smooth scrolling through datasets of any size (1M+ elements) while maintaining **O(1) constant memory usage**. Unlike traditional virtual scrolling libraries that rely on fixed heights or complex calculations, CeriousScroll uses an **element-based positioning system** with **just-in-time measurement** and **incremental DOM rendering**.

### Key Innovations

- **Element + Offset Positioning**: Instead of pixel-based scrolling, uses element index + pixel offset within that element
- **True O(1) Memory**: Maintains constant memory regardless of dataset size through sliding window caches
- **Variable Height Support**: No pre-calculation required; heights are measured on-demand
- **Incremental DOM Updates**: Only creates/removes elements at viewport edges, never repositions existing elements
- **No GPU Translations**: Achieves 60fps performance without CSS transforms (`translate3d`, `translateY`) or GPU acceleration - uses pure DOM insertion/removal at natural document positions
- **Native Scrollbar Integration**: Bidirectional sync with native scrollbars for familiar UX

### Performance Characteristics

- **Memory**: ~200KB baseline, grows to max 3-4MB during heavy scrolling, returns to baseline after GC
- **FPS**: Consistent 60fps during all scroll operations (wheel, touch, scrollbar, keyboard)
- **Dataset Size**: No practical limit (tested with 100M+ elements)
- **Scroll Latency**: Sub-millisecond position calculations

---

## Core Concepts

### 1. Element-Based Positioning

Traditional virtual scrolling uses **pixel-based positions**:
```
scrollPosition = 45,320px (which element is this?)
```

CeriousScroll uses **element-based positions**:
```
currentElement = 1000
scrollOffset = 25px (25 pixels into element 1000)
```

**Benefits:**
- O(1) position updates (no searching required)
- Natural handling of variable heights
- Deterministic scrolling behavior
- Simpler boundary detection

### 2. Viewport Rendering Window

The viewport consists of:
- **Visible elements**: Elements currently in the viewport
- **Overscan buffer**: 5 elements above and below (prevents flash during scrolling)
- **Tail height pin**: After the first measure, up to ~50 end-of-dataset rows are measured, then dropped from the DOM. `PerformanceCache` pins the last **80** height entries so prune at the top of a large list cannot evict them. True-bottom math reads those cached heights — it does not keep sentinel nodes mounted every frame.

```
┌─────────────────────────────┐
│   Buffer (5 elements)       │
├─────────────────────────────┤ ← Viewport Top
│                             │
│   Visible Elements          │
│   (calculated by height)    │
│                             │
├─────────────────────────────┤ ← Viewport Bottom
│   Buffer (5 elements)       │
└─────────────────────────────┘
     Tail heights cached (not live DOM)
```

### 3. Measurement-Driven Incremental Rendering

Heights are measured immediately as elements are rendered through an incremental approach:

1. **Render overscan buffer above** → Measure each element before startElement
2. **Render visible elements one-by-one** → Add to DOM → measure → accumulate height
3. **Stop when viewport filled** → Based on actual accumulated height
4. **Render overscan buffer below** → Measure each element after viewport
5. **Height cached** → Used for future positioning calculations

**Why this works:**
- Only measures visible elements (O(k) where k = visible count, typically 10-30)
- No estimated heights needed - all positioning from actual measurements
- Cache pruning prevents unbounded memory growth
- Incremental rendering prevents layout thrashing

### 4. Sliding Window Caching

Two types of caches with fixed maximum sizes:

**Height Cache** (200 entries max):
- Stores measured heights for elements
- Keeps entries within ±100 of current position
- Pruned when exceeding 250 entries

**Cumulative Height Cache** (300 entries max):
- Stores cumulative heights for position calculations
- Sliding window moves with scroll position
- Enables O(1) height lookups within window

---

## Architecture Components

### Component Hierarchy

```
CeriousScroll (Main Class)
├── ViewportStateCalculator (Derived viewport metrics)
├── PerformanceCache (Height caching & calculations)
├── ViewportRenderer (DOM rendering & measurement)
├── NavigationEngine (Scroll logic & position calculations)
├── NativeScrollbar (Scrollbar sync)
├── WheelController (Mouse wheel processing)
├── TouchController (Touch gesture processing)
├── ContentObserverManager (DOM resize/mutation tracking)
└── KeyboardHandler (Keyboard navigation)
```

### 1. CeriousScroll (Main Orchestrator)

**File:** `cerious-scroll/cerious-scroll.ts`

**Responsibilities:**
- API surface for consumers
- Component initialization and lifecycle
- State management (currentElement, scrollOffset)
- Position calculation coordination
- Event delegation

**Key Properties:**
```typescript
currentElement: number      // Current element index
scrollOffset: number        // Pixel offset within current element
totalElements: number       // Total dataset size
viewportHeight: number      // Viewport height in pixels
```

**Key Methods:**
```typescript
// Render the viewport
renderViewport(height, container, renderCallback)

// Navigate to specific position
jumpToElement(index)
jumpToPosition(element, offset)
jumpToPercentage(percentage)

// Scroll by delta
scroll(deltaY, viewportHeight)

// Get element information
getElementHeight(index)
getElementViewportPosition(index)
```

**Delegated Controllers:**
- `ViewportStateCalculator` – derives `startElement`, `endElement`, and scroll percentages without bloating the main class.
- `WheelController` – centralizes mouse wheel event wiring and viewport-change dispatch.
- `TouchController` – encapsulates touch gesture handling, touch-action management, and optional momentum.
- `ContentObserverManager` – watches rendered nodes for ResizeObserver/MutationObserver events to keep caches current.

### 2. PerformanceCache

**File:** `cerious-scroll/core/performance-cache.ts`

**Responsibilities:**
- Height measurement caching
- Cumulative height calculations
- Cache pruning and memory management
- Total content height calculation

**Authoritative mode:** supplying a `heightProvider` bypasses the map and its
pruning entirely. The window below is right for heights that can only be
observed by measuring; it is wrong for heights that can be computed, where
eviction is lossy rather than merely cold.

**Cache Limits:**
```typescript
MAX_MEASURED_HEIGHTS_CACHE = 200    // Sliding window around the cursor
CACHE_PRUNE_THRESHOLD = 250         // Prune trigger (plus tail budget)
TAIL_PIN_COUNT = 80                 // Last N indices never pruned
```

**Pruning Strategy:**
```typescript
// Keep heights near the cursor, plus the pinned tail.
// Writes prune; reads do not. If the tail were evicted while the
// camera is at the top of a large list, the renderer would remount
// ~50 sentinel rows every frame just to re-measure them.
const tailStart = totalElements - TAIL_PIN_COUNT;
const keepWindow = MAX_MEASURED_HEIGHTS_CACHE / 2;
for (const [index] of measuredHeights) {
  if (index >= tailStart) continue; // pinned
  if (index < lastAccessedIndex - keepWindow ||
      index > lastAccessedIndex + keepWindow) {
    measuredHeights.delete(index);
  }
}
```

**Why this achieves O(1) memory:**
- Cache size is fixed regardless of dataset size (window + 80 tail slots)
- Pruning removes old entries as new ones are added
- True-bottom still works after scrolling back to the top
- Maximum memory: ~280 heights × 8 bytes ≈ 2.2KB + overhead

### 2b. MasonryLayout + MasonryRenderer (`layout: 'masonry'`)

**Files:** `features/masonry-layout.ts`, `features/masonry-renderer.ts`

Masonry breaks two assumptions the engine otherwise relies on: height is no
longer a function of index alone (which column a card lands in depends on every
card before it), and one virtual element is no longer one DOM node.

Both are resolved by changing what a virtual element *is*:

- **Scroll unit = segment.** The engine is constructed over `segmentCount`, and
  every height question is answered by `MasonryLayout` through a
  `heightProvider`. `NavigationEngine`, `BoundaryGuardian`, `NativeScrollbar`
  and all four controllers are unchanged and unaware.
- **Mount unit = card.** `MasonryRenderer` owns the DOM loop, reading the camera
  the engine already computed. The default `ViewportRenderer` loop is untouched,
  so masonry costs nothing when unused.

`MasonryLayout` stores the real column frontier every K cards — `columns` floats
per snapshot — and resumes the next run from it, so the layout is bit-identical
to one greedy pass from card 0: no seam anywhere, every gutter exactly `gap`.
Memory is `columns * (n / segmentSize)` floats (~12KB for 1M cards at the
default K). The frontier table doubles as a prefix-sum table, making
`getCumulativeHeight` an O(1) lookup rather than a walk.

Reaching a cold position is a sequential pass over everything above it;
`chainAhead(target, budgetMs)` spreads that across frames, and progress is
durable so an abandoned rebuild costs nothing.

Heights come from `getItemHeight(index, columnWidth)`, never from the DOM —
segment replay must price cards that were never mounted. In exchange the scroll
path performs no layout reads at all.

See [MASONRY.md](MASONRY.md) for usage, the seam strategies that were rejected
and why, and resize/rebuild costs.

### 3. ViewportRenderer

**File:** `cerious-scroll/features/viewport-renderer.ts`

**Responsibilities:**
- DOM element creation and removal
- Element positioning (absolute positioning)
- Incremental measurement-based rendering
- Element pooling for reuse

**Rendering Algorithm:**

```typescript
1. Render overscan buffer ABOVE viewport:
   - Render elements [startElement - 5] to [startElement - 1]
   - Measure each element immediately after rendering
   - Calculate their total height to position startElement correctly

2. Render visible elements incrementally:
   - Start at startElement with -scrollOffset position
   - FOR EACH element until viewport filled:
     * Create/reuse element
     * Position at cumulative top
     * Add to DOM
     * Render content
     * Measure actual height (offsetHeight)
     * Add to accumulated height
     * STOP if accumulated height >= viewport height
   - No pre-calculation - measurements drive rendering

3. Render overscan buffer BELOW viewport:
   - Render next 5 elements after viewport
   - Measure each for future use

4. Measure bottom-boundary heights (first time only):
   - Walk up to 50 indices from the dataset end
   - If any height is missing, mount those rows, measure, then drop them
   - Once cached (and pinned), skip the live DOM sentinels — repositioning
     ~50 extra nodes every frame was wasted work
   - Limited count prevents initial-load lockup

5. Remove out-of-range elements:
   - Elements outside visible + overscan range
   - Return to pool for reuse
```

**Incremental DOM Strategy:**

CeriousScroll never repositions existing elements. When scrolling:

**Scroll Down (element 10 → 11):**
- Elements 10-14 already rendered
- Remove elements that scrolled out of view (top)
- Create new elements entering view (bottom)
- Existing elements stay at their positions

**Scroll Up (element 11 → 10):**
- Elements 11-15 already rendered
- Remove elements that scrolled out of view (bottom)
- Create new elements entering view (top)
- Existing elements stay at their positions

**Benefits:**
- Minimal DOM manipulation (only edges)
- No layout thrashing from repositioning
- Smooth 60fps scrolling
- No estimated heights or correction passes needed

### 4. NavigationEngine

**File:** `cerious-scroll/engine/navigation-engine.ts`

**Responsibilities:**
- Pure scroll delta processing with injected dependencies
- Element transition logic and offset bookkeeping
- Boundary detection via `BoundaryGuardian`
- Percentage/jump/reset navigation entry points
- Surfaces side-effect hooks (`requestDisplayUpdate`, `syncScrollbar`) for the orchestrator

**Support Class:** `BoundaryGuardian`
- Applies damping strategies near the end of the dataset
- Prevents scroll overshoot with configurable thresholds

**Public API:**
```typescript
scroll(deltaY, viewportHeight)
handleScrollPercentage(percentage)
jumpToElement(index)
jumpToPosition(element, offset, skipScrollbarSync?)
reset()
updateConfig(totalElements, viewportHeight)
```

**Scroll Algorithm:**

```typescript
scroll(deltaY: number) {
  let element = currentElement;
  let offset = scrollOffset + deltaY;
  
  // Handle element transitions
  while (true) {
    const elementHeight = getElementHeight(element);
    
    // Scroll down: offset >= height
    if (offset >= elementHeight && element < totalElements - 1) {
      offset -= elementHeight;
      element++;
      continue;
    }
    
    // Scroll up: offset < 0
    if (offset < 0 && element > 0) {
      element--;
      const prevHeight = getElementHeight(element);
      offset = prevHeight + offset; // offset is negative
      continue;
    }
    
    break; // No more transitions
  }
  
  // Clamp offset to valid range
  offset = clamp(offset, 0, getElementHeight(element) - 1);
  
  // Bottom boundary correction (if near end)
  if (shouldRunBoundaryCorrection(element)) {
    correction = calculateBottomBoundaryCorrection(element, offset);
    if (correction) {
      element = correction.element;
      offset = correction.offset;
    }
  }
  
  return { element, offset };
}
```

**Boundary Correction:**

Prevents over-scrolling past the last element. After the tail is measured,
`getTrueBottomPosition()` is known. If the camera is **not** past that
position, the overshoot walk (`getElementViewportPosition(last)`) is skipped —
it is O(distance) and a no-op in that branch. The walk still runs on the first
frames / short content, before the last row has a cached height. Unmeasured
last-row walks only start when the camera is within 100 of the end (avoids O(n)
on huge lists before the first render).

```typescript
calculateBottomBoundaryCorrection(element, offset) {
  // Only apply if within 10 elements of the end
  if (totalElements - 1 - element > 10) {
    return null; // Not near end, skip
  }
  
  // Check if last element's bottom is above viewport bottom
  const lastElementPos = getElementViewportPosition(totalElements - 1);
  const overshoot = viewportHeight - lastElementPos.bottom;
  
  if (overshoot <= 2) {
    return null; // No significant overshoot
  }
  
  // Scroll back to fill the gap
  // Move backwards through elements to fill overshoot
  let correctedElement = element;
  let correctedOffset = offset;
  let remainingGap = overshoot * 0.9; // 90% damping
  
  while (remainingGap > 0.5) {
    if (correctedOffset >= remainingGap) {
      correctedOffset -= remainingGap;
      break;
    }
    remainingGap -= correctedOffset;
    if (correctedElement > 0) {
      correctedElement--;
      correctedOffset = getElementHeight(correctedElement) - 1;
    } else {
      break;
    }
  }
  
  return { element: correctedElement, offset: correctedOffset };
}
```

**Why 10 elements threshold:**
- Prevents false corrections when scrolling through large elements mid-list
- Only activates near the actual end
- Avoids jumping when large elements are in the middle

### 5. NativeScrollbar

**File:** `cerious-scroll/features/native-scrollbar.ts`

**Responsibilities:**
- Create and manage native scrollbar
- Bidirectional sync (scrollbar ↔ virtual position)
- RAF throttling for performance
- Position change detection

**Architecture:**

```
Virtual Scroller              Native Scrollbar
┌──────────────┐             ┌──────────────┐
│ Element: 500 │   sync →    │ ScrollTop:   │
│ Offset:  30  │             │   12,345px   │
└──────────────┘             └──────────────┘
       ↑                              ↓
       └──────── sync ←───────────────┘
```

**Scrollbar Sync Algorithm:**

```typescript
// Virtual → Scrollbar (called after every scroll)
syncScrollbarToPosition() {
  const cumulativeHeight = getCumulativeHeight(currentElement);
  const totalHeight = getTotalContentHeight();
  const scrollbarPosition = cumulativeHeight + scrollOffset;
  
  scrollbarElement.scrollTop = scrollbarPosition;
}

// Scrollbar → Virtual (called on scrollbar scroll event)
handleScrollbarScroll(event) {
  // RAF throttle to max 60fps
  if (rafId) return;
  
  rafId = requestAnimationFrame(() => {
    const scrollbarPosition = scrollbarElement.scrollTop;
    
    // Convert pixel position to element + offset
    let accHeight = 0;
    let targetElement = 0;
    
    for (let i = 0; i < totalElements; i++) {
      const height = getElementHeight(i);
      if (accHeight + height > scrollbarPosition) {
        targetElement = i;
        targetOffset = scrollbarPosition - accHeight;
        break;
      }
      accHeight += height;
    }
    
    // Only update if position actually changed
    if (targetElement !== currentElement || 
        targetOffset !== scrollOffset) {
      jumpToPosition(targetElement, targetOffset);
    }
    
    rafId = null;
  });
}
```

**Performance Optimizations:**

1. **RAF Throttling**: Limits scrollbar scroll events to 60fps max
2. **Position Change Detection**: Skips updates if position hasn't changed
3. **Result**: Reduced renders by 70-80% during scrollbar dragging

### 6. Touch Handler

**File:** `cerious-scroll/features/scroll-handlers.ts` (touch methods)

**Responsibilities:**
- Touch gesture tracking
- Momentum calculation
- Friction simulation
- Smooth deceleration

**Touch Phases:**

```typescript
1. Touch Start:
   - Record initial touch position
   - Cancel any ongoing momentum
   - Mark touch as active

2. Touch Move:
   - Calculate delta from last position
   - Apply scroll delta
   - Track velocity for momentum
   - Render viewport

3. Touch End:
   - Calculate final velocity
   - Start momentum animation if enabled
   - Apply friction over time
   
4. Momentum (RAF loop):
   - velocity *= friction (e.g., 0.95)
   - scroll(velocity)
   - Continue until velocity < 0.5
```

**Momentum Calculation:**

```typescript
const friction = 0.95; // Default friction
let velocity = calculateVelocity(touchEvents);

function momentumStep() {
  if (Math.abs(velocity) < 0.5) {
    return; // Stop
  }
  
  scroll(velocity);
  velocity *= friction; // Apply friction
  
  requestAnimationFrame(momentumStep);
}
```

---

## Virtual Scrolling Algorithm

### Complete Scroll Cycle

Here's a complete trace of what happens when the user scrolls:

**User scrolls wheel by 50px:**

```
1. Wheel Event Handler
   └─→ scroll(deltaY = 50)

2. NavigationEngine.scroll()
  Current state: element=100, offset=30
   
   a. Add delta: offset = 30 + 50 = 80
   b. Get element height: getElementHeight(100) = 60
   c. Check transition: 80 >= 60? Yes!
   d. Transition: 
      - offset = 80 - 60 = 20
      - element = 101
   e. Check transition: 20 >= height(101)? No
   f. Clamp offset: offset = clamp(20, 0, 59) = 20
   g. Return { element: 101, offset: 20 }

3. Update Position
   currentElement = 101
   scrollOffset = 20

4. Sync Scrollbar
   cumulativeHeight = getCumulativeHeight(101)
   scrollbarTop = cumulativeHeight + 20

5. Call onScroll Callback
   └─→ app calls renderViewport() (this is the supported render hook
       for every input path, including native scrollbar)

6. ViewportRenderer.renderViewport()
   a. Calculate visible range:
      - Start at element 101, offset 20
      - viewportHeight = 600px
      - accHeight = -20 (start 20px into element 101)
      - Add elements until accHeight >= 600:
        * 101 (60px): accHeight = 40
        * 102 (40px): accHeight = 80
        * 103 (40px): accHeight = 120
        * ...continues...
        * 115 (60px): accHeight = 620 → STOP
      - Visible: 101-115
   
   b. Add overscan buffer:
      - Buffer above: 96-100 (5 elements)
      - Buffer below: 116-120 (5 elements)
      - Should render: 96-120
   
   c. Calculate positions:
      - startElementTop = -20 (element 101 position)
      - For buffer 96-100:
        * Position = startTop - sum(heights[96:100])
        * Example: -20 - 300 = -320px
      - Position element 101 at -20px
      - Position element 102 at 40px (101's height - offset)
      - Continue...
   
   d. Incremental update:
      - Previous render: 95-119
      - Remove: 95 (scrolled out of top buffer)
      - Create: 120 (entered bottom buffer)
      - Update positions: 96-119
   
   e. Measure new elements:
      - Render element 120 to DOM
      - Immediately measure: element.offsetHeight
      - Cache measurement: cache(120, measuredHeight)
   
   f. Return viewport info:
      {
        startElement: 101,
        endElement: 115,
        scrollPercentage: 10.15,
        renderedElements: [...],
        totalRenderedHeight: 620
      }

7. Update UI Metrics (demo specific)
   Display current position, visible range, etc.

Total time: < 1ms
DOM operations: 1-2 elements created/removed
FPS: 60
```

### Position Calculation Examples

**Example 1: Jump to Element 5000**

```typescript
jumpToElement(5000)

1. Set position:
   currentElement = 5000
   scrollOffset = 0

2. Calculate scrollbar position:
   cumulativeHeight = getCumulativeHeight(5000)
   
   // With sliding window cache:
   if (5000 in cache window) {
     return cache[5000 - cacheStart]
   } else {
     // Rebuild cache window around 5000
     windowStart = 5000 - 299 = 4701
     baseHeight = estimatedHeight(0-4700)
     
     cache = []
     cache[0] = 0
     for (i = 4701; i < 5300; i++) {
       height = getMeasured(i) || 40
       cache[i - 4701 + 1] = cache[i - 4701] + height
     }
     
     return baseHeight + cache[5000 - 4701]
   }

3. Set scrollbar:
   scrollbar.scrollTop = cumulativeHeight

4. Render viewport starting at 5000
```

**Example 2: Scroll Percentage to 50%**

```typescript
jumpToPercentage(50)

1. Calculate target position:
   totalHeight = calculateTotalContentHeight()
   // Uses measured heights + estimates for unmeasured
   
   targetPixel = totalHeight * 0.5

2. Find element at target pixel:
   accHeight = 0
   for (i = 0; i < totalElements; i++) {
     height = getElementHeight(i)
     if (accHeight + height > targetPixel) {
       element = i
       offset = targetPixel - accHeight
       break
     }
     accHeight += height
   }

3. Jump to position:
   jumpToPosition(element, offset)
```

---

## Performance Optimizations

### 1. No GPU Translations (Pure DOM Approach)

**CeriousScroll achieves 60fps scrolling without CSS transforms or GPU acceleration.**

Traditional virtual scrollers use:
```css
/* Traditional approach */
.virtual-item {
  transform: translate3d(0, 1234px, 0);  /* GPU-accelerated */
}
```

CeriousScroll uses:
```javascript
// Pure DOM insertion at natural positions
container.appendChild(element);  // No transforms needed
```

**Why this matters:**
- **No transform overhead**: Eliminates GPU layer management and composite operations
- **Natural document flow**: Elements exist at their natural positions in the DOM
- **Simpler rendering**: Browser's native layout engine handles positioning
- **Lower GPU memory**: No texture uploads or layer allocations
- **CPU-only approach**: Scales better on devices with limited GPU resources

**How it achieves performance:**
- Only renders visible elements + small buffer (~20 elements total)
- Incremental DOM updates (add/remove at edges only)
- Never repositions existing elements - they stay at natural positions
- O(1) operations regardless of dataset size

### 2. Object Pooling

Reusable data structures to eliminate per-frame allocations:

```typescript
// ViewportRenderer
private _shouldBeVisibleSet = new Set<number>();
private _toRemoveArray: number[] = [];
private _sortedIndicesArray: number[] = [];

// Reuse instead of creating new:
renderViewport() {
  // OLD (allocates every frame):
  const shouldBeVisible = new Set<number>();
  
  // NEW (reuses existing):
  this._shouldBeVisibleSet.clear();
  // ... use the set ...
}
```

**Impact:**
- Eliminates ~220 bytes × 60fps = 13KB/sec allocations
- Reduces GC pressure
- Smoother performance

### 2. RAF Throttling

Limit high-frequency events to 60fps max:

```typescript
private _scrollbarRafId: number | null = null;

handleScrollbarScroll(event) {
  if (this._scrollbarRafId) return; // Already scheduled
  
  this._scrollbarRafId = requestAnimationFrame(() => {
    // Process scroll
    this._scrollbarRafId = null;
  });
}
```

**Applied to:**
- Scrollbar scroll events (one engine `scroll` + `onScroll` per animation frame)
- Touch move events (vertical delta accumulated; velocity sampled every move)
- Momentum animation

Mouse-wheel notches stay instant. Trackpad wheel can optionally smooth (`wheel.smooth`).

### 2b. Uniform-height and table hot path

When `PerformanceCache.getUniformHeightHint()` is set (ten consecutive equal measured heights), `getElementViewportPosition` is O(1) instead of walking from the camera. Newly created rows can skip a layout-forcing `offsetHeight` read during fast scroll.

`layout: 'table'` caches `getBoundingClientRect` of `<thead>` as `getTopInset`. Invalidate at the start of `renderViewport`, between inset-before/after (async header), on resize, and on `invalidateCache` / `clearAllCaches`. `scroll()` uses the cached inset so the last row is not clipped behind the header.

`AbsolutePlacement` does not rewrite `position: absolute` every frame, and skips writing `top` when the value is unchanged.

### 3. Periodic DOM Cleanup

Clear DOM when jumping far to prevent memory accumulation:

```typescript
renderViewport() {
  // If we jumped > 100 elements from last render
  if (Math.abs(startElement - lastStartElement) > 100) {
    container.innerHTML = ''; // Nuclear option
    currentlyRendered.clear();
  }
}
```

**Why this works:**
- Large jumps indicate user navigation (not scrolling)
- Clearing DOM forces browser to release element memory
- Rebuilding from scratch is fast for ~20 elements
- Maintains O(1) memory guarantee

### 4. Cache Pruning Strategy

Aggressive cleanup keeps only relevant measurements:

```typescript
_pruneOldCacheEntries() {
  // Threshold includes room for the pinned tail
  if (measuredHeights.size <= PRUNE_THRESHOLD + TAIL_PIN_COUNT) return;

  const tailStart = totalElements - TAIL_PIN_COUNT;
  const keepWindow = MAX_MEASURED_HEIGHTS_CACHE / 2;

  for (const [index] of measuredHeights) {
    if (index >= tailStart) continue;
    if (Math.abs(index - lastAccessedIndex) > keepWindow) {
      measuredHeights.delete(index);
    }
  }
}
```

**Called from:**
- Every `setMeasuredHeight()` (writes prune; reads do not)

**Result:**
- Sliding window of ~200 heights plus 80 pinned tail entries
- No memory growth over time
- True-bottom math stays valid after a prune at the top of the list

### 5. Early Returns and Short Circuits

Avoid expensive operations when possible:

```typescript
### 5. Interaction Controllers

The monolithic scroll handler previously owned every form of input. Each signal
is now managed by a dedicated controller that speaks to `NavigationEngine` via
small, testable contracts:

- `controllers/keyboard-controller.ts`
  - Normalizes focus, key bindings, and event dispatching
  - Emits structured viewport-change events for analytics/UI hooks
- `controllers/wheel-controller.ts`
  - Handles passive wheel listeners, prevents default browser scrolling, and
    emits unified viewport events
- `controllers/touch-controller.ts`
  - Encapsulates touch-action styling, pointer tracking, optional momentum, and
    DOM event hygiene (capture + cleanup)
- `controllers/resize-controller.ts`
  - Listens to window resizes and routes them through a single `handleViewportChange`
    callback so the orchestrator and scrollbar stay consistent
- `observers/content-observer.ts`
  - Couples a `MutationObserver` with `ResizeObserver` to invalidate caches only
    when measured values truly change

Each controller exposes an `attach()` that returns a cleanup function, making
the lifecycle explicit inside `CeriousScroll.dispose()`.

## Input Handling

### Wheel Scrolling

**Implementation:** `setupWheelHandler()`

```typescript
container.addEventListener('wheel', (e) => {
  e.preventDefault(); // Prevent default scroll
  
  const result = scroll(e.deltaY, container.clientHeight);
  
  // Trigger re-render
  if (onScroll) onScroll(result);
}, { passive: false }); // Non-passive to preventDefault
```

**Delta Processing:**
- Positive deltaY → scroll down
- Negative deltaY → scroll up
- deltaY magnitude varies by device/OS
- Directly passed to scroll() method

### Touch Scrolling

**Phases:**

```typescript
1. touchstart:
   - Record startY, startTime
   - Cancel momentum
   - Set touchActive = true

2. touchmove:
   - Calculate deltaY = currentY - lastY
   - Invert for natural scrolling: deltaY *= -1
   - Accumulate deltaY; schedule one scroll + onScroll per animation frame
     (same idea as native-scrollbar 1.0.8 — browsers fire many touchmoves
     per frame; applying each one walks the engine and re-renders)
   - Velocity is still sampled on every move
   - Update lastY, lastTime

3. touchend:
   - Flush any coalesced delta before momentum so the flick starts from
     the real finger-up position
   - Calculate velocity from recent history
   - If enableMomentum:
     * Start momentum animation
     * velocity *= friction each frame
     * Continue until velocity < 0.5

4. touchcancel:
   - Stop everything
   - Clean up
```

**Momentum Calculation:**

```typescript
calculateVelocity(touchHistory) {
  // Use last 100ms of touch data
  const recent = touchHistory.filter(
    t => t.time > now - 100
  );
  
  if (recent.length < 2) return 0;
  
  const first = recent[0];
  const last = recent[recent.length - 1];
  
  const distance = last.y - first.y;
  const time = last.time - first.time;
  
  return distance / time * 16; // Normalize to 60fps
}
```

### Keyboard Navigation

**Supported Keys:**

```typescript
ArrowUp:     scroll(-arrowKeySpeed)    // Default: -120px
ArrowDown:   scroll(+arrowKeySpeed)    // Default: +120px
PageUp:      scroll(-viewportHeight * pageKeySpeed) // Default: -100%
PageDown:    scroll(+viewportHeight * pageKeySpeed) // Default: +100%
Home:        jumpToElement(0)
End:         jumpToElement(totalElements - 1)
```

**Custom Handlers:**

```typescript
keyboard: {
  enabled: true,
  arrowKeySpeed: 120,  // pixels per arrow key press
  pageKeySpeed: 1.0,   // viewport heights per page key
  onKeyDown: (event, scroller) => {
    console.log('Key pressed:', event.key);
    
    // Return true to prevent default handling
    if (event.key === 'Escape') {
      scroller.jumpToElement(0);
      return true; // Handled
    }
    
    return false; // Let CeriousScroll handle it
  }
}
```

---

## API Reference

### Constructor

```typescript
new CeriousScroll(
  container: HTMLElement,
  totalElements: number,
  options?: CeriousScrollOptions
)
```

**Parameters:**
- `container`: The DOM element that will contain the scrollable content
- `totalElements`: Total number of elements in the dataset
- `options`: Configuration object (optional)

**Options:**

```typescript
interface CeriousScrollOptions {
  // Input
  wheel?: {
    enabled?: boolean;                   // default true
    emitViewportChangeEvent?: boolean;   // default true
    coalesceViewportChangeEvent?: boolean; // default false
    smooth?: boolean;                    // trackpad only; default true
    smoothFactor?: number;               // default 0.22
  };
  touch?: {
    enabled?: boolean;
    enableMomentum?: boolean;            // default true
    momentumFriction?: number;           // default 0.95
    momentumThreshold?: number;          // px/ms, default 0.1
    getHorizontalScrollTarget?: () => HTMLElement | null | undefined;
    axisLockThreshold?: number;          // default 8
  };
  keyboard?: {
    enabled?: boolean;
    arrowKeySpeed?: number;              // px, default 120
    pageKeySpeed?: number;               // viewport fraction, default 1.0
    onKeyDown?: (event, scroller) => boolean;
  };

  attachScrollbar?: boolean;             // default true
  autoResize?: boolean;                  // default true
  observeContentChanges?: boolean;       // default true

  // Drive rendering from this callback. It runs for wheel, touch, keyboard,
  // native scrollbar, and resize. `cerious-viewport-change` is wheel/touch/
  // keyboard only; the scrollbar emits a different `viewport-change` event.
  onScroll?: () => void;

  layout?: 'absolute' | 'table';         // default 'absolute'
  table?: TableFlowOptions;              // header populator, class names
}
```

Overscan is a constant (`OVERSCAN_BUFFER_SIZE = 5`), not a constructor option.

### Core Methods

#### renderViewport()

```typescript
renderViewport(
  windowHeight: number,
  container: HTMLElement,
  renderElement: ElementRenderer
): MeasuredViewportRange
```

Renders the current viewport and returns information about what was rendered.

**Parameters:**
- `windowHeight`: Viewport height in pixels
- `container`: DOM container for rendered elements
- `renderElement`: Callback to render each element

**ElementRenderer Callback:**

```typescript
type ElementRenderer = (
  index: number,
  elementToRender: HTMLElement
) => void | HTMLElement;
```

The callback receives:
- `index`: The element index to render
- `elementToRender`: The DOM element to populate

The callback should:
1. Set the content of `elementToRender`
2. Optionally return void (library will measure)
3. Or return the element after rendering

**Returns:**

```typescript
interface MeasuredViewportRange {
  startElement: number;          // First visible element index
  endElement: number;            // Last visible element index
  scrollPercentage: number;      // 0-100
  viewportElements: number;      // Count of visible elements
  renderedElements: Array<{      // All rendered elements
    index: number;
    height: number;
  }>;
  totalRenderedHeight: number;   // Sum of visible heights
}
```

**Example:**

```typescript
const viewport = scroller.renderViewport(
  600,  // viewport height
  containerElement,
  (index, element) => {
    const data = getDataItem(index);
    element.innerHTML = `
      <div class="item">
        <h3>${data.title}</h3>
        <p>${data.content}</p>
      </div>
    `;
    element.style.minHeight = '40px';
  }
);

console.log(`Showing ${viewport.startElement}-${viewport.endElement}`);
```

#### scroll()

```typescript
scroll(deltaY: number, viewportHeight: number): ScrollResult
```

Scroll by a pixel delta. Handles element transitions automatically.

**Parameters:**
- `deltaY`: Pixels to scroll (positive = down, negative = up)
- `viewportHeight`: Current viewport height

**Returns:**

```typescript
interface ScrollResult {
  element: number;    // New current element
  offset: number;     // New offset within element
}
```

#### jumpToElement()

```typescript
jumpToElement(index: number): ScrollResult
```

Jump directly to an element (offset = 0). Out-of-range indices are clamped.
`Number.MAX_SAFE_INTEGER` is the keyboard End sentinel (jump to last row /
true bottom).

**Parameters:**
- `index`: Element index (0-based)

**Example:**

```typescript
scroller.jumpToElement(1000);  // Jump to element 1000
```

Offset-into-row jumps are not on the public `CeriousScroll` facade.
`NavigationEngine.jumpToPosition(element, offset)` exists for the native
scrollbar (thumb drag maps a pixel `scrollTop` onto an element + offset).
Consumers who need a percentage jump should use `handleScrollPercentage`.

#### handleScrollPercentage()

```typescript
handleScrollPercentage(percentage: number): ScrollResult
```

Navigate to a percentage position (0-100).

**Parameters:**
- `percentage`: Target scroll percentage (0.0 = top, 100.0 = bottom)

**Example:**

```typescript
scroller.handleScrollPercentage(50);  // Jump to 50%
```

### Information Methods

#### getElementHeight()

```typescript
getElementHeight(index: number): number
```

Get the measured height of an element.

**Parameters:**
- `index`: Element index

**Returns:** Height in pixels (from measured cache)

**Note:** Elements must have been rendered at least once to have a measured height. Returns the cached measurement from when the element was last rendered in the viewport.

#### getElementViewportPosition()

```typescript
getElementViewportPosition(index: number): {
  top: number;
  bottom: number;
  isVisible: boolean;
}
```

Calculate an element's position relative to the viewport.

**Parameters:**
- `index`: Element index

**Returns:**
- `top`: Distance from viewport top (negative if above)
- `bottom`: Distance from viewport top to element bottom
- `isVisible`: Whether element is in viewport

**Example:**

```typescript
const pos = scroller.getElementViewportPosition(100);
if (pos.isVisible) {
  console.log(`Element 100 is visible at ${pos.top}px`);
}
```

### Properties

```typescript
readonly currentElement: number;     // Current element index
readonly scrollOffset: number;       // Offset within current element
readonly totalElements: number;      // Total dataset size
readonly viewportHeight: number;     // Viewport height
readonly scrollPercentage: number;   // Current scroll percentage (0-100)
readonly startElement: number;       // First rendered element
readonly endElement: number;         // Last rendered element
```

### Lifecycle

#### dispose()

```typescript
dispose(): void
```

Detach wheel / touch / keyboard / resize / content observers and the native
scrollbar. Call this when the container leaves the DOM.

**Example:**

```typescript
const scroller = new CeriousScroll(container, 1000, options);

// ... use scroller ...

scroller.dispose();
```

---

## Advanced Features

### 1. Variable Height Content

CeriousScroll handles variable heights automatically through measurement-based rendering:

```typescript
scroller.renderViewport(600, container, (index, element) => {
  const item = getData(index);
  
  // Different content heights based on data
  if (item.type === 'header') {
    element.innerHTML = `<h1>${item.title}</h1>`;
    element.style.minHeight = '80px';
  } else if (item.type === 'image') {
    element.innerHTML = `<img src="${item.url}">`;
    element.style.minHeight = '300px';
  } else {
    element.innerHTML = `<p>${item.text}</p>`;
    element.style.minHeight = '40px';
  }
});
```

Heights are automatically measured and cached.

### 3. Horizontal Scrolling

Add horizontal overflow to elements:

```typescript
scroller.renderViewport(600, container, (index, element) => {
  element.innerHTML = `
    <div style="
      white-space: nowrap;
      overflow-x: auto;
      min-height: 50px;
    ">
      ${veryLongContent}
    </div>
  `;
});
```

CeriousScroll only handles vertical scrolling; horizontal is native.

### 4. Nested Scrolling

CeriousScroll can be nested:

```typescript
// Outer scroller
const outerScroller = new CeriousScroll(outerContainer, 1000);

outerScroller.renderViewport(600, outerContainer, (index, element) => {
  // Each outer element contains an inner scroller
  const innerContainer = document.createElement('div');
  innerContainer.style.height = '200px';
  element.appendChild(innerContainer);
  
  const innerScroller = new CeriousScroll(innerContainer, 100);
  innerScroller.renderViewport(200, innerContainer, (innerIndex, innerElement) => {
    innerElement.textContent = `Outer ${index}, Inner ${innerIndex}`;
  });
});
```

### 5. Dynamic Dataset Updates

Update the total element count:

```typescript
// Start with 1000 elements
const scroller = new CeriousScroll(container, 1000);

// Later, load more data
scroller.updateTotalElements(2000);

// The scroller adapts automatically
```

### 6. Preserve Scroll Position

When dataset changes, preserve visual position:

```typescript
// Before update
const currentPos = {
  element: scroller.currentElement,
  offset: scroller.scrollOffset,
  percentage: scroller.scrollPercentage
};

// Update data
updateDataset(newData);
scroller.updateTotalElements(newData.length);

// Restore position (choose one):
scroller.jumpToPosition(currentPos.element, currentPos.offset);
// OR maintain percentage:
scroller.handleScrollPercentage(currentPos.percentage);
```

### 7. Accessibility

Add ARIA attributes for screen readers:

```typescript
scroller.renderViewport(600, container, (index, element) => {
  element.setAttribute('role', 'listitem');
  element.setAttribute('aria-setsize', totalElements);
  element.setAttribute('aria-posinset', index + 1);
  element.setAttribute('tabindex', '0');
  
  element.innerHTML = `<div>${getData(index).text}</div>`;
});

// Make container focusable
container.setAttribute('role', 'list');
container.setAttribute('tabindex', '0');
```

### 8. Infinite Scrolling

Detect when approaching the end and load more:

```typescript
scroller.renderViewport(600, container, (index, element) => {
  // Render element
  renderItem(index, element);
  
  // Check if approaching end
  if (index >= scroller.totalElements - 20) {
    loadMoreData().then(newData => {
      appendData(newData);
      scroller.updateTotalElements(scroller.totalElements + newData.length);
    });
  }
});
```

### 9. Debugging

Enable debug logging:

```typescript
// Add to scroll handler
scroller.renderViewport(600, container, (index, element) => {
  console.log(`Rendering element ${index}`, {
    currentElement: scroller.currentElement,
    scrollOffset: scroller.scrollOffset,
    startElement: scroller.startElement,
    endElement: scroller.endElement,
    percentage: scroller.scrollPercentage
  });
  
  renderItem(index, element);
});
```

Monitor performance:

```typescript
const start = performance.now();
scroller.renderViewport(600, container, renderCallback);
const end = performance.now();
console.log(`Render took ${end - start}ms`);
```

---

## Performance Benchmarks

### Memory Usage

| Dataset Size | Baseline | Peak (Scrolling) | After GC |
|--------------|----------|------------------|----------|
| 100 elements | 200 KB   | 500 KB           | 200 KB   |
| 10K elements | 200 KB   | 2 MB             | 200 KB   |
| 100K elements| 200 KB   | 3 MB             | 200 KB   |
| 1M elements  | 200 KB   | 4 MB             | 200 KB   |
| 10M elements | 200 KB   | 4 MB             | 200 KB   |

**Key Insight:** Memory usage is **independent of dataset size** - true O(1) memory!

### Scroll Performance

| Operation | Time | FPS |
|-----------|------|-----|
| Single scroll event | < 1ms | 60 |
| Fast continuous scroll | 0.5-1ms per frame | 60 |
| Jump to element | < 1ms | N/A |
| Jump to percentage | 1-2ms | N/A |
| Render viewport | 0.5-2ms | 60 |

### Scrollbar Performance (with optimizations)

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Scrollbar drag renders | 240/sec | 60/sec | 75% reduction |
| Scroll events processed | All | RAF-throttled | Max 60fps |
| Position updates | Every event | On change only | 70% reduction |

---

## Common Patterns

### Pattern 1: Lazy Loading Images

```typescript
scroller.renderViewport(600, container, (index, element) => {
  const item = getData(index);
  
  element.innerHTML = `
    <div class="item">
      <img 
        src="placeholder.jpg"
        data-src="${item.imageUrl}"
        class="lazy"
      />
      <p>${item.text}</p>
    </div>
  `;
  
  // Lazy load image
  const img = element.querySelector('img');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        img.src = img.dataset.src;
        observer.unobserve(img);
      }
    });
  });
  observer.observe(img);
});
```

### Pattern 2: Search and Scroll to Result

```typescript
function searchAndScrollTo(query) {
  for (let i = 0; i < totalElements; i++) {
    const item = getData(i);
    if (item.text.includes(query)) {
      scroller.jumpToElement(i);
      
      // Highlight after render
      setTimeout(() => {
        const element = container.querySelector(
          `[data-element-index="${i}"]`
        );
        element.classList.add('highlight');
      }, 100);
      
      return;
    }
  }
}
```

### Pattern 3: Grouped/Sectioned Lists

```typescript
const sections = [
  { title: 'Section A', start: 0, end: 99 },
  { title: 'Section B', start: 100, end: 299 },
  { title: 'Section C', start: 300, end: 599 }
];

scroller.renderViewport(600, container, (index, element) => {
  // Find which section this index belongs to
  const section = sections.find(
    s => index >= s.start && index <= s.end
  );
  
  const isFirstInSection = index === section.start;
  
  element.innerHTML = `
    ${isFirstInSection ? `<h2>${section.title}</h2>` : ''}
    <div class="item">${getData(index).text}</div>
  `;
  
  element.style.minHeight = isFirstInSection ? '100px' : '40px';
});
```

### Pattern 4: Table Rows with Virtual Scrolling

```typescript
// Fixed header
const header = document.createElement('div');
header.className = 'table-header';
header.innerHTML = '<div>ID</div><div>Name</div><div>Value</div>';
container.parentElement.insertBefore(header, container);

// Virtual rows
scroller.renderViewport(600, container, (index, element) => {
  const row = getData(index);
  
  element.className = 'table-row';
  element.innerHTML = `
    <div class="cell">${row.id}</div>
    <div class="cell">${row.name}</div>
    <div class="cell">${row.value}</div>
  `;
  
  element.style.minHeight = '40px';
  element.style.display = 'flex';
});
```

---

## Troubleshooting

### Issue: Jumping/Jittering During Scroll

**Cause:** Position recalculation not working correctly

### Issue: Elements Misaligned After Scrolling

**Cause:** Elements not being measured before positioning

**Solution:** Ensure `renderViewport()` uses incremental measurement:

```typescript
// Elements must be rendered and measured before next element is positioned
container.appendChild(element);
renderElement(index, element);
const height = element.offsetHeight; // Measure immediately
// Use height for positioning next element
```

### Issue: Memory Growing Over Time

**Cause:** Cache not being pruned

**Solution:** Verify pruning is called:

```typescript
// In performance-cache.ts
setMeasuredHeight(index, height) {
  this._measuredHeights.set(index, height);
  this._pruneOldCacheEntries(); // Must be called!
}
```

### Issue: Blank Screen When Jumping

**Cause:** Elements not being rendered after jump

**Solution:** Ensure `renderViewport()` is called after `jumpToElement()`:

```typescript
scroller.jumpToElement(1000);
scroller.renderViewport(viewportHeight, container, renderCallback);
```

### Issue: Scrollbar Not Syncing

**Cause:** Scrollbar not updated after scroll

**Solution:** Ensure sync is called:

```typescript
scroll(deltaY) {
  // ... scroll logic ...
  this.syncScrollbar(); // Must be called!
}
```

### Issue: Touch Scrolling Not Working

**Cause:** Touch events prevented by browser

**Solution:** Ensure `touch-action: none` is applied:

```css
.scroll-container {
  touch-action: none;
}
```

Or via options:

```typescript
const scroller = new CeriousScroll(container, totalElements, {
  touch: { enabled: true }
});
```

---

## Best Practices

### 1. Always Set minHeight

Help the browser with layout:

```typescript
renderElement: (index, element) => {
  element.style.minHeight = '40px'; // Or expected height
  element.innerHTML = content;
}
```

### 2. Avoid Expensive Rendering

Keep render callbacks fast:

```typescript
// ❌ BAD: Heavy computation in render
renderElement: (index, element) => {
  const data = expensiveDataTransform(getData(index));
  element.innerHTML = complexTemplate(data);
}

// ✅ GOOD: Pre-process data
const processedData = data.map(expensiveDataTransform);
renderElement: (index, element) => {
  element.innerHTML = simpleTemplate(processedData[index]);
}
```

### 3. Use Event Delegation

Don't attach listeners to every element:

```typescript
// ❌ BAD: Listener per element
renderElement: (index, element) => {
  element.addEventListener('click', handleClick);
}

// ✅ GOOD: One listener on container
container.addEventListener('click', (e) => {
  const element = e.target.closest('[data-element-index]');
  if (element) {
    const index = parseInt(element.dataset.elementIndex);
    handleClick(index);
  }
});
```

### 4. Debounce External Updates

Don't update on every scroll:

```typescript
let updateTimeout;
onScroll: () => {
  clearTimeout(updateTimeout);
  updateTimeout = setTimeout(() => {
    updateExternalState(scroller.scrollPercentage);
  }, 100);
}
```

### 5. Clean Up Resources

Always call dispose:

```typescript
componentWillUnmount() {
  this.scroller.dispose();
}
```

---

## Future Enhancements

Potential areas for future development:

1. **Horizontal Virtual Scrolling**: Support for horizontal lists
2. **Grid Layout**: 2D virtual scrolling for grids
3. **Sticky Headers**: Section headers that stick during scroll
4. **Variable Width**: Support for horizontal variable widths
5. **Collaborative Scrolling**: Sync scroll position across clients
6. **Persistence**: Save/restore scroll position across sessions
7. **Animation Hooks**: Callbacks for custom scroll animations
8. **Smart Prefetching**: Predict scroll direction and preload

---

## Conclusion

CeriousScroll achieves high-performance virtual scrolling through:

1. **Element-based positioning** for O(1) position calculations
2. **Just-in-time measurement** for variable height support
3. **Sliding window caching** for O(1) memory usage
4. **Incremental DOM updates** for minimal rendering overhead
5. **Position recalculation** to prevent visual jumps
6. **Aggressive optimizations** (pooling, throttling, pruning)

The result is a virtual scrolling library that can handle datasets of any size with consistent 60fps performance and constant memory usage.

---

**Questions or Issues?** Contact: jared@kirchgatter.com
