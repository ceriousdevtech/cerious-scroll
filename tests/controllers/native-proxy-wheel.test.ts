/**
 * @fileoverview Wheel input drives the same hidden native surface the touch
 * proxy uses, so the BROWSER applies the platform's wheel physics and the
 * engine only consumes the resulting scrollTop deltas. There is no alternative
 * path to select — a JavaScript easing fallback survives only for a host the
 * surface cannot attach to, which the engine now prevents.
 *
 * jsdom has no wheel physics and no native scrolling, which is fine: what has to
 * hold here is the plumbing. The vertical axis must be left alone so there is
 * something for the browser to scroll, the surface must accept wheel-driven
 * scrolls as real input, and it must still reject the browser adjustments the
 * touch gate exists to reject.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NativeTouchController } from '../../src/controllers/native-touch-controller.js';
import { WheelController } from '../../src/controllers/wheel-controller.js';
import { CeriousScroll } from '../../src/cerious-scroll.js';
import { waitForAnimationFrame } from '../helpers/test-helpers.js';

function surfaceFixture(acceptWheel: boolean) {
  const host = document.createElement('div');
  const content = document.createElement('div');
  content.setAttribute('data-cerious-scroll-content', '');
  host.appendChild(content);
  document.body.appendChild(host);
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 600 });

  let scrollOffset = 0;
  const scroll = vi.fn((delta: number) => {
    scrollOffset += delta;
    return { element: 10, offset: scrollOffset };
  });
  const controller = new NativeTouchController({
    scroll,
    calculateScrollPercentage: () => 50,
    getCurrentElement: () => 10,
    getScrollOffset: () => scrollOffset,
  });
  const cleanup = controller.attach(host, vi.fn(), undefined, { acceptWheel });
  const proxy = host.querySelector<HTMLElement>('[data-cerious-native-touch-proxy]')!;
  Object.defineProperty(proxy, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(proxy, 'scrollHeight', { configurable: true, value: 2_000_600 });
  controller.syncPosition();
  return { host, content, proxy, controller, scroll, cleanup };
}

/** A wheel gesture: the signal event, then the native scroll it causes. */
async function wheelScroll(proxy: HTMLElement, distance: number): Promise<void> {
  proxy.dispatchEvent(new WheelEvent('wheel', { deltaY: distance, bubbles: true }));
  proxy.scrollTop = proxy.scrollTop + distance;
  proxy.dispatchEvent(new Event('scroll'));
  await waitForAnimationFrame();
}

