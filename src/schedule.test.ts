import { describe, expect, it } from 'vitest';
import { CONFIG } from './config';
import { buildSchedule, SPAWN_OUTSET_PX } from './schedule';
import { seedFromString } from './rng';

const { width: W, height: H, roundCapMs, firstSpawnAtMs } = CONFIG.world;

describe('buildSchedule', () => {
  it('is reproducible for the same seed and differs between seeds', () => {
    expect(buildSchedule(42, CONFIG)).toEqual(buildSchedule(42, CONFIG));
    expect(buildSchedule(42, CONFIG)).not.toEqual(buildSchedule(43, CONFIG));
  });

  it('spawns only inside the round, following each phase interval / speed / count', () => {
    const s = buildSchedule(7, CONFIG);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].tMs).toBe(firstSpawnAtMs);
    const byPattern = new Map<number, typeof s>();
    for (const e of s) {
      expect(e.tMs).toBeGreaterThanOrEqual(firstSpawnAtMs);
      expect(e.tMs).toBeLessThan(roundCapMs);
      const ph = CONFIG.spawnPhases.find((p) => e.tMs >= p.fromMs && e.tMs < p.untilMs)!;
      expect(e.speed).toBe(ph.projectileSpeedPxPerSec);
      (byPattern.get(e.groupId) ?? byPattern.set(e.groupId, []).get(e.groupId)!).push(e);
    }
    const patterns = [...byPattern.values()];
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      const ph = CONFIG.spawnPhases.find((x) => p[0].tMs >= x.fromMs && p[0].tMs < x.untilMs)!;
      expect(p.length).toBeGreaterThanOrEqual(ph.projectilesPerPattern[0]);
      expect(p.length).toBeLessThanOrEqual(ph.projectilesPerPattern[1]);
      expect(p.length).toBeLessThanOrEqual(3);
      expect(new Set(p.map((e) => e.side)).size).toBe(p.length); // distinct sides: no stacked spawns
      if (i > 0) expect(p[0].tMs - patterns[i - 1][0].tMs).toBe(
        CONFIG.spawnPhases.find((x) => patterns[i - 1][0].tMs >= x.fromMs && patterns[i - 1][0].tMs < x.untilMs)!.intervalMs,
      );
    }
  });

  it('places every spawn just outside the field edge, never inside the field', () => {
    for (const e of buildSchedule(123456, CONFIG)) {
      const onTop = e.side === 0 && e.y === -SPAWN_OUTSET_PX && e.x > 0 && e.x < W;
      const onRight = e.side === 1 && e.x === W + SPAWN_OUTSET_PX && e.y > 0 && e.y < H;
      const onBottom = e.side === 2 && e.y === H + SPAWN_OUTSET_PX && e.x > 0 && e.x < W;
      const onLeft = e.side === 3 && e.x === -SPAWN_OUTSET_PX && e.y > 0 && e.y < H;
      expect(onTop || onRight || onBottom || onLeft).toBe(true);
    }
  });

  it('accepts numeric and free-text seeds deterministically', () => {
    expect(seedFromString('42')).toBe(42);
    expect(seedFromString('playtest-3')).toBe(seedFromString('playtest-3'));
    expect(seedFromString('playtest-3')).not.toBe(seedFromString('playtest-4'));
  });
});
