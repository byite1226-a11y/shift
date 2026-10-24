import './style.css';
import { CONFIG, LEVEL_PRESETS, LEVELS as LEVELS_DEFAULT } from './config';
import { Sim, type Input, type Mode, type Phase, type ScheduleKind, type Vec } from './sim';
import { draw, type Vfx } from './render';
import { audio, type MusicState, type SfxKind } from './audio';
import { ads } from './ads';
import { comparableRuns, loadRecords, loadRuns, persistRuns, runStats, saveRun, clearRuns, type Records, type RunRecord } from './storage';
import { BOARD_SIZE, deviceRank, normalizeInitials, topRuns } from './ranking';
import { clearRounds, loadRounds, saveRound as storeRound, countRounds } from './roundstore';
import { clientToField } from './geom';
import { randomSeed, seedFromString } from './rng';
import { DodgeBot, ReactiveBot } from './bot';

const W = CONFIG.world.width, H = CONFIG.world.height;
// ?diff=aware → the 죽림고수-style preset (g3.2: stream / line / burst on independent timers) for side-by-side feel comparison with g3.1
const diffParam = new URLSearchParams(location.search).get('diff') ?? 'default';
const LEVELS = LEVEL_PRESETS[diffParam] ?? LEVELS_DEFAULT;
const RETRY_LOCK_MS = 250;   // result panel appears at 200 ms; a key already being mashed must not skip it
const RESULT_DELAY_MS = 200; // short freeze / hit feedback before the result panel
const MAX_ROUND_LOGS = 10;
const MAX_LEVEL = 10;

/** Mode names shown to players (2026-10-21: "DODGE / DEFEND" instead of input-device labels). The A/B/C ids stay in records and URLs. */
const MODES: Record<Mode, { tag: string; name: string; sub: string; badge: 'dart' | 'core' | 'dual'; hint: string; fail: string }> = {
  A: { tag: 'DODGE / SURVIVE', name: 'DODGE', sub: '탄막 회피', badge: 'dart', hint: 'WASD  /  ARROW KEYS', fail: '투사체에 한 번 닿으면 종료' },
  B: { tag: 'DODGE / MOUSE', name: 'DODGE', sub: '마우스 회피', badge: 'dart', hint: 'FOLLOW THE POINTER', fail: '투사체에 한 번 닿으면 종료' },
  C: { tag: 'DEFEND / CORE', name: 'DEFEND', sub: '코어 방어', badge: 'core', hint: 'AIM  /  LEFT CLICK', fail: `코어 체력 ${LEVELS.defend.coreHitPoints}칸이 모두 깎이면 종료` },
  D: { tag: 'DUAL / SURVIVE', name: 'DUAL', sub: '회피 + 요격', badge: 'dual', hint: 'WASD  +  LEFT CLICK', fail: '투사체에 한 번 닿으면 종료, 검은 탄은 요격 불가' },
};
/** Mode rows on the home screen. B is hidden since the 2026-10-21 playtest (still reachable via ?mode=B). */
const HOME_MODES: Mode[] = ['A', 'C', 'D'];
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stage = $<HTMLDivElement>('stage');
const overlay = $<HTMLDivElement>('overlay');
const timerEl = $('timer'), pbEl = $('pb'), hintEl = $('hint');
const modeTagEl = $('modeTag'), lvLabelEl = $('lvLabel'), lvPipsEl = $('lvPips');
const debugEl = $('debug'), seedInput = $<HTMLInputElement>('seedInput'), seedState = $('seedState'), dbgStats = $('dbgStats');
const showHitEl = $<HTMLInputElement>('showHit');
const testerEl = $<HTMLInputElement>('tester'), sessionInfo = $('sessionInfo'), modeStatsEl = $('modeStats');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- state -----------------------------------------------------------------
let mode: Mode = 'A';
let pinnedSeed: number | null = null;
const legacyRecords: Records = loadRecords(); // Gate 01/02 rounds: read-only from here on
let runs: RunRecord[] = loadRuns();           // Gate 03 endless runs
const keys = new Set<string>();
const clicks: Vec[] = [];
let pointer: Vec | null = null;
const input: Input = { keys, pointer: null, clicks };
const vfx: Vfx[] = [];
let shownPhase: Phase | null = null;
let finishedAt = 0;
let lastNewBest = false;
let lastRun: RunRecord | null = null;
let lastFinished: RunRecord | null = null;     // survives newRound(): the board highlights it
let lastRank: { rank: number; total: number } | null = null; // the finished run's place on the device board
let initialsPending = false;                   // arcade: the run made the board and has no name yet
let homeView: 'title' | 'board' | 'sound' = 'title'; // what the READY overlay shows
let titleEntrance = true;                      // play the wordmark's slide-in on the next title render
let boardMode: Mode = 'A';
let shownLevel = -1;
const roundLogs: ReturnType<Sim['toLog']>[] = [];

