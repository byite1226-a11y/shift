import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG, PATTERNS, LEVEL_PRESETS } from './config';
import { Sim, type Input, type LogEvent, type ScheduleKind } from './sim';
import { DodgeBot, ReactiveBot, type BotLike } from './bot';

/**
 * Automated fairness / stability sweep. Two bots play mode A on many seeds, on the Gate 02 and Gate 01 schedules:
 *   A geometric — exact kinematics of visible darts, time-to-collision search (upper bound on what a player could do)
 *   B reactive  — only what is drawn, velocity estimated from two sightings, ignores markers and schedule
 * Neither bot's survival says anything about human difficulty.
 *   SWEEP_SEEDS=200 SWEEP_REACTION=150 SWEEP_WRITE=1 [SWEEP_OUT=docs/logs/x.json] npx vitest run src/sweep.test.ts
 */
const N = Number(process.env.SWEEP_SEEDS ?? 60);
const REACTION = Number(process.env.SWEEP_REACTION ?? 150);
const OUT = process.env.SWEEP_OUT ?? 'docs/logs/sweep-summary.json';
const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
type BotKind = 'geometric' | 'reactive';

const G3_CAP_MS = Number(process.env.SWEEP_G3_CAP_MS ?? 180000); // endless rounds are cut here (censored) for the sweep
const G3_SEEDS = Number(process.env.SWEEP_G3_SEEDS ?? 20);
const G3_LEVELS = LEVEL_PRESETS[process.env.SWEEP_DIFF ?? 'default']; // SWEEP_DIFF=aware → the g3.2 preset for the gate03 sweep

function play(seed: number, schedule: ScheduleKind, bot: BotKind, reactionMs: number, capMs = 45000): Sim {
  const s = new Sim('A', seed, CONFIG, { schedule, autopilot: true, levels: G3_LEVELS });
  s.begin();
  const b: BotLike = bot === 'geometric'
    ? new DodgeBot({ reactionMs, horizonMs: 1200, decideEveryMs: 50 })
    : new ReactiveBot({ reactionMs, perceiveEveryMs: 100 });
  const dt = 1000 / 60;
  for (let i = 0; i < 61; i++) s.frame(dt, idle);
  while (s.phase === 'PLAYING' && s.t < capMs) s.frame(dt, { keys: b.keys(s), pointer: null, clicks: [] });
  if (s.phase === 'PLAYING') s.abandon(); // censored at the cap: survivalMs = capMs, reason 'abandoned'
  return s;
}

const tally = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const pct = (a: number, b: number) => (b ? +(a / b).toFixed(4) : 0);

function survival(sims: Sim[]) {
  const rows = sims.map((s) => {
    const col = s.log.find((e) => e.type === 'collision');
    const sp = col ? (s.log.find((e) => e.type === 'spawn' && e.id === col.id) as LogEvent) : null;
    return {
      seed: s.seed, reason: s.endReason, survivalMs: s.survivalMs,
      killer: sp && col ? {
        group: sp.group as string, pattern: sp.pattern as string, tier: sp.tier as string, kind: sp.kind as string,
        flightMs: sp.flightMs as number | null, telegraphed: sp.telegraphed as boolean,
        visibleForMs: col.t - (sp.t - (sp.telegraphed ? PATTERNS.fairness.fastTelegraphMs : 0)),
      } : null,
    };
  });
  const deaths = rows.filter((r) => r.reason === 'hit');
  const by = (key: (r: typeof rows[number]) => string) => { const m: Record<string, number> = {}; for (const r of deaths) tally(m, key(r)); return m; };
  const times = rows.map((r) => r.survivalMs).sort((a, b) => a - b);
  return {
    seeds: rows.length,
    clearRate: pct(rows.filter((r) => r.reason === 'clear').length, rows.length),
    medianSurvivalMs: times[Math.floor(times.length / 2)],
    deathsByGroup: by((r) => r.killer?.group ?? '?'),
    deathsByTier: by((r) => r.killer?.tier ?? '?'),
    deathsByPhase: by((r) => `P${PATTERNS.phases.findIndex((p) => r.survivalMs >= p.fromMs && r.survivalMs < p.untilMs) + 1}`),
    suspicious: deaths.filter((r) => (r.killer?.visibleForMs ?? 9999) < 400).map((r) => ({ seed: r.seed, t: r.survivalMs, ...r.killer })),
    deaths: deaths.map((r) => ({ seed: r.seed, t: r.survivalMs, ...r.killer })),
  };
}

