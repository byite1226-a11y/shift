import { describe, expect, it } from 'vitest';
import { CONFIG, LEVEL_PRESETS, LEVELS, type Config, type Levels } from './config';
import { Sim, type Input, type LogEvent } from './sim';
import { DodgeBot, ReactiveBot } from './bot';

/**
 * Mechanics diagnostics (not a pass/fail test). Prints per-level numbers for the dodge and defend schedules.
 *   DIAG=1 npx vitest run src/diag.test.ts --silent=false
 */
const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
const immortal = (): Config => ({ ...CONFIG, dodge: { ...CONFIG.dodge, playerHitRadiusPx: -10000 } });
const pct = (arr: number[], q: number) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
const r = (v: number, d = 1) => +v.toFixed(d);

function levelOf(t: number, levels: { level: number; fromMs: number; untilMs: number | null }[]) {
  return levels.find((l) => t >= l.fromMs && (l.untilMs === null || t < l.untilMs))?.level ?? 0;
}

/** Run a sim for `ms` and bucket events + half-second concurrency snapshots by level. */
function perLevel(s: Sim, ms: number, input: (sim: Sim) => Input, levels: { level: number; fromMs: number; untilMs: number | null }[]) {
  const conc = new Map<number, number[]>();
  const dt = 1000 / 60;
  let next = 0;
  while (s.t < ms && s.phase === 'PLAYING') {
    s.frame(dt, input(s));
    if (s.t >= next) { next += 500; const lv = levelOf(s.t, levels); (conc.get(lv) ?? conc.set(lv, []).get(lv)!).push(s.projectiles.length); }
  }
  const byLv = new Map<number, LogEvent[]>();
  for (const e of s.log) { const lv = levelOf(e.t, levels); (byLv.get(lv) ?? byLv.set(lv, []).get(lv)!).push(e); }
  const rows: Record<string, unknown>[] = [];
  for (const lv of [...byLv.keys()].sort((a, b) => a - b)) {
    if (lv === 0) continue;
    const ev = byLv.get(lv)!;
    const L = levels.find((l) => l.level === lv)!;
    const durS = ((L.untilMs ?? ms) - L.fromMs) / 1000;
    const sp = ev.filter((e) => e.type === 'spawn');
    const n = sp.length || 1;
    const tier = (k: string) => r(sp.filter((e) => e.tier === k).length / n, 2);
    const pat = (k: string) => sp.filter((e) => e.pattern === k).length;
    const aimedFlight = sp.filter((e) => e.flightMs !== null && e.flightMs !== undefined).map((e) => e.flightMs as number);
    const fastFlight = sp.filter((e) => e.tier === 'fast').map((e) => e.flightMs as number);
    const c = conc.get(lv) ?? [];
    rows.push({
      lv, spawnPerMin: r((sp.length / durS) * 60, 0), large: r(sp.filter((e) => e.kind === 'large').length / n, 2),
      slow: tier('slow'), normal: tier('normal'), fast: tier('fast'),
      aimed: pat('aimed'), wallDarts: pat('volley'), fanDarts: pat('fan'),
      groupsPerMin: r((new Set(sp.map((e) => e.group + ':' + e.t)).size / durS) * 60, 0),
      concMean: r(c.reduce((a, v) => a + v, 0) / (c.length || 1)), concP95: pct(c, 0.95), concMax: Math.max(0, ...c),
      flightP10: r(pct(aimedFlight, 0.1), 0), flightMed: r(pct(aimedFlight, 0.5), 0), fastFlightMin: fastFlight.length ? Math.min(...fastFlight) : null, fastFlightMed: r(pct(fastFlight, 0.5), 0),
      flipsPerMin: r((ev.filter((e) => e.type === 'flip').length / durS) * 60, 1), telePerMin: r((ev.filter((e) => e.type === 'telegraph').length / durS) * 60, 1),
      cancelled: ev.filter((e) => e.type === 'spawn_cancelled').length, skipped: ev.filter((e) => e.type === 'spawn_skipped').length,
    });
  }
  return rows;
}

