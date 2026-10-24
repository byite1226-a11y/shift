import { CONFIG } from './config';
import { clamp, type Vec } from './geom';
import { COUNTDOWN_MS, type Projectile, type Sim, type Telegraph } from './sim';

export interface Vfx {
  kind: 'spawn' | 'near' | 'kill' | 'miss' | 'fail' | 'label' | 'corehit';
  x: number;
  y: number;
  t0: number;   // wall-clock ms (performance.now)
  dur: number;
  angle?: number;
  text?: string;
  color?: string;
}

const P = CONFIG.palette;
const CORE_FILL = '#EEEAE1';
/** Motion trail length = speed × this many seconds. Rendering only — never part of any hit test. */
const TRAIL_SECONDS = 0.1;

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- Option B sprites (docs/brief/gate03-concept, approved reference) ------------------------------------------
// Transparent PNGs extracted from the concept art are drawn as-is (rotated to the heading, never reshaped).
// Sizes: body length in field px; width follows the asset's aspect ratio. `anchor` = where the physics centre sits
// along the body (fraction from the back), chosen so the circular hit zone lies inside the solid part of the shape.
interface SpriteDef { url: string; lengthPx: number; anchor: number; trail: string; img: HTMLImageElement | null; ready: boolean }
const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const SPRITES: Record<'normal' | 'large', SpriteDef> = {
  normal: { url: `${BASE}assets/projectiles/standard.png`, lengthPx: 26, anchor: 0.58, trail: P.danger, img: null, ready: false },
  large: { url: `${BASE}assets/projectiles/large.png`, lengthPx: 44, anchor: 0.5, trail: P.sage, img: null, ready: false },
};
if (typeof Image !== 'undefined') {
  for (const s of Object.values(SPRITES)) {
    const img = new Image();
    img.onload = () => { s.ready = true; };
    img.src = s.url;
    s.img = img;
  }
}
/** For the debug overlay / report: drawn body extents vs. the circular hit radius. */
export function spriteExtents(kind: 'normal' | 'large') {
  const s = SPRITES[kind];
  const w = s.img && s.img.naturalWidth ? (s.lengthPx * s.img.naturalHeight) / s.img.naturalWidth : s.lengthPx * 0.65;
  return { lengthPx: s.lengthPx, widthPx: +w.toFixed(1), tipAheadPx: +(s.lengthPx * (1 - s.anchor)).toFixed(1), tailBehindPx: +(s.lengthPx * s.anchor).toFixed(1), ready: s.ready };
}

export function draw(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  vfx: Vfx[],
  now: number,
  pointer: Vec | null,
  reducedMotion: boolean,
  showHitAreas = false,
) {
  const { width: W, height: H } = sim.cfg.world;
  ctx.fillStyle = P.field;
  ctx.fillRect(0, 0, W, H);
  cornerTicks(ctx, W, H);

  reducedMotionDraw = reducedMotion;
  for (const tg of sim.telegraphs) telegraph(ctx, tg, sim.t, W, H);
  for (const p of sim.projectiles) {
    if (sim.mode === 'C') { target(ctx, p, sim.cfg.defend.clickTargetHitRadiusPx, sim.t); continue; }
    // D: shootable darts look exactly like A's, armoured ones are drawn in ink. No click ring (user call, 2026-10-22):
    // the 15 px judgement is unchanged from C and still shows in the debug hit-area overlay.
    body(ctx, p, false, sim.t, sim.mode === 'D' && !!p.armored);
  }

  const failed = sim.phase === 'FINISHED' && (sim.endReason === 'hit' || sim.endReason === 'core_breach');
  const actorColor = failed ? P.danger : P.ink;
  if (sim.mode === 'C') core(ctx, sim.core.x, sim.core.y, sim.cfg.defend.coreVisualRadiusPx, actorColor, sim.coreHp, sim.coreHpMax);
  else diamond(ctx, sim.player.x, sim.player.y, sim.cfg.dodge.playerVisualRadiusPx, actorColor);

  // Pointer marker: thin ring + ticks, visually unlike both the player (solid diamond) and projectiles.
  const live = sim.phase === 'COUNTDOWN' || sim.phase === 'PLAYING';
  if (sim.mode !== 'A' && pointer && live) {
    if (sim.mode === 'B') {
      const r = sim.cfg.dodge.playerVisualRadiusPx;
      crosshair(ctx, clamp(pointer.x, r, W - r), clamp(pointer.y, r, H - r), P.sage);
    } else if (pointer.x >= 0 && pointer.x <= W && pointer.y >= 0 && pointer.y <= H) {
      crosshair(ctx, pointer.x, pointer.y, P.ink);
    }
  }

  for (let i = vfx.length - 1; i >= 0; i--) {
    const v = vfx[i];
    const k = (now - v.t0) / v.dur;
    if (k >= 1) { vfx.splice(i, 1); continue; }
    drawVfx(ctx, v, reducedMotion ? 0.45 : k);
  }

  if (sim.phase === 'COUNTDOWN') {
    const a = sim.mode === 'C' ? sim.core : sim.player;
    const remain = sim.countdownMs / COUNTDOWN_MS;
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 30, -Math.PI / 2, -Math.PI / 2 + remain * Math.PI * 2);
    ctx.stroke();
  }

  if (showHitAreas) hitAreas(ctx, sim);
}

