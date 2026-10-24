import { LEVELS, PATTERNS, type Config, type Kind, type Levels, type Patterns, type Tier } from './config';
import { CoreScheduler, LINE_DIRS, PatternScheduler, SPAWN_OUTSET_PX, TimerScheduler, buildSchedule, type EdgePoint, type SpawnEvent } from './schedule';
import { clamp, segPointDist, type Vec } from './geom';

export type { Vec };

/** Fixed simulation step. Game time advances only in whole steps, so 60/120/144 Hz all produce the same world. */
export const STEP_MS = 5;
/** One rendered frame may advance the world by at most this much (tab return, GC hitch, debugger). The excess is counted as lost time. */
export const MAX_FRAME_MS = 50;
export const COUNTDOWN_MS = 1000;
export const SAMPLE_EVERY_MS = 100;
/** 100 ms samples kept (ring): 5 minutes. The death trace (`lastSeconds`) is separate. */
export const SAMPLES_KEEP = 3000;
export const MAX_LOG_EVENTS = 20000;
/** Streamed schedules are generated this far ahead of game time (≥ telegraph + overlap offset + longest step). */
export const LOOKAHEAD_MS = 2500;
const CULL_MARGIN_PX = 48;
const PENDING_TRIM = 512;

/** A keyboard dodge · B pointer dodge · C click-intercept around a static core · D keyboard dodge + click-intercept (darts aim at the player, clicks remove them). */
export type Mode = 'A' | 'B' | 'C' | 'D';
export type Phase = 'READY' | 'COUNTDOWN' | 'PLAYING' | 'PAUSED' | 'FINISHED';
export type EndReason = 'hit' | 'core_breach' | 'clear' | 'abandoned';
/** g1/g2: Gate 01/02 legacy, 40 s with CLEAR. g3: Gate 03 dodge levels, endless. c3: Gate 03 defend levels, endless. */
export type ScheduleKind = 'g1' | 'g2' | 'g3' | 'c3';
export const DEFAULT_SCHEDULE: Record<Mode, ScheduleKind> = { A: 'g3', B: 'g3', C: 'c3', D: 'g3' };
export const LEGACY_KINDS: ReadonlySet<ScheduleKind> = new Set<ScheduleKind>(['g1', 'g2']);
export interface SimOptions { schedule?: ScheduleKind; patterns?: Patterns; levels?: Levels; autopilot?: boolean }

export interface Projectile {
  id: number;
  x: number; y: number;
  px: number; py: number; // position at the previous step (for swept collision)
  vx: number; vy: number;
  speed: number;
  kind: Kind;
  tier: Tier;
  r: number;              // hit radius (depends on kind)
  group: string;
  spawnT: number;
  visibleFromT: number;   // telegraph start or spawn time — what a player could have seen
  minDist: number;        // closest centre distance to the player so far (near-miss tracking)
  nearMissDone: boolean;
  armored?: boolean;      // mode D: a click cannot remove it (large darts, or groups flagged `armored` in the level config)
}

export interface Telegraph { id: number; x: number; y: number; startT: number; fireAt: number; tier: Tier }

export interface Input {
  keys: ReadonlySet<string>;   // KeyboardEvent.code values currently held
  pointer: Vec | null;         // latest pointer position in field coordinates
  clicks: Vec[];               // left clicks since the last frame, field coordinates
}

export type SimEvent =
  | { type: 'spawn'; x: number; y: number; angle: number; kind: Kind; tier: Tier; group: string; groupId: number }
  | { type: 'telegraph'; x: number; y: number }
  | { type: 'near_miss'; x: number; y: number }
  | { type: 'hit'; x: number; y: number; angle: number; closeSave: boolean }
  | { type: 'miss'; x: number; y: number }
  | { type: 'core_hit'; x: number; y: number; hp: number }
  | { type: 'level'; level: number }
  | { type: 'finish'; reason: EndReason; x: number; y: number };

export interface LogEvent { t: number; type: string; [k: string]: unknown }
export interface Sample {
  t: number;
  player: [number, number] | null;
  pointer: [number, number] | null;
  proj: [number, number, number][];
}

interface Resolved { x: number; y: number; flipped: boolean; flightMs: number; distPx: number; safe: boolean }
interface Pending extends SpawnEvent {
  idx: number;
  resolved?: Resolved;
  telegraphId?: number;
  committed?: boolean;  // telegraph shown: origin and the shot itself are now fixed
  cancelled?: boolean;  // decided at plan time; never fires
  placed?: boolean;     // lines: origins computed around the player (once per row, at plan time)
  aimAt?: Vec;          // bursts: the aim point fixed when the burst was planned (later darts aim here, not at the live player)
}

/** One 20 ms frame of the replay trace kept for the last few seconds of a round. */
export interface TraceEntry {
  t: number;
  player: [number, number];
  input: [number, number] | null;   // A: held direction; B: pointer target; C: null
  proj: [number, number, number][]; // [id, x, y] — velocities are constant and live in the spawn event
}
export const TRACE_EVERY_MS = 20;
export const TRACE_KEEP_MS = 3000;

export type RunValidity = 'valid' | 'suspect';

