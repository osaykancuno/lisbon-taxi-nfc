// The paid-start / server-run state machine, with the game plugged in through its adapter. The first three tests are
// the upstream recovery regressions (studio-games-example/tests/recovery.test.ts) run unchanged against OUR shell;
// the rest cover what the adapter seam adds: prediction, snapshots, the start handshake and the stage hand-offs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PaidRound } from '../src/shell/paid-round.js';
import { lisbonWayAdapter } from '../src/games/the-lisbon-way/client.js';
import { engine as lwEngine, NEIGHBOURS, RULES, type LwState } from '../src/games/the-lisbon-way/engine.js';
import { scoringConfiguration } from '../src/shell/config.js';

const appId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const address = '0x1111111111111111111111111111111111111111';
const authorization = { appId, groupId, address };
const terms = { credits: 1, title: 'Integration test' };
type PaidRequest = { idempotencyKey: string; fingerprint: string; expectedCredits: number };
type RunRequest = { sessionToken: string; eventId: string; idempotencyKey: string };

const PaidRoundAny = PaidRound as unknown as new (options: any) => any;

class RoundHarness extends PaidRoundAny {
  saved: string[] = [];
  messages: string[] = [];
  save(): void { this.saved.push(JSON.stringify(this.state)); }
  clearActions(): void { /* DOM is irrelevant to protocol assertions. */ }
  announce(message: string): void { this.messages.push(message); }
  showRecoveryError(error: unknown): void { this.messages.push(error instanceof Error ? error.message : String(error)); }
  showRunError(error: unknown): void { this.messages.push(error instanceof Error ? error.message : String(error)); }
}
const base = { root: null, getBalance: () => ({ available: 10 }), getAddress: () => address, storageKey: 'test' };

test('uncertain paid start and server-run retry retain original keys, event, and session after reload', async () => {
  const paid: PaidRequest[] = []; const recovered: string[] = []; const runs: RunRequest[] = [];
  let round: any;
  const game = {
    getAuthorization: () => authorization,
    requestConsent: async (request: PaidRequest) => { assert.ok(round.saved.length, 'paid and run keys are saved before consent'); paid.push(request); return { consent: { token: 'test-only-consent' }, recovery: 'persistent' }; },
    startWithConsent: async (request: PaidRequest) => { paid.push(request); throw new Error('lost paid start response'); },
    recoverStart: async (request: { idempotencyKey: string }) => { recovered.push(request.idempotencyKey); return { session: { id: 'paid-session', token: 'test-only-session', expiresAt: '2099-01-01T00:00:00Z' }, game: {} }; },
  };
  const options = { ...base, adapter: lisbonWayAdapter, game, scoringGame: {
    startServerValidatedRun: async (request: RunRequest) => { runs.push(request); throw new Error('lost run response'); },
    getActiveScoringEvent: async () => { throw new Error('must not rediscover event during recovery'); },
  } };
  round = new RoundHarness(options);
  round.storageKey = round.accountStorageKey();
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(round.state.key, 'original-paid-key');
  assert.equal(paid.length, 2); assert.equal(paid[0]?.idempotencyKey, 'original-paid-key'); assert.equal(paid[1]?.idempotencyKey, 'original-paid-key');
  const originalRunKey = round.state.run.key;
  assert.match(originalRunKey, /^[0-9a-f]{64}$/);
  await round.recover();
  assert.deepEqual(recovered, ['original-paid-key']);
  assert.deepEqual(runs[0], { sessionToken: 'test-only-session', eventId, idempotencyKey: originalRunKey });
  const restored = new RoundHarness(options);
  restored.storageKey = restored.accountStorageKey();
  restored.state = lisbonWayAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) as string));
  await restored.recover();
  assert.equal(paid.length, 2, 'reload/recover must not request new consent or a new paid start');
  assert.equal(recovered.length, 1, 'known paid session is reused');
  assert.deepEqual(runs[1], runs[0], 'same event/run key/session are replayed, even when active-event discovery fails');
});

