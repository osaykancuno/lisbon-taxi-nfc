// THE LISBON WAY: the map, the rules (core.ts), the page's schemas (engine.ts) and the BUILT verifier, as Studio receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import {
  BLOCKED, CELLS, COLS, DEPOT, ROWS, RULES, SPAWNABLE, STOPS, STOP_COUNT, cellOf, checkState, createEngine, inputSchema, opposite,
  parseInput, shiftBonus, stateSchema, stepFrom, stopAt, type Car, type LwState, type Person,
} from '../src/games/the-lisbon-way/engine.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('the-lisbon-way');
const engine = createEngine(WALL_PANELS);
const OPEN = RULES.countdownTicks;
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
const started = (seed: number): LwState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
/** A run at the opening with exactly this tram, these riders and people, no new arrivals, the next step on the next tick. */
function scene(tram: number[], cars: Partial<Car>[] = [], people: Partial<Person>[] = [], dir = UP, seed = 1): LwState {
  const s = engine.advance(started(seed), OPEN);
  return { ...s, play: { ...s.play, dir, tram, nextStep: OPEN + 1, nextSpawn: 1_000_000, nextCone: 1_000_000, nextId: 100,
    cars: cars.map((c, i) => ({ panel: 300 + i, stop: 0, gold: false, ...c })),
    people: people.map((p, i) => ({ id: i + 1, panel: 400 + i, cell: 0, stop: 0, gold: false, until: 1_000_000, ...p })) } };
}
const turn = (s: LwState, dir: number, tick = s.tick): LwState => engine.applyInput(s, { action: 'turn', dir }, tick);
const whats = (s: LwState): string[] => s.play.events.map((e) => e.what);
/** The tick of the n-th step (1-based) after a scene's first one. */
const stepTick = (n: number): number => OPEN + 1 + (n - 1) * RULES.stepStart;
const c = cellOf;

test('the map: a 15 × 19 grid, five stops on streets, a free depot, people never on a stop or the depot', () => {
  assert.equal(CELLS, COLS * ROWS); assert.equal(STOP_COUNT, 5);
  for (const stop of STOPS) { assert.equal(BLOCKED[stop.cell], false, stop.name); assert.equal(stopAt(stop.cell), STOPS.indexOf(stop)); }
  assert.equal(new Set(STOPS.map((s) => s.cell)).size, STOP_COUNT);
  assert.equal(BLOCKED[DEPOT], false); assert.equal(BLOCKED[DEPOT - COLS], false);
  for (const cell of SPAWNABLE) { assert.equal(BLOCKED[cell], false); assert.equal(stopAt(cell), -1); assert.notEqual(cell, DEPOT); }
  assert.ok(SPAWNABLE.length > 150);
  for (let x = 0; x < COLS; x++) assert.equal(BLOCKED[c(x, ROWS - 1)], true, 'the river along the bottom');
  assert.equal(stepFrom(c(0, 0), UP), -1); assert.equal(stepFrom(c(0, 0), LEFT), -1); assert.equal(stepFrom(c(3, 3), RIGHT), c(4, 3));
});

test('the scoring config: 3 s of countdown + a fixed 90 s shift, with room to start', () => {
  assert.deepEqual(CONFIG, { game: 'the-lisbon-way', maxTicks: 2160, roundTicks: 1860 });
  assert.equal(CONFIG.roundTicks, RULES.countdownTicks + RULES.playTicks);
});

test('createRun validates its seed and config; same seed and inputs, same shift', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(2 ** 32, CONFIG)); assert.throws(() => engine.createRun('1', CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'gate-rush' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  const drive = (seed: number): LwState => {
    let s = started(seed);
    for (const [t, d] of [[70, LEFT], [100, UP], [130, RIGHT], [190, UP]] as const) s = turn(engine.advance(s, t), d);
    return engine.advance(s, 900);
  };
  const a = drive(42), b = drive(42), other = drive(43);
  assert.deepEqual(a, b); assert.notDeepEqual(a.play.people, other.play.people);
  assert.ok(a.play.people.length > 0, 'people appear');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the state round-trips through JSON');
  let stepped = started(42); for (let t = 1; t <= 600; t += 7) stepped = engine.advance(stepped, t);
  assert.deepEqual(engine.advance(stepped, 600), engine.advance(started(42), 600), 'many small advances = one big advance');
});

