// THE LISBON WAY: the browser side. The page draws Lisbon from above (in 3D, or on a flat map) with the platform's
// authoritative state (the player's own queued inputs applied by the very module the verifier runs, then brought to "now"
// by that same module) and turns a gesture into ONE ordered input: { action: 'route', path: [next place] } or
// { action: 'boost' }. It never sends a score, a time or a state: who got picked up, who was delivered and what it is
// worth is decided by the rules on SuperRare's server.
//
// Steering (controls.ts): an arrow key, a swipe or a tap gives a direction; the taxi takes the street that points that
// way at the next corner, and goes straight on by itself where a street continues straight. The people are the people of
// the wall: their walking sprite (people.json) when they made one, a pixel stand-in otherwise. Sprites, bubbles, sounds
// and the end card are display only.
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
  EDGE, LENGTH, N, NEIGHBOURS, PLACES, speedOn, RULES, STREETS, engine, inputSchema, satisfaction, snapshotSchema, stateSchema,
  type Fare, type LwEvent, type LwState, type Play, type What,
} from './engine.js';
import { carOf, createScene3D, wx, wz, type Car, type Scene3D } from './scene3d.js';
import { BOOST_KEYS, KEY_ANGLE, pickStreet, straightOn, swipeAngle, type Way } from './controls.js';

/** Defined (true) only in dev builds (scripts/dev-flow.ts): never in a published archive. */
declare const __DEV_ANY_ORIGIN__: boolean | undefined;

