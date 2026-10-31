// THE LISBON WAY: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// You drive Lisbon's yellow tram on a grid of streets (map.ts). It never stops: one cell every few ticks, in the direction
// the player last chose. The people of the wall wait in the streets, each with the colour of the stop where they want to
// get off. Driving onto someone picks them up: they hook on as a new carriage at the back (the tram grows). Driving onto a
// stop drops EVERY rider of that stop's colour at once: k riders together pay k times their fares (3 together = ×3 each).
// Hitting a house, the river, roadworks or the tram's own carriages is a crash: the riders get off (a penalty), the tram
// starts again from the depot after a second. 90 s, faster and faster towards the end (the last 15 s pay double); a
// shift without a crash pays a bonus.
//
// Integer arithmetic only, a seeded generator (src/common/det.ts), a state that round-trips through JSON exactly, no
// clock, no network. Person number n and roadworks number n of a run are pure functions of (seed, n, tick).
import { fnv1a, mulberry32 } from '../../common/det.js';
import { BLOCKED, CELLS, DEPOT, SPAWNABLE, STOP_COUNT, adjacent, distance, opposite, stepFrom, stopAt } from './map.js';

/* ================================ RULES ==================================== */
export const RULES = {
  countdownTicks: 60,                          // 3 s between the start and the shift
  playTicks: 1800,                             // 90 s
  waveTicks: 300,                              // six waves of 15 s
  /** The tram moves one cell every `step` ticks: stepStart for the first half, then faster and faster towards the end
   *  (a quadratic ramp): 6 ticks (0.3 s) until 0:45, 5 from 0:45, 4 from 1:04, 3 (0.15 s) for the last 12 s. */
  stepStart: 6, stepEnd: 3,
  /** The FINAL RUSH: in the last `rushTicks` of the shift every fare is multiplied by `rushMult`. */
  rushTicks: 300, rushMult: 2,
  turnsMax: 2,                                 // turns queued ahead (two quick swipes make a U)
  maxCars: 16,                                 // carriages at most (a full tram leaves people waiting)
  peopleBound: 8,                              // hard bound of the state
  crowdStart: 3, crowdEnd: 7,                  // people waiting at most
  spawnStart: 60, spawnEnd: 24,                // ticks between people (plus up to half again)
  patienceStart: 440, patienceEnd: 240,        // ticks someone waits before walking away
  goldFromWave: 2, goldPercent: 12,            // golden passengers, from 0:30
  conesFromWave: 3,                            // roadworks, from 0:45
  coneEveryStart: 220, coneEveryEnd: 110, coneTicks: 260, conesMax: 5,
  stunTicks: 20,                               // a crash: one second back at the depot
  lastSpawnBeforeEnd: 60,                      // nobody new in the last 3 s
  fare: 100, goldFare: 300,                    // per rider, × the number of riders dropped together
  crashPer: 20,                                // per rider lost in a crash
  cleanBonus: 1000, cleanMin: 5,               // a shift without a crash (and with 5 riders dropped or more)
  eventsMax: 8, logMax: 24,
};
export const WAVES = 6;
/** board: picked up · drop: dropped at their stop (k together) · crash: the tram hit something (k riders lost) ·
 *  gone: someone waited too long and walked away. */
export const WHATS = ['board', 'drop', 'crash', 'gone'] as const;
export type What = (typeof WHATS)[number];

