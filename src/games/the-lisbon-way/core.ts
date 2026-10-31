// THE LISBON WAY: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// You drive a taxi through a stylised Lisbon (map.ts). The people of the wall wait at its places, each with a request:
// a destination, an express ride (less time, double fare), a two-stop tour ("via" a place, then the destination) or, now
// and then, a golden passenger (triple fare, little patience). The
// taxi has three seats: it picks people up and drops them off by driving through their places. The player only chooses
// the ROUTE: an ordered list of places, one street at a time. Deliveries pay (more when fast, with a combo multiplier);
// a passenger left waiting too long gives up, a passenger kept in the taxi too long jumps out: both cost points. Traffic
// jams block streets (the taxi crawls through them). The shift lasts 90 s and gets harder all along: more passengers,
// less patience, more jams, more complex requests. A good shift ends with a big bonus.
//
// Integer arithmetic only, a seeded generator (src/common/det.ts), a state that round-trips through JSON exactly, no
// clock, no network. Fare number n and jam number n of a run are pure functions of (seed, n, tick).
import { fnv1a, mulberry32 } from '../../common/det.js';
import { E, EDGE, HOPS, LENGTH, N, NEIGHBOURS, PLACES, adjacent } from './map.js';

/* ================================ RULES ==================================== */
export const RULES = {
  countdownTicks: 60,                          // 3 s between the start and the shift
  playTicks: 1800,                             // 90 s
  waveTicks: 300,                              // six waves of 15 s
  start: 11,                                   // the taxi starts at BAIXA
  seats: 3,
  speed: 44,                                   // street units per tick on a clear, flat street
  hill: 6,                                     // per level of height: uphill slower, downhill faster (Lisbon!)
  jamDivisor: 4,                               // a traffic jam: a quarter of the speed
  boostStart: 1, boostMax: 2,                  // turbo charges: one at the start, one more per delivery, two at most
  boostTicks: 40,                              // a turbo lasts 2 s ...
  boostNum: 17, boostDen: 10,                  // ... at ×1.7
  sharedNum: 3, sharedDen: 2,                  // two riders or more dropped at the same place: ×1.5 each
  routeMax: 8,                                 // places in a planned route
  waitingMax: 12,                              // hard bound of the state (the ramp stays below it)
  perPlace: 2,                                 // people waiting at one place
  lastSpawnBeforeEnd: 60,                      // no new fare in the last 3 s
  /** The ramp, even from the first tick of the shift to the last (a step every few ticks). */
  spawnStart: 64, spawnEnd: 26,                // ticks between fares (plus up to half again at random)
  crowdStart: 4, crowdEnd: 9,                  // people waiting at most
  patienceStart: 460, patienceEnd: 260,        // ticks a passenger waits before giving up (express: three quarters)
  slackStart: 240, slackEnd: 170,              // a ride's time, % of the clear-street time (+ grace)
  expressSlackStart: 150, expressSlackEnd: 125,
  grace: 40,
  firstJam: 200,                               // ticks after the opening
  jamEveryStart: 260, jamEveryEnd: 50,          // ticks between jams (plus up to half again)
  jamLenStart: 160, jamLenEnd: 300,            // ticks a jam lasts
  jamsMaxStart: 1, jamsMaxEnd: 6,              // jams at once
  jamsBound: 8,
  /** Fares. */
  base: { ride: 100, express: 200, tour: 160, gold: 300 },
  perHop: 15,                                  // per street of the shortest route
  tipMax: 60,                                  // × the share of the ride time left
  comboEvery: 3, multCap: 4,
  gaveUp: 50,                                  // a waiting passenger gives up
  jumpedOut: 100,                              // a passenger jumps out of the taxi
  /** The end of a good shift: satisfaction (deliveries / everyone you took or left) with at least `bonusMin` deliveries. */
  bonusMin: 5,
  bonusTiers: [[90, 2500], [75, 1200], [50, 500]] as readonly (readonly [number, number])[],
  eventsMax: 8, logMax: 24,
  /** Draw weight (out of 100) of each kind, per wave, in KINDS order. */
  weights: [
    [100, 0, 0, 0],
    [75, 25, 0, 0],
    [62, 28, 0, 10],
    [50, 22, 20, 8],
    [40, 27, 25, 8],
    [35, 27, 28, 10],
  ] as readonly (readonly number[])[],
};
export const WAVES = RULES.weights.length;
/** ride: to a place · express: faster, double fare · tour: via a place first, then the destination · gold: a rare
 *  golden passenger, triple fare, waits as little as an express. */