test('the tram moves one cell per step in its heading; a turn takes effect at the next step; never straight back', () => {
  let s = scene([c(7, 10)]);
  s = engine.advance(s, stepTick(1));
  assert.deepEqual(s.play.tram, [c(7, 9)]);
  s = turn(s, RIGHT);
  assert.deepEqual(s.play.turns, [RIGHT]);
  s = engine.advance(s, stepTick(2));
  assert.deepEqual(s.play.tram, [c(8, 9)]); assert.equal(s.play.dir, RIGHT);
  // the same direction or straight back is ignored; two quick turns make a U
  assert.deepEqual(turn(s, RIGHT).play.turns, []); assert.deepEqual(turn(s, LEFT).play.turns, []);
  s = turn(turn(s, DOWN), LEFT);
  assert.deepEqual(s.play.turns, [DOWN, LEFT]);
  assert.deepEqual(turn(s, UP).play.turns, [DOWN, LEFT], 'two turns ahead at most');
  s = engine.advance(s, stepTick(4));
  assert.deepEqual(s.play.tram, [c(7, 10)], 'down, then left: a U');
});

test('pick up: driving onto someone hooks them on as a carriage with the colour of their stop', () => {
  let s = scene([c(7, 10)], [], [{ cell: c(7, 9), stop: 3, panel: 77 }]);
  s = engine.advance(s, stepTick(1));
  assert.deepEqual(whats(s), ['board']);
  assert.deepEqual(s.play.tram, [c(7, 9), c(7, 10)], 'the tram grows by one');
  assert.deepEqual(s.play.cars, [{ panel: 77, stop: 3, gold: false }]); assert.equal(s.play.people.length, 0);
  s = engine.advance(s, stepTick(2));
  assert.deepEqual(s.play.tram, [c(7, 8), c(7, 9)], 'the carriage follows the head');
});

test('drop off: a stop drops EVERY rider of its colour at once, k together pay k times their fares', () => {
  const GRACA = 2;
  assert.equal(STOPS[GRACA]?.cell, c(9, 1));
  let s = scene([c(9, 3), c(9, 4), c(9, 5), c(9, 6), c(9, 7)], [{ stop: GRACA }, { stop: 0 }, { stop: GRACA }, { stop: GRACA, gold: true }]);
  s = engine.advance(s, stepTick(2));
  assert.deepEqual(whats(s), ['drop']);
  const drop = s.play.events[0];
  assert.equal(drop?.k, 3); assert.equal(drop?.gain, (RULES.fare * 2 + RULES.goldFare) * 3);
  assert.equal(s.play.score, (100 + 100 + 300) * 3); assert.equal(s.play.delivered, 3); assert.equal(s.play.bestChain, 3);
  assert.deepEqual(s.play.cars, [{ panel: 301, stop: 0, gold: false }], 'the other colour stays aboard');
  assert.equal(s.play.tram.length, 2, 'three carriages shorter'); assert.equal(s.play.tram[0], c(9, 1));
  assert.equal(s.play.log.length, 3);
  // a single rider pays one fare
  const one = engine.advance(scene([c(9, 2), c(9, 3)], [{ stop: GRACA }]), stepTick(1));
  assert.equal(one.play.score, RULES.fare);
});

