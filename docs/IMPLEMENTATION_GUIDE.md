# CeriousScroll Implementation Guide

**Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.**

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Basic Setup](#basic-setup)
4. [Configuration Options](#configuration-options)
    - [Pinned section headers (`sticky`)](#pinned-section-headers-sticky)
    - [Row snapping (`snap`)](#row-snapping-snap)
    - [Edge-triggered loading (`infinite`)](#edge-triggered-loading-infinite)
    - [Screen-reader semantics (`aria`)](#screen-reader-semantics-aria)
    - [Right-to-left (`direction`)](#right-to-left-direction)
    - [SSR and hydration (`ssr`)](#ssr-and-hydration-ssr)
5. [Rendering Patterns](#rendering-patterns)
6. [Navigation Methods](#navigation-methods)
7. [Event Handling](#event-handling)
8. [Performance Best Practices](#performance-best-practices)
9. [Common Use Cases](#common-use-cases)
10. [Framework Integration](#framework-integration)
    - [Vue Integration](#vue-integration)
    - [Angular Integration](#angular-integration)
11. [Troubleshooting](#troubleshooting)

---

## Quick Start

Constructor is `(container, totalElements, options?)`. There is no default-height argument. Drive rendering from `onScroll` — it runs for wheel, touch, keyboard, native scrollbar, and resize. The engine measures `offsetHeight` after your callback; returning a height is ignored.

`cerious-viewport-change` is wheel/touch/keyboard only. Native scrollbar emits a different `viewport-change` event. If you render only from `cerious-viewport-change`, thumb-drag will not update the list.

```typescript
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const data = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  content: `Item ${i}`
}));

const container = document.getElementById('scroll-container')!;

function render() {
  const viewport = scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      element.innerHTML = `
        <div class="item">
          <h3>Item ${data[index].id}</h3>
          <p>${data[index].content}</p>
        </div>
      `;
    }
  );
  console.log('Visible range:', viewport.startElement, '-', viewport.endElement);
}

const scroller = new CeriousScroll(container, data.length, {
  onScroll: render,
});

render();
```

**HTML Structure:**
```html
<div id="scroll-container" style="height: 600px; overflow: hidden;">
  <!-- CeriousScroll will manage content here -->
</div>
```

---

## Installation

### NPM/Yarn (Recommended)
```bash
npm install @ceriousdevtech/cerious-scroll
# or
yarn add @ceriousdevtech/cerious-scroll
```

### Manual Installation
Copy the `cerious-scroll` directory into your project and import:
```typescript
import { CeriousScroll } from './cerious-scroll/index.js';
```

---

## Basic Setup

### Step 1: Prepare Your HTML Container

```html
<div id="scroll-container" style="height: 600px; overflow: hidden;">
  <!-- Content will be rendered here by CeriousScroll -->
</div>
```

**Requirements:**
- Fixed height container (e.g., `height: 600px` or `height: 100vh`)
- `overflow: hidden` (CeriousScroll manages scrolling internally)
- Container must be in the DOM before initializing

### Step 2: Initialize CeriousScroll

```typescript
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

const container = document.getElementById('scroll-container')!;
const totalItems = 10000;
const scroller = new CeriousScroll(container, totalItems, {
  onScroll: render,
});
```

### Step 3: Implement the Render Function

```typescript
function render() {
  const viewport = scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      element.innerHTML = `<div class="item">${data[index].content}</div>`;
    }
  );

  console.log('Visible range:', viewport.startElement, '-', viewport.endElement);
}
```

The callback should populate `element`. Do not return a height — the engine reads `offsetHeight`.

### Step 4: Initial Render

Call `render()` once after constructing the scroller. `onScroll` covers later input.

---

## Configuration Options

CeriousScroll accepts an optional configuration object as the 3rd argument (`options`). There is no default-height constructor argument; the engine measures `offsetHeight` after your render callback.

```typescript
const scroller = new CeriousScroll(container, totalItems, {
  keyboard: {
    enabled: true,               // Enable/disable keyboard navigation
    arrowKeySpeed: 120,          // Pixels per arrow key press
    pageKeySpeed: 1.0,           // Viewport fraction per page key
    onKeyDown: (event, scroller) => {
      if (event.key === 'Home') {
        scroller.jumpToElement(0);
        return true; // Prevent default
      }
      return false; // Use default behavior
    }
  },

  touch: {
    enabled: true,
    enableMomentum: true,
    momentumFriction: 0.95,
    momentumThreshold: 0.1
  },

  wheel: {
    enabled: true,
    emitViewportChangeEvent: true,
    coalesceViewportChangeEvent: false
  },

  attachScrollbar: true,
  autoResize: true,
  observeContentChanges: true,

  onScroll: () => {
    console.log('Scrolled to:', scroller.currentElement);
  }
});
```

### Wheel and touch scrolling

Both are handled by the browser, not by the engine. The engine puts a hidden
native scroll surface behind your content, lets the browser scroll it, and
follows its `scrollTop`. So wheel notches, trackpad gestures and touch pans all
get the platform's own physics — Chrome and Edge animate a discrete notch on
Windows but not on macOS, Firefox uses a different curve again, and a precision
touchpad's continuous deltas are passed through unanimated. OS and driver
settings no script can read, such as how many lines a notch travels, apply too.

**There is nothing to configure and nothing your markup has to provide.** The
surface needs one element it can hold still while it scrolls beneath, and the
engine arranges that:

| Your host | What happens |
|---|---|
| Bare `<div>` | the engine creates `[data-cerious-scroll-content]` and renders rows into it |
| `[data-cerious-scroll-content]` as a direct child | wrapped as-is |
| Content element nested (e.g. inside a horizontal-scroll wrapper) | the host's own child containing it is wrapped |

When the engine creates the element, a `renderViewport(h, host, …)` call is
redirected into it — passing the host says *where* you want rows, and they have
to be inside the surface to move with it. Passing any other element is treated as
a specific instruction and left alone.

Horizontal deltas are still forwarded by the engine: the surface is
`overflow-x: hidden` and the scrollable element sits inside it, so a sideways
gesture has no native target. Only a horizontal-dominant gesture is claimed, so
the vertical part of a diagonal swipe still reaches the surface.

`wheel.smooth`, `wheel.smoothFactor` and `wheel.notchThresholdPx` are deprecated
no-ops. They tuned a JavaScript easing curve that no longer runs.

### Pinned section headers (`sticky`)

`sticky.resolve` is handed the first visible row and returns the dataset index
that should be pinned above it, or `null`. The pinned element is rendered
through your normal row renderer but mounted **outside** the recycler, so it
survives the moment its own row scrolls out of the mounted window.

```js
const sections = [0, 40, 95, 160];   // ascending header indices

new CeriousScroll(host, total, {
  sticky: {
    resolve: (firstVisible) => {
      for (let i = sections.length - 1; i >= 0; i--) {
        if (sections[i] <= firstVisible) return sections[i];
      }
      return null;
    },
    className: 'is-pinned'
  }
});
```

`resolve` runs on every window move, so keep it cheap: a scan over a few hundred
section markers is fine, a scan over the whole dataset is not. Because the
pinned row is drawn in two places at once, your renderer must be idempotent.
Cost is exactly one extra element, whatever the dataset size.

---

### Row snapping (`snap`)

Settles the camera on a row boundary once scrolling stops. This is cheap here in
a way it is not for a pixel-based scroller: the camera is already
`(element, offset)`, so snapping is driving `offset` to zero.

```js
new CeriousScroll(host, total, {
  snap: {
    enabled: true,
    align: 'nearest',   // or 'start' to always settle to the top of the row
    tolerance: 2        // px of slack; skips the nudge when already landed
  }
});
```

CSS scroll-snap cannot do this job. The surface the browser actually scrolls is
a featureless spacer with no snap targets on it, so the engine settles the
camera itself after the native `scrollend` signal — which also means snapping
never fights an in-flight gesture or its momentum.

---

### Edge-triggered loading (`infinite`)

Thin sugar over `updateTotalElements()`, which already does the hard part of
growing the dataset in place and re-anchoring both native surfaces so the camera
does not move. This option only decides *when* to ask.

```js
new CeriousScroll(host, rows.length, {
  infinite: {
    threshold: 20,     // rows from the edge that trigger a load
    edges: 'end',      // or 'both' to backfill upwards as well
    onLoadMore: (ctx) => {
      // ctx = { direction, first, last, total }
      return fetch('/api/rows?after=' + cursor)
        .then((r) => r.json())
        .then((page) => {
          rows.push(...page.items);
          scroller.updateTotalElements(rows.length);
        });
    }
  }
});
```

**Return the promise.** The callback fires once per approach and re-arms when the
window moves back out of the threshold; while a returned promise is still
pending, no further call is made. A callback that fires and forgets is re-armed
as soon as it returns, and a slow endpoint gets asked again on the next frame.

Growing the dataset does not grow the DOM. Measured on the infinite demo: the
dataset went from 40 rows to 520 while the mounted window stayed between 9 and
13 rows.

---

### Screen-reader semantics (`aria`)

Virtualization is invisible to a screen reader in the worst way: it reads the
DOM, the DOM holds twenty rows, so it announces "item 3 of 20" for a dataset of
a million. `aria-setsize` and `aria-posinset` are the standard repair — they
state the real size and position independently of what is mounted — and the
engine already knows both numbers.

```js
new CeriousScroll(host, 500_000, {
  aria: {
    enabled: true,
    role: 'list',          // default for absolute and masonry layouts
    itemRole: 'listitem',  // default for absolute and masonry layouts
    label: 'Search results'
    // labelledBy: 'results-heading'   // prefer this when a heading exists
  }
});
```

It is opt-in because the correct markup depends on what the rows *mean*. For
`layout: 'table'` neither role is set by default and you should not add them:
`<tr>` and `<td>` already carry real semantics, and a role replaces those rather
than adding to them.

ARIA describes the list; it does not make it focusable. Keyboard navigation is
the separate `keyboard` option.

---

### Right-to-left (`direction`)

RTL is not a mirrored stylesheet. The scrollbar moves to the leading edge, the
browser's own `scrollLeft` origin changes meaning, and any inset expressed as
`left` or `right` ends up on the wrong side.

```js
new CeriousScroll(host, total, {
  direction: 'auto'   // 'ltr' | 'rtl' | 'auto' (read the host's own direction)
});
```

The engine handles the scroll math and positions rows with **logical** insets
(`inset-inline-start` / `inset-inline-end`), so the gutter it reserves for the
scrollbar lands on whichever side the scrollbar is actually on. Masonry fills
columns from the trailing edge; column 0 is still the first column the packer
fills, it is simply drawn from the other edge.

Write your own row CSS with logical properties — `padding-inline-start`,
`border-inline-end`, `text-align: start` — and it follows the direction for
free. `direction: 'auto'` is read once at mount, so flipping the host's `dir`
at runtime means re-creating the instance.

---

### SSR and hydration (`ssr`)

The package is import-safe without a DOM already: nothing touches `document` or
`window` at module scope, so a server bundle can include it. `ssr.hydrate` adds
the second half — adopting markup that is already there instead of clearing it
on the first render.

```html
<!-- rendered on the server -->
<div id="feed" data-cerious-scroll-content>
  <div data-element-index="0">…</div>
  <div data-element-index="1">…</div>
</div>
```

```js
new CeriousScroll(host, total, { ssr: { hydrate: true } });
```

`data-element-index` is the contract: rows are matched by it, so server output
and client render agree on identity. A row without it cannot be matched and is
replaced. Your client renderer must produce the same markup the server did for a
given index, or the first paint after adoption will shift. Render enough rows to
cover the first viewport and no more; extras are adopted and then immediately
recycled.

Without `hydrate`, the first frame clears the container, which throws away the
server-rendered content and flashes.

---

## Rendering Patterns

### Pattern 1: Simple Text Rendering

```typescript
scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    element.textContent = `Item ${index}`;
  }
);
```

### Pattern 2: HTML Template Rendering

```typescript
scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    const item = data[index];
    element.innerHTML = `
      <div class="item-card">
        <img src="${item.image}" alt="${item.title}">
        <h3>${item.title}</h3>
        <p>${item.description}</p>
      </div>
    `;
  }
);
```

### Pattern 3: Component-Based Rendering (React-like)

```typescript
function renderItem(item: Item, container: HTMLElement): void {
  container.innerHTML = '';
  const itemElement = document.createElement('div');
  itemElement.className = 'item';
  
  // Build your component
  const title = document.createElement('h3');
  title.textContent = item.title;
  itemElement.appendChild(title);
  
  const description = document.createElement('p');
  description.textContent = item.description;
  itemElement.appendChild(description);
  
  container.appendChild(itemElement);
}

scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    renderItem(data[index], element);
  }
);
```

### Pattern 4: Cached Rendering (Performance Optimization)

```typescript
const renderedCache = new Map<number, string>();

scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    // Check cache
    if (!renderedCache.has(index)) {
      const item = data[index];
      renderedCache.set(index, `
        <div class="item">
          <h3>${item.title}</h3>
          <p>${item.description}</p>
        </div>
      `);
    }
    
    element.innerHTML = renderedCache.get(index)!;
  }
);
```

### Pattern 5: Variable Height Rendering

```typescript
scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    const item = data[index];
    
    // Different layouts based on item type
    if (item.type === 'header') {
      element.innerHTML = `<h2 class="header">${item.title}</h2>`;
    } else if (item.type === 'image') {
      element.innerHTML = `
        <div class="image-item">
          <img src="${item.url}" alt="${item.title}">
          <p>${item.caption}</p>
        </div>
      `;
    } else {
      element.innerHTML = `<p class="text">${item.content}</p>`;
    }
    
  }
);
```

---

## Navigation Methods

### Scroll to Specific Element

```typescript
scroller.jumpToElement(500); // offset 0

// Jump to end (same sentinel the keyboard End key uses)
scroller.jumpToElement(Number.MAX_SAFE_INTEGER);
```

`jumpToElement` always lands at offset 0. Out-of-range indices are clamped.
Offset-into-row jumps are not on the public facade (`NavigationEngine.jumpToPosition` is what the native scrollbar uses internally). For a percentage jump, use `handleScrollPercentage`.

### Scroll by Delta

```typescript
// Scroll down by 100 pixels
scroller.scroll(100, container.clientHeight);

// Scroll up by 100 pixels
scroller.scroll(-100, container.clientHeight);
```

### Get Current Position

```typescript
console.log('Current element:', scroller.currentElement);
console.log('Offset:', scroller.scrollOffset);
console.log('Scroll percentage:', scroller.scrollPercentage);
```

### Get Visible Range

```typescript
// startElement / endElement are updated by renderViewport / updateDisplay
console.log('Start:', scroller.startElement);
console.log('End:', scroller.endElement);
console.log('Visible elements:', scroller.endElement - scroller.startElement);
```

---

## Event Handling

Drive **rendering** from `onScroll`. Use the CustomEvents below for analytics / UI chrome if you want them — they are not a complete render signal.

### `onScroll` (render hook)

Runs after wheel, touch, keyboard, native scrollbar, and resize.

```typescript
const scroller = new CeriousScroll(container, totalItems, {
  onScroll: () => {
    scroller.renderViewport(container.clientHeight, container, renderFunction);
    updateScrollIndicator(scroller.scrollPercentage);
  }
});
scroller.renderViewport(container.clientHeight, container, renderFunction);
```

### `cerious-viewport-change`

Fired by wheel, touch, and keyboard. **Not** fired by native scrollbar drag.

`event.detail` is reused across events (do not retain it). Shape:

```typescript
{
  percentage: number;
  currentElement: number;
  scrollOffset: number;
  result?: { element: number; offset: number };
}
```

```typescript
container.addEventListener('cerious-viewport-change', (event: CustomEvent) => {
  const { currentElement, scrollOffset, percentage } = event.detail;
  console.log(`At element ${currentElement} + ${scrollOffset}px (${percentage.toFixed(1)}%)`);
});
```

### Native scrollbar `viewport-change`

Thumb drag emits `viewport-change` (no `cerious-` prefix) on the container. Prefer `onScroll` so you do not have to listen to both names.

### Custom Keyboard Handling

```typescript
const scroller = new CeriousScroll(container, totalItems, {
  keyboard: {
    onKeyDown: (event, scroller) => {
      if (event.key === 'Home') {
        scroller.jumpToElement(0);
        return true; // Handled
      }
      if (event.key === 'End') {
        scroller.jumpToElement(totalItems - 1);
        return true; // Handled
      }
      return false; // Use default behavior
    }
  }
});
```

---

## Performance Best Practices

### 1. Optimize Your Render Function

**❌ Bad:**
```typescript
(index, element) => {
  // Complex calculations inside render
  const processedData = expensiveOperation(data[index]);
  element.innerHTML = processedData;
}
```

**✅ Good:**
```typescript
// Pre-process data once
const processedData = data.map(item => expensiveOperation(item));

(index, element) => {
  element.innerHTML = processedData[index];
}
```

### 2. Minimize DOM Access

**❌ Bad:**
```typescript
(index, element) => {
  element.innerHTML = `<div>${data[index].title}</div>`;
  element.querySelector('div')!.style.color = 'red'; // Extra DOM access
}
```

**✅ Good:**
```typescript
(index, element) => {
  element.innerHTML = `<div style="color: red;">${data[index].title}</div>`;
}
```

### 3. Use Event Coalescing for Heavy Updates

```typescript
const scroller = new CeriousScroll(container, totalItems, {
  wheel: {
    coalesceViewportChangeEvent: true // Batch wheel events
  }
});
```

### 4. Disable Unused Features

```typescript
const scroller = new CeriousScroll(container, totalItems, {
  keyboard: { enabled: false },  // If no keyboard navigation needed
  touch: { enabled: false },     // If desktop-only
  observeContentChanges: false   // If heights are truly static
});
```

### 5. Clean Up When Done

```typescript
// When removing the scroller
scroller.dispose();
```

---

## Common Use Cases

These snippets are the **render callback**. Wire them through `onScroll` as in Quick Start so wheel, touch, keyboard, **and** native scrollbar all re-render. Dispatching `cerious-viewport-change` is not a substitute.

### Use Case 1: Data Grid

```typescript
const columns = ['ID', 'Name', 'Email', 'Status', 'Actions'];
const rows = 100000;

const scroller = new CeriousScroll(container, rows);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(container.clientHeight, container, (index, element) => {
    element.innerHTML = `
      <div class="grid-row">
        <div class="cell">${index}</div>
        <div class="cell">User ${index}</div>
        <div class="cell">user${index}@example.com</div>
        <div class="cell">${index % 2 === 0 ? 'Active' : 'Inactive'}</div>
        <div class="cell">
          <button onclick="editRow(${index})">Edit</button>
        </div>
      </div>
    `;
  });
});
```

### Use Case 2: Chat Messages

```typescript
const messages = loadMessages(); // Array of message objects

const scroller = new CeriousScroll(container, messages.length);

// Scroll to bottom (most recent message)
scroller.jumpToElement(messages.length - 1);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(container.clientHeight, container, (index, element) => {
    const msg = messages[index];
    element.innerHTML = `
      <div class="message ${msg.sender === 'me' ? 'sent' : 'received'}">
        <div class="avatar">${msg.sender[0]}</div>
        <div class="content">
          <div class="sender">${msg.sender}</div>
          <div class="text">${msg.text}</div>
          <div class="time">${msg.timestamp}</div>
        </div>
      </div>
    `;
  });
});
```

### Use Case 3: Log Viewer

```typescript
const logs = loadLogs(); // Array of log entries

const scroller = new CeriousScroll(container, logs.length);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(container.clientHeight, container, (index, element) => {
    const log = logs[index];
    const levelClass = log.level.toLowerCase(); // error, warn, info, debug
    
    element.innerHTML = `
      <div class="log-entry ${levelClass}">
        <span class="timestamp">${log.timestamp}</span>
        <span class="level">${log.level}</span>
        <span class="message">${log.message}</span>
      </div>
    `;
  });
});
```

### Use Case 4: E-commerce Product List

```typescript
const products = loadProducts(); // Array of products

const scroller = new CeriousScroll(container, products.length);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(container.clientHeight, container, (index, element) => {
    const product = products[index];
    element.innerHTML = `
      <div class="product-card">
        <img src="${product.image}" alt="${product.name}">
        <h3>${product.name}</h3>
        <p class="price">$${product.price.toFixed(2)}</p>
        <p class="description">${product.description}</p>
        <button onclick="addToCart(${product.id})">Add to Cart</button>
      </div>
    `;
  });
});
```

### Use Case 5: Financial Trading Dashboard

```typescript
const trades = loadTrades(); // Array of trade data

const scroller = new CeriousScroll(container, trades.length);

container.addEventListener('cerious-viewport-change', () => {
  scroller.renderViewport(container.clientHeight, container, (index, element) => {
    const trade = trades[index];
    const priceChangeClass = trade.change >= 0 ? 'positive' : 'negative';
    
    element.innerHTML = `
      <div class="trade-row">
        <span class="symbol">${trade.symbol}</span>
        <span class="price">$${trade.price.toFixed(2)}</span>
        <span class="change ${priceChangeClass}">
          ${trade.change >= 0 ? '+' : ''}${trade.change.toFixed(2)}%
        </span>
        <span class="volume">${trade.volume.toLocaleString()}</span>
        <span class="time">${trade.timestamp}</span>
      </div>
    `;
  });
});
```

---

## Troubleshooting

### Issue: Nothing Renders

**Cause:** `renderViewport` was never called. Constructing the scroller does not paint.

**Solution:**
```typescript
const scroller = new CeriousScroll(container, totalItems, { onScroll: render });
render(); // initial paint; onScroll covers later input
```

Do not rely on dispatching `cerious-viewport-change` for the first frame — that event is not how the constructor boots the list.

### Issue: Scrollbar Drag Does Not Re-render

**Cause:** Rendering is wired only to `cerious-viewport-change`, which wheel/touch/keyboard emit. Native scrollbar drag does not.

**Solution:** Put `renderViewport` in `onScroll`.

### Issue: Scroll Isn't Working

**Cause:** Container doesn't have `overflow: hidden`.

**Solution:**
```css
#scroll-container {
  height: 600px;
  overflow: hidden; /* Required */
}
```

### Issue: Heights Are Wrong

**Cause:** Content is not in the DOM yet when the engine measures, or height changes on later paints (images, fonts, async HTML).

**Solution:** Populate `element` synchronously in the render callback. The engine reads `offsetHeight` after the callback returns — you do not return a height. If content loads later (images), call `renderViewport` again once sizes are known, or set an explicit `minHeight`.

### Issue: Performance Degradation

**Cause:** Render function is too complex or data processing is inside render.

**Solution:**
- Pre-process data outside the render function
- Cache rendered HTML if possible
- Minimize DOM operations
- Use `coalesceViewportChangeEvent: true`

### Issue: Content Shifts During Scroll

**Cause:** Element heights changing between renders.

**Solution:**
```typescript
// Set fixed heights in CSS
.item {
  height: 60px; /* or min-height */
}
```

Or ensure consistent rendering:
```typescript
(index, element) => {
  element.style.minHeight = '60px'; // Prevent height changes
  element.innerHTML = content;
}
```

### Issue: Scrollbar Not Appearing

**Cause:** `attachScrollbar` option disabled.

**Solution:**
```typescript
const scroller = new CeriousScroll(container, totalItems, {
  attachScrollbar: true // Enable scrollbar
});
```

### Issue: Memory Leaks

**Cause:** Not calling `dispose()` when removing scroller.

**Solution:**
```typescript
// When done with scroller
scroller.dispose();
```

---

## Framework Integration

### Vue Integration

CeriousScroll integrates seamlessly with Vue 3 using Composition API or Options API.

#### Vue 3 Composition API

```vue
<template>
  <div ref="containerRef" class="scroll-container">
    <!-- Content rendered by CeriousScroll -->
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

interface Item {
  id: number;
  title: string;
  description: string;
}

const props = defineProps<{
  items: Item[];
}>();

const containerRef = ref<HTMLElement | null>(null);
let scroller: CeriousScroll | null = null;

const renderItem = (index: number, element: HTMLElement): number => {
  const item = props.items[index];
  element.innerHTML = `
    <div class="item-card">
      <h3>${item.title}</h3>
      <p>${item.description}</p>
    </div>
  `;
};

const handleViewportChange = () => {
  if (scroller && containerRef.value) {
    scroller.renderViewport(
      containerRef.value.clientHeight,
      containerRef.value,
      renderItem
    );
  }
};

onMounted(() => {
  if (containerRef.value) {
    // Initialize CeriousScroll
    scroller = new CeriousScroll(
      containerRef.value,
      props.items.length,
      {
        keyboard: { enabled: true },
        touch: { enabled: true },
        onScroll: handleViewportChange,
      }
    );
    handleViewportChange();
  }
});

onBeforeUnmount(() => {
  scroller?.dispose();
});

// Expose methods for parent components
defineExpose({
  jumpToElement: (index: number) => scroller?.jumpToElement(index),
  getCurrentPosition: () => ({
    element: scroller?.currentElement,
    offset: scroller?.scrollOffset,
    scrollPercentage: scroller?.scrollPercentage
  })
});
</script>

<style scoped>
.scroll-container {
  height: 600px;
  overflow: hidden;
  border: 1px solid #ddd;
}

.item-card {
  padding: 16px;
  border-bottom: 1px solid #eee;
}

.item-card h3 {
  margin: 0 0 8px 0;
}

.item-card p {
  margin: 0;
  color: #666;
}
</style>
```

#### Vue 3 Options API

```vue
<template>
  <div ref="container" class="scroll-container">
    <!-- Content rendered by CeriousScroll -->
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

export default defineComponent({
  name: 'CeriousScroll',
  props: {
    items: {
      type: Array,
      required: true
    }
  },
  data() {
    return {
      scroller: null as CeriousScroll | null
    };
  },
  mounted() {
    const container = this.$refs.container as HTMLElement;
    
    this.scroller = new CeriousScroll(container, this.items.length, {
      onScroll: this.handleViewportChange
    });
    this.handleViewportChange();
  },
  beforeUnmount() {
    this.scroller?.dispose();
  },
  methods: {
    handleViewportChange() {
      const container = this.$refs.container as HTMLElement;
      if (this.scroller) {
        this.scroller.renderViewport(
          container.clientHeight,
          container,
          (index: number, element: HTMLElement) => {
            const item = this.items[index];
            element.innerHTML = `
              <div class="item">
                <h3>${item.title}</h3>
                <p>${item.description}</p>
              </div>
            `;
          }
        );
      }
    },
    jumpToElement(index: number) {
      this.scroller?.jumpToElement(index);
    }
  }
});
</script>

<style scoped>
.scroll-container {
  height: 600px;
  overflow: hidden;
}
</style>
```

#### Vue Composable (Reusable Hook)

Create a reusable composable for CeriousScroll:

```typescript
// composables/useCeriousScroll.ts
import { ref, onMounted, onBeforeUnmount, Ref } from 'vue';
import { CeriousScroll, CeriousScrollOptions } from '@ceriousdevtech/cerious-scroll';

export function useCeriousScroll<T>(
  items: Ref<T[]>,
  defaultHeight: number = 60,
  options?: CeriousScrollOptions
) {
  const containerRef = ref<HTMLElement | null>(null);
  let scroller: CeriousScroll | null = null;
  let lastRender: (() => void) | null = null;

  const init = (renderFn: (index: number, element: HTMLElement) => void) => {
    if (!containerRef.value) return;

    lastRender = () => {
      if (scroller && containerRef.value) {
        scroller.renderViewport(
          containerRef.value.clientHeight,
          containerRef.value,
          renderFn
        );
      }
    };

    scroller = new CeriousScroll(
      containerRef.value,
      items.value.length,
      { ...options, onScroll: lastRender }
    );
    lastRender();
  };

  const jumpToElement = (index: number) => {
    scroller?.jumpToElement(index);
  };

  const getCurrentPosition = () => {
    return { element: scroller?.currentElement, offset: scroller?.scrollOffset, scrollPercentage: scroller?.scrollPercentage };
  };

  const updateItems = (newItems: T[]) => {
    scroller?.updateTotalElements(newItems.length);
    lastRender?.();
  };

  onBeforeUnmount(() => {
    scroller?.dispose();
  });

  return {
    containerRef,
    init,
    jumpToElement,
    getCurrentPosition,
    updateItems
  };
}
```

Usage of the composable:

```vue
<template>
  <div ref="containerRef" class="scroll-container"></div>
</template>

<script setup lang="ts">
import { useCeriousScroll } from '@/composables/useCeriousScroll';

const items = ref([/* your data */]);

const { containerRef, init } = useCeriousScroll(items, 60, {
  keyboard: { enabled: true }
});

onMounted(() => {
  init((index, element) => {
    element.innerHTML = `<div class="item">${items.value[index].title}</div>`;
  });
});
</script>
```

---

### Angular Integration

CeriousScroll integrates with Angular using directives, services, or direct component usage.

#### Angular Component Approach

```typescript
// virtual-scroller.component.ts
import { 
  Component, 
  ElementRef, 
  Input, 
  OnInit, 
  OnDestroy, 
  ViewChild, 
  Output, 
  EventEmitter 
} from '@angular/core';
import { CeriousScroll, CeriousScrollOptions } from '@ceriousdevtech/cerious-scroll';

export interface VirtualScrollItem {
  id: number;
  [key: string]: any;
}

@Component({
  selector: 'app-virtual-scroller',
  template: `
    <div #scrollContainer class="scroll-container">
      <!-- Content rendered by CeriousScroll -->
    </div>
  `,
  styles: [`
    .scroll-container {
      height: 600px;
      overflow: hidden;
      border: 1px solid #ddd;
    }
  `]
})
export class CeriousScrollComponent implements OnInit, OnDestroy {
  @ViewChild('scrollContainer', { static: true }) 
  containerRef!: ElementRef<HTMLElement>;

  @Input() items: VirtualScrollItem[] = [];
  @Input() defaultHeight: number = 60;
  @Input() options?: CeriousScrollOptions;
  @Input() renderItem!: (item: VirtualScrollItem, element: HTMLElement) => void;

  @Output() scrollPositionChange = new EventEmitter<number>();
  @Output() viewportChange = new EventEmitter<{ start: number; end: number }>();

  private scroller?: CeriousScroll;

  ngOnInit(): void {
    this.initializeScroller();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private initializeScroller(): void {
    const container = this.containerRef.nativeElement;

    this.scroller = new CeriousScroll(
      container,
      this.items.length,
      {
        ...this.options,
        onScroll: () => {
          this.handleViewportChange();
          if (this.scroller) {
            this.scrollPositionChange.emit(this.scroller.currentElement);
          }
        }
      }
    );
    this.handleViewportChange();
  }

  private handleViewportChange(): void {
    if (!this.scroller) return;

    const container = this.containerRef.nativeElement;
    const viewport = this.scroller.renderViewport(
      container.clientHeight,
      container,
      (index, element) => {
        const item = this.items[index];
        if (this.renderItem) {
          this.renderItem(item, element);
        } else {
          // Default rendering
          element.innerHTML = `
            <div class="default-item">
              ${JSON.stringify(item)}
            </div>
          `;
        }
      }
    );

    this.viewportChange.emit({
      start: viewport.startElement,
      end: viewport.endElement
    });
  }

  private cleanup(): void {
    this.scroller?.dispose();
  }

  // Public methods for parent components
  jumpToElement(index: number, offset: number = 0): void {
    this.scroller?.jumpToElement(index);
  }

  getCurrentPosition() {
    return {
      element: this.scroller?.currentElement,
      offset: this.scroller?.scrollOffset,
      scrollPercentage: this.scroller?.scrollPercentage
    };
  }

  updateItems(items: VirtualScrollItem[]): void {
    this.items = items;
    this.scroller?.updateTotalElements(items.length);
    this.handleViewportChange();
  }
}
```

#### Using the Angular Component

```typescript
// app.component.ts
import { Component } from '@angular/core';
import { VirtualScrollItem } from './virtual-scroller.component';

@Component({
  selector: 'app-root',
  template: `
    <div class="app">
      <h1>CeriousScroll with Angular</h1>
      
      <app-virtual-scroller
        [items]="items"
        [defaultHeight]="80"
        [renderItem]="renderItem"
        (scrollPositionChange)="onScrollPositionChange($event)"
        (viewportChange)="onViewportChange($event)">
      </app-virtual-scroller>

      <div class="controls">
        <button (click)="scrollToTop()">Scroll to Top</button>
        <button (click)="scrollToBottom()">Scroll to Bottom</button>
      </div>
    </div>
  `,
  styles: [`
    .app {
      padding: 20px;
    }
    .controls {
      margin-top: 20px;
    }
    .controls button {
      margin-right: 10px;
    }
  `]
})
export class AppComponent {
  items: VirtualScrollItem[] = [];

  constructor() {
    // Generate sample data
    this.items = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      title: `Item ${i}`,
      description: `Description for item ${i}`
    }));
  }

  renderItem = (item: VirtualScrollItem, element: HTMLElement): void => {
    element.innerHTML = `
      <div class="item-card">
        <h3>${item.title}</h3>
        <p>${item.description}</p>
      </div>
    `;
  };

  onScrollPositionChange(position: number): void {
    console.log('Current position:', position);
  }

  onViewportChange(viewport: { start: number; end: number }): void {
    console.log('Visible range:', viewport.start, '-', viewport.end);
  }

  scrollToTop(): void {
    // Access child component via ViewChild
  }

  scrollToBottom(): void {
    // Access child component via ViewChild
  }
}
```

#### Angular Service Approach

Create a service to manage CeriousScroll instances:

```typescript
// virtual-scroll.service.ts
import { Injectable } from '@angular/core';
import { CeriousScroll, CeriousScrollOptions } from '@ceriousdevtech/cerious-scroll';

@Injectable({
  providedIn: 'root'
})
export class VirtualScrollService {
  private scrollers = new Map<string, CeriousScroll>();

  createScroller(
    id: string,
    container: HTMLElement,
    totalItems: number,
    defaultHeight: number = 60,
    options?: CeriousScrollOptions
  ): CeriousScroll {
    const scroller = new CeriousScroll(container, totalItems, options);
    this.scrollers.set(id, scroller);
    return scroller;
  }

  getScroller(id: string): CeriousScroll | undefined {
    return this.scrollers.get(id);
  }

  disposeScroller(id: string): void {
    const scroller = this.scrollers.get(id);
    if (scroller) {
      scroller.dispose();
      this.scrollers.delete(id);
    }
  }

  disposeAll(): void {
    this.scrollers.forEach(scroller => scroller.dispose());
    this.scrollers.clear();
  }
}
```

#### Angular Directive Approach

```typescript
// virtual-scroll.directive.ts
import { 
  Directive, 
  ElementRef, 
  Input, 
  OnInit, 
  OnDestroy,
  Output,
  EventEmitter
} from '@angular/core';
import { CeriousScroll, CeriousScrollOptions } from '@ceriousdevtech/cerious-scroll';

@Directive({
  selector: '[appVirtualScroll]'
})
export class VirtualScrollDirective implements OnInit, OnDestroy {
  @Input() totalItems: number = 0;
  @Input() defaultHeight: number = 60;
  @Input() scrollOptions?: CeriousScrollOptions;
  @Input() renderFn!: (index: number, element: HTMLElement) => void;

  @Output() viewportChange = new EventEmitter<any>();

  private scroller?: CeriousScroll;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    const container = this.el.nativeElement;

    const render = () => {
      if (this.scroller && this.renderFn) {
        const viewport = this.scroller.renderViewport(
          container.clientHeight,
          container,
          this.renderFn
        );
        this.viewportChange.emit(viewport);
      }
    };

    this.scroller = new CeriousScroll(
      container,
      this.totalItems,
      { ...this.scrollOptions, onScroll: render }
    );
    render();
  }

  ngOnDestroy(): void {
    this.scroller?.dispose();
  }
}
```

Usage of the directive:

```typescript
@Component({
  selector: 'app-example',
  template: `
    <div 
      appVirtualScroll
      [totalItems]="items.length"
      [defaultHeight]="60"
      [renderFn]="renderItem"
      (viewportChange)="onViewportChange($event)"
      class="scroll-container">
    </div>
  `,
  styles: [`
    .scroll-container {
      height: 600px;
      overflow: hidden;
    }
  `]
})
export class ExampleComponent {
  items = [/* your data */];

  renderItem = (index: number, element: HTMLElement): number => {
    element.innerHTML = `<div>${this.items[index].title}</div>`;
  };

  onViewportChange(viewport: any): void {
    console.log('Viewport changed:', viewport);
  }
}
```

---

## Advanced Topics

### Custom Height Calculator

Instead of measuring heights in the render function, you can provide a custom calculator:

```typescript
// Pre-calculated heights
const heights = new Map<number, number>();
data.forEach((item, index) => {
  heights.set(index, item.type === 'header' ? 80 : 60);
});

// Set custom calculator
scroller.getElementHeight = (index: number) => {
  return heights.get(index) ?? 40;
};
```

### Dynamic Data Updates

When your data changes:

```typescript
// Update total count
scroller.updateTotalElements(newData.length);

// Force re-render (call the same function you passed as onScroll)
render();
```

### Scroll Position Persistence

Save and restore scroll position:

```typescript
// Save position
const position = {
  element: scroller.currentElement,
  offset: scroller.scrollOffset
};
localStorage.setItem('scrollPos', JSON.stringify(position));

// Restore position
const saved = JSON.parse(localStorage.getItem('scrollPos'));
if (saved) {
  scroller.jumpToElement(saved.element);
}
```

---

## License and Support

**License:** MIT  
**Support:** info@ceriousdevtech.com

---

**Ready to implement?** Working examples are the `*-demo.html` files in the repo root (gallery: `index.html`).
