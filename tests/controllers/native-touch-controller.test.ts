import { describe, it, expect, vi } from 'vitest';
import { NativeTouchController } from '../../src/controllers/native-touch-controller.js';
import { waitForAnimationFrame } from '../helpers/test-helpers.js';

function fixture(percentage = 50) {
  const host = document.createElement('div');
  const content = document.createElement('div');
  const button = document.createElement('button');
  content.setAttribute('data-cerious-scroll-content', '');
  content.appendChild(button);
  host.appendChild(content);
  document.body.appendChild(host);
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 600 });

  let scrollOffset = 0;
  const scroll = vi.fn((delta: number) => {
    scrollOffset += delta;
    return { element: percentage === 0 ? 0 : 10, offset: scrollOffset };
  });
  const controller = new NativeTouchController({
    scroll,
    calculateScrollPercentage: () => percentage,
    getCurrentElement: () => percentage === 0 ? 0 : 10,
    getScrollOffset: () => scrollOffset,
  });
  const onScroll = vi.fn();
  const cleanup = controller.attach(host, onScroll);
  const proxy = host.querySelector<HTMLElement>('[data-cerious-native-touch-proxy]')!;
  Object.defineProperty(proxy, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(proxy, 'scrollHeight', { configurable: true, value: 2_000_600 });
  controller.syncPosition();
  return { host, content, button, proxy, controller, scroll, onScroll, cleanup };
}

function fireTouch(proxy: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel'): void {
  const event = new Event(type);
  Object.defineProperty(event, 'touches', {
    value: type === 'touchstart' ? [{ identifier: 1 }] : [],
  });
  proxy.dispatchEvent(event);
}

describe('NativeTouchController', () => {
  it('keeps interactive content as the real hit-test target', () => {
    const { host, content, button, proxy, cleanup } = fixture();
    const click = vi.fn();
    button.addEventListener('click', click);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(button.parentElement).toBe(content);
    expect(content.parentElement).toBe(proxy);
    expect(proxy.parentElement).toBe(host);
    cleanup();
  });

  it('forwards native scrollTop distance to the existing pixel scroll engine', async () => {
    const { host, proxy, scroll, onScroll, cleanup } = fixture();
    const baseline = proxy.scrollTop;
    fireTouch(proxy, 'touchstart');
    proxy.scrollTop = baseline + 75;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();
    expect(scroll).toHaveBeenCalledWith(75, 600);
    expect(onScroll).toHaveBeenCalledWith({ element: 10, offset: 75 });
    expect(host.hasAttribute('data-cerious-touch')).toBe(false);
    cleanup();
  });

  it('coalesces native scroll events into one engine update per frame', async () => {
    const { proxy, scroll, cleanup } = fixture();
    const baseline = proxy.scrollTop;
    fireTouch(proxy, 'touchstart');
    proxy.scrollTop = baseline + 20;
    proxy.dispatchEvent(new Event('scroll'));
    proxy.scrollTop = baseline + 55;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith(55, 600);
    cleanup();
  });

  it('does not turn bottom rubber-band rebound into upward engine movement', async () => {
    const { proxy, controller, scroll, cleanup } = fixture(100);
    controller.syncPosition();
    const max = proxy.scrollHeight - proxy.clientHeight;
    expect(proxy.scrollTop).toBe(max);
    fireTouch(proxy, 'touchstart');

    // Safari reports values beyond max during elastic stretch. Returning from
    // that value to max must not be interpreted as a negative scroll delta.
    proxy.scrollTop = max + 120;
    proxy.dispatchEvent(new Event('scroll'));
    proxy.scrollTop = max;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();

    expect(scroll).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not turn top rubber-band rebound into downward engine movement', async () => {
    const { proxy, scroll, cleanup } = fixture(0);
    expect(proxy.scrollTop).toBe(0);
    fireTouch(proxy, 'touchstart');

    proxy.scrollTop = -90;
    proxy.dispatchEvent(new Event('scroll'));
    proxy.scrollTop = 0;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();

    expect(scroll).not.toHaveBeenCalled();
    cleanup();
  });

  it('keeps a tiny nonzero dataset position away from the proxy boundary', () => {
    // Large virtual datasets can remain below 0.01% after scrolling thousands
    // of pixels. That is still a real mid-dataset position, not the top.
    const { proxy, cleanup } = fixture(0.00593);
    const max = proxy.scrollHeight - proxy.clientHeight;

    expect(proxy.scrollTop).toBe(Math.round(max / 2));
    cleanup();
  });

  it('rejects browser scroll anchoring after a non-scrolling tap', async () => {
    const { proxy, scroll, cleanup } = fixture(50);
    const baseline = proxy.scrollTop;
    fireTouch(proxy, 'touchstart');
    fireTouch(proxy, 'touchend');

    // Model Safari moving the native surface after the tapped descendant is
    // focused or mutated by its synthesized click.
    proxy.scrollTop = baseline + 240;
    proxy.dispatchEvent(new Event('scroll'));
    await waitForAnimationFrame();

    expect(scroll).not.toHaveBeenCalled();
    expect(proxy.scrollTop).toBe(baseline);
    cleanup();
  });

  it('restores original DOM position and inline styles on cleanup', () => {
    const { host, content, proxy, cleanup } = fixture();
    cleanup();
    expect(host.querySelector('[data-cerious-native-touch-proxy]')).toBeNull();
    expect(content.parentElement).toBe(host);
    expect(content.style.position).toBe('');
    expect(content.style.top).toBe('');
    expect(proxy.isConnected).toBe(false);
  });

  it('requires dedicated content instead of installing a hit-test overlay', () => {
    const host = document.createElement('div');
    const controller = new NativeTouchController({
      scroll: () => ({ element: 0, offset: 0 }),
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
    expect(() => controller.attach(host)).toThrow('[data-cerious-scroll-content]');
  });
});
