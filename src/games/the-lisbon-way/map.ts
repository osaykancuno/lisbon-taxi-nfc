// THE LISBON WAY: the map. A grid of Lisbon streets seen from above, 15 × 19 cells: a few blocks of houses, five tram
// stops, the depot, and the river along the bottom. The geometry is part of the rules (where the tram can go), so it lives
// here, shared by the page and the verifier.

export const COLS = 15;
export const ROWS = 19;
export const CELLS = COLS * ROWS;

/** `#` houses, `~` the river: the tram cannot go there. `.` streets. */
const LAYOUT = [
  '...............',
  '.##.........##.',
  '.##.........##.',
  '...............',
  '....###........',
  '....###....##..',
  '...........##..',
  '...............',
  '...##.....##...',
  '...##.....##...',
  '...............',
  '...............',
  '.##.........##.',
  '.##...###...##.',
  '......###......',
  '...............',
  '...............',
  '...............',
  '~~~~~~~~~~~~~~~',
] as const;

export const cellOf = (x: number, y: number): number => y * COLS + x;
export const xOf = (cell: number): number => cell % COLS;
export const yOf = (cell: number): number => Math.floor(cell / COLS);

/** Cells the tram can never enter (houses and the river). */
export const BLOCKED: readonly boolean[] = Array.from({ length: CELLS }, (_, c) => (LAYOUT[yOf(c)] as string)[xOf(c)] !== '.');
/** What a cell is drawn as (display only). */
export const TILE = (cell: number): 'street' | 'house' | 'river' => {
  const t = (LAYOUT[yOf(cell)] as string)[xOf(cell)];
  return t === '#' ? 'house' : t === '~' ? 'river' : 'street';
};

/** The five stops: a street cell each, a name and a colour. A rider gets off at the stop of their colour. */
export const STOPS = [
  { name: 'BELÉM', cell: cellOf(2, 16), color: '#F28C28' },
  { name: 'ESTRELA', cell: cellOf(0, 7), color: '#7A4FA3' },
  { name: 'GRAÇA', cell: cellOf(9, 1), color: '#2E9C4F' },
  { name: 'ALFAMA', cell: cellOf(14, 10), color: '#2E7FD6' },
  { name: 'BAIXA', cell: cellOf(10, 15), color: '#D64532' },
] as const;
export const STOP_COUNT = STOPS.length;
/** The stop at a cell, or -1. */
export const stopAt = (cell: number): number => STOPS.findIndex((s) => s.cell === cell);

/** Where the tram starts, and starts again after a crash (heading up). */
export const DEPOT = cellOf(7, 17);

/** Up, right, down, left (screen directions: y grows downwards). */
export const DIRS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const opposite = (dir: number): number => (dir + 2) % 4;
/** The cell one step away in a direction, or -1 off the grid. */
export function stepFrom(cell: number, dir: number): number {
  const [dx, dy] = DIRS[dir] as readonly [number, number];
  const x = xOf(cell) + dx, y = yOf(cell) + dy;
  return x < 0 || y < 0 || x >= COLS || y >= ROWS ? -1 : cellOf(x, y);
}
export const adjacent = (a: number, b: number): boolean => Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)) === 1;
export const distance = (a: number, b: number): number => Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b));

/** Street cells where people can appear: not a stop, not the depot or the two cells above it. */
export const SPAWNABLE: readonly number[] = Array.from({ length: CELLS }, (_, c) => c)
  .filter((c) => !BLOCKED[c] && stopAt(c) < 0 && c !== DEPOT && c !== DEPOT - COLS && c !== DEPOT - 2 * COLS);
