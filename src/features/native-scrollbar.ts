/**
 * @fileoverview Native Scrollbar Integration Module for CeriousScroll
 * 
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 * PATENT PENDING - U.S. Provisional Patent Application Filed October 2025
 * 
 * This module handles native browser scrollbar integration for virtual scrolling.
 * Provides smooth synchronization between virtual scroll position and native scrollbar.
 */

import { NavigationEngine } from '../engine/navigation-engine.js';

/**
 * Native Scrollbar Manager for CeriousScroll
 * 
 * Manages native browser scrollbar integration, automatic width detection,
 * and bidirectional synchronization with virtual scroll position.
 */
export class NativeScrollbar {
  // Constants for scrollbar behavior
  private static readonly DEFAULT_SCROLLBAR_WIDTH = 17;
  private static readonly DEFAULT_Z_INDEX = 10;
  private static readonly ELEMENT_HEIGHT_MULTIPLIER = 10;
  private static readonly PROGRAMMATIC_UPDATE_GRACE_PERIOD_MS = 50;
  private static readonly BOTTOM_THRESHOLD_PERCENTAGE = 99;
  private static readonly PERCENTAGE_MAX = 100;

  private _scrollbarContainer: HTMLElement | null = null;
  private _syncingScrollbar = false;
  private _lastProgrammaticUpdate = 0;
  private _cachedScrollbarWidth: number | undefined = undefined;
  private _lastScrollTop: number = 0;
  private _lastRenderedElement: number = -1;
  private _lastRenderedOffset: number = -1;

  constructor(
    private totalElements: number,
    private getScrollPercentage: () => number,
    private getElementHeight: (index: number) => number,
    private onScrollPositionChange: (element: number, offset: number) => void,
    private scrollHandlers: NavigationEngine,
    private getViewportHeight: () => number,
    private getCurrentElement: () => number,
    private getScrollOffset: () => number,
    private getTrueBottomPosition: () => { element: number; offset: number } | null,
    private virtualTrackHeight: number = 10000000,
    private onRender?: (result: any) => void
  ) {}

  /**
   * Get the scrollbar container element
   */
  get container(): HTMLElement | null {
    return this._scrollbarContainer;
  }

  /**
   * Check if currently syncing scrollbar (to prevent infinite loops)
   */
  get isSyncing(): boolean {
    return this._syncingScrollbar;
  }

  /**
   * Update the last programmatic update timestamp
   */
  updateLastProgrammaticUpdate(): void {
    this._lastProgrammaticUpdate = Date.now();
  }

  /**
   * Dynamically detect the scrollbar width for the current browser/environment
   * This accounts for different browsers, OS settings, zoom levels, and custom CSS
   * 
   * @returns {number} The scrollbar width in pixels
   */
  private getScrollbarWidth(): number {
    // Return cached value if available (scrollbar width shouldn't change during session)
    if (this._cachedScrollbarWidth !== undefined) {
      return this._cachedScrollbarWidth;
    }

    // Create a temporary div to measure scrollbar width
    const outer = document.createElement('div');
    outer.style.cssText = 'visibility:hidden;width:100px;height:100px;overflow:scroll;position:absolute;top:-9999px;';
    document.body.appendChild(outer);
    
    const scrollbarWidth = outer.offsetWidth - outer.clientWidth;
    document.body.removeChild(outer);
    
    // Cache the result and return (fallback if detection fails)
    this._cachedScrollbarWidth = scrollbarWidth || NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH;
    return this._cachedScrollbarWidth;
  }

  /**
   * Clear cached scrollbar width (useful when zoom or display settings change)
   */
  clearScrollbarWidthCache(): void {
    this._cachedScrollbarWidth = undefined;
  }

