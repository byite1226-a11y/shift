import { describe, expect, it } from 'vitest';
import { CONFIG, LEVEL_PRESETS, LEVELS, PATTERNS, type Config, type Levels } from './config';
import { MAX_FRAME_MS, MAX_LOG_EVENTS, SAMPLES_KEEP, Sim, TRACE_EVERY_MS, TRACE_KEEP_MS, type Input, type LogEvent, type Mode, type SimOptions } from './sim';
import { levelAt } from './schedule';
import { comparableRuns, runStats, type RunRecord } from './storage';
import { LocalRankingProvider, deviceRank, normalizeInitials, rankRuns, topRuns } from './ranking';

/** Gate 03: endless survival, LV.1–10, core hit points, time accounting, records. */
const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };
const immortalCfg = (): Config => ({ ...CONFIG, dodge: { ...CONFIG.dodge, playerHitRadiusPx: -10000 } });
function run(s: Sim, ms: number, input: Input, dt = 1000 / 60) { const n = Math.round(ms / dt); for (let i = 0; i < n; i++) s.frame(dt, input); }
function playing(mode: Mode, seed: number, cfg: Config = CONFIG, opts: SimOptions = {}) {
  const s = new Sim(mode, seed, cfg, opts);
  s.begin();
  run(s, 1000, idle);
  expect(s.phase).toBe('PLAYING');
  return s;
}
const dart = (id: number, x: number, y: number, speed: number, tier: 'slow' | 'normal' | 'fast' = 'slow') => {
  const dx = 480 - x, dy = 270 - y, l = Math.hypot(dx, dy);
  return { id, x, y, px: x, py: y, vx: (dx / l) * speed, vy: (dy / l) * speed, speed, kind: 'normal' as const, tier, r: 7, group: 't', spawnT: 0, visibleFromT: 0, minDist: Infinity, nearMissDone: false };
};
const W = CONFIG.world.width, H = CONFIG.world.height;

