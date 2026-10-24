/** mulberry32: tiny seeded PRNG, deterministic across browsers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Numeric strings are used as-is; anything else is hashed (FNV-1a) so "test-3" is a valid seed too. */
export function seedFromString(s: string): number {
  const trimmed = s.trim();
  const n = Number(trimmed);
  if (trimmed !== '' && Number.isInteger(n) && n >= 0) return n >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const randomSeed = () => Math.floor(Math.random() * 1e9);