// ---- playtest session --------------------------------------------------------
const TESTER_KEY = 'shift.gate02.tester';
const sessionId = `${Date.now().toString(36)}-${randomSeed().toString(36)}`;
let tester = '';
try { tester = localStorage.getItem(TESTER_KEY) ?? ''; } catch { /* ignore */ }
let roundStartedAt = '';
let storedRounds = 0;
let unexported = false; // rounds stored since the last download
let hiddenSince = 0, hiddenMs = 0; // tab hidden while a round was live (the sim is paused meanwhile)

const params = new URLSearchParams(location.search);
const pt = params.get('tester');
if (pt) { tester = pt; try { localStorage.setItem(TESTER_KEY, tester); } catch { /* ignore */ } }
const pm = params.get('mode');
if (pm === 'A' || pm === 'B' || pm === 'C' || pm === 'D') mode = pm;
const ps = params.get('seed');
if (ps) pinnedSeed = seedFromString(ps);
// ?sched=g1|g2 plays the legacy 40 s schedules for before/after comparison (CLEAR at 40 s, not a valid record)
const schedParam = params.get('sched');
const scheduleFor = (m: Mode): ScheduleKind | undefined =>
  m === 'C' ? (schedParam === 'g1' ? 'g1' : undefined) : (schedParam === 'g1' || schedParam === 'g2' ? schedParam : undefined);
// ?autopilot=1 lets a bot drive mode A (test hook: reproducible screenshots/logs; such runs are marked suspect, never a best)
const autopilot = params.get('autopilot') === '1';
// round-end interstitial (Google H5 Games Ads). Loads only when VITE_ADSENSE_CLIENT is set; ?adtest=1 = test ads
ads.init(params.get('adtest') === '1');
const bot = params.get('bot') === 'reactive' ? new ReactiveBot() : new DodgeBot();
if (params.get('hit') === '1') showHitEl.checked = true;

let sim = new Sim(mode, randomSeed(), CONFIG, { schedule: scheduleFor(mode), autopilot, levels: LEVELS });

