import type { Config, CoreLevelDef, Kind, LevelDef, Levels, Patterns, Tier, TimerLevelDef, TimerSpec } from './config';
import { mulberry32 } from './rng';

export type Side = 0 | 1 | 2 | 3; // top, right, bottom, left
export interface EdgePoint { x: number; y: number; side: Side }

/**
 * One projectile to fire. Produced by the Gate 01 builder (static, 40 s), the pattern scheduler
 * (Gate 02 phases or Gate 03 levels, streamed) and the core scheduler (Gate 03 defend levels).
 *  - aim 'player': direction decided at fire time toward the player/core, plus angleOffsetRad (fans).
 *  - aim vector:   fixed direction (volley walls / lines); negated when the wall is flipped to its alt side.
 *  - alt:          fallback origin on the opposite side, used when the primary origin would give the
 *                  player less than fairness.minFlightMs of flight time. Fans (fanId) and walls (wallId)
 *                  flip as a whole.
 *  - dir:          timer-scheduler line (g3.2): the row is centred on the player when it is placed, so x/y/alt
 *                  are filled in by the sim at plan time; lineOffsetPx is this dart's offset along the row.
 */
export interface SpawnEvent {
  tMs: number;
  x: number;
  y: number;
  side: Side;
  speed: number;
  pattern: 'aimed' | 'volley' | 'fan';
  kind: Kind;
  tier: Tier;
  group: string;
  groupId: number;
  aim: 'player' | { dx: number; dy: number };
  angleOffsetRad?: number;
  fanId?: number;
  wallId?: number;
  alt?: EdgePoint & { distPx?: number };
  distPx?: number;         // lines: distance from the row's front to the player along the travel direction (set when placed)
  dir?: number;            // lines: index into LINE_DIRS (where the row comes from)
  lineOffsetPx?: number;
  burstId?: number;        // bursts: the sim fixes the aim point when the burst is due and staggers the fire times so every dart arrives together
  armored?: boolean;       // mode D: cannot be clicked away (unset = large darts only)
  telegraphMs?: number;
  maxActiveFast: number;
  maxActive?: number;  // defend levels: skip when this many darts are already on screen
  level?: number;
  corridorPx?: number; // volley: free width of the gap between neighbouring darts (centre to centre minus hit diameters)
}

/** Projectiles start this far outside the field edge so they visibly enter from the border, never pop in. */
export const SPAWN_OUTSET_PX = 14;
const EDGE_MARGIN = 0.08; // keep away from corners (fraction of the side length)

function edgePoint(side: Side, u: number, W: number, H: number): EdgePoint {
  const x = side === 0 || side === 2 ? u * W : side === 1 ? W + SPAWN_OUTSET_PX : -SPAWN_OUTSET_PX;
  const y = side === 1 || side === 3 ? u * H : side === 2 ? H + SPAWN_OUTSET_PX : -SPAWN_OUTSET_PX;
  return { x: +x.toFixed(2), y: +y.toFixed(2), side };
}
const opposite = (s: Side): Side => ((s + 2) % 4) as Side;
const byTime = (a: SpawnEvent, b: SpawnEvent) => a.tMs - b.tMs || a.groupId - b.groupId;

function shuffledSides(rng: () => number): Side[] {
  const sides: Side[] = [0, 1, 2, 3];
  for (let i = sides.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sides[i], sides[j]] = [sides[j], sides[i]]; }
  return sides;
}

/** Which level is active at t (levels are contiguous; the last one may be open-ended). */
export function levelAt<T extends { fromMs: number; untilMs: number | null }>(levels: T[], t: number): T | null {
  for (const l of levels) if (t >= l.fromMs && (l.untilMs === null || t < l.untilMs)) return l;
  return null;
}

