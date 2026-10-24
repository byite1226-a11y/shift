export interface Vec { x: number; y: number }

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Shortest distance from point P to segment A→B. Used for swept (tunneling-safe) circle tests. */
export function segPointDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

export interface Rect { left: number; top: number; width: number; height: number }

/** Browser client coordinates → logical field coordinates (the canvas keeps the 960:540 ratio, so one scale per axis). */
export function clientToField(clientX: number, clientY: number, rect: Rect, fieldW: number, fieldH: number): Vec {
  return {
    x: (clientX - rect.left) * (fieldW / rect.width),
    y: (clientY - rect.top) * (fieldH / rect.height),
  };
}