// ---- helpers ---------------------------------------------------------------
const fmt = (ms: number) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms / 10) % 100).padStart(2, '0')}`;
const fmtS = (ms: number) => (ms / 1000).toFixed(1);
const pips = (level: number, cls = '') =>
  Array.from({ length: MAX_LEVEL }, (_, i) => `<i class="${i < level ? (i === level - 1 ? 'on cur' : 'on') : ''}"></i>`).join('') + (cls ? '' : '');

// ---- sound page (home "SOUND"): every effect, where it plays, a button to hear it ----
const SOUNDS: [SfxKind, string, string, boolean][] = [ // kind, name, when, in use
  ['warn', '예고', '빠른 탄 예고 마커가 켜질 때', true],
  ['near', '근접 통과', '투사체가 아슬아슬하게 스칠 때 (CLOSE!)', true],
  ['hit', '요격', 'DEFEND·DUAL에서 클릭으로 투사체를 지울 때', true],
  ['save', '세이브', 'DEFEND에서 코어 직전에 요격했을 때 (SAVE!)', true],
  ['hurt', '코어 피격', 'DEFEND에서 코어 체력이 깎일 때', true],
  ['fail', '사망', '투사체에 닿거나 코어가 파괴될 때', true],
  ['start', '시작', '라운드 카운트다운이 시작될 때', true],
  ['record', '기록 등록', '이니셜을 등록했을 때', true],
  ['ui', '선택', '모드 선택, 페이지 닫기', true],
  ['pause', '일시정지', 'ESC로 멈출 때', true],
  ['resume', '재개', '일시정지에서 돌아올 때', true],
  ['clear', '클리어', '이전 규칙(40초)에서만', true],
  // kept for auditioning; not played by the game (user calls, 2026-10-22/23)
  ['volley', '일제사격', '일제사격·부채꼴 발사. 꺼 둠', false],
  ['row', '일렬탄', '일렬탄·벽 진입. 꺼 둠', false],
  ['miss', '빈 클릭', '빈 곳 클릭. 꺼 둠', false],
  ['level', '레벨 상승', '레벨이 오를 때. 꺼 둠', false],
  ['launch', '낱개 발사 (일반)', '조준탄 한 발 발사. 꺼 둠', false],
  ['launchFast', '낱개 발사 (빠름)', '빠른 탄 한 발 발사. 꺼 둠', false],
  ['launchHeavy', '낱개 발사 (대형)', '대형탄 한 발 발사. 꺼 둠', false],
];
function soundHtml() {
  const rows = SOUNDS.map(([k, name, when, used]) => `
        <li class="row${used ? '' : ' off'}">
          <button class="play" type="button" data-sfx="${k}" aria-label="${name} 듣기">▶</button>
          <span class="who">${name}</span><span class="when">${when}</span>
        </li>`).join('');
  return `
      <div class="board sounds">
        <p class="tagline">SOUND</p>
        <h2>효과음</h2>
        <ol class="rows">${rows}</ol>
        <div class="tabs">
          <button class="tab" type="button" data-music="home">BGM 홈</button>
          <button class="tab" type="button" data-music="play">BGM 게임</button>
          <button class="tab" type="button" data-music="off">정지</button>
        </div>
        <p class="rule">흐리게 표시된 소리는 지금 게임에서 쓰지 않는 것입니다. 전부 생성음이라 음량·길이·음색은 숫자로 바꿀 수 있습니다.</p>
        <button class="btn ghost" type="button" data-act="title">돌아가기 <kbd>ESC</kbd></button>
      </div>`;
}

// ---- device-local leaderboard (home "RANKING", result "랭킹") ---------------
// Only the runs stored in this browser: same mode and rules version, valid and finished. It is not a server ranking
// and shows no top percent; the contract for a real one lives in src/ranking.ts.
const boardQuery = (m: Mode) => ({ mode: m, gameVersion: LEVELS.gameVersion, difficultyVersion: m === 'C' ? LEVELS.difficultyVersion.defend : LEVELS.difficultyVersion.dodge });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const when = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function boardHtml() {
  const q = boardQuery(boardMode);
  const top = topRuns(runs, q, BOARD_SIZE);
  const total = comparableRuns(runs, boardMode, q.difficultyVersion).length;
  const tabs = HOME_MODES.map((m) => `<button class="tab" type="button" data-board="${m}" aria-pressed="${m === boardMode}">${MODES[m].name}</button>`).join('');
  // arcade table: rank, initials, time, level. Runs without a name show as ---.
  const rows = top.length
    ? top.map((e) => `
        <li class="row${lastFinished && lastFinished.createdAt === e.createdAt ? ' me' : ''}" title="${when(e.createdAt)}">
          <span class="rank">${e.rank}</span><span class="who">${e.participantId ? esc(e.participantId) : '---'}</span>
          <span class="time">${fmt(e.survivalTimeMs)}</span><span class="lv">LV.${e.reachedLevel}</span>
        </li>`).join('')
    : '<li class="empty">아직 기록이 없습니다.</li>';
  return `
      <div class="board">
        <p class="tagline">RANKING</p>
        <h2>HIGH SCORES</h2>
        <div class="tabs">${tabs}</div>
        <ol class="rows">${rows}</ol>
        <p class="rule">이 기기에서 플레이한 모든 기록 ${total}판 중 상위 ${Math.min(BOARD_SIZE, total)} (${q.difficultyVersion} 규칙). 온라인 순위는 서버가 붙으면 여기에 표시됩니다.</p>
        <button class="btn ghost" type="button" data-act="title">돌아가기 <kbd>ESC</kbd></button>
      </div>`;
}

function newRound() {
  if (sim.phase !== 'FINISHED') sim.abandon();
  sim = new Sim(mode, pinnedSeed ?? randomSeed(), CONFIG, { schedule: scheduleFor(mode), autopilot, levels: LEVELS });
  vfx.length = 0;
  shownPhase = null;
  shownLevel = -1;
  lastNewBest = false;
  lastRun = null;
  hiddenMs = 0;
  seedState.textContent = `현재 ${sim.seed}${pinnedSeed !== null ? ' (고정)' : ''} · 스케줄 ${sim.scheduleKind} (${sim.difficultyVersion})`;
}

function startRound() {
  homeView = 'title';
  if (sim.phase !== 'READY') newRound();
  roundStartedAt = new Date().toISOString();
  sim.begin();
  audio.play('start');
}

function goHome() {
  if (sim.phase === 'READY') return;
  titleEntrance = true;
  newRound();
}

function syncSession() {
  sessionInfo.textContent = `세션 ${sessionId} · 저장된 라운드 ${storedRounds}${unexported ? ' (미다운로드)' : ''}`;
  modeStatsEl.textContent = HOME_MODES
    .map((m) => { const st = runStats(runs, m, m === 'C' ? LEVELS.difficultyVersion.defend : LEVELS.difficultyVersion.dodge); return `${m} ${st.count}판 최고 ${fmtS(st.best)}s 중앙 ${fmtS(st.median)}s`; })
    .join(' · ');
}

function bestFor(m: Mode) {
  return runStats(runs, m, m === 'C' ? LEVELS.difficultyVersion.defend : LEVELS.difficultyVersion.dodge, tester || undefined);
}

function setMode(m: Mode) {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  const d = MODES[m];
  hintEl.textContent = d.hint;
  modeTagEl.textContent = d.tag;
  newRound();
}

/** Space / R / Enter / overlay click: the one "go" action for the current state. */
function primary(now = performance.now()) {
  if (ads.showing) return; // an interstitial is up: no retry/start underneath it
  audio.unlock();
  switch (sim.phase) {
    case 'READY': startRound(); break;
    case 'PAUSED': sim.resume(); audio.play('resume'); break;
    case 'FINISHED': if (now - finishedAt >= RETRY_LOCK_MS) { newRound(); startRound(); } break;
  }
}

function renderOverlay(phase: Phase) {
  const home = phase === 'READY';
  document.body.classList.toggle('home', home); // home: the overlay covers HUD + field + caption, canvas stays laid out
  overlay.classList.toggle('home', home);
  if (phase === 'COUNTDOWN' || phase === 'PLAYING') { overlay.hidden = true; return; }
  overlay.hidden = false;
  if (phase === 'READY') {
    if (homeView === 'board') { overlay.innerHTML = boardHtml(); return; }
    if (homeView === 'sound') { overlay.innerHTML = soundHtml(); return; }
    // Home screen after docs/brief/gate03-concept/02_Screen_Concepts/01_Home.png: wordmark, START, mode rows, best time,
    // projectile sprites at the margins (the real in-game assets, not redrawn).
    const best = bestFor(mode).best;
    const rows = HOME_MODES.map((m) => `
        <button class="mode" type="button" data-mode="${m}" aria-pressed="${m === mode}">
          <span class="k ${MODES[m].badge}">${MODES[m].badge !== 'core' ? '<img src="/assets/projectiles/standard.png" alt="" draggable="false" />' : ''}</span>
          <span class="n">${MODES[m].name}<small>${MODES[m].sub}</small></span>
          <span class="h">${MODES[m].hint}</span>
        </button>`).join('');
    // a still composition of darts caught mid-flight around the title (streaks and specks drawn in CSS, no animation)
    const deco = [['standard', 'd1'], ['standard', 'd2'], ['large', 'd3'], ['standard', 'd4'], ['large', 'd5'], ['large', 'd6'], ['standard', 'd7'], ['standard', 'd8'], ['standard', 'd9'], ['large', 'd10']]
      .map(([k, c]) => `<span class="deco ${c} ${k}" aria-hidden="true"><i></i><b></b><img src="/assets/projectiles/${k}.png" alt="" draggable="false" /></span>`).join('');
    const enter = titleEntrance; // the wordmark slides in once per arrival at the home screen, not on every mode click
    titleEntrance = false;
    overlay.innerHTML = `
      ${deco}
      <div class="title${enter ? ' enter' : ''}">
        <h2 class="wordmark">SHIFT</h2>
        <p class="tagline">A REFLEX WARM-UP ARCADE</p>
        <button class="btn primary start" type="button">START <span class="arrow" aria-hidden="true">→</span></button>
        <div class="pick" role="group" aria-label="모드 선택">${rows}</div>
        <p class="best"><span>BEST TIME</span><strong>${best > 0 ? fmt(best) : '--:--.--'}</strong></p>
        <button class="link" type="button" data-act="board">RANKING</button>
      </div>`;
  } else if (phase === 'PAUSED') {
    overlay.innerHTML = `
      <p class="eyebrow">일시정지</p>
      <button class="btn primary" type="button">재개 <kbd>ESC</kbd> / <kbd>Space</kbd></button>`;
  } else {
    // Gate 03 result screen (03_Game_Over_Clean, trimmed 2026-10-22): time, level, then either the arcade initials
    // prompt (the run made this device's board) or the best time. Two buttons. Seed and averages live in the debug panel / export.
    const st = bestFor(mode);
    const r = sim.endReason;
    const v = sim.validity();
    const reasonKo: Record<string, string> = { autopilot: '봇 조작', legacy_rules: '이전 규칙', slow_frames: '프레임 지연', low_fps: '낮은 FPS', long_stall: '긴 멈춤' };
    const title = r === 'abandoned' ? '중단' : r === 'clear' ? 'CLEAR (이전 규칙)' : 'RUN COMPLETE';
    const named = lastFinished?.participantId ?? '';
    const newBest = lastNewBest ? ' <span class="new">NEW BEST</span>' : '';
    const record = initialsPending
      ? `<div class="initials"><span class="eyebrow coral">NEW RECORD · #${lastRank!.rank}</span><input id="initials" maxlength="3" placeholder="AAA" autocomplete="off" spellcheck="false" aria-label="이니셜 3글자" /><button class="btn primary" type="button" data-act="initials">등록</button></div>`
      : lastRank && lastRank.rank <= BOARD_SIZE && named
        ? `<p class="best">#${lastRank.rank} <strong>${esc(named)}</strong>${newBest}</p>`
        : `<p class="best">BEST <strong>${st.best > 0 ? fmt(st.best) : '--:--.--'}</strong>${newBest}</p>`;
    overlay.innerHTML = `
      <div class="result">
        <p class="eyebrow coral">${title}</p>
        <div class="big-time">${fmt(sim.survivalMs)}</div>
        <div class="lvrow"><span class="muted">SURVIVED</span><strong>LV. ${sim.reachedLevel}</strong><span class="pips">${pips(sim.reachedLevel)}</span></div>
        ${record}
        <div class="btns">
          <button class="btn primary" type="button" data-act="retry">RETRY <kbd>R</kbd></button>
          <button class="btn ghost" type="button" data-act="board">RANKING</button>
        </div>
        <button class="link" type="button" data-act="home">모드 선택</button>
        ${v.status === 'suspect' ? `<p class="tiny">이 기록은 순위와 개인 최고에서 제외 (${v.reasons.map((x) => reasonKo[x] ?? x).join(', ')})</p>` : ''}
      </div>`;
    const input = overlay.querySelector<HTMLInputElement>('#initials');
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); registerInitials(); } });
      input.addEventListener('input', () => { input.value = normalizeInitials(input.value); });
      input.focus();
    }
  }
}

