// THE LISBON WAY: the browser side. The page draws Lisbon's grid of streets from above with the platform's authoritative
// state (the player's own queued turns applied by the very module the verifier runs, then brought to "now" by that same
// module) and turns a gesture into ONE ordered input: { action: 'turn', dir }. It never sends a score, a time or a state:
// who rides, who gets off and what it is worth is decided by the rules on SuperRare's server.
//
// The people are the people of the wall: their walking sprite (people.json) when they made one, a pixel stand-in
// otherwise; they ride at the tram's windows. Sprites, bubbles, sounds, music and the end card are display only.
import type { EndStats, GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { scoringConfiguration } from '../../shell/config.js';
import { HitFeed } from '../../shell/hits.js';
import { infoOf } from '../../shell/wall-data.js';
import { loadPeople, onPeople, sheetOfName } from '../../shell/people.js';
import { DIR, drawSprite, stepAt, type SpriteSheet } from '../../share/sprite.js';
import { fitTweet, intentHref, tag } from '../../share/post.js';
import { WALL_PANELS } from '../../generated/wall.js';
import { fnv1a } from '../../common/det.js';
import {
  CELLS, COLS, DEPOT, RULES, ROWS, STOPS, STOP_COUNT, TILE, engine, inputSchema, opposite, snapshotSchema, stateSchema, xOf, yOf,
  type LwEvent, type LwState, type Play, type What,
} from './engine.js';
import { KEY_DIR, swipeDir, tapDir } from './controls.js';

/** Defined (true) only in dev builds (scripts/dev-flow.ts): never in a published archive. */
declare const __DEV_ANY_ORIGIN__: boolean | undefined;

const W = 420, H = 800, TICK_MS = 50;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', BLUE = '#2E7FD6', LABEL = '#6B685F';
const TRAM = '#F2C230', TRAM_DARK = '#C99A12', RED = '#D64532', GOLD = '#D9A62E', RIVER = '#2E7FD6', STREET = '#E9E3D6';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const HUD_H = 96, CELL = W / COLS, GY = 100, PANEL_Y = GY + ROWS * CELL + 6;
const SNAPSHOT_NAME = new Map(WALL_PANELS.map((p) => [p.p, p]));
const nameOfPanel = (panel: number): string => (infoOf(panel).name || SNAPSHOT_NAME.get(panel)?.n || '').toUpperCase();
const handleOf = (panel: number): string => infoOf(panel).handle;   // the live wall's X handle, when known
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const cx = (cell: number): number => xOf(cell) * CELL + CELL / 2;
const cy = (cell: number): number => GY + yOf(cell) * CELL + CELL / 2;
const stopColor = (stop: number): string => STOPS[stop]?.color ?? INK;
const stopName = (stop: number): string => STOPS[stop]?.name ?? '';
const pick = <T,>(list: readonly T[], key: string): T => list[fnv1a(key) % list.length] as T;
/** "#3" -> 3; "—" or "Not top 10" -> undefined (the page's rank of this run in the week). */
const rankOf = (rank: string | undefined): number | undefined => { const m = rank ? /^#(\d+)$/.exec(rank) : null; return m ? Number(m[1]) : undefined; };

const SAYS: Record<What, readonly string[]> = {
  board: ['DING DING!', 'OLÁ!', 'GM!', 'NEXT STOP PLEASE', 'MOVE OVER!'],
  drop: ['OBRIGADO!', 'WAGMI', 'BEST TRAM EVER', 'THIS IS MY STOP'],
  crash: ['OUCH!', 'MY COFFEE!', 'NGMI', 'I WALK FROM HERE'],
  gone: ['TOO SLOW!', "I'LL TAKE A TUK-TUK", 'FORGET IT'],
};
/** What each 15 s wave brings (empty: nothing new). The speed-ups and the final rush have their own banners. */
const WAVE_BANNERS = ['ALL ABOARD!', '', '★ GOLDEN PASSENGERS', 'ROADWORKS!', '', ''];
const SPEED_BANNERS = ['', 'FASTER!', 'EVEN FASTER!', 'TOP SPEED!'];

type Mode = 'idle' | 'play' | 'end';
type Pop = { seq: number; what: What; cell: number; stop: number; k: number; gain: number; panel: number; t0: number };
type Bit = { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number };

/** The end card's title: what kind of tram driver this shift made you (display only). */
export function driverTitle(play: Play): { title: string; line: string; good: boolean } {
  if (play.bestChain >= 5) return { title: 'CHAIN LEGEND', line: `${play.bestChain} riders off at one stop.`, good: true };
  if (play.crashes === 0 && play.delivered >= RULES.cleanMin) return { title: 'SMOOTH OPERATOR', line: `${play.delivered} riders, not a single crash.`, good: true };
  if (play.crashes >= 4) return { title: 'DEMOLITION TRAM', line: `${play.crashes} crashes. Lisbon will remember.`, good: false };
  if (play.delivered >= 20) return { title: 'TRAM 28 HERO', line: `${play.delivered} people of the wall taken home.`, good: true };
  if (play.missed >= 10) return { title: 'LATE AGAIN', line: `${play.missed} people gave up waiting.`, good: false };
  return { title: 'NEW CONDUCTOR', line: `${play.delivered} ${play.delivered === 1 ? 'rider' : 'riders'}. The hills will wait for you.`, good: false };
}

/* ------------------------------- local high score ------------------------------ */
const BEST_KEY = 'the-lisbon-way:best';
type Best = { paid: number; practice: number };
function readBest(): Best {
  try { const b = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Partial<Best>; return { paid: Number(b.paid) || 0, practice: Number(b.practice) || 0 }; } catch { return { paid: 0, practice: 0 }; }
}
/** This device's best (display only, never sent anywhere); returns it and whether `score` is new. */
function recordBest(score: number, practice: boolean): { best: number; isNew: boolean } {
  const best = readBest(), key = practice ? 'practice' : 'paid', isNew = score > best[key];
  if (isNew) { best[key] = score; try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* storage unavailable */ } }
  return { best: best[key], isNew };
}

/* ------------------------------ a pixel stand-in ------------------------------ */
// A person of the wall without a character yet: a 16 × 16 pixel figure, colours from their name, four walking steps.
const SKIN = ['#F1C9A5', '#D9A47E', '#A8714F', '#6B4430', '#E8B98F'];
const TOP = ['#2E7FD6', '#3E7D4F', '#7A4FA3', '#D9A62E', '#5C6B78', '#B5462F', '#E86A92'];
const HAIR = ['#0B0B0B', '#5A3A22', '#C9A16B', '#8E2F1E', '#DEDBD3'];
function drawStandIn(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number, dir: number): void {
  const h = fnv1a(name), px = size / 16;
  const skin = SKIN[h % SKIN.length] as string, top = TOP[(h >>> 3) % TOP.length] as string, hair = HAIR[(h >>> 6) % HAIR.length] as string;
  const r = (x0: number, y0: number, w: number, hh: number, c: string): void => { g.fillStyle = c; g.fillRect(Math.round(x + x0 * px), Math.round(y + y0 * px), Math.ceil(w * px), Math.ceil(hh * px)); };
  const bob = step % 2 ? 0.5 : 0;
  r(5, 1 + bob, 6, 2, hair); r(5, 3 + bob, 6, 4, skin);
  if (dir === DIR.DOWN) { r(6, 4 + bob, 1, 1, INK); r(9, 4 + bob, 1, 1, INK); } else if (dir === DIR.UP) r(5, 3 + bob, 6, 2, hair);
  r(4, 7 + bob, 8, 5, top); r(3, 8 + bob, 1, 3, skin); r(12, 8 + bob, 1, 3, skin);
  const a = step % 4 === 1 ? 1 : step % 4 === 3 ? -1 : 0;
  r(5, 12, 2, 3 + (a > 0 ? 0 : 1), INK); r(9, 12, 2, 3 + (a < 0 ? 0 : 1), INK);
}
function drawPerson(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number, dir: number): void {
  const sheet: SpriteSheet | null = sheetOfName(name);
  if (sheet) drawSprite(g, sheet, x, y, size, step, dir);
  else drawStandIn(g, name, x, y, size, step, dir);
}

/* --------------------------------- sound --------------------------------- */
const SOUND_KEY = 'the-lisbon-way:sound';
let audio: AudioContext | null = null;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
function beep(freqs: number[], len = 0.08, type: OscillatorType = 'square', gain = 0.05): void {
  if (!soundOn) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    let t = audio.currentTime;
    for (const f of freqs) {
      const o = audio.createOscillator(), v = audio.createGain();
      o.type = type; o.frequency.value = f; v.gain.setValueAtTime(gain, t); v.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(v).connect(audio.destination); o.start(t); o.stop(t + len); t += len * 0.9;
    }
  } catch { /* no sound on this device */ }
}
const bell = (): void => beep([1320, 1660], 0.09, 'sine', 0.05);
/** A little tune for the shift (display only): A minor, faster in the rush. Off with the sound. */
class Music {
  private timer: number | undefined;
  private step = 0;
  private level = 0;
  private readonly bass = [110, 110, 130.8, 98, 110, 110, 146.8, 130.8];
  private readonly lead = [440, 523.3, 659.3, 587.3, 523.3, 440, 392, 440, 523.3, 659.3, 784, 659.3, 587.3, 523.3, 493.9, 440];
  start(): void { if (this.timer === undefined) this.loop(); }
  stop(): void { window.clearTimeout(this.timer); this.timer = undefined; this.step = 0; this.level = 0; }
  /** 0 at the start, 3 at top speed: the tune speeds up with the tram. */
  speed(level: number): void { this.level = level; }
  private loop(): void {
    const ms = [140, 124, 108, 92][this.level] ?? 92, fast = this.level >= 2;
    if (soundOn) {
      if (this.step % 2 === 0) beep([this.bass[(this.step / 2) % this.bass.length] as number], ms / 1000 * 1.6, 'triangle', 0.05);
      if (this.step % 4 === 1 || (fast && this.step % 2 === 1)) beep([this.lead[(this.step >> 1) % this.lead.length] as number], 0.07, 'square', 0.012);
    }
    this.step++;
    this.timer = window.setTimeout(() => this.loop(), ms);
  }
}

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('lw-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas lw-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'THE LISBON WAY. A grid of Lisbon streets seen from above. Steer the yellow tram with the arrow keys, W A S D, a swipe, or a tap on the side you want to turn to. Drive into the people of the wall to pick them up; drive onto the stop of their colour to drop them: riders of the same colour dropped together score more. Do not hit the houses, the river, roadworks or your own tram.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  soundButton.style.background = CHALK; soundButton.style.color = INK; soundButton.style.border = `1px solid ${INK}`;
  const label = (): void => { soundButton.textContent = soundOn ? 'Sound on' : 'Sound off'; };
  label();
  soundButton.addEventListener('click', () => { soundOn = !soundOn; label(); try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* storage unavailable */ } });
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your shift');
  host.append(canvas, endPanel, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  void loadPeople();
  onPeople(() => { dirty = true; });

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let finalScore: number | null = null;
  let view: LwState | null = null;          // the latest authoritative (or predicted) state
  let shown: LwState | null = null;         // that state brought to "now" by the rules: what is drawn
  let nowTick = 0, tickAt = 0;
  let seen = new Map<number, What>();       // event seq -> what, so each event plays once (and a correction replays)
  let pops: Pop[] = [];
  let bits: Bit[] = [];
  let banner: { text: string; t0: number; gold: boolean } | null = null;
  let lastWave = -2, lastLevel = 0, rushShown = false, lastCount = -1, lastSecond = -1, flash = 0, shake = 0;
  let knownGold = new Set<number>();
  let endStats: EndStats | null = null;
  let best: { best: number; isNew: boolean } | null = null;
  let dirty = true, DPR = 1;
  let hits = new HitFeed('the-lisbon-way', false);
  const music = new Music();

  function reset(isPractice: boolean): void {
    view = null; shown = null; nowTick = 0; seen = new Map(); pops = []; bits = []; banner = null;
    lastWave = -2; lastLevel = 0; rushShown = false; lastCount = -1; lastSecond = -1; flash = 0; shake = 0; knownGold = new Set();
    finalScore = null; endStats = null; best = null; practice = isPractice;
    hits = new HitFeed('the-lisbon-way', isPractice ? false : undefined);
  }

  /* ------------------------------ text helpers ----------------------------- */
  function text(s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center', g: CanvasRenderingContext2D = ctx): void {
    g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y);
  }
  function fitFont(s: string, maxW: number, size: number, family: string, g: CanvasRenderingContext2D = ctx): string {
    let sz = size;
    g.font = `${sz}px ${family}`;
    while (sz > 7 && g.measureText(s).width > maxW) { sz -= 1; g.font = `${sz}px ${family}`; }
    return `${sz}px ${family}`;
  }

  /* -------------------------------- input ----------------------------------- */
  // One gesture, one turn: an arrow key (W A S D), a swipe, or a tap on the side of the tram you want to turn to.
  const canSteer = (): boolean => mode === 'play' && shown !== null && !shown.gameOver && io.canInput() && nowTick >= engine.openTickOf(shown);
  /** The heading the tram will have once its queued turns are taken. */
  const headingOf = (s: LwState): number => (s.play.turns.length ? s.play.turns[s.play.turns.length - 1] as number : s.play.dir);
  function turn(dir: number): void {
    if (!canSteer() || !shown) return;
    const heading = headingOf(shown);
    if (dir === heading || dir === opposite(heading) || shown.play.turns.length >= RULES.turnsMax) return;   // the rules would ignore it
    beep([520], 0.03, 'square', 0.025);
    io.sendInput({ action: 'turn', dir });
  }
  const toCanvas = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  };
  let press: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play') return;
    e.preventDefault();
    press = { ...toCanvas(e), id: e.pointerId };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId || !shown) return;
    const at = toCanvas(e), start = press;
    press = null;
    const swipe = swipeDir(at.x - start.x, at.y - start.y);
    if (swipe !== null) { turn(swipe); return; }
    const head = shown.play.tram[0] as number;
    turn(tapDir(at.x - cx(head), at.y - cy(head), headingOf(shown)));
  });
  canvas.addEventListener('pointercancel', () => { press = null; });
  window.addEventListener('keydown', (e) => {
    if (mode !== 'play') return;
    const dir = KEY_DIR[e.code];
    if (dir === undefined) return;
    e.preventDefault();
    if (!e.repeat) turn(dir);
  });
  // dev builds only: an automated driver reads the shift and steers
  if (typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__) Object.assign(window as object, { __lwTurn: turn, __lwState: () => shown });

  /* ------------------------------ state follow ------------------------------ */
  function burst(x: number, y: number, count: number, colors: string[]): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = 90 + Math.random() * 220;
      bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.6 + Math.random() * 0.6, c: colors[i % colors.length] as string, s: 3 + Math.random() * 4 });
    }
  }
  function follow(s: LwState): void {
    for (const e of s.play.events) {
      const before = seen.get(e.seq);
      if (before === e.what) continue;
      seen.set(e.seq, e.what);
      if (before === undefined) onEvent(e);
      pops = pops.filter((p) => p.seq !== e.seq);
      pops.push({ seq: e.seq, what: e.what, cell: e.cell, stop: e.stop, k: e.k, gain: e.gain, panel: e.panel, t0: performance.now() });
      if (pops.length > 6) pops.shift();
    }
    for (const p of s.play.people) if (p.gold && !knownGold.has(p.id)) { knownGold.add(p.id); banner = { text: '★ GOLDEN PASSENGER ×3', t0: performance.now(), gold: true }; beep([988, 1319, 1568], 0.07, 'triangle', 0.05); }
    if (s.gameOver) hits.flush();
  }
  function onEvent(e: LwEvent): void {
    if (e.what === 'board') bell();
    if (e.what === 'drop') {
      beep([660, 880, 1320, 1760].slice(0, Math.min(4, e.k + 1)), 0.07);
      burst(cx(e.cell), cy(e.cell), 12 + e.k * 10, [stopColor(e.stop), TRAM, CHALK]);
      if (e.k >= 2) banner = { text: e.k >= 4 ? `×${e.k} MEGA CHAIN!` : `×${e.k} CHAIN!`, t0: performance.now(), gold: e.k >= 3 };
      if (!practice) {
        // every rider dropped, not only the first: they are in the log
        const s = shown ?? view;
        for (const t of (s?.play.log ?? []).slice(-e.k)) hits.add(t.panel);
      }
    }
    if (e.what === 'crash') { beep([180, 110, 70], 0.12, 'sawtooth', 0.07); flash = 1; shake = 1; }
    if (e.what === 'gone') beep([300, 220], 0.1, 'triangle', 0.03);
  }
  /** The state shown: the latest one, brought to the estimated server tick by the rules themselves. */
  function catchUp(): void {
    if (!view || mode !== 'play') return;
    const tick = Math.max(view.tick, io.estimatedTick());
    if (shown && tick === nowTick) return;
    if (tick !== nowTick) tickAt = performance.now();
    nowTick = tick;
    shown = tick > view.tick ? engine.advance(view, tick) : view;
    follow(shown);
  }

  /* --------------------------------- drawing -------------------------------- */
  let backdrop: HTMLCanvasElement | null = null;
  /** The town: cobbled streets, houses with terracotta roofs, the river, the depot and the five stops. Drawn once per size. */
  function townBackdrop(): HTMLCanvasElement {
    if (backdrop) return backdrop;
    const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(DPR, DPR);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    const walls = ['#F2E3C6', '#F4C7C3', '#CFE0EA', '#F6E7A8', '#E8E1D5', '#D8E8CF'], roofs = ['#C8553D', '#B5462F', '#D2693C', '#A9442E'];
    for (let cell = 0; cell < CELLS; cell++) {
      const x = xOf(cell) * CELL, y = GY + yOf(cell) * CELL, t = TILE(cell), h = fnv1a(`c${cell}`);
      if (t === 'street') {
        g.fillStyle = STREET; g.fillRect(x, y, CELL, CELL);
        g.fillStyle = 'rgba(11,11,11,.05)';                                         // cobbles
        for (let k = 0; k < 6; k++) g.fillRect(x + ((h >>> (k * 3)) % 24) + 1, y + ((h >>> (k * 2 + 1)) % 24) + 1, 3, 2);
      } else if (t === 'river') {
        g.fillStyle = RIVER; g.fillRect(x, y, CELL, CELL);
        g.fillStyle = 'rgba(242,240,235,.45)'; g.fillRect(x + (h % 12), y + 9, 10, 2); g.fillRect(x + ((h >>> 4) % 12) + 4, y + 18, 8, 2);
      } else {
        g.fillStyle = walls[h % walls.length] as string; g.fillRect(x, y, CELL, CELL);
        g.fillStyle = roofs[(h >>> 3) % roofs.length] as string; g.fillRect(x + 2, y + 2, CELL - 4, CELL - 9);
        g.fillStyle = 'rgba(11,11,11,.18)'; g.fillRect(x + 2, y + CELL - 7, CELL - 4, 2);
        g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 4, y + 4, CELL - 8, 3);
      }
    }
    // the depot
    g.fillStyle = 'rgba(11,11,11,.12)'; g.fillRect(xOf(DEPOT) * CELL + 2, GY + yOf(DEPOT) * CELL + 2, CELL - 4, CELL - 4);
    text('DEPOT', cx(DEPOT), cy(DEPOT) + CELL * 0.75, `500 8px ${F_MONO}`, LABEL, 'center', g);
    text('TEJO', W - 8, GY + (ROWS - 0.5) * CELL, `500 10px ${F_MONO}`, 'rgba(242,240,235,.85)', 'right', g);
    backdrop = c;
    return c;
  }

  /** The stops: a coloured platform with its name; it pulses when riders on board want to get off there. */
  function stops(s: LwState | null, now: number): void {
    const aboard = new Array(STOP_COUNT).fill(0) as number[];
    for (const c of s?.play.cars ?? []) aboard[c.stop] = (aboard[c.stop] as number) + 1;
    STOPS.forEach((stop, i) => {
      const x = cx(stop.cell), y = cy(stop.cell), n = aboard[i] as number;
      if (n) { ctx.strokeStyle = stop.color; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 140); ctx.beginPath(); ctx.arc(x, y, CELL * 0.8 + Math.sin(now / 140) * 3, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillStyle = stop.color; ctx.fillRect(x - CELL / 2 + 1, y - CELL / 2 + 1, CELL - 2, CELL - 2);
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(x - CELL / 2 + 1, y - CELL / 2 + 1, CELL - 2, CELL - 2);
      text(n ? `${n}` : 'T', x, y + 1, `${n ? 16 : 13}px ${F_ANTON}`, CHALK);
      // the name, on a sign beside the stop (inside the grid)
      ctx.font = `500 9px ${F_MONO}`;
      const w = ctx.measureText(stop.name).width + 6, above = yOf(stop.cell) > 0 && TILE(stop.cell - COLS) === 'street';
      const ly = above ? y - CELL / 2 - 7 : y + CELL / 2 + 7, lx = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, x));
      ctx.fillStyle = stop.color; ctx.fillRect(lx - w / 2, ly - 6, w, 12);
      text(stop.name, lx, ly + 0.5, ctx.font, CHALK);
    });
  }
  /** The people waiting: their sprite, the colour of their stop at their feet, their patience as a ring. */
  function people(s: LwState, now: number): void {
    for (const p of s.play.people) {
      const x = cx(p.cell), y = cy(p.cell), left = Math.max(0, Math.min(1, (p.until - nowTick) / (p.gold ? 300 : 440))), urgent = p.until - nowTick < 60;
      if (p.gold) { ctx.fillStyle = `rgba(217,166,46,${(0.3 + 0.2 * Math.sin(now / 110)).toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, CELL * 0.7, 0, Math.PI * 2); ctx.fill(); }
      // the colour of their stop: a disc at their feet and a flag above their head
      ctx.fillStyle = stopColor(p.stop); ctx.beginPath(); ctx.ellipse(x, y + CELL * 0.38, CELL * 0.48, CELL * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(x + CELL * 0.18, y - CELL * 0.62, CELL * 0.3, CELL * 0.2); ctx.fillStyle = INK; ctx.fillRect(x + CELL * 0.16, y - CELL * 0.62, 2, CELL * 0.42);
      ctx.strokeStyle = urgent ? RED : 'rgba(11,11,11,.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, CELL * 0.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, left)); ctx.stroke();
      const jig = urgent ? Math.sin(now / 40 + p.id) * 1.5 : 0;
      drawPerson(ctx, nameOfPanel(p.panel), x - CELL * 0.42 + jig, y - CELL * 0.5, CELL * 0.84, stepAt(now + p.id * 61) % 2, DIR.DOWN);
    }
  }
  function cones(s: LwState, now: number): void {
    for (const c of s.play.cones) {
      const x = cx(c.cell), y = cy(c.cell), fading = c.until - nowTick < 40 && Math.floor(now / 120) % 2 === 0;
      ctx.globalAlpha = fading ? 0.4 : 1;
      ctx.fillStyle = '#F28C28'; ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 9, y + 10); ctx.lineTo(x - 9, y + 10); ctx.closePath(); ctx.fill();
      ctx.fillStyle = CHALK; ctx.fillRect(x - 5, y - 1, 10, 3); ctx.fillStyle = INK; ctx.fillRect(x - 11, y + 9, 22, 3);
      ctx.globalAlpha = 1;
    }
  }
  /** The tram: a yellow head with its lights, then a carriage per rider, their face at the window and their stop's
   *  colour along the side. Each car slides from the cell behind it towards its own, between the server's steps. */
  function tram(s: LwState, now: number): void {
    const play = s.play, stunned = nowTick < play.stunUntil;
    if (stunned && Math.floor(now / 100) % 2 === 0) return;           // blinking back at the depot
    const step = engine.stepAt(s, nowTick), last = play.nextStep - step;
    const frac = stunned || s.gameOver ? 1 : Math.max(0, Math.min(1, (nowTick - last + (performance.now() - tickAt) / TICK_MS) / step));
    const at = (i: number): { x: number; y: number } => {
      const here = play.tram[i] as number, from = (play.tram[i + 1] ?? here) as number;
      return { x: cx(from) + (cx(here) - cx(from)) * frac, y: cy(from) + (cy(here) - cy(from)) * frac };
    };
    // couplers first, under the cars
    ctx.strokeStyle = INK; ctx.lineWidth = 4;
    for (let i = 1; i < play.tram.length; i++) { const a = at(i - 1), b = at(i); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    const r = CELL * 0.44;
    for (let i = play.tram.length - 1; i >= 1; i--) {
      const car = play.cars[i - 1], p = at(i);
      if (!car) continue;
      ctx.fillStyle = car.gold ? GOLD : TRAM; ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(p.x - r, p.y - r, r * 2, r * 2, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = stopColor(car.stop); ctx.fillRect(p.x - r + 2, p.y + r - 6, r * 2 - 4, 4);
      ctx.fillStyle = '#CFE0EA'; ctx.fillRect(p.x - r + 3, p.y - r + 3, r * 2 - 6, r * 1.15);
      drawPerson(ctx, nameOfPanel(car.panel), p.x - r * 0.85, p.y - r - 1, r * 1.7, 0, DIR.DOWN);
    }
    // the head: the driver's car, its lights towards the heading
    const h = at(0), dir = play.dir, [dx, dy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir] as [number, number];
    ctx.fillStyle = TRAM; ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.roundRect(h.x - r - 1, h.y - r - 1, r * 2 + 2, r * 2 + 2, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = TRAM_DARK; ctx.fillRect(h.x - r + 3, h.y - r + 3, r * 2 - 6, r * 2 - 6);
    ctx.fillStyle = CHALK;
    const lx = h.x + dx * (r - 3), ly = h.y + dy * (r - 3);
    ctx.beginPath(); ctx.arc(lx + dy * 6, ly + dx * 6, 3, 0, Math.PI * 2); ctx.arc(lx - dy * 6, ly - dx * 6, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5;                                  // the pantograph
    ctx.beginPath(); ctx.moveTo(h.x - 6, h.y - 4); ctx.lineTo(h.x, h.y - 12 - Math.abs(Math.sin(now / 200)) * 2); ctx.lineTo(h.x + 6, h.y - 4); ctx.stroke();
    text('28', h.x, h.y + 3, `11px ${F_ANTON}`, INK);
    // where the next turn goes
    const next = play.turns[0];
    if (next !== undefined && !stunned) {
      const [tx, ty] = [[0, -1], [1, 0], [0, 1], [-1, 0]][next] as [number, number];
      ctx.fillStyle = BLUE; ctx.beginPath();
      const ax = h.x + tx * (r + 9), ay = h.y + ty * (r + 9);
      ctx.moveTo(ax + tx * 6, ay + ty * 6); ctx.lineTo(ax - ty * 6, ay + tx * 6); ctx.lineTo(ax + ty * 6, ay - tx * 6); ctx.closePath(); ctx.fill();
    }
  }

  /** The bottom panel: how many riders aboard get off at each stop. */
  function aboardPanel(s: LwState | null): void {
    ctx.fillStyle = INK; ctx.fillRect(0, PANEL_Y, W, H - PANEL_Y);
    const aboard = new Array(STOP_COUNT).fill(0) as number[];
    for (const c of s?.play.cars ?? []) aboard[c.stop] = (aboard[c.stop] as number) + 1;
    const total = s?.play.cars.length ?? 0;
    text(total ? `ON BOARD · ${total}` : 'ON BOARD · NOBODY YET', 12, PANEL_Y + 14, `500 10px ${F_MONO}`, '#8C8A84', 'left');
    if (s) text(`${s.play.delivered} DROPPED · BEST CHAIN ×${s.play.bestChain}`, W - 12, PANEL_Y + 14, `500 10px ${F_MONO}`, '#8C8A84', 'right');
    const w = (W - 24 - 4 * 6) / STOP_COUNT, y = PANEL_Y + 28, h = H - y - 40, max = Math.max(...aboard);
    STOPS.forEach((stop, i) => {
      const x = 12 + i * (w + 6), n = aboard[i] as number, lead = n > 0 && n === max;
      ctx.fillStyle = n ? stop.color : '#1C1B19'; ctx.fillRect(x, y, w, h);
      if (lead) { ctx.strokeStyle = TRAM; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h); }
      text(n ? `${n}` : '–', x + w / 2, y + h / 2 - 6, `${n ? 34 : 22}px ${F_ANTON}`, n ? CHALK : '#5A5853');
      ctx.font = fitFont(stop.name, w - 6, 11, F_MONO);
      text(stop.name, x + w / 2, y + h - 12, ctx.font, n ? CHALK : stop.color);
      if (n >= 2) text(`×${n}`, x + w - 4, y + 10, `500 10px ${F_MONO}`, CHALK, 'right');
    });
  }
  function hud(s: LwState | null): void {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, HUD_H);
    if (!s) { text('THE LISBON WAY', W / 2, 48, `38px ${F_ANTON}`, CHALK); return; }
    const end = engine.endTickOf(s), open = engine.openTickOf(s);
    const secs = Math.ceil(Math.max(0, end - Math.max(nowTick, open)) * TICK_MS / 1000);
    const urgent = nowTick >= open && secs <= 10 && !s.gameOver;
    text(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 30, `34px ${F_ANTON}`, urgent ? TRAM : CHALK);
    const done = Math.max(0, Math.min(1, (Math.max(nowTick, open) - open) / RULES.playTicks));
    ctx.fillStyle = '#3A3936'; ctx.fillRect(W / 2 - 50, 54, 100, 4); ctx.fillStyle = urgent ? TRAM : BLUE; ctx.fillRect(W / 2 - 50, 54, 100 * done, 4);
    text(fmtScore(s.play.score), 14, 72, `30px ${F_ANTON}`, CHALK, 'left');
    // the speed: four bars, yellow then red as the end gets near
    const level = RULES.stepStart - engine.stepAt(s, Math.max(nowTick, open)), rush = engine.rushAt(s, nowTick) && !s.gameOver;
    text(rush ? 'FINAL RUSH ×2' : 'SPEED', W - 14 - 4 * 13 - 6, 30, `500 11px ${F_MONO}`, rush ? TRAM : '#B0ACA2', 'right');
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i <= level ? (level >= 3 ? RED : level >= 2 ? '#F28C28' : TRAM) : '#3A3936';
      ctx.fillRect(W - 14 - (4 - i) * 13 + 2, 36 - i * 4, 9, 6 + i * 4);
    }
    text(s.play.crashes ? `${s.play.crashes} CRASH${s.play.crashes > 1 ? 'ES' : ''}` : 'NO CRASH', W - 14, 72, `500 11px ${F_MONO}`, s.play.crashes ? RED : TRAM, 'right');
    if (nowTick >= open && !s.gameOver) {
      const wave = engine.waveAt(s, nowTick);
      if (wave !== lastWave) { if (WAVE_BANNERS[wave]) banner = { text: WAVE_BANNERS[wave] as string, t0: performance.now(), gold: false }; lastWave = wave; }
      if (level > lastLevel) { banner = { text: SPEED_BANNERS[level] as string, t0: performance.now(), gold: level >= 2 }; lastLevel = level; beep([440, 660, 880], 0.06, 'sawtooth', 0.04); }
      if (rush && !rushShown) { rushShown = true; banner = { text: 'FINAL RUSH: EVERY FARE ×2!', t0: performance.now(), gold: true }; beep([523, 659, 784, 1047], 0.08, 'square', 0.05); }
    }
  }
  /** Speed lines at the edges of the town as the tram speeds up; a pulsing gold frame in the final rush. */
  function rushFx(s: LwState, now: number): void {
    if (s.gameOver || nowTick < engine.openTickOf(s)) return;
    const level = RULES.stepStart - engine.stepAt(s, nowTick);
    if (level >= 1) {
      ctx.strokeStyle = 'rgba(11,11,11,.18)'; ctx.lineWidth = 2;
      const n = 4 + level * 4, speed = 2 + level * 2;
      for (let i = 0; i < n; i++) {
        const y = GY + ((i * 97 + now * speed / 8) % (ROWS * CELL)), len = 10 + level * 8, side = i % 2 ? W - 6 : 6;
        ctx.beginPath(); ctx.moveTo(side, y); ctx.lineTo(side, y + len); ctx.stroke();
      }
    }
    if (engine.rushAt(s, nowTick)) {
      ctx.strokeStyle = `rgba(242,194,48,${(0.55 + 0.35 * Math.sin(now / 90)).toFixed(3)})`; ctx.lineWidth = 6;
      ctx.strokeRect(3, GY + 3, W - 6, ROWS * CELL - 6);
    }
  }
  /** One line of help in the first seconds, then whenever there is something to learn. */
  function hint(s: LwState): void {
    const t = nowTick - engine.openTickOf(s);
    if (t < 0 || s.gameOver) return;
    let line = '';
    if (t < 140) line = 'SWIPE · ← ↑ → ↓ · OR TAP A SIDE TO TURN';
    else if (!s.play.cars.length && s.play.delivered === 0) line = 'DRIVE INTO SOMEONE TO PICK THEM UP';
    else if (s.play.delivered === 0) line = 'NOW DRIVE ONTO THE STOP OF THEIR COLOUR';
    else if (s.play.bestChain < 2 && t < 900) line = 'SAME COLOUR TOGETHER = DOUBLE, TRIPLE…';
    if (!line) return;
    // in the HUD, under the clock: never over the town
    ctx.font = fitFont(line, 200, 13, F_ANTON);
    text(line, W / 2, 80, ctx.font, TRAM);
  }
  /** A speech bubble whose tail points down at (x, y). */
  function bubble(say: string, x: number, y: number, loud: boolean, alpha: number): void {
    ctx.globalAlpha = alpha;
    ctx.font = `500 11px ${F_MONO}`;
    const w = Math.min(W - 16, ctx.measureText(say).width + 14), h = 22;
    const bx = Math.max(6, Math.min(W - 6 - w, x - w / 2)), by = Math.max(GY + 2, y - h - 7);
    ctx.fillStyle = loud ? INK : CHALK; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(bx, by, w, h); ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 7); ctx.lineTo(x + 5, by + h); ctx.fill(); ctx.stroke();
    ctx.fillRect(x - 4, by + h - 2, 8, 3);
    text(say, bx + w / 2, by + h / 2 + 1, ctx.font, loud ? CHALK : INK);
    ctx.globalAlpha = 1;
  }
  function popups(now: number): void {
    for (const p of pops) {
      const t = (now - p.t0) / 1300;
      if (t >= 1) continue;
      const x = cx(p.cell), y = cy(p.cell), alpha = 1 - Math.max(0, t - 0.7) / 0.3;
      const loud = p.what === 'crash' || p.what === 'gone';
      if (p.what !== 'board' || fnv1a(`s:${p.seq}`) % 2 === 0) bubble(p.what === 'crash' ? `CRASH! −${p.k * RULES.crashPer}` : pick(SAYS[p.what], `${p.what}:${p.seq}`), x, y - 18 - t * 14, loud, alpha);
      if (p.what === 'drop') { ctx.globalAlpha = alpha; text(`+${fmtScore(p.gain)}`, x, y + 22 - t * 18, `${p.k >= 3 ? 30 : 22}px ${F_ANTON}`, p.k >= 2 ? '#B8860B' : INK); ctx.globalAlpha = 1; }
    }
  }
  function banners(now: number): void {
    if (!banner) return;
    const t = (now - banner.t0) / 1400;
    if (t >= 1) { banner = null; return; }
    const pop = Math.min(1, t * 8);
    ctx.save();
    ctx.globalAlpha = 1 - Math.max(0, t - 0.75) / 0.25;
    ctx.translate(W / 2, GY + 200); ctx.rotate(-0.06); ctx.scale(pop, pop);
    ctx.font = fitFont(banner.text, W - 60, 38, F_ANTON);
    const w = ctx.measureText(banner.text).width + 36;
    ctx.fillStyle = banner.gold ? TRAM : INK; ctx.fillRect(-w / 2, -30, w, 60);
    text(banner.text, 0, 1, ctx.font, banner.gold ? INK : CHALK);
    ctx.restore();
  }
  function countdown(s: LwState): void {
    const left = engine.openTickOf(s) - nowTick;
    if (left <= 0 || s.gameOver) return;
    ctx.fillStyle = 'rgba(222,219,211,.94)'; ctx.fillRect(0, HUD_H, W, PANEL_Y - HUD_H);
    text(String(Math.ceil(left * TICK_MS / 1000)), W / 2, 170, `90px ${F_ANTON}`, BLUE);
    text('STEER THE TRAM', W / 2, 238, `30px ${F_ANTON}`, INK);
    text('SWIPE · ← ↑ → ↓ · OR TAP A SIDE', W / 2, 270, `500 13px ${F_MONO}`, LABEL);
    const rows: [string, string][] = [['1', 'PICK UP the people of the wall'], ['2', 'DROP them at the stop of their COLOUR'], ['3', 'SAME COLOUR TOGETHER = ×2 ×3 ×4']];
    rows.forEach(([k, v], i) => {
      ctx.fillStyle = BLUE; ctx.fillRect(34, 312 + i * 42, 28, 28);
      text(k, 48, 327 + i * 42, `20px ${F_ANTON}`, CHALK);
      text(v, 74, 327 + i * 42, fitFont(v, W - 90, 20, F_ANTON), INK, 'left');
    });
    text('Do not hit houses, roadworks or your own tram.', W / 2, 460, `500 12px ${F_MONO}`, RED);
    text('Faster and faster · the last 15 s pay double!', W / 2, 484, `500 12px ${F_MONO}`, BLUE);
    const n = Math.ceil(left * TICK_MS / 1000);
    if (n !== lastCount) { lastCount = n; beep([440], 0.05, 'sine'); }
  }
  function soundtrack(s: LwState | null): void {
    const open = s ? engine.openTickOf(s) : 0;
    if (!s || mode !== 'play' || s.gameOver || nowTick < open) { music.stop(); return; }
    music.start();
    music.speed(RULES.stepStart - engine.stepAt(s, nowTick));
    const secs = Math.ceil((engine.endTickOf(s) - nowTick) * TICK_MS / 1000);
    if (secs <= 10 && secs !== lastSecond) { lastSecond = secs; beep([secs <= 3 ? 1320 : 990], 0.04, 'square', 0.04); }
  }
  /** The entry: a little tram loops round the town behind the page's own overlay. */
  function idleTram(now: number): void {
    const loop = [DEPOT];
    for (let y = 16; y >= 3; y--) loop.push(y * COLS + 7);
    const i = Math.floor(now / 260) % loop.length, cell = loop[i] as number;
    ctx.fillStyle = TRAM; ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.roundRect(cx(cell) - 12, cy(cell) - 12, 24, 24, 7); ctx.fill(); ctx.stroke();
    text('28', cx(cell), cy(cell) + 2, `11px ${F_ANTON}`, INK);
  }

  function draw(now: number): void {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (mode === 'end') { ctx.fillStyle = CONCRETE; ctx.fillRect(0, 0, W, H); music.stop(); return; }   // the end panel covers the stage
    const s = mode === 'play' ? shown : null;
    soundtrack(s);
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 12 * shake, (Math.random() - 0.5) * 8 * shake);
    ctx.drawImage(townBackdrop(), 0, 0, W * DPR, H * DPR, 0, 0, W, H);
    stops(s, now);
    if (s) {
      cones(s, now);
      people(s, now);
      tram(s, now);
      rushFx(s, now);
      popups(now);
      hint(s);
      aboardPanel(s);
      hud(s);
      banners(now);
      countdown(s);
      if (s.gameOver) {
        ctx.fillStyle = 'rgba(222,219,211,.9)'; ctx.fillRect(0, 280, W, 170);
        text('END OF THE LINE!', W / 2, 336, `48px ${F_ANTON}`, BLUE);
        text(s.play.bonus ? `NO CRASH BONUS +${fmtScore(s.play.bonus)}` : `${s.play.delivered} RIDERS · BEST CHAIN ×${s.play.bestChain}`, W / 2, 396, `500 14px ${F_MONO}`, INK);
      }
    } else {
      idleTram(now);
      aboardPanel(null);
      hud(null);
    }
    for (const b of bits) { ctx.globalAlpha = Math.min(1, b.life); ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.s, b.s * 0.6); }
    ctx.globalAlpha = 1;
    if (flash > 0) { ctx.fillStyle = `rgba(214,69,50,${(flash * 0.25).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }

  /* ------------------------------- end screen ------------------------------- */
  /** The end card, 1080 × 1080, drawn here: the shift, the score, who rode where. */
  function endCard(s: LwState | null, score: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = CONCRETE; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = INK; g.fillRect(0, 0, 1080, 140);
    text('THE LISBON WAY', 60, 72, `74px ${F_ANTON}`, CHALK, 'left', g);
    text(practice ? 'PRACTICE' : 'NFC SUMMIT 2027', 1020, 72, `500 26px ${F_MONO}`, practice ? BLUE : '#B0ACA2', 'right', g);
    const p = s?.play;
    if (p) {
      const t = driverTitle(p);
      text('YOUR DRIVER TITLE', 64, 186, `500 22px ${F_MONO}`, LABEL, 'left', g);
      text(t.title, 58, 250, fitFont(t.title, 960, 88, F_ANTON, g), t.good ? BLUE : RED, 'left', g);
      text(t.line, 64, 318, fitFont(t.line, 960, 26, F_MONO, g), INK, 'left', g);
    }
    g.fillStyle = 'rgba(11,11,11,.12)'; g.fillRect(60, 352, 960, 2);
    text(fmtScore(score), 58, 428, `96px ${F_ANTON}`, INK, 'left', g);
    g.font = `96px ${F_ANTON}`;
    const sw = g.measureText(fmtScore(score)).width;
    const rank = practice ? undefined : rankOf(endStats?.rank);
    text(`POINTS${rank ? ` · #${rank} THIS WEEK` : ''}`, 58 + sw + 24, 446, `500 24px ${F_MONO}`, LABEL, 'left', g);
    if (p) {
      const line = `${p.delivered} DROPPED · BEST CHAIN ×${p.bestChain} · ${p.crashes} CRASH${p.crashes === 1 ? '' : 'ES'}${p.bonus ? ` · BONUS +${fmtScore(p.bonus)}` : ''}`;
      text(line, 60, 492, fitFont(line, 960, 24, F_MONO, g), INK, 'left', g);
      g.fillStyle = INK; g.fillRect(60, 520, 960, 380);
      text('WHO RODE WITH YOU', 84, 546, `500 20px ${F_MONO}`, '#8C8A84', 'left', g);
      const trips = [...p.log].reverse().slice(0, 8);
      if (!trips.length) text('Nobody this time. The tram will wait.', 540, 720, `500 26px ${F_MONO}`, '#8C8A84', 'center', g);
      trips.forEach((trip, i) => {
        const x = 84 + (i % 2) * 480, y = 572 + Math.floor(i / 2) * 80;
        const name = nameOfPanel(trip.panel);
        drawPerson(g, name, x, y, 64, 0, DIR.DOWN);
        text(name, x + 78, y + 20, fitFont(name, 370, 30, F_ANTON, g), CHALK, 'left', g);
        text(`→ ${stopName(trip.stop)}`, x + 78, y + 50, `500 22px ${F_MONO}`, stopColor(trip.stop), 'left', g);
      });
    }
    const player = endStats?.player;                    // an ENS name only: an address says nothing on a card
    if (player && !/^0x[0-9a-f]{40}$/i.test(player)) text(player, 60, 940, `500 26px ${F_MONO}`, INK, 'left', g);
    if (best) text(`${best.isNew ? 'NEW ' : ''}BEST ON THIS DEVICE${practice ? ' (PRACTICE)' : ''}: ${fmtScore(best.best)}`, 1020, 940, `500 22px ${F_MONO}`, best.isNew ? BLUE : LABEL, 'right', g);
    g.fillStyle = INK; g.fillRect(0, 980, 1080, 100);
    text('A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON', 540, 1030, `500 24px ${F_MONO}`, CHALK, 'center', g);
    return c;
  }
  function renderEnd(): void {
    const s = shown ?? view;
    const score = finalScore ?? s?.play.score ?? 0;
    best ??= recordBest(score, practice);
    const card = endCard(s, score);
    card.className = 'end-card';
    card.setAttribute('role', 'img');
    const riders = s ? [...s.play.log].reverse().map((t) => `${nameOfPanel(t.panel)} to ${stopName(t.stop)}`) : [];
    card.setAttribute('aria-label', `Your card: ${score} points, ${s?.play.delivered ?? 0} riders dropped. ${riders.join(', ')}.`);
    const nodes: HTMLElement[] = [card];
    if (!practice && s) {
      const gameUrl = `${location.origin}/`;
      const panels = [...new Set([...s.play.log].reverse().map((t) => t.panel))];
      const tags = panels.map((panel) => tag(SNAPSHOT_NAME.get(panel)?.n ?? nameOfPanel(panel), handleOf(panel))).filter(Boolean);
      const title = driverTitle(s.play).title, delivered = s.play.delivered;
      const tweet = fitTweet(tags, (names, more) => `${title} of THE LISBON WAY: ${score} points, ${delivered} ${delivered === 1 ? 'person' : 'people'} of the wall taken across Lisbon by tram.${names ? ` Thanks for riding: ${names}${more ? ' …' : ''}` : ''} ${gameUrl}`, gameUrl);
      const post = document.createElement('a');
      post.className = 'end-post'; post.target = '_blank'; post.rel = 'noopener';
      post.href = intentHref(tweet); post.textContent = 'Post on X';
      nodes.push(post);
    }
    const wall = document.createElement('a');
    wall.className = 'end-wall'; wall.href = 'https://onthewall.nfcsummit.com'; wall.target = '_blank'; wall.rel = 'noopener';
    wall.textContent = 'get on the wall';
    nodes.push(wall);
    endPanel.replaceChildren(...nodes);
  }

  /* ---------------------------- layout and main loop ------------------------ */
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || W, availH = frameEl.clientHeight || H;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    DPR = canvas.width / W;
    backdrop = null; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { backdrop = null; dirty = true; }).catch(() => undefined);

  let lastFrame = performance.now(), idleT = 0;
  function frame(t: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t;
    if (flash > 0) flash = Math.max(0, flash - dt * 3);
    if (shake > 0.05) shake *= Math.pow(0.02, dt); else shake = 0;
    for (const b of bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 480 * dt; b.life -= dt; }
    if (bits.length) bits = bits.filter((b) => b.life > 0);
    if (mode === 'play') { catchUp(); draw(t); }
    else if (mode === 'idle' && t - idleT > 60) { idleT = t; draw(t); }
    else if (dirty) { draw(t); dirty = false; }
  }
  requestAnimationFrame(frame);

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      if (extra?.idle) { mode = 'idle'; endPanel.hidden = true; return; }
      if (extra && typeof extra.final === 'number') {
        finalScore = extra.final;
        practice = Boolean(extra.practice);
        if (extra.view && typeof extra.view === 'object' && !view) { view = extra.view as LwState; shown = view; }
        mode = 'end';
        hits.flush();
        renderEnd(); endPanel.hidden = false;
      } else if (mode !== 'end') { mode = 'idle'; endPanel.hidden = true; }
    },
    hideRun(): void {
      if (mode !== 'play') return;
      mode = view?.gameOver ? 'end' : 'idle';
      if (mode === 'end') { renderEnd(); endPanel.hidden = false; }
      dirty = true;
    },
    endStats(stats: EndStats): void {
      endStats = stats;
      if (mode === 'end') renderEnd();
    },
    showRun(next: LwState, info): void {
      const nextPractice = Boolean(info.practice);
      if (mode !== 'play' || nextPractice !== practice || (view && view.seed !== next.seed)) {
        reset(nextPractice); mode = 'play'; endPanel.hidden = true;
      }
      if (next !== view) { view = next; shown = null; nowTick = -1; }
      catchUp();
    },
  };
}

export const lisbonWayAdapter: GameAdapter = {
  id: 'the-lisbon-way',
  title: 'THE LISBON WAY',
  heading: 'Drive the tram of the wall',
  tagline: 'Drive Lisbon\'s yellow tram: pick up the people of the wall, drop them at the stop of their colour. 90 seconds.',
  lede: 'You drive Lisbon\'s yellow tram through a grid of streets seen from above, for 90 seconds. It never stops: steer it with the arrow keys (or W A S D), a swipe, or a tap on the side you want to turn to. Drive into someone to pick them up: they hook on as a new carriage, their face at the window and the colour of their stop along the side. Drive onto a stop and everyone of that colour gets off at once: riders dropped together pay more (2 together ×2 each, 3 together ×3 each…), so it pays to collect the same colour. ★ golden passengers pay triple. Do not hit the houses, the river, roadworks or your own tram: the riders get off and you start again from the depot. The tram gets faster and faster as the end gets near, and the last 15 seconds pay double (FINAL RUSH); a shift with no crash pays +1000. One credit per shift, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: LwState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: LwState) => state.play.score,
  statusLine(state: LwState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated shift…';
    const open = engine.openTickOf(state);
    if (tick < open) return `The tram leaves in ${Math.ceil((open - tick) * TICK_MS / 1000)}`;
    const left = Math.max(0, engine.endTickOf(state) - tick) * TICK_MS / 1000;
    return `Score ${state.play.score} · ${state.play.cars.length} on board · ${Math.ceil(left)} s left`;
  },
  createStage,
  diagSummary: (s: LwState) => ({ tick: s.tick, started: s.started, startTick: s.startTick, gameOver: s.gameOver, score: s.play.score, dir: s.play.dir, turns: s.play.turns, head: s.play.tram[0], cars: s.play.cars.length, people: s.play.people.length, last: s.play.events.at(-1) ?? null }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('the-lisbon-way')),
    advance: (state: LwState, tick: number) => engine.advance(state, tick),
  },
};
