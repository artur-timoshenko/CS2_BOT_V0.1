// Headless CS-like simulation, shared by the Node server and the browser viewer.
// Source conventions so coordinates map onto a real CS2 bot: units ≈ inches, Z up,
// yaw in degrees (0 = +X, 90 = +Y), pitch in degrees (+ = looking down), 64 tick with sub-tick inputs.
import { MAP } from './map.js';
import { CS2_WEAPONS } from './weapons-cs2.js';

export const TICK = 64, DT = 1 / TICK;
// Movement/recoil constants, named after the CS2 cvars they mirror (CS2 defaults). Mutable for calibration.
// Movement follows Source/CS2 rules checked against Valve's CS:GO Mapper's Reference (reachable heights, fall damage)
// and community CS2 measurements (duck ramp 10 ticks, ±9 in-air duck shift, stamina = cost × max, 2-unit ground check).
// shortcut: tagging and punch-decay formulas follow the CS:GO game code, not verified tick-by-tick against CS2.
export const CVARS = {
  sv_gravity: 800, sv_jump_impulse: 301.993378, sv_friction: 5.2, sv_accelerate: 5.5, sv_airaccelerate: 12,
  sv_stopspeed: 80, sv_air_max_wishspeed: 30, sv_stepsize: 18, sv_maxvelocity: 3500,
  sv_staminamax: 80, sv_staminajumpcost: 0.08, sv_staminalandcost: 0.05, sv_staminarecoveryrate: 60,
  sv_enablebunnyhopping: 0, // 0: jumping caps horizontal speed at 1.1 × max speed (CS PreventBunnyJumping)
  sv_bhop_time_window: 0.0078125, // a jump pressed up to half this before touching down still fires on landing (CS2)
  mp_solid_teammates: 1, // players block each other and can stand on heads; enemies are always solid
  fall_safe_speed: 580, fall_fatal_speed: 1024, tag_velocity_modifier: 0.5, tag_recovery_rate: 0.4,
  weapon_recoil_scale: 2, weapon_recoil_decay2_exp: 8, weapon_recoil_decay2_lin: 18, weapon_recoil_vel_decay: 4.5,
  recoil_kick_scale: 0.8, // punch velocity (deg/s) per unit of m_flRecoilMagnitude; calibrated so an AK spray climbs ~8° by shot 8
  duck_speed: 6.4, duck_speed_spam_cost: 2, duck_speed_recovery: 3, // 6.4/s = full duck in 10 ticks
  ground_dist: 2, // grounded when floor is within this many units below (CS2)
};
const DIST_EPS = 0.03125; // players never get closer than this to a surface (feet float 0.03125 above the floor)
const EYE_STAND = 64.093811, EYE_DUCK = 46.076218; // eye level above feet (Valve Mapper's Reference)
const C = CVARS;
export const HULL_R = 16, STAND_H = 72, CROUCH_H = 54;
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Every CS2 weapon's mechanics, from the game's scripts/weapons.vdata (tools/import-weapons.js → weapons-cs2.js), by name:
// damage, cycle, magazine + spare magazines (CS2 2026: a reload discards what was left), m_flInaccuracy*, m_flRecoveryTime*,
// m_flRecoil*, pellets, burst mode. Inaccuracy/spread in radians.
export const CATALOG = Object.fromEntries(CS2_WEAPONS.map(w => [w.name, structuredClone(w)]));
for (const w of Object.values(CATALOG)) if (w.melee) {
  // shortcut: knife timings/damage are CS:GO's (vdata only has generic values for melee); measure in CS2 if they matter
  Object.assign(w, { auto: true, dmg: 40, backDmg: 90, cycle: 0.4, range: 48, stab: { dmg: 65, back: 180, cycle: 1.0, range: 32 } });
  delete w.rm; // melee damage does not fall off with distance
}
CATALOG.glock.reserve = 6; // seen in game: 6 spare magazines (the exported weapons.vdata says 3)
// Players carry three slots (CS binds 1 primary, 2 pistol, 3 knife); which weapons is the env's loadout.
export const DEFAULT_LOADOUT = ['ak47', 'glock', 'knife'];
export const WEAPONS = DEFAULT_LOADOUT.map(n => CATALOG[n]); // the default slots (viewer, older callers)
// slot 4 (p.weapon === 3) = the grenade in hand, p.nades[p.nade]
const W = p => (p.weapon === 3 ? CATALOG[p.nades[p.nade]] : p.loadout[p.weapon]);
// zoomed (attack2 on a scoped weapon): its scoped accuracy and speed (weapons.vdata m_*[1] values)
const zoomed = (p, w) => (p.zoom && w.scoped ? w.scoped : null);
const maxSpeedOf = (p, w) => zoomed(p, w)?.speed ?? w.speed;
// Grenades, CS:GO/CS2 game-code values: thrown at 750 × 0.9 u/s × (0.3 + 0.7 × strength) (LMB 1, RMB 0 = underhand, both 0.5)
// plus 1.25 × the thrower's velocity, 0.1 s after the button is released; gravity 0.4 × sv_gravity; a bounce keeps 45%.
// HE/flash go off 1.5 s after the throw, smoke/decoy once at rest, molotov on hitting the floor or after 2 s in the air.
// shortcut: smoke/fire sizes, smoke time and the flash-duration curve are approximations of CS2, not measured; grenades
// pass through players. Tune against the game if training depends on them.
export const NADE = { speed: 675, gravityScale: 0.4, elasticity: 0.45, radius: 2, fuse: 1.5, molotovAir: 2, throwDelay: 0.1,
  smokeRadius: 144, smokeLift: 48, smokeGrow: 0.8, smokeTime: 20, fireRadius: 120, fireTime: 7, decoyTime: 15,
  flashRange: 1500, flashHold: 1.95, flashFade: 2.92 };
const FIRE = new Set(['molotov', 'incgrenade']);
// CS2 limits: 4 grenades, up to 2 flashbangs, one of each other kind (molotov and incendiary are one kind: T / CT)
function checkGrenades(nd) {
  const kinds = (nd || []).filter(n => n !== 'flashbang').map(n => (n === 'incgrenade' ? 'molotov' : n));
  return Array.isArray(nd) && nd.length <= 4 && nd.every(n => CATALOG[n]?.slot === 'grenade') && nd.filter(n => n === 'flashbang').length <= 2 && new Set(kinds).size === kinds.length;
}
const teamNade = (n, team) => (team === 1 && n === 'molotov' ? 'incgrenade' : team === 0 && n === 'incgrenade' ? 'molotov' : n);
// AK-47 spray: where each bullet lands relative to the first one, digitised from a CS2 spray chart
// (pixels: [right, up]; dots ordered by the chart's colour gradient). Scaled so the whole spray climbs ~8.5° (≈1.5 m at 10 m).
// shortcut: the chart has no absolute scale and the late-band order comes from colour; refine with an in-game spray test at a known distance.
const AK_SPRAY_PX = [[0, 0], [9.3, 13.3], [4.2, 27.4], [3.5, 59.3], [6.7, 103.3], [2, 148.5], [-15.4, 189.6], [-29.1, 225.3], [-37, 251.7],
  [-0.8, 266.3], [55.7, 261.7], [73.1, 270.4], [63.6, 281.5], [120.6, 273.7], [108.5, 280.6], [57.4, 287.5], [91.9, 279.8], [3.2, 303],
  [-68.6, 290], [-39.3, 299.1], [28.8, 296.1], [-46.7, 291.5], [-50, 296.4], [-38, 304], [-36.6, 308.9], [-61.3, 304], [-58.2, 307.7],
  [-22.5, 308.7], [32.7, 299.5], [86.3, 280.6]];