/** Arcade initials: name the run that just made the board, persist it, show the result again. */
function registerInitials() {
  const name = normalizeInitials(overlay.querySelector<HTMLInputElement>('#initials')?.value ?? '');
  if (!name || !lastFinished) return;
  lastFinished.participantId = name; // the same object that saveRun() stored
  persistRuns(runs);
  initialsPending = false;
  audio.play('record');
  renderOverlay('FINISHED');
}

function onFinished(now: number) {
  finishedAt = now;
  const v = sim.validity();
  lastRun = {
    mode: sim.mode, participantId: tester, sessionId, seed: sim.seed,
    survivalTimeMs: sim.survivalMs, reachedLevel: sim.reachedLevel, deathReason: sim.endReason!,
    gameVersion: LEVELS.gameVersion, difficultyVersion: sim.difficultyVersion,
    runValidity: v.status, validityReasons: v.reasons, createdAt: new Date().toISOString(),
  };
  lastFinished = lastRun;
  lastRank = null;
  initialsPending = false;
  if (sim.endReason !== 'abandoned') {
    const before = bestFor(mode).best;
    runs = saveRun(runs, lastRun);
    lastNewBest = v.status === 'valid' && sim.survivalMs > before;
    // arcade table: a valid run that makes the top of this device's board asks for initials (a facilitated playtest already names the participant)
    lastRank = v.status === 'valid' ? deviceRank(runs, boardQuery(mode), sim.survivalMs) : null;
    initialsPending = !!lastRank && lastRank.rank <= BOARD_SIZE && !tester;
    audio.play(sim.endReason === 'clear' ? 'clear' : 'fail');
  }
  const log = {
    ...sim.toLog(),
    gate: '03', tester, sessionId, startedAt: roundStartedAt, endedAt: new Date().toISOString(), hiddenMs,
    run: lastRun,
    client: { ua: navigator.userAgent, dpr: window.devicePixelRatio || 1, viewport: [window.innerWidth, window.innerHeight], stageWidthPx: Math.round(stage.getBoundingClientRect().width) },
  };
  roundLogs.push(log);
  if (roundLogs.length > MAX_ROUND_LOGS) roundLogs.shift();
  void storeRound(log).then((n) => { storedRounds = n; unexported = true; syncSession(); });
}

