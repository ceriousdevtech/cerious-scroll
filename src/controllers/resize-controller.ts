/**
 * @fileoverview Window resize observer for CeriousScroll.
 */

export class ResizeController {
  constructor(private readonly onViewportChange: (container: HTMLElement) => void) {}

  attach(container: HTMLElement): () => void {
    const handler = () => this.onViewportChange(container);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }
}
