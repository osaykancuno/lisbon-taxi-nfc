// THE LISBON WAY: the controls (display side): an arrow key, a swipe or a tap picks the street at the next corner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOST_KEYS, KEY_ANGLE, angleDiff, pickStreet, straightOn, swipeAngle, type Way } from '../src/games/the-lisbon-way/controls.js';
import { NEIGHBOURS, PLACES } from '../src/games/the-lisbon-way/map.js';

/** The streets out of a place on the flat map (screen = map: x right, y down). */
const waysFrom = (p: number): Way[] => (NEIGHBOURS[p] as number[]).map((n) => ({
  place: n, angle: Math.atan2((PLACES[n]?.y as number) - (PLACES[p]?.y as number), (PLACES[n]?.x as number) - (PLACES[p]?.x as number)),
}));
const MARQUES = 0, BAIXA = 11, ROSSIO = 3, CHIADO = 8, ALFAMA = 7, CAIS = 10, BELEM = 13, LX = 9;

test('keys: arrows and W A S D give the four screen directions; Space, Shift and Enter fire the turbo', () => {
  assert.equal(KEY_ANGLE.ArrowRight, 0); assert.equal(KEY_ANGLE.KeyD, 0);
  assert.equal(KEY_ANGLE.ArrowUp, -Math.PI / 2); assert.equal(KEY_ANGLE.KeyW, -Math.PI / 2);
  assert.equal(KEY_ANGLE.ArrowLeft, Math.PI); assert.equal(KEY_ANGLE.ArrowDown, Math.PI / 2);
  for (const k of ['Space', 'ShiftLeft', 'Enter']) assert.ok(BOOST_KEYS.has(k));
  assert.equal(KEY_ANGLE.Space, undefined);
});

test('a direction picks the street that points the closest to it, and nothing when no street goes that way', () => {
  const baixa = waysFrom(BAIXA);
  assert.equal(pickStreet(baixa, KEY_ANGLE.ArrowUp as number), ROSSIO);
  assert.equal(pickStreet(baixa, KEY_ANGLE.ArrowLeft as number), CAIS);
  assert.equal(pickStreet(baixa, KEY_ANGLE.ArrowRight as number), ALFAMA, 'up-right is the closest to right');
  assert.equal(pickStreet(baixa, -Math.PI / 4), ALFAMA, 'up-right (a diagonal swipe or tap)');
  assert.equal(pickStreet(baixa, -2), CHIADO, 'up-left');
  assert.equal(pickStreet(baixa, KEY_ANGLE.ArrowDown as number), null, 'the river: no street goes down from BAIXA');
  // every street out of every place can be reached by its own direction
  for (let p = 0; p < PLACES.length; p++) for (const w of waysFrom(p)) assert.equal(pickStreet(waysFrom(p), w.angle), w.place);
});

test('straight on: the taxi keeps its heading where a street continues straight, never back, and stops at a T-junction', () => {
  // down the Avenida, from MARQUÊS to ROSSIO: straight on is BAIXA
  const heading = Math.atan2((PLACES[ROSSIO]?.y as number) - (PLACES[MARQUES]?.y as number), (PLACES[ROSSIO]?.x as number) - (PLACES[MARQUES]?.x as number));
  assert.equal(straightOn(waysFrom(ROSSIO), heading, MARQUES), BAIXA);
  // from CAIS to BAIXA (east): every street turns more than 35°, the taxi waits for a choice
  assert.equal(straightOn(waysFrom(BAIXA), 0, CAIS), null);
  // driving from LX FACTORY down to BELÉM: no street continues that way, the taxi waits for a choice
  const down = Math.atan2((PLACES[BELEM]?.y as number) - (PLACES[LX]?.y as number), (PLACES[BELEM]?.x as number) - (PLACES[LX]?.x as number));
  assert.equal(straightOn(waysFrom(BELEM), down, LX), null);
  assert.equal(straightOn(waysFrom(BAIXA), Math.PI, ALFAMA), CAIS, 'from ALFAMA westwards: CAIS');
  assert.equal(straightOn(waysFrom(ROSSIO), -Math.PI / 2, BAIXA) !== BAIXA, true, 'never back where it came from');
});

test('swipes: a short touch is a tap, a longer one a direction; angles compare round the circle', () => {
  assert.equal(swipeAngle(5, 3), null);
  assert.equal(swipeAngle(0, -40), -Math.PI / 2);
  assert.equal(swipeAngle(40, 0), 0);
  assert.ok(Math.abs(angleDiff(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9);
  assert.equal(angleDiff(1, 1), 0);
});