// ---------------------------------------------------------------------------
// Gate 01: 1–3 aimed normal darts per pattern, distinct sides. Legacy (`?sched=g1`).
// ---------------------------------------------------------------------------
export function buildSchedule(seed: number, cfg: Config): SpawnEvent[] {
  const rng = mulberry32(seed);
  const { width: W, height: H, roundCapMs, firstSpawnAtMs } = cfg.world;
  const phases = cfg.spawnPhases;
  const out: SpawnEvent[] = [];
  let t = firstSpawnAtMs;
  let pattern = 0;
  while (t < roundCapMs) {
    const ph = phases.find((p) => t >= p.fromMs && t < p.untilMs) ?? phases[phases.length - 1];
    const [lo, hi] = ph.projectilesPerPattern;
    const n = Math.min(4, lo + Math.floor(rng() * (hi - lo + 1)));
    const sides: Side[] = [0, 1, 2, 3];
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (sides.length - i));
      [sides[i], sides[j]] = [sides[j], sides[i]];
      const u = EDGE_MARGIN + rng() * (1 - 2 * EDGE_MARGIN);
      const p = edgePoint(sides[i], u, W, H);
      out.push({
        tMs: t, ...p, speed: ph.projectileSpeedPxPerSec, pattern: 'aimed', kind: 'normal',
        tier: ph.projectileSpeedPxPerSec >= 300 ? 'fast' : ph.projectileSpeedPxPerSec >= 185 ? 'normal' : 'slow',
        group: 'gate01', groupId: pattern, aim: 'player', maxActiveFast: 99, level: phases.indexOf(ph) + 1,
      });
    }
    pattern++;
    t += ph.intervalMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern scheduler: aimed / volley-with-gap / fan groups on a level table, generated on demand so a
// round can run for ever. Gate 02 (phases, 40 s) and Gate 03 (levels, open-ended) share it.
// ---------------------------------------------------------------------------
export interface SchedulerOptions { startMs: number; endMs: number | null; seedSalt?: number }

export class PatternScheduler {
  /** Everything generated so far, sorted by fire time. */
  readonly events: SpawnEvent[] = [];
  private readonly rng: () => number;
  private t: number;
  private prev: string | null = null;
  private lastFastT = -Infinity;
  private lastWallT = -Infinity;
  private groupId = 0;
  private fanId = 0;
  private wallId = 0;
  readonly maxTelegraphMs: number;

  constructor(seed: number, readonly cfg: Config, readonly pat: Patterns, readonly levels: LevelDef[], readonly opts: SchedulerOptions) {
    this.rng = mulberry32(seed ^ (opts.seedSalt ?? 0x9e3779b9)); // distinct stream from the Gate 01 builder on purpose
    this.t = opts.startMs;
    this.maxTelegraphMs = Object.values(pat.patterns).reduce((m, g) => Math.max(m, ...g.steps.map((s) => s.telegraphMs ?? 0)), 0);
  }

  levelAt(t: number): LevelDef | null { return levelAt(this.levels, t); }

  private fastTimes(name: string, t0: number) { return this.pat.patterns[name].steps.filter((s) => s.tier === 'fast').map((s) => t0 + s.atMs); }
  private wallTimes(name: string, t0: number) { return this.pat.patterns[name].steps.filter((s) => s.pattern === 'volley').map((s) => t0 + s.atMs); }

  private pickGroup(lv: LevelDef, exclude: string | null, t0: number): string {
    let pool = lv.playlist.filter(([name]) => name !== exclude);
    // fast shots stay sparse and walls never stack: groups that would violate a gap are not eligible
    const fastGap = lv.minFastGapMs ?? this.pat.fairness.minFastGapMs;
    const spaced = pool.filter(([name]) =>
      this.fastTimes(name, t0).every((ft) => ft - this.lastFastT >= fastGap) &&
      this.wallTimes(name, t0).every((wt) => wt - this.lastWallT >= this.pat.fairness.minWallGapMs));
    if (spaced.length) pool = spaced;
    else pool = pool.filter(([name]) => this.fastTimes(name, t0).length === 0 && this.wallTimes(name, t0).length === 0) .length
      ? pool.filter(([name]) => this.fastTimes(name, t0).length === 0 && this.wallTimes(name, t0).length === 0) : lv.playlist;
    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = this.rng() * total;
    for (const [name, w] of pool) { r -= w; if (r <= 0) return name; }
    return pool[pool.length - 1][0];
  }

