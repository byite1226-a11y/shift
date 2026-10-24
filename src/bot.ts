import type { Sim } from './sim';

/**
 * Greedy keyboard dodge bot used for the automated fairness sweep (and `?autopilot=1` in the browser).
 * It is deliberately simple: it sees a projectile only `reactionMs` after it became visible (telegraph start
 * or spawn), re-decides every `decideEveryMs`, and picks one of 9 directions by the longest time-to-collision
 * over a short horizon. Its deaths are candidates to inspect, not proof of unfairness; its survival shows an
 * escape existed for a player with this reaction time.
 */
/** centerBias: 1 = stay central (default); negative values make the bot prefer corners (used to probe the flip rule). */
export interface BotOptions { reactionMs: number; horizonMs: number; decideEveryMs: number; centerBias?: number }
export const DEFAULT_BOT: BotOptions = { reactionMs: 150, horizonMs: 1200, decideEveryMs: 50, centerBias: 1 };

export interface BotLike { keys(sim: Sim): Set<string> }

const toKeys = (dx: number, dy: number) => {
  const s = new Set<string>();
  if (dx > 0) s.add('KeyD'); else if (dx < 0) s.add('KeyA');
  if (dy > 0) s.add('KeyS'); else if (dy < 0) s.add('KeyW');
  return s;
};

/**
 * Bot B — restricted reactive bot. It only uses what is drawn: projectiles inside the field that have been
 * visible for at least `reactionMs`, with velocity *estimated from two sightings* 100 ms apart (never read from
 * the sim), and it ignores schedule data and the telegraph markers. It sidesteps the single most urgent threat
 * perpendicular to that threat's heading; otherwise it drifts to the centre.
 */
export interface ReactiveOptions { reactionMs: number; perceiveEveryMs: number }
export class ReactiveBot implements BotLike {
  private dir: [number, number] = [0, 0];
  private lastT = -Infinity;
  private prev = new Map<number, { x: number; y: number; t: number }>();
  constructor(readonly opts: ReactiveOptions = { reactionMs: 250, perceiveEveryMs: 100 }) {}

  keys(sim: Sim): Set<string> {
    const [dx, dy] = this.direction(sim);
    return toKeys(dx, dy);
  }

  direction(sim: Sim): [number, number] {
    if (sim.t - this.lastT < this.opts.perceiveEveryMs) return this.dir;
    this.lastT = sim.t;
    const { width: W, height: H } = sim.cfg.world;
    const px = sim.player.x, py = sim.player.y;
    const seen = sim.projectiles.filter((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && sim.t - p.spawnT >= this.opts.reactionMs);
    const next = new Map<number, { x: number; y: number; t: number }>();
    let worst: { score: number; vx: number; vy: number; x: number; y: number } | null = null;
    for (const p of seen) {
      next.set(p.id, { x: p.x, y: p.y, t: sim.t });
      const o = this.prev.get(p.id);
      if (!o || o.t === sim.t) continue; // motion needs two sightings
      const dts = (sim.t - o.t) / 1000;
      const vx = (p.x - o.x) / dts, vy = (p.y - o.y) / dts;
      const v2 = vx * vx + vy * vy;
      if (!v2) continue;
      const rx = p.x - px, ry = p.y - py;
      const tca = Math.min(1, Math.max(0, -(rx * vx + ry * vy) / v2)); // closest approach within 1 s
      const miss = Math.hypot(rx + vx * tca, ry + vy * tca);
      if (miss >= 60) continue;
      const score = miss + tca * 50; // nearer and sooner is worse
      if (!worst || score < worst.score) worst = { score, vx, vy, x: p.x, y: p.y };
    }
    this.prev = next;
    if (!worst) {
      const dx = W / 2 - px, dy = H / 2 - py;
      const l = Math.hypot(dx, dy);
      this.dir = l < 40 ? [0, 0] : [Math.abs(dx / l) > 0.38 ? Math.sign(dx) : 0, Math.abs(dy / l) > 0.38 ? Math.sign(dy) : 0];
      return this.dir;
    }
    const l = Math.hypot(worst.vx, worst.vy);
    const nx = -worst.vy / l, ny = worst.vx / l;
    const side = (px - worst.x) * nx + (py - worst.y) * ny >= 0 ? 1 : -1; // step away from its line, on our side
    let ex = nx * side, ey = ny * side;
    if ((ex > 0 && W - px < 60) || (ex < 0 && px < 60) || (ey > 0 && H - py < 60) || (ey < 0 && py < 60)) { ex = -ex; ey = -ey; }
    this.dir = [Math.abs(ex) > 0.38 ? Math.sign(ex) : 0, Math.abs(ey) > 0.38 ? Math.sign(ey) : 0];
    return this.dir;
  }
}

const DIRS: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const TELEGRAPH_KEEPOUT_PX = 260;

/** Earliest τ in [0, tMax] at which |r + wτ| ≤ R, or null. */
function firstHit(rx: number, ry: number, wx: number, wy: number, R: number, tMax: number): number | null {
  const c = rx * rx + ry * ry - R * R;
  if (c <= 0) return 0;
  const a = wx * wx + wy * wy;
  if (a === 0) return null;
  const b = 2 * (rx * wx + ry * wy);
  const D = b * b - 4 * a * c;
  if (D < 0) return null;
  const t = (-b - Math.sqrt(D)) / (2 * a);
  return t >= 0 && t <= tMax ? t : null;
}

/** Bot A — geometric: exact positions/velocities of visible darts (after reactionMs), time-to-collision search over 9 directions. */
export class DodgeBot implements BotLike {
  private dir: [number, number] = [0, 0];
  private lastT = -Infinity;
  readonly opts: BotOptions;
  constructor(opts: Partial<BotOptions> = {}) { this.opts = { ...DEFAULT_BOT, ...opts }; } // partial options keep the defaults

