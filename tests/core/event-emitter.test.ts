/**
 * @fileoverview Unit tests for EventEmitter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, ViewportChangeEvent, createEventEmitter, isEventEmitter } from '../../src/core/event-emitter.js';

describe('EventEmitter', () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  describe('Basic Event Subscription', () => {
    it('should subscribe to events', () => {
      const listener = vi.fn();
      emitter.on('viewport-change', listener);
      
      expect(emitter.hasListeners('viewport-change')).toBe(true);
      expect(emitter.listenerCount('viewport-change')).toBe(1);
    });

    it('should unsubscribe from events', () => {
      const listener = vi.fn();
      const unsubscribe = emitter.on('viewport-change', listener);
      
      unsubscribe();
      
      expect(emitter.hasListeners('viewport-change')).toBe(false);
    });

    it('should support multiple listeners for same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      
      emitter.on('viewport-change', listener1);
      emitter.on('viewport-change', listener2);
      
      expect(emitter.listenerCount('viewport-change')).toBe(2);
    });
  });

  describe('Event Emission', () => {
    it('should emit events to subscribers', () => {
      const listener = vi.fn();
      emitter.on('viewport-change', listener);
      
      const eventData: ViewportChangeEvent = {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      };
      
      emitter.emit('viewport-change', eventData);
      
      expect(listener).toHaveBeenCalledWith(eventData);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should emit to multiple subscribers', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      
      emitter.on('viewport-change', listener1);
      emitter.on('viewport-change', listener2);
      
      const eventData: ViewportChangeEvent = {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      };
      
      emitter.emit('viewport-change', eventData);
      
      expect(listener1).toHaveBeenCalledWith(eventData);
      expect(listener2).toHaveBeenCalledWith(eventData);
    });

    it('should not emit to unsubscribed listeners', () => {
      const listener = vi.fn();
      const unsubscribe = emitter.on('viewport-change', listener);
      
      unsubscribe();
      
      emitter.emit('viewport-change', {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      });
      
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle errors in listeners gracefully', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const normalListener = vi.fn();
      
      emitter.on('viewport-change', errorListener);
      emitter.on('viewport-change', normalListener);
      
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      emitter.emit('viewport-change', {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      });
      
      // Error should be caught and logged
      expect(consoleSpy).toHaveBeenCalled();
      // Other listeners should still be called
      expect(normalListener).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });

  describe('Once Listeners', () => {
    it('should subscribe with once', () => {
      const listener = vi.fn();
      emitter.once('viewport-change', listener);
      
      expect(emitter.hasListeners('viewport-change')).toBe(true);
    });

    it('should fire once listeners only once', () => {
      const listener = vi.fn();
      emitter.once('viewport-change', listener);
      
      const eventData: ViewportChangeEvent = {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      };
      
      emitter.emit('viewport-change', eventData);
      emitter.emit('viewport-change', eventData);
      
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should remove once listener after firing', () => {
      const listener = vi.fn();
      emitter.once('viewport-change', listener);
      
      emitter.emit('viewport-change', {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      });
      
      expect(emitter.hasListeners('viewport-change')).toBe(false);
    });

    it('should support unsubscribing once listeners before they fire', () => {
      const listener = vi.fn();
      const unsubscribe = emitter.once('viewport-change', listener);
      
      unsubscribe();
      
      emitter.emit('viewport-change', {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      });
      
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('Event Management', () => {
    it('should clear all listeners for an event', () => {
      emitter.on('viewport-change', vi.fn());
      emitter.on('viewport-change', vi.fn());
      emitter.on('scroll', vi.fn());
      
      emitter.clear('viewport-change');
      
      expect(emitter.hasListeners('viewport-change')).toBe(false);
      expect(emitter.hasListeners('scroll')).toBe(true);
    });

    it('should clear all listeners for all events', () => {
      emitter.on('viewport-change', vi.fn());
      emitter.on('scroll', vi.fn());
      emitter.on('resize', vi.fn());
      
      emitter.clear();
      
      expect(emitter.hasListeners('viewport-change')).toBe(false);
      expect(emitter.hasListeners('scroll')).toBe(false);
      expect(emitter.hasListeners('resize')).toBe(false);
    });

    it('should return correct listener count', () => {
      emitter.on('viewport-change', vi.fn());
      emitter.on('viewport-change', vi.fn());
      emitter.once('viewport-change', vi.fn());
      
      expect(emitter.listenerCount('viewport-change')).toBe(3);
    });

    it('should return event names with listeners', () => {
      emitter.on('viewport-change', vi.fn());
      emitter.on('scroll', vi.fn());
      
      const names = emitter.eventNames();
      
      expect(names).toContain('viewport-change');
      expect(names).toContain('scroll');
      expect(names.length).toBe(2);
    });

    it('should handle off for non-existent listener gracefully', () => {
      const listener = vi.fn();
      
      expect(() => emitter.off('viewport-change', listener)).not.toThrow();
    });
  });

  describe('Type Safety', () => {
    it('should provide type-safe event data', () => {
      const listener = vi.fn((data: ViewportChangeEvent) => {
        // Type assertions to verify TypeScript types
        expect(typeof data.percentage).toBe('number');
        expect(typeof data.currentElement).toBe('number');
        expect(typeof data.scrollOffset).toBe('number');
      });
      
      emitter.on('viewport-change', listener);
      
      emitter.emit('viewport-change', {
        percentage: 50,
        currentElement: 100,
        scrollOffset: 25,
        element: 100,
        offset: 25,
      });
      
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('Factory Functions', () => {
    it('should create emitter with factory', () => {
      const emitter = createEventEmitter();
      
      expect(emitter).toBeInstanceOf(EventEmitter);
    });

    it('should identify event emitters', () => {
      const emitter = createEventEmitter();
      const notEmitter = {};
      
      expect(isEventEmitter(emitter)).toBe(true);
      expect(isEventEmitter(notEmitter)).toBe(false);
    });
  });

  describe('Memory Management', () => {
    it('should clean up listener sets when empty', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      
      const unsub1 = emitter.on('viewport-change', listener1);
      const unsub2 = emitter.on('viewport-change', listener2);
      
      unsub1();
      unsub2();
      
      // Internal listener sets should be cleaned up
      expect(emitter.listenerCount('viewport-change')).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle emitting to event with no listeners', () => {
      expect(() => {
        emitter.emit('viewport-change', {
          percentage: 50,
          currentElement: 100,
          scrollOffset: 25,
          element: 100,
          offset: 25,
        });
      }).not.toThrow();
    });

    it('should handle checking listeners for non-existent event', () => {
      expect(emitter.hasListeners('viewport-change')).toBe(false);
      expect(emitter.listenerCount('viewport-change')).toBe(0);
    });
  });
});
