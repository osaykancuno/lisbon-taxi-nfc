// THE LISBON WAY: the map. A stylised Lisbon of 14 places joined by 23 streets, the river at the bottom. The geometry
// is part of the rules (street lengths decide travel times), so it lives here, shared by the page and the verifier.
// Coordinates are map pixels in a 400 × 440 box; a street's length is its straight length × 10 (Math.sqrt is correctly
// rounded in every JS engine, and the result is rounded to an integer once, at load).

export type Place = {
  /** Short label on the map. */
  name: string;
  x: number; y: number;
  /** What a passenger wants there (display only). */
  wishes: readonly string[];
  /** Pin colour (display only). */
  color: string;
  /** How high the place is (0 by the river, 4 on top of a hill): uphill streets are slow, downhill streets fast. */
  h: number;
};

export const PLACES: readonly Place[] = [
  { name: 'MARQUÊS', h: 2, x: 200, y: 30, color: '#3E8E5A', wishes: ['Marquês, quickly', 'Shopping on the Avenida', 'Meeting at the roundabout'] },
  { name: 'NFC SUMMIT', h: 1, x: 360, y: 40, color: '#2E7FD6', wishes: ["I'm late for my talk!", 'NFC Summit, please', 'Badge pick-up!'] },
  { name: 'PRÍNCIPE REAL', h: 3, x: 110, y: 110, color: '#7A4FA3', wishes: ['Brunch in Príncipe Real', 'The garden, please', 'Vintage shopping'] },
  { name: 'ROSSIO', h: 0, x: 230, y: 150, color: '#D2693C', wishes: ['A ginjinha at Rossio', 'Meet me at the fountain', 'The train station'] },
  { name: 'GRAÇA', h: 4, x: 340, y: 150, color: '#E86A92', wishes: ['Sunset at the miradouro', 'Up the hill, please', 'Best view in town'] },
  { name: 'ESTRELA', h: 2, x: 30, y: 190, color: '#5C6B78', wishes: ['The basilica, please', 'Picnic in the park', 'Tram 28 stop'] },
  { name: 'BAIRRO ALTO', h: 3, x: 130, y: 220, color: '#C2352B', wishes: ['Party in Bairro Alto!', 'One more drink', 'Where the music is'] },
  { name: 'ALFAMA', h: 2, x: 320, y: 260, color: '#1F5FA8', wishes: ['Fado night in Alfama', 'Lost in the alleys', 'Sardines, now'] },
  { name: 'CHIADO', h: 2, x: 200, y: 260, color: '#8E6B3E', wishes: ['A bica in Chiado', 'The old bookshop', 'Gallery opening'] },
  { name: 'LX FACTORY', h: 0, x: 60, y: 320, color: '#D9A62E', wishes: ['LX Factory, the bookshop', 'Studio visit', 'Rooftop at LX'] },
  { name: 'CAIS DO SODRÉ', h: 0, x: 150, y: 350, color: '#E0457B', wishes: ['Pink Street!', 'The food market', 'The ferry, hurry'] },
  { name: 'BAIXA', h: 0, x: 240, y: 350, color: '#2E9C9C', wishes: ['Praça do Comércio', 'The arch, please', 'Riverside walk'] },
  { name: 'SANTA APOLÓNIA', h: 0, x: 370, y: 360, color: '#6B8E23', wishes: ['Catch the train!', 'Station, quick', 'The flea market'] },
  { name: 'BELÉM', h: 0, x: 20, y: 410, color: '#B5462F', wishes: ['Pastéis de nata!', 'The tower, please', 'Monastery tour'] },
];
export const N = PLACES.length;

/** Streets, as pairs of places (both ways). */
export const STREETS: readonly (readonly [number, number])[] = [
  [0, 2], [0, 3], [0, 1], [1, 4], [1, 12], [2, 6], [2, 5], [3, 4], [3, 8], [3, 11], [4, 7], [5, 6],
  [5, 9], [6, 8], [6, 10], [8, 11], [8, 10], [7, 11], [7, 12], [9, 10], [9, 13], [13, 10], [10, 11],
];
export const E = STREETS.length;

/** Street index between two places, or -1. */
export const EDGE: readonly (readonly number[])[] = (() => {
  const m = Array.from({ length: N }, () => Array<number>(N).fill(-1));
  STREETS.forEach(([a, b], i) => { (m[a] as number[])[b] = i; (m[b] as number[])[a] = i; });
  return m;
})();
export const adjacent = (a: number, b: number): boolean => a !== b && (EDGE[a]?.[b] ?? -1) >= 0;
export const NEIGHBOURS: readonly (readonly number[])[] = PLACES.map((_, a) => PLACES.map((__, b) => b).filter((b) => adjacent(a, b)));

/** Street lengths (map px × 10, integers). */
export const LENGTH: readonly number[] = STREETS.map(([a, b]) => {
  const p = PLACES[a] as Place, q = PLACES[b] as Place;
  const dx = p.x - q.x, dy = p.y - q.y;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 10);
});

/** Shortest distance between every two places (Floyd–Warshall on the integer lengths). */
export const DIST: readonly (readonly number[])[] = (() => {
  const INF = 1e12;
  const d = Array.from({ length: N }, (_, a) => Array.from({ length: N }, (__, b) => (a === b ? 0 : INF)));
  STREETS.forEach(([a, b], i) => { (d[a] as number[])[b] = LENGTH[i] as number; (d[b] as number[])[a] = LENGTH[i] as number; });
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const via = (d[i] as number[])[k] as number + ((d[k] as number[])[j] as number);
    if (via < ((d[i] as number[])[j] as number)) (d[i] as number[])[j] = via;
  }
  return d;
})();

/** Fewest streets between every two places (breadth-first). */
export const HOPS: readonly (readonly number[])[] = PLACES.map((_, from) => {
  const hops = Array<number>(N).fill(-1);
  hops[from] = 0;
  const queue = [from];
  while (queue.length) {
    const a = queue.shift() as number;
    for (const b of NEIGHBOURS[a] as number[]) if (hops[b] === -1) { hops[b] = (hops[a] as number) + 1; queue.push(b); }
  }
  return hops;
});

/**
 * The shortest route from `from` to `to` (the places after `from`, `to` included), by length. `slow` gives an extra
 * cost per street (the page uses it to suggest a way around traffic; the rules never call it). Empty when from === to.
 */
export function shortestPath(from: number, to: number, slow: (edge: number) => number = () => 0): number[] {
  if (from === to) return [];
  const best = Array<number>(N).fill(Infinity), prev = Array<number>(N).fill(-1), done = Array<boolean>(N).fill(false);
  best[from] = 0;
  for (;;) {
    let a = -1;
    for (let i = 0; i < N; i++) if (!done[i] && (a < 0 || (best[i] as number) < (best[a] as number))) a = i;
    if (a < 0 || best[a] === Infinity || a === to) break;
    done[a] = true;
    for (const b of NEIGHBOURS[a] as number[]) {
      const e = (EDGE[a] as number[])[b] as number;
      const cost = (best[a] as number) + (LENGTH[e] as number) + slow(e);
      if (cost < (best[b] as number)) { best[b] = cost; prev[b] = a; }
    }
  }
  if (prev[to] === -1) return [];
  const path: number[] = [];
  for (let at = to; at !== from; at = prev[at] as number) path.unshift(at);
  return path;
}
