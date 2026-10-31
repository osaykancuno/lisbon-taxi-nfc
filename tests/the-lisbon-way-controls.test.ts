// THE LISBON WAY: the controls (display side): an arrow key, a swipe or a tap gives the tram's next turn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_DIR, swipeDir, tapDir } from '../src/games/the-lisbon-way/controls.js';

const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;

test('keys: the arrows and W A S D give the four directions on screen', () => {
  assert.equal(KEY_DIR.ArrowUp, UP); assert.equal(KEY_DIR.KeyW, UP);
  assert.equal(KEY_DIR.ArrowRight, RIGHT); assert.equal(KEY_DIR.KeyD, RIGHT);
  assert.equal(KEY_DIR.ArrowDown, DOWN); assert.equal(KEY_DIR.KeyS, DOWN);
  assert.equal(KEY_DIR.ArrowLeft, LEFT); assert.equal(KEY_DIR.KeyA, LEFT);
  assert.equal(KEY_DIR.Space, undefined);
});

test('swipes: the axis the finger moved most along; a short touch is a tap', () => {
  assert.equal(swipeDir(5, 3), null);
  assert.equal(swipeDir(0, -40), UP); assert.equal(swipeDir(40, 10), RIGHT); assert.equal(swipeDir(-8, 50), DOWN); assert.equal(swipeDir(-60, -30), LEFT);
});

test('taps: the side of the tram the finger is on', () => {
  // going up or down: left or right of the tram
  assert.equal(tapDir(50, -200, UP), RIGHT); assert.equal(tapDir(-5, 300, DOWN), LEFT);
  // going sideways: above or below the tram
  assert.equal(tapDir(-300, -20, RIGHT), UP); assert.equal(tapDir(200, 40, LEFT), DOWN);
});