test('crashes: the edge of the town, a house, the river, roadworks or the tram itself; riders lost, back at the depot', () => {
  const crashes = (s: LwState): boolean => whats(s).includes('crash');
  assert.ok(crashes(engine.advance(scene([c(0, 0)]), stepTick(1))), 'the edge');
  assert.ok(crashes(engine.advance(scene([c(7, 14)]), stepTick(1))), 'a house');
  assert.ok(crashes(engine.advance(scene([c(5, 17)], [], [], DOWN), stepTick(1))), 'the river');
  const works = scene([c(7, 10)]);
  assert.ok(crashes(engine.advance({ ...works, play: { ...works.play, cones: [{ cell: c(7, 9), until: 1_000_000 }] } }, stepTick(1))), 'roadworks');
  // into its own carriages
  let self = scene([c(5, 7), c(5, 8), c(6, 8), c(6, 7), c(6, 6)], [{}, {}, {}, {}]);
  self = { ...self, play: { ...self.play, score: 500 } };
  self = engine.advance(turn(self, RIGHT), stepTick(1));
  assert.deepEqual(whats(self), ['crash']); assert.equal(self.play.events[0]?.k, 4);
  assert.equal(self.play.score, 500 - 4 * RULES.crashPer); assert.equal(self.play.lost, 4); assert.equal(self.play.crashes, 1);
  assert.deepEqual(self.play.tram, [DEPOT]); assert.deepEqual(self.play.cars, []); assert.equal(self.play.dir, UP);
  // stunned for a second, then off again from the depot
  const still = engine.advance(self, stepTick(1) + RULES.stunTicks - 1);
  assert.deepEqual(still.play.tram, [DEPOT]);
  const off = engine.advance(self, stepTick(1) + RULES.stunTicks + RULES.stepStart);
  assert.deepEqual(off.play.tram, [DEPOT - COLS]);
  // following its own tail is fine: the tail moves away
  const loop = engine.advance(turn(scene([c(5, 7), c(5, 8), c(6, 8), c(6, 7)], [{}, {}, {}]), RIGHT), stepTick(1));
  assert.deepEqual(whats(loop), []); assert.equal(loop.play.tram[0], c(6, 7));
});

test('people walk away when kept waiting too long; a full tram leaves them in the street', () => {
  let s = scene([c(7, 10)], [], [{ cell: c(2, 3), until: OPEN + 3 }]);
  s = engine.advance(s, OPEN + 3);
  assert.deepEqual(whats(s), ['gone']); assert.equal(s.play.missed, 1); assert.equal(s.play.score, 0, 'no penalty');
  const cells = [c(7, 10)]; for (let y = 11; y <= 16; y++) cells.push(c(7, y)); for (let x = 6; x >= 0; x--) cells.push(c(x, 16));
  const full = scene(cells.slice(0, RULES.maxCars + 1), Array(RULES.maxCars).fill({}), [{ cell: c(7, 9) }]);
  const passed = engine.advance(full, stepTick(1));
  assert.deepEqual(whats(passed), []); assert.equal(passed.play.people.length, 1); assert.equal(passed.play.cars.length, RULES.maxCars);
});

test('faster and faster towards the end: 0.3 s a cell until 0:45, then 0.25, 0.2 and 0.15 s for the last 12 s', () => {
  const s = started(1), open = engine.openTickOf(s);
  assert.equal(engine.stepAt(s, open), 6); assert.equal(engine.stepAt(s, open + 899), 6);
  assert.equal(engine.stepAt(s, open + 900), 5); assert.equal(engine.stepAt(s, open + 1272), 5);
  assert.equal(engine.stepAt(s, open + 1273), 4); assert.equal(engine.stepAt(s, open + 1558), 4);
  assert.equal(engine.stepAt(s, open + 1559), 3); assert.equal(engine.stepAt(s, open + RULES.playTicks), RULES.stepEnd);
  // so the last 12 s run at twice the opening speed
  assert.equal(RULES.stepStart / RULES.stepEnd, 2);
});

