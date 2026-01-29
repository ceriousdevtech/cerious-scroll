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
  constructor(private readonly deps: ContentObserverDeps) {}

  observe(container: HTMLElement): () => void {
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
            resizeObserver.observe(node);
            observedElements.add(node);
          }
        });

        mutation.removedNodes.forEach((node) => {
          if (node instanceof Element && observedElements.has(node)) {
            resizeObserver.unobserve(node);
            observedElements.delete(node);
          }
        });
      }
    });

    mutationObserver.observe(container, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      observedElements.clear();
    };
  }
}
