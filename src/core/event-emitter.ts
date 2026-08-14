/**
 * Typed pub/sub. DOM CustomEvent stays on the container for consumers;
 * this is for internal listeners that want a payload type.
 */

export type EventListener<T = any> = (data: T) => void;
export type Unsubscribe = () => void;

export interface EventMap {
  'viewport-change': ViewportChangeEvent;
  'scroll': ScrollEvent;
  'resize': ResizeEvent;
  'element-measured': ElementMeasuredEvent;
}

export interface ViewportChangeEvent {
  percentage: number;
  currentElement: number;
  scrollOffset: number;
  element: number;
  offset: number;
}

export interface ScrollEvent {
  element: number;
  offset: number;
  deltaY: number;
  percentage: number;
}

export interface ResizeEvent {
  viewportHeight: number;
  viewportWidth: number;
  previousHeight: number;
  previousWidth: number;
}

export interface ElementMeasuredEvent {
  index: number;
  height: number;
  previousHeight?: number;
}

/** Internal typed pub/sub. Container CustomEvents are a separate channel. */
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
   *
   * @param handler Called with the thrown value and event name, or `null` to restore `console.error`.
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
   * @param eventName Event to subscribe to.
   * @param listener Invoked with the typed payload.
   * @returns Unsubscribe function.
   */
  on<K extends keyof TEventMap>(
    eventName: K,
    listener: EventListener<TEventMap[K]>
  ): Unsubscribe {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    
    this.listeners.get(eventName)!.add(listener);
    return () => this.off(eventName, listener);
  }

  /**
   * Subscribe for a single emission.
   *
   * @param eventName Event to subscribe to.
   * @param listener Invoked once with the typed payload.
   * @returns Unsubscribe function (no-op after the event fires).
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
   * @param eventName Event to unsubscribe from.
   * @param listener Listener previously passed to {@link on} or {@link once}.
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
   * @param eventName Event to emit.
   * @param data Typed payload.
   */
  emit<K extends keyof TEventMap>(eventName: K, data: TEventMap[K]): void {
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
    
    const onceListeners = this.onceListeners.get(eventName);
    if (onceListeners) {
      onceListeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          this._reportError(error, eventName, 'once-listener');
        }
      });
      this.onceListeners.delete(eventName);
    }
  }

  /**
   * @param eventName Event to clear. Omit to remove every listener.
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
   * @param eventName Event to count.
   * @returns Regular + once listeners.
   */
  listenerCount(eventName: keyof TEventMap): number {
    const regular = this.listeners.get(eventName)?.size ?? 0;
    const once = this.onceListeners.get(eventName)?.size ?? 0;
    return regular + once;
  }

  /**
   * @param eventName Event to check.
   * @returns Whether any listener is registered.
   */
  hasListeners(eventName: keyof TEventMap): boolean {
    return this.listenerCount(eventName) > 0;
  }

  /**
   * @returns Event names that currently have listeners.
   */
  eventNames(): Array<keyof TEventMap> {
    const names = new Set<keyof TEventMap>();
    this.listeners.forEach((_, key) => names.add(key));
    this.onceListeners.forEach((_, key) => names.add(key));
    return Array.from(names);
  }
}

/**
 * @returns A new typed emitter.
 */
export function createEventEmitter<TEventMap extends Record<string, any> = EventMap>(): EventEmitter<TEventMap> {
  return new EventEmitter<TEventMap>();
}

/**
 * @param obj Value to test.
 * @returns Whether `obj` is an {@link EventEmitter}.
 */
export function isEventEmitter(obj: any): obj is EventEmitter {
  return obj instanceof EventEmitter;
}
