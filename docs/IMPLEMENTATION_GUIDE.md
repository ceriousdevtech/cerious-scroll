# CeriousScroll Implementation Guide

**Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.**  
**PATENT PENDING - Patent Filed by Jared Kirchgatter, October 2025**

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Basic Setup](#basic-setup)
4. [Configuration Options](#configuration-options)
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

Here's the minimal code to get CeriousScroll running:

```typescript
import { CeriousScroll } from '@ceriousdevtech/cerious-scroll';

// Your data
const data = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  content: `Item ${i}`
}));

// Get your container element
const container = document.getElementById('scroll-container')!;

// Create the scroller
const scroller = new CeriousScroll(
  container,           // Container element
  data.length          // Total number of items
);

// Render on scroll
container.addEventListener('cerious-viewport-change', () => {
  const viewport = scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      // Render your content
      element.innerHTML = `
        <div class="item">
          <h3>Item ${data[index].id}</h3>
          <p>${data[index].content}</p>
        </div>
      `;
      // Return the measured height
      return element.offsetHeight;
    }
  );
});

// Initial render
container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
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
yarn add cerious-scroll
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
const defaultHeight = 40; // Optional, default is 40px

const scroller = new CeriousScroll(container, totalItems, defaultHeight);
```

### Step 3: Implement the Render Function

```typescript
container.addEventListener('cerious-viewport-change', () => {
  const viewport = scroller.renderViewport(
    container.clientHeight,
    container,
    (index, element) => {
      // Render logic here
      element.innerHTML = `<div class="item">${data[index].content}</div>`;
      
      // IMPORTANT: Return the measured height
      return element.offsetHeight;
    }
  );
  
  // Optional: Use viewport info
  console.log('Visible range:', viewport.startElement, '-', viewport.endElement);
});
```

### Step 4: Trigger Initial Render

```typescript
// Dispatch the event to render the initial viewport
container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
```

---

## Configuration Options

CeriousScroll accepts an optional configuration object as the 4th parameter:

```typescript
const scroller = new CeriousScroll(
  container,
  totalItems,
  defaultHeight,
  {
    // Keyboard navigation
    keyboard: {
      enabled: true,               // Enable/disable keyboard navigation
      arrowKeySpeed: 120,          // Pixels per arrow key press
      pageKeySpeed: 1.0,           // Viewport fraction per page key
      onKeyDown: (event, scroller) => {
        // Custom keyboard handling
        if (event.key === 'Home') {
          scroller.scrollToElement(0);
          return true; // Prevent default
        }
        return false; // Use default behavior
      }
    },
    
    // Touch navigation
    touch: {
      enabled: true,               // Enable/disable touch navigation
      enableMomentum: true,        // Enable momentum/inertia scrolling
      momentumFriction: 0.95,      // Friction coefficient (0-1)
      momentumThreshold: 0.1       // Min velocity to trigger momentum (px/ms)
    },
    
    // Wheel navigation
    wheel: {
      enabled: true,                      // Enable/disable wheel navigation
      emitViewportChangeEvent: true,      // Emit custom event on scroll
      coalesceViewportChangeEvent: false  // Batch multiple wheel events
    },
    
    // Features
    attachScrollbar: true,          // Auto-attach native scrollbar
    autoResize: true,               // Auto-handle container resize
    observeContentChanges: true,    // Auto-detect content height changes
    
    // Callback
    onScroll: () => {
      console.log('Scrolled to:', scroller.currentElement);
    }
  }
);
```

---

## Rendering Patterns

### Pattern 1: Simple Text Rendering

```typescript
scroller.renderViewport(
  container.clientHeight,
  container,
  (index, element) => {
    element.textContent = `Item ${index}`;
    return element.offsetHeight;
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
    return element.offsetHeight;
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
    return element.offsetHeight;
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
    return element.offsetHeight;
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
    
    // Height is measured automatically
    return element.offsetHeight;
  }
);
```

---

## Navigation Methods

### Scroll to Specific Element

```typescript
// Scroll to element at index 500
scroller.scrollToElement(500);

// Scroll to element with specific offset
scroller.scrollToElement(500, 20); // 20px offset into element
```

### Scroll by Delta

```typescript
// Scroll down by 100 pixels
scroller.scroll(100, container.clientHeight);

// Scroll up by 100 pixels
scroller.scroll(-100, container.clientHeight);
```

### Get Current Position

```typescript
const position = scroller.getCurrentPosition();
console.log('Current element:', position.element);
console.log('Offset:', position.offset);
console.log('Scroll percentage:', position.scrollPercentage);
```

### Get Visible Range

```typescript
const viewport = scroller.measureViewportRange(container.clientHeight);
console.log('Start:', viewport.startElement);
console.log('End:', viewport.endElement);
console.log('Visible elements:', viewport.endElement - viewport.startElement);
```

---

## Event Handling

### Viewport Change Event

Emitted whenever the visible viewport changes:

```typescript
container.addEventListener('cerious-viewport-change', (event: CustomEvent) => {
  const { startElement, endElement, scrollPercentage } = event.detail;
  
  console.log(`Showing elements ${startElement} to ${endElement}`);
  console.log(`Scroll progress: ${(scrollPercentage * 100).toFixed(1)}%`);
  
  // Re-render viewport
  scroller.renderViewport(container.clientHeight, container, renderFunction);
});
```

### Scroll Callback

Set a callback in the options:

```typescript
const scroller = new CeriousScroll(container, totalItems, 40, {
  onScroll: () => {
    updateScrollIndicator(scroller.scrollPercentage);
    updateVisibleCount(scroller.endElement - scroller.startElement);
  }
});
```

### Custom Keyboard Handling

```typescript
const scroller = new CeriousScroll(container, totalItems, 40, {
  keyboard: {
    onKeyDown: (event, scroller) => {
      if (event.key === 'Home') {
        scroller.scrollToElement(0);
        return true; // Handled
      }
      if (event.key === 'End') {
        scroller.scrollToElement(totalItems - 1);
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
  return element.offsetHeight;
}
```

**✅ Good:**
```typescript
// Pre-process data once
const processedData = data.map(item => expensiveOperation(item));

(index, element) => {
  element.innerHTML = processedData[index];
  return element.offsetHeight;
}
```

### 2. Minimize DOM Access

**❌ Bad:**
```typescript
(index, element) => {
  element.innerHTML = `<div>${data[index].title}</div>`;
  element.querySelector('div')!.style.color = 'red'; // Extra DOM access
  return element.offsetHeight;
}
```

**✅ Good:**
```typescript
(index, element) => {
  element.innerHTML = `<div style="color: red;">${data[index].title}</div>`;
  return element.offsetHeight;
}
```

### 3. Use Event Coalescing for Heavy Updates

```typescript
const scroller = new CeriousScroll(container, totalItems, 40, {
  wheel: {
    coalesceViewportChangeEvent: true // Batch wheel events
  }
});
```

### 4. Disable Unused Features

```typescript
const scroller = new CeriousScroll(container, totalItems, 40, {
  keyboard: { enabled: false },  // If no keyboard navigation needed
  touch: { enabled: false },     // If desktop-only
  observeContentChanges: false   // If heights are truly static
});
```

### 5. Clean Up When Done

```typescript
// When removing the scroller
scroller.destroy();
```

---

## Common Use Cases

### Use Case 1: Data Grid

```typescript
const columns = ['ID', 'Name', 'Email', 'Status', 'Actions'];
const rows = 100000;

const scroller = new CeriousScroll(container, rows, 40);

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
    return element.offsetHeight;
  });
});
```

### Use Case 2: Chat Messages

```typescript
const messages = loadMessages(); // Array of message objects

const scroller = new CeriousScroll(container, messages.length, 60);

// Scroll to bottom (most recent message)
scroller.scrollToElement(messages.length - 1);

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
    return element.offsetHeight;
  });
});
```

### Use Case 3: Log Viewer

```typescript
const logs = loadLogs(); // Array of log entries

const scroller = new CeriousScroll(container, logs.length, 24);

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
    return element.offsetHeight;
  });
});
```

### Use Case 4: E-commerce Product List

```typescript
const products = loadProducts(); // Array of products

const scroller = new CeriousScroll(container, products.length, 300);

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
    return element.offsetHeight;
  });
});
```

### Use Case 5: Financial Trading Dashboard

```typescript
const trades = loadTrades(); // Array of trade data

const scroller = new CeriousScroll(container, trades.length, 50);

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
    return element.offsetHeight;
  });
});
```

---

## Troubleshooting

### Issue: Nothing Renders

**Cause:** Forgot to trigger initial viewport change event.

**Solution:**
```typescript
// After setup, dispatch the event
container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
```

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

**Cause:** Not returning the measured height from render function.

**Solution:**
```typescript
scroller.renderViewport(container.clientHeight, container, (index, element) => {
  element.innerHTML = content;
  return element.offsetHeight; // Must return this!
});
```

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
  return element.offsetHeight;
}
```

### Issue: Scrollbar Not Appearing

**Cause:** `attachScrollbar` option disabled.

**Solution:**
```typescript
const scroller = new CeriousScroll(container, totalItems, 40, {
  attachScrollbar: true // Enable scrollbar
});
```

### Issue: Memory Leaks

**Cause:** Not calling `destroy()` when removing scroller.

**Solution:**
```typescript
// When done with scroller
scroller.destroy();
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
  return element.offsetHeight;
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
      60,
      {
        keyboard: { enabled: true },
        touch: { enabled: true },
        onScroll: () => {
          console.log('Scrolled to:', scroller?.currentElement);
        }
      }
    );

    // Listen for viewport changes
    containerRef.value.addEventListener('cerious-viewport-change', handleViewportChange);
    
    // Initial render
    containerRef.value.dispatchEvent(new CustomEvent('cerious-viewport-change'));
  }
});

