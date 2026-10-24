import { describe, expect, it } from 'vitest';
import { CONFIG, type Config } from './config';
import { MAX_FRAME_MS, Sim, STEP_MS, type Input, type Mode } from './sim';

const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
const mouseAt = (x: number, y: number, clicks: { x: number; y: number }[] = []): Input => ({ keys: new Set(), pointer: { x, y }, clicks });

function playing(mode: Mode, seed = 1, cfg: Config = CONFIG) {
  const s = new Sim(mode, seed, cfg, { schedule: mode === 'C' ? 'g1' : 'g2' }); // Gate 01/02 rules under test here
  s.begin();
  run(s, 1000, idle); // countdown elapses over ordinary frames (a single big frame is clamped on purpose)
  expect(s.phase).toBe('PLAYING');
  expect(s.t).toBe(0);
  return s;
}
function run(s: Sim, ms: number, input: Input, dt = 1000 / 60) {
  const n = Math.round(ms / dt);
  for (let i = 0; i < n; i++) s.frame(dt, input);
}
const count = (s: Sim, type: string) => s.log.filter((e) => e.type === type).length;
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };

describe('state machine & time', () => {
  it('READY → COUNTDOWN(1 s) → PLAYING', () => {
    const s = new Sim('A', 1, CONFIG);
    expect(s.phase).toBe('READY');
    s.begin();
    expect(s.phase).toBe('COUNTDOWN');
    run(s, 500, idle);
    expect(s.phase).toBe('COUNTDOWN');
    run(s, 500, idle);
    expect(s.phase).toBe('PLAYING');
  });

  it('game time is frame-rate independent (60 Hz vs 144 Hz give the same world)', () => {
    const a = playing('A'), b = playing('A');
    run(a, 2000, keysOf('KeyD'), 1000 / 60);
    run(b, 2000, keysOf('KeyD'), 1000 / 144);
    expect(Math.abs(a.t - b.t)).toBeLessThanOrEqual(STEP_MS);
    expect(Math.abs(a.player.x - b.player.x)).toBeLessThanOrEqual(CONFIG.dodge.playerMoveSpeedPxPerSec * STEP_MS / 1000 + 1e-6);
    expect(a.counters.spawned).toBe(b.counters.spawned);
  });

  it('a huge frame (tab was hidden) cannot fast-forward the world', () => {
    const s = playing('A');
    s.frame(5000, idle);
    expect(s.t).toBeLessThanOrEqual(MAX_FRAME_MS);
  });

  it('paused: world time, spawns and inputs are frozen; resume continues', () => {
    const s = playing('A');
    run(s, 500, idle);
    const t = s.t, spawned = s.counters.spawned;
    s.pause();
    run(s, 2000, keysOf('KeyD'));
    expect(s.phase).toBe('PAUSED');
    expect(s.t).toBe(t);
    expect(s.counters.spawned).toBe(spawned);
    expect(s.player.x).toBe(CONFIG.world.width / 2);
    s.resume();
    run(s, 100, idle);
    expect(s.t).toBeGreaterThan(t);
    expect(count(s, 'pause')).toBe(1);
    expect(count(s, 'resume')).toBe(1);
  });

  it('surviving 40 s ends with CLEAR at exactly the round cap and keeps log buffers bounded', () => {
    const s = playing('A', 5, noSpawns);
    run(s, 41000, idle);
    expect(s.phase).toBe('FINISHED');
    expect(s.endReason).toBe('clear');
    expect(s.survivalMs).toBe(CONFIG.world.roundCapMs);
    expect(s.samples.length).toBeLessThanOrEqual(CONFIG.world.roundCapMs / 100 + 1);
    expect(count(s, 'spawn_skipped') + count(s, 'spawn_cancelled')).toBe(s.schedule.length); // telegraphed shots are cancelled at plan time
    expect(count(s, 'game_over')).toBe(1);
  });
});