CATALOG.ak47.pattern = AK_SPRAY_PX.map(([r, u]) => [u * 8.5 / 308, r * 8.5 / 308]); // [up, right] in degrees of bullet offset
// Per-shot kick directions from each weapon's recoil seed/angle/magnitude (weapons without a measured pattern).
// shortcut: CS2 builds its table with Valve's RNG and smoothing we can't reproduce exactly; this follows the same parameters — swap in measured per-shot angles for an exact spray.
for (const w of Object.values(CATALOG)) {
  if (w.melee || !w.recoil) continue;
  const r = w.recoil, rnd = mulberry32(r.seed);
  let ang = 0; // kick direction does a bounded random walk: straight climb first, then a sideways sway (same every spray)
  w.kicks = Array.from({ length: 64 }, (_, j) => {
    const m = r.mag + (rnd() * 2 - 1) * r.magVar;
    ang = clamp(ang * 0.97 + (rnd() * 2 - 1) * r.angleVar * 0.6 * Math.min(1, j / 6), -r.angleVar, r.angleVar);
    return [m * Math.cos((r.angle + ang) * DEG), m * Math.sin((r.angle + ang) * DEG)]; // [up, right]
  });
}
const HITGROUPS = [ // [name, zFrom, zTo (fraction of height), half-width, damage multiplier]
  ['head', 0.8, 1.0, 7, 4], ['chest', 0.6, 0.8, 11, 1], ['stomach', 0.45, 0.6, 11, 1.25], ['legs', 0, 0.45, 9, 0.75],
];
// [forward, strafe, yawDelta°, pitchDelta°, jump, crouch, walk, fire, reload, slot 0..4, moveFrac, fireFrac]
// moveFrac/fireFrac (0..1): sub-tick moment within the first tick of the step when movement keys/jump changed and fire was pressed;
// a shot at fireFrac uses the view angles interpolated to that moment. 0 = no sub-tick info (start of tick, final aim of the step).
// attack2 (index 12): Glock toggles burst mode, knife stabs, scoped weapons zoom (next level, then out).
// slot 4: grenades (again while holding one = the next kind). Grenade: hold fire/attack2 to pull the pin, release to throw.
export const ACTION_SIZE = 13;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wrap180 = a => ((a + 540) % 360) - 180;
export const dirFromAngles = (yaw, pitch) => [Math.cos(pitch * DEG) * Math.cos(yaw * DEG), Math.cos(pitch * DEG) * Math.sin(yaw * DEG), -Math.sin(pitch * DEG)];

export function rayBox(o, d, b, tmax) {
  let t0 = 0, t1 = tmax;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / d[i];
    let ta = (b[i] - o[i]) * inv, tb = (b[i + 3] - o[i]) * inv;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}
// A map is either { boxes } (AABB list) or { grid } (voxels imported from a real map, see tools/import-map.js).
export function rayWorld(map, o, d, tmax) {
  if (map.grid) return rayGrid(map.grid, o, d, tmax);
  let t = tmax;
  for (const b of map.boxes) { const h = rayBox(o, d, b, t); if (h < t) t = h; }
  return t;
}
function solidAt(map, x, y, z) {
  if (map.grid) { const g = map.grid, i = Math.floor((x - g.origin[0]) / g.size), j = Math.floor((y - g.origin[1]) / g.size), k = Math.floor((z - g.origin[2]) / g.size);
    return i < 0 || j < 0 || k < 0 || i >= g.dims[0] || j >= g.dims[1] || k >= g.dims[2] || !!solid(g, i, j, k); }
  return map.boxes.some(b => x > b[0] && x < b[3] && y > b[1] && y < b[4] && z > b[2] && z < b[5]);
}
// Distance a ray entering solid at `at` travels before it is out again (1-unit march), or Infinity if thicker than max.
export function wallThickness(map, at, d, max) {
  for (let s = 0.5; s <= max; s += 1) if (!solidAt(map, at[0] + d[0] * s, at[1] + d[1] * s, at[2] + d[2] * s)) return s;
  return Infinity;
}
// Normal of the axis-aligned face a ray along d meets at `at` (voxels and boxes are axis-aligned): the axis whose move
// alone takes the point from just before the contact into solid.
export function surfaceNormal(map, at, d) {
  const a = at.map((v, i) => v - d[i] * 0.5), b = at.map((v, i) => v + d[i] * 0.5);
  let best = -1;
  for (let k = 0; k < 3; k++) {
    const q = [...a]; q[k] = b[k];
    if (solidAt(map, q[0], q[1], q[2]) && (best < 0 || Math.abs(d[k]) > Math.abs(d[best]))) best = k;
  }
  if (best < 0) return d.map(v => -v);
  const n = [0, 0, 0]; n[best] = d[best] > 0 ? -1 : 1;
  return n;
}
export function hullHit(map, x, y, z, h) {
  if (map.grid) return hullGrid(map.grid, x, y, z, h);
  for (const b of map.boxes)
    if (x - HULL_R < b[3] && x + HULL_R > b[0] && y - HULL_R < b[4] && y + HULL_R > b[1] && z < b[5] && z + h > b[2]) return b;
  return null;
}
// Column-major copy of the voxel bits: each (i, j) column's z bits sit in consecutive 32-bit words, so a hull's height
// range is a couple of masked word tests instead of one lookup per voxel (4-unit grids: ~1500 voxels per hull query).
function cols(g) {
  if (g.cols) return g.cols;
  const [nx, ny, nz] = g.dims, W = (g.W = (nz + 31) >> 5), out = new Uint32Array(nx * ny * W), b = g.bits, nxy = nx * ny;
  for (let byte = 0; byte < b.length; byte++) {
    for (let v = b[byte], bit = 0; v; bit++, v >>= 1) if (v & 1) {
      const idx = byte * 8 + bit, k = Math.floor(idx / nxy);
      out[(idx - k * nxy) * W + (k >> 5)] |= 1 << (k & 31);
    }
  }
  return (g.cols = out);
}
const solid = (g, x, y, z) => (cols(g)[(x + g.dims[0] * y) * g.W + (z >> 5)] >>> (z & 31)) & 1;
// Union box of all solid voxels the hull overlaps (outside the grid counts as solid), or null.
function hullGrid(g, x, y, z, h) {
  const s = g.size, o = g.origin, [nx, ny, nz] = g.dims, C = cols(g), W = g.W;
  const i0 = Math.floor((x - HULL_R - o[0]) / s), i1 = Math.ceil((x + HULL_R - o[0]) / s) - 1;
  const j0 = Math.floor((y - HULL_R - o[1]) / s), j1 = Math.ceil((y + HULL_R - o[1]) / s) - 1;
  const k0 = Math.floor((z - o[2]) / s), k1 = Math.ceil((z + h - o[2]) / s) - 1, ka = Math.max(k0, 0), kb = Math.min(k1, nz - 1);
  let a0 = Infinity, a1 = -1e9, b0 = Infinity, b1 = -1e9, c0 = Infinity, c1 = -1e9; // index bounds of solid cells hit
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    let lo = Infinity, hi = -Infinity;
    if (i < 0 || j < 0 || i >= nx || j >= ny) { lo = k0; hi = k1; }
    else {
      if (k0 < 0) { lo = k0; hi = -1; } // below / above the grid counts as solid
      if (k1 >= nz) { lo = Math.min(lo, nz); hi = k1; }
      const base = (i + nx * j) * W;
      for (let w = ka >> 5; ka <= kb && w <= kb >> 5; w++) {
        const from = Math.max(ka - w * 32, 0), to = Math.min(kb - w * 32, 31);
        const m = (C[base + w] & (to === 31 ? 0xffffffff : (1 << (to + 1)) - 1) & (0xffffffff << from)) >>> 0;
        if (!m) continue;
        const l = w * 32 + 31 - Math.clz32(m & -m), u = w * 32 + 31 - Math.clz32(m);
        if (l < lo) lo = l; if (u > hi) hi = u;
      }
    }
    if (lo === Infinity) continue;
    if (i < a0) a0 = i; if (i > a1) a1 = i; if (j < b0) b0 = j; if (j > b1) b1 = j; if (lo < c0) c0 = lo; if (hi > c1) c1 = hi;
  }
  return a0 === Infinity ? null : [o[0] + a0 * s, o[1] + b0 * s, o[2] + c0 * s, o[0] + (a1 + 1) * s, o[1] + (b1 + 1) * s, o[2] + (c1 + 1) * s];
}
function rayGrid(g, o, d, tmax) { // Amanatides–Woo voxel traversal
  const s = g.size, p = [0, 1, 2].map(c => Math.floor((o[c] - g.origin[c]) / s));
  const step = d.map(v => (v > 0 ? 1 : -1)), delta = d.map(v => Math.abs(s / v));
  const next = d.map((v, c) => { const edge = g.origin[c] + (p[c] + (v > 0 ? 1 : 0)) * s; return v ? (edge - o[c]) / v : Infinity; });
  let t = 0;
  while (t < tmax) {
    if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= g.dims[0] || p[1] >= g.dims[1] || p[2] >= g.dims[2]) return tmax;
    if (solid(g, p[0], p[1], p[2])) return t;
    const a = next[0] < next[1] ? (next[0] < next[2] ? 0 : 2) : next[1] < next[2] ? 1 : 2;
    t = next[a]; next[a] += delta[a]; p[a] += step[a];
  }
  return tmax;
}
const hullH = p => (p.crouch ? CROUCH_H : STAND_H);
// How far the voxel floor under p sits above the real (render) floor, from the map's surfaces.json (tools/surface-map.js):
// the highest real floor at most a voxel (+1.5) below the feet; 0 without surfaces or off a known floor (ledge edges).
// CS2 check: voxel feet stood 2–5 units above getpos at the spawns and sites; eyes and hitboxes use the real floor.
// Like Source's hull, the player rests on the highest floor under its 32×32 footprint (on a ramp: the uphill edge). The real
// floor is the surfaces' heights (sampled at cell centres) interpolated between centres, taken at the footprint's centre and
// corners: continuous on ramps and uneven ground, and on a ledge edge it stays the ledge. The voxels only add their
// quantisation on top (≤ a voxel + rounding), which is the gap returned.
export function floorDrop(map, [x, y, z]) {
  const s = map.surfaces;
  if (!s || !map.grid) return 0;
  s.index ||= new Map(s.cells.map(c => [c[0], c]));
  const top = (i, j) => {
    const c = i >= 0 && j >= 0 && i < s.dims[0] ? s.index.get(i + s.dims[0] * j) : null;
    let best = -Infinity;
    for (let k = 1; c && k < c.length; k += 2) if (c[k] <= z + 0.5 && c[k] > best) best = c[k];
    return best;
  };
  const floorAt = (px, py) => { // bilinear between the 4 cell centres around (px, py); a neighbour > 12 off (other floor) = this cell
    const fx = (px - s.origin[0]) / s.cell, fy = (py - s.origin[1]) / s.cell, own = top(Math.floor(fx), Math.floor(fy));
    if (own === -Infinity) return own;
    const i0 = Math.floor(fx - 0.5), j0 = Math.floor(fy - 0.5), tx = fx - 0.5 - i0, ty = fy - 0.5 - j0;
    const h = (i, j) => { const v = top(i, j); return Math.abs(v - own) <= 12 ? v : own; };
    return (h(i0, j0) * (1 - tx) + h(i0 + 1, j0) * tx) * (1 - ty) + (h(i0, j0 + 1) * (1 - tx) + h(i0 + 1, j0 + 1) * tx) * ty;
  };
  const r = HULL_R - 1, floor = Math.max(floorAt(x, y), floorAt(x - r, y - r), floorAt(x + r, y - r), floorAt(x - r, y + r), floorAt(x + r, y + r));
  const d = z - floor; // measured on dust2 routes: 0–5 almost always, up to 9 on ramps between voxel steps; more = another object
  return d >= 0 && d <= 2 * map.grid.size + 1.5 ? d : 0;
}
export const height = p => STAND_H - (STAND_H - CROUCH_H) * (p.duck ?? +p.crouch); // visual height: eyes, hitboxes (smooth duck)
// Feet on the real floor: voxel collision stands you up to a voxel above it, p.dz is that gap (see floorDrop).
const feetZ = p => p.pos[2] - (p.dz || 0);
export const eye = p => [p.pos[0], p.pos[1], feetZ(p) + EYE_STAND + (EYE_DUCK - EYE_STAND) * (p.duck ?? +p.crouch)];
export function hitboxes(p) {
  const h = height(p), [x, y] = p.pos, z = feetZ(p);
  return HITGROUPS.map(([name, a, b, w, mult]) => ({ name, mult, box: [x - w, y - w, z + a * h, x + w, y + w, z + b * h] }));
}
// Current inaccuracy (radians) of p's weapon: base + movement + air + accumulated fire/jump/land penalty.
export function inaccuracy(p) {
  const w = W(p), I = (p.burst && w.burst?.inacc) || zoomed(p, w)?.inacc || w.inacc;
  if (!I) return 0;
  const sp = Math.hypot(p.vel[0], p.vel[1]), lo = maxSpeedOf(p, w) * 0.34, hi = maxSpeedOf(p, w) * 0.95;
  return I.stand + (I.crouch - I.stand) * p.duck + clamp((sp - lo) / (hi - lo), 0, 1) * I.move + (p.onGround ? 0 : I.jump) + p.accPenalty;
}
function recoveryTime(p, w) {
  const R = w.recovery, t = clamp((p.recoilIndex - R.from) / Math.max(1, R.to - R.from), 0, 1);
  const base = R.stand + (R.crouch - R.stand) * p.duck, fin = R.standFinal + (R.crouchFinal - R.standFinal) * p.duck;
  return base + (fin - base) * t;
}