onBeforeUnmount(() => {
  // Cleanup
  if (containerRef.value) {
    containerRef.value.removeEventListener('cerious-viewport-change', handleViewportChange);
  }
  scroller?.destroy();
});

// Expose methods for parent components
defineExpose({
  scrollToElement: (index: number) => scroller?.scrollToElement(index),
  getCurrentPosition: () => scroller?.getCurrentPosition()
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
    
    this.scroller = new CeriousScroll(
      container,
      this.items.length,
      60
    );

    container.addEventListener('cerious-viewport-change', this.handleViewportChange);
    container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
  },
  beforeUnmount() {
    const container = this.$refs.container as HTMLElement;
    container.removeEventListener('cerious-viewport-change', this.handleViewportChange);
    this.scroller?.destroy();
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
            return element.offsetHeight;
          }
        );
      }
    },
    scrollToElement(index: number) {
      this.scroller?.scrollToElement(index);
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

  const init = (renderFn: (index: number, element: HTMLElement) => number) => {
    if (!containerRef.value) return;

    scroller = new CeriousScroll(
      containerRef.value,
      items.value.length,
      defaultHeight,
      options
    );

    const handleViewportChange = () => {
      if (scroller && containerRef.value) {
        scroller.renderViewport(
          containerRef.value.clientHeight,
          containerRef.value,
          renderFn
        );
      }
    };

    containerRef.value.addEventListener('cerious-viewport-change', handleViewportChange);
    containerRef.value.dispatchEvent(new CustomEvent('cerious-viewport-change'));
  };

  const scrollToElement = (index: number, offset: number = 0) => {
    scroller?.scrollToElement(index, offset);
  };

  const getCurrentPosition = () => {
    return scroller?.getCurrentPosition();
  };

  const updateItems = (newItems: T[]) => {
    scroller?.updateTotalElements(newItems.length);
    containerRef.value?.dispatchEvent(new CustomEvent('cerious-viewport-change'));
  };

  onBeforeUnmount(() => {
    scroller?.destroy();
  });

  return {
    containerRef,
    init,
    scrollToElement,
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
    return element.offsetHeight;
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
  private viewportChangeHandler?: () => void;

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
      this.defaultHeight,
      {
        ...this.options,
        onScroll: () => {
          if (this.scroller) {
            this.scrollPositionChange.emit(this.scroller.currentElement);
          }
        }
      }
    );

    this.viewportChangeHandler = () => this.handleViewportChange();
    container.addEventListener('cerious-viewport-change', this.viewportChangeHandler);
    
    // Initial render
    container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
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
        return element.offsetHeight;
      }
    );

    this.viewportChange.emit({
      start: viewport.startElement,
      end: viewport.endElement
    });
  }

  private cleanup(): void {
    if (this.viewportChangeHandler) {
      const container = this.containerRef.nativeElement;
      container.removeEventListener('cerious-viewport-change', this.viewportChangeHandler);
    }
    this.scroller?.destroy();
  }

  // Public methods for parent components
  scrollToElement(index: number, offset: number = 0): void {
    this.scroller?.scrollToElement(index, offset);
  }

  getCurrentPosition() {
    return this.scroller?.getCurrentPosition();
  }

  updateItems(items: VirtualScrollItem[]): void {
    this.items = items;
    this.scroller?.updateTotalElements(items.length);
    const container = this.containerRef.nativeElement;
    container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
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
    const scroller = new CeriousScroll(container, totalItems, defaultHeight, options);
    this.scrollers.set(id, scroller);
    return scroller;
  }

  getScroller(id: string): CeriousScroll | undefined {
    return this.scrollers.get(id);
  }

  destroyScroller(id: string): void {
    const scroller = this.scrollers.get(id);
    if (scroller) {
      scroller.destroy();
      this.scrollers.delete(id);
    }
  }

  destroyAll(): void {
    this.scrollers.forEach(scroller => scroller.destroy());
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
  @Input() renderFn!: (index: number, element: HTMLElement) => number;

  @Output() viewportChange = new EventEmitter<any>();

  private scroller?: CeriousScroll;
  private viewportHandler?: () => void;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    const container = this.el.nativeElement;

    this.scroller = new CeriousScroll(
      container,
      this.totalItems,
      this.defaultHeight,
      this.scrollOptions
    );

    this.viewportHandler = () => {
      if (this.scroller && this.renderFn) {
        const viewport = this.scroller.renderViewport(
          container.clientHeight,
          container,
          this.renderFn
        );
        this.viewportChange.emit(viewport);
      }
    };

    container.addEventListener('cerious-viewport-change', this.viewportHandler);
    container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
  }

  ngOnDestroy(): void {
    if (this.viewportHandler) {
      this.el.nativeElement.removeEventListener('cerious-viewport-change', this.viewportHandler);
    }
    this.scroller?.destroy();
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
    return element.offsetHeight;
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

// Force re-render
container.dispatchEvent(new CustomEvent('cerious-viewport-change'));
```

### Scroll Position Persistence

Save and restore scroll position:

```typescript
// Save position
const position = scroller.getCurrentPosition();
localStorage.setItem('scrollPos', JSON.stringify(position));

// Restore position
const saved = JSON.parse(localStorage.getItem('scrollPos'));
if (saved) {
  scroller.scrollToElement(saved.element, saved.offset);
}
```

---

## License and Support

**License:** Dual-licensed under MIT or Commercial License  
**Patent:** Patent Pending (Filed October 2025 by Jared Kirchgatter)  
**Support:** info@ceriousdevtech.com

For commercial licensing inquiries, see [LICENSE-COMMERCIAL](../LICENSE-COMMERCIAL).

---

**Ready to implement?** Check out the [demo files](../demo/) for complete working examples!
