import { describe, expect, it } from 'vitest';
import { clientToField, segPointDist } from './geom';

describe('segPointDist (swept collision primitive)', () => {
  it('returns the perpendicular distance when the foot lies inside the segment', () => {
    expect(segPointDist(0, 0, -100, 5, 100, 5)).toBeCloseTo(5);
  });
  it('clamps to the nearest endpoint when the foot lies outside', () => {
    expect(segPointDist(0, 0, 10, 0, 20, 0)).toBeCloseTo(10);
    expect(segPointDist(0, 0, 3, 4, 3, 4)).toBeCloseTo(5); // degenerate segment
  });
  it('catches tunneling: endpoints far away but the path crosses the circle', () => {
    const R = 15;
    const dPrev = Math.hypot(-300, 4), dCur = Math.hypot(300, 4);
    expect(dPrev).toBeGreaterThan(R);
    expect(dCur).toBeGreaterThan(R);
    expect(segPointDist(0, 0, -300, 4, 300, 4)).toBeLessThanOrEqual(R);
  });
});

describe('clientToField (pointer → 960×540 logical coordinates)', () => {
  it('maps a half-size canvas without drift', () => {
    const rect = { left: 100, top: 50, width: 480, height: 270 };
    expect(clientToField(100, 50, rect, 960, 540)).toEqual({ x: 0, y: 0 });
    expect(clientToField(340, 185, rect, 960, 540)).toEqual({ x: 480, y: 270 });
    expect(clientToField(580, 320, rect, 960, 540)).toEqual({ x: 960, y: 540 });
  });
  it('maps an upscaled canvas (1.5×) and positions outside the canvas', () => {
    const rect = { left: 0, top: 0, width: 1440, height: 810 };
    expect(clientToField(720, 405, rect, 960, 540)).toEqual({ x: 480, y: 270 });
    expect(clientToField(-30, 900, rect, 960, 540)).toEqual({ x: -20, y: 600 });
  });
});
