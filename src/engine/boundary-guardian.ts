/**
 * @fileoverview BoundaryGuardian keeps navigation within dataset bounds.
 */

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

  constructor(private readonly deps: BoundaryGuardianDeps) {
    this.overshootThreshold = deps.overshootThreshold ?? 2;
    this.dampingFactor = deps.dampingFactor ?? 0.9;
    this.smallDatasetThreshold = deps.smallDatasetThreshold ?? 1000;
    this.nearBottomThreshold = deps.nearBottomThreshold ?? 100;
  }

  shouldClamp(element: number): boolean {
    const total = this.deps.getTotalElements();
    return total <= this.smallDatasetThreshold || element >= Math.max(0, total - this.nearBottomThreshold);
  }

  correctBottomOvershoot(element: number, offset: number): { element: number; offset: number } | null {
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

    let remainingGap = overshootAmount * this.dampingFactor;
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