const LEFT = ['KeyA', 'ArrowLeft'], RIGHT = ['KeyD', 'ArrowRight'], UP = ['KeyW', 'ArrowUp'], DOWN = ['KeyS', 'ArrowDown'];
const held = (keys: ReadonlySet<string>, codes: string[]) => codes.some((c) => keys.has(c));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** One round of one mode. Pure logic: no DOM, no timers, no rendering. */
export class Sim {
  phase: Phase = 'READY';
  /** Game time in ms. Frozen while PAUSED/FINISHED; never tied to wall-clock. */
  t = 0;
  countdownMs = COUNTDOWN_MS;
  private acc = 0;

  readonly scheduleKind: ScheduleKind;
  readonly legacy: boolean;
  readonly patterns: Patterns;
  readonly levels: Levels;
  readonly autopilot: boolean;
  private readonly scheduler: PatternScheduler | TimerScheduler | CoreScheduler | null;
  private readonly staticSchedule: SpawnEvent[];
  private readonly pending: Pending[] = [];
  private nextIdx = 0;
  private schedIdx = 0;
  private readonly maxTelegraphMs: number;
  private nextTelegraphId = 1;
  /** Flip decisions shared by all rays of a fan / all darts of a wall. */
  private readonly sharedFlips = new Map<string, { flipped: boolean; flightMs: number; distPx: number; safe: boolean }>();
  private committedFast = 0; // telegraphed fast shots that will fire (count toward the cap at plan time)
  /** Fast-shot warnings currently shown (marker at the edge until the shot fires). */
  readonly telegraphs: Telegraph[] = [];
  /** Legacy schedules end the round with CLEAR here; endless ones never do. */
  readonly capMs: number;

  readonly projectiles: Projectile[] = [];
  private nextId = 1;

  readonly player: { x: number; y: number; px: number; py: number };
  readonly core: Vec;
  /** Defend: hit points left. Legacy C keeps 1 (Gate 01 rules). */
  coreHp: number;
  readonly coreHpMax: number;
  private readonly coreCooldownMs: number;
  private lastCoreHitT = -Infinity;

  endReason: EndReason | null = null;
  survivalMs = 0;
  reachedLevel = 0;
  private lastLevel = 0;

  /** Events for the host (audio/VFX). The host drains it every frame. */
  readonly outbox: SimEvent[] = [];
  /** Development log (bounded). Never shown to the player. */
  readonly log: LogEvent[] = [];
  readonly samples: Sample[] = [];
  droppedLogs = 0;
  readonly counters = {
    spawned: 0, skippedSpawns: 0, fastSkips: 0, cancelled: 0, flips: 0, telegraphs: 0, maxActive: 0, minFlightMs: Infinity,
    nearMisses: 0, clicks: 0, hits: 0, misses: 0, coreHits: 0, coreAbsorbed: 0, moveDistance: 0, pauses: 0,
  };
  readonly frames = { count: 0, totalMs: 0, maxMs: 0, steps: 0 };
  /**
   * Time accounting (Gate 03 §7): simulation time is `t`; `wallMs` is real time spent PLAYING; `pausedMs` real time
   * PAUSED (includes hidden-tab time, since the host pauses on hide); `lostMs` is the part of slow frames the clamp
   * threw away (the world ran slower than the clock by this much).
   */
  readonly clock = { wallMs: 0, pausedMs: 0, lostMs: 0, maxFrameMs: 0, slowFrames: 0 };
  /** Ring buffer: the last TRACE_KEEP_MS of positions at TRACE_EVERY_MS, for replaying the moments before a death. */
  private readonly trace: TraceEntry[] = [];
  private lastInput: [number, number] | null = null;

  private lastPointer: Vec | null = null;

  constructor(readonly mode: Mode, readonly seed: number, readonly cfg: Config, opts: SimOptions = {}) {
    const { width, height } = cfg.world;
    this.patterns = opts.patterns ?? PATTERNS;
    this.levels = opts.levels ?? LEVELS;
    this.autopilot = !!opts.autopilot;
    this.scheduleKind = opts.schedule ?? DEFAULT_SCHEDULE[mode];
    this.legacy = LEGACY_KINDS.has(this.scheduleKind);
    this.capMs = this.legacy ? cfg.world.roundCapMs : Infinity;
    if (this.scheduleKind === 'g1') {
      this.scheduler = null;
      this.staticSchedule = buildSchedule(seed, cfg);
      this.maxTelegraphMs = 0;
      for (const e of this.staticSchedule) this.pending.push({ ...e, idx: this.nextIdx++ });
    } else if (this.scheduleKind === 'g2') {
      const phases = this.patterns.phases.map((p, i) => ({ ...p, level: i + 1 }));
      this.scheduler = new PatternScheduler(seed, cfg, this.patterns, phases, { startMs: phases[0].fromMs, endMs: cfg.world.roundCapMs });
      this.staticSchedule = [];
      this.maxTelegraphMs = this.scheduler.maxTelegraphMs;
    } else if (this.scheduleKind === 'g3') {
      const d = this.levels.dodge;
      this.scheduler = d.timers
        ? new TimerScheduler(seed, cfg, this.patterns, d.timers, d.firstSpawnAtMs)
        : new PatternScheduler(seed, cfg, this.patterns, d.levels, { startMs: d.firstSpawnAtMs, endMs: null });
      this.staticSchedule = [];
      this.maxTelegraphMs = this.scheduler.maxTelegraphMs;
    } else {
      this.scheduler = new CoreScheduler(seed, cfg, this.levels.defend);
      this.staticSchedule = [];
      this.maxTelegraphMs = 0;
    }
    this.player = { x: width / 2, y: height / 2, px: width / 2, py: height / 2 };
    this.core = { x: width / 2, y: height / 2 };
    this.coreHpMax = this.scheduleKind === 'c3' ? this.levels.defend.coreHitPoints : 1;
    this.coreHp = this.coreHpMax;
    this.coreCooldownMs = this.scheduleKind === 'c3' ? this.levels.defend.coreDamageCooldownMs : 0;
    this.pull(); // make the first spawns visible to tests/inspection before the round starts
  }