  /**
   * Handle viewport changes that might affect scrollbar width (zoom, display settings, etc.)
   * Call this method when the viewport or container is resized
   * 
   * @param container The container element with the scrollbar
   * @param viewportHeight New viewport height
   */
  handleViewportChange(container: HTMLElement, viewportHeight: number): void {
    // Clear scrollbar width cache to force re-detection
    this.clearScrollbarWidthCache();
    
    // Re-attach scrollbar with new dimensions if one exists
    if (this._scrollbarContainer) {
      this.attachNativeScrollbar(container);
    }
  }

  /**
   * Set up automatic handling of viewport changes (window resize, zoom changes)
   * This ensures scrollbar width stays accurate when display settings change
   * 
   * @param container The container element with the scrollbar
   * @param onViewportChange Callback for when viewport changes
   * @returns A cleanup function to remove the resize listener
   */
  setupAutoResizeHandling(
    container: HTMLElement, 
    onViewportChange: (container: HTMLElement) => void
  ): () => void {
    const resizeHandler = () => onViewportChange(container);
    
    // Listen for window resize events
    window.addEventListener('resize', resizeHandler);
    
    // Return cleanup function
    return () => {
      window.removeEventListener('resize', resizeHandler);
    };
  }

  /**
   * Automatically attach a native scrollbar to the provided container
   * 
   * @param container Parent container to attach the scrollbar to
   */
  attachNativeScrollbar(container: HTMLElement): void {
    // Remove any existing scrollbar first since scrollbar properties depend on current data
    const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
    if (existingScrollbar) {
      existingScrollbar.remove();
    }

    // Use dynamic scrollbar width detection
    const detectedWidth = this.getScrollbarWidth();

    this._scrollbarContainer = this.createNativeScrollbar(container, {
      width: `${detectedWidth}px`,
      position: 'right',
      style: {
        background: '#f0f0f0',
        borderLeft: '1px solid #ccc',
        zIndex: String(NativeScrollbar.DEFAULT_Z_INDEX)
      }
    });
  }

