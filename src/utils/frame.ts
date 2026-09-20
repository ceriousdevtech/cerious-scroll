/**
 * Copyright (c) 2024-2026 Cerious DevTech LLC. All rights reserved.
 *
 * Frame scheduling with a non-DOM fallback.
 *
 * The engine is import-safe without a DOM — nothing touches `window` at module
 * scope — so anything that schedules work has to cope with `requestAnimationFrame`
 * being absent. Kept in one place because three separate copies of the same
 * four-line guard had already appeared.
 */

/** Schedule a callback for the next frame, or shortly after without a DOM. */
export function raf(cb: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
}

/** Cancel a handle from {@link raf}. */
export function caf(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}
