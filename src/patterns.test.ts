import { describe, expect, it } from 'vitest';
import { CONFIG, PATTERNS, type Config } from './config';
import { buildPatternSchedule, type SpawnEvent } from './schedule';
import { Sim, STEP_MS, type Input, type LogEvent } from './sim';

const idle: Input = { keys: new Set(), pointer: null, clicks: [] };
const keysOf = (...codes: string[]): Input => ({ keys: new Set(codes), pointer: null, clicks: [] });
function run(s: Sim, ms: number, input: Input, dt = 1000 / 60) {
  const n = Math.round(ms / dt);
  for (let i = 0; i < n; i++) s.frame(dt, input);
}
function playing(seed: number, cfg: Config = CONFIG) {
  const s = new Sim('A', seed, cfg, { schedule: 'g2' }); // Gate 02 rules under test here
  s.begin();
  run(s, 1000, idle);
  expect(s.phase).toBe('PLAYING');
  return s;
}
/** A player that cannot be hit: lets a full 40 s of spawns be observed from any parked position. */
const immortal: Config = { ...CONFIG, dodge: { ...CONFIG.dodge, playerHitRadiusPx: -10000 } };
const noSpawns: Config = { ...CONFIG, world: { ...CONFIG.world, maxProjectiles: 0 } };
const spawnsOf = (s: Sim) => s.log.filter((e) => e.type === 'spawn');
const F = PATTERNS.fairness;

describe('pattern table (config/gate02.patterns.json)', () => {
  it('speed tiers bracket the 260 px/s player: slow < player < fast', () => {
    expect(PATTERNS.speedTiers.slow[1]).toBeLessThan(CONFIG.dodge.playerMoveSpeedPxPerSec);
    expect(PATTERNS.speedTiers.normal[1]).toBeLessThan(CONFIG.dodge.playerMoveSpeedPxPerSec);
    expect(PATTERNS.speedTiers.fast[0]).toBeGreaterThan(CONFIG.dodge.playerMoveSpeedPxPerSec);
  });

  it('every step speed lies inside its tier; large darts and walls/fans are never fast; fast shots are telegraphed', () => {
    for (const [name, g] of Object.entries(PATTERNS.patterns)) {
      for (const st of g.steps) {
        const [lo, hi] = PATTERNS.speedTiers[st.tier];
        expect(st.speed, name).toBeGreaterThanOrEqual(lo);
        expect(st.speed, name).toBeLessThanOrEqual(hi);
        if (st.kind === 'large') expect(st.tier, name).not.toBe('fast');
        if (st.pattern !== 'aimed') expect(st.tier, name).not.toBe('fast');
        if (st.tier === 'fast') expect(st.telegraphMs ?? 0, name).toBeGreaterThanOrEqual(F.fastTelegraphMs);
      }
    }
  });

  it('phases are contiguous from the first spawn to the round cap and reference only defined groups', () => {
    const ph = PATTERNS.phases;
    expect(ph[0].fromMs).toBe(CONFIG.world.firstSpawnAtMs);
    expect(ph[ph.length - 1].untilMs).toBe(CONFIG.world.roundCapMs);
    for (let i = 1; i < ph.length; i++) expect(ph[i].fromMs).toBe(ph[i - 1].untilMs);
    for (const p of ph) for (const [name] of p.playlist) expect(PATTERNS.patterns[name], name).toBeDefined();
  });

  it('rhythm: no fast tier before 18 s, no overlap before 30 s, fast cap grows with the phase', () => {
    for (const p of PATTERNS.phases) {
      const hasFast = p.playlist.some(([name]) => PATTERNS.patterns[name].steps.some((s) => s.tier === 'fast'));
      if (p.fromMs < 18000) { expect(hasFast, p.name).toBe(false); expect(p.maxActiveFast).toBe(0); }
      if (p.fromMs < 30000) expect(p.overlap).toBe(1);
    }
  });
});