export const KINDS = ['ride', 'express', 'tour', 'gold'] as const;
export type Kind = (typeof KINDS)[number];
/** board: picked up · via: the tour's stop reached · drop: delivered · gaveup: left waiting too long · jumped: out of the taxi. */
export const WHATS = ['board', 'via', 'drop', 'gaveup', 'jumped'] as const;
export type What = (typeof WHATS)[number];

/* ============================ TYPES & VALIDATION ============================= */
export type NamedPanel = { p: number; n: string };
export type LwConfig = { game: 'the-lisbon-way'; maxTicks: number; roundTicks: number };
/** A passenger. Waiting: `until` is when they give up. Riding: `until` is their deadline. `span` is that timer's length. */
export type Fare = { id: number; panel: number; kind: Kind; from: number; to: number; via: number; until: number; span: number };
export type Taxi = { at: number; to: number; pos: number; route: number[] };
export type Jam = { edge: number; until: number };
export type LwEvent = { seq: number; tick: number; what: What; kind: Kind; panel: number; place: number; gain: number };
export type Trip = { panel: number; from: number; to: number; gain: number };
export type End = 'none' | 'time' | 'horizon';
export type Play = {
  score: number; combo: number; bestCombo: number;
  delivered: number; gaveUp: number; jumped: number; bonus: number; end: End;
  /** Turbo charges left, and the tick the running turbo ends (exclusive). */
  boosts: number; boostUntil: number;
  /** Riders delivered together with someone else (shared rides). */
  shared: number;
  taxi: Taxi; waiting: Fare[]; riders: Fare[]; jams: Jam[];
  nextSpawn: number; spawned: number; nextId: number; nextJam: number; jamsMade: number; eventSeq: number;
  events: LwEvent[];
  /** The last deliveries (oldest first): who went where, for the end screen. */
  log: Trip[];
};
export type LwState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: LwConfig; play: Play };
export type LwInput = { action: 'start' } | { action: 'boost' } | { action: 'route'; path: number[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const MAX_ID = 1_000_000;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const fail = (what: string): never => { throw new Error(`Invalid THE LISBON WAY ${what}`); };
const isPlace = (v: unknown): v is number => isInt(v, 0, N - 1);
/** A chain of places, each one a street away from the one before (`from` included as the start). */
function isChain(from: number, path: readonly number[]): boolean {
  let at = from;
  for (const p of path) { if (!adjacent(at, p)) return false; at = p; }
  return true;
}

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): LwConfig {
  if (!isObject(value) || value.game !== 'the-lisbon-way' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, RULES.countdownTicks + 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'the-lisbon-way', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, a place out of range, a route too long). Whether a
 *  route is drivable from where the taxi is is checked by applyInput (an undrivable route is a no-op). */
export function parseInput(value: unknown): LwInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'boost') return exactKeys(value, ['action']) ? { action: 'boost' } : null;
  if (value.action === 'route' && exactKeys(value, ['action', 'path']) && Array.isArray(value.path) && value.path.length <= RULES.routeMax
    && value.path.every(isPlace)) return { action: 'route', path: (value.path as number[]).slice() };
  return null;
}
const FARE_KEYS = ['id', 'panel', 'kind', 'from', 'to', 'via', 'until', 'span'] as const;
const TAXI_KEYS = ['at', 'to', 'pos', 'route'] as const;
const JAM_KEYS = ['edge', 'until'] as const;
const EVENT_KEYS = ['seq', 'tick', 'what', 'kind', 'panel', 'place', 'gain'] as const;
const TRIP_KEYS = ['panel', 'from', 'to', 'gain'] as const;
const PLAY_KEYS = ['score', 'combo', 'bestCombo', 'delivered', 'gaveUp', 'jumped', 'bonus', 'end', 'boosts', 'boostUntil', 'shared', 'taxi', 'waiting', 'riders', 'jams',
  'nextSpawn', 'spawned', 'nextId', 'nextJam', 'jamsMade', 'eventSeq', 'events', 'log'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
function checkFare(f: unknown): Fare {
  if (!isObject(f) || !exactKeys(f, FARE_KEYS)) return fail('fare');
  if (!isInt(f.id, 1, MAX_ID) || !isInt(f.panel, 1, 550) || !oneOf(f.kind, KINDS) || !isPlace(f.from) || !isPlace(f.to) || f.from === f.to
    || !isInt(f.via, -1, N - 1) || (f.via >= 0 && (f.kind !== 'tour' || f.via === f.from || f.via === f.to))
    || !isInt(f.until, 0, MAX_INT) || !isInt(f.span, 1, 100_000)) return fail('fare');
  return { id: f.id, panel: f.panel, kind: f.kind, from: f.from, to: f.to, via: f.via, until: f.until, span: f.span };
}
function checkTaxi(t: unknown): Taxi {
  if (!isObject(t) || !exactKeys(t, TAXI_KEYS)) return fail('taxi');
  if (!isPlace(t.at) || !isInt(t.to, -1, N - 1) || !Array.isArray(t.route) || t.route.length > RULES.routeMax || !t.route.every(isPlace)) return fail('taxi');
  if (t.to < 0 ? t.pos !== 0 : !adjacent(t.at, t.to) || !isInt(t.pos, 0, (LENGTH[(EDGE[t.at] as number[])[t.to] as number] as number) - 1)) return fail('taxi');
  if (!isChain(t.to >= 0 ? t.to : t.at, t.route as number[])) return fail('taxi');
  return { at: t.at, to: t.to, pos: t.pos as number, route: (t.route as number[]).slice() };
}
function checkJam(j: unknown): Jam {
  if (!isObject(j) || !exactKeys(j, JAM_KEYS) || !isInt(j.edge, 0, E - 1) || !isInt(j.until, 0, MAX_INT)) return fail('jam');
  return { edge: j.edge, until: j.until };
}
function checkEvent(e: unknown): LwEvent {
  if (!isObject(e) || !exactKeys(e, EVENT_KEYS)) return fail('event');
  if (!isInt(e.seq, 1, MAX_INT) || !isInt(e.tick, 0, MAX_INT) || !oneOf(e.what, WHATS) || !oneOf(e.kind, KINDS) || !isInt(e.panel, 1, 550)
    || !isPlace(e.place) || !isInt(e.gain, 0, 1_000_000)) return fail('event');
  return { seq: e.seq, tick: e.tick, what: e.what, kind: e.kind, panel: e.panel, place: e.place, gain: e.gain };
}
function checkTrip(t: unknown): Trip {
  if (!isObject(t) || !exactKeys(t, TRIP_KEYS) || !isInt(t.panel, 1, 550) || !isPlace(t.from) || !isPlace(t.to) || !isInt(t.gain, 0, 1_000_000)) return fail('trip');
  return { panel: t.panel, from: t.from, to: t.to, gain: t.gain };
}
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): LwState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  for (const k of ['score', 'combo', 'bestCombo', 'delivered', 'gaveUp', 'jumped', 'bonus', 'nextSpawn', 'nextJam', 'eventSeq', 'boostUntil', 'shared'] as const) {
    if (!isInt(p[k], 0, MAX_INT)) return fail('state');
  }
  if (!isInt(p.boosts, 0, RULES.boostMax) || !oneOf(p.end, ['none', 'time', 'horizon'] as const) || !isInt(p.spawned, 0, MAX_ID) || !isInt(p.nextId, 1, MAX_ID + 1) || !isInt(p.jamsMade, 0, MAX_ID)) return fail('state');
  const { waiting, riders, jams, events, log } = p;
  if (!Array.isArray(waiting) || waiting.length > RULES.waitingMax || !Array.isArray(riders) || riders.length > RULES.seats
    || !Array.isArray(jams) || jams.length > RULES.jamsBound || !Array.isArray(events) || events.length > RULES.eventsMax
    || !Array.isArray(log) || log.length > RULES.logMax) return fail('state');
  const taxi = checkTaxi(p.taxi), wait = waiting.map(checkFare), ride = riders.map(checkFare), jam = jams.map(checkJam);
  const evs = events.map(checkEvent), trips = log.map(checkTrip);
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  const ids = [...wait, ...ride].map((f) => f.id);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.end !== 'none') !== gameOver || (p.combo as number) > (p.bestCombo as number) || (!started && (ids.length > 0 || jam.length > 0))
    || new Set(ids).size !== ids.length || ids.some((id) => id >= (p.nextId as number)) || new Set(jam.map((j) => j.edge)).size !== jam.length
    || evs.some((e) => e.seq > (p.eventSeq as number)) || (p.bonus as number) > (p.score as number) || (p.shared as number) > (p.delivered as number)
    || (p.boostUntil as number) > tick + RULES.boostTicks) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      score: p.score as number, combo: p.combo as number, bestCombo: p.bestCombo as number,
      delivered: p.delivered as number, gaveUp: p.gaveUp as number, jumped: p.jumped as number, bonus: p.bonus as number, end: p.end,
      boosts: p.boosts, boostUntil: p.boostUntil as number, shared: p.shared as number,
      taxi, waiting: wait, riders: ride, jams: jam,
      nextSpawn: p.nextSpawn as number, spawned: p.spawned, nextId: p.nextId, nextJam: p.nextJam as number, jamsMade: p.jamsMade,
      eventSeq: p.eventSeq as number, events: evs, log: trips,
    },
  };
}