/** Stereo position of a field x (−0.8 … +0.8): sounds come from where things happen. */
const panOf = (x: number) => Math.max(-0.8, Math.min(0.8, (x / W - 0.5) * 1.6));
// Projectiles make no sound on launch (user calls, 2026-10-22/23: per-dart whips, then volley and row sounds, were
// all "정신사나워"); their cue is the spawn flash and the trail. The fast-shot telegraph still ticks.
function drainEvents(now: number) {
  for (const e of sim.outbox) {
    switch (e.type) {
      // origins sit 14 px outside the field, so the entry cue is pulled just inside the edge to stay visible
      case 'spawn': vfx.push({ kind: 'spawn', x: Math.min(Math.max(e.x, 10), W - 10), y: Math.min(Math.max(e.y, 10), H - 10), t0: now, dur: 110 }); break;
      case 'telegraph': audio.play('warn', panOf(e.x)); break;
      case 'near_miss':
        vfx.push({ kind: 'near', x: e.x, y: e.y, t0: now, dur: 80 }, { kind: 'label', text: 'CLOSE!', x: e.x, y: e.y, t0: now, dur: 320 });
        audio.play('near', panOf(e.x));
        break;
      case 'hit':
        vfx.push({ kind: 'kill', x: e.x, y: e.y, angle: e.angle, t0: now, dur: 140, color: e.closeSave ? CONFIG.palette.sage : undefined });
        if (e.closeSave) vfx.push({ kind: 'label', text: 'SAVE!', color: CONFIG.palette.danger, x: e.x, y: e.y, t0: now, dur: 360 });
        audio.play(e.closeSave ? 'save' : 'hit', panOf(e.x));
        break;
      case 'miss': vfx.push({ kind: 'miss', x: e.x, y: e.y, t0: now, dur: 120 }); break; // silent by user call
      case 'core_hit':
        vfx.push({ kind: 'corehit', x: e.x, y: e.y, t0: now, dur: 260 });
        if (e.hp > 0) audio.play('hurt');
        break;
      case 'level': break; // HUD reads sim.level each frame; no sound by user call
      case 'finish':
        if (e.reason === 'hit' || e.reason === 'core_breach') vfx.push({ kind: 'fail', x: e.x, y: e.y, t0: now, dur: 200 });
        break;
    }
  }
  sim.outbox.length = 0;
}