  private emitGroup(name: string, t0: number, lv: LevelDef, out: SpawnEvent[]) {
    const g = this.pat.patterns[name];
    if (!g) throw new Error(`unknown pattern group "${name}"`);
    const { width: W, height: H } = this.cfg.world;
    const rng = this.rng, pat = this.pat;
    const id = this.groupId++;
    const sides = shuffledSides(rng);
    let sideIdx = 0;
    const nextSide = () => sides[sideIdx++ % 4];
    const base = { group: name, groupId: id, maxActiveFast: lv.maxActiveFast, level: lv.level };
    for (const st of g.steps) {
      const tMs = t0 + st.atMs;
      if (this.opts.endMs !== null && tMs >= this.opts.endMs) continue;
      const common = { tMs, speed: st.speed, kind: st.kind, tier: st.tier, ...base };
      if (st.pattern === 'aimed') {
        const side = nextSide();
        const u = EDGE_MARGIN + rng() * (1 - 2 * EDGE_MARGIN);
        out.push({ ...common, ...edgePoint(side, u, W, H), pattern: 'aimed', aim: 'player', alt: edgePoint(opposite(side), u, W, H), telegraphMs: st.telegraphMs });
      } else if (st.pattern === 'fan') {
        const side = nextSide();
        const u = EDGE_MARGIN + rng() * (1 - 2 * EDGE_MARGIN);
        const p = edgePoint(side, u, W, H);
        const alt = edgePoint(opposite(side), u, W, H);
        const rays = st.rays ?? 3, spread = ((st.spreadDeg ?? 40) * Math.PI) / 180;
        const fid = this.fanId++;
        for (let k = 0; k < rays; k++) {
          const off = rays === 1 ? 0 : -spread / 2 + (spread * k) / (rays - 1);
          out.push({ ...common, ...p, pattern: 'fan', aim: 'player', angleOffsetRad: +off.toFixed(5), fanId: fid, alt, telegraphMs: st.telegraphMs });
        }
      } else {
        // volley: a straight wall from one side, evenly spaced, with one interior gap inside the allowed band
        const side = nextSide();
        const horizontal = side === 0 || side === 2; // wall spans x, travels in y
        const L = horizontal ? W : H;
        const spacing = st.spacingPx ?? 80, gapSlots = Math.max(1, st.gapSlots ?? 1);
        const n = Math.floor(L / spacing);
        const margin = (L - (n - 1) * spacing) / 2;
        const band = horizontal ? pat.fairness.wallGapBand.topBottom : pat.fairness.wallGapBand.leftRight;
        const first = Math.max(1, Math.ceil((band[0] * L - margin) / spacing));
        const last = Math.max(first, Math.min(n - gapSlots - 1, Math.floor((band[1] * L - margin) / spacing) - gapSlots + 1));
        const gapStart = first + Math.floor(rng() * (last - first + 1));
        const hitR = pat.projectileKinds[st.kind].hitRadiusPx;
        const corridorPx = +(spacing * (gapSlots + 1) - 2 * hitR).toFixed(1);
        const dir = side === 0 ? { dx: 0, dy: 1 } : side === 2 ? { dx: 0, dy: -1 } : side === 3 ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
        const wid = this.wallId++;
        for (let i = 0; i < n; i++) {
          if (i >= gapStart && i < gapStart + gapSlots) continue;
          const u = (margin + i * spacing) / L;
          out.push({ ...common, ...edgePoint(side, u, W, H), pattern: 'volley', aim: dir, corridorPx, wallId: wid, alt: edgePoint(opposite(side), u, W, H) });
        }
      }
    }
    const ft = this.fastTimes(name, t0);
    if (ft.length) this.lastFastT = Math.max(this.lastFastT, ...ft);
    const wt = this.wallTimes(name, t0);
    if (wt.length) this.lastWallT = Math.max(this.lastWallT, ...wt);
  }

  /** Generate every group that starts before untilMs. Returns the new events, sorted; `events` stays sorted too. */
  emitUntil(untilMs: number): SpawnEvent[] {
    const added: SpawnEvent[] = [];
    while (this.t < untilMs && (this.opts.endMs === null || this.t < this.opts.endMs)) {
      const lv = this.levelAt(this.t);
      if (!lv) break;
      const name = this.pickGroup(lv, this.prev, this.t);
      this.emitGroup(name, this.t, lv, added);
      let heavy = this.pat.patterns[name].heavy;
      if (lv.overlap >= 2 && this.rng() < (lv.overlapChance ?? 0.5)) {
        const t2 = this.t + this.pat.fairness.overlapOffsetMs;
        this.emitGroup(this.pickGroup(lv, name, t2), t2, lv, added);
        heavy = true;
      }
      this.prev = name;
      this.t += lv.intervalMs + (heavy ? lv.restAfterHeavyMs : 0);
    }
    if (added.length) this.merge(added);
    return added;
  }