/* ============================ TYPES & VALIDATION ============================= */
export type NamedPanel = { p: number; n: string };
export type LwConfig = { game: 'the-lisbon-way'; maxTicks: number; roundTicks: number };
/** A rider in a carriage: who, and which stop (0..4) they get off at. */
export type Car = { panel: number; stop: number; gold: boolean };
/** Someone waiting in the street. */
export type Person = { id: number; panel: number; cell: number; stop: number; gold: boolean; until: number };
export type Cone = { cell: number; until: number };
export type LwEvent = { seq: number; tick: number; what: What; panel: number; cell: number; stop: number; k: number; gain: number };
export type Trip = { panel: number; stop: number; gain: number };
export type End = 'none' | 'time' | 'horizon';
export type Play = {
  score: number; delivered: number; crashes: number; lost: number; missed: number; bestChain: number; bonus: number; end: End;
  /** Heading (0 up, 1 right, 2 down, 3 left) and the turns queued for the next steps. */
  dir: number; turns: number[];
  /** The tram's cells, head first; cars[i] rides in tram[i + 1]. */
  tram: number[]; cars: Car[];
  nextStep: number; stunUntil: number;
  people: Person[]; nextSpawn: number; spawned: number; nextId: number;
  cones: Cone[]; nextCone: number; conesMade: number;
  eventSeq: number; events: LwEvent[];
  /** The last riders dropped (oldest first), for the end screen. */
  log: Trip[];
};
export type LwState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: LwConfig; play: Play };
export type LwInput = { action: 'start' } | { action: 'turn'; dir: number };

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
const isStreet = (v: unknown): v is number => isInt(v, 0, CELLS - 1) && !BLOCKED[v];

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): LwConfig {
  if (!isObject(value) || value.game !== 'the-lisbon-way' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, RULES.countdownTicks + 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'the-lisbon-way', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, a direction out of range). */
export function parseInput(value: unknown): LwInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'turn' && exactKeys(value, ['action', 'dir']) && isInt(value.dir, 0, 3)) return { action: 'turn', dir: value.dir };
  return null;
}
const CAR_KEYS = ['panel', 'stop', 'gold'] as const;
const PERSON_KEYS = ['id', 'panel', 'cell', 'stop', 'gold', 'until'] as const;
const CONE_KEYS = ['cell', 'until'] as const;
const EVENT_KEYS = ['seq', 'tick', 'what', 'panel', 'cell', 'stop', 'k', 'gain'] as const;
const TRIP_KEYS = ['panel', 'stop', 'gain'] as const;
const PLAY_KEYS = ['score', 'delivered', 'crashes', 'lost', 'missed', 'bestChain', 'bonus', 'end', 'dir', 'turns', 'tram', 'cars',
  'nextStep', 'stunUntil', 'people', 'nextSpawn', 'spawned', 'nextId', 'cones', 'nextCone', 'conesMade', 'eventSeq', 'events', 'log'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
const isStop = (v: unknown): v is number => isInt(v, 0, STOP_COUNT - 1);
function checkCar(c: unknown): Car {
  if (!isObject(c) || !exactKeys(c, CAR_KEYS) || !isInt(c.panel, 1, 550) || !isStop(c.stop) || typeof c.gold !== 'boolean') return fail('car');
  return { panel: c.panel, stop: c.stop, gold: c.gold };
}
function checkPerson(p: unknown): Person {
  if (!isObject(p) || !exactKeys(p, PERSON_KEYS) || !isInt(p.id, 1, MAX_ID) || !isInt(p.panel, 1, 550) || !isStreet(p.cell) || stopAt(p.cell) >= 0
    || !isStop(p.stop) || typeof p.gold !== 'boolean' || !isInt(p.until, 0, MAX_INT)) return fail('person');
  return { id: p.id, panel: p.panel, cell: p.cell, stop: p.stop, gold: p.gold, until: p.until };
}
function checkCone(c: unknown): Cone {
  if (!isObject(c) || !exactKeys(c, CONE_KEYS) || !isStreet(c.cell) || stopAt(c.cell) >= 0 || !isInt(c.until, 0, MAX_INT)) return fail('roadworks');
  return { cell: c.cell, until: c.until };
}
function checkEvent(e: unknown): LwEvent {
  if (!isObject(e) || !exactKeys(e, EVENT_KEYS) || !isInt(e.seq, 1, MAX_INT) || !isInt(e.tick, 0, MAX_INT) || !oneOf(e.what, WHATS)
    || !isInt(e.panel, 0, 550) || !isInt(e.cell, 0, CELLS - 1) || !isInt(e.stop, -1, STOP_COUNT - 1) || !isInt(e.k, 0, RULES.maxCars)
    || !isInt(e.gain, 0, 10_000_000)) return fail('event');
  return { seq: e.seq, tick: e.tick, what: e.what, panel: e.panel, cell: e.cell, stop: e.stop, k: e.k, gain: e.gain };
}
function checkTrip(t: unknown): Trip {
  if (!isObject(t) || !exactKeys(t, TRIP_KEYS) || !isInt(t.panel, 1, 550) || !isStop(t.stop) || !isInt(t.gain, 0, 10_000_000)) return fail('trip');
  return { panel: t.panel, stop: t.stop, gain: t.gain };
}
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent board. Throws otherwise. */
export function checkState(value: unknown): LwState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  for (const k of ['score', 'delivered', 'crashes', 'lost', 'missed', 'bestChain', 'bonus', 'nextStep', 'stunUntil', 'nextSpawn', 'nextCone', 'eventSeq'] as const) {
    if (!isInt(p[k], 0, MAX_INT)) return fail('state');
  }
  if (!oneOf(p.end, ['none', 'time', 'horizon'] as const) || !isInt(p.dir, 0, 3) || !isInt(p.spawned, 0, MAX_ID) || !isInt(p.nextId, 1, MAX_ID + 1)
    || !isInt(p.conesMade, 0, MAX_ID)) return fail('state');
  const { turns, tram, cars, people, cones, events, log } = p;
  if (!Array.isArray(turns) || turns.length > RULES.turnsMax || !turns.every((d) => isInt(d, 0, 3))) return fail('state');
  if (!Array.isArray(tram) || tram.length < 1 || tram.length > RULES.maxCars + 1 || !tram.every(isStreet) || new Set(tram).size !== tram.length) return fail('tram');
  for (let i = 1; i < tram.length; i++) if (!adjacent(tram[i - 1] as number, tram[i] as number)) return fail('tram');
  if (!Array.isArray(cars) || cars.length !== tram.length - 1) return fail('tram');
  if (!Array.isArray(people) || people.length > RULES.peopleBound || !Array.isArray(cones) || cones.length > RULES.conesMax
    || !Array.isArray(events) || events.length > RULES.eventsMax || !Array.isArray(log) || log.length > RULES.logMax) return fail('state');
  const riders = cars.map(checkCar), crowd = people.map(checkPerson), works = cones.map(checkCone), evs = events.map(checkEvent), trips = log.map(checkTrip);
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  const cells = [...crowd.map((x) => x.cell), ...works.map((x) => x.cell)];
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.end !== 'none') !== gameOver || (!started && (crowd.length > 0 || works.length > 0 || tram.length > 1))
    || new Set(cells).size !== cells.length || new Set(crowd.map((x) => x.id)).size !== crowd.length || crowd.some((x) => x.id >= (p.nextId as number))
    || works.some((c) => tram.includes(c.cell)) || evs.some((e) => e.seq > (p.eventSeq as number)) || (p.bonus as number) > (p.score as number)
    || (p.bestChain as number) > (p.delivered as number)) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      score: p.score as number, delivered: p.delivered as number, crashes: p.crashes as number, lost: p.lost as number, missed: p.missed as number,
      bestChain: p.bestChain as number, bonus: p.bonus as number, end: p.end, dir: p.dir, turns: turns.slice() as number[],
      tram: tram.slice() as number[], cars: riders, nextStep: p.nextStep as number, stunUntil: p.stunUntil as number,
      people: crowd, nextSpawn: p.nextSpawn as number, spawned: p.spawned, nextId: p.nextId,
      cones: works, nextCone: p.nextCone as number, conesMade: p.conesMade, eventSeq: p.eventSeq as number, events: evs, log: trips,
    },
  };
}