export class Env {
  constructor(cfg = {}) {
    this.cfg = { teamSize: 1, opponent: 'bot', frameSkip: 4, maxSeconds: 115, rays: 24, botSkill: 0.5, loadout: DEFAULT_LOADOUT, grenades: [], ...cfg };
    if (!checkGrenades(this.cfg.grenades)) // trust boundary too; CT get incendiaries for molotovs and the other way round
      throw new Error(`grenades must be up to 4 grenade names (≤ 2 flashbang, one of each other), got ${JSON.stringify(this.cfg.grenades)}`);
    // trust boundary (config comes from the network): slots 1–3 = a primary/any gun, a gun, a melee weapon from CATALOG
    const lo = this.cfg.loadout;
    if (!Array.isArray(lo) || lo.length !== 3 || !lo.every(n => Object.hasOwn(CATALOG, n)) || !CATALOG[lo[2]].melee || lo.slice(0, 2).some(n => !CATALOG[n].mag))
      throw new Error(`loadout must be [gun, gun, melee] names from CATALOG, got ${JSON.stringify(lo)}`);
    this.loadout = lo.map(n => CATALOG[n]);
    this.map = this.cfg.map || MAP;
    this.cfg.map = undefined;
    this.reset(this.cfg.seed);
  }
  // Agents the caller controls: team 0 always; team 1 too when opponent === 'agent' (self-play).
  get nAgents() { return this.cfg.opponent === 'agent' ? 2 * this.cfg.teamSize : this.cfg.teamSize; }
  get obsSize() { return 28 + this.cfg.rays + 7 * (2 * this.cfg.teamSize - 1); }

  reset(seed = (Math.random() * 2 ** 31) | 0) {
    this.rng = mulberry32(seed);
    this.tick = 0; this.time = 0; this.done = false; this.winner = -1; this.events = [];
    this.nades = []; this.smokes = []; this.fires = []; this.nadeId = 0; // thrown grenades, active smokes, burning areas
    const n = this.cfg.teamSize;
    this.players = [];
    for (let team = 0; team < (this.cfg.opponent === 'none' ? 1 : 2); team++) { // 'none': practice alone, no enemy team
      const spawns = [...this.map.spawns[team]].sort(() => this.rng() - 0.5);
      for (let i = 0; i < n; i++) {
        const [x, y, z, yaw] = spawns[i % spawns.length];
        this.players.push({ id: team * n + i, team, pos: [x + (this.rng() - 0.5) * 32, y + (this.rng() - 0.5) * 32, z], vel: [0, 0, 0],
          dz: 0, yaw, pitch: 0, hp: 100, armor: 100, alive: true, crouch: false, duck: 0, duckSpeed: C.duck_speed, onGround: true, weapon: 0,
          loadout: this.loadout, ammo: this.loadout.map(w => w.mag || 0), reserve: this.loadout.map(w => w.reserve || 0),
          nextAttack: 0, reloadStart: 0, reloadUntil: 0, deployStart: -9, lastShot: -9, kills: 0, seen: 0, heading: yaw,
          stamina: 0, velMod: 1, landSpeed: 0, jumpHeld: false, crouchHeld: false, shotsFired: 0, attack2Held: false,
          burst: false, burstLeft: 0, burstNext: 0, burstStart: 0, jumpQueued: -9, zoom: 0, resumeZoom: 0, reloadShells: 1,
          nades: this.cfg.grenades.map(n => teamNade(n, team)), nade: 0, prevWeapon: 0, pin: 0, throwAt: 0, throwStrength: 1,
          flashHold: 0, flashEnd: 0, fireAcc: 0,
          punch: [0, 0], punchVel: [0, 0], accPenalty: 0, recoilIndex: 0, lastIn: { fwd: 0, strafe: 0, walk: 0, jump: 0, crouch: 0 } });
      }
    }
    this.rew = new Array(this.players.length).fill(0);
    return this.observeAll();
  }

  // actions: one ACTION_SIZE array per controlled agent. Returns rewards per controlled agent.
  step(actions = []) {
    if (this.done) return { obs: this.observeAll(), rewards: new Array(this.nAgents).fill(0), done: true, info: { winner: this.winner } };
    this.rew.fill(0); this.events = [];
    const acts = this.players.map((p, i) => (i < this.nAgents ? sanitize(actions[i]) : sanitize(this.botAction(p))));
    for (let k = 0; k < this.cfg.frameSkip && !this.done; k++) {
      this.players.forEach((p, i) => p.alive && this.tickPlayer(p, acts[i], k === 0));
      this.tickNades();
      this.tick++; this.time = this.tick * DT;
      this.checkDone();
    }
    return { obs: this.observeAll(), rewards: this.rew.slice(0, this.nAgents), done: this.done, info: this.done ? { winner: this.winner } : null };
  }

