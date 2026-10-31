// THE LISBON WAY: the rules (core.ts), the map (map.ts), the page's schemas (engine.ts) and the BUILT verifier, as Studio
// receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import {
  DIST, E, EDGE, HOPS, KINDS, LENGTH, N, NEIGHBOURS, PLACES, RULES, STREETS, adjacent, checkState, createEngine, inputSchema,
  parseInput, satisfaction, shiftBonus, shortestPath, speedOn, stateSchema, TIME, type Fare, type Kind, type LwState,
} from '../src/games/the-lisbon-way/engine.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('the-lisbon-way');
const engine = createEngine(WALL_PANELS);
const OPEN = RULES.countdownTicks;
const started = (seed: number): LwState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
/** A run at the start of the shift with exactly these passengers, no traffic and no more arrivals. */
function scene(waiting: Partial<Fare>[], riders: Partial<Fare>[] = [], seed = 1): LwState {
  const s = engine.advance(started(seed), OPEN);
  const fare = (f: Partial<Fare>, i: number): Fare => ({ id: i + 1, panel: i + 1, kind: 'ride', from: 0, to: 4, via: -1, until: 100_000, span: 1000, ...f });
  return { ...s, play: { ...s.play, nextSpawn: 1_000_000, nextJam: 1_000_000, nextId: 100,
    waiting: waiting.map(fare), riders: riders.map((f, i) => fare(f, i + 50)), jams: [] } };
}
const route = (s: LwState, path: number[], tick = s.tick): LwState => engine.applyInput(s, { action: 'route', path }, tick);
const whats = (s: LwState): string[] => s.play.events.map((e) => e.what);
/** Ticks to drive along a street on a clear road. */
const drive = (a: number, b: number): number => Math.ceil((LENGTH[(EDGE[a] as number[])[b] as number] as number) / speedOn(a, b));
const BAIXA = 11, CHIADO = 8, ROSSIO = 3, CAIS = 10, MARQUES = 0;

test('the map: 14 places, 23 two-way streets, all connected, integer lengths, shortest paths that agree with DIST', () => {
  assert.equal(N, PLACES.length); assert.equal(E, STREETS.length);
  for (const [a, b] of STREETS) { assert.ok(adjacent(a, b) && adjacent(b, a)); assert.ok(a !== b); }
  for (const len of LENGTH) assert.ok(Number.isSafeInteger(len) && len > 500);
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    assert.ok((HOPS[a] as number[])[b] as number >= 0, 'connected');
    const path = shortestPath(a, b);
    let at = a, length = 0;
    for (const p of path) { length += LENGTH[(EDGE[at] as number[])[p] as number] as number; at = p; }
    assert.equal(at, b); assert.equal(length, (DIST[a] as number[])[b]);
  }
  assert.equal(RULES.start, BAIXA); assert.equal(PLACES[BAIXA]?.name, 'BAIXA');
});

test('the scoring config: 3 s of countdown + a fixed 90 s shift, with room to start', () => {
  assert.deepEqual(CONFIG, { game: 'the-lisbon-way', maxTicks: 2160, roundTicks: 1860 });
  assert.equal(CONFIG.roundTicks, RULES.countdownTicks + RULES.playTicks);
  assert.equal(RULES.playTicks / RULES.waveTicks, RULES.weights.length);
  for (const w of RULES.weights) { assert.equal(w.reduce((a, b) => a + b, 0), 100); assert.equal(w.length, KINDS.length); }
});

test('createRun validates its seed and config; same seed and inputs, same shift', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(2 ** 32, CONFIG)); assert.throws(() => engine.createRun('1', CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'gate-rush' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  assert.throws(() => engine.createRun(1, { ...CONFIG, roundTicks: RULES.countdownTicks }));
  const a = engine.advance(started(42), 600), b = engine.advance(started(42), 600), c = engine.advance(started(43), 600);
  assert.deepEqual(a, b); assert.notDeepEqual(a.play.waiting, c.play.waiting);
  assert.ok(a.play.waiting.length > 0 && a.play.jams.length > 0, 'fares and traffic arrive');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the state round-trips through JSON');
  let stepped = started(42); for (let t = 1; t <= 600; t += 7) stepped = engine.advance(stepped, t);
  assert.deepEqual(engine.advance(stepped, 600), a, 'many small advances = one big advance');
});