describe('level table', () => {
  it('maps time to LV.1–LV.10 (dodge 3 s each → LV.10 from 27 s; defend 5 s each → 45 s; LV.10 open-ended)', () => {
    const tables: [{ level: number; fromMs: number; untilMs: number | null }[], number][] = [
      [LEVELS.dodge.levels, 3000], [LEVEL_PRESETS.aware.dodge.timers!, 3000], [LEVELS.defend.levels, 5000],
    ];
    for (const [L, step] of tables) {
      expect(L.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(levelAt(L, 0)!.level).toBe(1);
      expect(levelAt(L, step - 1)!.level).toBe(1);
      expect(levelAt(L, step)!.level).toBe(2);
      expect(levelAt(L, 9 * step - 1)!.level).toBe(9);
      expect(levelAt(L, 9 * step)!.level).toBe(10);
      expect(levelAt(L, 10 * 60 * 1000)!.level).toBe(10);
      for (let i = 1; i < L.length; i++) expect(L[i].fromMs).toBe(L[i - 1].untilMs);
      expect(L[L.length - 1].untilMs).toBeNull();
    }
  });

  it('dodge parameters only tighten up to LV.10: intervals never grow, fast cap never shrinks, no fast group before LV.5', () => {
    const L = LEVELS.dodge.levels;
    for (let i = 1; i < L.length; i++) {
      expect(L[i].intervalMs).toBeLessThanOrEqual(L[i - 1].intervalMs);
      expect(L[i].maxActiveFast).toBeGreaterThanOrEqual(L[i - 1].maxActiveFast);
    }
    const hasFast = (l: typeof L[number]) => l.playlist.some(([g]) => g.toLowerCase().includes('fast'));
    for (const l of L) { if (l.level < 5) expect(hasFast(l), `LV${l.level}`).toBe(false); if (l.level >= 5) expect(hasFast(l)).toBe(true); }
  });

  it('defend parameters: fewer simultaneous targets and no fast tier early, then tightening', () => {
    const L = LEVELS.defend.levels;
    for (const l of L) {
      if (l.fromMs < 10000) expect(l.maxActive).toBeLessThanOrEqual(2);
      if (l.level < 8) expect(l.tierWeights.fast).toBe(0);
      if (l.level < 4) expect(l.tierWeights.normal).toBe(0);
    }
    for (let i = 1; i < L.length; i++) {
      expect(L[i].intervalMs).toBeLessThanOrEqual(L[i - 1].intervalMs);
      expect(L[i].maxActive).toBeGreaterThanOrEqual(L[i - 1].maxActive);
    }
  });
});

describe('endless survival', () => {
  it('A (g3): no CLEAR at 40 s, LV.10 from 27 s, spawns keep coming, level events 1→10, reached level recorded', () => {
    const s = playing('A', 3, immortalCfg());
    run(s, 70000, idle);
    expect(s.phase).toBe('PLAYING');
    expect(s.t).toBe(70000);
    expect(s.level).toBe(10);
    expect(s.log.filter((e) => e.type === 'level' && e.level === 10)[0].t).toBe(27000);
    expect(s.log.filter((e) => e.type === 'spawn' && e.t > 45000).length).toBeGreaterThan(30);
    expect(s.log.filter((e) => e.type === 'level').map((e) => e.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.log.some((e) => e.type === 'game_over')).toBe(false);
    s.abandon();
    expect(s.reachedLevel).toBe(10);
    expect(s.difficultyVersion).toBe(LEVELS.difficultyVersion.dodge);
  });

  it('B shares the A schedule for the same seed (same scheduled fire times up to the same game time)', () => {
    const a = playing('A', 8, immortalCfg()), b = playing('B', 8, immortalCfg());
    run(a, 50000, idle);
    run(b, 50000, { keys: new Set(), pointer: { x: 60, y: 60 }, clicks: [] });
    expect(a.schedule.map((e) => [e.tMs, e.group, e.speed])).toEqual(b.schedule.map((e) => [e.tMs, e.group, e.speed]));
  });

  it('legacy g2 still ends with CLEAR at 40 s and is marked as legacy rules (comparison only)', () => {
    const s = playing('A', 3, immortalCfg(), { schedule: 'g2' });
    run(s, 41000, idle);
    expect(s.endReason).toBe('clear');
    expect(s.validity().reasons).toContain('legacy_rules');
    expect(s.difficultyVersion).toBe('g2.legacy');
  });

  it('a death at LV.7 records reachedLevel 7 and a death trace that still spans the last 3 s', () => {
    const cfg = immortalCfg();
    const s = playing('A', 5, cfg);
    run(s, 31000, idle);                // safely into LV.7
    (cfg.dodge as { playerHitRadiusPx: number }).playerHitRadiusPx = CONFIG.dodge.playerHitRadiusPx; // now mortal
    run(s, 20000, idle);                // idle at the centre: something hits soon
    expect(s.endReason).toBe('hit');
    expect(s.survivalMs).toBeGreaterThan(31000);
    expect(s.reachedLevel).toBeGreaterThanOrEqual(7);
    const log = s.toLog();
    const tr = log.lastSeconds;
    expect(tr[tr.length - 1].t).toBe(s.survivalMs);
    expect(tr[0].t).toBeGreaterThanOrEqual(s.survivalMs - TRACE_KEEP_MS - TRACE_EVERY_MS);
    expect(tr.length).toBeLessThanOrEqual(TRACE_KEEP_MS / TRACE_EVERY_MS + 2);
    expect(log.summary.lastHit!.id).toBeDefined();
    expect(log.reachedLevel).toBe(s.reachedLevel);
  });
});

describe('defend: core hit points', () => {
  it('starts with 3 HP; two darts arriving in the same step cost one HP; a dart inside the cooldown is absorbed; the third hit ends the round once', () => {
    const s = playing('C', 1, noSpawns);
    expect(s.coreHpMax).toBe(LEVELS.defend.coreHitPoints);
    expect(s.coreHp).toBe(3);
    s.projectiles.push(dart(1, 480 + 30, 270, 200), dart(2, 480 - 30, 270, 200)); // same distance → same step
    run(s, 100, idle);
    expect(s.coreHp).toBe(2);
    expect(s.counters.coreHits).toBe(1);
    expect(s.counters.coreAbsorbed).toBe(1);
    expect(s.projectiles.length).toBe(0);
    expect(s.phase).toBe('PLAYING');
    s.projectiles.push(dart(3, 480 + 30, 270, 200)); // arrives ~25 ms later, well inside the 500 ms cooldown
    run(s, 100, idle);
    expect(s.coreHp).toBe(2);
    expect(s.counters.coreAbsorbed).toBe(2);
    run(s, 600, idle);                                 // cooldown over
    s.projectiles.push(dart(4, 480 + 30, 270, 200));
    run(s, 100, idle);
    expect(s.coreHp).toBe(1);
    run(s, 600, idle);
    s.projectiles.push(dart(5, 480 + 30, 270, 200), dart(6, 480 - 30, 270, 200));
    run(s, 200, idle);
    expect(s.coreHp).toBe(0);
    expect(s.phase).toBe('FINISHED');
    expect(s.endReason).toBe('core_breach');
    expect(s.log.filter((e) => e.type === 'core_breach').length).toBe(1);
    expect(s.log.filter((e) => e.type === 'core_hit').length).toBe(2);
    expect(s.log.filter((e) => e.type === 'game_over').length).toBe(1);
  });

  it('legacy g1 defend still ends on the first dart (1 HP)', () => {
    const s = playing('C', 1, noSpawns, { schedule: 'g1' });
    expect(s.coreHpMax).toBe(1);
    s.projectiles.push(dart(1, 480 + 30, 270, 200));
    run(s, 200, idle);
    expect(s.endReason).toBe('core_breach');
  });

  it('c3 levels: ≤ maxActive darts on screen per level, no fast tier before LV.8, LV.10 keeps spawning at 10 minutes', () => {
    const levels: Levels = { ...LEVELS, defend: { ...LEVELS.defend, coreHitPoints: 1e9 } }; // observe without dying
    const s = playing('C', 9, CONFIG, { levels });
    const peaks = new Map<number, number>();
    const dt = 1000 / 60;
    while (s.t < 600000) {
      s.frame(dt, idle);
      const lv = levelAt(LEVELS.defend.levels, s.t)!;
      peaks.set(lv.level, Math.max(peaks.get(lv.level) ?? 0, s.projectiles.length));
    }
    for (const lv of LEVELS.defend.levels) expect(peaks.get(lv.level) ?? 0, `LV${lv.level}`).toBeLessThanOrEqual(lv.maxActive);
    for (const e of s.log) if (e.type === 'spawn' && (e.level as number) < 8) expect(e.tier).not.toBe('fast');
    expect(s.log.filter((e) => e.type === 'spawn' && e.tier === 'fast').length).toBeGreaterThan(0);
    expect(s.log.filter((e) => e.type === 'spawn' && e.t > 590000).length).toBeGreaterThan(5);
    expect(s.phase).toBe('PLAYING');
  });
});

describe('LV.10 is stationary: no hidden ramp over 10 minutes', () => {
  it('spawn rate, fast share, concurrency and group variety stay in one band at 1, 2, 5 and 10 minutes', () => {
    const s = playing('A', 21, immortalCfg());
    const windows = [[45, 105], [105, 165], [285, 345], [525, 585]].map(([a, b]) => ({ a: a * 1000, b: b * 1000, conc: [] as number[] }));
    const dt = 1000 / 60;
    let next = 0;
    while (s.t < 600000) {
      s.frame(dt, idle);
      if (s.t >= next) { next += 500; for (const w of windows) if (s.t >= w.a && s.t < w.b) w.conc.push(s.projectiles.length); }
    }
    expect(s.phase).toBe('PLAYING');
    const spawns = s.log.filter((e) => e.type === 'spawn');
    const stats = windows.map((w) => {
      const sp = spawns.filter((e) => e.t >= w.a && e.t < w.b);
      return {
        perMin: sp.length, fast: sp.filter((e) => e.tier === 'fast').length / Math.max(1, sp.length),
        conc: w.conc.reduce((x, v) => x + v, 0) / Math.max(1, w.conc.length), groups: new Set(sp.map((e) => e.group)).size,
      };
    });
    console.log('[lv10 windows 45-105s / 105-165s / 285-345s / 525-585s]', JSON.stringify(stats.map((s) => ({ ...s, fast: +s.fast.toFixed(3), conc: +s.conc.toFixed(2) }))));
    const mean = (k: 'perMin' | 'fast' | 'conc') => stats.reduce((x, v) => x + v[k], 0) / stats.length;
    for (const st of stats) {
      expect(st.perMin).toBeGreaterThan(mean('perMin') * 0.8);
      expect(st.perMin).toBeLessThan(mean('perMin') * 1.2);
      expect(Math.abs(st.fast - mean('fast'))).toBeLessThan(0.06);
      expect(st.conc).toBeGreaterThan(mean('conc') * 0.75);
      expect(st.conc).toBeLessThan(mean('conc') * 1.25);
      expect(st.groups).toBeGreaterThanOrEqual(6);
    }
    expect(spawns.filter((e) => e.t > 45000).every((e) => e.level === 10)).toBe(true);
  });
});

describe('long run resource bounds (10 minutes)', () => {
  it('samples, trace, log, schedule and projectiles stay bounded; heap growth is modest', () => {
    const before = process.memoryUsage().heapUsed;
    const s = playing('A', 22, immortalCfg());
    run(s, 600000, idle);
    expect(s.samples.length).toBeLessThanOrEqual(SAMPLES_KEEP);
    expect(s.toLog().lastSeconds.length).toBeLessThanOrEqual(TRACE_KEEP_MS / TRACE_EVERY_MS + 2);
    expect(s.log.length).toBeLessThanOrEqual(MAX_LOG_EVENTS);
    expect(s.schedule.length).toBeLessThan(20000);
    // the ceiling is checked when a telegraphed shot is planned; a committed shot still fires, so at most the
    // committed fast shots (≤ LV.10 cap of 2) can sit above it
    expect(s.counters.maxActive).toBeLessThanOrEqual(CONFIG.world.maxProjectiles + 2);
    for (const p of s.projectiles) { expect(p.x).toBeGreaterThan(-60); expect(p.x).toBeLessThan(W + 60); expect(p.y).toBeGreaterThan(-60); expect(p.y).toBeLessThan(H + 60); }
    expect(s.log.filter((e) => e.type === 'despawn').length).toBeGreaterThan(500);
    const grownMb = (process.memoryUsage().heapUsed - before) / 1048576;
    console.log('[10min bounds]', JSON.stringify({ samples: s.samples.length, trace: s.toLog().lastSeconds.length, log: s.log.length, dropped: s.droppedLogs, schedule: s.schedule.length, maxActive: s.counters.maxActive, spawned: s.counters.spawned, despawned: s.log.filter((e) => e.type === 'despawn').length, heapGrowMb: +grownMb.toFixed(1), logJsonKb: Math.round(JSON.stringify(s.toLog()).length / 1024) }));
    expect(grownMb).toBeLessThan(200);
  });
});

describe('time accounting and run validity', () => {
  it('pause adds wall time to pausedMs, never to survival; a clean 60 Hz run is valid', () => {
    const s = playing('A', 1, noSpawns);
    run(s, 1000, idle);
    const t = s.t;
    s.pause();
    run(s, 2000, idle);
    expect(s.t).toBe(t);
    expect(s.clock.pausedMs).toBeCloseTo(2000, -1);
    s.resume();
    run(s, 1000, idle);
    expect(s.clock.wallMs).toBeCloseTo(2000, -1);
    expect(s.validity()).toEqual({ status: 'valid', reasons: [] });
  });

  it('slow frames: the clamp keeps the world honest (≤ 50 ms per frame) and the lost time flags the run', () => {
    const s = playing('A', 1, noSpawns);
    run(s, 3000, idle, 200); // 5 fps
    expect(s.t).toBeLessThanOrEqual(15 * MAX_FRAME_MS);
    expect(s.clock.lostMs).toBeCloseTo(15 * (200 - MAX_FRAME_MS), -1);
    const v = s.validity();
    expect(v.status).toBe('suspect');
    expect(v.reasons).toContain('slow_frames');
    expect(v.reasons).toContain('low_fps');
  });

  it('one long stall advances the world by at most 50 ms and is flagged; bot runs are never valid records', () => {
    const s = playing('A', 1, noSpawns);
    const t = s.t;
    s.frame(1500, idle);
    expect(s.t - t).toBe(MAX_FRAME_MS);
    expect(s.validity().reasons).toContain('long_stall');
    const bot = playing('A', 1, noSpawns, { autopilot: true });
    expect(bot.validity().reasons).toEqual(['autopilot']);
  });
});

describe('Gate 03 run records and ranking interface', () => {
  const mk = (p: Partial<RunRecord>): RunRecord => ({
    mode: 'A', participantId: 'P1', sessionId: 's', seed: 1, survivalTimeMs: 1000, reachedLevel: 1, deathReason: 'hit',
    gameVersion: 'gate03', difficultyVersion: 'g3.1', runValidity: 'valid', validityReasons: [], createdAt: '2026-10-17T00:00:00Z', ...p,
  });

  it('personal bests are per mode and rules version; suspect, legacy and abandoned runs never count', () => {
    const runs = [
      mk({ survivalTimeMs: 30000 }),
      mk({ survivalTimeMs: 90000, runValidity: 'suspect', validityReasons: ['autopilot'] }),
      mk({ survivalTimeMs: 40000, difficultyVersion: 'g2.legacy' }),
      mk({ survivalTimeMs: 80000, deathReason: 'abandoned' }),
      mk({ mode: 'B', survivalTimeMs: 50000 }),
      mk({ mode: 'C', survivalTimeMs: 20000, difficultyVersion: 'c3.1' }),
    ];
    expect(comparableRuns(runs, 'A', 'g3.1').length).toBe(1);
    expect(runStats(runs, 'A', 'g3.1').best).toBe(30000);
    expect(runStats(runs, 'B', 'g3.1').best).toBe(50000);
    expect(runStats(runs, 'C', 'c3.1').best).toBe(20000);
    expect(runStats(runs, 'C', 'g3.1').count).toBe(0);
  });

  it('leaderboard: best valid run per participant, descending, ties share a rank, other versions excluded; no entry → null', async () => {
    const runs = [
      mk({ participantId: 'P1', survivalTimeMs: 30000, createdAt: '2026-10-17T00:00:01Z' }),
      mk({ participantId: 'P1', survivalTimeMs: 45000, createdAt: '2026-10-17T00:00:02Z' }),
      mk({ participantId: 'P2', survivalTimeMs: 45000, createdAt: '2026-10-17T00:00:03Z' }),
      mk({ participantId: 'P3', survivalTimeMs: 20000 }),
      mk({ participantId: 'P4', survivalTimeMs: 50000, difficultyVersion: 'g2.legacy' }),
      mk({ participantId: 'P5', survivalTimeMs: 60000, runValidity: 'suspect' }),
    ];
    const q = { mode: 'A' as const, gameVersion: 'gate03', difficultyVersion: 'g3.1' };
    const board = rankRuns(runs, q);
    expect(board.map((e) => [e.participantId, e.rank, e.survivalTimeMs])).toEqual([['P1', 1, 45000], ['P2', 1, 45000], ['P3', 3, 20000]]);
    const provider = new LocalRankingProvider(() => runs);
    expect(provider.source).toBe('local');
    expect(await provider.rankOf(q, 'P3')).toEqual({ rank: 3, total: 3, topPercent: 100 });
    expect(await provider.rankOf(q, 'P5')).toBeNull();
    expect((await provider.top(q, 2)).length).toBe(2);
  });

  it('device board: one row per finished valid run (participant may be blank), ties share a rank; deviceRank places a time in that field', () => {
    const runs = [
      mk({ participantId: '', survivalTimeMs: 30000, createdAt: '2026-10-22T00:00:01Z' }),
      mk({ participantId: '', survivalTimeMs: 45000, createdAt: '2026-10-22T00:00:02Z' }),
      mk({ participantId: 'P2', survivalTimeMs: 45000, createdAt: '2026-10-22T00:00:03Z' }),
      mk({ participantId: '', survivalTimeMs: 20000, deathReason: 'abandoned' }),
      mk({ participantId: '', survivalTimeMs: 60000, runValidity: 'suspect' }),
      mk({ participantId: '', survivalTimeMs: 50000, mode: 'D' }),
    ];
    const q = { mode: 'A' as const, gameVersion: 'gate03', difficultyVersion: 'g3.1' };
    expect(topRuns(runs, q, 10).map((e) => [e.rank, e.survivalTimeMs, e.participantId])).toEqual([[1, 45000, ''], [1, 45000, 'P2'], [3, 30000, '']]);
    expect(topRuns(runs, q, 2).length).toBe(2);
    expect(deviceRank(runs, q, 45000)).toEqual({ rank: 1, total: 3 });
    expect(deviceRank(runs, q, 30000)).toEqual({ rank: 3, total: 3 });
    expect(deviceRank(runs, { ...q, mode: 'D' }, 50000)).toEqual({ rank: 1, total: 1 }); // modes never pool
    expect(deviceRank(runs, { ...q, mode: 'C' }, 1)).toBeNull();
    // arcade initials: letters and digits only, upper-cased, three at most
    expect(normalizeInitials(' ab-9z ')).toBe('AB9');
    expect(normalizeInitials('')).toBe('');
    expect(normalizeInitials('한글')).toBe('');
  });
});

describe('aware preset (g3.2): 죽림고수 three types — stream / line / burst on independent timers', () => {
  const aware = LEVEL_PRESETS.aware;
  const F = PATTERNS.fairness;
  const T = aware.dodge.timers!;
  const centre = { x: W / 2, y: H / 2 };
  /** Perpendicular distance from a point to the ray (x, y, angle). */
  const rayMiss = (e: LogEvent, p: { x: number; y: number }) => {
    const a = e.angle as number, dx = Math.cos(a), dy = Math.sin(a);
    return Math.abs((p.x - (e.x as number)) * dy - (p.y - (e.y as number)) * dx);
  };
  const groupsAt = (s: Sim, group: string) => {
    const byT = new Map<number, LogEvent[]>();
    for (const e of s.log) if (e.type === 'spawn' && e.group === group) byT.set(e.t, [...(byT.get(e.t) ?? []), e]);
    return [...byT.entries()].sort((a, b) => a[0] - b[0]);
  };

  it('uses the timer table: g3.1 keeps the playlist scheduler and none of the new groups', () => {
    expect(LEVELS.dodge.timers).toBeUndefined();
    expect(T.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(T[T.length - 1].untilMs).toBeNull();
    const s = playing('A', 304, immortalCfg());
    run(s, 50000, idle);
    expect(s.schedule.some((e) => e.dir !== undefined || ['stream', 'line', 'burst'].includes(e.group))).toBe(false);
  });

  it('keeps the fairness floors wherever the player is parked; telegraphs honoured; no ceiling skips in 90 s', () => {
    for (const [i, park] of [idle, keysOf('KeyA', 'KeyW'), keysOf('KeyD'), keysOf('KeyS')].entries()) {
      const s = playing('A', 300 + i, immortalCfg(), { levels: aware });
      run(s, 90000, park);
      const spawns = s.log.filter((e) => e.type === 'spawn');
      expect(spawns.length).toBeGreaterThan(200);
      for (const e of spawns) {
        expect(e.flightAtResolveMs as number, `${e.group} ${e.t}`).toBeGreaterThanOrEqual(F.minFlightMs);
        expect(e.distAtResolvePx as number, `${e.group} ${e.t}`).toBeGreaterThanOrEqual(F.minSpawnDistancePx);
      }
      const byTele = new Map(spawns.filter((e) => e.telegraphId !== undefined).map((e) => [e.telegraphId as number, e]));
      for (const tg of s.log.filter((e) => e.type === 'telegraph')) {
        if ((tg.fireAt as number) > s.t) continue;
        const sp = byTele.get(tg.id as number)!;
        expect(sp).toBeDefined();
        expect([sp.x, sp.y, sp.t]).toEqual([tg.x, tg.y, tg.fireAt]);
      }
      // the only reasons a planned dart does not fire: a line track that misses the field, an origin unsafe from both ends,
      // or the fast cap (telegraphed stream from LV8) — and fast-cap cancellations stay under 5 % of planned fast shots
      const notFired = s.log.filter((e) => e.type === 'spawn_cancelled' || e.type === 'spawn_skipped');
      const reasons = new Set(notFired.map((e) => e.reason));
      expect([...reasons].every((r) => r === 'offfield' || r === 'unsafe' || r === 'fastcap'), [...reasons].join(',')).toBe(true);
      const fastCap = notFired.filter((e) => e.reason === 'fastcap').length, fastFired = spawns.filter((e) => e.tier === 'fast').length;
      expect(fastFired).toBeGreaterThan(20);
      expect(fastCap / (fastCap + fastFired), `fastcap ${fastCap}/${fastCap + fastFired}`).toBeLessThan(0.05);
      expect(s.difficultyVersion).toBe(aware.difficultyVersion.dodge);
    }
  });

  it('stream: one dart per period, period = the level’s everyMs at the time it fired', () => {
    const s = playing('A', 310, immortalCfg(), { levels: aware });
    run(s, 60000, idle);
    const ts = s.schedule.filter((e) => e.group === 'stream').map((e) => e.tMs); // as scheduled (a fast-cap cancel removes a dart, never shifts the beat)
    expect(new Set(ts).size).toBe(ts.length);
    expect(ts[0]).toBe(aware.dodge.firstSpawnAtMs);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(levelAt(T, ts[i - 1])!.stream!.everyMs);
    const fired = groupsAt(s, 'stream');
    expect(fired.every(([, g]) => g.length === 1)).toBe(true);
    expect(fired.length).toBeGreaterThan(ts.filter((t) => t <= s.t).length * 0.95);
  });

  it('line and burst debut half a period into the first level that has them, never on the same beat', () => {
    const s = playing('A', 311, immortalCfg(), { levels: aware });
    run(s, 20000, idle);
    const first = (g: string) => s.schedule.find((e) => e.group === g)!.tMs;
    expect(first('line')).toBe(T[1].fromMs + T[1].line!.everyMs / 2);
    expect(first('burst')).toBe(T[2].fromMs + T[2].burst!.everyMs / 2);
    expect(first('line')).not.toBe(first('burst'));
  });

  it('line: a straight row, 44 px apart, one of the 8 directions, centred on the player — the middle dart’s track passes through it', () => {
    const s = playing('A', 312, immortalCfg(), { levels: aware });
    run(s, 90000, idle); // stays at the centre: every track is inside the field, nothing is dropped
    const lines = groupsAt(s, 'line');
    expect(lines.length).toBeGreaterThanOrEqual(10);
    const dirs = new Set<number>();
    for (const [t, darts] of lines) {
      const lv = levelAt(T, t)!.line!;
      expect(darts.length).toBe(lv.count);
      const a = darts[0].angle as number;
      expect(darts.every((d) => d.angle === a)).toBe(true);
      const k = Math.round((a / Math.PI) * 4); // multiples of 45°
      expect(Math.abs(a - (k * Math.PI) / 4)).toBeLessThan(1e-3);
      dirs.add(((k % 8) + 8) % 8);
      const dx = Math.cos(a), dy = Math.sin(a);
      const along = darts.map((d) => (d.x as number) * dx + (d.y as number) * dy);
      const across = darts.map((d) => -(d.x as number) * dy + (d.y as number) * dx).sort((p, q) => p - q);
      expect(Math.max(...along) - Math.min(...along)).toBeLessThan(0.05); // one straight front
      for (let i = 1; i < across.length; i++) expect(across[i] - across[i - 1]).toBeCloseTo(lv.spacingPx, 1);
      const mid = darts.reduce((m, d) => (rayMiss(d, centre) < rayMiss(m, centre) ? d : m));
      expect(rayMiss(mid, centre)).toBeLessThan(0.05);
    }
    for (const e of s.schedule.filter((e) => e.group === 'line')) expect(e.corridorPx).toBe(levelAt(T, e.tMs)!.line!.spacingPx - 2 * PATTERNS.projectileKinds.normal.hitRadiusPx);
    expect(dirs.size).toBeGreaterThanOrEqual(5); // 4 edges early, 8 directions from LV5
    expect(s.log.some((e) => e.type === 'spawn_cancelled' && e.reason === 'offfield')).toBe(false);
  });

  it('line: a player in a corner gets the row from the far end (flip), and tracks that would miss the field are dropped', () => {
    const s = playing('A', 313, immortalCfg(), { levels: aware });
    run(s, 60000, keysOf('KeyA', 'KeyW'));
    const flips = s.log.filter((e) => e.type === 'flip' && e.group === 'line');
    expect(flips.length).toBeGreaterThan(0);
    expect(s.log.some((e) => e.type === 'spawn_cancelled' && e.reason === 'offfield' && e.group === 'line')).toBe(true);
    for (const [t, darts] of groupsAt(s, 'line')) {
      const sp = darts[0];
      expect(darts.every((d) => d.angle === sp.angle && d.flipped === sp.flipped), `line @${t}`).toBe(true); // the row flips as a whole
    }
  });

  const burstsOf = (s: Sim) => {
    const byId = new Map<number, LogEvent[]>();
    for (const e of s.log) if (e.type === 'spawn' && e.group === 'burst') byId.set(e.burstId as number, [...(byId.get(e.burstId as number) ?? []), e]);
    return [...byId.values()];
  };

  it('burst: count darts from ≥3 sides, the farthest leaves on the beat, all reach the player’s position at that beat together', () => {
    const s = playing('A', 314, immortalCfg(), { levels: aware });
    run(s, 60000, idle);
    const beats = s.schedule.filter((e) => e.group === 'burst').map((e) => e.tMs);
    const bursts = burstsOf(s);
    expect(bursts.length).toBeGreaterThanOrEqual(8);
    for (const darts of bursts) {
      const first = Math.min(...darts.map((d) => d.t));
      expect(beats).toContain(first); // the farthest dart fires on the scheduled beat, the others later
      expect(darts.length).toBe(levelAt(T, first)!.burst!.count);
      expect(new Set(darts.map((d) => d.side)).size).toBeGreaterThanOrEqual(3);
      const arrivals = darts.map((d) => d.t + (d.flightMs as number));
      expect(Math.max(...arrivals) - Math.min(...arrivals), `burst @${first}`).toBeLessThanOrEqual(10); // 5 ms steps + rounding
      for (const d of darts) expect(rayMiss(d, centre)).toBeLessThan(0.05);
    }
  });

  it('burst: for a running player every ray of a burst meets at one point — where the player was when the burst was planned', () => {
    const s = playing('A', 316, immortalCfg(), { levels: aware });
    for (let i = 0; i < 12000; i++) s.frame(5, i % 1200 < 600 ? keysOf('KeyD') : keysOf('KeyA', 'KeyS')); // keeps moving for 60 s
    const bursts = burstsOf(s).filter((d) => d.length >= 3);
    expect(bursts.length).toBeGreaterThanOrEqual(6);
    for (const darts of bursts) {
      // intersect the two most perpendicular rays (a near-parallel pair would amplify the 4-decimal angle rounding)
      let a = darts[0], b = darts[1], det = 0;
      for (const p of darts) for (const q of darts) {
        const d = Math.cos(p.angle as number) * Math.sin(q.angle as number) - Math.sin(p.angle as number) * Math.cos(q.angle as number);
        if (Math.abs(d) > Math.abs(det)) { a = p; b = q; det = d; }
      }
      const ax = Math.cos(a.angle as number), ay = Math.sin(a.angle as number), bx = Math.cos(b.angle as number), by = Math.sin(b.angle as number);
      expect(Math.abs(det)).toBeGreaterThan(0.3);
      const u = (((b.x as number) - (a.x as number)) * by - ((b.y as number) - (a.y as number)) * bx) / det;
      const P = { x: (a.x as number) + ax * u, y: (a.y as number) + ay * u };
      for (const d of darts) expect(rayMiss(d, P), `burst @${a.t}`).toBeLessThan(0.5); // angles are logged to 4 decimals; a live aim would miss by 100s of px
      const plannedAt = Math.min(...darts.map((d) => d.t));
      const lateDarts = darts.filter((d) => d.t > plannedAt);
      expect(lateDarts.length).toBeGreaterThan(0); // staggered, not simultaneous
    }
  });

  it('no lead: a running player is aimed at where it is when the dart fires, not where it is going', () => {
    const s = playing('A', 315, immortalCfg(), { levels: aware });
    let seen = 0, checked = 0;
    for (let i = 0; i < 6000; i++) {
      s.frame(5, i % 1200 < 600 ? keysOf('KeyD') : keysOf('KeyA', 'KeyS')); // 5 ms frames: at most one step between spawn and this check
      const spawns = s.log.filter((e) => e.type === 'spawn' && e.group === 'stream');
      for (const e of spawns.slice(seen)) { expect(rayMiss(e, s.player), `t=${e.t}`).toBeLessThan(3); checked++; }
      seen = spawns.length;
    }
    expect(checked).toBeGreaterThan(30);
  });
});