  checkDone() {
    const alive = [0, 1].map(t => this.players.some(p => p.team === t && p.alive));
    if (this.cfg.opponent === 'none') alive[1] = true; // alone: no enemy left is not a win; your death or the clock ends it
    if (!alive[0] || !alive[1]) { this.done = true; this.winner = alive[0] ? 0 : alive[1] ? 1 : -1; }
    else if (this.time >= this.cfg.maxSeconds) { this.done = true; this.winner = -1; }
  }

  tickPlayer(p, a, first) {
    const [fwd, strafe, dyaw, dpitch, jump, crouch, walk, fire, reload, slot, moveFrac, fireFrac, attack2] = a;
    const t0 = this.time, yaw0 = p.yaw, pitch0 = p.pitch;
    if (first) { // aim and edge-triggered buttons apply once per env step
      p.yaw = wrap180(p.yaw + dyaw); p.pitch = clamp(p.pitch + dpitch, -89, 89);
      if (slot === 4 && p.nades.length) { // grenades: select, or (holding one) the next kind
        if (p.weapon !== 3) this.switchTo(p, 3, t0);
        else {
          let j = p.nade;
          do j = (j + 1) % p.nades.length; while (p.nades[j] === p.nades[p.nade] && j !== p.nade);
          if (j !== p.nade) { p.nade = j; this.switchTo(p, 3, t0); }
        }
      } else if (slot && slot < 4 && slot - 1 !== p.weapon) this.switchTo(p, slot - 1, t0);
      if (reload) this.startReload(p);
    }
    let w = W(p);
    if (p.resumeZoom && t0 >= p.nextAttack && !p.reloadUntil) { p.zoom = p.resumeZoom; p.resumeZoom = 0; } // bolt sniper: back in the scope after the bolt
    if (p.reloadUntil && t0 >= p.reloadUntil) { // finish reload
      const s = p.weapon;
      if (w.clips === false) { const take = Math.min(w.mag - p.ammo[s], p.reserve[s]); p.ammo[s] += take; p.reserve[s] -= take; } // loose shells
      else if (p.reserve[s] > 0) { p.ammo[s] = w.mag; p.reserve[s]--; } // a fresh magazine; what was left in the old one is gone (CS2)
      p.reloadUntil = 0;
    }

    // Shots at their sub-tick moment, aimed with the view angles of that moment (CS2 sub-tick).
    const aimAt = ts => { const f = first && fireFrac > 0 ? (ts - t0) / DT : 1; // no sub-tick info → this step's final aim
      return [yaw0 + wrap180(p.yaw - yaw0) * f, pitch0 + (p.pitch - pitch0) * f]; };
    if (w.slot === 'grenade') this.grenadeInput(p, fire, attack2, t0);
    else {
      if (attack2 && !p.attack2Held && w.burst) p.burst = !p.burst; // Glock: right-click toggles burst mode
      if (attack2 && !p.attack2Held && w.scoped && !p.reloadUntil) { p.zoom = (p.zoom + 1) % (w.zoomLevels + 1); p.resumeZoom = 0; } // zoom 1 → 2 → out
      if (attack2 && w.melee && !fire) { // knife: right-click stab (repeats while held)
        const ts = Math.max(p.nextAttack, t0);
        if (ts < t0 + DT) this.fire(p, ...aimAt(ts), ts, true);
      }
      if (!fire) p.shotsFired = 0; // CS semi-auto rule: one shot per press, even if held through the deploy
      else if (w.auto || !p.shotsFired) {
        const ts = Math.max(p.nextAttack, t0 + (first ? fireFrac : 0) * DT);
        if (p.burst && w.burst) { if (ts < t0 + DT) { p.burstLeft = w.burst.count; p.burstNext = ts; p.burstStart = ts; p.shotsFired = 1; } }
        else for (let t = ts; t < t0 + DT && !p.reloadUntil; t = p.nextAttack) {
          if (!this.fire(p, ...aimAt(t), t)) break;
          p.shotsFired++;
          if (!w.auto) break;
        }
      }
      while (p.burstLeft > 0 && p.burstNext < t0 + DT && p.burst && w.burst) { // a burst completes even if the button is released
        if (!this.fire(p, ...aimAt(p.burstNext), p.burstNext)) { p.burstLeft = 0; break; }
        p.burstNext += w.burst.gap;
        if (--p.burstLeft === 0) p.nextAttack = p.burstStart + w.burst.cycle;
      }
    }
    p.attack2Held = !!attack2;

    // Movement integrated in two sub-tick segments: old inputs until moveFrac, new inputs after.
    const inp = { fwd, strafe, walk, jump, crouch }, f = first ? moveFrac : 0;
    if (f > 0) this.moveSegment(p, p.lastIn, f * DT);
    this.moveSegment(p, inp, (1 - f) * DT);
    p.lastIn = inp;
    if (p.onGround) p.dz = floorDrop(this.map, p.pos); // kept through a jump: the gap is the floor's, not the air's

    // Recoil punch decay (CS weapon_recoil_decay2_*) and accuracy recovery. A measured spray holds while the trigger keeps
    // firing (the table already is the accumulated recoil) and recovers once the spray stops.
    const holding = W(p).pattern && t0 - p.lastShot <= W(p).cycle * 1.1;
    const len = Math.hypot(p.punch[0], p.punch[1]), e = Math.exp(-C.weapon_recoil_decay2_exp * DT);
    const lin = holding ? 1 : len > 0 ? Math.max(0, len * e - C.weapon_recoil_decay2_lin * DT) / len : 0;
    const ve = Math.exp(-C.weapon_recoil_vel_decay * DT);
    for (let i = 0; i < 2; i++) {
      p.punch[i] = p.punch[i] * lin + p.punchVel[i] * DT * 0.5;
      p.punchVel[i] *= ve;
      p.punch[i] += p.punchVel[i] * DT * 0.5;
    }
    w = W(p);
    if (w.recovery) {
      const k = Math.exp(-DT * Math.LN10 / recoveryTime(p, w)); // penalty falls 10x per recovery time
      p.accPenalty *= k;
      if (t0 - p.lastShot > w.cycle * 1.5) p.recoilIndex *= k;
    }
  }

