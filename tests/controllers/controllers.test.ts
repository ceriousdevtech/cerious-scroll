/**
 * @fileoverview Unit tests for Controller modules (Wheel, Touch, Keyboard, Resize)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WheelController } from '../../src/controllers/wheel-controller.js';
import { TouchController } from '../../src/controllers/touch-controller.js';
import { KeyboardController } from '../../src/controllers/keyboard-controller.js';
import { ResizeController } from '../../src/controllers/resize-controller.js';
import {
  createMockContainer,
  createMockWheelEvent,
  createMockTouchEvent,
  createMockKeyboardEvent,
  waitForAnimationFrame,
} from '../helpers/test-helpers.js';

describe('WheelController', () => {
  let controller: WheelController;
  let mockScroll: ReturnType<typeof vi.fn>;
  let mockContainer: HTMLElement;

  beforeEach(() => {
    mockScroll = vi.fn((deltaY: number) => ({ element: 0, offset: deltaY }));
    mockContainer = createMockContainer();
    
    controller = new WheelController({
      scroll: mockScroll,
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
  });

  describe('Attachment and Cleanup', () => {
    it('should attach wheel event listener', () => {
      const cleanup = controller.attach(mockContainer);
      
      expect(mockContainer.addEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function),
        expect.objectContaining({ passive: false })
      );
      
      cleanup();
    });

    it('should remove wheel event listener on cleanup', () => {
      const cleanup = controller.attach(mockContainer);
      cleanup();
      
      expect(mockContainer.removeEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function)
      );
    });

    it('should not attach if disabled', () => {
      const cleanup = controller.attach(mockContainer, undefined, { enabled: false });
      
      expect(mockContainer.addEventListener).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('Wheel Event Handling', () => {
    it('should call scroll on wheel event', () => {
      controller.attach(mockContainer);
      
      const wheelEvent = createMockWheelEvent(100);
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(wheelEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(100, mockContainer.clientHeight);
      expect(wheelEvent.preventDefault).toHaveBeenCalled();
    });

    it('should invoke onScroll callback', () => {
      const onScroll = vi.fn();
      controller.attach(mockContainer, onScroll);
      
      const wheelEvent = createMockWheelEvent(50);
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(wheelEvent);
      
      expect(onScroll).toHaveBeenCalledWith({ element: 0, offset: 50 });
    });

    it('should emit viewport-change event by default', () => {
      controller.attach(mockContainer);
      
      const wheelEvent = createMockWheelEvent(100);
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(wheelEvent);
      
      expect(mockContainer.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cerious-viewport-change'
        })
      );
    });

    it('should not emit event when disabled', () => {
      controller.attach(mockContainer, undefined, { emitViewportChangeEvent: false });
      
      const wheelEvent = createMockWheelEvent(100);
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(wheelEvent);
      
      expect(mockContainer.dispatchEvent).not.toHaveBeenCalled();
    });

    it('should coalesce events when enabled', async () => {
      controller.attach(mockContainer, undefined, { coalesceViewportChangeEvent: true });
      
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      
      // Fire multiple wheel events
      handler(createMockWheelEvent(10));
      handler(createMockWheelEvent(20));
      handler(createMockWheelEvent(30));
      
      // Should batch into single RAF
      await waitForAnimationFrame();
      
      // Only one dispatched event after RAF
      expect(vi.mocked(mockContainer.dispatchEvent).mock.calls.length).toBeLessThanOrEqual(2);
    });
  });
});

describe('TouchController', () => {
  let controller: TouchController;
  let mockScroll: ReturnType<typeof vi.fn>;
  let mockContainer: HTMLElement;

  beforeEach(() => {
    mockScroll = vi.fn((deltaY: number) => ({ element: 0, offset: deltaY }));
    mockContainer = createMockContainer();
    
    controller = new TouchController({
      scroll: mockScroll,
      calculateScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
  });

  describe('Attachment and Cleanup', () => {
    it('should attach touch event listeners', () => {
      const cleanup = controller.attach(mockContainer);
      
      expect(mockContainer.addEventListener).toHaveBeenCalledWith(
        'touchstart',
        expect.any(Function),
        expect.objectContaining({ passive: false, capture: true })
      );
      expect(mockContainer.addEventListener).toHaveBeenCalledWith(
        'touchmove',
        expect.any(Function),
        expect.objectContaining({ passive: false, capture: true })
      );
      expect(mockContainer.addEventListener).toHaveBeenCalledWith(
        'touchend',
        expect.any(Function),
        expect.objectContaining({ passive: false, capture: true })
      );
      
      cleanup();
    });

    it('should remove touch event listeners on cleanup', () => {
      const cleanup = controller.attach(mockContainer);
      cleanup();
      
      expect(mockContainer.removeEventListener).toHaveBeenCalledWith(
        'touchstart',
        expect.any(Function),
        true
      );
    });

    it('should set touch-action CSS', () => {
      controller.attach(mockContainer);
      
      expect(mockContainer.style.touchAction).toBe('none');
      expect(mockContainer.setAttribute).toHaveBeenCalledWith('data-cerious-touch', 'true');
    });
  });

  describe('Touch Event Handling', () => {
    it('should handle touchstart', () => {
      controller.attach(mockContainer);
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      
      handler(touchStart);
      
      expect(touchStart.preventDefault).toHaveBeenCalled();
      expect(touchStart.stopPropagation).toHaveBeenCalled();
    });

    it('should handle touchmove and call scroll', () => {
      controller.attach(mockContainer);
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const touchMove = createMockTouchEvent('touchmove', [{ identifier: 1, clientY: 50 }]);
      
      const startHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      const moveHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchmove'
      )?.[1] as EventListener;
      
      startHandler(touchStart);
      moveHandler(touchMove);
      
      // Delta = 100 - 50 = 50 pixels down
      expect(mockScroll).toHaveBeenCalledWith(50, mockContainer.clientHeight);
    });

    it('should invoke onScroll callback', () => {
      const onScroll = vi.fn();
      controller.attach(mockContainer, onScroll);
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const touchMove = createMockTouchEvent('touchmove', [{ identifier: 1, clientY: 80 }]);
      
      const startHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      const moveHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchmove'
      )?.[1] as EventListener;
      
      startHandler(touchStart);
      moveHandler(touchMove);
      
      expect(onScroll).toHaveBeenCalled();
    });

    it('should emit viewport-change event', () => {
      controller.attach(mockContainer);
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const touchMove = createMockTouchEvent('touchmove', [{ identifier: 1, clientY: 80 }]);
      
      const startHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      const moveHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchmove'
      )?.[1] as EventListener;
      
      startHandler(touchStart);
      moveHandler(touchMove);
      
      expect(mockContainer.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cerious-viewport-change' })
      );
    });
  });

  describe('Momentum Scrolling', () => {
    it('should apply momentum on touchend by default', async () => {
      const onScroll = vi.fn();
      controller.attach(mockContainer, onScroll);
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const touchMove1 = createMockTouchEvent('touchmove', [{ identifier: 1, clientY: 80 }]);
      const touchMove2 = createMockTouchEvent('touchmove', [{ identifier: 1, clientY: 50 }]);
      const touchEnd = createMockTouchEvent('touchend', [{ identifier: 1, clientY: 50 }]);
      
      const startHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      const moveHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchmove'
      )?.[1] as EventListener;
      const endHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchend'
      )?.[1] as EventListener;
      
      startHandler(touchStart);
      await new Promise(resolve => setTimeout(resolve, 10));
      moveHandler(touchMove1);
      await new Promise(resolve => setTimeout(resolve, 10));
      moveHandler(touchMove2);
      endHandler(touchEnd);
      
      // Should call onScroll with momentum
      await waitForAnimationFrame();
      await waitForAnimationFrame();
      
      // Momentum should trigger additional scroll calls
      expect(onScroll.mock.calls.length).toBeGreaterThan(2);
    });

    it('should not apply momentum when disabled', () => {
      controller.attach(mockContainer, undefined, { enableMomentum: false });
      
      const touchStart = createMockTouchEvent('touchstart', [{ identifier: 1, clientY: 100 }]);
      const touchEnd = createMockTouchEvent('touchend', [{ identifier: 1, clientY: 50 }]);
      
      const startHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchstart'
      )?.[1] as EventListener;
      const endHandler = vi.mocked(mockContainer.addEventListener).mock.calls.find(
        call => call[0] === 'touchend'
      )?.[1] as EventListener;
      
      startHandler(touchStart);
      endHandler(touchEnd);
      
      // No additional scroll calls from momentum
      expect(mockScroll.mock.calls.length).toBe(0);
    });
  });
});

describe('KeyboardController', () => {
  let controller: KeyboardController;
  let mockScroll: ReturnType<typeof vi.fn>;
  let mockJump: ReturnType<typeof vi.fn>;
  let mockContainer: HTMLElement;

  beforeEach(() => {
    mockScroll = vi.fn((deltaY: number) => ({ element: 0, offset: deltaY }));
    mockJump = vi.fn((index: number) => ({ element: index, offset: 0 }));
    mockContainer = createMockContainer();
    
    controller = new KeyboardController({
      scroll: mockScroll,
      jumpToElement: mockJump,
      getViewportHeight: () => 600,
      getScrollPercentage: () => 0,
      getCurrentElement: () => 0,
      getScrollOffset: () => 0,
    });
  });

  describe('Attachment and Cleanup', () => {
    it('should attach keydown event listener', () => {
      const cleanup = controller.attach(mockContainer);
      
      expect(mockContainer.addEventListener).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
      
      cleanup();
    });

    it('should set tabindex if not present', () => {
      controller.attach(mockContainer);
      
      expect(mockContainer.setAttribute).toHaveBeenCalledWith('tabindex', '0');
    });

    it('should remove keydown event listener on cleanup', () => {
      const cleanup = controller.attach(mockContainer);
      cleanup();
      
      expect(mockContainer.removeEventListener).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
    });

    it('should not attach if disabled', () => {
      const cleanup = controller.attach(mockContainer, { enabled: false });
      
      expect(mockContainer.addEventListener).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('Arrow Key Navigation', () => {
    it('should scroll down on ArrowDown', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(120, 600); // Default arrow speed
      expect(keyEvent.preventDefault).toHaveBeenCalled();
    });

    it('should scroll up on ArrowUp', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('ArrowUp');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(-120, 600);
    });

    it('should use custom arrow key speed', () => {
      controller.attach(mockContainer, { arrowKeySpeed: 200 });
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(200, 600);
    });
  });

  describe('Page Key Navigation', () => {
    it('should scroll page down on PageDown', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('PageDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(600, 600); // Full viewport height
    });

    it('should scroll page up on PageUp', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('PageUp');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(-600, 600);
    });

    it('should use custom page key speed', () => {
      controller.attach(mockContainer, { pageKeySpeed: 0.5 });
      
      const keyEvent = createMockKeyboardEvent('PageDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockScroll).toHaveBeenCalledWith(300, 600); // Half viewport
    });
  });

  describe('Home and End Keys', () => {
    it('should jump to start on Home', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('Home');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockJump).toHaveBeenCalledWith(0);
    });

    it('should jump to end on End', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('End');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockJump).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('Custom Key Handler', () => {
    it('should call custom onKeyDown handler', () => {
      const onKeyDown = vi.fn(() => false);
      controller.attach(mockContainer, { onKeyDown });
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(onKeyDown).toHaveBeenCalledWith(keyEvent, null);
    });

    it('should prevent default handling when custom handler returns true', () => {
      const onKeyDown = vi.fn(() => true);
      controller.attach(mockContainer, { onKeyDown });
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      // Should not call scroll because custom handler handled it
      expect(mockScroll).not.toHaveBeenCalled();
    });
  });

  describe('Event Emission', () => {
    it('should emit viewport-change event', () => {
      controller.attach(mockContainer);
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(mockContainer.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cerious-viewport-change' })
      );
    });

    it('should invoke onViewportChange callback', () => {
      const onViewportChange = vi.fn();
      controller.attach(mockContainer, {}, onViewportChange);
      
      const keyEvent = createMockKeyboardEvent('ArrowDown');
      const handler = vi.mocked(mockContainer.addEventListener).mock.calls[0][1] as EventListener;
      handler(keyEvent);
      
      expect(onViewportChange).toHaveBeenCalledWith(
        expect.objectContaining({
          percentage: 0,
          currentElement: 0,
          scrollOffset: 0,
        })
      );
    });
  });
});

describe('ResizeController', () => {
  let controller: ResizeController;
  let mockOnViewportChange: ReturnType<typeof vi.fn>;
  let mockContainer: HTMLElement;

  beforeEach(() => {
    mockOnViewportChange = vi.fn();
    mockContainer = createMockContainer();
    
    controller = new ResizeController(mockOnViewportChange);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Attachment and Cleanup', () => {
    it('should attach resize event listener to window', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      const cleanup = controller.attach(mockContainer);
      
      expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
      
      cleanup();
    });

    it('should remove resize event listener on cleanup', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      
      const cleanup = controller.attach(mockContainer);
      cleanup();
      
      expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    });
  });

  describe('Resize Event Handling', () => {
    it('should call onViewportChange on resize', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      controller.attach(mockContainer);
      
      // Get the resize handler
      const resizeHandler = addEventListenerSpy.mock.calls[0][1] as EventListener;
      
      // Trigger resize
      resizeHandler(new Event('resize'));
      
      expect(mockOnViewportChange).toHaveBeenCalledWith(mockContainer);
    });

    it('should pass correct container to callback', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      controller.attach(mockContainer);
      
      const resizeHandler = addEventListenerSpy.mock.calls[0][1] as EventListener;
      resizeHandler(new Event('resize'));
      
      expect(mockOnViewportChange).toHaveBeenCalledWith(mockContainer);
    });
  });
});