  /** Everything scheduled so far (streamed kinds grow as the round goes on). */
  get schedule(): SpawnEvent[] { return this.scheduler ? this.scheduler.events : this.staticSchedule; }

  get difficultyVersion(): string {
    return this.scheduleKind === 'g3' ? this.levels.difficultyVersion.dodge
      : this.scheduleKind === 'c3' ? this.levels.difficultyVersion.defend
      : `${this.scheduleKind}.legacy`;
  }

  /** Current difficulty level (1–10). Legacy schedules report their phase number. */
  get level(): number {
    if (this.scheduler) return this.scheduler.levelAt(this.t)?.level ?? this.lastLevel;
    const i = this.cfg.spawnPhases.findIndex((p) => this.t >= p.fromMs && this.t < p.untilMs);
    return i < 0 ? this.lastLevel : i + 1;
  }

  begin() {
    if (this.phase !== 'READY') return;
    this.phase = 'COUNTDOWN';
    this.countdownMs = COUNTDOWN_MS;
  }

  pause() {
    if (this.phase !== 'PLAYING') return;
    this.phase = 'PAUSED';
    this.counters.pauses++;
    this.record('pause');
  }

  resume() {
    if (this.phase !== 'PAUSED') return;
    this.phase = 'PLAYING';
    this.record('resume');
  }

  /** Leaving the round early (mode switch). Not a result; never recorded as a best. */
  abandon() {
    if (this.phase === 'FINISHED') return;
    this.phase = 'FINISHED';
    this.endReason = 'abandoned';
    this.survivalMs = this.t;
    this.reachedLevel = this.level;
    this.record('game_over', { reason: 'abandoned', survivalMs: this.t, level: this.reachedLevel });
  }

  /** Advance by one rendered frame of wall time. */
  frame(dtMs: number, input: Input) {
    const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
    if (this.phase === 'COUNTDOWN') {
      this.countdownMs -= dt;
      if (this.countdownMs > 1e-6) return; // float residue from summed frame times must not cost a frame
      this.countdownMs = 0;
      this.phase = 'PLAYING';
      this.acc = 0;
      this.record('start');
      return;
    }
    if (this.phase === 'PAUSED') { this.clock.pausedMs += dtMs; return; }
    if (this.phase !== 'PLAYING') return;

    this.frames.count++;
    this.frames.totalMs += dtMs;
    if (dtMs > this.frames.maxMs) this.frames.maxMs = dtMs;
    this.clock.wallMs += dtMs;
    if (dtMs > MAX_FRAME_MS) { this.clock.lostMs += dtMs - MAX_FRAME_MS; this.clock.slowFrames++; }
    if (dtMs > this.clock.maxFrameMs) this.clock.maxFrameMs = dtMs;

    if (input.pointer) this.lastPointer = input.pointer;
    // Clicks are instant judgements against what the player saw (the state rendered last frame).
    if (this.mode === 'C' || this.mode === 'D') for (const c of input.clicks) this.judgeClick(c);

    this.acc += dt;
    while (this.acc >= STEP_MS && this.phase === 'PLAYING') {
      this.step(input);
      this.acc -= STEP_MS;
    }
  }

  /** Is this run comparable as a record? Bots, legacy rules and runs the clock could not keep up with are not. */
  validity(): { status: RunValidity; reasons: string[] } {
    const v = this.levels.validity;
    const reasons: string[] = [];
    if (this.autopilot) reasons.push('autopilot');
    if (this.legacy) reasons.push('legacy_rules');
    const { wallMs, lostMs, maxFrameMs } = this.clock;
    if (wallMs > 0 && lostMs / wallMs > v.maxLostFraction) reasons.push('slow_frames');
    if (wallMs > 1000 && (this.frames.count / (wallMs / 1000)) < v.minAvgFps) reasons.push('low_fps');
    if (maxFrameMs > v.maxSingleFrameMs) reasons.push('long_stall');
    return { status: reasons.length ? 'suspect' : 'valid', reasons };
  }

