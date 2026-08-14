/** Pulls the camera back when empty space appears under the last row. */

interface BoundaryGuardianDeps {
  getViewportHeight: () => number;
  getTotalElements: () => number;
  getElementViewportPosition: (index: number) => { top: number; bottom: number; isVisible: boolean };
  getElementHeight: (index: number) => number;
  overshootThreshold?: number;
  dampingFactor?: number;
  smallDatasetThreshold?: number;
  nearBottomThreshold?: number;
}

export class BoundaryGuardian {
  private readonly overshootThreshold: number;
  private readonly dampingFactor: number;
  private readonly smallDatasetThreshold: number;
  private readonly nearBottomThreshold: number;

  /**
   * @param deps Viewport size, dataset length, and per-row geometry.
   */
  constructor(private readonly deps: BoundaryGuardianDeps) {
    this.overshootThreshold = deps.overshootThreshold ?? 2;
    this.dampingFactor = deps.dampingFactor ?? 0.9;
    this.smallDatasetThreshold = deps.smallDatasetThreshold ?? 1000;
    this.nearBottomThreshold = deps.nearBottomThreshold ?? 100;
  }

  /**
   * @param element Current camera index.
   * @returns Whether bottom clamping should run (small lists, or near the end).
   */
  shouldClamp(element: number): boolean {
    const total = this.deps.getTotalElements();
    return total <= this.smallDatasetThreshold || element >= Math.max(0, total - this.nearBottomThreshold);
  }

  /**
   * If the last element's bottom sits above the viewport bottom (i.e. there is
   * empty space below the content), pull the scroll position back up to close
   * the gap. `damping` controls how much of the gap is closed in one call
   * (default {@link dampingFactor} for smooth wheel/touch correction; pass `1`
   * for a full re-anchor, e.g. after a container resize that revealed space).
   *
   * @param element Current camera element.
   * @param offset Current pixel offset into that element.
   * @param damping Fraction of the gap to close (`1` = full). Default 0.9.
   * @returns Corrected `{ element, offset }`, or `null` if no overshoot.
   */
  correctBottomOvershoot(
    element: number,
    offset: number,
    damping: number = this.dampingFactor
  ): { element: number; offset: number } | null {
    const total = this.deps.getTotalElements();
    if (total <= 0) {
      return null;
    }

    const lastElementPosition = this.deps.getElementViewportPosition(total - 1);
    const viewportHeight = this.deps.getViewportHeight();
    const overshootAmount = viewportHeight - lastElementPosition.bottom;

    if (overshootAmount <= this.overshootThreshold) {
      return null;
    }

    let remainingGap = overshootAmount * damping;
    let correctedElement = element;
    let correctedOffset = offset;

    while (remainingGap > 0.5 && (correctedElement > 0 || correctedOffset > 0)) {
      if (correctedOffset >= remainingGap) {
        correctedOffset -= remainingGap;
        remainingGap = 0;
      } else {
        remainingGap -= correctedOffset;
        if (correctedElement > 0) {
          correctedElement--;
          correctedOffset = Math.max(0, this.deps.getElementHeight(correctedElement) - 1);
        } else {
          correctedOffset = 0;
          remainingGap = 0;
        }
      }
    }

    const correctedHeight = Math.max(1, this.deps.getElementHeight(correctedElement));
    correctedOffset = Math.max(0, Math.min(correctedOffset, correctedHeight - 1));
    return { element: correctedElement, offset: correctedOffset };
  }
}