  /**
   * Create and attach a native scrollbar that drives the virtual scrolling
   * 
   * Creates a hidden scrollable div with the same total content height as the virtual content.
   * When the user scrolls this native scrollbar, it drives the virtual viewport scrolling.
   * 
   * @param container Parent container to attach the scrollbar to
   * @param options Scrollbar configuration options
   * @returns The created scrollbar container element
   */
  createNativeScrollbar(container: HTMLElement, options: {
    width?: string;
    position?: 'left' | 'right';
    style?: Record<string, string>;
  } = {}): HTMLElement {
    // Remove any existing scrollbar first since we need to create one with current data
    const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
    if (existingScrollbar) {
      existingScrollbar.remove();
    }

    const { width = `${this.getScrollbarWidth()}px`, position = 'right', style = {} } = options;

    // Create scrollbar container
    const scrollbarContainer = document.createElement('div');
    scrollbarContainer.setAttribute('data-cerious-scrollbar', 'container');
    scrollbarContainer.style.cssText = `
      position: absolute;
      top: 0;
      ${position}: 0;
      width: ${width};
      height: 100%;
      overflow-y: scroll;
      overflow-x: hidden;
      z-index: ${style['zIndex'] || NativeScrollbar.DEFAULT_Z_INDEX};
      background: ${style['background'] || '#f0f0f0'};
      border-left: ${style['borderLeft'] || '1px solid #ccc'};
      pointer-events: auto;
    `;

    // Create scrollable content (sets scroll range based on element count, not heights)
    // Add +1 to ensure scrollbar can reach 100% (accounts for rounding/boundary conditions)
    const scrollableContent = document.createElement('div');
    scrollableContent.setAttribute('data-cerious-scrollbar', 'content');
    scrollableContent.style.cssText = `
      width: 1px;
      height: ${(this.totalElements + 1) * NativeScrollbar.ELEMENT_HEIGHT_MULTIPLIER}px;
      pointer-events: none;
    `;

    scrollbarContainer.appendChild(scrollableContent);

    // Position container relatively and ensure it can contain the scrollbar
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Add padding to container to make room for scrollbar and prevent overlap
    const scrollbarWidth = parseInt(width) || NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH;
    if (position === 'right') {
      const currentPaddingRight = parseInt(getComputedStyle(container).paddingRight) || 0;
      container.style.paddingRight = `${Math.max(currentPaddingRight, scrollbarWidth + 2)}px`;
    } else if (position === 'left') {
      const currentPaddingLeft = parseInt(getComputedStyle(container).paddingLeft) || 0;
      container.style.paddingLeft = `${Math.max(currentPaddingLeft, scrollbarWidth + 2)}px`;
    }

    container.appendChild(scrollbarContainer);

    // Bind scroll events - map scrollbar position directly to element index
    scrollbarContainer.addEventListener('scroll', (e) => {
      // Prevent infinite loop by checking if we're currently syncing
      if (this._syncingScrollbar) return;
      
      // Ignore scroll events that happen shortly after programmatic updates
      const timeSinceUpdate = Date.now() - this._lastProgrammaticUpdate;
      if (timeSinceUpdate < NativeScrollbar.PROGRAMMATIC_UPDATE_GRACE_PERIOD_MS) return;
      
      const scrollTop = scrollbarContainer.scrollTop;
      const maxScroll = scrollbarContainer.scrollHeight - scrollbarContainer.clientHeight;
      
      // Update last scroll position
      this._lastScrollTop = scrollTop;
      
      // Calculate percentage based on scrollbar position
      // Add tolerance for when scrollbar is at/near bottom (scrollbar thumb has minimum size)
      const BOTTOM_TOLERANCE_PX = 1; // pixels from bottom to treat as 100%
      let percentage: number;
      if (maxScroll > 0) {
        if (scrollTop >= maxScroll - BOTTOM_TOLERANCE_PX) {
          percentage = NativeScrollbar.PERCENTAGE_MAX; // Treat as 100%
        } else {
          percentage = (scrollTop / maxScroll) * NativeScrollbar.PERCENTAGE_MAX;
        }
      } else {
        percentage = 0;
      }
      
      // Set flag to prevent sync loop
      this._syncingScrollbar = true;
      
      // Get the true bottom position based on measured elements
      const trueBottom = this.getTrueBottomPosition();
      
      // Calculate target position based on percentage
      // Map 0% to element 0 offset 0, and 100% to the true bottom position
      let targetElement: number;
      let targetOffset: number;
      
      if (trueBottom) {
        // Linear interpolation between 0% (element 0, offset 0) and 100% (true bottom)
        // Convert true bottom to a scalar position for interpolation
        const trueBottomPosition = trueBottom.element + (trueBottom.offset / this.getElementHeight(trueBottom.element));
        const targetPosition = (percentage / NativeScrollbar.PERCENTAGE_MAX) * trueBottomPosition;
        
        targetElement = Math.floor(targetPosition);
        const targetProgress = targetPosition - targetElement;
        const targetElementHeight = this.getElementHeight(targetElement);
        targetOffset = Math.round(targetProgress * targetElementHeight);
      } else {
        // Fallback to old behavior if true bottom not available
        const targetIndexPosition = (percentage / NativeScrollbar.PERCENTAGE_MAX) * (this.totalElements - 1);
        targetElement = Math.floor(targetIndexPosition);
        const targetProgress = targetIndexPosition - targetElement;
        const targetElementHeight = this.getElementHeight(targetElement);
        targetOffset = Math.round(targetProgress * targetElementHeight);
      }
      
      // Check if position actually changed before doing expensive operations
      const currentElement = this.getCurrentElement();
      const currentOffset = this.getScrollOffset();
      
      if (targetElement !== currentElement || targetOffset !== currentOffset) {
        // Position changed - update scroll position
        const result = this.scrollHandlers.jumpToPosition(targetElement, targetOffset, true);
        
        this._lastRenderedElement = result.element;
        this._lastRenderedOffset = result.offset;
        
        // Trigger a custom event
        // GC optimization: Create detail object inline (less frequent than scroll events)
        container.dispatchEvent(new CustomEvent('viewport-change', {
          detail: { element: result.element, scrollOffset: result.offset, percentage }
        }));
        
        // Trigger render callback - this is what actually updates the DOM
        if (this.onRender) {
          this.onRender(result);
        }
      }
      
      // Clear flag after handling
      this._syncingScrollbar = false;
    }); // End scroll event listener

    this._scrollbarContainer = scrollbarContainer;
    return scrollbarContainer;
  }