function cornerTicks(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.strokeStyle = P.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, y] of [[16, 18], [W - 24, 18], [16, H - 18], [W - 24, H - 18]]) {
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(x + 8, y + 0.5);
  }
  ctx.stroke();
}

/*
 * Option B trail, built so that it reads as motion instead of a picture glued to the body. Everything is a pure
 * function of (position, velocity, game time) — straight constant-speed flight makes "where was it N ms ago"
 * exact — so it freezes on pause and costs no state. Decorative only: never part of any hit test.
 *   1. specks: dropped from the tail every SPECK_EVERY ms, they stay where they were dropped and fade while the
 *      body flies on (the strongest "it is moving" cue);
 *   2. afterimages: the body as it was 65 / 130 / 195 ms ago, fainter and a little smaller, lagging behind;
 *   3. streaks: short tapered tints whose length and opacity breathe a little over time.
 */
const RIBBON_MS = 220;        // the ribbon covers the path flown in the last 220 ms
const SPECK_EVERY_MS = 140;
const SPECK_LIFE_MS = 380;
let reducedMotionDraw = false;

/** Specks dropped from the tail along the centre line; they stay where dropped and fade while the body flies on. */
function specks(ctx: CanvasRenderingContext2D, p: Projectile, back: number, width: number, color: string, t: number, compact: boolean) {
  const phase = (p.id * 37) % SPECK_EVERY_MS;
  const newest = Math.floor((t - p.spawnT - phase) / SPECK_EVERY_MS);
  ctx.fillStyle = color;
  for (let j = 0; j < 3; j++) {
    const n = newest - j;
    if (n < 0) break;
    const age = t - (p.spawnT + phase + n * SPECK_EVERY_MS);
    if (age < 0 || age > SPECK_LIFE_MS) continue;
    const k = age / SPECK_LIFE_MS;
    const x = back - (p.speed * age) / 1000;             // the tail was here when the speck was dropped
    const y = (n % 2 === 0 ? 1 : -1) * width * 0.1;      // barely off the centre line: calm, not scattered
    ctx.globalAlpha = 0.4 * (1 - k);
    ctx.beginPath();
    ctx.arc(x, y, (compact ? 1.0 : 1.4) * (1 - 0.5 * k), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * One smooth tapered ribbon in a light tint of the body colour (no outline, no copies) spanning the distance flown in
 * the last RIBBON_MS, plus one thin, shorter secondary line — the concept sheet's clean two-line trail. Geometry is
 * fixed per speed: nothing breathes or flickers.
 */
function streaks(ctx: CanvasRenderingContext2D, back: number, bodyLen: number, width: number, speed: number, color: string) {
  const L = Math.max(bodyLen * 0.7, (speed * RIBBON_MS) / 1000); // slow ≈ 25 px, normal ≈ 46 px, fast ≈ 74 px
  const rows: [number, number, number, number][] = [ // [y offset × width, length factor, root thickness × width, alpha]
    [0, 1.0, 0.32, 0.3],
    [-0.24, 0.58, 0.1, 0.2],
  ];
  for (const [oy, lf, th, a] of rows) {
    const y = oy * width, len = L * lf, h = Math.max(1.4, width * th) / 2;
    const grad = ctx.createLinearGradient(back, 0, back - len, 0);
    grad.addColorStop(0, rgba(color, a));
    grad.addColorStop(0.5, rgba(color, a * 0.5));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(back, y - h);
    ctx.quadraticCurveTo(back - len * 0.5, y - h * 0.4, back - len, y);
    ctx.quadraticCurveTo(back - len * 0.5, y + h * 0.4, back, y + h);
    ctx.closePath();
    ctx.fill();
  }
}

/** Projectile body: the Option B sprite when loaded, otherwise the Gate 02 vector dart. `t` is game time (freezes on pause). */
/** Ink-tinted copy of a sprite (mode D armoured look), made once per image: the silhouette in charcoal with the inner detail faintly kept. */
const INKED = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
function inked(img: HTMLImageElement): CanvasImageSource {
  let c = INKED.get(img);
  if (!c) {
    c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = rgba(P.ink, 0.82);
    g.fillRect(0, 0, c.width, c.height);
    INKED.set(img, c);
  }
  return c;
}

function body(ctx: CanvasRenderingContext2D, p: Projectile, compact: boolean, t: number, ink = false) {
  const s = SPRITES[p.kind];
  const angle = Math.atan2(p.vy, p.vx);
  const trail = ink ? P.ink : s.trail;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  if (s.ready && s.img) {
    const len = compact ? s.lengthPx * 0.78 : s.lengthPx;
    const w = (len * s.img.naturalHeight) / s.img.naturalWidth;
    const back = -len * s.anchor;
    if (!reducedMotionDraw) specks(ctx, p, back + len * 0.1, w, trail, t, compact);
    streaks(ctx, back + len * 0.12, len, w, p.speed, trail); // the ribbon starts just inside the tail notch
    ctx.drawImage(ink ? inked(s.img) : s.img, back, -w / 2, len, w);
  } else {
    const k = compact ? { L: 14, w: 3 } : p.kind === 'large' ? { L: 30, w: 8 } : { L: 19, w: 3.6 };
    dart(ctx, p, k.L, k.w, ink);
  }
  ctx.restore();
}

/** Gate 02 vector dart (fallback while sprites load). Drawn in local coordinates. */
function dart(ctx: CanvasRenderingContext2D, p: Projectile, L: number, w: number, ink = false) {
  const hw = w / 2, tip = L * 0.21, back = -L / 2 - 3;
  const trail = p.speed * TRAIL_SECONDS;
  const grad = ctx.createLinearGradient(back, 0, back - trail, 0);
  grad.addColorStop(0, rgba(ink ? P.ink : P.danger, 0.4));
  grad.addColorStop(1, rgba(ink ? P.ink : P.danger, 0));
  ctx.strokeStyle = grad;
  ctx.lineWidth = Math.max(1.6, w * 0.8);
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(back, 0); ctx.lineTo(back - trail, 0); ctx.stroke();
  ctx.fillStyle = ink ? P.ink : p.kind === 'large' ? P.sage : P.danger;
  ctx.beginPath();
  ctx.moveTo(-L / 2, -hw); ctx.lineTo(L / 2 - tip, -hw); ctx.lineTo(L / 2, 0); ctx.lineTo(L / 2 - tip, hw); ctx.lineTo(-L / 2, hw);
  ctx.closePath();
  ctx.fill();
  if (p.kind === 'large') { ctx.strokeStyle = rgba(P.ink, 0.55); ctx.lineWidth = 1; ctx.stroke(); }
}

/**
 * C-mode target: the drawn ring IS the click judgement (radius = clickTargetHitRadiusPx); the Option B body sits
 * inside it, pointing along the heading. The trail is decorative and outside the hit zone.
 */
function target(ctx: CanvasRenderingContext2D, p: Projectile, R: number, t: number) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.strokeStyle = P.danger;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  body(ctx, p, true, t);
}

/** Fast-shot warning: a mustard ring at the edge that shrinks and pulses until the shot fires. Uses game time, so it freezes on pause. */
function telegraph(ctx: CanvasRenderingContext2D, tg: Telegraph, t: number, W: number, H: number) {
  const k = clamp((t - tg.startT) / Math.max(1, tg.fireAt - tg.startT), 0, 1);
  const x = clamp(tg.x, 12, W - 12), y = clamp(tg.y, 12, H - 12);
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(k * Math.PI * 4));
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.strokeStyle = P.mustard;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 16 - 8 * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = P.mustard;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

/** Core with its hit points as ring segments around it (sage = left, border = lost). */
function core(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, hp: number, hpMax: number) {
  ctx.fillStyle = CORE_FILL;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r * 0.64, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = P.field;
  ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, Math.PI * 2); ctx.fill();
  if (hpMax > 1) {
    const gap = 0.22, span = (Math.PI * 2) / hpMax;
    ctx.lineWidth = 3;
    for (let i = 0; i < hpMax; i++) {
      const a0 = -Math.PI / 2 + i * span + gap / 2;
      ctx.strokeStyle = i < hp ? P.sage : P.border;
      ctx.beginPath(); ctx.arc(x, y, r + 7, a0, a0 + span - gap); ctx.stroke();
    }
  }
}

function crosshair(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * 15, y + dy * 15);
    ctx.lineTo(x + dx * 21, y + dy * 21);
  }
  ctx.stroke();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, width = 1.5, dash?: number[]) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Debug only: the real judgement circles, so visible shape and hit zone can be compared. */
