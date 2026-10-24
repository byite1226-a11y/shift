import { describe, expect, it } from 'vitest';
import { CONFIG, type Config } from './config';
import { Sim, TRACE_EVERY_MS, TRACE_KEEP_MS, type Input, type LogEvent } from './sim';
import { statsByMode, type Records } from './storage';

/** Gate 02.2: the fields a playtest analysis needs must be in every round log. */
const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };
const immortal: Config = { ...CONFIG, dodge: { ...CONFIG.dodge, playerHitRadiusPx: -10000 } };
function run(s: Sim, ms: number, input: Input, dt = 1000 / 60) { const n = Math.round(ms / dt); for (let i = 0; i < n; i++) s.frame(dt, input); }
function playing(mode: 'A' | 'B' | 'C', seed: number, cfg: Config = CONFIG) { const s = new Sim(mode, seed, cfg); s.begin(); run(s, 1000, idle); return s; }
const dart = (x: number, y: number, speed = 150) => {
  const dx = 480 - x, dy = 270 - y, l = Math.hypot(dx, dy);
  return { id: 1, x, y, px: x, py: y, vx: (dx / l) * speed, vy: (dy / l) * speed, speed, kind: 'normal' as const, tier: 'slow' as const, r: 7, group: 't', spawnT: 0, visibleFromT: 0, minDist: Infinity, nearMissDone: false };
};

describe('round log: death trace and summary', () => {
  it('keeps a 20 ms trace of the last 3 s ending exactly at the collision, with player, input and projectile positions', () => {
    const s = playing('A', 11);
    run(s, 45000, keysOf('KeyD', 'KeyS')); // walks into the corner and dies
    expect(s.endReason).toBe('hit');
    const log = s.toLog();
    const tr = log.lastSeconds;
    expect(tr.length).toBeGreaterThan(10);
    expect(tr.length).toBeLessThanOrEqual(TRACE_KEEP_MS / TRACE_EVERY_MS + 2);
    expect(tr[tr.length - 1].t).toBe(s.survivalMs);
    expect(tr[0].t).toBeGreaterThanOrEqual(s.survivalMs - TRACE_KEEP_MS - TRACE_EVERY_MS);
    for (let i = 1; i < tr.length - 1; i++) expect(tr[i].t - tr[i - 1].t).toBe(TRACE_EVERY_MS);
    const last = tr[tr.length - 1];
    expect(last.player).toEqual([Math.round(s.player.x * 10) / 10, Math.round(s.player.y * 10) / 10]);
    expect(last.input).toEqual([1, 1]);
    expect(last.proj.some(([id]) => id === log.summary.lastHit!.id)).toBe(true); // the killer is in the final frame
  });

  it('B trace records the pointer target; C trace has no input', () => {
    const b = playing('B', 2, noSpawns);
    run(b, 500, { keys: new Set(), pointer: { x: 700, y: 300 }, clicks: [] });
    b.abandon();
    expect(b.toLog().lastSeconds.at(-1)!.input).toEqual([700, 300]);
    const c = playing('C', 2, noSpawns);
    run(c, 300, idle);
    c.abandon();
    expect(c.toLog().lastSeconds.at(-1)!.input).toBeNull();
  });

  it('summary.lastHit names the projectile that ended the round (kind, tier, speed, pattern, group)', () => {
    const s = playing('A', 5);
    run(s, 45000, idle);
    const col = s.log.find((e) => e.type === 'collision')!;
    const sp = s.log.find((e) => e.type === 'spawn' && e.id === col.id)!;
    const h = s.toLog().summary.lastHit!;
    expect(h.t).toBe(s.survivalMs);
    expect([h.id, h.kind, h.tier, h.speed, h.pattern, h.group]).toEqual([sp.id, sp.kind, sp.tier, sp.speed, sp.pattern, sp.group]);
    expect(h.visibleForMs).toBeGreaterThan(0);
  });

  it('every origin fallback is a flip event with time, position and both sides; spawns point back at it', () => {
    const s = playing('A', 101, immortal);
    run(s, 40000, keysOf('KeyA', 'KeyW'));
    const flips = s.toLog().summary.flips;
    expect(flips.length).toBe(s.counters.flips);
    expect(flips.length).toBeGreaterThan(0);
    for (const f of flips) {
      expect(f.fromSide).not.toBe(f.toSide);
      expect((f.after as { distPx: number }).distPx).toBeGreaterThanOrEqual((f.before as { distPx: number }).distPx);
      const sp = s.log.find((e) => e.type === 'spawn' && e.idx === f.idx) as LogEvent | undefined;
      if (sp) { expect(sp.flipped).toBe(true); expect(sp.fromSide).toBe(f.fromSide); expect(sp.side).toBe(f.toSide); }
    }
  });

  it('accounting splits spawned darts by pattern type and counts group starts', () => {
    const s = playing('A', 7, immortal);
    run(s, 40000, idle);
    const a = s.accounting();
    const total = Object.values(a.spawned).reduce((x, v) => x + v, 0);
    expect(Object.values(a.spawnedPattern).reduce((x, v) => x + v, 0)).toBe(total);
    expect(Object.keys(a.spawnedPattern).sort()).toEqual(['aimed', 'fan', 'volley']);
    expect(Object.values(a.groupStarts).reduce((x, v) => x + v, 0)).toBeGreaterThan(20);
  });
});

describe('C: miss events carry the distance to the nearest target', () => {
  it('records nearestDist / nearestId on an empty click, null when nothing is on screen', () => {
    const s = playing('C', 1, noSpawns);
    s.frame(0, { keys: new Set(), pointer: { x: 100, y: 100 }, clicks: [{ x: 100, y: 100 }] });
    const m0 = s.log.filter((e) => e.type === 'miss').at(-1)!;
    expect(m0.nearestDist).toBeNull();
    s.projectiles.push(dart(680, 270));
    s.frame(0, { keys: new Set(), pointer: { x: 700, y: 270 }, clicks: [{ x: 700, y: 270 }] });
    const m1 = s.log.filter((e) => e.type === 'miss').at(-1)!;
    expect(m1.nearestId).toBe(1);
    expect(m1.nearestDist).toBe(20);
    expect(s.projectiles.length).toBe(1);
  });
});

describe('statsByMode', () => {
  it('keeps the three modes apart and can filter by tester', () => {
    const r: Records = {
      best: { A: 0, B: 0, C: 0, D: 0 },
      rounds: [
        { mode: 'A', seed: 1, survivalMs: 10000, reason: 'hit', at: 1, tester: 'P1' },
        { mode: 'A', seed: 2, survivalMs: 40000, reason: 'clear', at: 2, tester: 'P1' },
        { mode: 'A', seed: 3, survivalMs: 5000, reason: 'hit', at: 3, tester: 'P2' },
        { mode: 'C', seed: 1, survivalMs: 20000, reason: 'core_breach', at: 4, tester: 'P1' },
      ],
    };
    const all = statsByMode(r);
    expect(all.A).toMatchObject({ count: 3, clears: 1, best: 40000, median: 10000 });
    expect(all.B.count).toBe(0);
    expect(all.C).toMatchObject({ count: 1, clears: 0, best: 20000 });
    expect(statsByMode(r, 'P1').A).toMatchObject({ count: 2, clears: 1, clearRate: 0.5 });
  });
});
