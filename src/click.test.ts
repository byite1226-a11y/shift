import { describe, expect, it } from 'vitest';
import { CONFIG, PATTERNS, type Config } from './config';
import { clientToField } from './geom';
import { Sim, type Input } from './sim';

/** C-mode click judgement around the 15 px rule (Gate 02 §5). Mechanics unchanged; this pins them down. */
const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };
const R = CONFIG.defend.clickTargetHitRadiusPx;
const clickAt = (x: number, y: number): Input => ({ keys: new Set(), pointer: { x, y }, clicks: [{ x, y }] });

function playingC() {
  const s = new Sim('C', 1, noSpawns, { schedule: 'g1' }); // Gate 01 defend rules (1 HP) under test here
  s.begin();
  for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle);
  expect(s.phase).toBe('PLAYING');
  return s;
}
const dart = (x: number, y: number, speed = 150) => {
  const dx = 480 - x, dy = 270 - y, l = Math.hypot(dx, dy);
  return { id: 1, x, y, px: x, py: y, vx: (dx / l) * speed, vy: (dy / l) * speed, speed, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', spawnT: 0, visibleFromT: 0, minDist: Infinity, nearMissDone: false };
};

describe('C: click boundary (15 px from the dart centre, inclusive)', () => {
  it.each([
    [14.9, true],
    [15, true],
    [15.1, false],
  ])('a static click %s px away → hit=%s', (d, hit) => {
    const s = playingC();
    s.projectiles.push(dart(680, 270));
    const ang = 0; // axis-aligned so 15.0 is exactly representable
    s.frame(0, clickAt(680 + Math.cos(ang) * d, 270 + Math.sin(ang) * d)); // dt 0: no world step, pure judgement
    expect(s.counters.hits).toBe(hit ? 1 : 0);
    expect(s.counters.misses).toBe(hit ? 0 : 1);
    expect(s.projectiles.length).toBe(hit ? 0 : 1);
  });

  it('moving target: a click on where the dart was one 60 Hz frame ago hits; five frames ago (≈15.4 px at 205 px/s) misses', () => {
    const s = playingC();
    const d = dart(680, 270, 205);
    s.projectiles.push(d);
    const seen = { x: d.x, y: d.y };
    s.frame(1000 / 60, idle);               // 3 steps → 3.1 px of travel since the player saw it
    s.frame(1000 / 60, clickAt(seen.x, seen.y));
    expect(s.counters.hits).toBe(1);

    const s2 = playingC();
    const d2 = dart(680, 270, 205);
    s2.projectiles.push(d2);
    const seen2 = { x: d2.x, y: d2.y };
    for (let i = 0; i < 5; i++) s2.frame(1000 / 60, idle); // 15 steps → 15.4 px
    s2.frame(1000 / 60, clickAt(seen2.x, seen2.y));
    expect(s2.counters.hits).toBe(0);
    expect(s2.counters.misses).toBe(1);
  });

  it('the boundary survives the screen transform at 0.5× and 1.5×: 15 px hits, 16 px misses', () => {
    for (const scale of [0.5, 1.5]) {
      const rect = { left: 37, top: 11, width: 960 * scale, height: 540 * scale };
      for (const [d, hit] of [[15, true], [16, false]] as const) {
        const s = playingC();
        s.projectiles.push(dart(680, 270));
        const c = clientToField(rect.left + (680 + d) * scale, rect.top + 270 * scale, rect, 960, 540);
        s.frame(0, { keys: new Set(), pointer: c, clicks: [c] });
        expect(s.counters.hits, `scale ${scale}, ${d} px`).toBe(hit ? 1 : 0);
      }
    }
  });

  it('documents the mismatch: the visible dart (9.5 × 1.8 px half-extents) is far smaller than the 15 px click zone', () => {
    const k = PATTERNS.projectileKinds.normal;
    expect(k.lengthPx / 2).toBeLessThan(R);
    expect(k.widthPx / 2).toBeLessThan(R);
    expect(R - k.widthPx / 2).toBeGreaterThan(13); // Gate 02.1 draws the 15 px ring itself in C, so outline == judgement
  });

  it('a click is judged against the positions drawn in the previous frame, at any frame rate (no world step in between)', () => {
    for (const dt of [1000 / 144, 1000 / 60, 50]) {
      const s = playingC();
      const d = dart(760, 120, 205);
      s.projectiles.push(d);
      s.frame(dt, idle);                      // frame N steps the world, then the app renders it
      const drawn = { x: d.x, y: d.y };       // what the player sees until the next frame
      s.frame(dt, clickAt(drawn.x, drawn.y)); // frame N+1 judges the click before stepping
      expect(s.log.find((e) => e.type === 'hit')!.dist, `dt ${dt}`).toBe(0);
    }
  });
});