// ---- canvas sizing & pointer transform --------------------------------------
let dpr = 1, scale = 1;
function resize() {
  const rect = stage.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  scale = rect.width / W;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
}
new ResizeObserver(resize).observe(stage);
resize();

function toField(e: PointerEvent): Vec {
  return clientToField(e.clientX, e.clientY, canvas.getBoundingClientRect(), W, H);
}

// ---- input -----------------------------------------------------------------
window.addEventListener('pointermove', (e) => { pointer = toField(e); input.pointer = pointer; }, { passive: true });
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  audio.unlock();
  pointer = toField(e);
  input.pointer = pointer;
  if (sim.phase === 'PLAYING' && (mode === 'C' || mode === 'D')) clicks.push(pointer);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
overlay.addEventListener('click', (e) => {
  if (ads.showing) return;
  const t = e.target as HTMLElement;
  const m = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as Mode | undefined;
  if (m) { audio.unlock(); audio.play('ui'); setMode(m); return; }
  const tab = t.closest<HTMLElement>('[data-board]')?.dataset.board as Mode | undefined;
  if (tab) { boardMode = tab; renderOverlay('READY'); return; }
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'home') { goHome(); return; }
  if (act === 'board') { boardMode = mode; homeView = 'board'; if (sim.phase === 'READY') renderOverlay('READY'); else goHome(); return; }
  if (act === 'title') { homeView = 'title'; renderOverlay('READY'); audio.setMusic('home'); return; }
  if (act === 'sound') { homeView = 'sound'; renderOverlay('READY'); return; }
  if (act === 'initials') { registerInitials(); return; }
  // sound page: audition one effect, or set the music state
  const sfxKind = t.closest<HTMLElement>('[data-sfx]')?.dataset.sfx as SfxKind | undefined;
  if (sfxKind) { audio.unlock(); audio.play(sfxKind, 0); return; }
  const music = t.closest<HTMLElement>('[data-music]')?.dataset.music as MusicState | undefined;
  if (music) { audio.unlock(); audio.setMusic(music); return; }
  if (t.closest('.initials')) return; // typing a name, not starting a round
  if (sim.phase === 'READY' && homeView !== 'title') return; // the board / sound pages are for reading, not a start button
  primary();
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (ads.showing) return;
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); if (!e.repeat) keys.add(e.code); return; }
  if (e.repeat) return;
  switch (e.code) {
    case 'Escape':
      if (sim.phase === 'PLAYING') { sim.pause(); audio.play('pause'); }
      else if (sim.phase === 'PAUSED') { sim.resume(); audio.play('resume'); }
      else if (sim.phase === 'READY' && homeView !== 'title') { homeView = 'title'; renderOverlay('READY'); audio.setMusic('home'); audio.play('ui'); }
      break;
    case 'Space': case 'KeyR': case 'Enter':
      e.preventDefault();
      primary();
      break;
    case 'Backquote':
      toggleDebug();
      break;
  }
});
window.addEventListener('keyup', (e) => { keys.delete(e.code); });
window.addEventListener('blur', () => { keys.clear(); sim.pause(); });
document.addEventListener('visibilitychange', () => {
  audio.background(document.hidden);
  if (document.hidden) { keys.clear(); sim.pause(); if (sim.phase === 'PAUSED') hiddenSince = performance.now(); }
  else if (hiddenSince) { hiddenMs += performance.now() - hiddenSince; hiddenSince = 0; }
});


