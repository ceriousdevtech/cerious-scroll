/**
 * @fileoverview Unit tests for NativeScrollbar programmatic/user scroll disambiguation.
 *
 * Regression coverage for the "wheel-then-drag dead zone": rapid programmatic
 * scrollTop writes (one per wheel animation frame) get coalesced by the browser
 * into fewer `scroll` events. The previous counter-based echo accounting then
 * leaked a positive residual that swallowed the user's subsequent real drags,
 * so row positions stopped updating until enough drag events drained it. The
 * fix recognises an echo by matching the live scrollTop against the last value
 * we wrote, which carries no residual.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NativeScrollbar } from '../../src/features/native-scrollbar.js';
import type { NavigationEngine } from '../../src/engine/navigation-engine.js';

/**
 * Build a NativeScrollbar wired to stubs, attach it to a fresh container, and
 * give the scrollbar strip a real, programmable scroll geometry (jsdom does no
 * layout, so scrollTop/scrollHeight/clientHeight must be backed by hand).
 */
function setup() {
  let percentage = 0;

  const jumpToPosition = vi.fn((element: number, offset: number) => ({ element, offset }));
  const handlers = { jumpToPosition } as unknown as NavigationEngine;

  const sb = new NativeScrollbar(
    100,                       // totalElements
    () => percentage,          // getScrollPercentage
    () => 10,                  // getElementHeight (uniform)
    () => {},                  // onScrollPositionChange
    null,                      // scrollHandlers (injected below)
    () => 100,                 // getViewportHeight
    () => 0,                   // getCurrentElement (always 0 so any target differs)
    () => 0,                   // getScrollOffset
    () => ({ element: 99, offset: 0 }), // getTrueBottomPosition
    10000,
    undefined
  );
  sb.setScrollHandlers(handlers);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const strip = sb.createNativeScrollbar(container);

  // Give the strip a programmable scroll geometry. maxScroll = 1010 - 100 = 910.
  let scrollTop = 0;
  Object.defineProperty(strip, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => { scrollTop = v; },
  });
  Object.defineProperty(strip, 'scrollHeight', { configurable: true, get: () => 1010 });
  Object.defineProperty(strip, 'clientHeight', { configurable: true, get: () => 100 });

  const setPercentage = (p: number) => { percentage = p; };
  const fireScroll = () => strip.dispatchEvent(new Event('scroll'));
  const userScrollTo = (top: number) => { (strip as any).scrollTop = top; fireScroll(); };

  return { sb, container, strip, jumpToPosition, setPercentage, fireScroll, userScrollTo };
}

describe('NativeScrollbar programmatic/user scroll disambiguation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('ignores the echo scroll event of its own programmatic write', () => {
    const { sb, jumpToPosition, setPercentage, fireScroll } = setup();

    setPercentage(50);
    sb.syncNativeScrollbar(); // writes scrollTop = 455, records the marker

    // The browser fires the echo for that write; scrollTop still reads 455.
    fireScroll();

    expect(jumpToPosition).not.toHaveBeenCalled();
  });

  it('registers a user drag even after many coalesced programmatic writes', () => {
    const { sb, jumpToPosition, setPercentage, fireScroll, userScrollTo } = setup();

    // Simulate a wheel gesture: several programmatic syncs (one per frame),
    // each moving the strip a little further down.
    for (const p of [40, 50, 60, 70]) {
      setPercentage(p);
      sb.syncNativeScrollbar();
    }

    // The browser coalesces those four writes into a single echo scroll event.
    // (The old counter approach would be left with a residual of 3 here.)
    fireScroll();
    expect(jumpToPosition).not.toHaveBeenCalled();

    // Now the user grabs the strip and drags it to a new position. This MUST be
    // processed — the regression was that the residual swallowed it.
    userScrollTo(800);

    expect(jumpToPosition).toHaveBeenCalledTimes(1);
  });

  it('processes every distinct user drag position (no accumulating dead zone)', () => {
    const { jumpToPosition, userScrollTo } = setup();

    userScrollTo(200);
    userScrollTo(400);
    userScrollTo(600);

    expect(jumpToPosition).toHaveBeenCalledTimes(3);
  });
});
