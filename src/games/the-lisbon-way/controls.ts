// The controls, as pure functions (display side only: the rules never see an angle). The player steers with a direction:
// an arrow key (or W A S D), a swipe, or a tap/click towards where they want to go from the taxi. At the next corner the
// taxi takes the street that points the closest to that direction ON SCREEN; with no new direction it goes straight on
// when a street continues straight, and stops at the corner otherwise (a T-junction asks for a choice).

/** A street out of the next corner: the place it leads to, and its direction on screen (radians, 0 = right, y down). */
export type Way = { place: number; angle: number };

/** Directions of the keys, on screen. */
export const KEY_ANGLE: Readonly<Record<string, number>> = {
  ArrowRight: 0, KeyD: 0, ArrowDown: Math.PI / 2, KeyS: Math.PI / 2, ArrowLeft: Math.PI, KeyA: Math.PI, ArrowUp: -Math.PI / 2, KeyW: -Math.PI / 2,
};
/** Keys that fire the turbo. */
export const BOOST_KEYS: ReadonlySet<string> = new Set(['Space', 'ShiftLeft', 'ShiftRight', 'Enter']);

/** The smallest difference between two angles, 0..π. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  return d;
}
/** The street closest to the wanted direction, within `maxDiff` (a little over 60°); null when none goes that way. */
export function pickStreet(ways: readonly Way[], wanted: number, maxDiff = 1.1): number | null {
  let best: Way | null = null;
  for (const w of ways) if (!best || angleDiff(w.angle, wanted) < angleDiff(best.angle, wanted)) best = w;
  return best && angleDiff(best.angle, wanted) <= maxDiff ? best.place : null;
}
/** Straight on: the street that continues the taxi's heading within `maxDiff` (35°), never back where it came from. */
export function straightOn(ways: readonly Way[], heading: number, cameFrom: number, maxDiff = 0.62): number | null {
  const ahead = ways.filter((w) => w.place !== cameFrom);
  const pick = pickStreet(ahead, heading, maxDiff);
  return pick;
}
/** A swipe's direction, or null when the finger barely moved (then it is a tap). */
export function swipeAngle(dx: number, dy: number, minLength = 24): number | null {
  return Math.hypot(dx, dy) < minLength ? null : Math.atan2(dy, dx);
}