  /** Scheduled vs. fired, per group, level, tier and pattern type, for the part of the schedule this round reached. */
  accounting() {
    const tally = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
    const planned: Record<string, number> = {}, plannedPhase: Record<string, number> = {}, plannedTier: Record<string, number> = {};
    for (const e of this.schedule) {
      if (e.tMs > this.t) break;
      tally(planned, e.group); tally(plannedPhase, `LV${e.level ?? 0}`); tally(plannedTier, e.tier);
    }
    const spawned: Record<string, number> = {}, spawnedPhase: Record<string, number> = {}, spawnedTier: Record<string, number> = {};
    const spawnedPattern: Record<string, number> = {};
    const notFired: Record<string, number> = {}, notFiredTier: Record<string, number> = {};
    for (const e of this.log) {
      if (e.type === 'spawn') { tally(spawned, e.group as string); tally(spawnedPhase, `LV${e.level ?? 0}`); tally(spawnedTier, e.tier as string); tally(spawnedPattern, e.pattern as string); }
      else if (e.type === 'spawn_skipped' || e.type === 'spawn_cancelled') { tally(notFired, `${e.type}:${e.reason}`); tally(notFiredTier, `${e.tier}:${e.reason}`); }
    }
    const groupStarts: Record<string, number> = {};
    const seen = new Set<number>();
    for (const e of this.schedule) { if (e.tMs > this.t) break; if (!seen.has(e.groupId)) { seen.add(e.groupId); tally(groupStarts, e.group); } }
    return { planned, plannedPhase, plannedTier, spawned, spawnedPhase, spawnedTier, spawnedPattern, groupStarts, notFired, notFiredTier };
  }

  /** Playtest summary: what ended the round and where origins fell back. */
  summary() {
    const col = this.log.find((e) => e.type === 'collision' || e.type === 'core_breach');
    const sp = col ? this.log.find((e) => e.type === 'spawn' && e.id === col.id) : undefined;
    const lastHit = col && sp ? {
      t: col.t, id: sp.id, kind: sp.kind, tier: sp.tier, speed: sp.speed, pattern: sp.pattern, group: sp.group,
      spawnT: sp.t, flipped: sp.flipped, telegraphed: sp.telegraphed,
      visibleForMs: col.t - (sp.t - (sp.telegraphed ? this.patterns.fairness.fastTelegraphMs : 0)),
    } : null;
    return { lastHit, reachedLevel: this.reachedLevel, flips: this.log.filter((e) => e.type === 'flip') };
  }

  toLog() {
    const { count, totalMs, maxMs, steps } = this.frames;
    return {
      mode: this.mode,
      seed: this.seed,
      schedule: this.scheduleKind,
      gameVersion: this.levels.gameVersion,
      difficultyVersion: this.difficultyVersion,
      inputKind: this.mode === 'A' ? 'keyboard' : this.mode === 'D' ? 'keyboard+mouse' : 'mouse',
      endReason: this.endReason,
      survivalMs: this.survivalMs,
      reachedLevel: this.reachedLevel,
      tGameMs: this.t,
      clock: { simMs: this.t, ...this.clock, lostMs: Math.round(this.clock.lostMs), wallMs: Math.round(this.clock.wallMs), pausedMs: Math.round(this.clock.pausedMs) },
      validity: this.validity(),
      coreHp: this.mode === 'C' ? { left: this.coreHp, max: this.coreHpMax } : null,
      counters: { ...this.counters, moveDistance: Math.round(this.counters.moveDistance), minFlightMs: Math.round(this.counters.minFlightMs) },
      summary: this.summary(),
      accounting: this.accounting(),
      lastSeconds: this.trace.slice(),
      frames: { count, steps, avgFps: totalMs > 0 ? +(count / (totalMs / 1000)).toFixed(1) : 0, maxFrameMs: +maxMs.toFixed(1) },
      droppedLogs: this.droppedLogs,
      events: this.log,
      samples: this.samples,
    };
  }

  // ---- internals ---------------------------------------------------------