  private merge(added: SpawnEvent[]) {
    added.sort(byTime);
    const minT = added[0].tMs;
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].tMs > minT) i--; // earlier groups' late steps can interleave
    const tail = this.events.splice(i).concat(added).sort(byTime);
    this.events.push(...tail);
  }
}

/** Gate 02 schedule: phases table, 40 s, static — kept for before/after comparison (`?sched=g2`). */
export function buildPatternSchedule(seed: number, cfg: Config, pat: Patterns): SpawnEvent[] {
  const levels: LevelDef[] = pat.phases.map((p, i) => ({ ...p, level: i + 1 }));
  const s = new PatternScheduler(seed, cfg, pat, levels, { startMs: pat.phases[0].fromMs, endMs: cfg.world.roundCapMs });
  s.emitUntil(cfg.world.roundCapMs);
  return s.events;
}

// ---------------------------------------------------------------------------
// Gate 03 defend scheduler: aimed darts at the core on the defend level table, open-ended.
// Speeds come from the level's tier weights; one speed per pattern, never per dart.
// ---------------------------------------------------------------------------
export class CoreScheduler {
  readonly events: SpawnEvent[] = [];
  private readonly rng: () => number;
  private t: number;
  private groupId = 0;
  readonly maxTelegraphMs = 0;

  constructor(seed: number, readonly cfg: Config, readonly def: Levels['defend']) {
    this.rng = mulberry32(seed ^ 0x51ed270b);
    this.t = def.firstSpawnAtMs;
  }

  levelAt(t: number): CoreLevelDef | null { return levelAt(this.def.levels, t); }

  emitUntil(untilMs: number): SpawnEvent[] {
    const { width: W, height: H } = this.cfg.world;
    const added: SpawnEvent[] = [];
    while (this.t < untilMs) {
      const lv = this.levelAt(this.t);
      if (!lv) break;
      const [lo, hi] = lv.dartsPerPattern;
      const n = Math.min(4, lo + Math.floor(this.rng() * (hi - lo + 1)));
      const tiers = (Object.keys(lv.tierWeights) as Tier[]).filter((k) => lv.tierWeights[k] > 0);
      const total = tiers.reduce((s, k) => s + lv.tierWeights[k], 0);
      let r = this.rng() * total;
      let tier: Tier = tiers[tiers.length - 1];
      for (const k of tiers) { r -= lv.tierWeights[k]; if (r <= 0) { tier = k; break; } }
      const options = this.def.speeds[tier];
      const speed = options[Math.floor(this.rng() * options.length)];
      const sides = shuffledSides(this.rng);
      const id = this.groupId++;
      for (let i = 0; i < n; i++) {
        const u = EDGE_MARGIN + this.rng() * (1 - 2 * EDGE_MARGIN);
        added.push({
          tMs: this.t, ...edgePoint(sides[i], u, W, H), speed, pattern: 'aimed', kind: 'normal', tier,
          group: `core-${tier}`, groupId: id, aim: 'player', maxActiveFast: lv.maxActiveFast, maxActive: lv.maxActive, level: lv.level,
        });
      }
      this.t += lv.intervalMs;
    }
    this.events.push(...added);
    return added;
  }
}

// ---------------------------------------------------------------------------
// Gate 03 "aware" preset (g3.2): 죽림고수-style timer scheduler. Three independent periodic timers — stream,
// line, burst — each on its own cadence, so single aimed darts keep coming while a row or a burst is in flight.
// ---------------------------------------------------------------------------
/** Where a line comes from → the unit direction it travels. 0 top, 1 right, 2 bottom, 3 left, 4–7 the corners (TR, BR, BL, TL). */
const D = Math.SQRT1_2;
export const LINE_DIRS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 },
  { dx: -D, dy: D }, { dx: -D, dy: -D }, { dx: D, dy: -D }, { dx: D, dy: D },
];
type TimerName = 'stream' | 'line' | 'burst';

export class TimerScheduler {
  readonly events: SpawnEvent[] = [];
  private readonly rng: () => number;
  private readonly next: Record<TimerName, number>;
  private groupId = 0;
  private wallId = 0;
  readonly maxTelegraphMs: number;