test('fares: none in the countdown; the first one street from the taxi; every kind in its wave; requests make sense', () => {
  assert.equal(engine.advance(started(5), OPEN - 1).play.waiting.length, 0, 'the countdown is empty');
  const first = engine.advance(started(5), OPEN + 1).play.waiting[0] as Fare;
  assert.ok(adjacent(first.from, RULES.start), 'the first fare waits one street away'); assert.equal(first.kind, 'ride');
  const firstWave = new Map<Kind, number>();
  for (let seed = 1; seed <= 30; seed++) {
    let run = started(seed);
    for (let t = OPEN; t < CONFIG.roundTicks; t += 20) {
      run = engine.advance(run, t);
      for (const f of run.play.waiting) {
        const w = engine.waveAt(run, t);
        if (!firstWave.has(f.kind) || (firstWave.get(f.kind) as number) > w) firstWave.set(f.kind, w);
        assert.ok(f.from !== f.to && ((HOPS[f.from] as number[])[f.to] as number) >= 2, 'a destination at least two streets away');
        if (f.kind === 'tour') assert.ok(f.via >= 0 && f.via !== f.from && f.via !== f.to); else assert.equal(f.via, -1);
      }
      for (let p = 0; p < N; p++) assert.ok(run.play.waiting.filter((f) => f.from === p).length <= RULES.perPlace);
      assert.equal(new Set(run.play.waiting.map((f) => f.panel)).size, run.play.waiting.length, 'one name waits once');
    }
  }
  assert.equal(firstWave.get('ride'), 0); assert.equal(firstWave.get('express'), 1); assert.equal(firstWave.get('gold'), 2); assert.equal(firstWave.get('tour'), 3);
});

test('difficulty ramps evenly from the first second to the last: more fares, less patience, less slack, more traffic', () => {
  const s = started(1), open = engine.openTickOf(s), end = open + RULES.playTicks;
  const at = (t: number, a: number, b: number): number => engine.ramp(s, t, a, b);
  assert.equal(at(open, RULES.spawnStart, RULES.spawnEnd), RULES.spawnStart); assert.equal(at(end, RULES.spawnStart, RULES.spawnEnd), RULES.spawnEnd);
  assert.equal(at(open - 30, RULES.patienceStart, RULES.patienceEnd), RULES.patienceStart); assert.equal(at(end + 99, RULES.patienceStart, RULES.patienceEnd), RULES.patienceEnd);
  for (let t = open + 1; t <= end; t++) {
    for (const [a, b] of [[RULES.spawnStart, RULES.spawnEnd], [RULES.patienceStart, RULES.patienceEnd], [RULES.slackStart, RULES.slackEnd], [RULES.jamEveryStart, RULES.jamEveryEnd]] as const) {
      const step = at(t, a, b) - at(t - 1, a, b);
      assert.ok(step === 0 || step === -1, 'never a jump');
    }
  }
  // seen in a real (idle) run: fares wait less at the end, more people wait at once, more jams at once
  let run = started(12), earlySpan = 0, lateSpan = 1e9, earlyCrowd = 0, lateCrowd = 0, lateJams = 0;
  for (let t = open; t < end; t += 5) {
    run = engine.advance(run, t);
    for (const f of run.play.waiting) if (f.kind === 'ride') { if (t < open + 300) earlySpan = Math.max(earlySpan, f.span); else if (t > open + 1500) lateSpan = Math.min(lateSpan, f.span); }
    if (t < open + 300) earlyCrowd = Math.max(earlyCrowd, run.play.waiting.length); else if (t > open + 1500) lateCrowd = Math.max(lateCrowd, run.play.waiting.length);
    if (t > open + 1500) lateJams = Math.max(lateJams, run.play.jams.length);
  }
  assert.ok(earlySpan > lateSpan + 100, `patience ${earlySpan} -> ${lateSpan}`);
  assert.ok(lateCrowd > earlyCrowd, `crowd ${earlyCrowd} -> ${lateCrowd}`);
  assert.ok(lateJams >= 3, `jams at the end ${lateJams}`);
});