test('the FINAL RUSH: in the last 15 s every fare is doubled', () => {
  const GRACA = 2, rushTick = OPEN + RULES.playTicks - RULES.rushTicks + 10;
  const s = engine.advance(started(1), rushTick - 1);
  assert.equal(engine.rushAt(s, rushTick - 20 - RULES.rushTicks), false); assert.equal(engine.rushAt(s, rushTick), true);
  const atRush = { ...s, play: { ...s.play, dir: UP, tram: [c(9, 2), c(9, 3)], cars: [{ panel: 300, stop: GRACA, gold: false }], people: [], cones: [], nextStep: rushTick, nextSpawn: 1_000_000, nextCone: 1_000_000, stunUntil: 0, score: 0 } };
  const dropped = engine.advance(atRush, rushTick);
  assert.equal(dropped.play.events.at(-1)?.what, 'drop'); assert.equal(dropped.play.score, RULES.fare * RULES.rushMult);
});

test('the shift gets busier all along: more people, golden passengers from 0:30, roadworks from 0:45', () => {
  const s = started(1), open = engine.openTickOf(s);
  for (let t = open + 1; t <= open + RULES.playTicks; t++) assert.ok(engine.stepAt(s, t - 1) - engine.stepAt(s, t) <= 1);
  let firstGold = Infinity, firstCone = Infinity, earlyCrowd = 0, lateCrowd = 0;
  for (let seed = 1; seed <= 12; seed++) {
    let run = started(seed);
    for (let t = open; t < open + RULES.playTicks; t += 10) {
      run = engine.advance(run, t);
      if (run.play.people.some((p) => p.gold)) firstGold = Math.min(firstGold, t - open);
      if (run.play.cones.length) firstCone = Math.min(firstCone, t - open);
      if (t - open < 300) earlyCrowd = Math.max(earlyCrowd, run.play.people.length); else if (t - open > 1500) lateCrowd = Math.max(lateCrowd, run.play.people.length);
      for (const p of run.play.people) assert.ok(!run.play.tram.includes(p.cell) || run.play.cars.length >= RULES.maxCars);
    }
  }
  assert.ok(firstGold >= RULES.goldFromWave * RULES.waveTicks && firstGold < Infinity, `first gold ${firstGold}`);
  assert.ok(firstCone >= RULES.conesFromWave * RULES.waveTicks && firstCone < Infinity, `first roadworks ${firstCone}`);
  assert.ok(lateCrowd > earlyCrowd, `crowd ${earlyCrowd} -> ${lateCrowd}`);
});

test('the end: a fixed 90 s shift; no crash and 5 riders or more pays the bonus; a finished run never changes', () => {
  const idle = engine.advance(started(9), CONFIG.roundTicks);
  assert.equal(idle.gameOver, true); assert.equal(idle.play.end, 'time'); assert.equal(idle.tick, CONFIG.roundTicks);
  assert.ok(idle.play.crashes > 5, 'an idle tram runs into the houses'); assert.equal(idle.play.score, 0); assert.equal(idle.play.bonus, 0);
  const never = engine.advance(engine.createRun(9, CONFIG), CONFIG.maxTicks);
  assert.equal(never.gameOver, true); assert.equal(never.play.end, 'horizon'); assert.equal(never.play.score, 0);
  assert.equal(shiftBonus({ ...idle.play, crashes: 0, delivered: 5 }), RULES.cleanBonus);
  assert.equal(shiftBonus({ ...idle.play, crashes: 0, delivered: 4 }), 0); assert.equal(shiftBonus({ ...idle.play, crashes: 1, delivered: 40 }), 0);
  const bot = play(greedy, 77);
  assert.equal(bot.play.end, 'time'); assert.equal(bot.play.bonus, shiftBonus(bot.play));
  assert.ok(bot.play.delivered >= 10, `delivered ${bot.play.delivered}`);
  assert.ok(JSON.stringify(bot).length < 8192);
  assert.deepEqual(turn(bot, LEFT, bot.tick + 1), bot, 'a finished run never changes');
});

test('start: turns before the start or during the countdown are no-ops; a second start does not move the clock', () => {
  const fresh = engine.createRun(3, CONFIG);
  assert.deepEqual(turn(fresh, LEFT, 2).play, fresh.play);
  const s = started(3);
  assert.deepEqual(turn(s, LEFT, OPEN - 1).play.turns, []);
  assert.equal(engine.applyInput(s, { action: 'start' }, 30).startTick, 0);
  assert.deepEqual(turn(s, LEFT, OPEN).play.turns, [LEFT]);
});