  moveSegment(p, inp, dt) {
    if (dt <= 0) return;
    const map = this.map, w = W(p), shift = (STAND_H - CROUCH_H) / 2, gd = C.ground_dist;
    const free = (z, h) => !this.blocked(p, p.pos[0], p.pos[1], z, h);
    // Duck ramp (CS2: 10 ticks); the hull switches when the ramp completes. On the ground the feet stay put,
    // in the air the hull re-centres: feet rise 9 when ducking, drop 9 when unducking.
    if (!inp.crouch && p.crouchHeld) p.duckSpeed = Math.max(1.5, p.duckSpeed - C.duck_speed_spam_cost); // duck spam slows the next ducks
    p.crouchHeld = !!inp.crouch;
    p.duckSpeed = Math.min(C.duck_speed, p.duckSpeed + C.duck_speed_recovery * dt);
    if (inp.crouch) {
      p.duck = p.duck + p.duckSpeed * dt > 1 - 1e-9 ? 1 : p.duck + p.duckSpeed * dt; // 10 × 0.1 must reach exactly 1
      if (p.duck >= 1 && !p.crouch) {
        if (p.onGround) p.crouch = true;
        else if (free(p.pos[2] + shift, CROUCH_H)) { p.pos[2] += shift; p.crouch = true; }
      }
    } else {
      if (p.crouch) {
        if (!p.onGround && free(p.pos[2] - shift, STAND_H)) { p.pos[2] -= shift; p.crouch = false; }
        else if (free(p.pos[2], STAND_H)) p.crouch = false;
      }
      if (!p.crouch) p.duck = Math.max(0, p.duck - p.duckSpeed * dt);
    }

    // Ground: floor within 2 units below while not rising (CS2); snap down onto it (records the landing).
    const wasAir = !p.onGround;
    if (p.vel[2] <= 0 && !free(p.pos[2] - gd, hullH(p))) { if (!p.onGround) this.moveAxis(p, 2, -gd); p.onGround = true; }
    else if (p.vel[2] > 0 || free(p.pos[2] - gd, hullH(p))) p.onGround = false;
    if (p.landSpeed > 1) this.land(p, p.landSpeed);
    p.landSpeed = 0;

    // Source gravity: half before the move, half after. The first half lands before the jump check, so a standing jump
    // adds the impulse to −g·dt/2 while a ducking jump sets it outright — that is why crouch jumps reach ~2.3 higher.
    p.vel[2] -= C.sv_gravity * dt * 0.5;
    const wspeed = maxSpeedOf(p, w), maxSpeedRun = wspeed * Math.min(inp.walk ? 0.52 : 1, 1 - 0.66 * p.duck) * p.velMod;
    const pressed = inp.jump && !p.jumpHeld;
    if (pressed && !p.onGround) p.jumpQueued = this.time;
    // shortcut: the press time is tick-resolution here, so the 3.9 ms window only covers presses in the landing tick
    const bhopWindow = wasAir && p.onGround && this.time - p.jumpQueued <= C.sv_bhop_time_window / 2;
    if (p.onGround && (pressed || bhopWindow)) {
      const imp = C.sv_jump_impulse * (1 - p.stamina / C.sv_staminamax); // tired (recent jump/landing) = lower jump
      p.vel[2] = (inp.crouch || p.crouch ? imp : p.vel[2] + imp) - C.sv_gravity * dt * 0.5; // Source's CheckJumpButton ends with FinishGravity
      // → apex 54.65 standing / 57.0 ducking at 64 tick (55.83 / 57.0 at 128): Valve's reachable heights 54 / 56 / 63 / 65
      const sp = Math.hypot(p.vel[0], p.vel[1]), cap = 1.1 * maxSpeedRun;
      if (!C.sv_enablebunnyhopping && sp > cap) { p.vel[0] *= cap / sp; p.vel[1] *= cap / sp; }
      p.stamina = Math.min(C.sv_staminamax, p.stamina + C.sv_staminajumpcost * C.sv_jump_impulse);
      if (w.inacc) p.accPenalty += w.inacc.jumpInitial;
      p.onGround = false;
    }
    p.jumpHeld = !!inp.jump;
    if (p.onGround) p.vel[2] = 0;
    p.stamina = Math.max(0, p.stamina - C.sv_staminarecoveryrate * dt);
    p.velMod = Math.min(1, p.velMod + C.tag_recovery_rate * dt);

    const fx = Math.cos(p.yaw * DEG), fy = Math.sin(p.yaw * DEG);
    let wx = inp.fwd * fx + inp.strafe * fy, wy = inp.fwd * fy - inp.strafe * fx; // right vector = (sin yaw, -cos yaw)
    const wl = Math.hypot(wx, wy); // W+A gives √2: speed is capped to 1, direction is the unit vector (normalised once)
    const tired = 1 - p.stamina / C.sv_staminamax, maxSpeed = maxSpeedRun * tired;
    const wishSpeed = Math.min(wl, 1) * maxSpeed, dir = wl > 1e-9 ? [wx / wl, wy / wl] : [0, 0];
    if (p.onGround) { // sv_accelerate_use_weapon_speed 1: acceleration scales with the current max speed
      friction(p, dt);
      // scaled by the weapon's own speed, not the walk/duck-reduced wish speed: at 34% (AK duck = 73) friction would win
      accelerate(p, dir, wishSpeed, C.sv_accelerate, wishSpeed, dt, wspeed);
      // CS2 landing penalty: on the ground speed is clamped to the weapon cap lowered by stamina (275 → ~189 after a bhop);
      // walk/duck slow-downs still bleed off through friction.
      const sp = Math.hypot(p.vel[0], p.vel[1]), cap = wspeed * p.velMod * tired;
      if (sp > cap) { p.vel[0] *= cap / sp; p.vel[1] *= cap / sp; }
    } else { // "deadstrafe": air acceleration is 4x weaker while rising at 0..140 u/s (Source surface friction quirk)
      const deadstrafe = p.vel[2] > 0 && p.vel[2] <= 140 ? 0.25 : 1;
      accelerate(p, dir, wishSpeed, C.sv_airaccelerate * deadstrafe, C.sv_air_max_wishspeed, dt);
    }
    for (let i = 0; i < 3; i++) p.vel[i] = clamp(p.vel[i], -C.sv_maxvelocity, C.sv_maxvelocity);
    this.moveAxis(p, 0, p.vel[0] * dt); this.moveAxis(p, 1, p.vel[1] * dt);
    if (p.onGround) { // stay on ground walking down steps/ramps: ledges up to ~20 units stick, higher ones drop
      if (free(p.pos[2] - gd, hullH(p))) {
        const z0 = p.pos[2]; p.onGround = false;
        this.moveAxis(p, 2, -(C.sv_stepsize + gd - DIST_EPS));
        if (!p.onGround) p.pos[2] = z0;
        p.landSpeed = 0;
      }
    } else {
      this.moveAxis(p, 2, p.vel[2] * dt);
      if (!p.onGround) p.vel[2] -= C.sv_gravity * dt * 0.5;
    }
    if (p.landSpeed > 1) this.land(p, p.landSpeed);
    p.landSpeed = 0;
  }

  land(p, v) {
    p.stamina = Math.min(C.sv_staminamax, p.stamina + C.sv_staminalandcost * v);
    const I = W(p).inacc;
    if (I) p.accPenalty += I.land * v;
    const dmg = Math.floor((v - C.fall_safe_speed) * 100 / (C.fall_fatal_speed - C.fall_safe_speed));
    if (dmg > 0) this.hurt(null, p, dmg, 'fall', 'fall');
  }

  moveAxis(p, axis, d) {
    if (!d) return;
    const pos = p.pos, h = hullH(p), map = this.map, step = C.sv_stepsize;
    pos[axis] += d;
    let b = this.blocked(p, pos[0], pos[1], pos[2], h);
    if (!b) return;
    if (axis < 2 && p.onGround) { // step up stairs/ledges up to sv_stepsize
      pos[2] += step;
      if (!this.blocked(p, pos[0], pos[1], pos[2], h)) { this.moveAxis(p, 2, -step); return; }
      pos[2] -= step;
    } else if (axis < 2 && map.grid && b[5] - pos[2] <= map.grid.size) {
      // Airborne against a voxel ramp's riser (≤ one voxel above the feet): rise onto it, as Source slides along the slope
      // plane, instead of stopping dead — jumping while running uphill would otherwise kill all speed.
      const z0 = pos[2];
      pos[2] = b[5] + DIST_EPS;
      if (!this.blocked(p, pos[0], pos[1], pos[2], h)) return;
      pos[2] = z0;
    }
    for (let i = 0; b && i < 4; i++, b = this.blocked(p, pos[0], pos[1], pos[2], h)) {
      const ext = axis < 2 ? HULL_R : 0;
      pos[axis] = d > 0 ? b[axis] - (axis < 2 ? HULL_R : h) - DIST_EPS : b[axis + 3] + ext + DIST_EPS;
    }
    if (axis === 2 && d < 0) { p.onGround = true; p.landSpeed = -p.vel[2]; }
    p.vel[axis] = 0;
  }

  // Map collision plus other living players' hulls (CS2: players block each other and can stand on heads).
  blocked(p, x, y, z, h) {
    const b = hullHit(this.map, x, y, z, h);
    if (b) return b;
    for (const q of this.players) {
      if (q === p || !q.alive || (!C.mp_solid_teammates && q.team === p.team)) continue;
      const qb = [q.pos[0] - HULL_R, q.pos[1] - HULL_R, q.pos[2], q.pos[0] + HULL_R, q.pos[1] + HULL_R, q.pos[2] + hullH(q)];
      if (x - HULL_R < qb[3] && x + HULL_R > qb[0] && y - HULL_R < qb[4] && y + HULL_R > qb[1] && z < qb[5] && z + h > qb[2]) return qb;
    }
    return null;
  }

  startReload(p) {
    const w = W(p), s = p.weapon;
    if (w.melee || w.slot === 'grenade' || p.reloadUntil || p.ammo[s] >= w.mag || !p.reserve[s]) return;
    // shotguns load shell by shell: the reload lasts one shell's time per missing shell
    // shortcut: the whole shell reload is one action (CS lets you fire between shells); split it if bots should
    const shells = w.perShell ? Math.min(w.mag - p.ammo[s], p.reserve[s]) : 1;
    p.reloadStart = this.time; p.reloadUntil = this.time + w.reload * shells; p.reloadShells = shells;
    p.zoom = p.resumeZoom = 0; // reloading takes you out of the scope
  }

  // Weapon switch: slot 0–2 = loadout, 3 = grenade p.nades[p.nade]. Cancels reload, zoom and a pulled pin.
  switchTo(p, slot, t) {
    if (p.weapon !== 3) p.prevWeapon = p.weapon;
    p.weapon = slot; p.reloadUntil = 0; p.deployStart = t; p.nextAttack = t + W(p).deploy; p.recoilIndex = 0;
    p.zoom = p.resumeZoom = 0; p.pin = p.throwAt = 0;
  }

