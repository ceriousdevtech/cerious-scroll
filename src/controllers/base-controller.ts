/** Shared attach/detach and a reused event-detail object. */

import { ScrollResult } from '../types/index.js';
import { EventEmitter } from '../core/event-emitter.js';

export interface BaseControllerDeps {
  scroll: (deltaY: number, viewportHeight: number) => ScrollResult;
  calculateScrollPercentage: () => number;
  getCurrentElement: () => number;
  getScrollOffset: () => number;
}

export interface ControllerLifecycleHooks {
  onAttach?(): void;
  onDetach?(): void;
  onScroll?(result: ScrollResult): void;
}

/**
 * Attach/detach + a reused event-detail object (the CustomEvent payload
 * is mutated in place; listeners must copy if they retain it).
 */
export abstract class BaseController<TOptions = any> implements ControllerLifecycleHooks {
  protected container?: HTMLElement;
  protected options?: TOptions;
  protected cleanupFunctions: Array<() => void> = [];
  protected isAttached: boolean = false;
  
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
   * @param container Host.
   * @param options Controller options.
   * @param onScroll After a scroll this controller produced.
   * @returns Detach function. Re-attach detaches first.
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
    this.onAttach?.();
    this.attachEventListeners(onScroll);
    return () => this.detach();
  }

  protected detach(): void {
    if (!this.isAttached) {
      return;
    }
    
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

  protected trackCleanup(cleanup: () => void): void {
    this.cleanupFunctions.push(cleanup);
  }

  /** Mutates `eventDetail` in place. */
  protected updateEventDetail(result?: ScrollResult): void {
    this.eventDetail.percentage = this.deps.calculateScrollPercentage();
    this.eventDetail.currentElement = this.deps.getCurrentElement();
    this.eventDetail.scrollOffset = this.deps.getScrollOffset();
    if (result) {
      this.eventDetail.result = result;
    }
  }

  protected dispatchViewportChange(container: HTMLElement, result?: ScrollResult): void {
    this.updateEventDetail(result);
    
    container.dispatchEvent(new CustomEvent('cerious-viewport-change', {
      detail: this.eventDetail
    }));
  }

  protected validateContainer(container: HTMLElement | undefined): asserts container is HTMLElement {
    if (!container) {
      throw new Error(`${this.constructor.name}: Container element is required`);
    }
  }

  protected isEnabled(): boolean {
    const options = this.options as any;
    return options?.enabled !== false;
  }

  protected abstract attachEventListeners(onScroll?: (result: ScrollResult) => void): void;

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