/** Schedule accounting, pattern mix, concurrency, coexistence, danger samples, telegraph consistency. */
function stats(sims: Sim[]) {
  const planned: Record<string, number> = {}, spawned: Record<string, number> = {}, notFired: Record<string, number> = {};
  const plannedPhase: Record<string, number> = {}, spawnedPhase: Record<string, number> = {};
  const plannedTier: Record<string, number> = {}, spawnedTier: Record<string, number> = {}, notFiredTier: Record<string, number> = {};
  const groupStarts: Record<string, number> = {};
  const counts: number[] = [];
  let samples = 0, coexist = 0, samplesLate = 0, coexistLate = 0, danger = 0;
  const dangerByGroup: Record<string, number> = {};
  let teleMismatch = 0, teleUnfired = 0, teleChecked = 0, flips = 0, maxActive = 0, minFlight = Infinity;
  for (const s of sims) {
    const a = s.accounting();
    for (const [k, v] of Object.entries(a.planned)) tally(planned, k, v);
    for (const [k, v] of Object.entries(a.spawned)) tally(spawned, k, v);
    for (const [k, v] of Object.entries(a.notFired)) tally(notFired, k, v);
    for (const [k, v] of Object.entries(a.plannedPhase)) tally(plannedPhase, k, v);
    for (const [k, v] of Object.entries(a.spawnedPhase)) tally(spawnedPhase, k, v);
    for (const [k, v] of Object.entries(a.plannedTier)) tally(plannedTier, k, v);
    for (const [k, v] of Object.entries(a.spawnedTier)) tally(spawnedTier, k, v);
    for (const [k, v] of Object.entries(a.notFiredTier)) tally(notFiredTier, k, v);
    const seenGroups = new Set<number>();
    for (const e of s.schedule) { if (e.tMs > s.t) break; if (!seenGroups.has(e.groupId)) { seenGroups.add(e.groupId); tally(groupStarts, e.group); } }
    const tierOf = new Map<number, string>(), groupOf = new Map<number, string>();
    for (const e of s.log) {
      if (e.type === 'spawn') {
        tierOf.set(e.id as number, e.tier as string); groupOf.set(e.id as number, e.group as string);
        if ((e.flightAtResolveMs as number) < minFlight) minFlight = e.flightAtResolveMs as number;
      }
    }
    for (const sm of s.samples) {
      samples++;
      counts.push(sm.proj.length);
      let hasFast = false, hasSlow = false, nearest = Infinity, nearestGroup = '';
      for (const [id, x, y] of sm.proj) {
        const tier = tierOf.get(id);
        if (tier === 'fast') hasFast = true; else if (tier === 'slow') hasSlow = true;
        if (sm.player) { const d = Math.hypot(x - sm.player[0], y - sm.player[1]); if (d < nearest) { nearest = d; nearestGroup = groupOf.get(id) ?? '?'; } }
      }
      if (hasFast && hasSlow) coexist++;
      if (sm.t >= 18000) { samplesLate++; if (hasFast && hasSlow) coexistLate++; }
      if (nearest <= 40) { danger++; tally(dangerByGroup, nearestGroup); }
    }
    const spawnsByTele = new Map<number, LogEvent>();
    for (const e of s.log) if (e.type === 'spawn' && e.telegraphId !== undefined) spawnsByTele.set(e.telegraphId as number, e);
    for (const tg of s.log) {
      if (tg.type !== 'telegraph' || (tg.fireAt as number) > s.t) continue;
      teleChecked++;
      const sp = spawnsByTele.get(tg.id as number);
      if (!sp) teleUnfired++;
      else if (sp.x !== tg.x || sp.y !== tg.y || sp.t !== tg.fireAt) teleMismatch++;
    }
    flips += s.counters.flips;
    if (s.counters.maxActive > maxActive) maxActive = s.counters.maxActive;
  }
  counts.sort((a, b) => a - b);
  const plannedFast = plannedTier.fast ?? 0;
  const notFiredFast = Object.entries(notFiredTier).filter(([k]) => k.startsWith('fast:')).reduce((a, [, v]) => a + v, 0);
  const plannedAll = Object.values(planned).reduce((a, v) => a + v, 0);
  const spawnedAll = Object.values(spawned).reduce((a, v) => a + v, 0);
  const notFiredMax = (notFired['spawn_skipped:max'] ?? 0) + (notFired['spawn_cancelled:max'] ?? 0);
  const share: Record<string, number> = {};
  for (const [k, v] of Object.entries(spawned)) share[k] = pct(v, spawnedAll);
  return {
    rounds: sims.length,
    groupStarts, projectilesByGroup: spawned, projectileShareByGroup: share,
    plannedByGroup: planned, notFired, plannedByPhase: plannedPhase, spawnedByPhase: spawnedPhase,
    plannedByTier: plannedTier, spawnedByTier: spawnedTier, notFiredByTier: notFiredTier,
    skipRatio: {
      fast: { numerator: notFiredFast, denominator: plannedFast, ratio: pct(notFiredFast, plannedFast) },
      ceiling: { numerator: notFiredMax, denominator: plannedAll, ratio: pct(notFiredMax, plannedAll) },
      all: { numerator: plannedAll - spawnedAll, denominator: plannedAll, ratio: pct(plannedAll - spawnedAll, plannedAll) },
    },
    concurrency: { max: counts[counts.length - 1] ?? 0, mean: +(counts.reduce((a, v) => a + v, 0) / (counts.length || 1)).toFixed(2), p95: counts[Math.floor(0.95 * (counts.length - 1))] ?? 0, samples },
    fastSlowCoexist: { overall: pct(coexist, samples), after18s: pct(coexistLate, samplesLate) },
    danger40px: { samples: danger, fraction: pct(danger, samples), byNearestGroup: dangerByGroup },
    telegraph: { checked: teleChecked, originMismatch: teleMismatch, shownButNotFired: teleUnfired },
    flipsPerRound: +(flips / (sims.length || 1)).toFixed(2), maxActive, minFlightMs: minFlight,
  };
}