  // Grenade in hand: holding fire/attack2 pulls the pin (once drawn), the buttons held set the throw (LMB long, RMB short
  // underhand, both medium), releasing throws 0.1 s later.
  grenadeInput(p, fire, attack2, t0) {
    if (!p.throwAt) {
      if ((fire || attack2) && !p.pin && t0 >= p.nextAttack) p.pin = t0;
      if (p.pin && (fire || attack2)) p.throwStrength = fire && attack2 ? 0.5 : fire ? 1 : 0;
      else if (p.pin) p.throwAt = t0 + NADE.throwDelay;
    }
    if (p.throwAt && p.throwAt < t0 + DT) this.throwNade(p, p.throwAt);
  }

  throwNade(p, ts) {
    const w = W(p), s = p.throwStrength;
    // CS: the throw pitch is bent 10° up (looking straight ahead throws at −10°)
    const pitch = p.pitch < 0 ? -10 + p.pitch * 80 / 90 : -10 + p.pitch * 100 / 90, d = dirFromAngles(p.yaw, pitch);
    const e = eye(p), src = [e[0], e[1], e[2] + s * 12 - 12], ahead = Math.max(0, rayWorld(this.map, src, d, 16) - NADE.radius);
    const v = NADE.speed * (0.3 + 0.7 * s);
    const n = { id: ++this.nadeId, type: w.name, by: p.id, team: p.team, born: ts, state: 'fly', until: 0, next: 0,
      pos: src.map((c, i) => c + d[i] * ahead), vel: d.map((c, i) => c * v + p.vel[i] * 1.25) };
    this.nades.push(n);
    this.events.push({ type: 'throw', by: p.id, weapon: w.name, id: n.id, strength: s });
    p.nades.splice(p.nade, 1); p.nade = 0; p.lastShot = ts;
    this.switchTo(p, p.prevWeapon, ts); // back to the weapon held before
  }

  // Thrown grenades (flight, bounces, fuses), smokes, fires and decoys: once per tick.
  tickNades() {
    if (!this.nades.length && !this.smokes.length && !this.fires.length) return;
    const t = this.time, g = C.sv_gravity * NADE.gravityScale;
    for (const n of this.nades) {
      if (n.state === 'fly') {
        n.vel[2] -= g * DT * 0.5; this.moveNade(n, DT); if (n.state === 'fly') n.vel[2] -= g * DT * 0.5;
        const age = t - n.born;
        if (n.state === 'done') continue; // a molotov that hit the floor
        if ((n.type === 'hegrenade' || n.type === 'flashbang') && age >= NADE.fuse) this.detonate(n);
        else if (FIRE.has(n.type) && age >= NADE.molotovAir) this.detonate(n);
      }
      if (n.state === 'rest' && (n.type === 'smokegrenade' || n.type === 'decoy')) this.detonate(n);
      else if (n.state === 'rest' && (n.type === 'hegrenade' || n.type === 'flashbang') && t - n.born >= NADE.fuse) this.detonate(n);
      if (n.state === 'decoy') { // the thrower's primary firing in bursts, then a small pop
        if (t >= n.next) { this.events.push({ type: 'decoyShot', id: n.id, pos: [...n.pos], weapon: (this.players.find(q => q.id === n.by)?.loadout[0] || WEAPONS[0]).name }); n.next = t + 0.15 + this.rng() * 0.9; }
        if (t >= n.until) { n.state = 'done'; this.events.push({ type: 'detonate', weapon: 'decoy', id: n.id, pos: [...n.pos], by: n.by, end: true }); }
      }
    }
    this.nades = this.nades.filter(n => n.state !== 'done');
    for (const f of this.fires) for (const q of this.players) { // fire: 40 hp/s while standing in it (thrower included, no team damage)
      const by = this.players.find(x => x.id === f.by);
      if (!q.alive || (by && q !== by && q.team === by.team) || Math.hypot(q.pos[0] - f.pos[0], q.pos[1] - f.pos[1]) > NADE.fireRadius + HULL_R) continue;
      if (Math.abs(feetZ(q) - f.pos[2]) > 40) continue;
      q.fireAcc += CATALOG[f.type].dmg * DT;
      const dmg = Math.floor(q.fireAcc);
      if (dmg > 0) { q.fireAcc -= dmg; this.hurt(by === q ? null : by, q, dmg, 'generic', f.type); }
    }
    this.fires = this.fires.filter(f => t < f.until);
    this.smokes = this.smokes.filter(s => t < s.until);
  }

  // Flight with bounces off the map's faces (players are not obstacles for grenades here).
  moveNade(n, dt) {
    let left = dt;
    for (let i = 0; i < 4 && left > 1e-6; i++) {
      const sp = Math.hypot(...n.vel);
      if (sp < 1e-6) return;
      const d = n.vel.map(v => v / sp), dist = sp * left, hit = rayWorld(this.map, n.pos, d, dist + NADE.radius);
      if (hit >= dist + NADE.radius) { n.pos = n.pos.map((c, k) => c + d[k] * dist); return; }
      const go = Math.max(0, hit - NADE.radius);
      n.pos = n.pos.map((c, k) => c + d[k] * go); left -= go / sp;
      const nrm = surfaceNormal(this.map, n.pos.map((c, k) => c + d[k] * (hit - go)), d), vn = n.vel[0] * nrm[0] + n.vel[1] * nrm[1] + n.vel[2] * nrm[2];
      if (nrm[2] > 0.7 && FIRE.has(n.type)) { this.detonate(n); return; } // a molotov breaks on the floor
      n.vel = n.vel.map((v, k) => (v - 2 * vn * nrm[k]) * NADE.elasticity);
      if (-vn > 60) this.events.push({ type: 'bounce', id: n.id, weapon: n.type, pos: [...n.pos] });
      if (nrm[2] > 0.7 && Math.hypot(...n.vel) < 20) { n.vel = [0, 0, 0]; n.state = 'rest'; return; }
    }
  }

