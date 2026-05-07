/**
 * @fileoverview Content observation utilities for CeriousScroll
 *
 * Watches rendered DOM elements for size mutations so cached measurements stay
 * in sync without bloating the main CeriousScroll class.
 */

interface ContentObserverDeps {
  getMeasuredHeight: (index: number) => number | undefined;
  setMeasuredHeight: (index: number, height: number) => void;
  invalidateCache: () => void;
}

export class ContentObserverManager {
  // Track a single observation per container to prevent observer leaks if
  // observe() is called more than once on the same element. Refcounted so
  // multiple consumers can share a single underlying observer pair.
  private readonly _activeObservations = new WeakMap<
    HTMLElement,
    { refCount: number; cleanup: () => void }
  >();

  constructor(private readonly deps: ContentObserverDeps) {}

  observe(container: HTMLElement): () => void {
    if (!container) return () => {};

    const existing = this._activeObservations.get(container);
    if (existing) {
      existing.refCount++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        existing.refCount--;
        if (existing.refCount <= 0) {
          existing.cleanup();
          this._activeObservations.delete(container);
        }
      };
    }

    if (typeof ResizeObserver === 'undefined') {
      return () => {};
    }

    const observedElements = new Set<Element>();
    const resizeObserver = new ResizeObserver((entries) => {
      let needsInvalidation = false;

      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const indexAttr = element.getAttribute('data-element-index');
        if (indexAttr === null) {
          continue;
        }

        const index = parseInt(indexAttr, 10);
        if (Number.isNaN(index)) {
          continue;
        }

        const cachedHeight = this.deps.getMeasuredHeight(index);
        const newHeight = entry.contentRect.height;
        // Defensive: ResizeObserver should always give a finite number, but
        // guard against zero/negative which would corrupt the height cache.
        if (!Number.isFinite(newHeight) || newHeight < 0) continue;

        if (cachedHeight !== undefined && Math.abs(cachedHeight - newHeight) > 0.5) {
          this.deps.setMeasuredHeight(index, newHeight);
          needsInvalidation = true;
        }
      }

      if (needsInvalidation) {
        this.deps.invalidateCache();
      }
    });

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element && node.hasAttribute('data-element-index') && !observedElements.has(node)) {
            try {
              resizeObserver.observe(node);
              observedElements.add(node);
            } catch {
              // Defensive: detached/invalid node. Ignore.
            }
          }
        });

        mutation.removedNodes.forEach((node) => {
          if (node instanceof Element && observedElements.has(node)) {
            try {
              resizeObserver.unobserve(node);
            } catch {
              // Already unobserved.
            }
            observedElements.delete(node);
          }
        });
      }
    });

    try {
      mutationObserver.observe(container, { childList: true, subtree: true });
    } catch {
      // Container is not a valid Node; observers are inert.
      resizeObserver.disconnect();
      return () => {};
    }

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      try { mutationObserver.disconnect(); } catch { /* noop */ }
      try { resizeObserver.disconnect(); } catch { /* noop */ }
      observedElements.clear();
    };

    const entry = { refCount: 1, cleanup };
    this._activeObservations.set(container, entry);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.cleanup();
        this._activeObservations.delete(container);
      }
    };
  }
}