describe.skipIf(!process.env.DIAG)('mechanics diagnostics', () => {
  it('dodge (g3): per level, centre-parked immortal / corner-parked immortal / geometric bot', () => {
    const L = LEVELS.dodge.levels;
    const mk = () => { const s = new Sim('A', 5, immortal()); s.begin(); for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle); return s; };
    console.log('[dodge centre-parked]', JSON.stringify(perLevel(mk(), 120000, () => idle, L)));
    console.log('[dodge corner-parked]', JSON.stringify(perLevel(mk(), 120000, () => keysOf('KeyA', 'KeyW'), L)));
    const bot = new DodgeBot();
    console.log('[dodge bot A]', JSON.stringify(perLevel(mk(), 120000, (s) => ({ keys: bot.keys(s), pointer: null, clicks: [] }), L)));
    expect(true).toBe(true);
  });

  it('dodge LV.10 composition over 10 minutes (group starts and darts by group)', () => {
    const s = new Sim('A', 21, immortal());
    s.begin();
    while (s.t < 600000) s.frame(1000 / 60, idle);
    const starts: Record<string, number> = {}, darts: Record<string, number> = {};
    const seen = new Set<number>();
    for (const e of s.schedule) { if (e.tMs < 45000 || e.tMs > s.t) continue; if (!seen.has(e.groupId)) { seen.add(e.groupId); starts[e.group] = (starts[e.group] ?? 0) + 1; } }
    for (const e of s.log) if (e.type === 'spawn' && e.t >= 45000) darts[e.group as string] = (darts[e.group as string] ?? 0) + 1;
    const tot = Object.values(darts).reduce((a, v) => a + v, 0), totS = Object.values(starts).reduce((a, v) => a + v, 0);
    const byPattern: Record<string, number> = {};
    for (const e of s.log) if (e.type === 'spawn' && e.t >= 45000) byPattern[e.pattern as string] = (byPattern[e.pattern as string] ?? 0) + 1;
    console.log('[LV10 10min] group starts', JSON.stringify(Object.fromEntries(Object.entries(starts).map(([k, v]) => [k, `${v} (${r((v / totS) * 100, 0)}%)`]))));
    console.log('[LV10 10min] darts', JSON.stringify(Object.fromEntries(Object.entries(darts).map(([k, v]) => [k, `${v} (${r((v / tot) * 100, 0)}%)`]))), 'byPattern', JSON.stringify(Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [k, r((v / tot) * 100, 0) + '%']))));
    expect(true).toBe(true);
  });

  it('does hugging a corner pay off? geometric bot with centre bias vs corner bias (g3, 180 s cap)', () => {
    const runBot = (seed: number, centerBias: number) => {
      const s = new Sim('A', seed, CONFIG, { autopilot: true });
      s.begin();
      for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle);
      const bot = new DodgeBot({ reactionMs: 250, horizonMs: 1200, decideEveryMs: 50, centerBias });
      let cornerSteps = 0, steps = 0;
      while (s.phase === 'PLAYING' && s.t < 180000) {
        s.frame(1000 / 60, { keys: bot.keys(s), pointer: null, clicks: [] });
        steps++;
        if (Math.min(s.player.x, 960 - s.player.x) < 150 && Math.min(s.player.y, 540 - s.player.y) < 150) cornerSteps++;
      }
      if (s.phase === 'PLAYING') s.abandon();
      return { survival: s.survivalMs, alive: s.endReason === 'abandoned', cornerShare: cornerSteps / steps, flips: s.counters.flips, medFlight: pct(s.log.filter((e) => e.type === 'spawn' && e.flightMs != null).map((e) => e.flightMs as number), 0.5) };
    };
    for (const bias of [1, -2]) {
      const rs = Array.from({ length: 20 }, (_, i) => runBot(i + 1, bias));
      const sv = rs.map((x) => x.survival);
      console.log(`[corner probe centerBias=${bias}] alive ${rs.filter((x) => x.alive).length}/20 · median ${r(pct(sv, 0.5) / 1000)}s · min ${r(Math.min(...sv) / 1000)}s · corner time ${r(rs.reduce((a, x) => a + x.cornerShare, 0) / rs.length * 100, 0)}% · flips/round ${r(rs.reduce((a, x) => a + x.flips, 0) / rs.length)} · median aimed flight ${r(rs.reduce((a, x) => a + x.medFlight, 0) / rs.length, 0)}ms`);
    }
    expect(true).toBe(true);
  });

  it('threat relevance: how many darts actually come for the player? g3.1 vs g3.2 (aware), reactive bot 250 ms, 120 s', () => {
    const measure = (levels: Levels, seed: number, geo = false) => {
      const s = new Sim('A', seed, CONFIG, { levels, autopilot: true });
      s.begin();
      for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle);
      const bot = geo ? new DodgeBot({ reactionMs: 150 }) : new ReactiveBot({ reactionMs: 250, perceiveEveryMs: 100 });
      // closest approach of each dart to the player, measured every step while both exist
      const closest = new Map<number, number>();
      while (s.phase === 'PLAYING' && s.t < 120000) {
        s.frame(1000 / 60, { keys: bot.keys(s), pointer: null, clicks: [] });
        for (const p of s.projectiles) { const d = Math.hypot(p.x - s.player.x, p.y - s.player.y); if (d < (closest.get(p.id) ?? Infinity)) closest.set(p.id, d); }
      }
      const spawns = s.log.filter((e) => e.type === 'spawn');
      const ds = spawns.map((e) => closest.get(e.id as number) ?? Infinity).filter((d) => d < Infinity);
      const flights = spawns.filter((e) => e.flightMs != null).map((e) => e.flightMs as number);
      const byPat: Record<string, number> = {};
      for (const e of spawns) byPat[e.pattern as string] = (byPat[e.pattern as string] ?? 0) + 1;
      const tier: Record<string, number> = {};
      for (const e of spawns) tier[e.tier as string] = (tier[e.tier as string] ?? 0) + 1;
      return {
        survivalS: r(s.survivalMs / 1000), died: s.endReason === 'hit', darts: spawns.length, perMin: r((spawns.length / (s.t / 60000)), 0),
        within40px: r(ds.filter((d) => d <= 40).length / ds.length, 2), within80px: r(ds.filter((d) => d <= 80).length / ds.length, 2), medianClosestPx: r(pct(ds, 0.5), 0),
        medianFlightMs: r(pct(flights, 0.5), 0), slowShare: r((tier.slow ?? 0) / spawns.length, 2), fastShare: r((tier.fast ?? 0) / spawns.length, 2),
        byPattern: Object.fromEntries(Object.entries(byPat).map(([k, v]) => [k, r(v / spawns.length, 2)])),
      };
    };
    for (const geo of [false, true]) for (const [name, levels] of Object.entries(LEVEL_PRESETS)) {
      const rows = [1, 2, 3, 4, 5].map((seed) => measure(levels, seed, geo));
      const avg = (k: keyof ReturnType<typeof measure>) => r(rows.reduce((a, x) => a + (x[k] as number), 0) / rows.length, 2);
      console.log(`[relevance ${name} ${geo ? 'geometric 150ms' : 'reactive 250ms'}] survival ${rows.map((x) => x.survivalS + (x.died ? '†' : '')).join('/')}s · darts/min ${avg('perMin')} · closest≤40px ${avg('within40px')} · ≤80px ${avg('within80px')} · median closest ${avg('medianClosestPx')}px · median flight ${avg('medianFlightMs')}ms · slow ${avg('slowShare')} fast ${avg('fastShare')} · patterns ${JSON.stringify(rows[0].byPattern)}`);
    }
    expect(true).toBe(true);
  });

  it('density per park: concurrency and ceiling pressure, g3.1 vs g3.2, 120 s immortal', () => {
    for (const [name, levels] of Object.entries(LEVEL_PRESETS)) {
      for (const [pname, park] of [['centre', idle], ['TL', keysOf('KeyA', 'KeyW')], ['right', keysOf('KeyD')], ['bottom', keysOf('KeyS')]] as const) {
        const s = new Sim('A', 300, immortal(), { levels });
        s.begin();
        for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle);
        const conc: number[] = [], lv10: number[] = [];
        let steps = 0;
        while (s.t < 120000) { s.frame(1000 / 60, park); if (++steps % 6 === 0) { conc.push(s.projectiles.length); if (s.t >= 45000) lv10.push(s.projectiles.length); } }
        const skips: Record<string, number> = {};
        for (const e of s.log) if (e.type === 'spawn_skipped' || e.type === 'spawn_cancelled') { const k = `${e.reason}:${e.group}`; skips[k] = (skips[k] ?? 0) + 1; }
        const spawns = s.log.filter((e) => e.type === 'spawn').length;
        console.log(`[density ${name} ${pname}] spawned ${spawns} (${Math.round(spawns / 2)}/min) · max conc ${Math.max(...conc)} · LV10 mean ${r(lv10.reduce((a, b) => a + b, 0) / lv10.length)} p95 ${pct(lv10, 0.95)} max ${Math.max(...lv10)} · notFired ${JSON.stringify(skips)}`);
      }
    }
    expect(true).toBe(true);
  });

  it('defend (c3): per level with an indestructible core; time-to-core and click budget', () => {
    const levels: Levels = { ...LEVELS, defend: { ...LEVELS.defend, coreHitPoints: 1e9 } };
    const s = new Sim('C', 5, CONFIG, { levels });
    s.begin();
    for (let i = 0; i < 61; i++) s.frame(1000 / 60, idle);
    const rows = perLevel(s, 120000, () => idle, LEVELS.defend.levels);
    // time from spawn to core per tier (no clicks: every dart reaches the core)
    const spawnT = new Map<number, LogEvent>();
    for (const e of s.log) if (e.type === 'spawn') spawnT.set(e.id as number, e);
    const ttc: Record<string, number[]> = { slow: [], normal: [], fast: [] };
    for (const e of s.log) if (e.type === 'core_hit' || e.type === 'core_absorbed') { const sp = spawnT.get(e.id as number); if (sp) ttc[sp.tier as string].push(e.t - sp.t); }
    console.log('[defend per level]', JSON.stringify(rows));
    console.log('[defend time-to-core ms p10/med/p90]', JSON.stringify(Object.fromEntries(Object.entries(ttc).map(([k, v]) => [k, v.length ? [pct(v, 0.1), pct(v, 0.5), pct(v, 0.9)] : null]))));
    console.log('[defend levelcap skips]', JSON.stringify(s.log.filter((e) => e.type === 'spawn_skipped').reduce((m: Record<string, number>, e) => { const k = `LV${levelOf(e.t, LEVELS.defend.levels)}:${e.reason}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})));
    expect(true).toBe(true);
  });
});