const soundBtn = $<HTMLButtonElement>('soundBtn');
const syncSound = () => { soundBtn.textContent = audio.enabled ? '사운드 켜짐' : '사운드 꺼짐'; };
soundBtn.addEventListener('click', () => { audio.unlock(); audio.toggle(); syncSound(); soundBtn.blur(); });
syncSound();

// ---- debug -----------------------------------------------------------------
function toggleDebug() { debugEl.hidden = !debugEl.hidden; }
$('debugBtn').addEventListener('click', toggleDebug);
// the sound audition page is a tuning tool, reached from here and not from the player-facing home
$('soundPage').addEventListener('click', () => { if (sim.phase !== 'READY') goHome(); homeView = 'sound'; renderOverlay('READY'); });
// forces an ad break outside a round; with ?adtest=1 Google serves a test interstitial, without a client id it does nothing
$('adTest').addEventListener('click', () => {
  const out = $('adState');
  if (!ads.enabled) { out.textContent = '광고: VITE_ADSENSE_CLIENT 미설정'; return; }
  out.textContent = '광고: 요청함';
  ads.roundEnd({ after: () => { const l = ads.last; out.textContent = `광고: ${l ? `${l.breakStatus} (${l.breakFormat || '-'})` : '응답 없음'}`; } });
});
$('seedPin').addEventListener('click', () => {
  const v = seedInput.value.trim();
  pinnedSeed = v === '' ? null : seedFromString(v);
  if (sim.phase === 'READY' || sim.phase === 'FINISHED') newRound();
  else seedState.textContent = `다음 판부터 ${pinnedSeed ?? '랜덤'}`;
});
$('seedRandom').addEventListener('click', () => { pinnedSeed = null; seedInput.value = ''; if (sim.phase === 'READY' || sim.phase === 'FINISHED') newRound(); });
$('dlLogs').addEventListener('click', async () => {
  const rounds = await loadRounds();
  const dv = LEVELS.difficultyVersion;
  const payload = {
    exportedAt: new Date().toISOString(), gate: '03', gameVersion: LEVELS.gameVersion, difficultyVersion: dv, tester, sessionId,
    client: { ua: navigator.userAgent, dpr: window.devicePixelRatio || 1, viewport: [window.innerWidth, window.innerHeight] },
    config: CONFIG, patterns: sim.patterns, levels: LEVELS,
    // Gate 03 runs (per mode, never pooled) and the frozen Gate 01/02 records, kept apart
    runs,
    runStatsByMode: { A: runStats(runs, 'A', dv.dodge), B: runStats(runs, 'B', dv.dodge), C: runStats(runs, 'C', dv.defend), D: runStats(runs, 'D', dv.dodge) },
    runStatsForTester: tester ? { A: runStats(runs, 'A', dv.dodge, tester), B: runStats(runs, 'B', dv.dodge, tester), C: runStats(runs, 'C', dv.defend, tester), D: runStats(runs, 'D', dv.dodge, tester) } : null,
    legacyRecords,
    rounds,
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shift-playtest-${tester || 'anon'}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  unexported = false;
  syncSession();
});
$('clearRounds').addEventListener('click', async () => {
  if (!confirm(`저장된 라운드 로그 ${storedRounds}판을 지웁니다. 다운로드했습니까?`)) return;
  await clearRounds();
  storedRounds = 0; unexported = false;
  syncSession();
});
$('clearRecords').addEventListener('click', () => { if (confirm('Gate 03 개인 기록을 지웁니다. (Gate 01/02 기록은 유지)')) { runs = clearRuns(); shownPhase = null; syncSession(); } });
testerEl.value = tester;
testerEl.addEventListener('change', () => {
  tester = testerEl.value.trim();
  try { localStorage.setItem(TESTER_KEY, tester); } catch { /* ignore */ }
  shownPhase = null;
  syncSession();
});
window.addEventListener('beforeunload', (e) => { if (unexported) { e.preventDefault(); e.returnValue = ''; } });
void countRounds().then((n) => { storedRounds = n; syncSession(); });
if (pinnedSeed !== null) seedInput.value = String(pinnedSeed);

// ---- loop ------------------------------------------------------------------
let last = performance.now();
let statsAt = 0;
function tick(now: number) {
  const dt = now - last;
  last = now;

  if (autopilot && mode === 'A' && sim.phase === 'PLAYING') {
    keys.clear();
    for (const k of bot.keys(sim)) keys.add(k);
  }

  const before = sim.phase;
  sim.frame(dt, input);
  clicks.length = 0;
  if (sim.phase === 'FINISHED' && before !== 'FINISHED') onFinished(now);
  drainEvents(now);

  // overlay / chrome follow the phase; FINISHED waits for the short hit feedback
  const visiblePhase: Phase = sim.phase === 'FINISHED' && now - finishedAt < RESULT_DELAY_MS ? 'PLAYING' : sim.phase;
  if (visiblePhase !== shownPhase) {
    shownPhase = visiblePhase;
    renderOverlay(visiblePhase);
    audio.setMusic(visiblePhase === 'READY' ? 'home' : visiblePhase === 'COUNTDOWN' || visiblePhase === 'PLAYING' ? 'play' : visiblePhase === 'PAUSED' ? 'pause' : 'off');
    // one interstitial per round, offered once the result is on screen (Google may skip it); input waits until it closes
    if (visiblePhase === 'FINISHED') ads.roundEnd({ before: () => keys.clear(), after: () => overlay.querySelector<HTMLInputElement>('#initials')?.focus() });
    const live = visiblePhase === 'COUNTDOWN' || visiblePhase === 'PLAYING';
    canvas.style.cursor = live && mode !== 'A' ? 'none' : '';
    const best = bestFor(mode).best;
    pbEl.textContent = best > 0 ? `BEST ${fmt(best)}` : 'BEST --:--.--';
  }
  timerEl.textContent = fmt(sim.phase === 'FINISHED' ? sim.survivalMs : sim.t);
  const lv = sim.phase === 'READY' || sim.phase === 'COUNTDOWN' ? 1 : Math.max(1, sim.phase === 'FINISHED' ? sim.reachedLevel : sim.level);
  if (lv !== shownLevel) {
    shownLevel = lv;
    lvLabelEl.textContent = `LEVEL ${String(lv).padStart(2, '0')}`;
    lvPipsEl.innerHTML = pips(lv);
  }

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  draw(ctx, sim, vfx, now, pointer, reducedMotion, showHitEl.checked);

  if (!debugEl.hidden && now - statsAt > 250) {
    statsAt = now;
    const f = sim.frames, c = sim.counters, k = sim.clock;
    const fps = f.totalMs > 0 ? (f.count / (f.totalMs / 1000)).toFixed(0) : '-';
    dbgStats.textContent = `LV ${sim.level} · fps ${fps} · max frame ${f.maxMs.toFixed(0)}ms · lost ${k.lostMs.toFixed(0)}ms · paused ${k.pausedMs.toFixed(0)}ms · steps ${f.steps} · proj ${sim.projectiles.length} (max ${c.maxActive}) · spawned ${c.spawned} (skip ${c.skippedSpawns}, fastcap ${c.fastSkips}, cancel ${c.cancelled}) · flips ${c.flips} · tele ${c.telegraphs} · near ${c.nearMisses} · hit ${c.hits} · miss ${c.misses}${mode === 'C' ? ` · core ${sim.coreHp}/${sim.coreHpMax}` : ''} · log ${sim.log.length}${sim.droppedLogs ? ` (+${sim.droppedLogs} dropped)` : ''}`;
  }
  requestAnimationFrame(tick);
}

setMode(mode);
requestAnimationFrame(tick);

if (import.meta.env.DEV) {
  // test hook: window.__shift.sim / .setMode / .primary / .runs
  (window as unknown as { __shift: unknown }).__shift = {
    get sim() { return sim; },
    get runs() { return runs; },
    get roundLogs() { return roundLogs; },
    get sessionId() { return sessionId; },
    get lastRun() { return lastRun; },
    loadRounds, setMode, primary, goHome, bot,
    exported() { unexported = false; }, // automated runs: skip the leave-page guard
  };
}
