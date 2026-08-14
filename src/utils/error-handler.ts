/** Library errors. Most call sites still throw `Error`; these exist for typed catching. */

export class CeriousScrollError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'CeriousScrollError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CeriousScrollError);
    }
  }
}

export class ConfigurationError extends CeriousScrollError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigurationError';
  }
}

export class InvalidStateError extends CeriousScrollError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'INVALID_STATE', context);
    this.name = 'InvalidStateError';
  }
}

export class BoundaryError extends CeriousScrollError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'BOUNDARY_ERROR', context);
    this.name = 'BoundaryError';
  }
}

/**
 * Error handler with logging and recovery strategies
 */
export class ErrorHandler {
  private static errorListeners: Array<(error: Error) => void> = [];
  
  /**
   * Add error listener for global error monitoring
   */
  static addListener(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      const index = this.errorListeners.indexOf(listener);
      if (index > -1) {
        this.errorListeners.splice(index, 1);
      }
    };
  }
  
  /**
   * Handle error with optional recovery
   */
  static handle(
    error: Error,
    context?: Record<string, any>,
    recovery?: () => void
  ): void {
    console.error('CeriousScroll Error:', error.message, context);

    this.errorListeners.forEach(listener => {
      try {
        listener(error);
      } catch (listenerError) {
        console.error('Error in error listener:', listenerError);
      }
    });
    
    if (recovery) {
      try {
        recovery();
      } catch (recoveryError) {
        console.error('Error recovery failed:', recoveryError);
      }
    }
  }
  
  /**
   * Wrap async function with error handling
   */
  static async wrapAsync<T>(
    fn: () => Promise<T>,
    errorMessage: string
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      this.handle(
        new CeriousScrollError(
          errorMessage,
          'ASYNC_ERROR',
          { originalError: error }
        )
      );
      return null;
    }
  }
  
  /**
   * Wrap sync function with error handling
   */
  static wrap<T>(
    fn: () => T,
    errorMessage: string
  ): T | null {
    try {
      return fn();
    } catch (error) {
      this.handle(
        new CeriousScrollError(
          errorMessage,
          'SYNC_ERROR',
          { originalError: error }
        )
      );
      return null;
    }
  }
}

/**
 * Validation utilities
 */
export class Validator {
  /**
   * Validate required parameter
   */
  static required<T>(value: T | undefined | null, name: string): T {
    if (value === undefined || value === null) {
      throw new ConfigurationError(`${name} is required`, { name, value });
    }
    return value;
  }
  
  /**
   * Validate number is positive
   */
  static positive(value: number, name: string): number {
    if (value <= 0) {
      throw new ConfigurationError(`${name} must be positive`, { name, value });
    }
    return value;
  }
  
  /**
   * Validate number is non-negative
   */
  static nonNegative(value: number, name: string): number {
    if (value < 0) {
      throw new ConfigurationError(`${name} must be non-negative`, { name, value });
    }
    return value;
  }
  
  /**
   * Validate number is within range
   */
  static inRange(value: number, min: number, max: number, name: string): number {
    if (value < min || value > max) {
      throw new ConfigurationError(
        `${name} must be between ${min} and ${max}`,
        { name, value, min, max }
      );
    }
    return value;
  }
  
  /**
   * Validate type
   */
  static ofType<T>(
    value: any,
    type: string,
    name: string
  ): T {
    if (typeof value !== type) {
      throw new ConfigurationError(
        `${name} must be of type ${type}`,
        { name, value, expectedType: type, actualType: typeof value }
      );
    }
    return value as T;
  }
  
  /**
   * Validate function
   */
  static isFunction<T extends Function>(value: any, name: string): T {
    if (typeof value !== 'function') {
      throw new ConfigurationError(
        `${name} must be a function`,
        { name, value }
      );
    }
    return value as T;
  }
  
  /**
   * Validate element
   */
  static isHTMLElement(value: any, name: string): HTMLElement {
    if (!(value instanceof HTMLElement)) {
      throw new ConfigurationError(
        `${name} must be an HTMLElement`,
        { name, value }
      );
    }
    return value;
  }
}

/**
 * Assert utilities for runtime checks
 */
export class Assert {
  /**
   * Assert condition is true
   */
  static true(condition: boolean, message: string, context?: Record<string, any>): void {
    if (!condition) {
      throw new InvalidStateError(message, context);
    }
  }
  
  /**
   * Assert condition is false
   */
  static false(condition: boolean, message: string, context?: Record<string, any>): void {
    if (condition) {
      throw new InvalidStateError(message, context);
    }
  }
  
  /**
   * Assert value is defined
   */
  static defined<T>(value: T | undefined | null, message: string): T {
    if (value === undefined || value === null) {
      throw new InvalidStateError(message, { value });
    }
    return value;
  }
  
  /**
   * Assert value is within bounds
   */
  static inBounds(
    value: number,
    min: number,
    max: number,
    message: string
  ): void {
    if (value < min || value > max) {
      throw new BoundaryError(message, { value, min, max });
    }
  }
}
