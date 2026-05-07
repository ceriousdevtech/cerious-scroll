/**
 * @fileoverview Type-Safe Event Emitter for CeriousScroll
 * 
 * Provides a strongly-typed event system to replace generic CustomEvent usage,
 * improving type safety and developer experience.
 */

/**
 * Event listener function type
 */
export type EventListener<T = any> = (data: T) => void;

/**
 * Cleanup function returned from event subscriptions
 */
export type Unsubscribe = () => void;

/**
 * Event map defining available events and their payload types
 */
export interface EventMap {
  'viewport-change': ViewportChangeEvent;
  'scroll': ScrollEvent;
  'resize': ResizeEvent;
  'element-measured': ElementMeasuredEvent;
}

/**
 * Viewport change event data
 */
export interface ViewportChangeEvent {
  percentage: number;
  currentElement: number;
  scrollOffset: number;
  element: number;
  offset: number;
}

/**
 * Scroll event data
 */
export interface ScrollEvent {
  element: number;
  offset: number;
  deltaY: number;
  percentage: number;
}

/**
 * Resize event data
 */
export interface ResizeEvent {
  viewportHeight: number;
  viewportWidth: number;
  previousHeight: number;
  previousWidth: number;
}

/**
 * Element measured event data
 */
export interface ElementMeasuredEvent {
  index: number;
  height: number;
  previousHeight?: number;
}

/**
 * Type-safe event emitter implementation
 * 
 * Provides a publish-subscribe pattern with strong typing for events.
 * Replaces generic DOM CustomEvent usage with proper TypeScript types.
 */
export class EventEmitter<TEventMap extends Record<string, any> = EventMap> {
  private listeners: Map<keyof TEventMap, Set<EventListener<any>>> = new Map();
  private onceListeners: Map<keyof TEventMap, Set<EventListener<any>>> = new Map();
  // Optional sink for listener errors. When unset (default), errors are
  // logged via console.error. Consumers integrating with structured logging
  // (Sentry, Datadog, etc.) can register a hook to capture them instead.
  private _onError: ((error: unknown, eventName: string | symbol) => void) | null = null;

  /**
   * Register a global error handler for listener exceptions. Replaces the
   * default console.error logging. Pass `null` to restore default behavior.
   */
  setErrorHandler(
    handler: ((error: unknown, eventName: string | symbol) => void) | null
  ): void {
    this._onError = handler;
  }

  private _reportError(error: unknown, eventName: keyof TEventMap, kind: 'listener' | 'once-listener'): void {
    if (this._onError) {
      try {
        this._onError(error, eventName as string | symbol);
      } catch {
        // Never let an error handler bring down the emitter.
      }
    } else {
      console.error(`Error in ${kind} for '${String(eventName)}':`, error);
    }
  }

  /**
   * Subscribe to an event
   * 
   * @param eventName Name of the event to listen for
   * @param listener Callback function to invoke when event is emitted
   * @returns Unsubscribe function to remove the listener
   */
  on<K extends keyof TEventMap>(
    eventName: K,
    listener: EventListener<TEventMap[K]>
  ): Unsubscribe {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    
    this.listeners.get(eventName)!.add(listener);
    
    // Return unsubscribe function
    return () => this.off(eventName, listener);
  }

  /**
   * Subscribe to an event that fires only once
   * 
   * @param eventName Name of the event to listen for
   * @param listener Callback function to invoke when event is emitted
   * @returns Unsubscribe function to remove the listener
   */
  once<K extends keyof TEventMap>(
    eventName: K,
    listener: EventListener<TEventMap[K]>
  ): Unsubscribe {
    if (!this.onceListeners.has(eventName)) {
      this.onceListeners.set(eventName, new Set());
    }
    
    this.onceListeners.get(eventName)!.add(listener);
    
    return () => {
      const listeners = this.onceListeners.get(eventName);
      if (listeners) {
        listeners.delete(listener);
      }
    };
  }

  /**
   * Unsubscribe from an event
   * 
   * @param eventName Name of the event to stop listening for
   * @param listener Callback function to remove
   */
  off<K extends keyof TEventMap>(
    eventName: K,
    listener: EventListener<TEventMap[K]>
  ): void {
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventName);
      }
    }
    
    const onceListeners = this.onceListeners.get(eventName);
    if (onceListeners) {
      onceListeners.delete(listener);
      if (onceListeners.size === 0) {
        this.onceListeners.delete(eventName);
      }
    }
  }

  /**
   * Emit an event to all subscribers
   * 
   * @param eventName Name of the event to emit
   * @param data Event data payload
   */
  emit<K extends keyof TEventMap>(eventName: K, data: TEventMap[K]): void {
    // Call regular listeners
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          this._reportError(error, eventName, 'listener');
        }
      });
    }
    
    // Call once listeners and remove them
    const onceListeners = this.onceListeners.get(eventName);
    if (onceListeners) {
      onceListeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          this._reportError(error, eventName, 'once-listener');
        }
      });
      // Clear once listeners after calling
      this.onceListeners.delete(eventName);
    }
  }

  /**
   * Remove all listeners for a specific event, or all events if no event specified
   * 
   * @param eventName Optional event name to clear listeners for
   */
  clear(eventName?: keyof TEventMap): void {
    if (eventName) {
      this.listeners.delete(eventName);
      this.onceListeners.delete(eventName);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
  }

  /**
   * Get the number of listeners for an event
   * 
   * @param eventName Name of the event
   * @returns Number of listeners subscribed to the event
   */
  listenerCount(eventName: keyof TEventMap): number {
    const regular = this.listeners.get(eventName)?.size ?? 0;
    const once = this.onceListeners.get(eventName)?.size ?? 0;
    return regular + once;
  }

  /**
   * Check if there are any listeners for an event
   * 
   * @param eventName Name of the event
   * @returns True if there are listeners for the event
   */
  hasListeners(eventName: keyof TEventMap): boolean {
    return this.listenerCount(eventName) > 0;
  }

  /**
   * Get all event names that have listeners
   * 
   * @returns Array of event names
   */
  eventNames(): Array<keyof TEventMap> {
    const names = new Set<keyof TEventMap>();
    this.listeners.forEach((_, key) => names.add(key));
    this.onceListeners.forEach((_, key) => names.add(key));
    return Array.from(names);
  }
}

/**
 * Create a new event emitter instance
 * 
 * @returns New EventEmitter instance
 */
export function createEventEmitter<TEventMap extends Record<string, any> = EventMap>(): EventEmitter<TEventMap> {
  return new EventEmitter<TEventMap>();
}

/**
 * Type guard to check if an object is an event emitter
 */
export function isEventEmitter(obj: any): obj is EventEmitter {
  return obj instanceof EventEmitter;
}