  detonate(n) {
    const t = this.time, at = n.pos, w = CATALOG[n.type], by = this.players.find(q => q.id === n.by);
    n.state = 'done';
    const clear = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      return rayWorld(this.map, a, [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d], d) >= d - 1; };
    if (FIRE.has(n.type)) {
      if (this.smokes.some(s => this.inSmoke(s, at))) { this.events.push({ type: 'extinguish', id: n.id, pos: [...at] }); return; } // into a smoke: fizzles
      const down = rayWorld(this.map, at, [0, 0, -1], 128); // in the air: fire only if the floor is close below
      if (down >= 128) { this.events.push({ type: 'detonate', weapon: n.type, id: n.id, pos: [...at], by: n.by, air: true }); return; }
      const fire = { id: n.id, type: n.type, by: n.by, pos: [at[0], at[1], at[2] - down], born: t, until: t + NADE.fireTime };
      this.fires.push(fire);
      this.events.push({ type: 'detonate', weapon: n.type, id: n.id, pos: [...fire.pos], by: n.by });
      return;
    }
    this.events.push({ type: 'detonate', weapon: n.type, id: n.id, pos: [...at], by: n.by });
    if (n.type === 'decoy') { n.state = 'decoy'; n.until = t + NADE.decoyTime; n.next = t; return; }
    if (n.type === 'smokegrenade') {
      const s = { id: n.id, pos: [...at], born: t, until: t + NADE.smokeTime };
      this.smokes.push(s);
      this.fires = this.fires.filter(f => { const out = Math.hypot(f.pos[0] - at[0], f.pos[1] - at[1]) < NADE.smokeRadius + NADE.fireRadius && Math.abs(f.pos[2] - at[2]) < 120;
        if (out) this.events.push({ type: 'extinguish', id: f.id, pos: [...f.pos] }); return !out; });
      return;
    }
    for (const q of this.players) {
      if (!q.alive || (by && q !== by && q.team === by.team)) continue; // no team damage, as for bullets
      if (n.type === 'hegrenade') { // CS radius damage: gaussian falloff (σ = radius/3), blocked by walls, armor as for bullets
        const c = [q.pos[0], q.pos[1], feetZ(q) + height(q) / 2], d = Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]);
        if (d > w.range || !clear(at, c)) continue;
        const k = Math.exp(-(d * d) / (2 * (w.range / 3) ** 2));
        if (w.dmg * k >= 1) this.damage(by === q ? null : by, q, { ...w, rm: 0 }, k, 0, 'generic');
      } else if (n.type === 'flashbang') { // blind: full white, then a fade; less when looking away or far
        const e = eye(q), d = Math.hypot(e[0] - at[0], e[1] - at[1], e[2] - at[2]);
        if (d > NADE.flashRange || !clear(at, e) || this.smokes.some(s => this.segSmoke(s, at, e))) continue;
        const f = dirFromAngles(q.yaw, q.pitch), dot = (f[0] * (at[0] - e[0]) + f[1] * (at[1] - e[1]) + f[2] * (at[2] - e[2])) / (d || 1);
        const k = (1 - d / NADE.flashRange) * (dot >= 0.6 ? 1 : dot >= 0.3 ? 0.6 : dot >= -0.2 ? 0.4 : 0.2);
        q.flashHold = Math.max(q.flashHold, t + NADE.flashHold * k); q.flashEnd = Math.max(q.flashEnd, t + (NADE.flashHold + NADE.flashFade) * k);
        this.events.push({ type: 'flashed', victim: q.id, by: n.by, amount: k });
      }
    }
  }
  // smoke volume: a sphere above the landing point that grows for smokeGrow seconds
  smokeR(s) { return NADE.smokeRadius * Math.min(1, (this.time - s.born) / NADE.smokeGrow); }
  inSmoke(s, pt) { const c = [s.pos[0], s.pos[1], s.pos[2] + NADE.smokeLift]; return Math.hypot(pt[0] - c[0], pt[1] - c[1], pt[2] - c[2]) < this.smokeR(s); }
  segSmoke(s, a, b) { // does the segment a→b pass through smoke s?
    const c = [s.pos[0], s.pos[1], s.pos[2] + NADE.smokeLift], r = this.smokeR(s), ab = b.map((v, i) => v - a[i]), L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const u = clamp(L2 ? ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / L2 : 0, 0, 1);
    return Math.hypot(a[0] + ab[0] * u - c[0], a[1] + ab[1] * u - c[1], a[2] + ab[2] * u - c[2]) < r;
  }

  // One shot at time ts with view angles (yaw, pitch); stab = knife right-click. Returns false if nothing was fired.
  fire(p, yaw, pitch, ts, stab = false) {
    const w = W(p);
    if (!w.melee && p.ammo[p.weapon] <= 0) { this.startReload(p); return false; }
    p.nextAttack = ts + (w.melee ? (stab ? w.stab.cycle : w.cycle) : p.burst && w.burst ? w.burst.gap : w.cycle);
    const mode = p.burst && w.burst ? w.burst : zoomed(p, w) || w, acc = w.melee ? 0 : inaccuracy(p);
    if (zoomed(p, w) && !w.auto) { p.resumeZoom = p.zoom; p.zoom = 0; } // AWP/SSG: out of the scope for the bolt, back in after it
    if (!w.melee) {
      p.ammo[p.weapon]--;
      if (w.pattern) { // measured spray: this bullet's aim punch is the table entry for its place in the spray (bullets fly at 2×punch)
        const [up, right] = w.pattern[Math.min(Math.floor(p.recoilIndex), w.pattern.length - 1)];
        p.punch[0] = -up / C.weapon_recoil_scale; p.punch[1] = -right / C.weapon_recoil_scale; p.punchVel[0] = p.punchVel[1] = 0;
      }
    }
    // shotguns fire m_nNumBullets pellets, each with its own spread, trace and damage (one shell, one kick)
    for (let pellet = 0; pellet < (w.melee ? 1 : w.pellets || 1); pellet++) {
      let py = yaw, pp = pitch;
      if (!w.melee) { // CS spread: one random offset inside the inaccuracy circle plus one inside the weapon spread circle
        const r0 = this.rng() * acc, t0 = this.rng() * 2 * Math.PI, r1 = this.rng() * mode.spread, t1 = this.rng() * 2 * Math.PI;
        pp += (Math.cos(t0) * r0 + Math.cos(t1) * r1) / DEG + p.punch[0] * C.weapon_recoil_scale;
        py += (Math.sin(t0) * r0 + Math.sin(t1) * r1) / DEG + p.punch[1] * C.weapon_recoil_scale;
      }
      this.trace(p, w, py, pp, ts, stab, pellet);
    }
    if (!w.melee) {
      if (!w.pattern) {
        const [up, right] = w.kicks[Math.min(Math.floor(p.recoilIndex), w.kicks.length - 1)], ks = C.recoil_kick_scale * (mode.kickScale || 1);
        p.punchVel[0] -= up * ks; p.punchVel[1] -= right * ks; // pitch − = up; yaw − = right
      }
      p.accPenalty += mode.inacc.fire;
      p.recoilIndex += 1;
    }
    p.lastShot = ts;
    return true;
  }

  // One bullet (or pellet, or knife swing) from p's eye along (yaw, pitch): walls, penetration, the player it hits, damage.
  trace(p, w, yaw, pitch, ts, stab, pellet) {
    const d = dirFromAngles(yaw, pitch), start = eye(p);
    // Trace through up to w.penLayers walls (m_flPenetration); each wall costs damage by thickness.
    let o = start, left = w.melee ? (stab ? w.stab.range : w.range) : w.range, travelled = 0, scale = 1, layers = w.penLayers || 0, hit = null, end = null, pierced = 0;
    for (;;) {
      let t = rayWorld(this.map, o, d, left);
      for (const q of this.players) {
        if (q === p || !q.alive) continue;
        for (const hb of hitboxes(q)) {
          // knife swings are a hull trace in CS (head_hull 32×32×36), not a thin ray: grow the target boxes by its half-size
          const b = w.melee ? [hb.box[0] - 16, hb.box[1] - 16, hb.box[2] - 18, hb.box[3] + 16, hb.box[4] + 16, hb.box[5] + 18] : hb.box;
          const th = rayBox(o, d, b, t); if (th < t) { t = th; hit = { q, hb }; }
        }
      }
      const at = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      travelled += t;
      if (hit || t >= left || layers-- <= 0) { end = at; break; }
      const thick = wallThickness(this.map, at, d, 12 * w.penetration); // shortcut: no surface materials in the voxel map — thickness only, tune if wallbangs feel off
      if (thick === Infinity) { end = at; break; }
      scale *= 0.5 ** (thick / (6 * w.penetration)); pierced++;
      o = [at[0] + d[0] * (thick + 0.5), at[1] + d[1] * (thick + 0.5), at[2] + d[2] * (thick + 0.5)];
      left -= t + thick + 0.5; travelled += thick + 0.5;
    }
    this.events.push({ type: 'shot', by: p.id, weapon: w.name, t: ts, from: start, to: end, hitPlayer: !!hit, wall: !hit && travelled < w.range - 1, pierced, pellet });
    if (hit && hit.q.team !== p.team) {
      if (w.melee) { // knife: no hitgroups; hitting from behind is a backstab (CS: 90 slash / 180 stab)
        const q = hit.q, f = [Math.cos(q.yaw * DEG), Math.sin(q.yaw * DEG)], lx = q.pos[0] - p.pos[0], ly = q.pos[1] - p.pos[1], l = Math.hypot(lx, ly) || 1;
        const back = (f[0] * lx + f[1] * ly) / l > 0.475;
        this.damage(p, q, { ...w, dmg: stab ? (back ? w.stab.back : w.stab.dmg) : back ? w.backDmg : w.dmg }, 1, travelled, hit.hb.name);
      } else this.damage(p, hit.q, w, hit.hb.mult * scale, travelled, hit.hb.name);
    }
  }

  damage(att, vic, w, mult, dist, group) {
    let dmg = w.dmg * mult * (w.rm ? Math.pow(w.rm, dist / 500) : 1);
    if (vic.armor > 0 && group !== 'legs') { // kevlar + helmet assumed
      const hp = dmg * w.pen; vic.armor = Math.max(0, vic.armor - (dmg - hp) * 0.5); dmg = hp;
    }
    vic.velMod = Math.min(vic.velMod, C.tag_velocity_modifier); // tagging: getting shot slows you down
    this.hurt(att, vic, Math.floor(dmg), group, w.name);
  }

  hurt(att, vic, dmg, group, weapon) { // att = null for fall damage
    dmg = Math.min(dmg, vic.hp);
    vic.hp -= dmg;
    if (att) this.rew[att.id] += dmg / 100;
    this.rew[vic.id] -= dmg / 100;
    this.events.push({ type: 'hit', by: att ? att.id : -1, victim: vic.id, group, dmg });
    if (vic.hp <= 0) {
      vic.alive = false;
      if (att) { att.kills++; this.rew[att.id] += 1; }
      this.rew[vic.id] -= 1;
      this.events.push({ type: 'kill', by: att ? att.id : -1, victim: vic.id, weapon, headshot: group === 'head' });
    }
  }

  // Aim error (deg) from p's view to point; visible = in 106° FOV, not occluded by walls or smoke, p not fully flashed.
  look(p, pt) {
    const o = eye(p), dx = pt[0] - o[0], dy = pt[1] - o[1], dz = pt[2] - o[2], dist = Math.hypot(dx, dy, dz);
    const yawErr = wrap180(Math.atan2(dy, dx) / DEG - p.yaw), pitchErr = -Math.atan2(dz, Math.hypot(dx, dy)) / DEG - p.pitch;
    const visible = Math.abs(yawErr) < 53 && Math.abs(pitchErr) < 45 && this.time >= p.flashHold &&
      rayWorld(this.map, o, [dx / dist, dy / dist, dz / dist], dist) >= dist && !this.smokes.some(s => this.segSmoke(s, o, pt));
    return { yawErr, pitchErr, dist, dx, dy, dz, visible };
  }
  headOf(q) { const h = height(q); return [q.pos[0], q.pos[1], feetZ(q) + 0.9 * h]; }

  observeAll() { return this.players.slice(0, this.nAgents).map(p => this.observe(p)); }

  observe(p) {
    const w = W(p), c = Math.cos(p.yaw * DEG), s = Math.sin(p.yaw * DEG);
    const local = (x, y) => [x * c + y * s, x * s - y * c]; // → [forward, right]
    const [vf, vr] = local(p.vel[0], p.vel[1]);
    const o = [
      p.hp / 100, p.armor / 100, ...p.loadout.map((_, i) => +(i === p.weapon)), // slot one-hot: same size whatever the loadout
      w.mag ? p.ammo[p.weapon] / w.mag : 1, w.reserve ? p.reserve[p.weapon] / w.reserve : 1,
      +!!p.reloadUntil, +(this.time >= p.nextAttack && !p.reloadUntil),
      vf / 250, vr / 250, p.vel[2] / 300, +p.onGround, +p.crouch,
      Math.sin(p.yaw * DEG), Math.cos(p.yaw * DEG), p.pitch / 89,
      p.pos[0] / 2048, p.pos[1] / 2048, p.pos[2] / 512, Math.min(p.recoilIndex, 30) / 30,
      1 - this.time / this.cfg.maxSeconds, p.stamina / C.sv_staminamax, p.velMod,
      p.duck, p.punch[0] / 10, p.punch[1] / 10, Math.min(inaccuracy(p) * 10, 3), // recoil state: what to compensate
    ];
    const e = eye(p), R = this.cfg.rays; // depth ring, ray 0 = straight ahead, counter-clockwise
    for (let i = 0; i < R; i++) o.push(rayWorld(this.map, e, dirFromAngles(p.yaw + (360 * i) / R, 0), 2048) / 2048);
    const others = this.players.filter(q => q !== p).sort((a, b) => (a.team === p.team) - (b.team === p.team) || a.id - b.id);
    for (const q of others) { // enemies first, then allies; enemies only if visible (no wallhack)
      const l = this.look(p, this.headOf(q)), ally = q.team === p.team;
      if (!q.alive || (!ally && !l.visible)) { o.push(0, 0, 0, 0, 0, 0, 0); continue; }
      const [lf, lr] = local(l.dx, l.dy);
      o.push(1, lf / 2048, lr / 2048, l.dz / 512, l.yawErr / 180, l.pitchErr / 90, q.hp / 100);
    }
    return o;
  }

  // Scripted opponent: wanders, aims at visible enemies with skill-limited turn speed, bursts, pulls down against recoil.
  botAction(p) {
    if (!p.alive) return new Array(ACTION_SIZE).fill(0);
    const s = this.cfg.botSkill, fs = this.cfg.frameSkip, maxTurn = (1.5 + 8 * s) * fs;
    let best = null;
    for (const q of this.players) {
      if (q.team === p.team || !q.alive) continue;
      const l = this.look(p, this.headOf(q));
      if (l.visible && (!best || l.dist < best.dist)) best = l;
    }
    if (best) {
      p.seen += fs;
      const noise = (1 - s) * 3, comp = C.weapon_recoil_scale * s; // bullets go to view + 2×punch: aim that much the other way
      const ey = best.yawErr - p.punch[1] * comp, ep = best.pitchErr - p.punch[0] * comp;
      const dy = clamp(ey + (this.rng() - 0.5) * noise, -maxTurn, maxTurn), dp = clamp(ep + (this.rng() - 0.5) * noise, -maxTurn, maxTurn);
      const onTarget = Math.abs(ey) < 2.5 && Math.abs(ep) < 2.5;
      const fire = onTarget && p.seen >= (0.45 - 0.35 * s) * TICK && p.recoilIndex < 4;
      return [0, 0, dy, dp, 0, 0, 0, +fire, 0, 1, 0, 0];
    }
    p.seen = 0;
    if (Math.floor(this.tick / fs) % 4 === p.id % 4) { // re-plan every 4 steps: head for the enemy, steer around walls
      // shortcut: the scripted bot knows where the enemy is and has no pathfinding (can stall in dead ends); add a nav mesh if it must navigate.
      const foe = this.players.find(q => q.team !== p.team && q.alive), o = [p.pos[0], p.pos[1], p.pos[2] + 40];
      const want = (foe ? Math.atan2(foe.pos[1] - p.pos[1], foe.pos[0] - p.pos[0]) / DEG : p.heading) + (this.rng() - 0.5) * 40;
      const stuck = Math.hypot(p.vel[0], p.vel[1]) < 30 && this.rng() < 0.3;
      let pick = null;
      for (let a = 0; a <= 160 && pick === null; a += 20)
        for (const sgn of this.rng() < 0.5 ? [a, -a] : [-a, a]) if (pick === null && rayWorld(this.map, o, dirFromAngles(want + sgn, 0), 200) >= 200) pick = want + sgn;
      p.heading = wrap180(stuck || pick === null ? p.yaw + 90 + this.rng() * 180 : pick);
    }
    return [1, 0, clamp(wrap180(p.heading - p.yaw), -maxTurn, maxTurn), -p.pitch, 0, 0, 0, 0, +(p.ammo[p.weapon] < 10), 1, 0, 0];
  }

  state() {
    const t = this.time;
    return { tick: this.tick, time: t, done: this.done, winner: this.winner, events: this.events,
      nades: this.nades.map(n => ({ id: n.id, type: n.type, pos: n.pos, state: n.state })),
      smokes: this.smokes.map(s => ({ id: s.id, pos: s.pos, born: s.born, until: s.until, r: this.smokeR(s) })),
      fires: this.fires.map(f => ({ id: f.id, type: f.type, pos: f.pos, born: f.born, until: f.until, r: NADE.fireRadius })),
      players: this.players.map(p => {
        const w = W(p), nade = w.slot === 'grenade';
        return { id: p.id, team: p.team, pos: p.pos, dz: p.dz, vel: p.vel, onGround: p.onGround, yaw: p.yaw, pitch: p.pitch, hp: p.hp, armor: p.armor,
          alive: p.alive, crouch: p.crouch, duck: p.duck, weapon: p.weapon, weaponName: w.name, loadout: p.loadout.map(x => x.name),
          nades: [...p.nades], nade: p.nade, pin: !!p.pin, throwStrength: p.throwStrength,
          ammo: nade ? null : p.ammo[p.weapon], reserve: nade ? null : p.reserve[p.weapon], kills: p.kills, reloading: !!p.reloadUntil,
          reloadFrac: p.reloadUntil ? clamp((t - p.reloadStart) / (p.reloadUntil - p.reloadStart), 0, 1) : -1, reloadShells: p.reloadShells, // shell reloads last longer
          zoom: p.zoom, zoomFov: zoomed(p, w) ? w.scoped.fov[p.zoom - 1] : 0, flashHold: p.flashHold, flashEnd: p.flashEnd,
          deployFrac: clamp((t - p.deployStart) / w.deploy, 0, 1), punch: p.punch, inaccuracy: inaccuracy(p), lastShot: p.lastShot };
      }) };
  }
}

const LIM = [[-1, 1], [-1, 1], [-180, 180], [-90, 90], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 4], [0, 0.999], [0, 0.999], [0, 1]];
function sanitize(a) { // trust boundary: actions come from the network
  return LIM.map(([lo, hi], i) => {
    const v = clamp(Number(a?.[i]) || 0, lo, hi);
    return i === 9 ? Math.round(v) : i === 10 || i === 11 || i < 4 ? v : +(v > 0.5);
  });
}
function friction(p, dt) {
  const v = p.vel, sp = Math.hypot(v[0], v[1]);
  if (sp < 0.1) { v[0] = v[1] = 0; return; }
  const k = Math.max(sp - Math.max(sp, C.sv_stopspeed) * C.sv_friction * dt, 0) / sp;
  v[0] *= k; v[1] *= k;
}
function accelerate(p, dir, wishSpeed, accel, cap, dt, scale = wishSpeed) {
  const add = Math.min(wishSpeed, cap) - (p.vel[0] * dir[0] + p.vel[1] * dir[1]);
  if (add <= 0) return;
  const a = Math.min(accel * scale * dt, add);
  p.vel[0] += a * dir[0]; p.vel[1] += a * dir[1];
}
