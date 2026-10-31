// THE LISBON WAY: the map in 3D (display only). A low-poly diorama of the same Lisbon the rules use (map.ts): streets,
// pastel houses with terracotta roofs, a few landmarks, the Tagus and its red bridge, a yellow tram, the black-and-green
// taxi and the people of the wall waiting as sprites. It draws a state; it never changes one. The page keeps drawing the
// HUD, the seats, the labels and the bubbles on a 2D canvas above it, at the places this scene projects to the screen.
//
// Every device: three.js needs WebGL2. createScene3D returns null when it is not there (or fails), and the page keeps its
// 2D map; a lost WebGL context or a device too slow for it reports `failed` and the page falls back the same way.
import {
  AmbientLight, BoxGeometry, MeshBasicMaterial, DoubleSide, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Fog, Group,
  HemisphereLight, InstancedMesh, Mesh, MeshLambertMaterial, NearestFilter, Object3D, PerspectiveCamera, PlaneGeometry,
  SRGBColorSpace, Scene, Sprite, SpriteMaterial, TorusGeometry, Vector3, WebGLRenderer,
} from 'three';
import { mulberry32 } from '../../common/det.js';
import { EDGE, LENGTH, N, PLACES, STREETS } from './map.js';
import { RULES, speedOn, type LwState } from './core.js';

/** World units: 10 map px per unit, the map's centre at the origin, the river towards the camera (+z). */
export const wx = (x: number): number => (x - 200) / 10;
export const wz = (y: number): number => (y - 220) / 10;
const placeW = (p: number): Vector3 => new Vector3(wx(PLACES[p]?.x ?? 0), 0, wz(PLACES[p]?.y ?? 0));
const RIVER_Z = 23.2;

export type DrawPerson = (g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number, dir: number) => void;
/** The taxi in map px; `angle` is its heading, null when it stands (the last heading is kept). */
export type Car = { x: number; z: number; angle: number | null };
export type Scene3D = {
  /** The map band's size on screen (CSS px) and the device pixel ratio. */
  resize(width: number, height: number, dpr: number): void;
  /** Draws one frame. `car` is the taxi (map px), `people` the waiting passengers' names by place, in order, `shake`
   *  0..1 shakes the camera. */
  render(s: LwState | null, car: Car, people: Map<number, { name: string; step: number }[]>, now: number, shake?: number): void;
  /** A world point on the screen, in the band's own 0..1 coordinates. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  /** True once the 3D view cannot go on (context lost, or too slow): the page switches to 2D. */
  readonly failed: boolean;
  /** People's sprites changed (people.json or a sheet arrived): rebuild their textures. */
  refreshPeople(): void;
  dispose(): void;
};

/** WebGL2, or nothing (three.js r163+ draws with WebGL2 only). */
export function webgl2Available(): boolean {
  try { return Boolean(document.createElement('canvas').getContext('webgl2')); } catch { return false; }
}

const WALLS = ['#F2E3C6', '#F4C7C3', '#CFE0EA', '#F6E7A8', '#E8E1D5', '#D8E8CF', '#F2F0EB', '#E9C9A0'];
const ROOFS = ['#C8553D', '#B5462F', '#D2693C', '#A9442E'];
const INK = '#0B0B0B', CHALK = '#F2F0EB', RED = '#D64532', TRAM = '#F2C230', GREEN = '#3E8E5A', BLUE = '#2E7FD6';