/* ================================ ENGINE ==================================== */
export const display = (name: string): string => name.trim().toUpperCase();
/** The satisfaction of a shift, 0..100 (deliveries over everyone delivered, given up or jumped out). */
export const satisfaction = (play: Play): number => {
  const all = play.delivered + play.gaveUp + play.jumped;
  return all === 0 ? 0 : Math.floor(100 * play.delivered / all);
};
/** The end-of-shift bonus for these figures (0 below `bonusMin` deliveries). */
export function shiftBonus(play: Play): number {
  if (play.delivered < RULES.bonusMin) return 0;
  const rate = satisfaction(play);
  for (const [min, bonus] of RULES.bonusTiers) if (rate >= min) return bonus;
  return 0;
}

/** Speed on the street from `a` to `b` (units per tick): uphill slower, downhill faster; a jam divides it, a turbo
 *  multiplies it. */
export function speedOn(a: number, b: number, jam = false, boost = false): number {
  let v = RULES.speed - RULES.hill * (((PLACES[b] as { h: number }).h) - ((PLACES[a] as { h: number }).h));
  if (boost) v = Math.floor(v * RULES.boostNum / RULES.boostDen);
  return jam ? Math.floor(v / RULES.jamDivisor) : v;
}
/** Ticks to drive from every place to every other on clear streets, the fastest way (hills included). */
export const TIME: readonly (readonly number[])[] = (() => {
  const t = Array.from({ length: N }, (_, a) => Array.from({ length: N }, (__, b) => (a === b ? 0 : 1e9)));
  for (let a = 0; a < N; a++) for (const b of NEIGHBOURS[a] as number[]) {
    (t[a] as number[])[b] = Math.ceil((LENGTH[(EDGE[a] as number[])[b] as number] as number) / speedOn(a, b));
  }
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const via = ((t[i] as number[])[k] as number) + ((t[k] as number[])[j] as number);
    if (via < ((t[i] as number[])[j] as number)) (t[i] as number[])[j] = via;
  }
  return t;
})();