function hitAreas(ctx: CanvasRenderingContext2D, sim: Sim) {
  const dash = [3, 3];
  if (sim.mode === 'C') {
    ring(ctx, sim.core.x, sim.core.y, sim.cfg.defend.coreHitRadiusPx, P.mustard, 0.9, 1, dash);
    for (const p of sim.projectiles) {
      ring(ctx, p.x, p.y, sim.cfg.defend.clickTargetHitRadiusPx, P.mustard, 0.9, 1, dash); // click zone
      ring(ctx, p.x, p.y, p.r, P.danger, 0.7, 1, dash);                                     // body used for the core breach
    }
  } else {
    ring(ctx, sim.player.x, sim.player.y, sim.cfg.dodge.playerHitRadiusPx, P.mustard, 0.9, 1, dash);
    ring(ctx, sim.player.x, sim.player.y, sim.cfg.dodge.nearMissCenterDistanceMaxPx, P.sage, 0.35, 1, dash);
    for (const p of sim.projectiles) {
      ring(ctx, p.x, p.y, p.r, P.danger, 0.7, 1, dash);
      if (sim.mode === 'D' && !p.armored) ring(ctx, p.x, p.y, sim.cfg.defend.clickTargetHitRadiusPx, P.mustard, 0.9, 1, dash); // click zone
    }
  }
}

