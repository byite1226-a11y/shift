import type { EndReason, Mode, RunValidity } from './sim';

// ---------------------------------------------------------------------------
// Gate 01/02 records (40 s rounds). Frozen: kept readable so nothing is lost, never mixed with Gate 03 runs.
// ---------------------------------------------------------------------------
const KEY = 'shift.gate01.records.v1';
const MAX_ROUNDS = 200; // local history is bounded; oldest rounds drop off

export interface RoundRecord { mode: Mode; seed: number; survivalMs: number; reason: EndReason; at: number; tester?: string }
export interface Records { best: Record<Mode, number>; rounds: RoundRecord[] }

const empty = (): Records => ({ best: { A: 0, B: 0, C: 0, D: 0 }, rounds: [] });

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<Records>;
    return { best: { ...empty().best, ...(parsed.best ?? {}) }, rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [] };
  } catch {
    return empty();
  }
}

function persist(r: Records) {
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* quota/private mode: records stay in memory */ }
}

/** Store a finished legacy round. Returns whether it set a new personal best for its mode. */
export function saveRound(records: Records, rec: RoundRecord): boolean {
  records.rounds.push(rec);
  if (records.rounds.length > MAX_ROUNDS) records.rounds.splice(0, records.rounds.length - MAX_ROUNDS);
  const newBest = rec.reason !== 'abandoned' && rec.survivalMs > records.best[rec.mode];
  if (newBest) records.best[rec.mode] = rec.survivalMs;
  persist(records);
  return newBest;
}

export function clearRecords(): Records {
  const r = empty();
  persist(r);
  return r;
}

export interface ModeStats { count: number; clears: number; clearRate: number; best: number; median: number; mean: number; last: number[] }

/** Legacy personal-record view, one block per mode; modes are never pooled (their survival times are not comparable). */
export function statsByMode(r: Records, tester?: string): Record<Mode, ModeStats> {
  const out = {} as Record<Mode, ModeStats>;
  for (const mode of ['A', 'B', 'C', 'D'] as Mode[]) {
    const rounds = r.rounds.filter((x) => x.mode === mode && (tester === undefined || x.tester === tester));
    const times = rounds.map((x) => x.survivalMs).sort((a, b) => a - b);
    const clears = rounds.filter((x) => x.reason === 'clear').length;
    out[mode] = {
      count: rounds.length,
      clears,
      clearRate: rounds.length ? +(clears / rounds.length).toFixed(3) : 0,
      best: times.length ? times[times.length - 1] : 0,
      median: times.length ? times[Math.floor(times.length / 2)] : 0,
      mean: times.length ? Math.round(times.reduce((a, v) => a + v, 0) / times.length) : 0,
      last: rounds.slice(-5).map((x) => x.survivalMs),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate 03 runs (endless survival). The record shape is the one a future server would receive.
// ---------------------------------------------------------------------------
export interface RunRecord {
  mode: Mode;
  participantId: string;
  sessionId: string;
  seed: number;
  survivalTimeMs: number;
  reachedLevel: number;
  deathReason: EndReason;
  gameVersion: string;
  difficultyVersion: string;
  runValidity: RunValidity;
  validityReasons: string[];
  createdAt: string; // ISO
}

const RUNS_KEY = 'shift.gate03.runs.v1';
const MAX_RUNS = 500;

export function loadRuns(): RunRecord[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
  } catch {
    return [];
  }
}

/** Append a run (bounded history). Returns the stored list. */
export function saveRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  runs.push(run);
  if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch { /* keep in memory */ }
  return runs;
}

/** Re-persist after editing a stored run in place (arcade initials entered after the run was saved). */
export function persistRuns(runs: RunRecord[]) {
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch { /* keep in memory */ }
}

export function clearRuns(): RunRecord[] {
  try { localStorage.removeItem(RUNS_KEY); } catch { /* ignore */ }
  return [];
}

/** Runs that count: finished (not abandoned), valid, same rules. Optionally one participant. */
export function comparableRuns(runs: RunRecord[], mode: Mode, difficultyVersion: string, participantId?: string): RunRecord[] {
  return runs.filter((r) =>
    r.mode === mode && r.difficultyVersion === difficultyVersion && r.runValidity === 'valid' && r.deathReason !== 'abandoned' &&
    (participantId === undefined || r.participantId === participantId));
}

export interface RunStats { count: number; best: number; median: number; mean: number; last5Avg: number; last: number[] }

/** Personal-record view for the result screen and the export: per mode and rules version, never pooled. */
export function runStats(runs: RunRecord[], mode: Mode, difficultyVersion: string, participantId?: string): RunStats {
  const rs = comparableRuns(runs, mode, difficultyVersion, participantId);
  const times = rs.map((r) => r.survivalTimeMs).sort((a, b) => a - b);
  const last = rs.slice(-5).map((r) => r.survivalTimeMs);
  return {
    count: rs.length,
    best: times.length ? times[times.length - 1] : 0,
    median: times.length ? times[Math.floor(times.length / 2)] : 0,
    mean: times.length ? Math.round(times.reduce((a, v) => a + v, 0) / times.length) : 0,
    last5Avg: last.length ? Math.round(last.reduce((a, v) => a + v, 0) / last.length) : 0,
    last,
  };
}