export function createEngine(panels: readonly NamedPanel[]) {
  const pool = panels.filter((panel) => /^[\x20-\x7E]{1,32}$/.test(display(panel.n))).map((panel) => ({ p: panel.p, n: display(panel.n) }));
  if (pool.length < 16) throw new Error('THE LISBON WAY needs at least 16 named panels');

  const openTickOf = (state: LwState): number => (state.startTick ?? 0) + RULES.countdownTicks;
  function endTickOf(state: LwState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  /** How far into the 90 s a tick is, from 0 to playTicks. */
  const elapsed = (state: LwState, tick: number): number => Math.max(0, Math.min(RULES.playTicks, tick - openTickOf(state)));
  /** The ramp: from `a` at the opening to `b` at the end, in whole steps. */
  const ramp = (state: LwState, tick: number, a: number, b: number): number => a + Math.trunc((b - a) * elapsed(state, tick) / RULES.playTicks);
  function waveAt(state: LwState, tick: number): number {
    const t = tick - openTickOf(state);
    return t <= 0 ? 0 : Math.min(WAVES - 1, Math.floor(t / RULES.waveTicks));
  }
  const multOf = (combo: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(combo / RULES.comboEvery));
  const jammed = (play: Play, edge: number): boolean => play.jams.some((j) => j.edge === edge);
  /** Ticks a ride gets, from where it is boarded: the clear-street time × the slack, plus grace. */
  function rideTicks(state: LwState, fare: Fare, from: number): number {
    const clear = fare.via >= 0 ? ((TIME[from] as number[])[fare.via] as number) + ((TIME[fare.via] as number[])[fare.to] as number) : (TIME[from] as number[])[fare.to] as number;
    const slack = fare.kind === 'express' ? ramp(state, state.tick, RULES.expressSlackStart, RULES.expressSlackEnd) : ramp(state, state.tick, RULES.slackStart, RULES.slackEnd);
    return Math.floor(clear * slack / 100) + RULES.grace;
  }

  function event(state: LwState, fare: Fare, what: What, place: number, gain: number): void {
    const play = state.play;
    play.eventSeq++;
    play.events.push({ seq: play.eventSeq, tick: state.tick, what, kind: fare.kind, panel: fare.panel, place, gain });
    if (play.events.length > RULES.eventsMax) play.events.shift();
  }
  function penalty(state: LwState, fare: Fare, what: 'gaveup' | 'jumped', place: number, points: number): void {
    const play = state.play;
    play.score -= Math.min(play.score, points);
    play.combo = 0;
    if (what === 'gaveup') play.gaveUp++; else play.jumped++;
    event(state, fare, what, place, 0);
  }
  function deliver(state: LwState, fare: Fare, place: number, shared: boolean): void {
    const play = state.play;
    const hops = ((HOPS[fare.from] as number[])[fare.to] as number) + (fare.kind === 'tour' ? 1 : 0);
    const tip = Math.floor(RULES.tipMax * Math.max(0, fare.until - state.tick) / fare.span);
    const fare1 = (RULES.base[fare.kind] + RULES.perHop * hops + tip) * multOf(play.combo);
    const gain = shared ? Math.floor(fare1 * RULES.sharedNum / RULES.sharedDen) : fare1;
    play.score += gain; play.combo++; play.delivered++;
    if (shared) play.shared++;
    if (play.boosts < RULES.boostMax) play.boosts++;
    if (play.combo > play.bestCombo) play.bestCombo = play.combo;
    event(state, fare, 'drop', place, gain);
    play.log.push({ panel: fare.panel, from: fare.from, to: fare.to, gain });
    if (play.log.length > RULES.logMax) play.log.shift();
  }

  /** Fare number n: place, destination, kind and name are a pure function of (seed, n, wave). Null when every place is
   *  full (it is retried a little later). */
  function fare(state: LwState, n: number, wave: number): Fare | null {
    const play = state.play;
    const rnd = mulberry32(fnv1a(`fare:${state.seed}:${n}`));
    const busy = (place: number): boolean => play.waiting.filter((f) => f.from === place).length >= RULES.perPlace;
    // the first fare waits one street from the taxi: the shift starts at once
    let from = -1;
    if (n === 0) {
      const near = NEIGHBOURS[play.taxi.at] as number[];
      from = near[Math.floor(rnd() * near.length)] as number;
    } else {
      const first = Math.floor(rnd() * N);
      for (let k = 0; k < N && from < 0; k++) { const p = (first + k) % N; if (!busy(p)) from = p; }
    }
    // a destination two streets away or more
    const far = Array.from({ length: N }, (_, i) => i).filter((p) => ((HOPS[from < 0 ? 0 : from] as number[])[p] as number) >= 2);
    const to = far[Math.floor(rnd() * far.length)] as number;
    const weights = RULES.weights[wave] as readonly number[];
    let r = Math.floor(rnd() * 100), k = 0;
    while (k < KINDS.length - 1 && r >= (weights[k] as number)) { r -= weights[k] as number; k++; }
    const kind: Kind = n === 0 ? 'ride' : KINDS[k] as Kind;
    // a tour's stop: not the start or the end, at most three streets out of the way
    let via = -1;
    if (kind === 'tour' && from >= 0) {
      const direct = (HOPS[from] as number[])[to] as number;
      const stops = Array.from({ length: N }, (_, i) => i).filter((p) => p !== from && p !== to
        && ((HOPS[from] as number[])[p] as number) + ((HOPS[p] as number[])[to] as number) <= direct + 3);
      via = stops[Math.floor(rnd() * stops.length)] ?? -1;
    }
    // a name not already waiting or riding (the next one in the pool otherwise)
    let at = Math.floor(rnd() * pool.length);
    const taken = (panel: number): boolean => play.waiting.some((f) => f.panel === panel) || play.riders.some((f) => f.panel === panel);
    for (let j = 0; j < pool.length && taken((pool[at] as NamedPanel).p); j++) at = (at + 1) % pool.length;
    if (from < 0) return null;
    const patience = ramp(state, state.tick, RULES.patienceStart, RULES.patienceEnd);
    const span = kind === 'express' || kind === 'gold' ? Math.floor(patience * 3 / 4) : patience;
    return { id: play.nextId, panel: (pool[at] as NamedPanel).p, kind: via >= 0 || kind !== 'tour' ? kind : 'ride', from, to, via, until: state.tick + span, span };
  }
  function spawn(state: LwState): void {
    const play = state.play, tick = state.tick;
    if (tick < play.nextSpawn || tick >= endTickOf(state) - RULES.lastSpawnBeforeEnd) return;
    if (play.waiting.length >= Math.min(RULES.waitingMax, ramp(state, tick, RULES.crowdStart, RULES.crowdEnd))) { play.nextSpawn = tick + 10; return; }
    const next = fare(state, play.spawned, waveAt(state, tick));
    if (!next) { play.nextSpawn = tick + 10; return; }
    const rnd = mulberry32(fnv1a(`gap:${state.seed}:${play.spawned}`));
    const interval = ramp(state, tick, RULES.spawnStart, RULES.spawnEnd);
    play.waiting.push(next);
    play.spawned++; play.nextId++;
    play.nextSpawn = tick + interval + Math.floor(rnd() * (Math.floor(interval / 2) + 1));
  }
  function traffic(state: LwState): void {
    const play = state.play, tick = state.tick;
    if (play.jams.some((j) => j.until <= tick)) play.jams = play.jams.filter((j) => j.until > tick);
    if (tick < play.nextJam) return;
    const rnd = mulberry32(fnv1a(`jam:${state.seed}:${play.jamsMade}`));
    const every = ramp(state, tick, RULES.jamEveryStart, RULES.jamEveryEnd);
    play.nextJam = tick + every + Math.floor(rnd() * (Math.floor(every / 2) + 1));
    play.jamsMade++;
    if (play.jams.length >= ramp(state, tick, RULES.jamsMaxStart, RULES.jamsMaxEnd)) return;
    const first = Math.floor(rnd() * E);
    for (let k = 0; k < E; k++) {
      const edge = (first + k) % E;
      if (jammed(play, edge)) continue;
      play.jams.push({ edge, until: tick + ramp(state, tick, RULES.jamLenStart, RULES.jamLenEnd) });
      return;
    }
  }
  /** The taxi is at `place` (arriving or standing): tour stops, drop-offs, then pick-ups while a seat is free. */
  function atPlace(state: LwState, place: number): void {
    const play = state.play;
    for (const f of play.riders) if (f.via === place) { f.via = -1; event(state, f, 'via', place, 0); }
    const off = play.riders.filter((f) => f.to === place && f.via < 0);
    if (off.length) {
      play.riders = play.riders.filter((f) => !off.includes(f));
      for (const f of off) deliver(state, f, place, off.length > 1);
    }
    if (play.riders.length >= RULES.seats) return;
    const here = play.waiting.filter((f) => f.from === place).sort((a, b) => a.until - b.until || a.id - b.id);
    for (const f of here) {
      if (play.riders.length >= RULES.seats) break;
      play.waiting = play.waiting.filter((w) => w !== f);
      const span = rideTicks(state, f, place);
      const rider: Fare = { ...f, until: state.tick + span, span };
      play.riders.push(rider);
      event(state, rider, 'board', place, 0);
    }
  }
  function drive(state: LwState): void {
    const taxi = state.play.taxi;
    if (taxi.to < 0 && taxi.route.length) { taxi.to = taxi.route.shift() as number; taxi.pos = 0; }
    if (taxi.to < 0) { atPlace(state, taxi.at); return; }
    const edge = (EDGE[taxi.at] as number[])[taxi.to] as number;
    taxi.pos += speedOn(taxi.at, taxi.to, jammed(state.play, edge), state.tick < state.play.boostUntil);
    if (taxi.pos >= (LENGTH[edge] as number)) { taxi.at = taxi.to; taxi.to = -1; taxi.pos = 0; atPlace(state, taxi.at); }
  }
  function timers(state: LwState): void {
    const play = state.play, tick = state.tick;
    const gone = play.waiting.filter((f) => f.until <= tick);
    if (gone.length) { play.waiting = play.waiting.filter((f) => f.until > tick); for (const f of gone) penalty(state, f, 'gaveup', f.from, RULES.gaveUp); }
    const out = play.riders.filter((f) => f.until <= tick);
    if (out.length) {
      play.riders = play.riders.filter((f) => f.until > tick);
      const t = play.taxi;
      for (const f of out) penalty(state, f, 'jumped', t.to >= 0 && t.pos * 2 >= (LENGTH[(EDGE[t.at] as number[])[t.to] as number] as number) ? t.to : t.at, RULES.jumpedOut);
    }
  }

  /** One server tick of the shift: fares, traffic, the taxi, then the clocks of everyone waiting or riding. */
  function step(state: LwState): void {
    spawn(state);
    traffic(state);
    drive(state);
    timers(state);
  }
  function finish(state: LwState, end: End): void {
    const play = state.play;
    state.gameOver = true; play.end = end;
    if (end === 'time') { play.bonus = shiftBonus(play); play.score += play.bonus; }
  }
  /** Mutating advance, one server tick at a time from the start of the shift. */
  function advanceInPlace(state: LwState, serverTick: number): LwState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const end = endTickOf(state);
    const target = Math.min(serverTick, end);
    if (state.started) {
      const open = openTickOf(state);
      if (state.tick < open) state.tick = Math.min(open, target);
      while (state.tick < target) { state.tick++; step(state); }
    }
    state.tick = Math.max(state.tick, target);
    if (state.tick >= end) finish(state, state.started ? 'time' : 'horizon');
    return state;
  }
  const clone = (state: LwState): LwState => structuredClone(state);

  function createRun(seed: unknown, config: unknown): LwState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return {
      tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules,
      play: {
        score: 0, combo: 0, bestCombo: 0, delivered: 0, gaveUp: 0, jumped: 0, bonus: 0, end: 'none',
        boosts: RULES.boostStart, boostUntil: 0, shared: 0,
        taxi: { at: RULES.start, to: -1, pos: 0, route: [] }, waiting: [], riders: [], jams: [],
        nextSpawn: 0, spawned: 0, nextId: 1, nextJam: 0, jamsMade: 0, eventSeq: 0, events: [], log: [],
      },
    };
  }
  function advance(state: LwState, serverTick: number): LwState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: LwState, input: unknown, serverTick: number): LwState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) {
        state.started = true; state.startTick = state.tick;
        state.play.nextSpawn = openTickOf(state); state.play.nextJam = openTickOf(state) + RULES.firstJam;
      }
      return state;
    }
    if (!state.started || state.tick < openTickOf(state)) return state;
    if (action.action === 'boost') {
      // a turbo from this tick, if a charge is left and none is running
      if (state.play.boosts > 0 && state.tick >= state.play.boostUntil) { state.play.boosts--; state.play.boostUntil = state.tick + RULES.boostTicks; }
      return state;
    }
    // the new route replaces the old one, from the place the taxi is at or driving to
    const taxi = state.play.taxi;
    if (!isChain(taxi.to >= 0 ? taxi.to : taxi.at, action.path)) return state;
    taxi.route = action.path;
    return state;
  }
  function applyInput(state: LwState, input: unknown, serverTick: number): LwState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: LwState): LwState => state;
  const isFinished = (state: LwState): boolean => state.gameOver;
  const score = (state: LwState): number => state.play.score;

  return {
    createRun, advance, applyInput, view, isFinished, score,
    advanceInPlace, applyInputInPlace, clone, endTickOf, openTickOf, waveAt, multOf, jammed, rideTicks, ramp, pool,
  };
}
export type LisbonWayEngine = ReturnType<typeof createEngine>;