  private step(input: Input) {
    const dt = STEP_MS / 1000;
    this.t += STEP_MS;
    this.frames.steps++;
    this.spawnDue();
    this.movePlayer(input, dt);
    for (const p of this.projectiles) {
      p.px = p.x; p.py = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    if (this.t % TRACE_EVERY_MS === 0) this.pushTrace();
    if (this.mode === 'C') this.checkCore(); else this.checkPlayer();
    if (this.phase !== 'PLAYING') return;
    this.cull();
    if (this.projectiles.length > this.counters.maxActive) this.counters.maxActive = this.projectiles.length;
    if (this.t % SAMPLE_EVERY_MS === 0) this.sample();
    const lv = this.level;
    if (lv !== this.lastLevel) { this.lastLevel = lv; this.record('level', { level: lv }); this.outbox.push({ type: 'level', level: lv }); }
    if (this.t >= this.capMs) this.finish('clear', this.mode === 'C' ? this.core : this.player);
  }

  private target(): Vec { return this.mode === 'C' ? this.core : this.player; }

  /** Streamed schedules: generate ahead of game time and keep `pending` sorted and trimmed. */
  private pull() {
    if (!this.scheduler) return;
    const added = this.scheduler.emitUntil(this.t + LOOKAHEAD_MS);
    if (!added.length) return;
    for (const e of added) this.pending.push({ ...e, idx: this.nextIdx++ });
    // new events may interleave with unfired ones already queued: sort the unfired tail only
    const tail = this.pending.splice(this.schedIdx).sort((a, b) => a.tMs - b.tMs || a.idx - b.idx);
    this.pending.push(...tail);
    if (this.schedIdx > PENDING_TRIM) { this.pending.splice(0, this.schedIdx); this.schedIdx = 0; }
  }

  /** Distance from an origin to the target: straight-line for aimed/fan, perpendicular distance from the side for walls, precomputed for lines. */
  private distFrom(e: Pending, p: EdgePoint & { distPx?: number }): number {
    if (p.distPx !== undefined) return p.distPx;
    const tg = this.target();
    const dist = e.pattern !== 'volley'
      ? Math.hypot(tg.x - p.x, tg.y - p.y)
      : p.side === 0 ? tg.y - p.y : p.side === 2 ? p.y - tg.y : p.side === 3 ? tg.x - p.x : p.x - tg.x;
    return Math.max(0, dist);
  }

  /**
   * g3.2 line: the row is centred on the player's position now (plan time), one straight front outside the field,
   * every dart on its own track parallel to the travel direction. The primary origin is the near end of each track,
   * `alt` the far end (the whole row flips together, like a wall). A track that misses the field entirely is dropped.
   * The fairness distance is what the centre track's dart has to cover from the field edge to the player.
   */
  private placeLine(first: Pending) {
    const { width: W, height: H } = this.cfg.world, O = SPAWN_OUTSET_PX;
    const P = this.target();
    const d = LINE_DIRS[first.dir!];
    const inField = (x: number, y: number) => x >= -O && x <= W + O && y >= -O && y <= H + O;
    /** Distance from (x, y) along (ux, uy) to the field boundary (+outset). */
    const exit = (x: number, y: number, ux: number, uy: number) => Math.min(
      ux > 0 ? (W + O - x) / ux : ux < 0 ? (-O - x) / ux : Infinity,
      uy > 0 ? (H + O - y) / uy : uy < 0 ? (-O - y) / uy : Infinity);
    const row = this.pending.filter((p) => p.wallId === first.wallId);
    const tracks = row.map((p) => ({ p, x: P.x - d.dy * p.lineOffsetPx!, y: P.y + d.dx * p.lineOffsetPx! }));
    const kept = tracks.filter((t) => inField(t.x, t.y));
    const back = Math.max(0, ...kept.map((t) => exit(t.x, t.y, -d.dx, -d.dy)));
    const fwd = Math.max(0, ...kept.map((t) => exit(t.x, t.y, d.dx, d.dy)));
    const near = Math.max(0, exit(P.x, P.y, -d.dx, -d.dy)), far = Math.max(0, exit(P.x, P.y, d.dx, d.dy));
    const alt = ((first.side + 2) % 4) as EdgePoint['side'];
    for (const t of tracks) {
      // every dart gets its geometry (the row's shared flip decision may be computed from any of them); off-field ones never fire
      t.p.placed = true;
      t.p.x = +(t.x - d.dx * back).toFixed(2); t.p.y = +(t.y - d.dy * back).toFixed(2); t.p.distPx = near;
      t.p.alt = { x: +(t.x + d.dx * fwd).toFixed(2), y: +(t.y + d.dy * fwd).toFixed(2), side: alt, distPx: far };
      if (!inField(t.x, t.y)) this.cancel(t.p, 'offfield');
    }
  }

  private resolveOrigin(e: Pending): Resolved {
    if (e.resolved) return e.resolved;
    if (e.dir !== undefined && !e.placed) this.placeLine(e);
    const key = e.fanId !== undefined ? `f${e.fanId}` : e.wallId !== undefined ? `w${e.wallId}` : null;
    let decision = key ? this.sharedFlips.get(key) : undefined;
    if (!decision) {
      const { minFlightMs, minSpawnDistancePx } = this.patterns.fairness;
      const unsafe = (flightMs: number, distPx: number) => flightMs < minFlightMs || distPx < minSpawnDistancePx;
      let flipped = false;
      let distPx = this.distFrom(e, e);
      let flightMs = (distPx / e.speed) * 1000;
      if (e.alt && unsafe(flightMs, distPx)) {
        // too close (pops in next to the player) or too quick (no time to react) → opposite side
        flipped = true;
        this.counters.flips++;
        const before = { flightMs: Math.round(flightMs), distPx: Math.round(distPx) };
        distPx = this.distFrom(e, e.alt);
        flightMs = (distPx / e.speed) * 1000;
        // one entry per decision (a whole wall or fan flips together)
        this.record('flip', {
          idx: e.idx, fireAt: e.tMs, group: e.group, pattern: e.pattern, tier: e.tier,
          fromSide: e.side, toSide: e.alt.side, x: e.alt.x, y: e.alt.y, before,
          after: { flightMs: Math.round(flightMs), distPx: Math.round(distPx) },
        });
      }
      decision = { flipped, flightMs, distPx, safe: !unsafe(flightMs, distPx) || this.scheduleKind === 'g1' || this.scheduleKind === 'c3' };
      if (key) { this.sharedFlips.set(key, decision); if (this.sharedFlips.size > 256) this.sharedFlips.delete(this.sharedFlips.keys().next().value!); }
    }
    const o = decision.flipped && e.alt ? e.alt : e;
    e.resolved = { x: o.x, y: o.y, flipped: decision.flipped, flightMs: decision.flightMs, distPx: decision.distPx, safe: decision.safe };
    return e.resolved;
  }

  /** Plan-time decision: the shot never happens. Nothing has been shown to the player yet. */
  private cancel(e: Pending, reason: string) {
    e.cancelled = true;
    this.counters.cancelled++;
    this.record('spawn_cancelled', { idx: e.idx, tMs: e.tMs, reason, group: e.group, tier: e.tier, telegraphed: !!e.telegraphMs });
  }

  /** Fast darts still heading toward the player; one that has passed is no longer a threat for the cap. */
  private activeFast() {
    const tg = this.target();
    let n = 0;
    for (const p of this.projectiles) if (p.tier === 'fast' && p.vx * (tg.x - p.x) + p.vy * (tg.y - p.y) > 0) n++;
    return n;
  }

  private spawnDue() {
    this.pull();
    const { maxProjectiles } = this.cfg.world;
    // 1) plan telegraphed shots: decide origin and whether the shot happens, then show the marker.
    //    From here on nothing about the shot changes (origin, timing); the marker is a promise.
    for (let i = this.schedIdx; i < this.pending.length; i++) {
      const e = this.pending[i];
      if (e.tMs - this.maxTelegraphMs > this.t) break;
      if (!e.telegraphMs || e.telegraphId !== undefined || e.cancelled || e.tMs - e.telegraphMs > this.t) continue;
      const o = this.resolveOrigin(e);
      if (e.cancelled) continue; // a line dart whose track misses the field
      if (!o.safe) { this.cancel(e, 'unsafe'); continue; }
      if (this.projectiles.length >= maxProjectiles) { this.cancel(e, 'max'); continue; }
      if (e.tier === 'fast' && this.activeFast() + this.committedFast >= e.maxActiveFast) { this.cancel(e, 'fastcap'); continue; }
      e.committed = true;
      if (e.tier === 'fast') this.committedFast++;
      e.telegraphId = this.nextTelegraphId++;
      this.counters.telegraphs++;
      this.telegraphs.push({ id: e.telegraphId, x: o.x, y: o.y, startT: this.t, fireAt: e.tMs, tier: e.tier });
      this.record('telegraph', { id: e.telegraphId, idx: e.idx, x: o.x, y: o.y, fireAt: e.tMs, flipped: o.flipped, group: e.group });
      this.outbox.push({ type: 'telegraph', x: o.x, y: o.y });
    }
    // 1b) g3.2 bursts: when a burst is due, fix its aim point (the player now) and stagger the fire times so every
    //     dart reaches that point at the same instant — the farthest dart leaves now, the nearest last. Origins and
    //     the fairness decision are settled here; nothing about the burst changes afterwards.
    let resort = false;
    for (let i = this.schedIdx; i < this.pending.length; i++) {
      const e = this.pending[i];
      if (e.tMs > this.t) break;
      if (e.burstId === undefined || e.aimAt !== undefined || e.cancelled) continue;
      const P = { ...this.target() };
      const darts = this.pending.filter((p) => p.burstId === e.burstId && !p.cancelled);
      let dMax = 0;
      for (const p of darts) { const o = this.resolveOrigin(p); if (!o.safe) this.cancel(p, 'unsafe'); else dMax = Math.max(dMax, o.distPx); }
      for (const p of darts) if (!p.cancelled) { p.aimAt = P; p.tMs = this.t + Math.round(((dMax - p.resolved!.distPx) / p.speed) * 1000); }
      resort = true;
    }
    if (resort) { const tail = this.pending.splice(this.schedIdx).sort((a, b) => a.tMs - b.tMs || a.idx - b.idx); this.pending.push(...tail); }
    // 2) fire
    while (this.schedIdx < this.pending.length && this.pending[this.schedIdx].tMs <= this.t) {
      const e = this.pending[this.schedIdx++];
      const idx = e.idx;
      if (e.cancelled) continue;
      if (e.telegraphId !== undefined) {
        const k = this.telegraphs.findIndex((tg) => tg.id === e.telegraphId);
        if (k >= 0) this.telegraphs.splice(k, 1);
      }
      if (e.committed) {
        if (e.tier === 'fast') this.committedFast--;
      } else {
        // not telegraphed: plan and fire in the same instant
        const o = this.resolveOrigin(e);
        if (e.cancelled) continue;
        if (!o.safe) { this.cancel(e, 'unsafe'); continue; }
        const ceiling = e.maxActive !== undefined ? Math.min(maxProjectiles, e.maxActive) : maxProjectiles;
        if (this.projectiles.length >= ceiling) {
          this.counters.skippedSpawns++;
          this.record('spawn_skipped', { idx, tMs: e.tMs, reason: e.maxActive !== undefined && this.projectiles.length < maxProjectiles ? 'levelcap' : 'max', group: e.group, tier: e.tier });
          continue;
        }
        if (e.tier === 'fast' && this.activeFast() + this.committedFast >= e.maxActiveFast) {
          this.counters.fastSkips++;
          this.record('spawn_skipped', { idx, tMs: e.tMs, reason: 'fastcap', group: e.group, tier: e.tier });
          continue;
        }
      }
      const o = e.resolved!;
      let dx: number, dy: number, flightMs: number | null = null;
      if (e.aim === 'player') {
        // Aim once at fire time (player for A/B, core for C; a burst's fixed point); straight line afterwards, no homing, no lead.
        const tg = e.aimAt ?? this.target();
        const ang = Math.atan2(tg.y - o.y, tg.x - o.x) + (e.angleOffsetRad ?? 0);
        dx = Math.cos(ang); dy = Math.sin(ang);
        flightMs = (Math.hypot(tg.x - o.x, tg.y - o.y) / e.speed) * 1000;
        if (flightMs < this.counters.minFlightMs) this.counters.minFlightMs = flightMs;
      } else {
        const sgn = o.flipped ? -1 : 1; // a flipped wall comes from the opposite side, so it travels the other way
        dx = e.aim.dx * sgn; dy = e.aim.dy * sgn;
      }
      const r = e.kind === 'normal' ? this.cfg.dodge.projectileHitRadiusPx : this.patterns.projectileKinds[e.kind].hitRadiusPx;
      const id = this.nextId++;
      const telegraphed = e.telegraphId !== undefined;
      const fastActive = e.tier === 'fast' ? this.activeFast() + 1 : undefined; // approaching fast darts incl. this one
      const armored = e.armored ?? e.kind === 'large';
      this.projectiles.push({
        id, x: o.x, y: o.y, px: o.x, py: o.y,
        vx: dx * e.speed, vy: dy * e.speed, speed: e.speed,
        kind: e.kind, tier: e.tier, r, group: e.group, armored,
        spawnT: this.t, visibleFromT: telegraphed ? this.t - (e.telegraphMs ?? 0) : this.t,
        minDist: Infinity, nearMissDone: false,
      });
      this.counters.spawned++;
      const angle = Math.atan2(dy, dx);
      this.record('spawn', {
        id, idx, x: o.x, y: o.y, side: o.flipped && e.alt ? e.alt.side : e.side, fromSide: o.flipped ? e.side : undefined,
        speed: e.speed, kind: e.kind, tier: e.tier, group: e.group, pattern: e.pattern, level: e.level, burstId: e.burstId, armored,
        angle: +angle.toFixed(4), flightMs: flightMs === null ? null : Math.round(flightMs),
        flightAtResolveMs: Math.round(o.flightMs), distAtResolvePx: Math.round(o.distPx), flipped: o.flipped, telegraphed, telegraphId: e.telegraphId, fastActive,
      });
      this.outbox.push({ type: 'spawn', x: o.x, y: o.y, angle, kind: e.kind, tier: e.tier, group: e.group, groupId: e.groupId });
    }
  }

  private movePlayer(input: Input, dt: number) {
    const p = this.player;
    p.px = p.x; p.py = p.y;
    if (this.mode === 'C') return;
    const { width, height } = this.cfg.world;
    const r = this.cfg.dodge.playerVisualRadiusPx;
    if (this.mode === 'A' || this.mode === 'D') {
      const dx = (held(input.keys, RIGHT) ? 1 : 0) - (held(input.keys, LEFT) ? 1 : 0);
      const dy = (held(input.keys, DOWN) ? 1 : 0) - (held(input.keys, UP) ? 1 : 0);
      this.lastInput = [dx, dy];
      if (!dx && !dy) return;
      const l = Math.hypot(dx, dy); // diagonal normalised
      const m = this.cfg.dodge.playerMoveSpeedPxPerSec * dt;
      p.x = clamp(p.x + (dx / l) * m, r, width - r);
      p.y = clamp(p.y + (dy / l) * m, r, height - r);
    } else {
      const target = this.lastPointer;
      if (!target) return;
      const tx = clamp(target.x, r, width - r), ty = clamp(target.y, r, height - r);
      this.lastInput = [r1(tx), r1(ty)];
      const d = Math.hypot(tx - p.x, ty - p.y);
      if (d < this.cfg.dodge.mouseArrivalTolerancePx) return;
      const m = Math.min(d, this.cfg.dodge.mouseFollowMaxSpeedPxPerSec * dt); // never teleports
      p.x += ((tx - p.x) / d) * m;
      p.y += ((ty - p.y) / d) * m;
    }
    this.counters.moveDistance += Math.hypot(p.x - p.px, p.y - p.py);
  }

  private checkPlayer() {
    const d0 = this.cfg.dodge;
    const nearMax = d0.nearMissCenterDistanceMaxPx;
    const pl = this.player;
    for (const p of this.projectiles) {
      const R = d0.playerHitRadiusPx + p.r;
      // Relative sweep: both bodies move linearly within a step, so test the relative segment against the origin.
      const ax = p.px - pl.px, ay = p.py - pl.py, bx = p.x - pl.x, by = p.y - pl.y;
      const d = segPointDist(0, 0, ax, ay, bx, by);
      if (d <= R) {
        this.record('collision', { id: p.id, dist: +d.toFixed(2), group: p.group, tier: p.tier, kind: p.kind });
        this.finish('hit', { x: pl.x, y: pl.y });
        return;
      }
      if (p.nearMissDone) continue;
      if (d < p.minDist) p.minDist = d;
      const endD = Math.hypot(bx, by);
      if (p.minDist <= nearMax && endD > p.minDist + 0.25) { // closest point is behind us: it passed
        p.nearMissDone = true;
        this.counters.nearMisses++;
        this.record('near_miss', { id: p.id, dist: +p.minDist.toFixed(2) });
        this.outbox.push({ type: 'near_miss', x: pl.x, y: pl.y });
      }
    }
  }

  /**
   * Defend damage rule (Gate 03 §1): darts that reach the core this step are handled deepest-first; the first one
   * costs one hit point and starts a cooldown of coreDamageCooldownMs; any dart reaching the core during the cooldown
   * (including the same step) is destroyed without damage. The round ends when hit points reach zero.
   */
  private checkCore() {
    const c = this.core;
    const arrived: { p: Projectile; depth: number }[] = [];
    for (const p of this.projectiles) {
      const R = this.cfg.defend.coreHitRadiusPx + p.r;
      const d = segPointDist(c.x, c.y, p.px, p.py, p.x, p.y);
      if (d <= R) arrived.push({ p, depth: R - d });
    }
    if (!arrived.length) return;
    arrived.sort((a, b) => b.depth - a.depth);
    for (const { p } of arrived) {
      this.projectiles.splice(this.projectiles.indexOf(p), 1);
      if (this.t - this.lastCoreHitT < this.coreCooldownMs) {
        this.counters.coreAbsorbed++;
        this.record('core_absorbed', { id: p.id, group: p.group, tier: p.tier, hp: this.coreHp });
        continue;
      }
      this.lastCoreHitT = this.t;
      this.coreHp--;
      this.counters.coreHits++;
      this.record(this.coreHp <= 0 ? 'core_breach' : 'core_hit', { id: p.id, group: p.group, tier: p.tier, speed: p.speed, hp: this.coreHp });
      this.outbox.push({ type: 'core_hit', x: c.x, y: c.y, hp: this.coreHp });
      if (this.coreHp <= 0) { this.finish('core_breach', c); return; }
    }
  }

  private judgeClick(c: Vec) {
    const R = this.cfg.defend.clickTargetHitRadiusPx;
    this.counters.clicks++;
    this.record('click', { x: r1(c.x), y: r1(c.y) });
    let best: Projectile | null = null, bestD = Infinity, nearest: Projectile | null = null, nearestD = Infinity;
    for (const p of this.projectiles) {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < nearestD) { nearest = p; nearestD = d; }
      if (p.armored) continue; // D: armoured darts are not targets, however close the click
      if (d <= R && d < bestD) { best = p; bestD = d; }
    }
    if (!best) {
      this.counters.misses++;
      // how far the empty click was from the closest target centre: "felt like a hit" complaints can be checked against this
      this.record('miss', { x: r1(c.x), y: r1(c.y), nearestId: nearest?.id ?? null, nearestDist: nearest ? +nearestD.toFixed(2) : null, nearestArmored: nearest?.armored ?? false });
      this.outbox.push({ type: 'miss', x: c.x, y: c.y });
      return;
    }
    this.projectiles.splice(this.projectiles.indexOf(best), 1);
    // time the dart had left before touching what it threatens: the core (C) or the player (D)
    const tg = this.target();
    const reach = (this.mode === 'C' ? this.cfg.defend.coreHitRadiusPx : this.cfg.dodge.playerHitRadiusPx) + best.r;
    const remainMs = Math.max(0, ((Math.hypot(best.x - tg.x, best.y - tg.y) - reach) / best.speed) * 1000);
    const closeSave = remainMs < this.cfg.defend.closeSaveThresholdMs;
    this.counters.hits++;
    this.record('hit', { id: best.id, dist: +bestD.toFixed(2), threatTimeToCoreMs: Math.round(remainMs), closeSave });
    this.outbox.push({ type: 'hit', x: best.x, y: best.y, angle: Math.atan2(best.vy, best.vx), closeSave });
  }