describe('pattern schedule', () => {
  it('is reproducible per seed (groups, origins, speeds) and differs between seeds', () => {
    expect(buildPatternSchedule(42, CONFIG, PATTERNS)).toEqual(buildPatternSchedule(42, CONFIG, PATTERNS));
    expect(buildPatternSchedule(42, CONFIG, PATTERNS)).not.toEqual(buildPatternSchedule(43, CONFIG, PATTERNS));
  });

  it('assigns speeds only from the pattern table, never per dart', () => {
    for (const e of buildPatternSchedule(7, CONFIG, PATTERNS)) {
      const steps = PATTERNS.patterns[e.group].steps;
      expect(steps.some((s) => s.speed === e.speed && s.kind === e.kind && s.tier === e.tier && s.pattern === e.pattern), e.group).toBe(true);
    }
  });

  it('every wall has exactly one gap, inside the allowed band, with a corridor ≥ minCorridorPx', () => {
    const { width: W, height: H } = CONFIG.world;
    for (const seed of [1, 2, 3, 4, 5]) {
      const walls = new Map<string, SpawnEvent[]>();
      for (const e of buildPatternSchedule(seed, CONFIG, PATTERNS)) {
        if (e.pattern !== 'volley') continue;
        const k = `${e.groupId}:${e.tMs}`;
        (walls.get(k) ?? walls.set(k, []).get(k)!).push(e);
      }
      expect(walls.size).toBeGreaterThan(0);
      for (const darts of walls.values()) {
        const horizontal = darts[0].side === 0 || darts[0].side === 2;
        const L = horizontal ? W : H;
        const band = horizontal ? F.wallGapBand.topBottom : F.wallGapBand.leftRight;
        const pos = darts.map((d) => (horizontal ? d.x : d.y)).sort((a, b) => a - b);
        const diffs = pos.slice(1).map((p, i) => +(p - pos[i]).toFixed(1));
        const spacing = Math.min(...diffs);
        const gaps = diffs.filter((d) => d > spacing + 0.5);
        expect(gaps.length, `seed ${seed}`).toBe(1);
        const gi = diffs.indexOf(gaps[0]);
        const gapCentre = (pos[gi] + pos[gi + 1]) / 2;
        expect(gapCentre / L).toBeGreaterThanOrEqual(band[0] - 0.05);
        expect(gapCentre / L).toBeLessThanOrEqual(band[1] + 0.05);
        expect(darts[0].corridorPx!).toBeGreaterThanOrEqual(F.minCorridorPx);
        expect(gaps[0] - 2 * PATTERNS.projectileKinds[darts[0].kind].hitRadiusPx).toBeCloseTo(darts[0].corridorPx!, 0);
        for (const d of darts) expect(d.aim).not.toBe('player'); // walls travel straight, never re-aim
      }
    }
  });

  it('fan rays share one origin and leave ≥ minFanGapPx between rays at 270 px', () => {
    const fans = new Map<number, SpawnEvent[]>();
    for (const e of buildPatternSchedule(9, CONFIG, PATTERNS)) if (e.fanId !== undefined) (fans.get(e.fanId) ?? fans.set(e.fanId, []).get(e.fanId)!).push(e);
    expect(fans.size).toBeGreaterThan(0);
    for (const rays of fans.values()) {
      expect(new Set(rays.map((r) => `${r.x},${r.y}`)).size).toBe(1);
      const offs = rays.map((r) => r.angleOffsetRad!).sort((a, b) => a - b);
      const step = Math.min(...offs.slice(1).map((o, i) => o - offs[i]));
      expect(270 * step - 2 * PATTERNS.projectileKinds[rays[0].kind].hitRadiusPx).toBeGreaterThanOrEqual(F.minFanGapPx);
    }
  });
});

