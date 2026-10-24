import { describe, expect, it } from 'vitest';
import { CONFIG, LEVELS, LEVEL_PRESETS, type Config } from './config';
import { DEFAULT_SCHEDULE, Sim, type Input, type Mode } from './sim';

// Mode D (DUAL): the keyboard dodge of A plus the click-intercept of C, aimed at the player instead of a core.
// Armoured darts (large darts, or timers flagged `armored` in the level config) cannot be clicked away.

const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };
const immortal: Config = { ...CONFIG, dodge: { ...CONFIG.dodge, playerHitRadiusPx: -10000 } };
function run(s: Sim, ms: number, input: Input, dt = 1000 / 60) { const n = Math.round(ms / dt); for (let i = 0; i < n; i++) s.frame(dt, input); }
function playing(mode: Mode, seed: number, cfg: Config = CONFIG, levels = LEVELS) {
  const s = new Sim(mode, seed, cfg, { levels });
  s.begin();
  run(s, 1000, idle);
  expect(s.phase).toBe('PLAYING');
  return s;
}
/** A normal dart at (x, y) flying straight at (tx, ty). */
const dartAt = (id: number, x: number, y: number, tx: number, ty: number, armored = false, speed = 200) => {
  const dx = tx - x, dy = ty - y, l = Math.hypot(dx, dy);
  return { id, x, y, px: x, py: y, vx: (dx / l) * speed, vy: (dy / l) * speed, speed, kind: 'normal' as const, tier: 'normal' as const, r: 7, group: 't', spawnT: 0, visibleFromT: 0, minDist: Infinity, nearMissDone: false, armored };
};
const clickAt = (x: number, y: number): Input => ({ keys: new Set(), pointer: { x, y }, clicks: [{ x, y }] });

describe('mode D (DUAL): keyboard dodge + click intercept', () => {
  it('runs the dodge schedule under the dodge difficulty version and is a dodge round for the records', () => {
    expect(DEFAULT_SCHEDULE.D).toBe('g3');
    const s = new Sim('D', 1, CONFIG);
    expect(s.difficultyVersion).toBe(LEVELS.difficultyVersion.dodge);
    expect(s.coreHpMax).toBe(1); // no core in play
  });

  it('with the same keys, D and A produce the same world: identical spawns (aimed at the player) and movement', () => {
    const a = playing('A', 7, immortal), d = playing('D', 7, immortal);
    const script = (i: number): Input => (i % 300 < 150 ? keysOf('KeyD', 'KeyW') : keysOf('KeyA'));
    for (let i = 0; i < 1500; i++) { a.frame(1000 / 60, script(i)); d.frame(1000 / 60, script(i)); }
    expect([d.player.x, d.player.y]).toEqual([a.player.x, a.player.y]);
    expect(d.player.x).not.toBeCloseTo(CONFIG.world.width / 2, 0); // the keys really moved it
    const spawns = (s: Sim) => s.log.filter((e) => e.type === 'spawn').map((e) => [e.t, e.x, e.y, e.angle]);
    expect(spawns(d).length).toBeGreaterThan(20);
    expect(spawns(d)).toEqual(spawns(a));
  });

  it('a click within 15 px of a dart removes it and logs the time it had left to reach the player; a miss logs its nearest distance', () => {
    const s = playing('D', 2, noSpawns);
    const P = { x: s.player.x, y: s.player.y };
    s.projectiles.push(dartAt(1, P.x - 100, P.y, P.x, P.y));
    s.frame(1000 / 60, clickAt(P.x - 100 + 14.9, P.y)); // judged against the last rendered position
    expect(s.projectiles.length).toBe(0);
    const hit = s.log.find((e) => e.type === 'hit')!;
    expect(hit).toBeDefined();
    expect(hit.threatTimeToCoreMs).toBe(Math.round(((100 - (CONFIG.dodge.playerHitRadiusPx + 7)) / 200) * 1000)); // vs the player, not a core
    s.projectiles.push(dartAt(2, P.x - 100, P.y, P.x, P.y));
    s.frame(1000 / 60, clickAt(P.x - 100 + 20, P.y));
    expect(s.projectiles.length).toBe(1);
    const miss = s.log.find((e) => e.type === 'miss')!;
    expect(miss.nearestDist).toBeCloseTo(20, 1);
  });

  it('an armoured dart cannot be clicked away: a dead-centre click is a miss that names it, and a shootable neighbour is still taken', () => {
    const s = playing('D', 5, noSpawns);
    const P = { x: s.player.x, y: s.player.y };
    s.projectiles.push(dartAt(1, P.x - 100, P.y, P.x, P.y, true));
    s.frame(1000 / 60, clickAt(P.x - 100, P.y));
    expect(s.projectiles.length).toBe(1);
    const miss = s.log.find((e) => e.type === 'miss')!;
    expect(miss.nearestId).toBe(1);
    expect(miss.nearestArmored).toBe(true);
    // a shootable dart 12 px away from the same click goes, the armoured one stays
    s.projectiles.push(dartAt(2, P.x - 100 + 12, P.y, P.x, P.y));
    s.frame(1000 / 60, clickAt(P.x - 100, P.y));
    expect(s.projectiles.map((p) => p.id)).toEqual([1]);
  });

  it('what is armoured: large darts in g3.1, the bursts of the aware preset; everything else can be shot', () => {
    const d = playing('D', 6, immortal);
    run(d, 60000, idle);
    const spawned = d.log.filter((e) => e.type === 'spawn');
    expect(spawned.filter((e) => e.kind === 'large').length).toBeGreaterThan(0);
    for (const e of spawned) expect(e.armored, `${e.group} ${e.kind}`).toBe(e.kind === 'large');
    const w = playing('D', 6, immortal, LEVEL_PRESETS.aware);
    run(w, 60000, idle);
    const ws = w.log.filter((e) => e.type === 'spawn');
    expect(ws.filter((e) => e.group === 'burst').length).toBeGreaterThan(0);
    for (const e of ws) expect(e.armored, `${e.group}`).toBe(e.group === 'burst');
    // the flag is the same object in A (clicks do not exist there, so it changes nothing)
    const a = playing('A', 6, immortal, LEVEL_PRESETS.aware);
    run(a, 60000, idle);
    expect(a.log.filter((e) => e.type === 'spawn').map((e) => e.armored)).toEqual(ws.map((e) => e.armored));
  });

  it('a dart that reaches the player ends the round (hit), exactly as in A', () => {
    const s = playing('D', 3, noSpawns);
    s.projectiles.push(dartAt(1, s.player.x - 60, s.player.y, s.player.x, s.player.y));
    run(s, 1000, idle);
    expect(s.phase).toBe('FINISHED');
    expect(s.endReason).toBe('hit');
  });

  it('clicks are ignored in A (regression): same click, dart stays, nothing logged', () => {
    const s = playing('A', 4, noSpawns);
    s.projectiles.push(dartAt(1, s.player.x - 100, s.player.y, s.player.x, s.player.y));
    s.frame(1000 / 60, clickAt(s.player.x - 100, s.player.y));
    expect(s.projectiles.length).toBe(1);
    expect(s.log.some((e) => e.type === 'hit' || e.type === 'miss' || e.type === 'click')).toBe(false);
  });
});