  /**
   * Synchronize native scrollbar position with virtual scroll position
   * 
   * @param scrollbarContainer The scrollbar container element
   */
  syncNativeScrollbar(scrollbarContainer?: HTMLElement): void {
    const container = scrollbarContainer || this._scrollbarContainer;
    if (!container || this._syncingScrollbar) return;

    const percentage = this.getScrollPercentage();
    const maxScroll = container.scrollHeight - container.clientHeight;
    const targetScrollTop = (percentage / NativeScrollbar.PERCENTAGE_MAX) * maxScroll;

    // Prevent infinite loop by checking if we need to update
    if (Math.abs(container.scrollTop - targetScrollTop) > 1) {
      this._syncingScrollbar = true;
      container.scrollTop = targetScrollTop;
      // Update lastScrollTop to match the new position
      this._lastScrollTop = targetScrollTop;
      this._syncingScrollbar = false;
    }
  }

  /**
   * Update native scrollbar content height when dataset changes
   * 
   * @param totalElements New total number of elements
   * @param scrollbarContainer The scrollbar container element (optional)
   */
  updateNativeScrollbarHeight(totalElements: number, scrollbarContainer?: HTMLElement): void {
    this.totalElements = totalElements;
    const container = scrollbarContainer || this._scrollbarContainer;
    if (!container) return;

    const scrollableContent = container.querySelector('[data-cerious-scrollbar="content"]') as HTMLElement;
    if (scrollableContent) {
      // Use element count for scroll height, not content height
      scrollableContent.style.height = (totalElements * NativeScrollbar.ELEMENT_HEIGHT_MULTIPLIER) + 'px';
    }
  }

  /**
   * Detach and remove the native scrollbar from the container
   * 
   * This is useful for cleanup when the CeriousScroll instance is no longer needed.
   * Note: Creating a new CeriousScroll instance will automatically replace any existing scrollbar.
   * 
   * @param container The container to remove the scrollbar from
   */
  detachScrollbar(container?: HTMLElement): void {
    if (this._scrollbarContainer) {
      // Find the parent container to restore padding
      const parentContainer = this._scrollbarContainer.parentElement;
      
      this._scrollbarContainer.remove();
      this._scrollbarContainer = null;
      
      // Restore original padding if we can identify the container
      if (parentContainer) {
        // Reset padding that was added for scrollbar
        // Note: This is a simple reset - in production you might want to store original values
        if (parentContainer.style.paddingRight && 
            parseInt(parentContainer.style.paddingRight) >= NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH) {
          const currentPadding = parseInt(parentContainer.style.paddingRight);
          parentContainer.style.paddingRight = `${Math.max(0, currentPadding - 19)}px`; // 17px + 2px border
        }
      }
    } else if (container) {
      // If no tracked scrollbar, try to find and remove any existing scrollbar
      const existingScrollbar = container.querySelector('[data-cerious-scrollbar="container"]');
      if (existingScrollbar) {
        existingScrollbar.remove();
        
        // Also restore padding for this case
        if (container.style.paddingRight && 
            parseInt(container.style.paddingRight) >= NativeScrollbar.DEFAULT_SCROLLBAR_WIDTH) {
          const currentPadding = parseInt(container.style.paddingRight);
          container.style.paddingRight = `${Math.max(0, currentPadding - 19)}px`;
        }
      }
    }
  }
}