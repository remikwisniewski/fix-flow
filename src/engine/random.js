// @ts-check
// Seeded random numbers (mulberry32). The bots draw from this so a simulation can be
// replayed exactly, which is what makes their behaviour testable.

/**
 * @param {number} seed
 * @returns {() => number} A function returning floats in [0, 1).
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience helpers over a uniform source. */
export class Random {
  /** @param {number} seed */
  constructor(seed) {
    this.next = mulberry32(seed);
  }

  /** Integer in [min, max], inclusive. */
  int(/** @type {number} */ min, /** @type {number} */ max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(/** @type {number} */ probability) {
    return this.next() < probability;
  }

  /**
   * @template T
   * @param {readonly T[]} items
   * @returns {T}
   */
  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Roughly normal with mean 0 and standard deviation 1 (sum of uniforms). */
  gaussian() {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    return (sum - 3) / Math.sqrt(0.5);
  }
}