const W = 420, H = 800, TICK_MS = 50;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', BLUE = '#2E7FD6', LABEL = '#6B685F', FAINT = '#CFCBC1';
const TRAM = '#F2C230', RED = '#D64532', RIVER = '#2E7FD6', TAXI_GREEN = '#3E8E5A', CREAM = '#F4E9CF';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const HUD_H = 96, MX = 10, MY = 124, RIVER_Y = MY + 444, PANEL_Y = 606;
const PIN = 9, PERSON = 26;
const SHORT = ['MARQUÊS', 'NFC', 'P. REAL', 'ROSSIO', 'GRAÇA', 'ESTRELA', 'B. ALTO', 'ALFAMA', 'CHIADO', 'LX', 'CAIS', 'BAIXA', 'S. APOL.', 'BELÉM'];
const SNAPSHOT_NAME = new Map(WALL_PANELS.map((p) => [p.p, p]));
const nameOfPanel = (panel: number): string => (infoOf(panel).name || SNAPSHOT_NAME.get(panel)?.n || '').toUpperCase();
const handleOf = (panel: number): string => infoOf(panel).handle;   // the live wall's X handle, when known
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const placeX = (p: number): number => MX + (PLACES[p]?.x ?? 0);
const placeY = (p: number): number => MY + (PLACES[p]?.y ?? 0);
const colorOf = (p: number): string => PLACES[p]?.color ?? INK;
const pick = <T,>(list: readonly T[], key: string): T => list[fnv1a(key) % list.length] as T;
/** "#3" -> 3; "—" or "Not top 10" -> undefined (the page's rank of this run in the week). */
const rankOf = (rank: string | undefined): number | undefined => { const m = rank ? /^#(\d+)$/.exec(rank) : null; return m ? Number(m[1]) : undefined; };
const stars = (rate: number): number => (rate >= 90 ? 5 : rate >= 75 ? 4 : rate >= 50 ? 3 : rate >= 25 ? 2 : 1);

/** What a passenger says (display only, picked from the event number). */
const SAYS: Record<What, readonly string[]> = {
  board: [],                                         // their wish, from the destination
  via: ['ONE SEC!', 'GOT IT, GO GO', 'PHOTO STOP!'],
  drop: ['OBRIGADO!', 'GM!', 'WAGMI', 'BEST TAXI EVER', 'KEEP THE CHANGE'],
  gaveup: ["I'LL TAKE THE TRAM", 'FORGET IT', 'UBER IT IS'],
  jumped: ['LET ME OUT!', "I'LL WALK!", 'TOO SLOW!', 'NGMI'],
};
const WAVE_BANNERS = ['SHIFT STARTS!', 'EXPRESS FARES ⚡', 'MORE TRAFFIC', 'TWO-STOP TOURS', 'RUSH HOUR!', 'LAST FARES!'];
const COMBO_BANNERS = ['', '', '×2 NICE DRIVING', '×3 ON FIRE', '×4 LEGEND OF LISBON'];

type Mode = 'idle' | 'play' | 'end';
type Pop = { seq: number; what: What; place: number; panel: number; gain: number; kind: Fare['kind']; t0: number; late: boolean };
type Bit = { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number };

/** The end card's title: what kind of taxi driver this shift made you (display only). */
export function driverTitle(play: Play): { title: string; line: string; good: boolean } {
  const rate = satisfaction(play);
  if (play.delivered >= RULES.bonusMin && rate >= 90) return { title: 'LEGEND OF LISBON', line: `${play.delivered} rides, ${rate}% happy. Obrigado!`, good: true };
  if (play.jumped >= 5) return { title: 'THE ESCAPE ARTIST', line: `${play.jumped} passengers jumped out on the way.`, good: false };
  if (play.gaveUp >= 8) return { title: 'LOST IN ALFAMA', line: `${play.gaveUp} people gave up and took the tram.`, good: false };
  if (play.delivered >= RULES.bonusMin && rate >= 75) return { title: 'MASTER OF THE HILLS', line: `${play.delivered} rides, ${rate}% happy.`, good: true };
  if (play.bestCombo >= 8) return { title: 'COMBO CABBIE', line: `${play.bestCombo} deliveries in a row.`, good: true };
  if (play.delivered >= RULES.bonusMin && rate >= 50) return { title: 'SOLID CABBIE', line: `${play.delivered} rides around Lisbon.`, good: true };
  return { title: 'ROOKIE DRIVER', line: `${play.delivered} ${play.delivered === 1 ? 'ride' : 'rides'}. The hills will wait for you.`, good: false };
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
  const r = (cx: number, cy: number, w: number, hh: number, c: string): void => { g.fillStyle = c; g.fillRect(Math.round(x + cx * px), Math.round(y + cy * px), Math.ceil(w * px), Math.ceil(hh * px)); };
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
const SOUNDS: Record<What, () => void> = {
  board: () => beep([520, 780], 0.05, 'triangle', 0.04),
  via: () => beep([660], 0.05, 'triangle', 0.03),
  drop: () => beep([660, 880, 1320], 0.06),
  gaveup: () => beep([300, 220], 0.12, 'sawtooth', 0.04),
  jumped: () => beep([200, 130], 0.15, 'sawtooth', 0.06),
};
const honk = (): void => beep([392, 392], 0.06, 'square', 0.04);

/** A little procedural tune for the shift (display only): A minor, faster in the rush. Off with the sound. */
class Music {
  private timer: number | undefined;
  private step = 0;
  private fast = false;
  private readonly bass = [110, 110, 130.8, 98, 110, 110, 146.8, 130.8];
  private readonly lead = [440, 523.3, 659.3, 587.3, 523.3, 440, 392, 440, 523.3, 659.3, 784, 659.3, 587.3, 523.3, 493.9, 440];
  start(): void { if (this.timer === undefined) this.loop(); }
  stop(): void { window.clearTimeout(this.timer); this.timer = undefined; this.step = 0; this.fast = false; }
  rush(on: boolean): void { this.fast = on; }
  private loop(): void {
    const ms = this.fast ? 105 : 140;
    if (soundOn) {
      if (this.step % 2 === 0) beep([this.bass[(this.step / 2) % this.bass.length] as number], ms / 1000 * 1.6, 'triangle', 0.05);
      if (this.step % 4 === 1 || (this.fast && this.step % 2 === 1)) beep([this.lead[(this.step >> 1) % this.lead.length] as number], 0.07, 'square', 0.012);
    }
    this.step++;
    this.timer = window.setTimeout(() => this.loop(), ms);
  }
}
const GOLD = '#D9A62E';

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('lw-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas lw-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'THE LISBON WAY. A map of Lisbon seen from above, 14 places joined by streets. Steer the taxi with the arrow keys, a swipe or a tap towards a direction: it turns that way at the next corner. Space fires a turbo. Pick up the people of the wall and drive them where they ask, before they lose patience. Red streets are traffic jams.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  const label = (): void => { soundButton.textContent = soundOn ? 'Sound on' : 'Sound off'; };
  label();
  soundButton.addEventListener('click', () => { soundOn = !soundOn; label(); try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* storage unavailable */ } });
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your shift');
  // the 3D map, behind the 2D canvas (which keeps the HUD, the seats and the labels): WebGL2 where the device has it,
  // the 2D map otherwise, and a button to choose
  const gl = document.createElement('canvas');
  gl.className = 'lw-gl';
  gl.setAttribute('aria-hidden', 'true');
  gl.style.cssText = `position:absolute;left:0;width:100%;top:${(HUD_H / H) * 100}%;height:${((PANEL_Y - HUD_H) / H) * 100}%;pointer-events:none;`;
  canvas.style.position = 'relative'; canvas.style.zIndex = '1'; canvas.style.background = 'transparent';   // the 3D map shows through
  const viewButton = document.createElement('button');
  viewButton.type = 'button'; viewButton.className = 'ub-sound secondary';
  viewButton.style.right = 'auto'; viewButton.style.left = '6px'; viewButton.style.zIndex = '2';
  // both controls readable over the dark seats panel
  for (const b of [soundButton, viewButton]) { b.style.background = CHALK; b.style.color = INK; b.style.border = `1px solid ${INK}`; }
  host.append(gl, canvas, endPanel, soundButton, viewButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  /** Seen from above, always: in 3D (three.js, WebGL2) or on the flat 2D map (the fallback, or the player's choice). */
  type View = '3d' | '2d';
  const VIEW_KEY = 'the-lisbon-way:view';
  let viewMode: View = (() => { try { return localStorage.getItem(VIEW_KEY) === '2d' ? '2d' : '3d'; } catch { return '3d'; } })();
  let scene: Scene3D | null = null, glUnavailable = false;
  /** 3D when asked and possible; the flat map otherwise (no WebGL2, a lost context, a device too slow). */
  function setView(next: View): void {
    if (next === '3d' && !scene && !glUnavailable) {
      try { scene = createScene3D(gl, drawPerson); } catch { scene = null; }
      if (!scene) glUnavailable = true;
    }
    if (scene?.failed) { scene.dispose(); scene = null; glUnavailable = true; }
    viewMode = next === '3d' && scene ? '3d' : '2d';
    gl.style.display = viewMode === '3d' ? 'block' : 'none';
    viewButton.hidden = glUnavailable;
    viewButton.textContent = viewMode === '3d' ? 'View: 3D' : 'View: 2D';
    viewButton.setAttribute('aria-label', `${viewButton.textContent}. Tap to change the view.`);
    backdrop = null; dirty = true;
    if (scene) resizeScene();
  }
  const in3d = (): boolean => viewMode === '3d' && scene !== null && !scene.failed;
  viewButton.addEventListener('click', () => {
    setView(viewMode === '3d' ? '2d' : '3d');
    try { localStorage.setItem(VIEW_KEY, viewMode); } catch { /* storage unavailable */ }
  });
  void loadPeople();
  onPeople(() => { dirty = true; scene?.refreshPeople(); });

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
  let ripple: { place: number; t0: number; ok: boolean } | null = null;
  let lastWave = -2, lastCombo = 0, lastCount = -1, flash = 0;
  let endStats: EndStats | null = null;
  let best: { best: number; isNew: boolean } | null = null;
  let dirty = true, DPR = 1;
  let hits = new HitFeed('the-lisbon-way', false);
  let shake = 0, lastSecond = -1;
  let knownFares = new Set<number>();
  let riderClock = new Map<number, { until: number; span: number }>();   // panel -> the ride's clock, for JUST IN TIME
  const music = new Music();

  function reset(isPractice: boolean): void {
    view = null; shown = null; nowTick = 0; seen = new Map(); pops = []; bits = []; banner = null; ripple = null;
    lastWave = -2; lastCombo = 0; lastCount = -1; flash = 0;
    finalScore = null; endStats = null; best = null; practice = isPractice;
    hits = new HitFeed('the-lisbon-way', isPractice ? false : undefined);
    shake = 0; lastSecond = -1; knownFares = new Set(); riderClock = new Map();
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

  /* ------------------------------- positions -------------------------------- */
  type Spot = { x: number; y: number; visible: boolean };
  /** A world point of the 3D map on this canvas (logical px). */
  function screen3d(x: number, y: number, z: number): Spot {
    const q = (scene as Scene3D).project(x, y, z);
    const at = { x: q.x * W, y: HUD_H + q.y * (PANEL_Y - HUD_H) };
    return { ...at, visible: q.visible && at.x > -20 && at.x < W + 20 && at.y > HUD_H && at.y < PANEL_Y };
  }
  /** A point of the map (map px) on screen, in either view. */
  function mapPoint(x: number, y: number, height = 0): Spot {
    return in3d() ? screen3d(wx(x), height, wz(y)) : { x: MX + x, y: MY + y, visible: true };
  }
  /** Where a place is on screen (its pin). */
  const posOf = (p: number, height = 1.4): Spot => mapPoint(PLACES[p]?.x ?? 0, PLACES[p]?.y ?? 0, in3d() ? height : 0);
  let carNow: Car = { x: PLACES[RULES.start]?.x ?? 0, z: PLACES[RULES.start]?.y ?? 0, angle: null };   // the taxi as drawn (map px)

  /* -------------------------------- input ----------------------------------- */
  // One gesture, one direction: an arrow key (W A S D), a swipe, or a tap towards where you want to go. The taxi takes the
  // street that points that way at the NEXT corner (the place it is at, or driving to); with no new direction it goes
  // straight on where a street continues straight. Space (or the TURBO button) fires a turbo.
  /** The place the taxi is at, or driving to: where the next turn happens. */
  const anchorOf = (s: LwState): number => (s.play.taxi.to >= 0 ? s.play.taxi.to : s.play.taxi.at);
  /** The streets out of the next corner, with their direction on screen (so "up" is up in both views). */
  function waysOf(s: LwState): Way[] {
    const anchor = anchorOf(s), a = posOf(anchor, 0);
    return (NEIGHBOURS[anchor] as number[]).map((n) => { const b = posOf(n, 0); return { place: n, angle: Math.atan2(b.y - a.y, b.x - a.x) }; });
  }
  const canSteer = (): boolean => mode === 'play' && shown !== null && !shown.gameOver && io.canInput() && nowTick >= engine.openTickOf(shown);
  let nope = 0;                                        // a direction with no street: the corner hint shakes
  function steer(angle: number): void {
    if (!canSteer() || !shown) return;
    const place = pickStreet(waysOf(shown), angle);
    if (place === null) { nope = performance.now(); beep([150], 0.06, 'square', 0.03); return; }
    autoFor = '';                                      // the player decided: no straight-on guess for this corner
    if (shown.play.taxi.route.length === 1 && shown.play.taxi.route[0] === place) return;
    ripple = { place, t0: performance.now(), ok: true };
    honk();
    io.sendInput({ action: 'route', path: [place] });
  }
  function boost(): void {
    if (!canSteer() || !shown) return;
    if (shown.play.boosts <= 0 || nowTick < shown.play.boostUntil) { beep([150], 0.06, 'square', 0.03); return; }
    beep([330, 660, 990], 0.05, 'sawtooth', 0.05);
    io.sendInput({ action: 'boost' });
  }
  /** Straight on at the next corner when the player chose nothing (once per street driven). */
  let autoFor = '';
  function autoStraight(s: LwState): void {
    const t = s.play.taxi;
    if (!canSteer() || t.to < 0 || t.route.length) return;
    const key = `${s.play.taxi.at}>${t.to}`;
    if (autoFor === key) return;
    autoFor = key;
    const from = posOf(t.at, 0), to = posOf(t.to, 0);
    const place = straightOn(waysOf(s), Math.atan2(to.y - from.y, to.x - from.x), t.at);
    if (place !== null) io.sendInput({ action: 'route', path: [place] });
  }
  /** The TURBO button, bottom right of the map. */
  const TURBO = { x: W - 46, y: PANEL_Y - 48, r: 34 };
  const onTurbo = (x: number, y: number): boolean => Math.hypot(x - TURBO.x, y - TURBO.y) <= TURBO.r + 6;
  const toCanvas = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  };
  let press: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play') return;
    const at = toCanvas(e);
    if (at.y < HUD_H || at.y > PANEL_Y) return;
    e.preventDefault();
    if (onTurbo(at.x, at.y)) { boost(); return; }
    press = { ...at, id: e.pointerId };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const at = toCanvas(e), start = press;
    press = null;
    const swipe = swipeAngle(at.x - start.x, at.y - start.y);
    if (swipe !== null) { steer(swipe); return; }
    // a tap: the direction from the taxi to the finger
    const car = mapPoint(carNow.x, carNow.z, 0.6);
    steer(Math.atan2(at.y - car.y, at.x - car.x));
  });
  canvas.addEventListener('pointercancel', () => { press = null; });
  window.addEventListener('keydown', (e) => {
    if (mode !== 'play') return;
    const angle = KEY_ANGLE[e.code];
    if (angle !== undefined) { e.preventDefault(); if (!e.repeat) steer(angle); return; }
    if (BOOST_KEYS.has(e.code)) { e.preventDefault(); if (!e.repeat) boost(); }
  });

  // dev builds only: steer and boost from an automated driver
  if (typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__) {
    Object.assign(window as object, { __lwSteerTo: (p: number) => { if (shown) { const w = waysOf(shown).find((x) => x.place === p); if (w) steer(w.angle); } }, __lwBoost: boost });
  }

  /* ------------------------------ state follow ------------------------------ */
  function burst(x: number, y: number, count: number, colors = [TRAM, BLUE, CHALK, RED, TAXI_GREEN]): void {
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
      if (before === undefined) onEvent(e, s);
      pops = pops.filter((p) => p.seq !== e.seq);
      const clock = riderClock.get(e.panel);
      const late = e.what === 'drop' && clock !== undefined && (clock.until - e.tick) * 5 < clock.span;   // the last fifth of the ride
      pops.push({ seq: e.seq, what: e.what, place: e.place, panel: e.panel, gain: e.gain, kind: e.kind, t0: performance.now(), late });
      if (pops.length > 6) pops.shift();
    }
    for (const f of s.play.waiting) {
      if (knownFares.has(f.id)) continue;
      knownFares.add(f.id);
      if (f.kind === 'gold') { banner = { text: '★ GOLDEN PASSENGER!', t0: performance.now(), gold: true }; beep([988, 1319, 1568], 0.07, 'triangle', 0.05); }
    }
    riderClock = new Map(s.play.riders.map((f) => [f.panel, { until: f.until, span: f.span }]));
    if (s.gameOver) hits.flush();
  }
  function onEvent(e: LwEvent, s: LwState): void {
    SOUNDS[e.what]();
    if (e.what === 'drop') {
      const at = posOf(e.place);
      burst(at.x, at.y, e.kind === 'gold' ? 60 : e.kind === 'express' ? 30 : 18, e.kind === 'gold' ? [GOLD, TRAM, CHALK, GOLD] : [colorOf(e.place), TRAM, CHALK]);
      if (!practice) hits.add(e.panel);
      const step = engine.multOf(s.play.combo);
      if (step > lastCombo && step >= 2 && step < COMBO_BANNERS.length) { banner = { text: COMBO_BANNERS[step] as string, t0: performance.now(), gold: true }; burst(W / 2, 330, 30); }
      lastCombo = step;
    }
    if (e.what === 'drop' && e.kind === 'gold') { banner = { text: `GOLDEN FARE +${e.gain}!`, t0: performance.now(), gold: true }; beep([784, 988, 1175, 1568], 0.08, 'square', 0.05); }
    if (e.what === 'gaveup' || e.what === 'jumped') { flash = 1; shake = 1; lastCombo = 1; }
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
  /** Concrete, the names of the wall in watermark, the hills, the river and its bridge: drawn once per size. */
  function mapBackdrop(): HTMLCanvasElement {
    if (backdrop) return backdrop;
    const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(DPR, DPR);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    const names = WALL_PANELS.map((p) => p.n.toUpperCase());
    g.font = `10px ${F_ANTON}`; g.fillStyle = FAINT; g.textBaseline = 'top';
    let i = 0;
    for (let y = HUD_H + 4; y < RIVER_Y - 8; y += 15) {
      let x = -((y * 7) % 50);
      while (x < W) { const n = names[i++ % names.length] as string; g.fillText(n, x, y); x += g.measureText(n).width + 12; }
    }
    // the seven hills, soft
    for (const [hx, hy, hr] of [[110, 120, 70], [330, 160, 60], [130, 230, 55], [40, 190, 50], [230, 150, 45], [320, 270, 50], [200, 40, 60]] as const) {
      const grad = g.createRadialGradient(MX + hx, MY + hy, 4, MX + hx, MY + hy, hr);
      grad.addColorStop(0, 'rgba(176,160,130,.28)'); grad.addColorStop(1, 'rgba(176,160,130,0)');
      g.fillStyle = grad; g.beginPath(); g.arc(MX + hx, MY + hy, hr, 0, Math.PI * 2); g.fill();
    }
    // the Tagus
    g.fillStyle = RIVER; g.fillRect(0, RIVER_Y, W, PANEL_Y - RIVER_Y);
    g.fillStyle = 'rgba(242,240,235,.35)';
    for (let y = RIVER_Y + 8; y < PANEL_Y - 4; y += 10) for (let x = (y * 13) % 30; x < W; x += 30) g.fillRect(x, y, 12, 2);
    // the red bridge, on the left
    g.strokeStyle = '#C2352B'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(MX + 42, RIVER_Y - 18); g.lineTo(MX + 42, PANEL_Y); g.moveTo(MX + 0, RIVER_Y + 6); g.lineTo(MX + 100, RIVER_Y + 6); g.stroke();
    g.lineWidth = 1.5; g.beginPath(); g.moveTo(MX - 10, RIVER_Y + 4); g.quadraticCurveTo(MX + 42, RIVER_Y + 34, MX + 110, RIVER_Y + 4); g.stroke();
    text('TEJO', W - 14, PANEL_Y - 16, `500 10px ${F_MONO}`, 'rgba(242,240,235,.8)', 'right', g);
    backdrop = c;
    return c;
  }

  function street(a: number, b: number, color: string, width: number, dash: number[] = []): void {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(placeX(a), placeY(a)); ctx.lineTo(placeX(b), placeY(b)); ctx.stroke();
    ctx.setLineDash([]);
  }
  function streets(s: LwState | null, now: number): void {
    for (const [a, b] of STREETS) street(a, b, INK, 12);
    for (const [a, b] of STREETS) street(a, b, CHALK, 8);
    if (!s) return;
    for (const j of s.play.jams) {
      const [a, b] = STREETS[j.edge] as readonly [number, number];
      const left = j.until - nowTick;
      ctx.globalAlpha = left < 20 ? 0.4 + 0.3 * Math.sin(now / 60) : 1;
      street(a, b, RED, 8);
      // the cars in the jam
      const x0 = placeX(a), y0 = placeY(a), x1 = placeX(b), y1 = placeY(b), len = Math.hypot(x1 - x0, y1 - y0);
      for (let k = 1; k * 16 < len - 10; k++) {
        const f = (k * 16) / len, wob = Math.sin(now / 200 + k) * 1.2;
        ctx.fillStyle = [TRAM, CHALK, INK][k % 3] as string;
        ctx.fillRect(x0 + (x1 - x0) * f - 3 + wob, y0 + (y1 - y0) * f - 2, 6, 4);
      }
      ctx.globalAlpha = 1;
    }
    // the planned route, from the taxi
    const t = s.play.taxi;
    let from = t.to >= 0 ? t.to : t.at;
    if (t.to >= 0) street(t.at, t.to, BLUE, 4, [6, 5]);
    ctx.lineDashOffset = -now / 40;
    for (const p of t.route) { street(from, p, BLUE, 4, [6, 5]); from = p; }
    ctx.lineDashOffset = 0;
  }

  function pins(s: LwState | null, now: number): void {
    const wanted = new Map<number, 'drop' | 'via'>();
    // where the riders go next: a tour's FIRST place (dashed) until it is reached, then the destination
    if (s) for (const f of s.play.riders) { if (f.via < 0) wanted.set(f.to, 'drop'); else if (!wanted.has(f.via)) wanted.set(f.via, 'via'); }
    for (let p = 0; p < N; p++) {
      const x = placeX(p), y = placeY(p), want = wanted.get(p);
      if (want) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 150);
        ctx.strokeStyle = colorOf(p); ctx.lineWidth = want === 'drop' ? 4 : 2; ctx.setLineDash(want === 'via' ? [4, 3] : []);
        ctx.beginPath(); ctx.arc(x, y, PIN + 6 + pulse * 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y, PIN + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colorOf(p); ctx.beginPath(); ctx.arc(x, y, PIN, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CHALK; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      const name = PLACES[p]?.name ?? '';
      ctx.font = `500 9px ${F_MONO}`;
      const w = ctx.measureText(name).width + 6, ly = y + PIN + 9;
      const lx = Math.max(2 + w / 2, Math.min(W - 2 - w / 2, x));
      ctx.fillStyle = want === 'drop' ? colorOf(p) : 'rgba(242,240,235,.92)'; ctx.fillRect(lx - w / 2, ly - 6, w, 12);
      text(name, lx, ly + 0.5, ctx.font, want === 'drop' ? CHALK : INK);
    }
  }
  /** The blue circle where the player just tapped. */
  function rippleFx(now: number): void {
    if (!ripple) return;
    const t = (now - ripple.t0) / 450;
    if (t >= 1) { ripple = null; return; }
    const at = posOf(ripple.place, 0.2);
    ctx.strokeStyle = BLUE; ctx.lineWidth = 3; ctx.globalAlpha = 1 - t;
    ctx.beginPath(); ctx.arc(at.x, at.y, PIN + 6 + t * 26, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  }
  /** 3D view: the places' names under their pins, coloured when a rider wants to go there. */
  function labels3d(s: LwState | null): void {
    const want = new Set<number>();
    for (const f of s?.play.riders ?? []) want.add(f.via >= 0 ? f.via : f.to);
    for (let p = 0; p < N; p++) {
      const at = posOf(p, 0), name = PLACES[p]?.name ?? '', on = want.has(p);
      ctx.font = `500 9px ${F_MONO}`;
      const w = ctx.measureText(name).width + 6, ly = at.y + 14;
      const lx = Math.max(2 + w / 2, Math.min(W - 2 - w / 2, at.x));
      ctx.fillStyle = on ? colorOf(p) : 'rgba(242,240,235,.88)'; ctx.fillRect(lx - w / 2, ly - 6, w, 12);
      text(name, lx, ly + 0.5, ctx.font, on ? CHALK : INK);
    }
  }
  /** The people waiting, by place, in the order both views draw them. */
  function waitingByPlace(s: LwState): Map<number, Fare[]> {
    const byPlace = new Map<number, Fare[]>();
    for (const f of s.play.waiting) byPlace.set(f.from, [...(byPlace.get(f.from) ?? []), f]);
    return byPlace;
  }
  /** A waiting passenger's patience ring and request tag (the 3D view draws the sprite itself). */
  function patienceAndTag(f: Fare, x: number, cy: number, r: number, tagY: number): void {
    const left = Math.max(0, Math.min(1, (f.until - nowTick) / f.span)), urgent = left < 0.3;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(11,11,11,.18)';
    ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = urgent ? RED : f.kind === 'gold' ? GOLD : TAXI_GREEN;
    ctx.beginPath(); ctx.arc(x, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
    const label = `${f.kind === 'express' ? '⚡' : f.kind === 'gold' ? '★' : ''}${SHORT[f.to]}${f.kind === 'tour' && f.via >= 0 ? '+' : ''}`;
    ctx.font = `500 8px ${F_MONO}`;
    const w = ctx.measureText(label).width + 6;
    ctx.fillStyle = colorOf(f.to); ctx.fillRect(x - w / 2, tagY - 6, w, 11);
    if (f.kind === 'express' || f.kind === 'gold') { ctx.strokeStyle = f.kind === 'gold' ? GOLD : TRAM; ctx.lineWidth = 2; ctx.strokeRect(x - w / 2, tagY - 6, w, 11); }
    text(label, x, tagY, ctx.font, CHALK);
  }
  function waiting3d(s: LwState, now: number): void {
    for (const [p, list] of waitingByPlace(s)) {
      const place = PLACES[p] as { x: number; y: number };
      list.forEach((f, i) => {
        const x3 = wx(place.x) + (list.length > 1 ? (i ? 1.3 : -1.3) : 0), z3 = wz(place.y);
        const feet = screen3d(x3, 1.45, z3), head = screen3d(x3, 1.45 + 2.6, z3);
        if (!feet.visible || !head.visible || feet.y - head.y < 6) return;      // off the map band, or too small to read
        const r = Math.max(8, Math.min(60, (feet.y - head.y) / 2 + 3));
        if (f.kind === 'gold') {                                                   // a golden passenger shines
          ctx.fillStyle = `rgba(217,166,46,${(0.25 + 0.15 * Math.sin(now / 120)).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(head.x, (feet.y + head.y) / 2, r + 6, 0, Math.PI * 2); ctx.fill();
        }
        patienceAndTag(f, head.x, (feet.y + head.y) / 2, r, head.y - 9);
      });
    }
  }

  /** People waiting at a place: their sprite, their patience as a ring, where they want to go. */
  function waitingPeople(s: LwState, now: number): void {
    for (const [p, list] of waitingByPlace(s)) {
      list.forEach((f, i) => {
        const x = placeX(p) + (list.length > 1 ? (i ? 15 : -15) : 0), feet = placeY(p) - PIN - 3;
        const urgent = f.until - nowTick < f.span * 0.3;
        patienceAndTag(f, x, feet - PERSON / 2, PERSON / 2 + 3, feet - PERSON - 8);
        const jig = urgent ? Math.sin(now / 40 + f.id) * 1.5 : 0;
        drawPerson(ctx, nameOfPanel(f.panel), x - PERSON / 2 + jig, feet - PERSON, PERSON, stepAt(now + f.id * 61) % 2, DIR.DOWN);
      });
    }
  }

  /** The taxi: a black cab with a green roof, between the two places of its street (interpolated between ticks). */
  function taxiAt(s: LwState, frac: number): { x: number; y: number; angle: number } {
    const t = s.play.taxi;
    if (t.to < 0) return { x: placeX(t.at), y: placeY(t.at), angle: 0 };
    const edge = (EDGE[t.at] as number[])[t.to] as number, len = LENGTH[edge] as number;
    const speed = speedOn(t.at, t.to, engine.jammed(s.play, edge), s.tick < s.play.boostUntil);
    const f = Math.min(1, (t.pos + (s.gameOver ? 0 : speed * frac)) / len);
    const x0 = placeX(t.at), y0 = placeY(t.at), x1 = placeX(t.to), y1 = placeY(t.to);
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, angle: Math.atan2(y1 - y0, x1 - x0) };
  }
  function drawTaxi(x: number, y: number, angle: number, riders: number, g: CanvasRenderingContext2D = ctx, scale = 1, boosting = false): void {
    g.save();
    g.translate(x, y); g.rotate(angle); g.scale(scale, scale);
    g.fillStyle = 'rgba(11,11,11,.25)'; g.fillRect(-15, -7, 32, 17);
    g.fillStyle = INK; g.fillRect(-16, -9, 32, 18);
    g.fillStyle = TAXI_GREEN; g.fillRect(-7, -7, 14, 14);
    g.fillStyle = TRAM; g.fillRect(-3, -5, 6, 10);                                   // the TAXI light
    g.fillStyle = CREAM; g.fillRect(12, -8, 3, 4); g.fillRect(12, 4, 3, 4);           // headlights
    g.fillStyle = RED; g.fillRect(-16, -8, 2, 4); g.fillRect(-16, 4, 2, 4);
    for (let k = 0; k < riders; k++) { g.fillStyle = [BLUE, '#E86A92', '#D9A62E'][k] as string; g.fillRect(-13, -7 + k * 5, 4, 4); }   // heads on the back seat
    if (boosting) { for (let k = 0; k < 3; k++) { g.fillStyle = [TRAM, '#F28C28', RED][k] as string; g.fillRect(-24 - k * 7 - Math.random() * 4, -4 + k, 7, 8 - k * 2); } }
    g.restore();
    if (g === ctx && riders >= RULES.seats) text('FULL', x, y - 18, `500 9px ${F_MONO}`, INK);
  }

  /** The three seats: who is in the taxi, where to, how much time they give you. */
  function seats(s: LwState | null, now: number): void {
    ctx.fillStyle = INK; ctx.fillRect(0, PANEL_Y, W, H - PANEL_Y);
    text('IN THE TAXI', 12, PANEL_Y + 13, `500 10px ${F_MONO}`, '#8C8A84', 'left');
    if (s) {
      // the bottom line, left of the page's sound button
      const waiting = s.play.waiting.length, jams = s.play.jams.length;
      text(`${waiting} WAITING · ${jams} ${jams === 1 ? 'JAM' : 'JAMS'}`, W / 2, H - 18, `500 10px ${F_MONO}`, waiting >= 6 ? TRAM : '#8C8A84', 'center');
    }
    const cw = (W - 24 - 2 * 8) / 3, cy = PANEL_Y + 24, ch = H - cy - 38;
    for (let i = 0; i < RULES.seats; i++) {
      const cx = 12 + i * (cw + 8), f = s?.play.riders[i];
      if (!f) {
        ctx.strokeStyle = '#3A3936'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.strokeRect(cx, cy, cw, ch); ctx.setLineDash([]);
        text('FREE SEAT', cx + cw / 2, cy + ch / 2, `500 10px ${F_MONO}`, '#5A5853');
        continue;
      }
      const left = Math.max(0, Math.min(1, (f.until - nowTick) / f.span)), urgent = left < 0.3;
      ctx.fillStyle = '#1C1B19'; ctx.fillRect(cx, cy, cw, ch);
      ctx.fillStyle = colorOf(f.via >= 0 ? f.via : f.to); ctx.fillRect(cx, cy, cw, 5);
      const name = nameOfPanel(f.panel);
      const jig = urgent ? Math.sin(now / 35 + i) * 2 : 0;
      drawPerson(ctx, name, cx + 6 + jig, cy + 12, 44, 0, DIR.DOWN);
      ctx.font = fitFont(name, cw - 58, 13, F_ANTON);
      text(name, cx + 54, cy + 22, ctx.font, CHALK, 'left');
      if (f.kind === 'express') text('⚡ EXPRESS', cx + 54, cy + 40, `500 9px ${F_MONO}`, TRAM, 'left');
      else if (f.kind === 'gold') text('★ GOLDEN', cx + 54, cy + 40, `500 9px ${F_MONO}`, GOLD, 'left');
      else if (f.kind === 'tour') text('TOUR', cx + 54, cy + 40, `500 9px ${F_MONO}`, '#B0ACA2', 'left');
      const dest = PLACES[f.to]?.name ?? '';
      if (f.via >= 0) {
        text('FIRST', cx + 8, cy + 62, `500 9px ${F_MONO}`, '#B0ACA2', 'left');
        text(PLACES[f.via]?.name ?? '', cx + 8, cy + 78, fitFont(PLACES[f.via]?.name ?? '', cw - 16, 16, F_ANTON), colorOf(f.via), 'left');
        text(`THEN ${dest}`, cx + 8, cy + 96, fitFont(`THEN ${dest}`, cw - 16, 10, F_MONO), '#B0ACA2', 'left');
      } else {
        text('TO', cx + 8, cy + 62, `500 9px ${F_MONO}`, '#B0ACA2', 'left');
        text(dest, cx + 8, cy + 79, fitFont(dest, cw - 16, 18, F_ANTON), colorOf(f.to), 'left');
        const wish = pick(PLACES[f.to]?.wishes ?? [''], `w:${f.id}`);
        ctx.font = fitFont(`“${wish}”`, cw - 16, 10, F_MONO);
        text(`“${wish}”`, cx + 8, cy + 98, ctx.font, '#8C8A84', 'left');
      }
      // the time they give you
      ctx.fillStyle = '#3A3936'; ctx.fillRect(cx + 8, cy + ch - 16, cw - 16, 8);
      ctx.fillStyle = urgent ? RED : left < 0.6 ? TRAM : TAXI_GREEN; ctx.fillRect(cx + 8, cy + ch - 16, (cw - 16) * left, 8);
    }
  }

  function hud(s: LwState | null): void {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, HUD_H);
    if (!s) { text('THE LISBON WAY', W / 2, 48, `38px ${F_ANTON}`, CHALK); return; }
    const end = engine.endTickOf(s), open = engine.openTickOf(s);
    const secs = Math.ceil(Math.max(0, end - Math.max(nowTick, open)) * TICK_MS / 1000);
    const urgent = nowTick >= open && secs <= 10 && !s.gameOver;
    text(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 30, `34px ${F_ANTON}`, urgent ? TRAM : CHALK);
    // the 90 s as a bar under the clock
    const done = Math.max(0, Math.min(1, (Math.max(nowTick, open) - open) / RULES.playTicks));
    ctx.fillStyle = '#3A3936'; ctx.fillRect(W / 2 - 50, 54, 100, 4); ctx.fillStyle = urgent ? TRAM : BLUE; ctx.fillRect(W / 2 - 50, 54, 100 * done, 4);
    text(fmtScore(s.play.score), 14, 72, `30px ${F_ANTON}`, CHALK, 'left');
    const outcomes = s.play.delivered + s.play.gaveUp + s.play.jumped;
    if (outcomes > 0) {
      const n = stars(satisfaction(s.play));
      text('★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n), W - 14, 26, `14px ${F_MONO}`, n >= 4 ? TRAM : '#B0ACA2', 'right');
    } else text('RATING', W - 14, 26, `500 10px ${F_MONO}`, '#8C8A84', 'right');
    const mult = engine.multOf(s.play.combo);
    if (s.play.combo >= 2) text(`${mult > 1 ? `×${mult} · ` : ''}${s.play.combo} IN A ROW`, W - 14, 72, `500 12px ${F_MONO}`, mult > 1 ? TRAM : '#B0ACA2', 'right');
    else text(`${s.play.delivered} DELIVERED`, W - 14, 72, `500 12px ${F_MONO}`, '#B0ACA2', 'right');
    if (nowTick >= open && !s.gameOver) {
      const wave = engine.waveAt(s, nowTick);
      if (wave !== lastWave) { banner = { text: WAVE_BANNERS[wave] as string, t0: performance.now(), gold: wave === RULES.weights.length - 1 }; lastWave = wave; }
    }
  }

  /** A speech bubble whose tail points down at (x, y). */
  function bubble(say: string, x: number, y: number, loud: boolean, alpha: number): void {
    ctx.globalAlpha = alpha;
    ctx.font = `500 11px ${F_MONO}`;
    const w = Math.min(W - 16, ctx.measureText(say).width + 14), h = 22;
    const bx = Math.max(6, Math.min(W - 6 - w, x - w / 2)), by = Math.max(HUD_H + 2, y - h - 7);
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
      const spot = posOf(p.place), alpha = 1 - Math.max(0, t - 0.7) / 0.3;
      const { x, y } = spot.visible ? spot : { x: W / 2, y: HUD_H + 120 };   // off screen: up front
      const loud = p.what === 'gaveup' || p.what === 'jumped';
      const say = p.what === 'board' ? pick(PLACES[p.place]?.wishes ?? [''], `b:${p.seq}`) : pick(SAYS[p.what], `${p.what}:${p.seq}`);
      // every board would be noise: one in two speaks; every other event speaks
      if (p.what !== 'via' && (p.what !== 'board' || fnv1a(`s:${p.seq}`) % 2 === 0)) bubble(p.late ? 'JUST IN TIME!' : say, x, y - 44 - t * 16, loud || p.late, alpha);
      const gain = p.what === 'gaveup' ? `−${RULES.gaveUp}` : p.what === 'jumped' ? `−${RULES.jumpedOut}` : p.gain > 0 ? `+${p.gain}` : '';
      if (gain) { ctx.globalAlpha = alpha; text(gain, x, y + 26 - t * 18, `22px ${F_ANTON}`, loud ? RED : p.kind === 'express' || p.kind === 'gold' ? '#B8860B' : in3d() ? CHALK : INK); ctx.globalAlpha = 1; }
    }
  }
  function banners(now: number): void {
    if (!banner) return;
    const t = (now - banner.t0) / 1400;
    if (t >= 1) { banner = null; return; }
    const pop = Math.min(1, t * 8);
    ctx.save();
    ctx.globalAlpha = 1 - Math.max(0, t - 0.75) / 0.25;
    ctx.translate(W / 2, 330); ctx.rotate(-0.06); ctx.scale(pop, pop);
    ctx.font = fitFont(banner.text, W - 60, 38, F_ANTON);
    const w = ctx.measureText(banner.text).width + 36;
    ctx.fillStyle = banner.gold ? TRAM : INK; ctx.fillRect(-w / 2, -30, w, 60);
    text(banner.text, 0, 1, ctx.font, banner.gold ? INK : CHALK);
    ctx.restore();
  }
  /* ------------------------------ steering hints ------------------------------ */
  /** At the next corner, a chevron per street: blue for the one the taxi will take, red when a jam waits on it. */
  function cornerHint(s: LwState, now: number): void {
    if (s.gameOver || nowTick < engine.openTickOf(s)) return;
    const anchor = anchorOf(s), at = posOf(anchor, 0.2), next = s.play.taxi.route[0];
    if (!at.visible) return;
    const shake = now - nope < 250 ? Math.sin(now / 20) * 4 : 0;
    for (const w of waysOf(s)) {
      const chosen = w.place === next, jam = engine.jammed(s.play, (EDGE[anchor] as number[])[w.place] as number);
      const d = chosen ? 36 : 30, x = at.x + Math.cos(w.angle) * d + shake, y = at.y + Math.sin(w.angle) * d;
      ctx.save(); ctx.translate(x, y); ctx.rotate(w.angle);
      ctx.fillStyle = chosen ? BLUE : jam ? RED : 'rgba(11,11,11,.55)'; ctx.strokeStyle = CHALK; ctx.lineWidth = 2;
      const k = chosen ? 1.8 : 1.3;
      ctx.beginPath(); ctx.moveTo(9 * k, 0); ctx.lineTo(-5 * k, -8 * k); ctx.lineTo(-1 * k, 0); ctx.lineTo(-5 * k, 8 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (s.play.taxi.to < 0 && !s.play.taxi.route.length) text('PICK A WAY', at.x, at.y - 44, `16px ${F_ANTON}`, BLUE);
  }
  /** The TURBO button: its charges, and the turbo running down. */
  function turboButton(s: LwState, now: number): void {
    const running = nowTick < s.play.boostUntil, ready = s.play.boosts > 0 && !running;
    ctx.fillStyle = running ? TRAM : ready ? INK : 'rgba(11,11,11,.45)';
    ctx.beginPath(); ctx.arc(TURBO.x, TURBO.y, TURBO.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ready ? TRAM : CHALK; ctx.lineWidth = 3; ctx.stroke();
    if (running) {
      const left = (s.play.boostUntil - nowTick) / RULES.boostTicks;
      ctx.strokeStyle = INK; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(TURBO.x, TURBO.y, TURBO.r - 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
    }
    text('TURBO', TURBO.x, TURBO.y - 4, `15px ${F_ANTON}`, running ? INK : ready ? TRAM : CHALK);
    for (let i = 0; i < RULES.boostMax; i++) {
      ctx.fillStyle = i < s.play.boosts ? TRAM : '#5A5853';
      ctx.beginPath(); ctx.arc(TURBO.x - 6 + i * 12, TURBO.y + 13, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (ready && fnv1a(String(Math.floor(now / 600))) % 7 === 0) { ctx.strokeStyle = TRAM; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(TURBO.x, TURBO.y, TURBO.r + 5, 0, Math.PI * 2); ctx.stroke(); }
  }

  function countdown(s: LwState, now: number): void {
    const left = engine.openTickOf(s) - nowTick;
    if (left <= 0 || s.gameOver) return;
    ctx.fillStyle = 'rgba(222,219,211,.93)'; ctx.fillRect(0, HUD_H, W, PANEL_Y - HUD_H);
    text(String(Math.ceil(left * TICK_MS / 1000)), W / 2, 176, `96px ${F_ANTON}`, BLUE);
    // three rules, nothing else to learn before driving
    text('← ↑ → ↓  OR SWIPE TO TURN', W / 2, 252, `26px ${F_ANTON}`, INK);
    const rows: [string, string][] = [['1', 'PICK UP the people of the wall'], ['2', 'DRIVE them where their tag says'], ['3', 'BE QUICK: late riders jump out']];
    rows.forEach(([k, v], i) => {
      ctx.fillStyle = BLUE; ctx.fillRect(40, 288 + i * 40, 28, 28);
      text(k, 54, 303 + i * 40, `20px ${F_ANTON}`, CHALK);
      text(v, 82, 303 + i * 40, `20px ${F_ANTON}`, INK, 'left');
    });
    text('SPACE or TURBO: ×1.7 for 2 s (one per delivery)', W / 2, 424, `500 11px ${F_MONO}`, '#8C6A1E');
    text('hills: up slow, down fast · drop two together ×1.5', W / 2, 446, `500 11px ${F_MONO}`, BLUE);
    text('red street = traffic · in a row = ×2 ×3 ×4', W / 2, 468, `500 11px ${F_MONO}`, RED);
    drawTaxi(W / 2, 530, 0, 0, ctx, 1.6);
    const n = Math.ceil(left * TICK_MS / 1000);
    if (n !== lastCount) { lastCount = n; beep([440], 0.05, 'sine'); }
  }

  /** The entry: the taxi cruises a loop behind the page's own overlay (map px). */
  function idleCar(now: number): { x: number; z: number; angle: number } {
    const loop = [11, 8, 3, 0, 2, 6, 10, 11, 7, 4, 3, 11];
    const leg = Math.floor(now / 1600) % (loop.length - 1), f = (now % 1600) / 1600;
    const a = PLACES[loop[leg] as number] as { x: number; y: number }, b = PLACES[loop[leg + 1] as number] as { x: number; y: number };
    return { x: a.x + (b.x - a.x) * f, z: a.y + (b.y - a.y) * f, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  /** The shift's soundtrack and its last ten seconds. */
  function soundtrack(s: LwState | null): void {
    const open = s ? engine.openTickOf(s) : 0;
    if (!s || mode !== 'play' || s.gameOver || nowTick < open) { music.stop(); return; }
    music.start();
    music.rush(engine.waveAt(s, nowTick) >= 4);
    const secs = Math.ceil((engine.endTickOf(s) - nowTick) * TICK_MS / 1000);
    if (secs <= 10 && secs !== lastSecond) { lastSecond = secs; beep([secs <= 3 ? 1320 : 990], 0.04, 'square', 0.04); }
  }

  function draw(now: number): void {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (scene?.failed) setView('2d');                     // the device could not keep up: the flat map from now on
    if (mode === 'end') { ctx.fillStyle = CONCRETE; ctx.fillRect(0, 0, W, H); music.stop(); return; }   // the end panel covers the stage
    const s = mode === 'play' ? shown : null;
    soundtrack(s);
    if (s) autoStraight(s);
    const frac = Math.max(0, Math.min(1, (now - tickAt) / TICK_MS));
    const sx = shake > 0 ? (Math.random() - 0.5) * 12 * shake : 0, sy = shake > 0 ? (Math.random() - 0.5) * 8 * shake : 0;
    if (in3d() && scene) {
      ctx.clearRect(0, 0, W, H);
      const car = s ? carOf(s, frac, (e) => engine.jammed(s.play, e)) : idleCar(now);
      carNow = car;
      const people = new Map<number, { name: string; step: number }[]>();
      if (s) for (const [p, list] of waitingByPlace(s)) people.set(p, list.map((f) => ({ name: nameOfPanel(f.panel), step: stepAt(now + f.id * 61) % 2 })));
      scene.render(s, car, people, now, shake);
      ctx.translate(sx, sy);
      labels3d(s);
      if (s) waiting3d(s, now);
    } else {
      ctx.fillStyle = CONCRETE; ctx.fillRect(0, 0, W, H);
      ctx.translate(sx, sy);
      ctx.drawImage(mapBackdrop(), 0, 0, W * DPR, H * DPR, 0, 0, W, H);
      streets(s, now);
      pins(s, now);
      if (s) { const car = taxiAt(s, frac); carNow = carOf(s, frac, (e) => engine.jammed(s.play, e)); drawTaxi(car.x, car.y, car.angle, s.play.riders.length, ctx, 1, nowTick < s.play.boostUntil); waitingPeople(s, now); }
      else { const car = idleCar(now); drawTaxi(MX + car.x, MY + car.z, car.angle, 1); }
    }
    rippleFx(now);
    if (s) {
      popups(now);
      cornerHint(s, now);
      turboButton(s, now);
      seats(s, now);
      hud(s);
      banners(now);
      countdown(s, now);
      if (s.gameOver) {
        ctx.fillStyle = 'rgba(222,219,211,.9)'; ctx.fillRect(0, 280, W, 170);
        text('END OF SHIFT!', W / 2, 336, `52px ${F_ANTON}`, BLUE);
        text(s.play.bonus ? `GOOD SHIFT BONUS +${fmtScore(s.play.bonus)}` : `${satisfaction(s.play)}% HAPPY PASSENGERS`, W / 2, 396, `500 14px ${F_MONO}`, INK);
      }
    } else {
      seats(null, now);
      hud(null);
    }
    for (const b of bits) { ctx.globalAlpha = Math.min(1, b.life); ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.s, b.s * 0.6); }
    ctx.globalAlpha = 1;
    if (flash > 0) { ctx.fillStyle = `rgba(214,69,50,${(flash * 0.22).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
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
      text(t.title, 58, 250, fitFont(t.title, 700, 88, F_ANTON, g), t.good ? BLUE : RED, 'left', g);
      text(t.line, 64, 318, fitFont(t.line, 960, 26, F_MONO, g), INK, 'left', g);
      const n = stars(satisfaction(p));
      text('★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n), 1020, 250, `52px ${F_MONO}`, n >= 4 ? '#B8860B' : LABEL, 'right', g);
    }
    g.fillStyle = 'rgba(11,11,11,.12)'; g.fillRect(60, 352, 960, 2);
    text(fmtScore(score), 58, 428, `96px ${F_ANTON}`, INK, 'left', g);
    g.font = `96px ${F_ANTON}`;
    const sw = g.measureText(fmtScore(score)).width;
    const rank = practice ? undefined : rankOf(endStats?.rank);
    text(`POINTS${rank ? ` · #${rank} THIS WEEK` : ''}`, 58 + sw + 24, 446, `500 24px ${F_MONO}`, LABEL, 'left', g);
    if (p) {
      text(`${p.delivered} DELIVERED · ${p.gaveUp} GAVE UP · ${p.jumped} JUMPED OUT${p.bonus ? ` · BONUS +${fmtScore(p.bonus)}` : ''}`, 60, 492, fitFont(`${p.delivered} DELIVERED · ${p.gaveUp} GAVE UP · ${p.jumped} JUMPED OUT · BONUS +0000`, 960, 24, F_MONO, g), INK, 'left', g);
      // who rode with you, and where
      g.fillStyle = INK; g.fillRect(60, 520, 960, 380);
      text('WHO RODE WITH YOU', 84, 546, `500 20px ${F_MONO}`, '#8C8A84', 'left', g);
      const trips = [...p.log].reverse().slice(0, 8);
      if (!trips.length) text('Nobody this time. The hills will wait.', 540, 720, `500 26px ${F_MONO}`, '#8C8A84', 'center', g);
      trips.forEach((trip, i) => {
        const x = 84 + (i % 2) * 480, y = 572 + Math.floor(i / 2) * 80;
        const name = nameOfPanel(trip.panel);
        drawPerson(g, name, x, y, 64, 0, DIR.DOWN);
        text(name, x + 78, y + 20, fitFont(name, 370, 30, F_ANTON, g), CHALK, 'left', g);
        const dest = `→ ${PLACES[trip.to]?.name ?? ''}`;
        text(dest, x + 78, y + 50, fitFont(dest, 370, 22, F_MONO, g), colorOf(trip.to), 'left', g);
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
    const riders = s ? [...s.play.log].reverse().map((t) => `${nameOfPanel(t.panel)} to ${PLACES[t.to]?.name ?? ''}`) : [];
    card.setAttribute('aria-label', `Your card: ${score} points, ${s?.play.delivered ?? 0} delivered. ${riders.join(', ')}.`);
    const nodes: HTMLElement[] = [card];
    if (!practice && s) {
      const gameUrl = `${location.origin}/`;
      const panels = [...new Set([...s.play.log].reverse().map((t) => t.panel))];
      const tags = panels.map((panel) => tag(SNAPSHOT_NAME.get(panel)?.n ?? nameOfPanel(panel), handleOf(panel))).filter(Boolean);
      const title = driverTitle(s.play).title, delivered = s.play.delivered;
      const tweet = fitTweet(tags, (names, more) => `${title} of THE LISBON WAY: ${score} points, ${delivered} ${delivered === 1 ? 'person' : 'people'} of the wall driven around Lisbon.${names ? ` Thanks for riding: ${names}${more ? ' …' : ''}` : ''} ${gameUrl}`, gameUrl);
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
    resizeScene();
  }
  function resizeScene(): void {
    const cssW = parseFloat(canvas.style.width) || W, cssH = parseFloat(canvas.style.height) || H;
    scene?.resize(cssW, cssH * (PANEL_Y - HUD_H) / H, Math.min(window.devicePixelRatio || 1, 2));
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  setView(viewMode);
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
    else if (mode === 'idle' && t - idleT > 50) { idleT = t; draw(t); }
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
  heading: 'Drive the wall around Lisbon',
  tagline: 'You drive a taxi in Lisbon. The people of the wall wave you down: take them where they want to go. 90 seconds.',
  lede: 'You drive a taxi through Lisbon, seen from above, for 90 seconds. Three rules: 1. pick up the people of the wall (drive through the place where they wait; three seats); 2. drive them to the place on their tag; 3. be quick: someone kept waiting gives up (−50), someone kept too long in the taxi jumps out (−100). Steer with the arrow keys (or W A S D), a swipe, or a tap towards where you want to go: the taxi turns that way at the next corner, and goes straight on by itself where it can. Space (or the TURBO button) gives ×1.7 for 2 s: one charge at the start, one more per delivery. Lisbon has hills: uphill is slow, downhill fast. Two riders dropped at the same place pay ×1.5 each. ⚡ quick fares pay double, ★ golden fares triple, a + tour must stop at its FIRST place first. Deliveries in a row ×2 ×3 ×4, red streets are traffic. It gets busier every second; finish with happy passengers for a bonus up to +2500. One credit per shift, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: LwState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: LwState) => state.play.score,
  statusLine(state: LwState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated shift…';
    const open = engine.openTickOf(state);
    if (tick < open) return `Shift starts in ${Math.ceil((open - tick) * TICK_MS / 1000)}`;
    const left = Math.max(0, engine.endTickOf(state) - tick) * TICK_MS / 1000;
    return `Score ${state.play.score} · ${state.play.delivered} delivered · ${state.play.riders.length}/${RULES.seats} seats · ${Math.ceil(left)} s left`;
  },
  createStage,
  diagSummary: (s: LwState) => ({ tick: s.tick, started: s.started, startTick: s.startTick, gameOver: s.gameOver, score: s.play.score, taxi: s.play.taxi, riders: s.play.riders.length, waiting: s.play.waiting.length, jams: s.play.jams.length, last: s.play.events.at(-1) ?? null }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('the-lisbon-way')),
    advance: (state: LwState, tick: number) => engine.advance(state, tick),
  },
};