describe('A / B: dodge rules', () => {
  it('A and B share max speed and hit radius (config)', () => {
    expect(CONFIG.dodge.mouseFollowMaxSpeedPxPerSec).toBe(CONFIG.dodge.playerMoveSpeedPxPerSec);
    expect(CONFIG.dodge.nearMissCenterDistanceMinPx).toBe(CONFIG.dodge.playerHitRadiusPx + CONFIG.dodge.projectileHitRadiusPx);
  });

  it('same seed → identical schedule and spawn times in A and B, whatever the input (origins: see patterns.test)', () => {
    const a = playing('A', 99), b = playing('B', 99);
    expect(a.schedule).toEqual(b.schedule);
    run(a, 12000, keysOf('KeyD', 'KeyS'));
    run(b, 12000, mouseAt(60, 60));
    const spawns = (s: Sim) => s.log.filter((e) => e.type === 'spawn').map((e) => [e.t, e.speed, e.kind]);
    const sa = spawns(a), sb = spawns(b);
    const n = Math.min(sa.length, sb.length);
    expect(n).toBeGreaterThan(0);
    expect(sa.slice(0, n)).toEqual(sb.slice(0, n));
  });

  it('A: diagonal movement is normalised to the max speed and clamps inside the field', () => {
    const s = playing('A', 1, noSpawns);
    run(s, 1000, keysOf('KeyD', 'KeyS'));
    const dx = s.player.x - 480, dy = s.player.y - 270;
    expect(Math.hypot(dx, dy)).toBeCloseTo(CONFIG.dodge.playerMoveSpeedPxPerSec, 0);
    expect(dx).toBeCloseTo(dy, 5);
    run(s, 5000, keysOf('ArrowRight'));
    expect(s.player.x).toBe(CONFIG.world.width - CONFIG.dodge.playerVisualRadiusPx);
  });

  it('B: a teleporting pointer never teleports the player; it approaches at max speed', () => {
    const s = playing('B', 1, noSpawns);
    s.frame(1000 / 60, mouseAt(900, 500)); // 3 steps = 15 ms
    const moved = Math.hypot(s.player.x - 480, s.player.y - 270);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(CONFIG.dodge.mouseFollowMaxSpeedPxPerSec * 0.015 + 1e-6);
    run(s, 3000, mouseAt(900, 500));
    expect(Math.hypot(s.player.x - 900, s.player.y - 500)).toBeLessThan(CONFIG.dodge.mouseArrivalTolerancePx);
  });

  it('B: stops within the arrival tolerance and clamps an off-field pointer to the field', () => {
    const s = playing('B', 1, noSpawns);
    run(s, 500, mouseAt(481.5, 270));
    expect(s.player.x).toBe(480);
    run(s, 10000, mouseAt(-500, 9999));
    const r = CONFIG.dodge.playerVisualRadiusPx;
    expect(Math.hypot(s.player.x - r, s.player.y - (CONFIG.world.height - r))).toBeLessThan(CONFIG.dodge.mouseArrivalTolerancePx);
  });

  it('a collision ends the round exactly once, even with two simultaneous hits', () => {
    const s = playing('A', 1, noSpawns);
    s.projectiles.push(
      { id: 1, x: 520, y: 270, px: 520, py: 270, vx: -205, vy: 0, speed: 205, spawnT: 0, minDist: Infinity, nearMissDone: false, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', visibleFromT: 0 },
      { id: 2, x: 440, y: 270, px: 440, py: 270, vx: 205, vy: 0, speed: 205, spawnT: 0, minDist: Infinity, nearMissDone: false, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', visibleFromT: 0 },
    );
    run(s, 400, idle);
    expect(s.phase).toBe('FINISHED');
    expect(s.endReason).toBe('hit');
    const t = s.survivalMs;
    expect(t).toBeGreaterThan(0);
    run(s, 400, keysOf('KeyD'));
    expect(s.survivalMs).toBe(t);
    expect(count(s, 'game_over')).toBe(1);
    expect(count(s, 'collision')).toBe(1);
  });

  it('a projectile fast enough to cross the player within one step still hits (sweep, no tunneling)', () => {
    const s = playing('A', 1, noSpawns);
    s.projectiles.push({ id: 1, x: 900, y: 272, px: 900, py: 272, vx: -200000, vy: 0, speed: 200000, spawnT: 0, minDist: Infinity, nearMissDone: false, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', visibleFromT: 0 });
    s.frame(STEP_MS, idle);
    expect(s.endReason).toBe('hit');
  });

  it('near miss fires once when a projectile passes within 30 px without touching', () => {
    const s = playing('A', 1, noSpawns);
    s.projectiles.push({ id: 1, x: 380, y: 250, px: 380, py: 250, vx: 200, vy: 0, speed: 200, spawnT: 0, minDist: Infinity, nearMissDone: false, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', visibleFromT: 0 });
    run(s, 4000, idle);
    expect(s.phase).toBe('PLAYING');
    expect(count(s, 'near_miss')).toBe(1);
    expect(s.log.find((e) => e.type === 'near_miss')!.dist).toBeCloseTo(20, 0);
    expect(s.projectiles.length).toBe(0); // culled after leaving the field
  });
});

describe('C: defend rules', () => {
  const dart = (x: number, y: number, speed = 150) => {
    const dx = 480 - x, dy = 270 - y, l = Math.hypot(dx, dy);
    return { id: 1, x, y, px: x, py: y, vx: (dx / l) * speed, vy: (dy / l) * speed, speed, spawnT: 0, minDist: Infinity, nearMissDone: false, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', visibleFromT: 0 };
  };

  it('a click within 15 px removes the target; a click on empty space is a logged miss and removes nothing', () => {
    const s = playing('C', 1, noSpawns);
    s.projectiles.push(dart(680, 270));
    s.frame(1000 / 60, mouseAt(100, 100, [{ x: 100, y: 100 }]));
    expect(s.projectiles.length).toBe(1);
    expect(s.counters.misses).toBe(1);
    expect(s.counters.hits).toBe(0);
    s.frame(1000 / 60, mouseAt(690, 274, [{ x: 690, y: 274 }])); // ~10 px from the dart
    expect(s.projectiles.length).toBe(0);
    expect(s.counters.hits).toBe(1);
    expect(count(s, 'click')).toBe(2);
    const hit = s.log.find((e) => e.type === 'hit')!;
    expect(hit.closeSave).toBe(false);
    expect(hit.threatTimeToCoreMs).toBeGreaterThan(1000);
    expect(s.phase).toBe('PLAYING');
  });

  it('a click 16 px away is a miss', () => {
    const s = playing('C', 1, noSpawns);
    s.projectiles.push(dart(680, 270));
    s.frame(1000 / 60, mouseAt(696.5, 270, [{ x: 696.5, y: 270 }]));
    expect(s.projectiles.length).toBe(1);
    expect(s.counters.misses).toBe(1);
  });

  it('removing a target with < 350 ms left to the core is a close save', () => {
    const s = playing('C', 1, noSpawns);
    const reach = CONFIG.defend.coreHitRadiusPx + CONFIG.dodge.projectileHitRadiusPx;
    s.projectiles.push(dart(480 + reach + 150 * 0.3, 270, 150)); // 300 ms out
    s.frame(0, mouseAt(0, 0, [{ x: 480 + reach + 45, y: 270 }]));
    expect(s.counters.hits).toBe(1);
    expect(s.log.find((e) => e.type === 'hit')!.closeSave).toBe(true);
  });

  it('a target reaching the core ends the round once with core_breach; empty clicks never add anything', () => {
    const s = playing('C', 1, noSpawns);
    s.projectiles.push(dart(560, 270, 200));
    run(s, 2000, mouseAt(10, 10, [{ x: 10, y: 10 }]));
    expect(s.phase).toBe('FINISHED');
    expect(s.endReason).toBe('core_breach');
    expect(s.survivalMs).toBeLessThan(400);
    expect(count(s, 'game_over')).toBe(1);
    expect(s.counters.hits).toBe(0);
    expect(s.counters.misses).toBeGreaterThan(0);
  });
});