export function createScene3D(canvas: HTMLCanvasElement, drawPerson: DrawPerson): Scene3D | null {
  if (!webgl2Available()) return null;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
  } catch { return null; }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color('#DEDBD3'));
  let failed = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); failed = true; });

  const scene = new Scene();
  scene.fog = new Fog('#DEDBD3', 80, 140);
  const camera = new PerspectiveCamera(46, 420 / 510, 1, 220);
  camera.position.set(0, 58, 40);
  camera.lookAt(0, 0, 4);
  scene.add(new HemisphereLight('#FFF8EC', '#B9AE9A', 1.6), new AmbientLight('#FFFFFF', 0.35));
  const sun = new DirectionalLight('#FFE9C7', 1.6);
  sun.position.set(-25, 40, 18);
  scene.add(sun);

  const lambert = (color: string): MeshLambertMaterial => new MeshLambertMaterial({ color });
  const box = new BoxGeometry(1, 1, 1);
  const add = (geometry: BoxGeometry | CylinderGeometry | ConeGeometry | PlaneGeometry | TorusGeometry, color: string, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, ry = 0): Mesh => {
    const m = new Mesh(geometry, lambert(color));
    m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.y = ry;
    scene.add(m);
    return m;
  };

  /* ground and river */
  const ground = add(new PlaneGeometry(140, 80), '#DCD6C8', 0, 0, RIVER_Z - 40);
  ground.rotation.x = -Math.PI / 2;
  const river = add(new PlaneGeometry(160, 60), '#2E7FD6', 0, -0.05, RIVER_Z + 30);
  river.rotation.x = -Math.PI / 2;
  add(box, '#BFB6A4', 0, 0.1, RIVER_Z, 160, 0.3, 0.6);                    // the quay
  const waves = new InstancedMesh(box, lambert('#9CC3EC'), 60);
  scene.add(waves);
  // the red bridge, on the left, and the tram
  for (const z of [RIVER_Z + 3, RIVER_Z + 11]) add(box, '#C2352B', -15.5, 4, z, 0.8, 8, 0.8);
  add(box, '#C2352B', -15.5, 2.4, RIVER_Z + 9, 1.6, 0.35, 20);
  add(box, '#C2352B', -15.5, 7.6, RIVER_Z + 7, 0.25, 0.25, 9);

  /* streets: an ink kerb under a chalk road; jams lay red over them */
  const jamTop: Mesh[] = [];
  STREETS.forEach(([a, b]) => {
    const p = placeW(a), q = placeW(b), len = p.distanceTo(q), angle = -Math.atan2(q.z - p.z, q.x - p.x);
    const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
    add(box, INK, mx, 0.04, mz, len, 0.08, 1.5, angle);
    add(box, CHALK, mx, 0.1, mz, len, 0.08, 1.05, angle);
    const jam = add(box, RED, mx, 0.16, mz, len, 0.06, 1.07, angle);
    jam.visible = false;
    jamTop.push(jam);
  });
  const jamCars = new InstancedMesh(box, lambert('#FFFFFF'), 120);
  jamCars.count = 0;
  scene.add(jamCars);

  /* houses: deterministic blocks wherever there is no street, place or river */
  const segDist = (x: number, z: number, a: Vector3, b: Vector3): number => {
    const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
  };
  const hills = [[110, 120], [330, 160], [130, 230], [40, 190], [230, 150], [320, 260], [200, 40]].map(([x, y]) => [wx(x as number), wz(y as number)] as const);
  const rnd = mulberry32(2027);
  const spots: { x: number; z: number; w: number; d: number; h: number }[] = [];
  for (let gz = -26; gz < RIVER_Z - 1; gz += 2.3) for (let gx = -30; gx <= 30; gx += 2.3) {
    const x = gx + (rnd() - 0.5) * 0.8, z = gz + (rnd() - 0.5) * 0.8;
    if (STREETS.some(([a, b]) => segDist(x, z, placeW(a), placeW(b)) < 1.9)) continue;
    if (PLACES.some((_, p) => placeW(p).distanceTo(new Vector3(x, 0, z)) < 3.2)) continue;
    const hill = Math.max(0, ...hills.map(([hx, hz]) => 1 - Math.hypot(x - hx, z - hz) / 9));
    spots.push({ x, z, w: 1.2 + rnd() * 0.6, d: 1.2 + rnd() * 0.6, h: 0.9 + rnd() * 1.1 + hill * 1.6 });
  }
  const walls = new InstancedMesh(box, lambert('#FFFFFF'), spots.length);
  const roofs = new InstancedMesh(new ConeGeometry(0.72, 0.6, 4), lambert('#FFFFFF'), spots.length);
  const dummy = new Object3D();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.h / 2, s.z); dummy.scale.set(s.w, s.h, s.d); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix); walls.setColorAt(i, new Color(WALLS[i % WALLS.length] as string));
    dummy.position.set(s.x, s.h + 0.3, s.z); dummy.scale.set(s.w * 1.05, 1, s.d * 1.05); dummy.rotation.set(0, Math.PI / 4, 0); dummy.updateMatrix();
    roofs.setMatrixAt(i, dummy.matrix); roofs.setColorAt(i, new Color(ROOFS[(i * 7) % ROOFS.length] as string));
  });
  scene.add(walls, roofs);

  /* places: a pillar in the place's colour; a few landmarks behind their pin */
  const rings: Mesh[] = [];
  const cyl = new CylinderGeometry(0.75, 0.85, 1.2, 20);
  for (let p = 0; p < N; p++) {
    const w = placeW(p), color = PLACES[p]?.color ?? INK;
    add(cyl, INK, w.x, 0.5, w.z, 1.18, 0.9, 1.18); add(cyl, color, w.x, 0.75, w.z);
    add(new CylinderGeometry(0.35, 0.35, 0.1, 16), CHALK, w.x, 1.38, w.z);
    const ring = add(new TorusGeometry(1.5, 0.16, 8, 32), color, w.x, 0.3, w.z);
    ring.rotation.x = -Math.PI / 2; ring.visible = false;
    rings.push(ring);
  }
  // light beams over the places where riders go next, seen from anywhere on the map
  const beams: Mesh[] = PLACES.map((pl, p) => {
    const w = placeW(p);
    const m = new Mesh(new CylinderGeometry(0.9, 0.9, 30, 16, 1, true), new MeshBasicMaterial({ color: pl.color, transparent: true, opacity: 0.3, depthWrite: false, side: DoubleSide }));
    m.position.set(w.x, 15, w.z); m.visible = false; scene.add(m);
    return m;
  });
  const at = (p: number, dx: number, dz: number): [number, number] => { const w = placeW(p); return [w.x + dx, w.z + dz]; };
  { const [x, z] = at(13, 0.4, 2.6); add(box, '#EDE6D3', x, 1.6, z, 1.3, 3.2, 1.3); add(box, '#EDE6D3', x, 3.6, z, 0.9, 0.8, 0.9); }      // Belém tower
  { const [x, z] = at(11, 0, 2.6); add(box, CHALK, x - 1.1, 1.4, z, 0.6, 2.8, 0.7); add(box, CHALK, x + 1.1, 1.4, z, 0.6, 2.8, 0.7); add(box, CHALK, x, 3, z, 3, 0.6, 0.8); } // the arch
  { const [x, z] = at(0, 0, -2.4); add(box, CHALK, x, 2.4, z, 0.5, 4.8, 0.5); add(box, '#5C6B78', x, 5.1, z, 0.7, 0.7, 0.7); }           // Marquês column
  { const [x, z] = at(7, 1.8, -1.8); add(box, '#CDBFA6', x, 0.8, z, 3, 1.6, 2.2); for (const dx of [-1.2, 0, 1.2]) add(box, '#CDBFA6', x + dx, 1.85, z - 1, 0.5, 0.5, 0.3); } // castle
  { const [x, z] = at(9, -2.2, -0.6); add(box, '#B5654A', x, 0.9, z, 2.4, 1.8, 1.8); add(cyl, '#8E4A36', x + 0.8, 2.6, z, 0.4, 2.4, 0.4); } // LX Factory
  { const [x, z] = at(1, 0.6, -2.6); add(box, BLUE, x, 1.2, z, 3.4, 2.4, 2.2); add(box, CHALK, x, 2.5, z, 3.6, 0.2, 2.4); }              // the summit
  { const [x, z] = at(12, 0, 2.4); add(box, '#E8DDC8', x, 0.9, z, 3.6, 1.8, 1.2); }                                                     // the station

  /* the taxi: black with a green roof and its light */
  const taxi = new Group();
  const part = (color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    const m = new Mesh(box, lambert(color)); m.position.set(x, y, z); m.scale.set(sx, sy, sz); taxi.add(m);
  };
  part(INK, 0, 0.45, 0, 2, 0.55, 1.05);
  part(GREEN, -0.1, 0.9, 0, 1.05, 0.4, 0.95);
  part(TRAM, -0.1, 1.2, 0, 0.35, 0.18, 0.5);
  part('#FFF5D6', 1.0, 0.5, 0.33, 0.06, 0.16, 0.22); part('#FFF5D6', 1.0, 0.5, -0.33, 0.06, 0.16, 0.22);
  part(RED, -1.0, 0.5, 0.33, 0.06, 0.14, 0.2); part(RED, -1.0, 0.5, -0.33, 0.06, 0.14, 0.2);
  for (const [x, z] of [[0.6, 0.55], [0.6, -0.55], [-0.6, 0.55], [-0.6, -0.55]] as const) {
    const wheel = new Mesh(new CylinderGeometry(0.26, 0.26, 0.2, 12), lambert('#222222'));
    wheel.rotation.x = Math.PI / 2; wheel.position.set(x, 0.26, z); taxi.add(wheel);
  }
  // the turbo's flame, behind the taxi
  const flame = new Mesh(new ConeGeometry(0.35, 1.4, 10), new MeshBasicMaterial({ color: '#F28C28' }));
  flame.rotation.z = Math.PI / 2; flame.position.set(-1.7, 0.45, 0); flame.visible = false; taxi.add(flame);
  taxi.scale.setScalar(1.6);
  taxi.rotation.order = 'YXZ';                                   // heading first, then the lean (roll) in the taxi's own frame
  scene.add(taxi);
  const tram = new Group();
  { const body = new Mesh(box, lambert(TRAM)); body.scale.set(2.2, 1.1, 0.95); body.position.y = 0.7; tram.add(body);
    const top = new Mesh(box, lambert(CHALK)); top.scale.set(2.2, 0.15, 0.95); top.position.y = 1.32; tram.add(top); }
  scene.add(tram);
  const TRAM_LOOP = [5, 6, 8, 11, 7, 4, 3, 8, 6, 5];

  /* the route: blue studs from the taxi along the planned streets */
  const studs = new InstancedMesh(new CylinderGeometry(0.2, 0.2, 0.08, 10), lambert(BLUE), 160);
  studs.count = 0;
  scene.add(studs);

  /* waiting people: sprites, their frames drawn by the page (a walking sheet or a pixel stand-in) */
  const sprites: Sprite[] = [];
  for (let i = 0; i < RULES.waitingMax; i++) {
    const s = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }));
    s.center.set(0.5, 0); s.scale.set(2.6, 2.6, 1); s.visible = false;
    scene.add(s); sprites.push(s);
  }
  const frames = new Map<string, CanvasTexture>();
  function frame(name: string, step: number): CanvasTexture {
    const key = `${name}:${step}`;
    let t = frames.get(key);
    if (!t) {
      const c = document.createElement('canvas'); c.width = 48; c.height = 48;
      drawPerson(c.getContext('2d') as CanvasRenderingContext2D, name, 0, 0, 48, step, 2);
      t = new CanvasTexture(c); t.magFilter = NearestFilter; t.minFilter = NearestFilter; t.colorSpace = SRGBColorSpace;
      frames.set(key, t);
      if (frames.size > 400) { const first = frames.keys().next().value as string; frames.get(first)?.dispose(); frames.delete(first); }
    }
    return t;
  }

  /* -------------------------------- per frame -------------------------------- */
  let slowFrames = 0, frameCount = 0, lastT = 0;
  const CAM = new Vector3(0, 58, 40), LOOK = new Vector3(0, 0, 4), follow = new Vector3();
  let lastAngle = 0;
  function render(s: LwState | null, car: Car, people: Map<number, { name: string; step: number }[]>, now: number, shake = 0): void {
    if (failed) return;
    // turn smoothly (the heading is kept while the taxi stands)
    let d = car.angle === null ? 0 : -car.angle - lastAngle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    lastAngle += d * 0.25;
    const tx = wx(car.x), tz = wz(car.z);
    const jolt = (): number => (Math.random() - 0.5) * shake;
    // an arcade camera above the town: it leans a little towards the taxi, and shakes when a passenger is lost
    follow.lerp(new Vector3(tx * 0.06, 0, tz * 0.05), 0.06);
    camera.position.set(CAM.x + follow.x + jolt(), CAM.y + jolt(), CAM.z + follow.z);
    camera.lookAt(LOOK.x + follow.x, LOOK.y, LOOK.z + follow.z);
    // a device too slow for 3D (under ~20 fps most of the time, after warming up) switches to 2D
    if (lastT) { frameCount++; if (now - lastT > 50) slowFrames++; }
    lastT = now;
    if (frameCount > 90 && slowFrames > frameCount * 0.6) { failed = true; return; }
    if (frameCount > 400) { frameCount = 0; slowFrames = 0; }

    // the taxi, with a little bounce, leaning into the turn
    taxi.position.set(tx, Math.abs(Math.sin(now / 90)) * 0.06, tz);
    taxi.rotation.set(Math.max(-0.12, Math.min(0.12, -d * 0.3)), lastAngle, 0);
    flame.visible = Boolean(s && !s.gameOver && s.tick < s.play.boostUntil && car.angle !== null);
    if (flame.visible) flame.scale.set(1, 0.8 + Math.random() * 0.6, 1);
    // the tram, slowly round its loop
    const leg = Math.floor(now / 4200) % (TRAM_LOOP.length - 1), f = (now % 4200) / 4200;
    const ta = placeW(TRAM_LOOP[leg] as number), tb = placeW(TRAM_LOOP[leg + 1] as number);
    tram.position.set(ta.x + (tb.x - ta.x) * f, 0.1, ta.z + (tb.z - ta.z) * f);
    tram.rotation.y = -Math.atan2(tb.z - ta.z, tb.x - ta.x);
    // waves
    for (let i = 0; i < 60; i++) {
      dummy.position.set(((i * 13.7 + now / 900) % 80) - 40, 0, RIVER_Z + 2 + (i % 10) * 1.6);
      dummy.scale.set(1.2, 0.02, 0.12); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); waves.setMatrixAt(i, dummy.matrix);
    }
    waves.instanceMatrix.needsUpdate = true;

    // traffic, rings, route
    const jams = new Set(s?.play.jams.map((j) => j.edge) ?? []);
    let cars = 0;
    STREETS.forEach(([a, b], e) => {
      const on = jams.has(e);
      (jamTop[e] as Mesh).visible = on;
      if (!on) return;
      const p = placeW(a), q = placeW(b), len = p.distanceTo(q), angle = -Math.atan2(q.z - p.z, q.x - p.x);
      for (let k = 1; k * 1.6 < len - 1 && cars < 120; k++, cars++) {
        const t = (k * 1.6) / len, wob = Math.sin(now / 220 + k) * 0.08;
        dummy.position.set(p.x + (q.x - p.x) * t + wob, 0.35, p.z + (q.z - p.z) * t);
        dummy.scale.set(0.8, 0.4, 0.5); dummy.rotation.set(0, angle, 0); dummy.updateMatrix();
        jamCars.setMatrixAt(cars, dummy.matrix); jamCars.setColorAt(cars, new Color([TRAM, CHALK, '#5C6B78', '#7A4FA3'][k % 4] as string));
      }
    });
    jamCars.count = cars;
    jamCars.instanceMatrix.needsUpdate = true;
    if (jamCars.instanceColor) jamCars.instanceColor.needsUpdate = true;

    const want = new Map<number, number>();               // place -> 2 drop, 1 via
    for (const r of s?.play.riders ?? []) { if (r.via < 0) want.set(r.to, 2); else if (!want.has(r.via)) want.set(r.via, 1); }
    rings.forEach((ring, p) => {
      const w = want.get(p);
      ring.visible = w !== undefined;
      if (w) { const pulse = 1 + 0.12 * Math.sin(now / 150); ring.scale.set(pulse * (w === 2 ? 1 : 0.8), pulse * (w === 2 ? 1 : 0.8), w === 2 ? 1.6 : 0.8); }
    });

    beams.forEach((beam, p) => {
      const target = want.get(p);
      beam.visible = target !== undefined;
      if (target !== undefined) {
        (beam.material as MeshBasicMaterial).opacity = 0.32 + 0.12 * Math.sin(now / 160);
        beam.scale.set(target === 2 ? 1.4 : 0.9, 1, target === 2 ? 1.4 : 0.9);
      }
    });

    let n = 0;
    if (s && !s.gameOver) {
      const t = s.play.taxi;
      const points: Vector3[] = [new Vector3(wx(car.x), 0, wz(car.z))];
      if (t.to >= 0) points.push(placeW(t.to));
      for (const p of t.route) points.push(placeW(p));
      const offset = (now / 400) % 1;
      for (let i = 1; i < points.length && n < 160; i++) {
        const a = points[i - 1] as Vector3, b = points[i] as Vector3, len = a.distanceTo(b);
        for (let d = offset * 0.9; d < len && n < 160; d += 0.9, n++) {
          dummy.position.set(a.x + (b.x - a.x) * d / len, 0.2, a.z + (b.z - a.z) * d / len);
          dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); studs.setMatrixAt(n, dummy.matrix);
        }
      }
    }
    studs.count = n;
    studs.instanceMatrix.needsUpdate = true;

    // the people waiting at each place, side by side above the pin
    let k = 0;
    for (const [p, list] of people) {
      const w = placeW(p);
      list.forEach((person, i) => {
        const sprite = sprites[k++];
        if (!sprite) return;
        sprite.visible = true;
        sprite.position.set(w.x + (list.length > 1 ? (i ? 1.3 : -1.3) : 0), 1.45, w.z);
        const map = frame(person.name, person.step);
        if (sprite.material.map !== map) { sprite.material.map = map; sprite.material.needsUpdate = true; }
      });
    }
    for (; k < sprites.length; k++) (sprites[k] as Sprite).visible = false;

    renderer.render(scene, camera);
  }

  const v = new Vector3();
  return {
    resize(width: number, height: number, dpr: number): void {
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },
    render,
    project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
      v.set(x, y, z).project(camera);
      return { x: (v.x + 1) / 2, y: (1 - v.y) / 2, visible: v.z < 1 && v.z > -1 };
    },
    get failed() { return failed; },
    refreshPeople(): void { for (const t of frames.values()) t.dispose(); frames.clear(); },
    dispose(): void { renderer.dispose(); },
  };
}

/** The taxi between the two places of its street, in map px (interpolated between ticks). */
export function carOf(s: LwState, frac: number, jammed: (edge: number) => boolean): Car {
  const t = s.play.taxi;
  const at = PLACES[t.at] as { x: number; y: number };
  if (t.to < 0) return { x: at.x, z: at.y, angle: null };
  const edge = (EDGE[t.at] as number[])[t.to] as number, len = LENGTH[edge] as number, to = PLACES[t.to] as { x: number; y: number };
  const f = Math.min(1, (t.pos + (s.gameOver ? 0 : speedOn(t.at, t.to, jammed(edge), s.tick < s.play.boostUntil) * frac)) / len);
  return { x: at.x + (to.x - at.x) * f, z: at.y + (to.y - at.y) * f, angle: Math.atan2(to.y - at.y, to.x - at.x) };
}