/* ================================ ENGINE ==================================== */
export const display = (name: string): string => name.trim().toUpperCase();
/** The end-of-shift bonus: a shift without a crash, with enough riders dropped. */
export const shiftBonus = (play: Play): number => (play.crashes === 0 && play.delivered >= RULES.cleanMin ? RULES.cleanBonus : 0);

export function createEngine(panels: readonly NamedPanel[]) {
  const pool = panels.filter((panel) => /^[\x20-\x7E]{1,32}$/.test(display(panel.n))).map((panel) => ({ p: panel.p, n: display(panel.n) }));
  if (pool.length < RULES.maxCars + RULES.peopleBound + 1) throw new Error('THE LISBON WAY needs more named panels');

  const openTickOf = (state: LwState): number => (state.startTick ?? 0) + RULES.countdownTicks;
  function endTickOf(state: LwState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  const elapsed = (state: LwState, tick: number): number => Math.max(0, Math.min(RULES.playTicks, tick - openTickOf(state)));
  /** The ramp: from `a` at the opening to `b` at the end, in whole steps. */
  const ramp = (state: LwState, tick: number, a: number, b: number): number => a + Math.trunc((b - a) * elapsed(state, tick) / RULES.playTicks);
  function waveAt(state: LwState, tick: number): number {
    const t = tick - openTickOf(state);
    return t <= 0 ? 0 : Math.min(WAVES - 1, Math.floor(t / RULES.waveTicks));
  }
  /** The tram's step: quadratic in the time played, so it speeds up more and more as the end gets near. */
  const stepAt = (state: LwState, tick: number): number => {
    const e = elapsed(state, tick), span = RULES.stepStart - RULES.stepEnd;
    return Math.max(RULES.stepEnd, RULES.stepStart - Math.floor((span + 1) * e * e / (RULES.playTicks * RULES.playTicks)));
  };
  /** The final rush: the last seconds of the shift pay double. */
  const rushAt = (state: LwState, tick: number): boolean => elapsed(state, tick) > RULES.playTicks - RULES.rushTicks;
  const coneAt = (play: Play, cell: number): boolean => play.cones.some((c) => c.cell === cell);

  function event(state: LwState, what: What, panel: number, cell: number, stop: number, k: number, gain: number): void {
    const play = state.play;
    play.eventSeq++;
    play.events.push({ seq: play.eventSeq, tick: state.tick, what, panel, cell, stop, k, gain });
    if (play.events.length > RULES.eventsMax) play.events.shift();
  }
  /** A free street cell for someone or for roadworks, at least `away` cells from the tram's head; -1 when none. */
  function freeCell(state: LwState, rnd: () => number, away: number): number {
    const play = state.play, head = play.tram[0] as number;
    const first = Math.floor(rnd() * SPAWNABLE.length);
    for (let k = 0; k < SPAWNABLE.length; k++) {
      const cell = SPAWNABLE[(first + k) % SPAWNABLE.length] as number;
      if (play.tram.includes(cell) || play.people.some((x) => x.cell === cell) || coneAt(play, cell) || distance(cell, head) < away) continue;
      return cell;
    }
    return -1;
  }
  function spawn(state: LwState): void {
    const play = state.play, tick = state.tick;
    if (tick < play.nextSpawn || tick >= endTickOf(state) - RULES.lastSpawnBeforeEnd) return;
    if (play.people.length >= Math.min(RULES.peopleBound, ramp(state, tick, RULES.crowdStart, RULES.crowdEnd))) { play.nextSpawn = tick + 10; return; }
    const rnd = mulberry32(fnv1a(`person:${state.seed}:${play.spawned}`));
    const cell = freeCell(state, rnd, 3);
    const stop = Math.floor(rnd() * STOP_COUNT);
    const gold = waveAt(state, tick) >= RULES.goldFromWave && Math.floor(rnd() * 100) < RULES.goldPercent;
    // a name not already in the street or on the tram (the next one in the pool otherwise)
    let at = Math.floor(rnd() * pool.length);
    const taken = (panel: number): boolean => play.people.some((x) => x.panel === panel) || play.cars.some((x) => x.panel === panel);
    for (let j = 0; j < pool.length && taken((pool[at] as NamedPanel).p); j++) at = (at + 1) % pool.length;
    const interval = ramp(state, tick, RULES.spawnStart, RULES.spawnEnd);
    play.nextSpawn = tick + interval + Math.floor(rnd() * (Math.floor(interval / 2) + 1));
    if (cell < 0) return;
    const patience = ramp(state, tick, RULES.patienceStart, RULES.patienceEnd);
    play.people.push({ id: play.nextId, panel: (pool[at] as NamedPanel).p, cell, stop, gold, until: tick + (gold ? Math.floor(patience * 2 / 3) : patience) });
    play.spawned++; play.nextId++;
  }
  function roadworks(state: LwState): void {
    const play = state.play, tick = state.tick;
    if (play.cones.some((c) => c.until <= tick)) play.cones = play.cones.filter((c) => c.until > tick);
    if (tick < play.nextCone || waveAt(state, tick) < RULES.conesFromWave) return;
    const rnd = mulberry32(fnv1a(`cone:${state.seed}:${play.conesMade}`));
    const every = ramp(state, tick, RULES.coneEveryStart, RULES.coneEveryEnd);
    play.nextCone = tick + every + Math.floor(rnd() * (Math.floor(every / 2) + 1));
    play.conesMade++;
    if (play.cones.length >= RULES.conesMax) return;
    const cell = freeCell(state, rnd, 4);
    if (cell >= 0) play.cones.push({ cell, until: tick + RULES.coneTicks });
  }
  function crash(state: LwState, cell: number): void {
    const play = state.play, lost = play.cars.length;
    play.score -= Math.min(play.score, RULES.crashPer * lost);
    play.crashes++; play.lost += lost;
    event(state, 'crash', 0, cell, -1, lost, 0);
    play.tram = [DEPOT]; play.cars = []; play.dir = 0; play.turns = [];
    play.stunUntil = state.tick + RULES.stunTicks;
    play.nextStep = play.stunUntil + stepAt(state, state.tick);
  }
  /** One step of the tram: turn, move, pick up, drop off, or crash. */
  function move(state: LwState): void {
    const play = state.play;
    while (play.turns.length) {
      const d = play.turns.shift() as number;
      if (d !== opposite(play.dir) && d !== play.dir) { play.dir = d; break; }
    }
    const head = play.tram[0] as number, next = stepFrom(head, play.dir);
    const person = next < 0 ? undefined : play.people.find((x) => x.cell === next);
    const grow = person !== undefined && play.cars.length < RULES.maxCars;
    // the tail moves away this step unless the tram grows
    const body = grow ? play.tram : play.tram.slice(0, -1);
    if (next < 0 || BLOCKED[next] || coneAt(play, next) || body.includes(next)) { crash(state, next < 0 ? head : next); return; }
    play.tram.unshift(next);
    if (grow && person) {
      play.cars.push({ panel: person.panel, stop: person.stop, gold: person.gold });
      play.people = play.people.filter((x) => x !== person);
      event(state, 'board', person.panel, next, person.stop, 1, 0);
    } else play.tram.pop();
    const stop = stopAt(next);
    if (stop < 0) return;
    const off = play.cars.filter((c) => c.stop === stop);
    if (!off.length) return;
    const k = off.length, gain = off.reduce((sum, c) => sum + (c.gold ? RULES.goldFare : RULES.fare), 0) * k * (rushAt(state, state.tick) ? RULES.rushMult : 1);
    play.cars = play.cars.filter((c) => c.stop !== stop);
    play.tram.splice(play.tram.length - k, k);                // the tram gets k carriages shorter
    play.score += gain; play.delivered += k;
    if (k > play.bestChain) play.bestChain = k;
    event(state, 'drop', (off[0] as Car).panel, next, stop, k, gain);
    for (const c of off) play.log.push({ panel: c.panel, stop, gain: Math.floor(gain / k) });
    while (play.log.length > RULES.logMax) play.log.shift();
  }
  /** One server tick of the shift: people, roadworks, the tram when its step is due, then the patience of everyone. */
  function step(state: LwState): void {
    const play = state.play, tick = state.tick;
    spawn(state);
    roadworks(state);
    if (tick >= play.stunUntil && tick >= play.nextStep) { move(state); if (play.nextStep <= tick) play.nextStep = tick + stepAt(state, tick); }
    const gone = play.people.filter((x) => x.until <= tick);
    if (gone.length) {
      play.people = play.people.filter((x) => x.until > tick);
      for (const x of gone) { play.missed++; event(state, 'gone', x.panel, x.cell, x.stop, 0, 0); }
    }
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
        score: 0, delivered: 0, crashes: 0, lost: 0, missed: 0, bestChain: 0, bonus: 0, end: 'none', dir: 0, turns: [],
        tram: [DEPOT], cars: [], nextStep: 0, stunUntil: 0, people: [], nextSpawn: 0, spawned: 0, nextId: 1,
        cones: [], nextCone: 0, conesMade: 0, eventSeq: 0, events: [], log: [],
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
        const open = openTickOf(state);
        state.play.nextStep = open + RULES.stepStart; state.play.nextSpawn = open; state.play.nextCone = open;
      }
      return state;
    }
    if (!state.started || state.tick < openTickOf(state)) return state;
    // a turn for the next step: never straight back, never the same direction twice in a row, two at most
    const play = state.play, last = play.turns.length ? play.turns[play.turns.length - 1] as number : play.dir;
    if (action.dir === last || action.dir === opposite(last) || play.turns.length >= RULES.turnsMax) return state;
    play.turns.push(action.dir);
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
    advanceInPlace, applyInputInPlace, clone, endTickOf, openTickOf, waveAt, stepAt, rushAt, ramp, pool,
  };
}
export type LisbonWayEngine = ReturnType<typeof createEngine>;