describe('fairness rules in the simulation', () => {
  it('aimed/fan shots always leave ≥ minFlightMs of flight time, wherever the player is parked', () => {
    const parks = [keysOf('KeyA', 'KeyW'), keysOf('KeyD', 'KeyS'), keysOf('KeyA'), keysOf('ArrowUp'), idle];
    let flips = 0, aimed = 0;
    for (const [i, park] of parks.entries()) {
      const s = playing(100 + i, immortal);
      run(s, 40000, park);
      expect(s.endReason).toBe('clear');
      for (const e of spawnsOf(s)) {
        aimed++;
        expect(e.flightAtResolveMs as number, `seed ${100 + i} ${e.group}`).toBeGreaterThanOrEqual(F.minFlightMs);
        expect(e.distAtResolvePx as number, `seed ${100 + i} ${e.group}`).toBeGreaterThanOrEqual(F.minSpawnDistancePx);
        if (e.flightMs !== null) expect(e.flightMs as number, `parked player: fire-time flight ${e.group}`).toBeGreaterThanOrEqual(F.minFlightMs);
        if (e.flipped) flips++;
      }
    }
    expect(aimed).toBeGreaterThan(50);
    expect(flips).toBeGreaterThan(0); // corner parking must have exercised the opposite-side fallback
  });

  it('a fast shot shows its telegraph at the same origin exactly telegraphMs before firing', () => {
    const s = playing(5, immortal);
    run(s, 40000, idle);
    const fast = spawnsOf(s).filter((e) => e.tier === 'fast');
    expect(fast.length).toBeGreaterThan(0);
    for (const sp of fast) {
      expect(sp.telegraphed).toBe(true);
      const tg = s.log.find((e) => e.type === 'telegraph' && e.fireAt === sp.t && e.x === sp.x && e.y === sp.y);
      expect(tg, `fast shot at ${sp.t}`).toBeDefined();
      expect(sp.t - tg!.t).toBe(F.fastTelegraphMs);
    }
    expect(s.telegraphs.length).toBe(0); // all markers removed once fired
  });

  it('approaching fast darts never exceed the phase cap (the sim skips and logs the excess)', () => {
    for (const seed of [8, 9, 10]) {
      const s = playing(seed, immortal);
      run(s, 40000, idle);
      const fast = spawnsOf(s).filter((e: LogEvent) => e.tier === 'fast');
      expect(fast.length).toBeGreaterThan(0);
      for (const e of fast) {
        const cap = PATTERNS.phases.find((p) => e.t >= p.fromMs && e.t < p.untilMs)!.maxActiveFast;
        expect(e.fastActive as number, `seed ${seed} t=${e.t}`).toBeLessThanOrEqual(cap);
      }
      for (const e of s.log.filter((x) => x.type === 'spawn_skipped' && x.reason === 'fastcap')) expect(e.t).toBeGreaterThanOrEqual(18000);
    }
  });

  it('60 Hz and 144 Hz frames give identical spawn logs and positions on the pattern schedule', () => {
    const a = playing(21, immortal), b = playing(21, immortal);
    run(a, 40000, keysOf('KeyD'), 1000 / 60);
    run(b, 40000, keysOf('KeyD'), 1000 / 144);
    const pick = (s: Sim) => spawnsOf(s).map((e) => [e.t, e.x, e.y, e.speed, e.angle]);
    expect(pick(a)).toEqual(pick(b));
    expect(Math.abs(a.t - b.t)).toBeLessThanOrEqual(STEP_MS);
  });

  it('a dart covers exactly its configured speed per second (one tier each)', () => {
    for (const speed of [125, 210, 330]) {
      const s = playing(1, noSpawns);
      s.projectiles.push({ id: 1, x: 100, y: 500, px: 100, py: 500, vx: speed, vy: 0, speed, kind: 'normal', tier: 'slow', r: 7, group: 't', spawnT: 0, visibleFromT: 0, minDist: Infinity, nearMissDone: false });
      run(s, 1000, idle);
      expect(s.projectiles[0].x - 100).toBeCloseTo(speed, 0);
    }
  });

  it('A and B share the same schedule and the same spawn times; origins differ only where a flip happened', () => {
    const a = playing(99, immortal), b = new Sim('B', 99, immortal, { schedule: 'g2' });
    b.begin(); run(b, 1000, idle);
    expect(a.schedule).toEqual(b.schedule);
    run(a, 40000, keysOf('KeyD', 'KeyS'));
    run(b, 40000, { keys: new Set(), pointer: { x: 60, y: 60 }, clicks: [] });
    // scheduled fire times are shared; whether a shot fired, was skipped or was cancelled at plan time is input-dependent
    const times = (s: Sim) => s.log
      .filter((e) => e.type === 'spawn' || e.type === 'spawn_skipped' || e.type === 'spawn_cancelled')
      .map((e) => (e.type === 'spawn' ? e.t : (e.tMs as number)))
      .sort((x, y) => x - y);
    expect(times(a)).toEqual(times(b));
    const sa = spawnsOf(a), sb = spawnsOf(b);
    const byIdx = new Map(sb.map((e) => [e.idx, e]));
    let compared = 0;
    for (const e of sa) {
      const m = byIdx.get(e.idx);
      if (m && !e.flipped && !m.flipped) { compared++; expect(e.x).toBe(m.x); expect(e.y).toBe(m.y); }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe('telegraph promise (Gate 02.1 P0-1)', () => {
  it('every marker that reached its fire time produced exactly one shot at the marker origin and time; cancelled shots never showed a marker', () => {
    let checked = 0;
    for (const seed of [3, 4, 5, 6]) {
      for (const park of [idle, keysOf('KeyA', 'KeyW'), keysOf('KeyD')]) {
        const s = playing(seed, immortal);
        run(s, 40000, park);
        const byTele = new Map(spawnsOf(s).filter((e) => e.telegraphId !== undefined).map((e) => [e.telegraphId as number, e]));
        for (const tg of s.log.filter((e) => e.type === 'telegraph')) {
          if ((tg.fireAt as number) > s.t) continue;
          const sp = byTele.get(tg.id as number);
          expect(sp, `seed ${seed} telegraph ${tg.id}`).toBeDefined();
          expect(sp!.x).toBe(tg.x);
          expect(sp!.y).toBe(tg.y);
          expect(sp!.t).toBe(tg.fireAt);
          checked++;
        }
        for (const c of s.log.filter((e) => e.type === 'spawn_cancelled')) {
          expect(s.log.some((t) => t.type === 'telegraph' && t.idx === c.idx), `cancelled ${c.idx} must not have a marker`).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