test('forged inputs never score, move the tram or change anyone', () => {
  const s = scene([c(9, 3), c(9, 4)], [{ stop: 2 }], [{ cell: c(3, 3) }]);
  const forged: unknown[] = [
    { action: 'turn', dir: 4 }, { action: 'turn', dir: -1 }, { action: 'turn', dir: 1.5 }, { action: 'turn', dir: '1' }, { action: 'turn' },
    { action: 'turn', dir: 1, score: 999 }, { action: 'turn', dir: 1, cell: 16 }, { action: 'teleport', cell: c(9, 1) }, { action: 'drop', stop: 2 },
    { action: 'start', x: 1 }, { action: 'boost' }, null, 7, 'turn', [], { score: 1e9 },
  ];
  const plain = engine.advance(s, stepTick(1));
  for (const input of forged) {
    const after = engine.advance(engine.applyInput(s, input, OPEN), stepTick(1));
    assert.deepEqual(after.play, plain.play, JSON.stringify(input));
    assert.equal(parseInput(input), null);
    assert.equal(inputSchema.safeParse(input).success, false, 'the page refuses what the verifier refuses');
  }
  assert.ok(inputSchema.safeParse({ action: 'turn', dir: 2 }).success);
});

test('checkState and the page schema refuse incoherent or tampered states (and agree)', () => {
  let s = scene([c(9, 3), c(9, 4), c(9, 5)], [{ stop: 1 }, { stop: 2 }], [{ cell: c(3, 3) }]);
  s = { ...s, play: { ...s.play, cones: [{ cell: c(2, 10), until: 999 }] } };
  s = engine.advance(s, OPEN + 4);                                  // one step: the head at (9, 2), two riders aboard
  assert.equal(s.play.cars.length, 2);
  assert.deepEqual(checkState(s), s); assert.equal(stateSchema.safeParse(s).success, true);
  const mutate = (f: (x: any) => void): unknown => { const x = structuredClone(s) as any; f(x); return x; };
  const bad = [
    mutate((x) => { x.extra = 1; }), mutate((x) => { x.play.extra = 1; }), mutate((x) => { x.play.score = -1; }), mutate((x) => { x.play.score = 1.5; }),
    mutate((x) => { x.play.dir = 4; }), mutate((x) => { x.play.turns = [1, 2, 3]; }), mutate((x) => { x.play.tram = []; }),
    mutate((x) => { x.play.tram[0] = c(7, 14); }), mutate((x) => { x.play.tram[1] = c(0, 0); }), mutate((x) => { x.play.tram.push(x.play.tram[0]); }),
    mutate((x) => { x.play.cars.pop(); }), mutate((x) => { x.play.cars[0].stop = 5; }), mutate((x) => { x.play.cars[0].extra = 1; }),
    mutate((x) => { x.play.people[0].cell = STOPS[0]?.cell; }), mutate((x) => { x.play.people[0].cell = c(1, 1); }),
    mutate((x) => { x.play.people.push({ ...x.play.people[0] }); }), mutate((x) => { x.play.people[0].id = x.play.nextId; }),
    mutate((x) => { x.play.cones.push({ cell: x.play.tram[0], until: 9 }); }), mutate((x) => { x.play.end = 'time'; }),
    mutate((x) => { x.started = false; }), mutate((x) => { x.tick = x.rules.maxTicks + 1; }), mutate((x) => { x.rules.game = 'gate-rush'; }),
    mutate((x) => { x.seed = -1; }), mutate((x) => { x.play.bonus = x.play.score + 1; }), mutate((x) => { x.play.bestChain = x.play.delivered + 1; }),
    mutate((x) => { x.play.log = Array(25).fill({ panel: 1, stop: 0, gain: 1 }); }),
  ];
  for (const state of bad) {
    assert.throws(() => checkState(state), Error, JSON.stringify(state).slice(0, 80));
    assert.equal(stateSchema.safeParse(state).success, false);
  }
});