test('wallet replacement during consent never starts or transfers the old wallet play', async () => {
  let currentAddress = address; let starts = 0;
  const game = { getAuthorization: () => authorization,
    requestConsent: async () => { currentAddress = '0x2222222222222222222222222222222222222222'; return { consent: {} }; },
    startWithConsent: async () => { starts += 1; throw new Error('must never run'); } };
  const round: any = new RoundHarness({ ...base, adapter: lisbonWayAdapter, game, scoringGame: {}, getAddress: () => currentAddress });
  round.storageKey = round.accountStorageKey();
  const originalStorageKey = round.storageKey;
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(starts, 0); assert.equal(round.accountStorageKey(), null); assert.equal(round.storageKey, originalStorageKey);
  assert.equal(round.state.request.idempotencyKey, 'original-paid-key'); assert.ok(round.saved.length, 'original wallet recovery is retained');
  currentAddress = address.toUpperCase();
  assert.equal(round.accountStorageKey(), originalStorageKey, 'wallet boundary is case-insensitive');
});

test('memory-only consent never sends a paid start and retains the original attempt for recovery', async () => {
  let starts = 0, recoveries = 0, recovery = 'memory';
  const game = { getAuthorization: () => authorization,
    requestConsent: async () => ({ consent: { token: 'memory-only' }, recovery }),
    startWithConsent: async () => { starts += 1; throw new Error('Paid start must not run without durable consent'); },
    recoverStart: async () => { recoveries += 1; throw new Error('Lost recovery response'); } };
  const round: any = new RoundHarness({ ...base, adapter: lisbonWayAdapter, game, scoringGame: {} });
  round.storageKey = round.accountStorageKey();
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(starts, 0); assert.equal(round.state.key, 'original-paid-key'); assert.equal(round.state.phase, 'pending');
  assert.equal(lisbonWayAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) ?? 'null')).request && (lisbonWayAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) as string)) as any).request.idempotencyKey, 'original-paid-key');
  await round.recover();
  assert.equal(recoveries, 0, 'Continue must not bypass the failed durability check');
  recovery = 'persistent';
  await round.recover();
  assert.equal(recoveries, 1); assert.equal(round.state.request.idempotencyKey, 'original-paid-key');
});

/* ---- the adapter seam ---- */
const lwConfig = scoringConfiguration('the-lisbon-way');
const configDigest = 'a'.repeat(64);
const parse = (packet: unknown) => lisbonWayAdapter.snapshotSchema.parse(packet);
function playingRound(adapter: typeof lisbonWayAdapter, state0: unknown) {
  const sent: string[] = []; const stageCalls: string[] = [];
  const round: any = new RoundHarness({ ...base, adapter, game: { getAuthorization: () => authorization }, scoringGame: {} });
  round.storageKey = round.accountStorageKey();
  round.stage = { hideRun: () => stageCalls.push('hideRun'), setMessage: (text: string, extra?: unknown) => stageCalls.push(`setMessage:${text}:${JSON.stringify(extra ?? null)}`), showRun: () => stageCalls.push('showRun') };
  round.socket = { readyState: 1, send: (message: string) => sent.push(message), close: () => undefined };
  round.scoreNode = { textContent: '' };
  round.state = { version: 2, key: 'k', phase: 'playing', createdAt: Date.now(), request: { idempotencyKey: 'k', fingerprint: 'f', expectedCredits: 1 },
    session: { id: 's', token: 't', expiresAt: '2099-01-01T00:00:00Z' },
    run: { eventId, key: 'r'.repeat(64), runId, configDigest, serverTick: -1, inputSeq: 0, inputTick: -1, pendingInputs: [], view: state0 } };
  round.lastPacketAt = performance.now();
  const packet = (state: unknown, serverTick: number, extra: Record<string, unknown> = {}) => ({ runId, configDigest, serverTick, inputSeq: 0, inputTick: -1,
    expiresAt: '2099-01-01T00:00:00Z', state, result: null, ...extra });
  return { round, sent, stageCalls, packet };
}

