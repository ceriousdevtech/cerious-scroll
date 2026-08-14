/**
 * Regression test: the renderer must recycle the previous window when the user
 * jumps far away, instead of allocating a fresh set of row elements every jump.
 *
 * Before the fix, the big-jump shortcut in renderViewport() dropped every live
 * row (placement.clear + currentlyRendered.clear) WITHOUT pushing them into the
 * recycle pool, so each far jump leaked the whole window and the rebuild created
 * ~one window of brand-new DOM nodes. Ten far jumps through a 100M-row dataset
 * created 536 elements with a pool of 0. This guards that path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';
import { setupBrowserMocks } from '../helpers/test-helpers.js';

const HUNDRED_MILLION = 100_000_000;

let previousOffsetHeight: PropertyDescriptor | undefined;

function installHeightMock(): void {
  previousOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const index = Number(this.dataset?.elementIndex ?? 0);
      return 24 + (index % 11);
    },
  });
}

function restoreHeightMock(): void {
  if (previousOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', previousOffsetHeight);
  } else {
    delete (HTMLElement.prototype as any).offsetHeight;
  }
}

function createRealContainer(height = 720, width = 1024): HTMLElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: height });
  Object.defineProperty(container, 'offsetHeight', { configurable: true, value: height });
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(container, 'offsetWidth', { configurable: true, value: width });
  document.body.appendChild(container);
  return container;
}

describe('ViewportRenderer far-jump recycling', () => {
  beforeEach(() => {
    setupBrowserMocks();
    installHeightMock();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    restoreHeightMock();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('recycles the previous window across repeated far jumps instead of allocating fresh rows', () => {
    const container = createRealContainer();
    const scroller = new CeriousScroll(container, HUNDRED_MILLION, {
      attachScrollbar: false,
      autoResize: false,
      observeContentChanges: false,
      keyboard: { enabled: false },
      wheel: { enabled: false },
      touch: { enabled: false },
    });

    const renderRow = (index: number, element: HTMLElement): void => {
      element.textContent = `row ${index}`;
    };

    // Each jump is > 100 rows from the last, so it takes the big-jump rebuild path.
    const farJumps = [
      0, 999, 50_000, 1_000_000, 25_000_000, 50_000_000, 75_000_000,
      99_999_500, 1_000, 60_000_000,
    ];

    for (const position of farJumps) {
      scroller.jumpToElement(position);
      scroller.renderViewport(720, container, renderRow);
    }

    const stats = (scroller as any).viewportRenderer.lifecycleStats;
    const windowSize = (scroller as any).viewportRenderer.renderedElementCount;

    // Created elements must stay near a single window, not grow per jump. One
    // window (visible + overscan + up to 50 bottom rows) is well under 180; the
    // unfixed code created 536 here. Reuse must dominate after warm-up, and the
    // pool must retain the salvaged window rather than sitting empty.
    expect(stats.createdTotal).toBeLessThanOrEqual(180);
    expect(stats.reusedTotal).toBeGreaterThan(stats.createdTotal);
    expect(stats.poolSize + windowSize).toBeGreaterThanOrEqual(stats.createdTotal);

    scroller.dispose();
  });

  it('drops already-measured tail sentinel rows after the first render', () => {
    const container = createRealContainer();
    const scroller = new CeriousScroll(container, 10_000, {
      attachScrollbar: false,
      autoResize: false,
      observeContentChanges: false,
      keyboard: { enabled: false },
      wheel: { enabled: false },
      touch: { enabled: false },
    });

    const renderRow = (index: number, element: HTMLElement): void => {
      element.textContent = `row ${index}`;
    };

    scroller.jumpToElement(0);
    scroller.renderViewport(720, container, renderRow);
    const firstCount = (scroller as any).viewportRenderer.renderedElementCount;

    scroller.scroll(40, 720);
    scroller.renderViewport(720, container, renderRow);
    const secondCount = (scroller as any).viewportRenderer.renderedElementCount;

    // First pass may mount tail sentinels to measure true-bottom. After that
    // they must be recycled so the live window is just visible + overscan
    // (~viewport/24 + 10), well under visible+overscan+50.
    expect(secondCount).toBeLessThan(firstCount);
    expect(secondCount).toBeLessThan(60);

    scroller.dispose();
  });
});
