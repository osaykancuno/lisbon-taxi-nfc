// The controls, as pure functions (display side: the rules only ever see { action: 'turn', dir }). Directions are on
// screen: 0 up, 1 right, 2 down, 3 left. An arrow key (or W A S D) or a swipe gives one; a tap turns towards the side
// of the tram where the finger is (left or right of it when it goes up or down, above or below it when it goes sideways).

export const KEY_DIR: Readonly<Record<string, number>> = {
  ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3,
};

/** A swipe's direction (the axis it moved most along), or null when the finger barely moved (then it is a tap). */
export function swipeDir(dx: number, dy: number, minLength = 24): number | null {
  if (Math.hypot(dx, dy) < minLength) return null;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
}
/** A tap at (dx, dy) from the tram's head, while it heads `dir`: a turn to that side. */
export function tapDir(dx: number, dy: number, dir: number): number {
  return dir === 0 || dir === 2 ? (dx >= 0 ? 1 : 3) : (dy >= 0 ? 2 : 0);
}
