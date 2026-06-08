/**
 * @fileoverview Test Helpers and Utilities for CeriousScroll Tests
 * 
 * Provides reusable test fixtures, mocks, and utilities for comprehensive testing.
 */

import { vi } from 'vitest';

/**
 * Create a mock HTMLElement for testing
 */
export function createMockElement(overrides: Partial<HTMLElement> = {}): HTMLElement {
  const element = {
    clientHeight: 600,
    clientWidth: 800,
    offsetHeight: 600,
    offsetWidth: 800,
    scrollTop: 0,
    scrollHeight: 1000,
    style: {} as CSSStyleDeclaration,
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      contains: vi.fn(() => false),
      toggle: vi.fn(),
    },
    getAttribute: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    hasAttribute: vi.fn(() => false),
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    dataset: {} as DOMStringMap,
    parentElement: null,
    closest: vi.fn(() => null),
    ...overrides,
  } as unknown as HTMLElement;

  // Mock style object with proper getters/setters
  element.style = new Proxy({} as CSSStyleDeclaration, {
    get: (target: any, prop: string) => target[prop] || '',
    set: (target: any, prop: string, value: any) => {
      target[prop] = value;
      return true;
    },
  });

  return element;
}

/**
 * Create a mock container for testing virtual scrolling
 */
export function createMockContainer(
  height: number = 600,
  width: number = 800
): HTMLElement {
  return createMockElement({
    clientHeight: height,
    clientWidth: width,
    offsetHeight: height,
    offsetWidth: width,
  });
}

/**
 * Create mock element height data for testing
 */
export function createElementHeights(
  count: number,
  defaultHeight: number = 50,
  variableHeights?: Record<number, number>
): number[] {
  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    heights[i] = variableHeights?.[i] ?? defaultHeight;
  }
  return heights;
}

/**
 * Create a mock element height calculator
 */
export function createMockHeightCalculator(
  heights: number[]
): (index: number) => number {
  return (index: number) => {
    if (index < 0 || index >= heights.length) {
      return heights[0] ?? 50;
    }
    return heights[index];
  };
}

/**
 * Simulate DOM measurements
 */
export class MockDOMEnvironment {
  private heights = new Map<number, number>();
  private defaultHeight: number;

  constructor(defaultHeight: number = 50) {
    this.defaultHeight = defaultHeight;
  }

  setElementHeight(index: number, height: number): void {
    this.heights.set(index, height);
  }

  getElementHeight(index: number): number {
    return this.heights.get(index) ?? this.defaultHeight;
  }

  clearHeights(): void {
    this.heights.clear();
  }

  mockRenderedElement(index: number, height?: number): HTMLElement {
    const element = createMockElement({
      offsetHeight: height ?? this.getElementHeight(index),
    });
    element.dataset.elementIndex = String(index);
    return element;
  }
}

/**
 * Wait for async operations to complete
 */
export function waitForAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for requestAnimationFrame
 */
export function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Create a spy for scroll events
 */
export function createScrollSpy() {
  return {
    onScroll: vi.fn(),
    onViewportChange: vi.fn(),
    reset: function() {
      this.onScroll.mockClear();
      this.onViewportChange.mockClear();
    }
  };
}

/**
 * Assert scroll position
 */
export function assertScrollPosition(
  result: { element: number; offset: number },
  expectedElement: number,
  expectedOffset: number,
  message?: string
) {
  const actualMessage = message || `Expected element ${expectedElement}, offset ${expectedOffset}`;
  
  if (result.element !== expectedElement || result.offset !== expectedOffset) {
    throw new Error(
      `${actualMessage} but got element ${result.element}, offset ${result.offset}`
    );
  }
}

/**
 * Create mock wheel event
 */
export function createMockWheelEvent(deltaY: number): WheelEvent {
  return {
    deltaY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    type: 'wheel',
  } as unknown as WheelEvent;
}

/**
 * A trackpad-shaped wheel event: pixel delta mode with a small per-event delta,
 * which the WheelController classifies as a trackpad (continuous, inertial) so
 * its smooth-easing path runs. Discrete mouse-wheel notches (large integer px or
 * line mode) bypass smoothing and apply instantly.
 */
export function createMockTrackpadWheelEvent(deltaY: number): WheelEvent {
  return {
    deltaY,
    deltaX: 0,
    deltaMode: 0, // DOM_DELTA_PIXEL
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    type: 'wheel',
  } as unknown as WheelEvent;
}

/**
 * Create mock touch event
 */
export function createMockTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Array<{ identifier: number; clientY: number; clientX?: number }>
): TouchEvent {
  return {
    type,
    touches: touches.map(t => ({
      identifier: t.identifier,
      clientY: t.clientY,
      clientX: t.clientX ?? 0,
    })),
    changedTouches: touches.map(t => ({
      identifier: t.identifier,
      clientY: t.clientY,
      clientX: t.clientX ?? 0,
    })),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    cancelable: true,
    target: null,
  } as unknown as TouchEvent;
}

/**
 * Create mock keyboard event
 */
export function createMockKeyboardEvent(key: string): KeyboardEvent {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    type: 'keydown',
  } as unknown as KeyboardEvent;
}

/**
 * Measure test execution time
 */
export class PerformanceTimer {
  private startTime: number = 0;

  start(): void {
    this.startTime = performance.now();
  }

  end(): number {
    return performance.now() - this.startTime;
  }

  static measure(fn: () => void): number {
    const timer = new PerformanceTimer();
    timer.start();
    fn();
    return timer.end();
  }

  static async measureAsync(fn: () => Promise<void>): Promise<number> {
    const timer = new PerformanceTimer();
    timer.start();
    await fn();
    return timer.end();
  }
}

/**
 * Generate large dataset for performance testing
 */
export function generateLargeDataset(size: number): Array<{ id: number; content: string }> {
  return Array.from({ length: size }, (_, i) => ({
    id: i,
    content: `Item ${i} - ${Math.random().toString(36).substring(7)}`,
  }));
}

/**
 * Mock ResizeObserver for tests
 */
export function mockResizeObserver() {
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as any;
}

/**
 * Mock IntersectionObserver for tests
 */
export function mockIntersectionObserver() {
  global.IntersectionObserver = class IntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as any;
}

/**
 * Setup common browser APIs for tests
 */
export function setupBrowserMocks() {
  mockResizeObserver();
  mockIntersectionObserver();
  
  // Mock requestAnimationFrame
  global.requestAnimationFrame = vi.fn((callback) => {
    setTimeout(callback, 16);
    return 1;
  });
  
  global.cancelAnimationFrame = vi.fn();
}