test('the taxi drives the route street by street, picks up on the way and delivers at the destination', () => {
  // a passenger at CHIADO for ROSSIO; the taxi at BAIXA drives BAIXA -> CHIADO -> ROSSIO
  let s = scene([{ from: CHIADO, to: ROSSIO, until: 100_000 }]);
  s = route(s, [CHIADO, ROSSIO]);
  assert.deepEqual(s.play.taxi.route, [CHIADO, ROSSIO]);
  const toChiado = drive(BAIXA, CHIADO), toRossio = drive(CHIADO, ROSSIO);
  s = engine.advance(s, OPEN + toChiado);
  assert.equal(s.play.taxi.at, CHIADO); assert.deepEqual(whats(s), ['board']);
  assert.equal(s.play.riders.length, 1); assert.equal(s.play.waiting.length, 0);
  const rider = s.play.riders[0] as Fare;
  assert.equal(rider.span, engine.rideTicks(s, rider, CHIADO)); assert.equal(rider.until, s.tick + rider.span);
  s = engine.advance(s, OPEN + toChiado + toRossio + 1);
  assert.equal(s.play.taxi.at, ROSSIO); assert.deepEqual(whats(s), ['board', 'drop']);
  assert.equal(s.play.delivered, 1); assert.equal(s.play.riders.length, 0); assert.equal(s.play.combo, 1);
  const dropTick = (s.play.events.find((e) => e.what === 'drop') as { tick: number }).tick;
  assert.ok(dropTick <= OPEN + toChiado + toRossio + 1, 'downhill from CHIADO to ROSSIO');
  const tip = Math.floor(RULES.tipMax * (rider.until - dropTick) / rider.span);
  assert.equal(s.play.score, RULES.base.ride + RULES.perHop * ((HOPS[CHIADO] as number[])[ROSSIO] as number) + tip);
  assert.deepEqual(s.play.log, [{ panel: rider.panel, from: CHIADO, to: ROSSIO, gain: s.play.score }]);
});

test('a standing taxi picks up whoever appears at its place; three seats at most; the longest-waiting boards first', () => {
  let s = scene([
    { from: BAIXA, to: MARQUES, until: OPEN + 300 }, { from: BAIXA, to: 13, until: OPEN + 100 },
    { from: BAIXA, to: 5, until: OPEN + 200 }, { from: BAIXA, to: 1, until: OPEN + 400 },
  ], [{ from: ROSSIO, to: 13 }]);
  s = engine.advance(s, OPEN + 1);
  assert.equal(s.play.riders.length, RULES.seats);
  assert.deepEqual(s.play.riders.slice(1).map((f) => f.to), [13, 5], 'the most urgent first');
  assert.equal(s.play.waiting.length, 2);
});