/* ------------------------------ bots ------------------------------ */
type Bot = (s: LwState, rnd: () => number) => number | null;
/** The first direction of the shortest way from the head to any target cell, around houses, roadworks and the tram. */
function firstDir(s: LwState, targets: Set<number>): number | null {
  const p = s.play, head = p.tram[0] as number, blocked = new Set([...p.tram.slice(0, -1), ...p.cones.map((x) => x.cell)]);
  const prev = new Map<number, [number, number]>(), queue: number[] = [];
  for (let d = 0; d < 4; d++) {
    const n = stepFrom(head, d);
    if (d === opposite(p.dir) || n < 0 || BLOCKED[n] || blocked.has(n) || prev.has(n)) continue;
    prev.set(n, [head, d]); queue.push(n);
  }
  while (queue.length) {
    const cell = queue.shift() as number;
    if (targets.has(cell)) { let x = cell; while ((prev.get(x) as [number, number])[0] !== head) x = (prev.get(x) as [number, number])[0]; return (prev.get(x) as [number, number])[1]; }
    for (let d = 0; d < 4; d++) {
      const n = stepFrom(cell, d);
      if (n < 0 || BLOCKED[n] || blocked.has(n) || prev.has(n) || n === head) continue;
      prev.set(n, [cell, d]); queue.push(n);
    }
  }
  return null;
}
const anywhere = (s: LwState): number | null => firstDir(s, new Set(Array.from({ length: CELLS }, (_, i) => i).filter((i) => !BLOCKED[i] && i !== s.play.tram[0])));
const wander: Bot = (_s, rnd) => (rnd() < 0.15 ? Math.floor(rnd() * 4) : null);
/** Goes for the nearest person or rider's stop. */
const greedy: Bot = (s) => {
  const p = s.play, targets = new Set<number>(p.cars.map((x) => (STOPS[x.stop] as { cell: number }).cell));
  if (p.cars.length < 3) for (const x of p.people) targets.add(x.cell);
  return firstDir(s, targets) ?? anywhere(s);
};
/** Collects one colour, then drops them together. */
const planner: Bot = (s) => {
  const p = s.play, targets = new Set<number>(), count = new Array(STOP_COUNT).fill(0) as number[];
  for (const x of p.cars) count[x.stop] = (count[x.stop] as number) + (x.gold ? 3 : 1);
  const best = count.indexOf(Math.max(...count));
  if (p.cars.length >= 6 || (count[best] as number) >= 3) targets.add((STOPS[best] as { cell: number }).cell);
  else {
    for (const x of p.people) if (x.stop === best || count[best] === 0 || x.gold) targets.add(x.cell);
    if (!targets.size) for (const x of p.people) targets.add(x.cell);
    if (!targets.size && p.cars.length) targets.add((STOPS[best] as { cell: number }).cell);
  }
  return firstDir(s, targets) ?? anywhere(s);
};
/** A whole shift with a bot that decides one tick before every step of the tram. */
function play(bot: Bot, seed: number): LwState {
  let s = started(seed); const rnd = mulberry32(seed);
  for (let t = 1; !s.gameOver && t <= CONFIG.maxTicks; t++) {
    s = engine.advance(s, t);
    if (s.gameOver || s.play.nextStep - t !== 1 || s.play.turns.length) continue;
    const d = bot(s, rnd);
    if (d !== null && d !== s.play.dir) s = turn(s, d, t);
  }
  return s;
}

test('competitive: skill shows in the score (wandering < greedy < planning)', () => {
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const seeds = [3, 7922, 15841, 23760, 31679, 39598, 47517, 55436, 63355];
  const m = { wander: median(seeds.map((x) => play(wander, x).play.score)), greedy: median(seeds.map((x) => play(greedy, x).play.score)), planner: median(seeds.map((x) => play(planner, x).play.score)) };
  console.log(`  the-lisbon-way skill: median score wander ${m.wander}, greedy ${m.greedy}, planner ${m.planner}`);
  assert.ok(m.wander < 500 && m.greedy > m.wander + 2000 && m.planner > m.greedy, JSON.stringify(m));
});