  constructor(seed: number, readonly cfg: Config, readonly pat: Patterns, readonly table: TimerLevelDef[], firstSpawnAtMs: number) {
    this.rng = mulberry32(seed ^ 0x2b7e1516);
    this.next = { stream: firstSpawnAtMs, line: firstSpawnAtMs, burst: firstSpawnAtMs };
    // a burst's fire times are re-planned by the sim when it is due; a telegraph committed before that would be broken
    if (table.some((lv) => lv.burst?.tier === 'fast')) throw new Error('timer levels: burst cannot be fast-tier (arrive-together planning vs. telegraph)');
    const fast = table.some((lv) => (['stream', 'line', 'burst'] as const).some((k) => lv[k]?.tier === 'fast'));
    this.maxTelegraphMs = fast ? pat.fairness.fastTelegraphMs : 0;
  }

  levelAt(t: number): TimerLevelDef | null { return levelAt(this.table, t); }

  emitUntil(untilMs: number): SpawnEvent[] {
    const added: SpawnEvent[] = [];
    for (;;) {
      const k = (Object.keys(this.next) as TimerName[]).reduce((a, b) => (this.next[b] < this.next[a] ? b : a));
      const t = this.next[k];
      if (t >= untilMs) break;
      const lv = this.levelAt(t);
      if (!lv) break;
      const spec = lv[k];
      if (!spec) {
        // not in this level: resume half a period into the next level that has it, so new elements never debut together
        const start = lv.untilMs;
        if (start === null) { this.next[k] = Infinity; continue; }
        this.next[k] = start + (this.levelAt(start)?.[k]?.everyMs ?? 0) / 2;
        continue;
      }
      if (k === 'stream') this.aimed(t, lv, spec, 'stream', 1, added);
      else if (k === 'burst') this.aimed(t, lv, spec, 'burst', (spec as TimerLevelDef['burst'])!.count, added);
      else this.line(t, lv, spec as NonNullable<TimerLevelDef['line']>, added);
      this.next[k] = t + spec.everyMs;
    }
    this.events.push(...added);
    return added;
  }

  /** n darts at once from n edge points spread over the sides, each aimed at the player when it fires (n = 1: the stream). */
  private aimed(t: number, lv: TimerLevelDef, spec: TimerSpec, group: TimerName, n: number, out: SpawnEvent[]) {
    const { width: W, height: H } = this.cfg.world;
    const id = this.groupId++;
    const sides = shuffledSides(this.rng);
    for (let i = 0; i < n; i++) {
      const side = sides[i % 4];
      const u = EDGE_MARGIN + this.rng() * (1 - 2 * EDGE_MARGIN);
      out.push({
        tMs: t, ...edgePoint(side, u, W, H), speed: spec.speed, pattern: 'aimed', kind: spec.kind ?? 'normal', tier: spec.tier,
        group, groupId: id, aim: 'player', alt: edgePoint(opposite(side), u, W, H), burstId: n > 1 ? id : undefined, armored: spec.armored,
        telegraphMs: spec.tier === 'fast' ? this.pat.fairness.fastTelegraphMs : undefined, maxActiveFast: lv.maxActiveFast, level: lv.level,
      });
    }
  }

  /** A row of `count` darts travelling one of 4/8 directions. Origins are placed by the sim around the player at plan time. */
  private line(t: number, lv: TimerLevelDef, spec: NonNullable<TimerLevelDef['line']>, out: SpawnEvent[]) {
    const id = this.groupId++, wid = this.wallId++;
    const dir = Math.floor(this.rng() * (spec.directions ?? 8));
    const kind = spec.kind ?? 'normal';
    const corridorPx = +(spec.spacingPx - 2 * this.pat.projectileKinds[kind].hitRadiusPx).toFixed(1);
    for (let i = 0; i < spec.count; i++) {
      out.push({
        tMs: t, x: 0, y: 0, side: (dir % 4) as Side, speed: spec.speed, pattern: 'volley', kind, tier: spec.tier, group: 'line', groupId: id,
        aim: LINE_DIRS[dir], dir, lineOffsetPx: (i - (spec.count - 1) / 2) * spec.spacingPx, wallId: wid, corridorPx, armored: spec.armored,
        telegraphMs: spec.tier === 'fast' ? this.pat.fairness.fastTelegraphMs : undefined, maxActiveFast: lv.maxActiveFast, level: lv.level,
      });
    }
  }
}
