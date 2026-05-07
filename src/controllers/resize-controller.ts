/**
 * @fileoverview Container + window resize observer for CeriousScroll.
 *
 * Detects size changes that affect the virtual viewport via two channels:
 *  - `ResizeObserver` on the container element (fires for layout/CSS-driven
 *    changes that never trigger a window resize, e.g. flex/grid reflows,
 *    media-query branches, JS-driven sizing).
 *  - `window.resize` as a fallback for environments without ResizeObserver
 *    and to catch viewport-level changes (zoom, orientation).
 */

export class ResizeController {
  constructor(private readonly onViewportChange: (container: HTMLElement) => void) {}

  attach(container: HTMLElement): () => void {
    const cleanups: Array<() => void> = [];

    // Always listen to window.resize so existing behavior/tests keep working
    // and to handle environments without ResizeObserver.
    const windowHandler = () => this.onViewportChange(container);
    window.addEventListener('resize', windowHandler);
    cleanups.push(() => window.removeEventListener('resize', windowHandler));

    // Observe the container itself for size mutations that don't bubble up
    // as a window resize (CSS-driven, parent layout, programmatic sizing).
    if (typeof ResizeObserver !== 'undefined') {
      let lastWidth = container.clientWidth;
      let lastHeight = container.clientHeight;
      let firstObservation = true;

      const ro = new ResizeObserver(() => {
        // ResizeObserver fires once on observe(); ignore that synthetic event
        // so we don't double-trigger on attach.
        if (firstObservation) {
          firstObservation = false;
          lastWidth = container.clientWidth;
          lastHeight = container.clientHeight;
          return;
        }

        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === lastWidth && h === lastHeight) return;
        lastWidth = w;
        lastHeight = h;
        this.onViewportChange(container);
      });

      try {
        ro.observe(container);
        cleanups.push(() => ro.disconnect());
      } catch {
        // Defensive: if observe throws (detached node etc.), ignore.
      }
    }

    return () => {
      for (let i = 0; i < cleanups.length; i++) {
        try {
          cleanups[i]();
        } catch {
          // Continue cleaning up remaining handles even if one throws.
        }
      }
    };
  }
}