/* ------------------------------ the BUILT verifier ------------------------------ */
const ARCHIVE: Configuration = {
  appId: '00000000-0000-4000-8000-00000000a002', groupId: '60faaf46-ba4b-460c-a82a-adb852371a94', studioUrl: 'https://studio.superrare.com',
  apiUrl: 'https://api.superrare.com', connectUrl: 'https://connect.superrare.com', appOrigin: 'https://the-lisbon-way-test.srstudio.dev',
  display: 'embed', game: 'the-lisbon-way', hubUrl: 'https://6972mvu4.srstudio.dev/',
};
async function built() {
  const files = unzipSync(zipSync(await packageGame(ARCHIVE)));
  const verifier = await loadBuiltVerifier(files['server-verifier.js'] as Uint8Array);
  return { files, verifier, config: JSON.parse(strFromU8(files['scoring-config.json'] as Uint8Array)) as Record<string, unknown> };
}

test('the-lisbon-way: the archive has Studio\'s root layout, the credit line, a zod-free verifier under 256 KB, a web app', async () => {
  const { files, config } = await built();
  for (const required of ['index.html', 'config.json', 'server-verifier.js', 'scoring-config.json']) assert.ok(files[required], `missing ${required}`);
  assert.ok(Object.keys(files).some((name) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name)), 'content-hashed app bundle');
  assert.deepEqual(config, CONFIG);
  const verifier = files['server-verifier.js'] as Uint8Array;
  assert.ok(verifier.byteLength < 256_000, `${verifier.byteLength} B`);
  assert.ok(!/ZodError|\$ZodType/.test(strFromU8(verifier)), 'zod-free verifier');
  assert.ok(!/Math\.random|Date\.now|new Date|fetch\(|localStorage/.test(strFromU8(verifier).replace(/request|Request|Response/g, '')), 'no randomness, clock, network or storage in the verifier');
  const html = strFromU8(files['index.html'] as Uint8Array);
  assert.ok(html.includes('<title>THE LISBON WAY · THE WALL ARCADE</title>'));
  assert.ok(/remix the wall experiment/i.test(html) && html.includes('https://onthewall.nfcsummit.com'), 'the credit line, linked');
  const publicConfig = strFromU8(files['config.json'] as Uint8Array);
  assert.ok(!/secret|token|private|treasury|0x[0-9a-fA-F]{40}/i.test(publicConfig));
  assert.equal(JSON.parse(publicConfig).groupId, '60faaf46-ba4b-460c-a82a-adb852371a94');
  const manifest = JSON.parse(strFromU8(files['assets/manifest.json'] as Uint8Array)) as { short_name: string; display: string; icons: { src: string }[] };
  assert.equal(manifest.short_name, 'THE LISBON WAY'); assert.equal(manifest.display, 'standalone'); assert.equal(manifest.icons.length, 2);
  for (const icon of manifest.icons) assert.ok(files[`assets/${icon.src.slice(2)}`], icon.src);
  assert.ok(html.includes('rel="manifest" href="./assets/manifest.json"') && html.includes('apple-touch-icon'));
  const app = Object.entries(files).find(([name]) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name))?.[1] as Uint8Array;
  console.log(`  the-lisbon-way page bundle: ${(app.byteLength / 1024).toFixed(0)} KB, verifier ${(verifier.byteLength / 1024).toFixed(0)} KB`);
  assert.ok(!strFromU8(app).includes('__lwTurn'), 'the dev-only hook is not in a published build');
});