describe(`sweep (${N} seeds, reaction ${REACTION} ms)`, () => {
  const seeds = Array.from({ length: N }, (_, i) => i + 1);
  const run = (sched: ScheduleKind, bot: BotKind) => seeds.map((seed) => play(seed, sched, bot, REACTION));
  const geoG2 = run('g2', 'geometric'), geoG1 = run('g1', 'geometric');
  const reaG2 = run('g2', 'reactive'), reaG1 = run('g1', 'reactive');
  // Gate 03 endless (g3): censored at G3_CAP_MS; "clear" here means "still alive at the cap"
  const g3seeds = Array.from({ length: G3_SEEDS }, (_, i) => i + 1);
  const geoG3 = g3seeds.map((seed) => play(seed, 'g3', 'geometric', REACTION, G3_CAP_MS));
  const reaG3 = g3seeds.map((seed) => play(seed, 'g3', 'reactive', REACTION, G3_CAP_MS));
  const g3Survival = (sims: Sim[]) => {
    const t = sims.map((s) => s.survivalMs).sort((a, b) => a - b);
    const alive = sims.filter((s) => s.endReason === 'abandoned').length;
    const levels = sims.map((s) => s.reachedLevel);
    return { seeds: sims.length, capMs: G3_CAP_MS, aliveAtCap: alive, aliveRate: +(alive / sims.length).toFixed(3), medianSurvivalMs: t[Math.floor(t.length / 2)], minSurvivalMs: t[0], meanLevel: +(levels.reduce((a, v) => a + v, 0) / levels.length).toFixed(1), deathsByGroup: survival(sims).deathsByGroup };
  };
  const summary = {
    generatedAt: new Date().toISOString(), seeds: N, reactionMs: REACTION,
    bots: {
      geometric: { gate02: survival(geoG2), gate01: survival(geoG1) },
      reactive: { gate02: survival(reaG2), gate01: survival(reaG1) },
    },
    gate03: { geometric: g3Survival(geoG3), reactive: g3Survival(reaG3), stats: stats(geoG3) },
    stats: { gate02: stats(geoG2), gate01: stats(geoG1), gate02_reactiveRounds: stats(reaG2) },
  };
  const S = summary.stats.gate02;
  for (const [bot, b] of Object.entries(summary.bots)) for (const [g, v] of Object.entries(b))
    console.log(`[sweep ${bot} ${g}] clear ${(v.clearRate * 100).toFixed(0)}% · median ${(v.medianSurvivalMs / 1000).toFixed(1)}s · deaths ${JSON.stringify(v.deathsByGroup)} · suspicious ${v.suspicious.length}`);
  for (const [bot, v] of Object.entries({ geometric: summary.gate03.geometric, reactive: summary.gate03.reactive }))
    console.log(`[sweep ${bot} gate03 cap ${G3_CAP_MS / 1000}s] alive ${(v.aliveRate * 100).toFixed(0)}% · median ${(v.medianSurvivalMs / 1000).toFixed(1)}s · min ${(v.minSurvivalMs / 1000).toFixed(1)}s · mean LV ${v.meanLevel} · deaths ${JSON.stringify(v.deathsByGroup)}`);
  console.log(`[stats gate03] skip fast ${summary.gate03.stats.skipRatio.fast.numerator}/${summary.gate03.stats.skipRatio.fast.denominator} · ceiling ${summary.gate03.stats.skipRatio.ceiling.numerator}/${summary.gate03.stats.skipRatio.ceiling.denominator} · tele ${JSON.stringify(summary.gate03.stats.telegraph)} · minFlight ${summary.gate03.stats.minFlightMs} · concurrency ${JSON.stringify(summary.gate03.stats.concurrency)} · share ${JSON.stringify(summary.gate03.stats.projectileShareByGroup)}`);
  console.log(`[stats gate02] skip fast ${S.skipRatio.fast.numerator}/${S.skipRatio.fast.denominator}=${(S.skipRatio.fast.ratio * 100).toFixed(1)}% · ceiling ${S.skipRatio.ceiling.numerator}/${S.skipRatio.ceiling.denominator} · all ${S.skipRatio.all.numerator}/${S.skipRatio.all.denominator} · notFired ${JSON.stringify(S.notFired)} · concurrency max ${S.concurrency.max} mean ${S.concurrency.mean} p95 ${S.concurrency.p95} · coexist ${S.fastSlowCoexist.overall}/${S.fastSlowCoexist.after18s} · danger ${S.danger40px.fraction} · tele ${JSON.stringify(S.telegraph)} · flips/round ${S.flipsPerRound} · share ${JSON.stringify(S.projectileShareByGroup)} · starts ${JSON.stringify(S.groupStarts)}`);
  if (process.env.SWEEP_WRITE) {
    mkdirSync('docs/logs', { recursive: true });
    writeFileSync(OUT, JSON.stringify(summary, null, 1));
  }

  it('every dart had ≥ minFlightMs of flight time when its origin was decided', () => {
    expect(S.minFlightMs).toBeGreaterThanOrEqual(PATTERNS.fairness.minFlightMs);
  });

  it('a shown telegraph is a promise: 0 origin mismatches, 0 markers without a shot', () => {
    expect(S.telegraph.checked).toBeGreaterThan(0);
    expect(S.telegraph.originMismatch).toBe(0);
    expect(S.telegraph.shownButNotFired).toBe(0);
    expect(summary.stats.gate02_reactiveRounds.telegraph.originMismatch).toBe(0);
    expect(summary.stats.gate02_reactiveRounds.telegraph.shownButNotFired).toBe(0);
  });

  it('scheduled shots fire: fast shots not fired < 5 % of planned fast shots, ceiling drops < 1 % of all planned', () => {
    expect(S.skipRatio.fast.ratio).toBeLessThan(0.05);
    expect(S.skipRatio.ceiling.ratio).toBeLessThan(0.01);
  });

  it('the geometric bot survives most Gate 02 rounds (regression floor, not a difficulty claim)', () => {
    expect(summary.bots.geometric.gate02.clearRate).toBeGreaterThanOrEqual(0.8);
  });
});