test('a first snapshot of an unstarted run queues exactly one start, which is sent as an ordered input (no score, no time)', () => {
  const { round, sent, packet } = playingRound(lisbonWayAdapter, lwEngine.createRun(5, lwConfig));
  round.lastPacketAt = performance.now() - 120;
  round.acceptSnapshot(parse(packet(lwEngine.createRun(5, lwConfig), 3)));
  assert.equal(round.state.run.pendingInputs.length, 1);
  assert.deepEqual(round.state.run.pendingInputs[0].input, { action: 'start' });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0] as string), { type: 'input', seq: 1, input: { action: 'start' } });
  round.acceptSnapshot(parse(packet(lwEngine.createRun(5, lwConfig), 4)));
  assert.equal(round.state.run.pendingInputs.length, 1, 'the start is not queued twice');
});

test('prediction: a queued turn is applied where the player made it, then replaced by the next server snapshot', () => {
  const open = lwEngine.advance(lwEngine.applyInput(lwEngine.createRun(8, lwConfig), { action: 'start' }, 0), RULES.countdownTicks + 2);
  const { round, sent, packet } = playingRound(lisbonWayAdapter, open);
  round.acceptSnapshot(parse(packet(open, open.tick)));
  const next = (NEIGHBOURS[open.play.taxi.at] as number[])[0] as number;
  round.lastPacketAt = performance.now() - 200;                    // ~4 ticks after that snapshot
  round.userInput({ action: 'route', path: [next] });
  assert.deepEqual(round.predictedView.play.taxi.route, [next], 'the turn shows immediately');
  assert.ok(round.predictedView.tick >= open.tick + 3, 'applied at the player\'s own tick, not before the snapshot');
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0] as string).input, { action: 'route', path: [next] });
  // the server accepted it as input #1 a few ticks later: its snapshot replaces the guess and clears the queue
  const accepted = lwEngine.applyInput(open, { action: 'route', path: [next] }, open.tick + 6) as LwState;
  round.acceptSnapshot(parse(packet(accepted, accepted.tick + 1, { inputSeq: 1, inputTick: accepted.tick })));
  assert.equal(round.state.run.pendingInputs.length, 0);
  assert.deepEqual(round.predictedView.play.taxi, accepted.play.taxi, 'the server\'s taxi, with the turn queued');
  assert.deepEqual(accepted.play.taxi.route, [next]);
  // refused once the round is finishing
  round.state.phase = 'finalizing'; round.userInput({ action: 'boost' });
  assert.equal(sent.length, 1, 'inputs are dropped once the round is finishing');
});

test('a terminal snapshot with the platform result finalizes the round and hands the official score to the stage', () => {
  const started = lwEngine.applyInput(lwEngine.createRun(8, lwConfig), { action: 'start' }, 0);
  const over = lwEngine.advance(started, lwConfig.roundTicks);
  assert.equal(over.gameOver, true); assert.equal(over.play.score, 0, 'an idle shift scores nothing');
  const { round, stageCalls, packet } = playingRound(lisbonWayAdapter, started);
  (round as any).submitAndComplete = async () => undefined;       // completion is the SDK's business, not under test here
  round.acceptSnapshot(parse(packet(over, over.tick, { result: { runId, score: '0', status: 'completed' } })));
  assert.equal(round.state.phase, 'finalizing'); assert.equal(round.state.result.score, 0);
  assert.ok(stageCalls.some((call) => call.startsWith('setMessage:Server-verified score: 0.')), stageCalls.join(' | '));
  assert.equal(round.socket, null, 'the socket is released');
});

test('snapshots of another run, another verifier or another game are refused', () => {
  const state0 = lwEngine.createRun(3, lwConfig);
  const { round, packet } = playingRound(lisbonWayAdapter, state0);
  assert.throws(() => round.acceptSnapshot({ ...packet(state0, 2), runId: '55555555-5555-4555-8555-555555555555' }), /different run or verifier/);
  assert.throws(() => round.acceptSnapshot({ ...packet(state0, 2), configDigest: 'b'.repeat(64) }), /different run or verifier/);
  const otherGame = { ...state0, rules: { ...state0.rules, game: 'gate-rush' } };
  assert.throws(() => parse(packet(otherGame, 2)));
});