test('the-lisbon-way: the BUILT verifier answers the conformance probe and rejects everything else', async () => {
  const { verifier, config } = await built();
  const probe = new Coordinator(verifier, config, 0);
  const state = await probe.create() as LwState;
  assert.equal(state.rules.game, 'the-lisbon-way');
  assert.equal(await probe.score(), 0); assert.equal(await probe.isFinished(), false); assert.deepEqual(await probe.view(), state);
  const post = (payload: unknown) => verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  assert.equal((await post({ version: 1, op: 'score', state: { ...state, bogus: 9 } })).status, 400);
  assert.equal((await post({ version: '1', op: 'createRun', seed: 1, config })).status, 400);
  assert.equal((await post({ version: 1, op: 'submitScore', score: 999999 })).status, 400);
  assert.equal((await post({ version: 1, op: 'advance', state, serverTick: -1 })).status, 400);
  assert.equal((await post({ version: 1, op: 'advance', state, serverTick: 3, extra: true })).status, 400);
  assert.equal((await post({ version: 1, op: 'createRun', seed: 1, config: { ...config, game: 'gate-rush' } })).status, 400);
  assert.equal((await verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'GET' }))).status, 404);
  const s10 = (await (await post({ version: 1, op: 'applyInput', state, input: { action: 'start' }, serverTick: 10 })).json() as { result: LwState }).result;
  assert.equal((await post({ version: 1, op: 'advance', state: s10, serverTick: 9 })).status, 400, 'time never moves backwards');
  const forged = await post({ version: 1, op: 'applyInput', state: s10, input: { action: 'turn', dir: 1, score: 1e6 }, serverTick: 80 });
  assert.equal((await forged.json() as { result: LwState }).result.play.score, 0);
});

test('the-lisbon-way: whole shifts through the BUILT verifier, called every tick like the platform, equal the engine and replay exactly', async () => {
  const { verifier: raw, config } = await built();
  const times: number[] = [];
  const verifier = { fetch: async (request: Request): Promise<Response> => { const t0 = performance.now(); const r = await raw.fetch(request); times.push(performance.now() - t0); return r; } };
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<LwState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown, tick: number): Promise<void> => { await run.input(input, tick); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' }, 2);
    const rnd = mulberry32(seed ^ 0x99);
    while (!run.state.gameOver && run.tick < (config.maxTicks as number)) {
      await run.advanceTo(run.tick + 1); local = engine.advance(local, run.tick);
      const s = run.state;
      if (s.gameOver || s.play.nextStep - run.tick > 2 || s.play.turns.length) continue;
      // a fallible player: decides a little late now and then, and sometimes turns at random
      const d = rnd() < 0.9 ? greedy(s, rnd) : Math.floor(rnd() * 4);
      if (d !== null && d !== s.play.dir) await send({ action: 'turn', dir: d }, run.tick + 1);
    }
    await run.advanceTo(config.maxTicks as number); local = engine.advance(local, run.tick);
    assert.equal(run.state.gameOver, true);
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    const again = new Coordinator<LwState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state, 'same seed, same inputs at the same ticks: same shift');
    console.log(`  the-lisbon-way built verifier (seed ${seed}): ${run.calls} calls, score ${run.state.play.score}, dropped ${run.state.play.delivered}, crashes ${run.state.play.crashes}, largest state ${run.largestState} B`);
    assert.ok(run.largestState < 8192);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] as number, p99 = times[Math.floor(times.length * 0.99)] as number;
  console.log(`  the-lisbon-way built verifier: ${times.length} calls, median ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${(times.at(-1) as number).toFixed(2)} ms`);
  assert.ok(p99 < 3, `p99 ${p99} ms`);
});

test('the-lisbon-way: the worst single call (an idle shift advanced in one go) stays far under 10 ms', async () => {
  const { verifier, config } = await built();
  let worst = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = new Coordinator<LwState>(verifier, config, seed);
    await run.create(); await run.input({ action: 'start' }, 1);
    await run.advanceTo(config.maxTicks as number);
    worst = Math.max(worst, run.worstMs);
  }
  console.log(`  the-lisbon-way built verifier: worst call ${worst.toFixed(2)} ms`);
  assert.ok(worst < 10);
});
