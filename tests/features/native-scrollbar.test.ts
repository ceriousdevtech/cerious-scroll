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

  // The scroll listener now coalesces its map+render onto requestAnimationFrame.
  // Drive that deterministically: queue rAF callbacks and flush them on demand
  // (a flush = one frame boundary). vi.unstubAllGlobals() in afterEach restores.
  const rafCbs: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafCbs.push(cb); return rafCbs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const flushRaf = () => { const cbs = rafCbs.splice(0); cbs.forEach((cb) => cb()); };

  const setPercentage = (p: number) => { percentage = p; };
  // Raw scroll event — does NOT advance a frame (use to test coalescing).
  const fireScroll = () => strip.dispatchEvent(new Event('scroll'));
  // A user drag step that lands in its own frame: move, fire, render.
  const userScrollTo = (top: number) => { (strip as any).scrollTop = top; fireScroll(); flushRaf(); };

  return { sb, container, strip, jumpToPosition, setPercentage, fireScroll, userScrollTo, flushRaf };
}

describe('NativeScrollbar programmatic/user scroll disambiguation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
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

  it('processes every distinct user drag position across frames (no accumulating dead zone)', () => {
    const { jumpToPosition, userScrollTo } = setup();

    // Each userScrollTo lands in its own frame (it flushes the coalescing rAF),
    // so all three positions are processed — no swallowed drags.
    userScrollTo(200);
    userScrollTo(400);
    userScrollTo(600);

    expect(jumpToPosition).toHaveBeenCalledTimes(3);
  });

  it('coalesces multiple scroll events within one frame into a single render', () => {
    const { strip, jumpToPosition, fireScroll, flushRaf } = setup();

    // Three scroll events before the frame boundary (a fast native-scrollbar
    // drag): nothing renders synchronously...
    (strip as any).scrollTop = 200; fireScroll();
    (strip as any).scrollTop = 400; fireScroll();
    (strip as any).scrollTop = 600; fireScroll();
    expect(jumpToPosition).not.toHaveBeenCalled();

    // ...and the single coalesced render lands on the LATEST position only.
    flushRaf();
    expect(jumpToPosition).toHaveBeenCalledTimes(1);
    // 600/910 maxScroll → 65.9% → 0.659 × trueBottom(99) ≈ element 65.
    expect(jumpToPosition.mock.calls[0][0]).toBe(65);
  });

  it('does NOT drop a genuine drag back to a previously-synced scrollTop (stale marker)', () => {
    // Repro of the "drag to the top, eventually not row 0" bug: a programmatic
    // sync records its scrollTop as the echo marker, but a scrollbar DRAG never
    // refreshes that marker (it uses jumpToPosition(skipScrollbarSync)). So after
    // the user drags away and then drags back to the synced value, the return was
    // wrongly suppressed as our own echo — the engine never went back there.
    const { sb, jumpToPosition, setPercentage, fireScroll, userScrollTo } = setup();

    setPercentage(50);
    sb.syncNativeScrollbar(); // writes scrollTop = 455, marker := 455
    fireScroll();             // the echo of that write — correctly ignored
    expect(jumpToPosition).not.toHaveBeenCalled();

    userScrollTo(800);        // user drags away (processed) — invalidates the marker
    jumpToPosition.mockClear();

    userScrollTo(455);        // drags back to the old synced value: MUST be processed
    expect(jumpToPosition).toHaveBeenCalledTimes(1);
  });
});

describe('NativeScrollbar defers engine→scrollbar sync to an active user scroll', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('does NOT write scrollTop while the user is actively scrolling the strip', () => {
    // Repro of the "thumb freezes / bounces when a row is appended mid-drag":
    // a live feed re-anchors the engine and calls syncNativeScrollbar, which
    // would write scrollTop out from under the user's in-progress drag.
    const { sb, strip, setPercentage, userScrollTo } = setup();

    userScrollTo(300);                 // user drags the strip (stamps the marker)
    expect((strip as any).scrollTop).toBe(300);

    setPercentage(90);                 // engine re-anchored elsewhere by the append
    sb.syncNativeScrollbar();          // must defer to the user, not yank to 90%

    expect((strip as any).scrollTop).toBe(300);
  });

  it('resumes syncing once the user-scroll window lapses', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const { sb, strip, setPercentage, userScrollTo } = setup();

    userScrollTo(300);                 // _lastUserScrollTs := 1000

    now.mockReturnValue(1100);         // +100ms: still inside the 150ms window
    setPercentage(90);
    sb.syncNativeScrollbar();
    expect((strip as any).scrollTop).toBe(300); // deferred

    now.mockReturnValue(2000);         // +1s: window lapsed, user has let go
    sb.syncNativeScrollbar();
    expect((strip as any).scrollTop).toBeCloseTo(819, 0); // 90% of maxScroll 910
  });
});

describe('NativeScrollbar gutter reservation', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; });

  function makeScrollbar() {
    return new NativeScrollbar(
      100, () => 0, () => 10, () => {}, null,
      () => 100, () => 0, () => 0, () => ({ element: 99, offset: 0 }),
      10000, undefined
    );
  }

  it('does NOT reserve a gutter with overlay scrollbars (no dead gap)', () => {
    // jsdom does no layout, so the probe measures 0 => overlay scrollbars.
    const sb = makeScrollbar();
    const container = document.createElement('div');
    document.body.appendChild(container);
    sb.createNativeScrollbar(container);
    expect(container.style.paddingRight === '' || container.style.paddingRight === '0px').toBe(true);
  });

  it('reserves a gutter when the platform has classic (fixed-width) scrollbars', () => {
    const sb = makeScrollbar();
    // Force the measured-metrics cache to a classic 17px scrollbar.
    (sb as any)._cachedScrollbarWidth = 17;
    (sb as any)._cachedOverlayScrollbars = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    sb.createNativeScrollbar(container);
    expect(container.style.paddingRight).toBe('19px'); // 17 + 2
  });
});
