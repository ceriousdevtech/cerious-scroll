/**
 * @fileoverview Base Controller for CeriousScroll Input Controllers
 * 
 * Provides common functionality for all input controllers (Wheel, Touch, Keyboard).
 * Implements template method pattern for consistent controller lifecycle management.
 */

import { ScrollResult } from '../types/index.js';
import { EventEmitter } from '../core/event-emitter.js';

/**
 * Base dependencies required by all controllers
 */
export interface BaseControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

/**
 * Controller lifecycle hooks
 */
export interface ControllerLifecycleHooks {
  /**
   * Called when controller is attached to container
   */
  onAttach?(): void;
  
  /**
   * Called when controller is detached from container
   */
  onDetach?(): void;
  
  /**
   * Called after a scroll operation
   */
  onScroll?(result: ScrollResult): void;
}

/**
 * Abstract base controller class
 * 
 * Provides common functionality for input controllers:
 * - Event listener management
 * - Lifecycle hooks
 * - Event detail object reuse (GC optimization)
 * - Cleanup tracking
 */
export abstract class BaseController<TOptions = any> implements ControllerLifecycleHooks {
  protected container?: HTMLElement;
  protected options?: TOptions;
  protected cleanupFunctions: Array<() => void> = [];
  protected isAttached: boolean = false;
  
  // GC optimization: Reusable event detail object
  protected readonly eventDetail: {
    percentage: number;
    currentElement: number;
    scrollOffset: number;
    result?: ScrollResult;
  } = {
    percentage: 0,
    currentElement: 0,
    scrollOffset: 0,
  };

  constructor(protected readonly deps: BaseControllerDeps) {}

  /**
   * Attach controller to container
   * 
   * Template method pattern - calls lifecycle hooks
   */
  attach(
    container: HTMLElement,
    options?: TOptions,
    onScroll?: (result: ScrollResult) => void
  ): () => void {
    if (this.isAttached) {
      console.warn('Controller already attached. Detaching first.');
      this.detach();
    }
    
    this.container = container;
    this.options = options;
    this.isAttached = true;
    
    // Call lifecycle hook
    this.onAttach?.();
    
    // Perform actual attachment (implemented by subclasses)
    this.attachEventListeners(onScroll);
    
    // Return cleanup function
    return () => this.detach();
  }

  /**
   * Detach controller from container
   */
  protected detach(): void {
    if (!this.isAttached) {
      return;
    }
    
    // Call lifecycle hook (do not let a buggy hook prevent cleanup below)
    try {
      this.onDetach?.();
    } catch (error) {
      console.error(`${this.constructor.name}.onDetach threw:`, error);
    }
    
    // Execute every cleanup function even if one throws.
    // Skipping subsequent cleanups would leak listeners/observers/RAFs.
    const cleanups = this.cleanupFunctions;
    this.cleanupFunctions = [];
    for (let i = 0; i < cleanups.length; i++) {
      try {
        cleanups[i]();
      } catch (error) {
        console.error(`${this.constructor.name}: cleanup[${i}] threw:`, error);
      }
    }
    
    this.container = undefined;
    this.options = undefined;
    this.isAttached = false;
  }

  /**
   * Track cleanup function
   * 
   * @param cleanup Function to call on detach
   */
  protected trackCleanup(cleanup: () => void): void {
    this.cleanupFunctions.push(cleanup);
  }

  /**
   * Update event detail object with current state
   * 
   * GC optimization: Reuses same object instead of creating new one
   */
  protected updateEventDetail(result?: ScrollResult): void {
    this.eventDetail.percentage = this.deps.calculateScrollPercentage();
    this.eventDetail.currentElement = this.deps.getCurrentElement();
    this.eventDetail.scrollOffset = this.deps.getScrollOffset();
    if (result) {
      this.eventDetail.result = result;
    }
  }

  /**
   * Dispatch viewport change event
   * 
   * @param container Target element for the event
   * @param result Optional scroll result
   */
  protected dispatchViewportChange(container: HTMLElement, result?: ScrollResult): void {
    this.updateEventDetail(result);
    
    container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
      detail: this.eventDetail
    }));
  }

  /**
   * Validate container element
   * 
   * @throws Error if container is invalid
   */
  protected validateContainer(container: HTMLElement | undefined): asserts container is HTMLElement {
    if (!container) {
      throw new Error(`${this.constructor.name}: Container element is required`);
    }
  }

  /**
   * Check if controller is enabled based on options
   * 
   * @returns True if controller should be enabled
   */
  protected isEnabled(): boolean {
    const options = this.options as any;
    return options?.enabled !== false;
  }

  /**
   * Abstract method for attaching event listeners
   * Must be implemented by subclasses
   */
  protected abstract attachEventListeners(onScroll?: (result: ScrollResult) => void): void;

  // Lifecycle hooks (can be overridden by subclasses)
  onAttach?(): void;
  onDetach?(): void;
  onScroll?(result: ScrollResult): void;
}

/**
 * Controller options interface with common properties
 */
export interface CommonControllerOptions {
  /** Enable/disable the controller (default: true) */
  enabled?: boolean;
  /** Emit viewport-change events (default: true) */
  emitViewportChangeEvent?: boolean;
}

/**
 * Validation utilities for controllers
 */
export class ControllerValidator {
  /**
   * Validate numeric option within range
   */
  static validateNumber(
    value: number,
    name: string,
    min?: number,
    max?: number
  ): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`${name} must be a valid number`);
    }
    if (min !== undefined && value < min) {
      throw new Error(`${name} must be >= ${min}`);
    }
    if (max !== undefined && value > max) {
      throw new Error(`${name} must be <= ${max}`);
    }
  }

  /**
   * Validate boolean option
   */
  static validateBoolean(value: any, name: string): void {
    if (typeof value !== 'boolean' && value !== undefined) {
      throw new Error(`${name} must be a boolean or undefined`);
    }
  }

  /**
   * Validate function option
   */
  static validateFunction(value: any, name: string): void {
    if (typeof value !== 'function' && value !== undefined) {
      throw new Error(`${name} must be a function or undefined`);
    }
  }
}