function drawVfx(ctx: CanvasRenderingContext2D, v: Vfx, k: number) {
  switch (v.kind) {
    case 'spawn':       // 80–120 ms entry cue at the edge
      ring(ctx, v.x, v.y, 6 + 10 * k, P.danger, 0.6 * (1 - k));
      break;
    case 'near':        // one thin ring expanding around the player
      ring(ctx, v.x, v.y, 14 + 12 * k, P.sage, 1 - k);
      break;
    case 'kill': {      // target splits into two fragments that separate and fade; the 15 px ring collapses
      const a = v.angle ?? 0;
      const sep = 2 + 6 * k;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.translate(v.x, v.y);
      ctx.rotate(a);
      ctx.strokeStyle = P.danger;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-8, -sep); ctx.lineTo(6, -sep);
      ctx.moveTo(-8, sep); ctx.lineTo(6, sep);
      ctx.stroke();
      ctx.restore();
      ring(ctx, v.x, v.y, 15 - 9 * k, v.color ?? P.danger, 1 - k);
      break;
    }
    case 'miss':        // empty click: a faint, tiny ring so the click is acknowledged without rewarding it
      ring(ctx, v.x, v.y, 4 + 4 * k, P.muted, 0.5 * (1 - k), 1);
      break;
    case 'fail':        // ≤200 ms hit feedback before the result panel
      ring(ctx, v.x, v.y, 12 + 26 * k, P.danger, 1 - k, 2);
      break;
    case 'corehit':     // core lost a hit point: coral ring bursts outward from the core
      ring(ctx, v.x, v.y, 30 + 22 * k, P.danger, 1 - k, 3);
      break;
    case 'label': {
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = v.color ?? P.sage;
      ctx.font = '800 11px "Noto Sans KR", "NanumSquare", sans-serif';
      ctx.fillText(v.text ?? '', v.x + 20, v.y - 8 - 6 * k);
      ctx.restore();
      break;
    }
  }
}