  private cull() {
    const { width, height } = this.cfg.world;
    const M = CULL_MARGIN_PX;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // outside the margin and no longer heading toward the field (a g3.2 diagonal row starts well outside and flies in)
      if ((p.x < -M || p.x > width + M || p.y < -M || p.y > height + M) && p.vx * (width / 2 - p.x) + p.vy * (height / 2 - p.y) <= 0) {
        this.projectiles.splice(i, 1);
        this.record('despawn', { id: p.id });
      }
    }
  }

  private sample() {
    if (this.samples.length >= SAMPLES_KEEP) this.samples.shift();
    const ptr = this.lastPointer;
    this.samples.push({
      t: this.t,
      player: this.mode === 'C' ? null : [r1(this.player.x), r1(this.player.y)],
      pointer: this.mode === 'A' || !ptr ? null : [r1(ptr.x), r1(ptr.y)],
      proj: this.projectiles.map((p) => [p.id, r1(p.x), r1(p.y)]),
    });
  }

  private record(type: string, data?: Record<string, unknown>) {
    if (this.log.length >= MAX_LOG_EVENTS) { this.droppedLogs++; return; }
    this.log.push({ t: this.t, type, ...data });
  }

  private pushTrace() {
    if (this.trace.length && this.trace[this.trace.length - 1].t === this.t) return;
    this.trace.push({
      t: this.t,
      player: [r1(this.player.x), r1(this.player.y)],
      input: this.mode === 'C' ? null : this.lastInput,
      proj: this.projectiles.map((p) => [p.id, r1(p.x), r1(p.y)]),
    });
    while (this.trace.length > TRACE_KEEP_MS / TRACE_EVERY_MS + 1) this.trace.shift();
  }

  private finish(reason: EndReason, at: Vec) {
    if (this.phase !== 'PLAYING') return; // one round ends exactly once
    this.pushTrace(); // the final frame, whatever the step grid
    this.phase = 'FINISHED';
    this.endReason = reason;
    this.survivalMs = reason === 'clear' ? this.capMs : this.t;
    this.reachedLevel = this.level;
    this.record('game_over', { reason, survivalMs: this.survivalMs, level: this.reachedLevel, validity: this.validity() });
    this.outbox.push({ type: 'finish', reason, x: at.x, y: at.y });
  }
}