test('a golden passenger: triple fare, less patience than a ride', () => {
  let g = scene([], [{ kind: 'gold', from: BAIXA, to: CHIADO, until: OPEN + 500, span: 500 }]);
  g = engine.advance(route(g, [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  assert.deepEqual(whats(g), ['drop']); assert.ok(g.play.score >= RULES.base.gold && RULES.base.gold === 3 * RULES.base.ride);
  for (let seed = 1; seed <= 40; seed++) {
    const run = engine.advance(started(seed), OPEN + 1500);
    for (const f of run.play.waiting.filter((x) => x.kind === 'gold')) assert.ok(f.span < engine.ramp(run, run.tick, RULES.patienceStart, RULES.patienceEnd) + 10);
  }
});

test('express: double fare, less time; tour: no drop-off before its stop, then a bigger fare', () => {
  let x = scene([], [{ kind: 'express', from: BAIXA, to: CHIADO, until: OPEN + 500, span: 500 }]);
  x = engine.advance(route(x, [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  assert.deepEqual(whats(x), ['drop']);
  assert.ok(x.play.score >= RULES.base.express);
  const ride = engine.rideTicks(x, { id: 1, panel: 1, kind: 'ride', from: BAIXA, to: MARQUES, via: -1, until: 0, span: 1 }, BAIXA);
  const express = engine.rideTicks(x, { id: 1, panel: 1, kind: 'express', from: BAIXA, to: MARQUES, via: -1, until: 0, span: 1 }, BAIXA);
  assert.ok(express < ride, `express ${express} < ride ${ride}`);
  // a tour from BAIXA to ROSSIO via CHIADO: driving straight BAIXA -> ROSSIO does not drop them
  let t = scene([], [{ kind: 'tour', from: BAIXA, to: ROSSIO, via: CHIADO, until: 100_000, span: 1000 }]);
  t = engine.advance(route(t, [ROSSIO]), OPEN + drive(BAIXA, ROSSIO));
  assert.equal(t.play.taxi.at, ROSSIO); assert.deepEqual(whats(t), []); assert.equal(t.play.riders.length, 1);
  t = engine.advance(route(t, [CHIADO, ROSSIO]), OPEN + drive(BAIXA, ROSSIO) + drive(ROSSIO, CHIADO) * 2 + 2);
  assert.deepEqual(whats(t), ['via', 'drop']);
  assert.ok(t.play.score >= RULES.base.tour + RULES.perHop * (((HOPS[BAIXA] as number[])[ROSSIO] as number) + 1));
});

test('penalties: a waiting passenger gives up (-50), a rider out of time jumps out (-100); both reset the combo; the score never goes below 0', () => {
  let s = scene([{ from: MARQUES, to: CAIS, until: OPEN + 10 }], [{ from: BAIXA, to: 13, until: OPEN + 20 }]);
  s = { ...s, play: { ...s.play, score: 120, combo: 4, bestCombo: 4 } };
  s = engine.advance(s, OPEN + 10);
  assert.deepEqual(whats(s), ['gaveup']); assert.equal(s.play.score, 120 - RULES.gaveUp); assert.equal(s.play.combo, 0); assert.equal(s.play.gaveUp, 1);
  s = engine.advance(s, OPEN + 20);
  assert.deepEqual(whats(s), ['gaveup', 'jumped']); assert.equal(s.play.score, 0, 'clamped at 0'); assert.equal(s.play.jumped, 1);
  assert.equal(s.play.riders.length, 0); assert.equal(s.play.bestCombo, 4);
  // a delivery on the very tick of the deadline still counts
  let late = scene([], [{ from: BAIXA, to: CHIADO, until: OPEN + drive(BAIXA, CHIADO) }]);
  late = engine.advance(route(late, [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  assert.deepEqual(whats(late), ['drop']);
});

test('the combo multiplies fares: x2 from the 3rd delivery in a row, x4 at most', () => {
  assert.deepEqual([0, 2, 3, 5, 6, 9, 30].map(engine.multOf), [1, 1, 2, 2, 3, 4, 4]);
  let s = scene([], [{ from: BAIXA, to: CHIADO }]);
  s = { ...s, play: { ...s.play, combo: 3, bestCombo: 3 } };
  s = engine.advance(route(s, [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  const e = s.play.events.at(-1);
  assert.equal(e?.what, 'drop'); assert.equal((e?.gain as number) % 2, 0); assert.ok((e?.gain as number) >= 2 * RULES.base.ride);
});

test('traffic: a jammed street is crawled at a quarter of the speed', () => {
  let s = scene([]);
  const edge = (EDGE[BAIXA] as number[])[CHIADO] as number;
  s = { ...s, play: { ...s.play, jams: [{ edge, until: 100_000 }] } };
  s = engine.advance(route(s, [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  assert.equal(s.play.taxi.to, CHIADO, 'still on the way');
  assert.equal(speedOn(BAIXA, CHIADO, true), Math.floor(speedOn(BAIXA, CHIADO) / RULES.jamDivisor));
  assert.equal(s.play.taxi.pos, speedOn(BAIXA, CHIADO, true) * drive(BAIXA, CHIADO));
  s = engine.advance(s, OPEN + Math.ceil((LENGTH[edge] as number) / speedOn(BAIXA, CHIADO, true)));
  assert.equal(s.play.taxi.at, CHIADO); assert.equal(s.play.taxi.to, -1);
});

test('hills: uphill streets are slow, downhill streets fast; the fastest way is not always the shortest', () => {
  const GRACA = 4;
  assert.ok(speedOn(ROSSIO, GRACA) < RULES.speed && speedOn(GRACA, ROSSIO) > RULES.speed, 'up to Graça is slow, down is fast');
  assert.equal(speedOn(CAIS, BAIXA), RULES.speed, 'flat by the river');
  assert.ok(((TIME[ROSSIO] as number[])[GRACA] as number) > ((TIME[GRACA] as number[])[ROSSIO] as number));
  for (let a = 0; a < N; a++) for (const b of NEIGHBOURS[a] as number[]) assert.ok(speedOn(a, b, true) >= 1 && speedOn(a, b, false, true) > speedOn(a, b));
  // the same street, driven up and down, in a real shift
  const up = engine.advance(route(scene([]), [ROSSIO]), OPEN + drive(BAIXA, ROSSIO));
  const climb = engine.advance(route(up, [GRACA]), OPEN + drive(BAIXA, ROSSIO) + drive(ROSSIO, GRACA) + 1);
  assert.equal(climb.play.taxi.at, GRACA);
  assert.ok(drive(ROSSIO, GRACA) > drive(GRACA, ROSSIO) * 2);
});

test('turbo: one charge at the start, ×1.7 for 2 s, one more per delivery (two at most); never two at once', () => {
  let s = scene([], [{ from: BAIXA, to: CHIADO }, { from: BAIXA, to: CAIS }]);
  assert.equal(s.play.boosts, RULES.boostStart);
  s = engine.applyInput(route(s, [CHIADO]), { action: 'boost' }, OPEN);
  assert.equal(s.play.boosts, 0); assert.equal(s.play.boostUntil, OPEN + RULES.boostTicks);
  const again = engine.applyInput(s, { action: 'boost' }, OPEN + 1);
  assert.equal(again.play.boostUntil, OPEN + RULES.boostTicks, 'no charge left, nothing changes');
  const one = engine.advance(s, OPEN + 1);
  assert.equal(one.play.taxi.pos, speedOn(BAIXA, CHIADO, false, true), 'boosted speed');
  const there = engine.advance(s, OPEN + drive(BAIXA, CHIADO));
  assert.deepEqual(whats(there), ['drop']); assert.equal(there.play.boosts, 1, 'a delivery charges one');
  let full = { ...there, play: { ...there.play, boosts: RULES.boostMax } };
  full = engine.advance(route(full, [CAIS]), there.tick + drive(CHIADO, CAIS) + 2);
  assert.ok(whats(full).filter((w) => w === 'drop').length === 2); assert.equal(full.play.boosts, RULES.boostMax, 'capped');
  // a running turbo cannot be stacked, and none before the shift opens
  const twice = engine.applyInput({ ...s, play: { ...s.play, boosts: 2 } }, { action: 'boost' }, OPEN + 5);
  assert.equal(twice.play.boosts, 2); assert.equal(twice.play.boostUntil, OPEN + RULES.boostTicks);
  assert.equal(engine.applyInput(started(3), { action: 'boost' }, OPEN - 1).play.boosts, RULES.boostStart);
});

test('shared ride: riders dropped together at the same place pay ×1.5 each', () => {
  const solo = engine.advance(route(scene([], [{ from: BAIXA, to: CHIADO }]), [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  const duo = engine.advance(route(scene([], [{ from: BAIXA, to: CHIADO }, { from: BAIXA, to: CHIADO, panel: 77 }]), [CHIADO]), OPEN + drive(BAIXA, CHIADO));
  const soloGain = solo.play.events.at(-1)?.gain as number;
  const duoGains = duo.play.events.filter((e) => e.what === 'drop').map((e) => e.gain);
  assert.equal(duoGains.length, 2); assert.equal(duo.play.shared, 2); assert.equal(solo.play.shared, 0);
  assert.equal(duoGains[0], Math.floor(soloGain * RULES.sharedNum / RULES.sharedDen));
  assert.ok((duoGains[1] as number) >= (duoGains[0] as number), 'the combo grows inside the shared ride');
});

test('routes: replaced by the next one, from the place the taxi drives to; an undrivable route is a no-op', () => {
  let s = scene([]);
  s = route(s, [CHIADO, ROSSIO, MARQUES]);
  s = engine.advance(s, OPEN + 2);
  assert.equal(s.play.taxi.to, CHIADO); assert.deepEqual(s.play.taxi.route, [ROSSIO, MARQUES]);
  const turned = route(s, [CAIS], OPEN + 3);
  assert.deepEqual(turned.play.taxi.route, [CAIS], 'replaced, starting from CHIADO');
  for (const bad of [[ROSSIO, CHIADO, MARQUES, 13], [BAIXA, BAIXA], [MARQUES], [CHIADO], [13]]) {
    if (bad.length === 1 && adjacent(CHIADO, bad[0] as number)) continue;
    assert.deepEqual(route(s, bad, OPEN + 3).play.taxi, engine.advance(s, OPEN + 3).play.taxi, JSON.stringify(bad));
  }
  assert.deepEqual(route(s, [], OPEN + 3).play.taxi.route, [], 'an empty route: stop at the next place');
  assert.equal(parseInput({ action: 'route', path: Array(RULES.routeMax + 1).fill(0) }), null);
});

test('the end: a fixed 90 s shift; the bonus rewards a good shift; a finished run never changes', () => {
  const idle = engine.advance(started(9), CONFIG.roundTicks);
  assert.equal(idle.gameOver, true); assert.equal(idle.play.end, 'time'); assert.equal(idle.tick, CONFIG.roundTicks);
  assert.equal(idle.play.score, 0); assert.equal(idle.play.bonus, 0); assert.ok(idle.play.gaveUp > 10);
  const never = engine.advance(engine.createRun(9, CONFIG), CONFIG.maxTicks);
  assert.equal(never.gameOver, true); assert.equal(never.play.end, 'horizon'); assert.equal(never.play.score, 0);
  const figures = (delivered: number, gaveUp: number, jumped: number) => ({ ...idle.play, delivered, gaveUp, jumped });
  assert.equal(shiftBonus(figures(4, 0, 0)), 0, 'too few deliveries');
  assert.equal(shiftBonus(figures(20, 1, 1)), 2500); assert.equal(satisfaction(figures(20, 1, 1)), 90);
  assert.equal(shiftBonus(figures(15, 3, 2)), 1200); assert.equal(shiftBonus(figures(10, 5, 5)), 500); assert.equal(shiftBonus(figures(5, 10, 0)), 0);
  const bot = playBot(77);
  assert.equal(bot.play.end, 'time');
  assert.equal(bot.play.bonus, shiftBonus(bot.play));
  assert.ok(bot.play.delivered >= 12 && bot.play.bonus > 0, `delivered ${bot.play.delivered}, bonus ${bot.play.bonus}`);
  console.log(`  the-lisbon-way bot (seed 77): score ${bot.play.score}, delivered ${bot.play.delivered}, gave up ${bot.play.gaveUp}, jumped ${bot.play.jumped}, satisfaction ${satisfaction(bot.play)}%, bonus ${bot.play.bonus}, best combo ${bot.play.bestCombo}`);
  assert.ok(JSON.stringify(bot).length < 8192);
  const after = engine.applyInput(bot, { action: 'route', path: [NEIGHBOURS[bot.play.taxi.at]?.[0] as number] }, bot.tick + 1);
  assert.deepEqual(after, bot, 'a finished run never changes');
});

test('start: routes before the start or during the countdown are no-ops; a second start does not move the clock', () => {
  const fresh = engine.createRun(3, CONFIG);
  assert.deepEqual(engine.applyInput(fresh, { action: 'route', path: [CHIADO] }, 2).play, fresh.play);
  const s = started(3);
  assert.deepEqual(route(s, [CHIADO], OPEN - 1).play.taxi.route, []);
  assert.equal(engine.applyInput(s, { action: 'start' }, 30).startTick, 0);
  assert.deepEqual(route(s, [CHIADO], OPEN).play.taxi.route, [CHIADO]);
});

test('forged inputs never score, move the taxi or change a fare', () => {
  const s = scene([{ from: CHIADO, to: ROSSIO }], [{ from: BAIXA, to: CHIADO, until: OPEN + 5 }]);
  const forged: unknown[] = [
    { action: 'route', path: [CHIADO], score: 999 }, { action: 'route', path: [14] }, { action: 'route', path: [-1] }, { action: 'route', path: [8.5] },
    { action: 'route', path: ['8'] }, { action: 'route', path: 8 }, { action: 'route' }, { action: 'route', path: [CHIADO], extra: 1 },
    { action: 'teleport', to: CHIADO }, { action: 'drop', id: 51 }, { action: 'start', x: 1 }, { action: 'deliver', fare: 51, gain: 9999 },
    { action: 'boost', times: 9 }, { action: 'boost', speed: 999 },
    null, 7, 'route', [], { score: 1e9 }, { action: 'route', path: Array(9).fill(CHIADO) },
  ];
  for (const input of forged) {
    const after = engine.advance(engine.applyInput(s, input, OPEN), OPEN + 5);
    assert.deepEqual(whats(after), ['jumped'], JSON.stringify(input));
    assert.equal(after.play.taxi.at, BAIXA); assert.equal(after.play.score, 0);
    assert.equal(parseInput(input), null);
    assert.equal(inputSchema.safeParse(input).success, false, 'the page refuses what the verifier refuses');
  }
  assert.ok(inputSchema.safeParse({ action: 'route', path: [CHIADO, ROSSIO] }).success);
  assert.ok(inputSchema.safeParse({ action: 'route', path: [] }).success);
});

test('checkState and the page schema refuse incoherent or tampered states (and agree)', () => {
  let s = engine.advance(started(4), 300);
  s = route(s, shortestPath(s.play.taxi.at, MARQUES));
  s = engine.advance(s, 330);
  assert.ok(s.play.waiting.length > 0 && s.play.taxi.to >= 0);
  assert.deepEqual(checkState(s), s); assert.equal(stateSchema.safeParse(s).success, true);
  const mutate = (f: (x: any) => void): unknown => { const c = structuredClone(s) as any; f(c); return c; };
  const bad = [
    mutate((x) => { x.extra = 1; }), mutate((x) => { x.play.extra = 1; }), mutate((x) => { x.play.score = -1; }), mutate((x) => { x.play.score = 1.5; }),
    mutate((x) => { x.play.taxi.at = 14; }), mutate((x) => { x.play.taxi.to = x.play.taxi.at; }), mutate((x) => { x.play.taxi.pos = 99_999; }),
    mutate((x) => { x.play.taxi.route = [13, 13]; }), mutate((x) => { x.play.taxi.extra = 1; }),
    mutate((x) => { x.play.waiting[0].kind = 'limo'; }), mutate((x) => { x.play.waiting[0].to = x.play.waiting[0].from; }),
    mutate((x) => { x.play.waiting[0].via = 3; x.play.waiting[0].kind = 'ride'; }), mutate((x) => { x.play.waiting[0].extra = 1; }),
    mutate((x) => { x.play.waiting.push({ ...x.play.waiting[0] }); }), mutate((x) => { x.play.waiting[0].id = x.play.nextId; }),
    mutate((x) => { x.play.waiting = Array(13).fill(x.play.waiting[0]); }), mutate((x) => { x.play.riders = Array(4).fill(x.play.waiting[0]); }),
    mutate((x) => { x.play.jams = [{ edge: 0, until: 9 }, { edge: 0, until: 9 }]; }), mutate((x) => { x.play.jams = [{ edge: 23, until: 9 }]; }),
    mutate((x) => { x.play.end = 'time'; }), mutate((x) => { x.play.combo = x.play.bestCombo + 1; }), mutate((x) => { x.started = false; }),
    mutate((x) => { x.tick = x.rules.maxTicks + 1; }), mutate((x) => { x.rules.game = 'gate-rush'; }), mutate((x) => { x.seed = -1; }),
    mutate((x) => { x.play.log = Array(25).fill({ panel: 1, from: 0, to: 1, gain: 1 }); }), mutate((x) => { x.play.bonus = x.play.score + 1; }),
    mutate((x) => { x.play.boosts = 3; }), mutate((x) => { x.play.boostUntil = x.tick + 999; }), mutate((x) => { x.play.shared = x.play.delivered + 1; }),
  ];
  for (const state of bad) {
    assert.throws(() => checkState(state), Error);
    assert.equal(stateSchema.safeParse(state).success, false);
  }
});

/** A fair bot: drives the shortest way around traffic to the nearest rider's next stop, or to the nearest waiting
 *  passenger while a seat is free; it plans when its route runs out. */
function botRoute(s: LwState): number[] | null {
  const t = s.play.taxi, from = t.to >= 0 ? t.to : t.at;
  if (t.route.length) return null;
  const goals = s.play.riders.map((f) => (f.via >= 0 ? f.via : f.to));
  if (s.play.riders.length < RULES.seats) goals.push(...s.play.waiting.map((f) => f.from));
  const near = goals.filter((g) => g !== from).sort((a, b) => ((DIST[from] as number[])[a] as number) - ((DIST[from] as number[])[b] as number))[0];
  if (near === undefined) return null;
  const jams = new Set(s.play.jams.map((j) => j.edge));
  return shortestPath(from, near, (e) => (jams.has(e) ? (LENGTH[e] as number) * 3 : 0)).slice(0, RULES.routeMax);
}
function playBot(seed: number): LwState {
  let s = started(seed);
  for (let t = 1; !s.gameOver && t <= CONFIG.maxTicks; t++) {
    s = engine.advance(s, t);
    const path = s.gameOver ? null : botRoute(s);
    if (path) s = engine.applyInput(s, { action: 'route', path }, t);
  }
  return s;
}

test('competitive: skill shows in the score (wandering < greedy < planning) and nobody gets the top bonus for free', () => {
  const jamCost = (s: LwState) => { const j = new Set(s.play.jams.map((x) => x.edge)); return (e: number) => (j.has(e) ? (LENGTH[e] as number) * 3 : 0); };
  const anchor = (s: LwState): number => (s.play.taxi.to >= 0 ? s.play.taxi.to : s.play.taxi.at);
  const eta = (a: number, b: number): number => (TIME[a] as number[])[b] as number;
  const wander = (s: LwState, rnd: () => number): number[] | null => {
    if (s.play.taxi.route.length) return null;
    const n = NEIGHBOURS[anchor(s)] as number[]; return [n[Math.floor(rnd() * n.length)] as number];
  };
  // replans every 10 ticks: fare per tick of driving, skips what it cannot reach in time, rushes urgent riders
  const planner = (s: LwState): number[] | null => {
    if (s.tick % 10 && s.play.taxi.route.length) return null;
    const from = anchor(s), worth = (k: Kind): number => (k === 'gold' ? 3 : k === 'express' ? 2 : 1);
    let best: number | null = null, bestV = -1;
    for (const f of s.play.riders) {
      const g = f.via >= 0 ? f.via : f.to, left = f.until - s.tick, need = eta(from, g) + (f.via >= 0 ? eta(f.via, f.to) : 0);
      const v = (left - need < 30 ? 5000 : 1000) / (1 + eta(from, g)) * worth(f.kind);
      if (left >= need && v > bestV) { bestV = v; best = g; }
    }
    if (s.play.riders.length < RULES.seats) for (const f of s.play.waiting) {
      if (f.until - s.tick < eta(from, f.from)) continue;
      const v = 600 * worth(f.kind) / (1 + eta(from, f.from) + eta(f.from, f.to) * 0.5);
      if (v > bestV) { bestV = v; best = f.from; }
    }
    if (best === null || best === from) return null;
    const path = shortestPath(from, best, jamCost(s)).slice(0, RULES.routeMax);
    return JSON.stringify(path) === JSON.stringify(s.play.taxi.route) ? null : path;
  };
  const run = (bot: (s: LwState, rnd: () => number) => number[] | null, seed: number) => {
    let s = started(seed); const rnd = mulberry32(seed);
    for (let t = 1; !s.gameOver && t <= CONFIG.maxTicks; t++) { s = engine.advance(s, t); const p = s.gameOver ? null : bot(s, rnd); if (p) s = engine.applyInput(s, { action: 'route', path: p }, t); }
    return s.play;
  };
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const seeds = [1, 7920, 15839, 23758, 31677, 39596, 47515, 55434, 63353];
  const results = { wander: seeds.map((s) => run(wander, s)), greedy: seeds.map((s) => run((x) => botRoute(x), s)), planner: seeds.map((s) => run(planner, s)) };
  const m = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, median(v.map((p) => p.score))])) as Record<keyof typeof results, number>;
  console.log(`  the-lisbon-way skill: median score wander ${m.wander}, greedy ${m.greedy}, planner ${m.planner}; planner satisfaction ${median(results.planner.map(satisfaction))}%`);
  assert.ok(m.wander < 1000 && m.greedy > m.wander + 1000 && m.planner > m.greedy * 1.3, JSON.stringify(m));
  assert.ok(results.planner.filter((p) => p.bonus === 2500).length <= seeds.length / 3, 'the top bonus stays hard to earn');
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

test('the-lisbon-way: the archive has Studio\'s root layout, the credit line, a zod-free verifier under 256 KB', async () => {
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
  // a web app on every device: manifest, home-screen icons, full screen
  const manifest = JSON.parse(strFromU8(files['assets/manifest.json'] as Uint8Array)) as { short_name: string; display: string; icons: { src: string }[] };
  assert.equal(manifest.short_name, 'THE LISBON WAY'); assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(files[`assets/${icon.src.slice(2)}`], icon.src);
  assert.equal(manifest.icons.length, 2);
  assert.ok(html.includes('rel="manifest" href="./assets/manifest.json"') && html.includes('apple-touch-icon') && html.includes('viewport-fit=cover'));
  const app = Object.entries(files).find(([name]) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name))?.[1] as Uint8Array;
  console.log(`  the-lisbon-way page bundle: ${(app.byteLength / 1024).toFixed(0)} KB (three.js included), verifier ${(verifier.byteLength / 1024).toFixed(0)} KB`);
  assert.ok(!strFromU8(app).includes('__ltPlaceOnScreen'), 'the dev-only hook is not in a published build');
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
  assert.equal((await post({ version: 1, op: 'score', state: { ...state, play: { ...state.play, score: 999_999, bonus: 0 }, tick: -1 } })).status, 400);
  assert.equal((await verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'GET' }))).status, 404);
  // time never moves backwards, a forged route does nothing
  const later = await post({ version: 1, op: 'applyInput', state, input: { action: 'start' }, serverTick: 10 });
  const s10 = (await later.json() as { result: LwState }).result;
  assert.equal((await post({ version: 1, op: 'advance', state: s10, serverTick: 9 })).status, 400);
  const forged = await post({ version: 1, op: 'applyInput', state: s10, input: { action: 'route', path: [13], score: 1e6 }, serverTick: 11 });
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
      const path = run.state.gameOver ? null : botRoute(run.state);
      // a fallible player: plans 1-3 ticks late, now and then sends a route that cannot be driven (a no-op)
      if (path && rnd() < 0.9) await send({ action: 'route', path }, run.tick + 1 + Math.floor(rnd() * 3));
      else if (rnd() < 0.01) await send({ action: 'route', path: [Math.floor(rnd() * N)] }, run.tick + 1);
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
    console.log(`  the-lisbon-way built verifier (seed ${seed}): ${run.calls} calls, score ${run.state.play.score}, delivered ${run.state.play.delivered}, satisfaction ${satisfaction(run.state.play)}%, largest state ${run.largestState} B`);
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