function listFixture() {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  document.body.appendChild(host);
  const content = document.createElement('div');
  content.setAttribute('data-cerious-scroll-content', '');
  host.appendChild(content);
  const s = new CeriousScroll(host, 5000, { attachScrollbar: false });
  return { host, content, s };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('native-surface wheel input', () => {
  it('leaves the vertical axis for the browser to scroll', () => {
    // The whole mode rests on this: preventDefault here would cancel the native
    // scroll, and there would be nothing left for the surface to forward.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wheel = new WheelController({
      scroll: vi.fn(() => ({ element: 0, offset: 0 })),
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    const cleanup = wheel.attach(host, undefined, {}, true);

    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    cleanup();
  });

  it('does not run its own smoothing when the surface is present', () => {
    const scroll = vi.fn(() => ({ element: 0, offset: 0 }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wheel = new WheelController({
      scroll,
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    const cleanup = wheel.attach(host, undefined, {}, true);

    host.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, cancelable: true }));
    // The engine hears nothing from the wheel controller: the surface is the
    // only thing that reports movement in this mode.
    expect(scroll).not.toHaveBeenCalled();
    cleanup();
  });

  it('still forwards a horizontal-dominant gesture by hand', () => {
    // The proxy is overflow-x: hidden and the scrollable element is inside it,
    // so sideways input has no native target and must still be forwarded.
    const host = document.createElement('div');
    const content = document.createElement('div');
    content.setAttribute('data-cerious-scroll-content', '');
    host.appendChild(content);
    document.body.appendChild(host);
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 3000 });
    Object.defineProperty(content, 'clientWidth', { configurable: true, value: 600 });

    const wheel = new WheelController({
      scroll: vi.fn(() => ({ element: 0, offset: 0 })),
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    const cleanup = wheel.attach(host, undefined, {}, true);

    const sideways = new WheelEvent('wheel', { deltaX: 90, deltaY: 4, cancelable: true });
    host.dispatchEvent(sideways);
    expect(content.scrollLeft).toBe(90);
    expect(sideways.defaultPrevented).toBe(true);
    cleanup();
  });

  it('lets a diagonal gesture keep its vertical component', () => {
    const host = document.createElement('div');
    const content = document.createElement('div');
    content.setAttribute('data-cerious-scroll-content', '');
    host.appendChild(content);
    document.body.appendChild(host);
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 3000 });
    Object.defineProperty(content, 'clientWidth', { configurable: true, value: 600 });

    const wheel = new WheelController({
      scroll: vi.fn(() => ({ element: 0, offset: 0 })),
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    const cleanup = wheel.attach(host, undefined, {}, true);

    // More vertical than horizontal: the sideways part is applied, but the
    // event is NOT claimed, so the proxy still scrolls.
    const diagonal = new WheelEvent('wheel', { deltaX: 12, deltaY: 80, cancelable: true });
    host.dispatchEvent(diagonal);
    expect(content.scrollLeft).toBe(12);
    expect(diagonal.defaultPrevented).toBe(false);
    cleanup();
  });

  it('forwards a wheel-driven native scroll to the engine', async () => {
    const { proxy, scroll, cleanup } = surfaceFixture(true);
    await wheelScroll(proxy, 150);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0][0]).toBe(150);
    cleanup();
  });

  it('ignores wheel-driven scrolls when the surface was not given the wheel', async () => {
    // Touch-only attachment must behave exactly as before: an unowned scroll is
    // a browser adjustment, and gets rebased rather than forwarded.
    const { proxy, scroll, cleanup } = surfaceFixture(false);
    await wheelScroll(proxy, 150);
    expect(scroll).not.toHaveBeenCalled();
    cleanup();
  });

  it('still rejects an unowned scroll while accepting the wheel', async () => {
    // The gate that keeps scroll anchoring and scrollIntoView out must survive
    // the new driver: a scroll with no wheel event in front of it is not input.
    const { proxy, scroll, cleanup } = surfaceFixture(true);
    proxy.scrollTop = proxy.scrollTop + 240;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();
    expect(scroll).not.toHaveBeenCalled();
    cleanup();
  });

  it('contains overscroll so a virtual boundary cannot chain to the page', () => {
    const { proxy, cleanup } = surfaceFixture(true);
    expect(proxy.style.overscrollBehavior).toBe('contain');
    cleanup();
  });

  it('mounts the surface for the wheel even when touch is switched off', () => {
    // Desktop hosts routinely disable touch. Without the union the option would
    // silently do nothing there, which is the worst possible failure for a mode
    // that exists to be A/B tested.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    const content = document.createElement('div');
    content.setAttribute('data-cerious-scroll-content', '');
    host.appendChild(content);
    document.body.appendChild(host);

    const s = new CeriousScroll(host, 5000, {
      attachScrollbar: false,
      touch: { enabled: false },
      wheel: { mode: 'native-proxy' },
    });
    expect(host.querySelector('[data-cerious-native-touch-proxy]')).not.toBeNull();
    s.dispose();
  });

  it('is the default where the surface can exist', () => {
    const { host, s } = listFixture();
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    // Unclaimed: the browser scrolls the surface and the engine follows it.
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-cerious-native-touch-proxy]')).not.toBeNull();
    s.dispose();
  });

  it('applies to a bare host, by building the content element it lacks', () => {
    // The plain case — `new CeriousScroll(div, n)` — is the one most likely to
    // exist in the wild, and a default that skipped it would be a default in
    // name only.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    document.body.appendChild(host);
    const s = new CeriousScroll(host, 5000, { attachScrollbar: false });

    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-cerious-native-touch-proxy]')).not.toBeNull();
    s.dispose();
  });

  it('renders rows INTO the element it built, not beside it', () => {
    // The surface holds the content element still while it scrolls beneath.
    // A row left outside would simply not move, so the redirect is what makes
    // the auto-created element correct rather than merely present.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    document.body.appendChild(host);
    const s = new CeriousScroll(host, 5000, { attachScrollbar: false });

    // The caller hands us the HOST, as the documented quick-start does.
    s.renderViewport(600, host, (i, el) => { el.textContent = String(i); });

    const rows = host.querySelectorAll('[data-element-index]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.closest('[data-cerious-native-touch-proxy]')).not.toBeNull();
      expect(row.closest('[data-cerious-scroll-content]')).not.toBeNull();
    }
    s.dispose();
  });

  it('leaves a host that names its own render target alone', () => {
    // Passing something other than the host is a specific instruction, and the
    // redirect must not second-guess it.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    const own = document.createElement('div');
    own.setAttribute('data-cerious-scroll-content', '');
    const inner = document.createElement('div');
    own.appendChild(inner);
    host.appendChild(own);
    document.body.appendChild(host);

    const s = new CeriousScroll(host, 5000, { attachScrollbar: false });
    s.renderViewport(600, inner, (i, el) => { el.textContent = String(i); });

    expect(inner.querySelectorAll('[data-element-index]').length).toBeGreaterThan(0);
    s.dispose();
  });

  it('wraps a NESTED content element, so a host may nest one', () => {
    // A horizontal-scroll wrapper around a wide grid is a legitimate structure,
    // and it used to cost the host native scrolling silently.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    const wrapper = document.createElement('div');
    const content = document.createElement('div');
    content.setAttribute('data-cerious-scroll-content', '');
    wrapper.appendChild(content);
    host.appendChild(wrapper);
    document.body.appendChild(host);

    const s = new CeriousScroll(host, 5000, { attachScrollbar: false });
    const proxy = host.querySelector('[data-cerious-native-touch-proxy]');
    expect(proxy).not.toBeNull();

    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    // The surface wraps the host's own child, not the content element buried
    // inside it, so the wrapper keeps its place in the tree.
    expect(proxy!.parentElement).toBe(host);
    expect(wrapper.closest('[data-cerious-native-touch-proxy]')).toBe(proxy);
    // And the host's element is never restyled — an element that sizes itself
    // by being positioned would collapse if the surface rewrote `position`.
    expect(wrapper.style.position).toBe('');
    s.dispose();
    expect(wrapper.parentElement).toBe(host);
  });

  it('exposes no way to select a different path', () => {
    // The point of removing the option: there is one behaviour, so there is
    // nothing to configure, get wrong, or drift between hosts.
    const { host, s } = listFixture();
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect((s as unknown as { options: { wheel?: Record<string, unknown> } }).options.wheel?.mode)
      .toBeUndefined();
    s.dispose();
  });

  it('keeps a working fallback for a container with no surface around it', () => {
    // Unreachable through the engine, which builds the element the surface
    // needs — but the alternative to keeping it is a container that does not
    // scroll at all, which is a far worse failure than an approximated curve.
    const scroll = vi.fn(() => ({ element: 0, offset: 0 }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wheel = new WheelController({
      scroll,
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    const cleanup = wheel.attach(host, undefined, {}, false);

    const event = new WheelEvent('wheel', { deltaY: 600, cancelable: true, bubbles: true });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalled();
    cleanup();
  });

  it('restores the DOM on dispose', () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
    const content = document.createElement('div');
    content.setAttribute('data-cerious-scroll-content', '');
    host.appendChild(content);
    document.body.appendChild(host);

    const s = new CeriousScroll(host, 5000, {
      attachScrollbar: false,
      touch: { enabled: false },
      wheel: { mode: 'native-proxy' },
    });
    s.dispose();
    expect(host.querySelector('[data-cerious-native-touch-proxy]')).toBeNull();
    expect(content.parentElement).toBe(host);
  });
});
