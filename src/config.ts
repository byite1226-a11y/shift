import raw from '../config/gate01.constants.json';
import rawPatterns from '../config/gate02.patterns.json';
import rawLevels from '../config/gate03.levels.json';
import rawLevelsAware from '../config/gate03.levels.aware.json';

export interface SpawnPhase {
  fromMs: number;
  untilMs: number;
  intervalMs: number;
  projectileSpeedPxPerSec: number;
  projectilesPerPattern: [number, number];
}

export interface Config {
  world: {
    width: number;
    height: number;
    roundCapMs: number;
    firstSpawnAtMs: number;
    failureHitsAllowed: number;
    maxProjectiles: number;
  };
  spawnPhases: SpawnPhase[];
  dodge: {
    playerMoveSpeedPxPerSec: number;
    playerVisualRadiusPx: number;
    playerHitRadiusPx: number;
    projectileHitRadiusPx: number;
    nearMissCenterDistanceMinPx: number;
    nearMissCenterDistanceMaxPx: number;
    aimAtPlayerOnSpawn: boolean;
    homingAfterSpawn: boolean;
    mouseFollowMaxSpeedPxPerSec: number;
    mouseArrivalTolerancePx: number;
  };
  defend: {
    coreVisualRadiusPx: number;
    coreHitRadiusPx: number;
    clickTargetHitRadiusPx: number;
    targetMovesTowardStaticCore: boolean;
    closeSaveThresholdMs: number;
  };
  palette: Record<'paper' | 'field' | 'ink' | 'muted' | 'border' | 'danger' | 'sage' | 'mustard', string>;
}

// ---- Gate 02: dodge pattern definitions ------------------------------------

export type Kind = 'normal' | 'large';
export type Tier = 'slow' | 'normal' | 'fast';
export type PatternType = 'aimed' | 'volley' | 'fan';

export interface PatternStep {
  atMs: number;
  pattern: PatternType;
  kind: Kind;
  tier: Tier;
  speed: number;
  telegraphMs?: number;   // aimed only: marker appears this long before the shot fires
  spacingPx?: number;     // volley
  gapSlots?: number;      // volley
  rays?: number;          // fan
  spreadDeg?: number;     // fan: fixed angular spread
}

export interface PatternGroup { heavy: boolean; steps: PatternStep[] }

export interface PatternPhase {
  name: string;
  fromMs: number;
  untilMs: number;
  intervalMs: number;
  restAfterHeavyMs: number;
  maxActiveFast: number;
  overlap: number;
  minFastGapMs?: number; // overrides fairness.minFastGapMs for this phase
  playlist: [string, number][];
}

export interface Patterns {
  projectileKinds: Record<Kind, { hitRadiusPx: number; lengthPx: number; widthPx: number }>;
  speedTiers: Record<Tier, [number, number]>;
  fairness: {
    minFlightMs: number;
    fastTelegraphMs: number;
    minCorridorPx: number;
    minFanGapPx: number;
    wallGapBand: { topBottom: [number, number]; leftRight: [number, number] };
    overlapOffsetMs: number;
    minFastGapMs: number;
    minWallGapMs: number;
    minSpawnDistancePx: number;
  };
  patterns: Record<string, PatternGroup>;
  phases: PatternPhase[];
}

// ---- Gate 03: endless survival levels -------------------------------------

/** One difficulty level for the dodge modes. untilMs null = open-ended (LV.10). */
export interface LevelDef {
  level: number;
  fromMs: number;
  untilMs: number | null;
  intervalMs: number;
  restAfterHeavyMs: number;
  maxActiveFast: number;
  overlap: number;
  overlapChance?: number;
  minFastGapMs?: number;
  playlist: [string, number][];
}

/** One difficulty level for the defend mode (aimed darts at the core only). */
export interface CoreLevelDef {
  level: number;
  fromMs: number;
  untilMs: number | null;
  intervalMs: number;
  dartsPerPattern: [number, number];
  tierWeights: Record<Tier, number>;
  maxActive: number;
  maxActiveFast: number;
}

/**
 * 죽림고수-style dodge levels (g3.2 "aware" preset): three independent timers instead of a weighted playlist.
 *  - stream: one dart at a steady cadence, aimed at the player's position when it fires.
 *  - line:   a straight row of `count` darts, `spacingPx` apart, all travelling the same way (one of 4 or 8
 *            directions), centred on the player's position when it is placed. The gaps are the way through.
 *  - burst:  `count` darts at the same instant from points spread around the field, all aimed at the player's
 *            position at that instant — they converge on it and scatter after passing through.
 * A level without a timer skips it. Fast-tier timers are telegraphed like every other fast shot.
 */
/** armored: mode D cannot click these away (large darts are armoured by default; set it to make a whole timer unshootable). */
export interface TimerSpec { everyMs: number; speed: number; tier: Tier; kind?: Kind; armored?: boolean }
export interface TimerLevelDef {
  level: number;
  fromMs: number;
  untilMs: number | null;
  maxActiveFast: number;
  stream?: TimerSpec;
  line?: TimerSpec & { count: number; spacingPx: number; directions?: 4 | 8 };
  burst?: TimerSpec & { count: number };
}

export interface Levels {
  gameVersion: string;
  difficultyVersion: { dodge: string; defend: string };
  validity: { maxLostFraction: number; minAvgFps: number; maxSingleFrameMs: number };
  /** `timers` present → the timer scheduler runs the dodge modes and `levels` is unused. */
  dodge: { firstSpawnAtMs: number; levels: LevelDef[]; timers?: TimerLevelDef[] };
  defend: {
    coreHitPoints: number;
    coreDamageCooldownMs: number;
    firstSpawnAtMs: number;
    speeds: Record<Tier, number[]>;
    levels: CoreLevelDef[];
  };
}

// All tunable numbers live in config/*.json (designer-editable, no code change needed).
export const CONFIG = raw as unknown as Config;
export const PATTERNS = rawPatterns as unknown as Patterns;
export const LEVELS = rawLevels as unknown as Levels;
export const LEVELS_AWARE = rawLevelsAware as unknown as Levels;
export const LEVEL_PRESETS: Record<string, Levels> = { default: LEVELS, aware: LEVELS_AWARE };