  direction(sim: Sim): [number, number] {
    if (sim.t - this.lastT < this.opts.decideEveryMs) return this.dir;
    this.lastT = sim.t;
    this.dir = this.choose(sim);
    return this.dir;
  }

  /** KeyboardEvent.code set equivalent to the chosen direction (feeds Sim.frame like a real player). */
  keys(sim: Sim): Set<string> {
    const [dx, dy] = this.direction(sim);
    return toKeys(dx, dy);
  }

  private choose(sim: Sim): [number, number] {
    const { width: W, height: H } = sim.cfg.world;
    const speed = sim.cfg.dodge.playerMoveSpeedPxPerSec;
    const pr = sim.cfg.dodge.playerHitRadiusPx, rv = sim.cfg.dodge.playerVisualRadiusPx;
    const Hs = this.opts.horizonMs / 1000;
    const px = sim.player.x, py = sim.player.y;
    const visible = sim.projectiles.filter((p) => sim.t - p.visibleFromT >= this.opts.reactionMs);
    let best: [number, number] = [0, 0], bestScore = -Infinity;
    for (const [dx, dy] of DIRS) {
      const l = Math.hypot(dx, dy) || 1;
      const vx = (dx / l) * speed, vy = (dy / l) * speed;
      // the field edge stops us; afterwards we stand still there
      let tWall = Hs;
      if (vx > 0) tWall = Math.min(tWall, (W - rv - px) / vx); else if (vx < 0) tWall = Math.min(tWall, (rv - px) / vx);
      if (vy > 0) tWall = Math.min(tWall, (H - rv - py) / vy); else if (vy < 0) tWall = Math.min(tWall, (rv - py) / vy);
      tWall = Math.max(0, tWall);
      let ttc = Hs;
      for (const p of visible) {
        const R = p.r + pr + 2;
        const t1 = firstHit(p.x - px, p.y - py, p.vx - vx, p.vy - vy, R, tWall);
        if (t1 !== null) { ttc = Math.min(ttc, t1); continue; }
        const t2 = firstHit(p.x - px + (p.vx - vx) * tWall, p.y - py + (p.vy - vy) * tWall, p.vx, p.vy, R, Hs - tWall);
        if (t2 !== null) ttc = Math.min(ttc, tWall + t2);
      }
      const ta = Math.min(0.4, tWall);
      const ex = px + vx * ta, ey = py + vy * ta;
      let score = ttc;
      for (const tg of sim.telegraphs) {               // a fast shot will come from here: keep flight time long
        const d = Math.hypot(ex - tg.x, ey - tg.y);
        if (d < TELEGRAPH_KEEPOUT_PX) score -= ((TELEGRAPH_KEEPOUT_PX - d) / TELEGRAPH_KEEPOUT_PX) * 0.4;
      }
      let clear = Infinity;
      for (const p of visible) clear = Math.min(clear, Math.hypot(p.x + p.vx * ta - ex, p.y + p.vy * ta - ey) - p.r - pr);
      if (clear < Infinity) score += (Math.min(clear, 120) / 120) * 0.2;
      score -= (Math.hypot(ex - W / 2, ey - H / 2) / 1000) * 0.15 * (this.opts.centerBias ?? 1); // corners are traps (unless probing)
      if (dx === this.dir[0] && dy === this.dir[1]) score += 0.01;  // stability
      if (score > bestScore) { bestScore = score; best = [dx, dy]; }
    }
    return best;
  }
}
