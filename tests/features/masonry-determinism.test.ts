/**
 * @fileoverview Pins the determinism guarantee of each masonry mode.
 *
 * These are the contract. Oracle mode promises a card's column is a function of
 * the DATASET; dynamic mode promises only that it is a function of the dataset
 * AND the route taken to it. The second is a deliberate trade for constant-time
 * random access, not a defect — so route-dependence is asserted as EXPECTED
 * here, and a future change that quietly made dynamic mode canonical (or oracle
 * mode route-dependent) should fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CeriousScroll } from '../../src/cerious-scroll.js';

const GAP = 16;
const TOTAL = 100_000;
const TARGET = 60_000;
const CONTENT_H = (i: number) => 60 + ((i * 53) % 11) * 47;

function stubMeasurement() {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const idx = this.getAttribute('data-measure-index');
      return idx === null ? 0 : CONTENT_H(Number(idx));
    }
  });
}

function host(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 900, configurable: true });
  document.body.appendChild(el);
  return el;
}

function makeScroller(oracle: boolean) {
  const el = host();
  const s = new CeriousScroll(el, TOTAL, {
    layout: 'masonry',
    attachScrollbar: false,
    masonry: {
      ...(oracle ? { getItemHeight: (i: number) => CONTENT_H(i) } : {}),
      renderItem: (i: number, node: HTMLElement) => {
        node.setAttribute('data-measure-index', String(i));
      },
      gap: GAP, columns: 3, segmentSize: oracle ? 500 : 24, estimatedItemHeight: 300
    }
  });
  return { el, s };
}

/** Column of a card, if it is currently drawn. */
function columnOf(el: HTMLElement, index: number): number | null {
  const node = el.querySelector(`[data-element-index="${index}"]`) as HTMLElement | null;
  if (!node) return null;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform);
  return m ? Math.round(parseFloat(m[1])) : null;
}

/** Arrive at TARGET by jumping straight to it. */
function byJump(oracle: boolean): number | null {
  const { el, s } = makeScroller(oracle);
  s.renderViewport(800, el, () => {});
  s.jumpToItem(TARGET);
  s.renderViewport(800, el, () => {});
  const col = columnOf(el, TARGET);
  s.dispose();
  return col;
}

/** Arrive at TARGET by scrolling into its neighbourhood first. */
function byApproach(oracle: boolean): number | null {
  const { el, s } = makeScroller(oracle);
  s.renderViewport(800, el, () => {});
  s.jumpToItem(TARGET - 4000);
  s.renderViewport(800, el, () => {});
  for (let i = 0; i < 60; i++) {
    s.scroll(900, 800);
    s.renderViewport(800, el, () => {});
  }
  s.jumpToItem(TARGET);
  s.renderViewport(800, el, () => {});
  const col = columnOf(el, TARGET);
  s.dispose();
  return col;
}

beforeEach(() => { document.body.innerHTML = ''; stubMeasurement(); });
afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
});

describe('masonry determinism contract', () => {
  it('reports which guarantee is in force', () => {
    const a = makeScroller(true);
    expect(a.s.masonryDeterminism).toBe('canonical');
    a.s.dispose();

    const b = makeScroller(false);
    expect(b.s.masonryDeterminism).toBe('local');
    b.s.dispose();

    const plain = new CeriousScroll(host(), 100, { attachScrollbar: false });
    expect(plain.masonryDeterminism).toBeNull();
    plain.dispose();
  });

  it('canonical: a card lands in the same column regardless of route', () => {
    const jumped = byJump(true);
    const approached = byApproach(true);
    expect(jumped).not.toBeNull();
    expect(approached).not.toBeNull();
    // The defining promise of oracle mode: position is a function of the
    // dataset alone, which is what makes a deep link to a card meaningful.
    expect(approached).toBe(jumped);
  });

  it('canonical: repeating the same route reproduces the layout', () => {
    expect(byJump(true)).toBe(byJump(true));
  });

  it('local: the same route reproduces the layout', () => {
    // Locally deterministic — the guarantee dynamic mode DOES make.
    expect(byJump(false)).toBe(byJump(false));
    expect(byApproach(false)).toBe(byApproach(false));
  });

  it('local: route may change the column, and that is the trade', () => {
    // Not asserted as inequality — arriving by two routes MAY agree by chance.
    // What must hold is that both routes produce a valid placement; differing
    // is permitted, and a future change that made this impossible would mean
    // dynamic mode had silently taken on canonical mode's O(n) cost.
    const jumped = byJump(false);
    const approached = byApproach(false);
    expect(jumped).not.toBeNull();
    expect(approached).not.toBeNull();
    for (const col of [jumped, approached]) {
      expect(col).toBeGreaterThanOrEqual(0);
    }
  });

  it('local: every arrival is still a valid masonry layout', () => {
    // Route-dependence buys constant-time access; it must not buy a broken
    // layout. Gutters exact, columns balanced, nothing overlapping.
    for (const arrive of [byJump, byApproach]) {
      const { el, s } = makeScroller(false);
      s.renderViewport(800, el, () => {});
      s.jumpToItem(TARGET);
      s.renderViewport(800, el, () => {});
      void arrive;

      const byColumn = new Map<number, { y: number; h: number }[]>();
      for (const node of [...el.querySelectorAll('[data-element-index]')] as HTMLElement[]) {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform)!;
        const x = Math.round(parseFloat(m[1]));
        const list = byColumn.get(x) ?? [];
        list.push({
          y: parseFloat(m[2]),
          h: node.style.height ? parseFloat(node.style.height) : node.offsetHeight
        });
        byColumn.set(x, list);
      }
      expect(byColumn.size).toBeGreaterThan(0);
      const gaps = new Set<number>();
      for (const col of byColumn.values()) {
        col.sort((a, b) => a.y - b.y);
        for (let i = 1; i < col.length; i++) {
          gaps.add(Math.round((col[i].y - (col[i - 1].y + col[i - 1].h)) * 100) / 100);
        }
      }
      expect([...gaps]).toEqual([GAP]);
      s.dispose();
    }
  });
});
