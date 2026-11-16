// Player visuals: third-person avatars and the first-person viewmodel (arms + weapon), in Source units (feet at y=0,
// facing +X, right = +Z). With public/models/models.json present: the CS2 agent and weapon models and their animations
// (loadModels); otherwise original low-poly stand-ins animated procedurally from sim state.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CATALOG } from '/sim/core.js';

const DEG = Math.PI / 180, WEAPON_NAMES = ['ak47', 'glock', 'knife'];
// p.weaponName = CS2 internal name (sim state, demos); older states only carry the default-loadout slot index
const nameOf = p => p.weaponName || WEAPON_NAMES[p.weapon] || 'ak47';
// the agents' locomotion set (world/<class>/_default_<class>) a weapon is carried with
const classOf = n => (CATALOG[n]?.type === 'knife' ? 'knife' : !CATALOG[n] || CATALOG[n].slot === 'primary' ? 'rifle' : 'pistol');
const standIn = n => ({ rifle: 'ak47', pistol: 'glock', knife: 'knife' })[classOf(n)];
const mats = {};
const mat = (c, emissive) => (mats[c + (emissive ? 'e' : '')] ||= emissive
  ? new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  : new THREE.MeshLambertMaterial({ color: c }));
function box(w, h, d, color, x = 0, y = 0, z = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z); m.rotation.z = rz; return m;
}
const group = (x = 0, y = 0, z = 0, ...kids) => { const g = new THREE.Group(); g.position.set(x, y, z); kids.forEach(k => g.add(k)); return g; };
const smooth = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const ease = t => t * t * (3 - 2 * t);

// Weapons point along +X with the grip at the origin; userData.muzzle = muzzle position.
export function weaponMesh(name) {
  const METAL = 0x2b2b2b, WOOD = 0x7a4a22, DARK = 0x161616, STEEL = 0xb8bcc0;
  let g;
  if (name === 'ak47') {
    g = group(0, 0, 0,
      box(14, 2.6, 1.8, METAL, 4, 1.4), box(9, 2.1, 2.1, WOOD, 14.5, 1.1), box(10, 0.7, 0.7, METAL, 23, 1.8),
      box(8, 0.6, 0.6, METAL, 14, 3), box(1.5, 4.2, 1.2, WOOD, -0.5, -1.6, 0, -0.35),
      box(10, 2.6, 1.4, WOOD, -8, 0.6, 0, 0.1), box(0.4, 1.2, 0.3, METAL, 26.5, 2.6));
    g.userData.mag = group(6, -0.4, 0, box(2.2, 7, 1.3, METAL, 0, -2.2, 0, 0.35)); g.add(g.userData.mag);
    g.userData.muzzle = new THREE.Vector3(28.5, 1.8, 0);
  } else if (name === 'glock') {
    g = group(0, 0, 0, box(6, 0.9, 1, DARK, 2.2, 0.5), box(1.4, 4.4, 1.1, DARK, 0.1, -1.6, 0, -0.25));
    g.userData.slide = box(7.4, 1.4, 1.1, DARK, 2.6, 1.5); g.add(g.userData.slide);
    g.userData.muzzle = new THREE.Vector3(6.6, 1.5, 0);
  } else {
    const shape = new THREE.Shape([[0, -0.55], [6, -0.55], [7.8, 0.3], [6, 0.85], [0, 0.85]].map(([x, y]) => new THREE.Vector2(x, y)));
    const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false }), mat(STEEL));
    blade.position.set(2.7, 0, -0.11);
    g = group(0, 0, 0, box(4.6, 1.2, 1, DARK, 0, 0), box(0.4, 1.8, 1.3, METAL, 2.5, 0.1), blade);
  }
  return g;
}
function muzzleFlash(gun) {
  if (!gun.userData.muzzle) return null;
  const f = group(0, 0, 0, box(3.5, 1.6, 1.6, 0xffc060, 0, 0, 0), box(1.6, 3.2, 0.2, 0xffe0a0, 0.5, 0, 0), box(1.6, 0.2, 3.2, 0xffe0a0, 0.5, 0, 0));
  f.children.forEach(m => (m.material = mat(m.material.color.getHex(), true)));
  f.position.copy(gun.userData.muzzle).add(new THREE.Vector3(1.6, 0, 0)); f.visible = false; gun.add(f);
  return f;
}

// Limb hangs along -Y from its joint; returns [joint, childJoint].
function limb(parent, x, y, z, len, w, color, endColor) {
  const j = group(x, y, z, box(w, len, w, color, 0, -len / 2)), k = group(0, -len, 0, box(w * 0.9, len, w * 0.9, color, 0, -len / 2));
  if (endColor != null) k.add(box(w + 0.6, 3, w + 0.6, endColor, 0, -len - 1.5));
  j.add(k); parent.add(j); return [j, k];
}

export function makeAvatar(team) {
  if (real) return makeRealAvatar(team);
  const C = team ? { shirt: 0x41608c, pants: 0x2d3a4b, vest: 0x26354a, helm: 0x30405a }
    : { shirt: 0x9a7b4c, pants: 0x5a4a34, vest: 0x6a5838, helm: 0x5a4a30 };
  const SKIN = 0xc79a78, BOOT = 0x1e1e1e, GLOVE = 0x2a2a2a;
  const root = new THREE.Group(), body = group(), hips = group(0, 36, 0);
  root.add(body); body.add(hips);
  const torso = group(0, 0, 0, box(8, 22, 14, C.shirt, 0, 11), box(9.5, 13, 15, C.vest, 0.3, 12), box(3, 5, 10, C.vest, 4.6, 8));
  hips.add(torso);
  const chest = group(0, 20, 0); torso.add(chest); // pitches with aim: head, arms, weapon
  const head = group(0, 3, 0, box(7.5, 8.5, 7.5, SKIN, 0.5, 4.5), box(8.5, 3.5, 8.5, C.helm, 0, 9), box(1.2, 1, 6, 0x111111, 4.3, 6));
  chest.add(head);
  const legs = [-1, 1].map(s => limb(hips, 0, 0, s * 4.4, 17.5, 5.5, C.pants, BOOT));
  const arms = [-1, 1].map(s => limb(chest, 0, 0, s * 9.5, 11, 4, C.shirt, GLOVE));
  const holder = group(11, -3, 2.5); chest.add(holder);
  const guns = WEAPON_NAMES.map(n => { const g = weaponMesh(n); holder.add(g); g.userData.flash = muzzleFlash(g); return g; });
  root.userData = { body, hips, torso, chest, head, legs, arms, holder, guns, phase: 0, duck: 0, air: 0, land: 0, wasGround: true,
    deathT: -1, lean: 0, side: 0, swing: 0, lastShot: -9 };
  return root;
}

// Arm poses per weapon: [upper z, lower z, upper x] for left (index 0) and right arm.
const POSES = { ak47: [[70, 35, -0.55], [35, 75, 0.2]], glock: [[75, 15, -0.7], [70, 15, 0.25]], knife: [[20, 30, 0], [50, 50, 0.15]] };

export function updateAvatar(a, p, dt, firstPerson = false, simTime = 0) {
  if (a.userData.real) return updateRealAvatar(a, p, dt, firstPerson, simTime);
  const u = a.userData, name = standIn(nameOf(p)), wi = WEAPON_NAMES.indexOf(name);
  u.guns.forEach((g, i) => (g.visible = i === wi && !firstPerson));
  u.head.visible = !firstPerson;
  u.arms.forEach(([j]) => (j.visible = !firstPerson));

  if (!p.alive) { // fall over in 0.45 s, knees buckling
    if (u.deathT < 0) u.deathT = 0;
    u.deathT = Math.min(1, u.deathT + dt / 0.45);
    const t = ease(u.deathT);
    u.body.rotation.z = -Math.PI / 2 * t; u.body.position.y = 4 * t;
    u.legs.forEach(([th, kn]) => { th.rotation.z = 25 * DEG * (1 - t); kn.rotation.z = -50 * DEG * (1 - t); });
    return;
  }
  u.deathT = -1; u.body.rotation.set(0, 0, 0); u.body.position.y = 0;

  // Velocity in the body frame: forward (+X) and right (+Z).
  const c = Math.cos(p.yaw * DEG), s = Math.sin(p.yaw * DEG), vx = p.vel?.[0] || 0, vy = p.vel?.[1] || 0;
  const fwd = vx * c + vy * s, right = vx * s - vy * c, speed = Math.hypot(fwd, right), air = p.onGround === false;
  // Gait: phase advances with distance travelled, so feet don't slide; stride grows with speed.
  const stride = 44 + speed * 0.1;
  if (!air) u.phase += (speed * dt / stride) * 2 * Math.PI;
  const k = Math.min(speed / 230, 1), dirF = speed > 1 ? fwd / speed : 1, dirS = speed > 1 ? right / speed : 0;
  u.duck = smooth(u.duck, p.duck ?? +p.crouch, 30, dt);
  u.air = smooth(u.air, air ? 1 : 0, 14, dt);
  if (!air && !u.wasGround) u.land = 1; // landing squash
  u.wasGround = !air; u.land = Math.max(0, u.land - dt / 0.18);
  const amp = k * (u.duck > 0.5 ? 26 : 34) * DEG;
  u.hips.position.y = 36 - 17 * u.duck - Math.abs(Math.sin(u.phase)) * 1.6 * k - 3.5 * Math.sin(u.land * Math.PI);
  u.legs.forEach(([thigh, knee], i) => {
    const ph = u.phase + (i ? Math.PI : 0), sw = Math.sin(ph) * amp;
    const crouchThigh = 62 * DEG * u.duck, crouchKnee = -122 * DEG * u.duck;
    thigh.rotation.z = crouchThigh + sw * dirF * (1 - u.air) + 38 * DEG * u.air;
    thigh.rotation.x = -sw * dirS * 0.8 * (1 - u.air); // side-step when strafing
    knee.rotation.z = crouchKnee - Math.max(0, Math.cos(ph)) * amp * 1.5 * (1 - u.air) - 72 * DEG * u.air * (1 - u.duck);
  });
  // Lean into motion, sway with the gait, breathe when idle.
  u.lean = smooth(u.lean, -fwd / 250 * 0.12, 6, dt); u.side = smooth(u.side, right / 250 * 0.1, 6, dt);
  u.torso.rotation.set(u.side + Math.sin(u.phase) * 0.03 * k, Math.sin(u.phase) * 0.06 * k, u.lean + Math.sin(simTime * 1.8) * 0.01 * (1 - k));

  // Upper body: aim pitch + recoil, then weapon-specific arm pose, reload, draw and knife swing.
  const punch = Math.hypot(p.punch?.[0] || 0, p.punch?.[1] || 0);
  u.chest.rotation.z = -(p.pitch || 0) * DEG * 0.75 + punch * DEG * 0.8;
  const shotAge = simTime - (p.lastShot ?? -9), kick = shotAge >= 0 && shotAge < 0.09 ? 1 - shotAge / 0.09 : 0;
  POSES[name].forEach(([up, low, side], i) => { const [j, kk] = u.arms[i]; j.rotation.z = up * DEG; kk.rotation.z = low * DEG; j.rotation.x = side; });
  const r = p.reloadFrac ?? -1, draw = 1 - (p.deployFrac ?? 1);
  u.holder.position.set((name === 'knife' ? 9 : 11) - kick * 1.5, name === 'glock' ? 1 : -3, name === 'knife' ? 6 : 2.5);
  u.holder.rotation.set(r >= 0 ? Math.sin(r * Math.PI) * 0.5 : 0, 0, kick * 0.08 - draw * 1.0 - (r >= 0 ? Math.sin(r * Math.PI) * 0.35 : 0));
  if (r >= 0) { const [lj, lk] = u.arms[0], t = Math.sin(Math.min(1, r * 1.6) * Math.PI); lj.rotation.z -= t * 0.9; lk.rotation.z += t * 0.6; } // left hand to the mag
  if (name === 'knife') {
    if (shotAge >= 0 && shotAge < 0.3 && u.lastShot !== p.lastShot) { u.lastShot = p.lastShot; u.swing = 1; }
    u.swing = Math.max(0, u.swing - dt / 0.3);
    const [rj] = u.arms[1]; rj.rotation.z += Math.sin(u.swing * Math.PI) * 1.2; rj.rotation.y = -Math.sin(u.swing * Math.PI) * 0.9;
  } else u.arms[1][0].rotation.y = 0;
  u.guns.forEach(g => g.userData.flash && (g.userData.flash.visible = kick > 0.4 && name !== 'knife'));
}

// First-person: weapon + forearms in camera space (camera looks -Z, right +X, up +Y).
export function makeViewmodel(team) {
  if (real) return makeRealViewmodel(team);
  const SLEEVE = team ? 0x34507a : 0x7a6340, GLOVE = 0x262626, root = new THREE.Group();
  const forearm = (x, y, z, ry, rx) => { const g = group(x, y, z, box(2.6, 2.6, 13, SLEEVE, 0, 0, 6.5), box(3, 2.4, 3.2, GLOVE, 0, 0.2, -0.6)); g.rotation.set(rx, ry, 0); return g; };
  const rigs = WEAPON_NAMES.map(name => {
    const gun = weaponMesh(name); gun.rotation.y = Math.PI / 2; // +X muzzle → -Z
    const rig = group(0, 0, 0, gun);
    rig.userData = { gun, flash: muzzleFlash(gun), left: null };
    if (name === 'ak47') { rig.add(forearm(0.3, -2.2, 0.5, 0.35, 0.5)); rig.userData.left = forearm(-0.6, -0.2, -13, -0.45, 0.25); }
    if (name === 'glock') { rig.add(forearm(0.2, -2.4, 0.4, 0.3, 0.55)); rig.userData.left = forearm(-1.4, -2.6, 0.8, -0.35, 0.55); }
    if (name === 'knife') rig.add(forearm(0, -0.4, 0.8, 0.25, 0.45));
    if (rig.userData.left) rig.add(rig.userData.left);
    root.add(rig); return rig;
  });
  root.userData = { rigs, phase: 0, kick: 0, swing: 0, swingSide: 1, weapon: -1, swayX: 0, swayY: 0, land: 0, wasGround: true, flashT: 0, slide: 0 };
  return root;
}

const VM_POS = { ak47: [6.5, -7.5, -27], glock: [6, -6.5, -19], knife: [7, -7, -17] };
export function updateViewmodel(vm, p, dt, shot, look = { yaw: 0, pitch: 0 }, simTime = 0) {
  if (vm.userData.real) return updateRealViewmodel(vm, p, dt, shot, look, simTime);
  const u = vm.userData, name = standIn(nameOf(p)), wi = WEAPON_NAMES.indexOf(name), rig = u.rigs[wi] || u.rigs[0];
  const speed = Math.hypot(p.vel?.[0] || 0, p.vel?.[1] || 0), air = p.onGround === false;
  u.rigs.forEach((r, i) => (r.visible = i === wi));
  if (u.weapon !== nameOf(p)) { u.weapon = nameOf(p); u.kick = 0; }
  if (shot) {
    if (name === 'knife') { u.swing = 1; u.swingSide = -u.swingSide; }
    else { u.kick = Math.min(1.6, u.kick + 1); u.flashT = 0.045; u.slide = 1; }
  }
  u.kick *= Math.exp(-dt * 11); u.swing = Math.max(0, u.swing - dt / 0.35); u.flashT -= dt; u.slide = Math.max(0, u.slide - dt / 0.08);
  if (rig.userData.flash) { rig.userData.flash.visible = u.flashT > 0; rig.userData.flash.rotation.x = Math.random() * Math.PI; }
  const gunU = rig.userData.gun.userData;
  if (gunU.slide) gunU.slide.position.x = 2.6 - u.slide * 1.6;
  // Sway: the weapon lags behind mouse motion and springs back.
  u.swayX = smooth(u.swayX, Math.max(-3, Math.min(3, -look.yaw * 0.6)), 10, dt);
  u.swayY = smooth(u.swayY, Math.max(-3, Math.min(3, look.pitch * 0.6)), 10, dt);
  // Bob: figure-eight synced to distance travelled; none in the air.
  if (!air) u.phase += speed * dt / 30;
  const bob = air ? 0 : Math.min(speed / 250, 1);
  if (!air && !u.wasGround) u.land = 1;
  u.wasGround = !air; u.land = Math.max(0, u.land - dt / 0.25);
  const r = p.reloadFrac ?? -1, draw = ease(1 - (p.deployFrac ?? 1)), duck = p.duck ?? +p.crouch;
  const rl = r >= 0 ? Math.sin(Math.min(1, r * 1.15) * Math.PI) : 0; // lower, tilt, swap mag, raise
  if (gunU.mag) gunU.mag.position.y = -0.4 - (r >= 0 && r > 0.25 && r < 0.6 ? 6 : 0);
  if (rig.userData.left && name !== 'knife') rig.userData.left.position.y = (name === 'ak47' ? -0.2 : -2.6) - (r > 0.2 && r < 0.65 ? 3 : 0);
  const [x, y, z] = VM_POS[name], sw = Math.sin(u.swing * Math.PI);
  vm.position.set(
    x + Math.sin(u.phase) * 0.55 * bob + u.swayX * 0.4 - duck * 0.6,
    y - Math.abs(Math.cos(u.phase)) * 0.45 * bob + u.swayY * 0.3 - draw * 9 - rl * 3.5 - Math.sin(u.land * Math.PI) * 1.2 - duck * 0.5 + (air ? 0.6 : 0),
    z + u.kick * 1.6 + sw * -4);
  vm.rotation.set(
    u.kick * 0.07 - rl * 0.45 + draw * 0.8 + u.swayY * 0.02 + sw * 0.5,
    u.swayX * 0.03 + sw * 0.9 * u.swingSide,
    rl * 0.5 + Math.sin(u.phase) * 0.01 * bob + sw * 0.6 * u.swingSide);
}

// ---- CS2 models: agents (tm_phoenix = T, ctm_sas = CT) with their own animation sets, weapons from the game ----
// Source2Viewer exports are in meters, Y up, model facing +Z; the viewmodel animations drive the same agent skeleton.
const M = 39.37007874015748, DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'], FOOT_Y = 4.1; // planted ankle height (measured)
let real = null;
const qTmp = new THREE.Quaternion(), vTmp = new THREE.Vector3(), mTmp = new THREE.Matrix4(), mTmp2 = new THREE.Matrix4();
const trackNode = t => t.name.slice(0, t.name.lastIndexOf('.')), trackProp = t => t.name.slice(t.name.lastIndexOf('.') + 1);

// Loads public/models/models.json (paths relative to its srcDir, served at /models/src/) and the weapon index
// <weaponDir>/index.json (tools/build-weapons.js). Call before makeAvatar/makeViewmodel.
export async function loadModels(base = '/models/') {
  try {
    const cfg = await (await fetch(base + 'models.json')).json(), loader = new GLTFLoader(), src = base + 'src/';
    const dir = `${src}${cfg.weaponDir || 'weapons'}/`, index = await fetch(dir + 'index.json').then(r => (r.ok ? r.json() : {}));
    const agents = await Promise.all(cfg.agents.map(p => loader.loadAsync(src + p)));
    real = { agents: agents.map(prepAgent), index, dir, loader, guns: {}, loading: {} };
    await Promise.all(['ak47', 'glock', 'knife', 'knife_t'].map(ensureWeapon)); // the default loadout is ready at once; the rest load when first seen
  } catch (e) { real = null; console.warn('CS2 models not loaded, using stand-ins:', e); }
  return !!real;
}
// Loads a weapon's model and its animation set (once). Its clips join every agent's table as "<weapon>:<clip>"
// (both agents share the skeleton), then real.guns[name] is set: the weapon can be shown.
export function ensureWeapon(name) {
  const e = real?.index[name];
  if (!e) return Promise.resolve(false);
  return (real.loading[name] ||= (async () => {
    try {
      const [m, an] = await Promise.all([e.model && real.loader.loadAsync(real.dir + e.model), e.anims && real.loader.loadAsync(real.dir + e.anims)]);
      if (an) {
        const clips = splitClips(an, an.scene.getObjectByName('pelvis')?.parent?.parent);
        for (const A of real.agents) for (const k in clips) A.clips[`${name}:${k}`] = clips[k];
      }
      real.guns[name] = m ? prepGun(m.scene) : null;
    } catch (err) { real.guns[name] = null; console.warn(`weapon ${name} not loaded:`, err); }
    return true;
  })());
}
// The weapon shown for p: its own model (T's default knife is knife_t) or, while that one loads, its class stand-in.
function shownWeapon(p, team) {
  const t = n => (n === 'knife' && team === 0 ? 'knife_t' : n), n = t(nameOf(p));
  if (real.guns[n] !== undefined) return n;
  ensureWeapon(n);
  return t(standIn(n));
}
// "<weapon>:vm_<action>", with the stand-ins some sets need (karambit idle1, Dual Berettas shoot_left1/right1…)
const VM_ALT = { idle: ['idle1'], shoot1: ['shoot_right1', 'shoot'], shoot_left1: ['shoot1', 'shoot_right1', 'shoot'], light_miss1: ['light_miss2', 'heavy_miss1'], heavy_miss1: ['light_miss1'], throw_underhand: ['throw_overhand'], lookat01: ['lookat02'] };
function vmKey(C, name, k) {
  for (const a of [k, ...(VM_ALT[k] || [])]) if (C[`${name}:vm_${a}`]) return `${name}:vm_${a}`;
  return null;
}
function prepGun(scene) {
  // rifles/pistols carry both a legacy and an HD body (keep HD); knives have only the legacy one
  let hd = false;
  scene.traverse(o => { hd ||= /body_hd$/.test(o.name); });
  if (hd) scene.traverse(o => { if (/legacy/.test(o.name)) o.visible = false; });
  scene.traverse(o => { if (/holster/.test(o.name)) o.visible = false; }); // Dual Berettas' belt holster: worn on the body, not held
  return scene;
}
// Splits every clip into the agent-skeleton part and the weapon-bone part (bolt, mag… renamed to the weapon file's bone
// names), and measures the root-motion distance per cycle so feet match the sim speed. Root motion itself is dropped.
function prepAgent(gltf) {
  const { scene } = gltf, skel = scene.getObjectByName('pelvis').parent.parent;
  const meshes = scene.children.filter(o => /thirdperson|firstperson/.test(o.name) && !/defusekit/.test(o.name));
  const clips = splitClips(gltf, skel);
  // Crouching still: one real frame of the crouch-walk cycle with both feet planted. Averaging the 8 directions (as the
  // standing idle does) bends the legs into a pose that sinks the feet ~5 units and is not the crouch height of CS2.
  for (const cls of ['rifle', 'pistol', 'knife']) {
    const c = clips[`crouch_n_${cls}`];
    if (c) clips[`crouch_idle_${cls}`] = { body: Object.assign(c.body.clone(), { name: `crouch_idle_${cls}` }), stride: 0, restT: plantedTime(skel, c.body) };
  }
  // overlays (reload, draw, knife swing) replace the torso, arms and weapon bone (the weapon hangs off the root, so arms
  // only match it on the clip's own torso); legs keep walking
  const upper = new Set();
  for (const n of ['spine_0', 'wpnPivot']) skel.getObjectByName(n)?.traverse(o => upper.add(o.name));
  const tpl = new THREE.Group();
  tpl.add(skel, ...meshes);
  return { tpl, clips, upper };
}
// Clips of an agent export or a weapon's animation set (same skeleton), keyed by their last path part ("vm_" for viewmodel).
function splitClips({ scene, animations, parser }, skel) {
  // name → node and skeleton membership looked up once: per track a full-scene search (726 nodes × ~700 tracks × every
  // clip of every weapon) took minutes when a demo loaded its 35 weapons
  const byName = new Map(), inSkelSet = new Set();
  scene.traverse(o => { if (!byName.has(o.name)) byName.set(o.name, o); }); // first in traversal order, as getObjectByName
  skel?.traverse(o => inSkelSet.add(o));
  const inSkel = o => inSkelSet.has(o);
  const srcName = o => parser.json.nodes[parser.associations.get(o)?.nodes]?.name;
  const clips = {};
  for (const clip of animations) {
    const vm = clip.name.includes('/viewmodel/'), key = (vm ? 'vm_' : '') + clip.name.split('/').pop();
    const body = [], gun = [];
    let stride = 0;
    for (const t of clip.tracks) {
      const o = byName.get(trackNode(t));
      if (!o) continue;
      if (o.name === 'root_motion' && !vm && trackProp(t) === 'position') { // travel → stride; the body stays at its start point
        const v = t.values, n = v.length - 3;
        stride = Math.hypot(v[n] - v[0], v[n + 1] - v[1], v[n + 2] - v[2]) * M;
        body.push(new THREE.VectorKeyframeTrack(t.name, [0], [v[0], v[1], v[2]]));
        continue;
      }
      if (inSkel(o)) body.push(t);
      else { const c = t.clone(); c.name = `${srcName(o)}.${trackProp(t)}`; gun.push(c); }
    }
    clips[key] = { body: new THREE.AnimationClip(key, clip.duration, body), gun: gun.length ? new THREE.AnimationClip(key, clip.duration, gun) : null, stride };
  }
  return clips;
}
// Time in a walk cycle where both feet are down: the frame whose higher ankle is lowest. Leaves the skeleton as it was.
function plantedTime(skel, clip) {
  const saved = []; skel.traverse(o => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(skel), act = mixer.clipAction(clip).play(), feet = ['ankle_L', 'ankle_R'].map(n => skel.getObjectByName(n));
  act.timeScale = 0;
  let best = 0, bestY = Infinity;
  for (let i = 0; i < 32 && feet[0] && feet[1]; i++) {
    act.time = clip.duration * i / 32; mixer.update(0); skel.updateMatrixWorld(true);
    const inv = mTmp.copy(skel.matrixWorld).invert(), y = Math.max(...feet.map(f => vTmp.setFromMatrixPosition(f.matrixWorld).applyMatrix4(inv).y));
    if (y < bestY) { bestY = y; best = act.time; }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(skel);
  saved.forEach(([o, p, q, s]) => { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); });
  return best;
}
const agentFor = team => real.agents[team] || real.agents[0];
function cloneAgent(team, show) {
  const model = SkeletonUtils.clone(agentFor(team).tpl);
  model.scale.setScalar(M);
  model.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); // skinned bounds are the bind pose
  model.children.forEach(o => { if (!o.getObjectByName('pelvis')) o.visible = show.test(o.name); });
  return model;
}
function cloneGun(name, team, parent) {
  const src = real.guns[name], g = src ? SkeletonUtils.clone(src) : new THREE.Group();
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  // 'weapon' bone = hand's 'wpn' bone: its rest rotation is the glTF→Source axis swap, so the root undoes it
  const w = g.getObjectByName('weapon');
  if (w) { g.quaternion.copy(w.quaternion).invert(); w.position.set(0, 0, 0); }
  // weapon files have no muzzle bone; the agent's weapon skeleton does (offset taken from the viewmodel idle clip)
  const C = agentFor(team).clips, off = C[vmKey(C, name, 'idle') || vmKey(C, name, 'shoot1')]?.gun?.tracks.find(t => t.name === 'muzzle.position');
  const wo = g.getObjectByName('weapon_offset');
  if (off && wo && !g.getObjectByName('muzzle')) { const m = new THREE.Object3D(); m.name = 'muzzle'; m.position.fromArray(off.values); wo.add(m); }
  parent.add(g); return g;
}
// CS2's animgraph turns the forearm twist bones (1/3 and 2/3 down the forearm) with the hand's roll; the clips leave them
// at rest, so without this the wrist skin shears and pokes through the glove cuff.
const X_AXIS = new THREE.Vector3(1, 0, 0);
function forearmTwist(model) {
  return ['L', 'R'].flatMap(s => [['', 1 / 3], ['1', 2 / 3]].map(([n, k]) => {
    const b = model.getObjectByName(`arm_lower_${s}_TWIST${n}`), hand = model.getObjectByName(`hand_${s}`);
    return b && hand && { b, hand, k, rest: b.quaternion.clone() };
  }).filter(Boolean));
}
function applyTwist(list) {
  for (const { b, hand, k, rest } of list) {
    const q = hand.quaternion, sg = q.w < 0 ? -1 : 1, roll = 2 * Math.atan2(sg * q.x, sg * q.w); // about the forearm (bone X)
    b.quaternion.copy(rest).multiply(qTmp.setFromAxisAngle(X_AXIS, roll * k));
  }
}
// A thrown grenade's CS2 model (world scale), or null while it loads / without models.
export function nadeModel(name) {
  if (!real) return null;
  if (real.guns[name] === undefined) { ensureWeapon(name); return null; }
  if (!real.guns[name]) return null;
  const g = SkeletonUtils.clone(real.guns[name]);
  g.scale.setScalar(M); g.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  return g;
}
// World position of the visible weapon's muzzle (CS2 models only), or null.
export function muzzlePos(obj) {
  let m = null;
  obj.traverseVisible(o => { if (o.name === 'muzzle') m = o; });
  return m && m.getWorldPosition(new THREE.Vector3());
}

function makeRealAvatar(team) {
  const A = agentFor(team), model = cloneAgent(team, /thirdperson/), root = new THREE.Group(), body = group();
  model.rotation.y = Math.PI / 2; // +Z forward → +X
  body.add(model); root.add(body);
  const wpn = model.getObjectByName('wpn'), guns = {}; // name → weapon clone on the hand bone, made when first carried
  const legs = []; // first person: only the legs stay visible (look down)
  model.traverse(o => { if (o.isMesh && /thirdperson_body/.test(o.parent?.name + o.name)) legs.push(o); });
  const edited = []; // bones changed by hand after the mixer (overlays, aim): their mixer pose, restored every frame
  model.traverse(o => { if (o.isBone && (A.upper.has(o.name) || o.name === 'spine_2')) edited.push([o, o.position.clone(), o.quaternion.clone()]); });
  root.userData = { real: true, A, team, model, body, wpn, guns, legs, edited, twist: forearmTwist(model),
    ankles: ['ankle_L', 'ankle_R'].map(n => model.getObjectByName(n)), mixer: new THREE.AnimationMixer(model), acts: {}, samp: {},
    spine: model.getObjectByName('spine_2'), pivot: model.getObjectByName('wpnPivot'), cycle: 0, duck: 0, air: 0, run: 0, move: 0, deathT: -1 };
  return root;
}
function act(u, key) {
  if (key in u.acts) return u.acts[key];
  const c = u.A.clips[key];
  if (!c) return (u.acts[key] = null);
  const a = u.mixer.clipAction(c.body);
  a.play(); a.timeScale = 0; a.enabled = false;
  return (u.acts[key] = a);
}
// Arm/weapon overlay sampled by hand and blended over the mixer's pose (the mixer can't weight per bone).
function overlay(u, key, time, w) {
  if (!(w > 0)) return;
  let s = u.samp[key];
  if (s === undefined) {
    const c = u.A.clips[key], f = n => c.body.tracks.find(t => t.name === n)?.createInterpolant();
    s = u.samp[key] = c ? { dur: c.body.duration, tracks: c.body.tracks.filter(t => u.A.upper.has(trackNode(t)) && !trackNode(t).startsWith('wpnPivot'))
      .map(t => ({ o: u.model.getObjectByName(trackNode(t)), prop: trackProp(t), f: t.createInterpolant() })).filter(t => t.o),
      hips: [f('pelvis.position'), f('pelvis.quaternion')], pivot: [f('wpnPivot.position'), f('wpnPivot.quaternion')],
      pelvisBone: u.model.getObjectByName('pelvis'), pivotBone: u.model.getObjectByName('wpnPivot') } : null;
  }
  if (!s) return;
  const t = Math.min(Math.max(time, 0), s.dur);
  for (const { o, prop, f } of s.tracks) {
    const v = f.evaluate(t);
    if (prop === 'quaternion') o.quaternion.slerp(qTmp.fromArray(v), w);
    else if (prop === 'position') o.position.lerp(vTmp.fromArray(v), w);
  }
  // The weapon pivot hangs off the root, the torso off the hips: move the clip's pivot by (our hips ← clip's hips), so the
  // hands keep the weapon although our hips (walk/crouch) are not the clip's.
  const [hp, hq] = s.hips, [pp, pq] = s.pivot, b = s.pivotBone;
  if (!hp || !hq || !pp || !pq || !b) return;
  const ONE = vTmp.set(1, 1, 1);
  mTmp.compose(new THREE.Vector3().fromArray(hp.evaluate(t)), new THREE.Quaternion().fromArray(hq.evaluate(t)), ONE).invert();
  mTmp.premultiply(mTmp2.compose(s.pelvisBone.position, s.pelvisBone.quaternion, ONE));
  mTmp.multiply(mTmp2.compose(new THREE.Vector3().fromArray(pp.evaluate(t)), new THREE.Quaternion().fromArray(pq.evaluate(t)), ONE));
  const pos = new THREE.Vector3(), rot = new THREE.Quaternion();
  mTmp.decompose(pos, rot, new THREE.Vector3());
  b.position.lerp(pos, w); b.quaternion.slerp(rot, w);
}
// Turns a bone about a pivot point by a rotation given in the avatar root's frame (world matrices must be current).
function rotateAbout(root, o, pivot, q) {
  const inv = root.matrixWorld.clone().invert();
  mTmp.copy(inv).multiply(o.matrixWorld); // bone in root space
  mTmp2.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)).multiply(mTmp);
  mTmp.copy(inv).multiply(o.parent.matrixWorld).invert().multiply(mTmp2); // back to parent space
  mTmp.decompose(o.position, o.quaternion, vTmp);
}

function updateRealAvatar(a, p, dt, firstPerson, simTime) {
  const u = a.userData, name = shownWeapon(p, u.team), cls = classOf(name);
  u.guns[name] ||= cloneGun(name, u.team, u.wpn);
  for (const k in u.guns) u.guns[k].visible = k === name && !firstPerson;
  u.legs.forEach(m => (m.visible = !firstPerson || /legs/i.test(m.material?.name || '')));
  u.model.children.forEach(o => { if (/thirdperson/.test(o.name)) o.visible = !firstPerson || o.name.includes('thirdperson_body'); });

  if (!p.alive) { // no death clips in the set (CS2 uses ragdolls): keep the last pose and topple over in 0.45 s
    if (u.deathT < 0) u.deathT = 0;
    u.deathT = Math.min(1, u.deathT + dt / 0.45);
    const t = ease(u.deathT);
    u.body.rotation.z = -Math.PI / 2 * t; u.body.position.y = 6 * t;
    return;
  }
  u.deathT = -1; u.body.rotation.set(0, 0, 0); u.body.position.y = 0;

  const c = Math.cos(p.yaw * DEG), s = Math.sin(p.yaw * DEG), vx = p.vel?.[0] || 0, vy = p.vel?.[1] || 0;
  const fwd = vx * c + vy * s, right = vx * s - vy * c, speed = Math.hypot(fwd, right), air = p.onGround === false;
  u.duck = smooth(u.duck, p.duck ?? +p.crouch, 30, dt);
  u.air = smooth(u.air, air ? 1 : 0, 14, dt);
  u.move = smooth(u.move, Math.min(speed / 50, 1), 12, dt);
  u.run = smooth(u.run, Math.min(Math.max((speed - 120) / 80, 0), 1), 8, dt); // walk (shift ≈ 112) → run (≥ 200)
  // 8-way blend: the two direction clips around the movement angle (clockwise from forward: e = right)
  const f = ((Math.atan2(right, fwd) / (Math.PI / 4)) % 8 + 8) % 8, i0 = Math.floor(f) % 8, i1 = (i0 + 1) % 8, k1 = speed > 1 ? f - Math.floor(f) : 0;
  const g = 1 - u.air, m = u.move, dk = u.duck, W = {};
  const add = (key, w) => (W[key] = (W[key] || 0) + w);
  // the export's idle_* / shoot_* clips are additive layers (deltas from the bind pose), unusable on their own:
  // standing still = all 8 walk (crouch) directions blended equally, which cancels the stride
  for (const d of DIRS) add(`walk_${d}_${cls}`, g * (1 - m) * (1 - dk) / 8);
  add(u.A.clips[`crouch_idle_${cls}`] ? `crouch_idle_${cls}` : `crouch_n_${cls}`, g * (1 - m) * dk); // planted crouch frame
  add(`inair_stand_${cls}`, u.air * (1 - dk)); add(`inair_crouch_stand_${cls}`, u.air * dk);
  for (const [k, w] of [['walk', g * m * (1 - dk) * (1 - u.run)], ['run', g * m * (1 - dk) * u.run], ['crouch', g * m * dk]]) {
    add(`${k}_${DIRS[i0]}_${cls}`, w * (1 - k1)); add(`${k}_${DIRS[i1]}_${cls}`, w * k1);
  }
  // gait phase advances with distance travelled (stride = the clip's root motion per cycle), so feet don't slide
  const stride = k => u.A.clips[`${k}_n_${cls}`]?.stride || 180;
  const len = (stride('walk') * (1 - u.run) + stride('run') * u.run) * (1 - dk) + stride('crouch') * dk;
  if (!air) u.cycle = (u.cycle + speed * dt / len) % 1;
  for (const key in u.acts) if (u.acts[key]) u.acts[key].enabled = false;
  for (const key in W) {
    const x = W[key] > 1e-3 && act(u, key);
    if (!x) continue;
    const dur = x.getClip().duration;
    x.enabled = true; x.setEffectiveWeight(W[key]);
    x.time = key.startsWith('crouch_idle_') ? u.A.clips[key].restT
      : /^(walk|run|crouch)_/.test(key) ? u.cycle * dur
      : key.startsWith('inair') ? dur * Math.min(1, Math.max(0, (300 - (p.vel?.[2] || 0)) / 600)) // pose by vertical speed: take-off → fall, not a loop
      : dur ? simTime % dur : 0;
  }
  // the mixer skips bones whose blended value didn't change, so last frame's manual edits must be undone first
  u.edited.forEach(([o, p, q]) => { o.position.copy(p); o.quaternion.copy(q); });
  u.mixer.update(0);
  u.edited.forEach(([o, p, q]) => { p.copy(o.position); q.copy(o.quaternion); });

  // Arms + weapon: draw / reload follow the sim's progress, the knife swing plays from the shot time (gun recoil = punch below).
  const shotAge = simTime - (p.lastShot ?? -9), r = p.reloadFrac ?? -1, deploy = p.deployFrac ?? 1;
  const dur = key => u.A.clips[key]?.body.duration || 0.3, crouchKey = (a, b) => (dk > 0.5 && u.A.clips[a] ? a : b);
  if (deploy < 1) overlay(u, `${name}:draw`, deploy * dur(`${name}:draw`), 1);
  else if (r >= 0) { const k = crouchKey(`${name}:reload_crouch`, `${name}:reload`); overlay(u, k, r * dur(k), Math.min(1, Math.min(r, 1 - r) * 12)); }
  else if (p.plantT >= 0 && u.A.clips[`${name}:planting`]) overlay(u, `${name}:planting`, Math.min(p.plantT, dur(`${name}:planting`)), 1); // C4: kneel and type
  else if (cls === 'knife') {
    const k = crouchKey('frontswing_crouching_knife', 'frontswing_knife');
    overlay(u, k, shotAge, shotAge >= 0 && shotAge < dur(k) ? 1 : 0);
  }
  applyTwist(u.twist);

  // Planted feet: the 8-way averaged crouch idle pulls the ankles ~2.6 units into the floor (the clips themselves don't);
  // lift the body back to the ankle height the agent's walk/crouch clips keep (≈4.1), only up, only on the ground.
  if (u.ankles[0] && u.ankles[1]) {
    a.updateMatrixWorld(true);
    const low = Math.min(...u.ankles.map(b => a.worldToLocal(vTmp.setFromMatrixPosition(b.matrixWorld)).y));
    u.body.position.y = Math.max(0, FOOT_Y - low) * (1 - u.air);
  }

  // Aim pitch (+ recoil): the upper body and the weapon pivot turn together about the chest.
  const punch = Math.hypot(p.punch?.[0] || 0, p.punch?.[1] || 0), pitch = -(p.pitch || 0) * DEG * 0.8 + punch * DEG * 0.8;
  if (u.spine && u.pivot && pitch) {
    a.updateMatrixWorld(true);
    const at = new THREE.Vector3().setFromMatrixPosition(u.spine.matrixWorld).applyMatrix4(a.matrixWorld.clone().invert());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch);
    rotateAbout(a, u.spine, at, q); rotateAbout(a, u.pivot, at, q);
  }
}

function makeRealViewmodel(team) {
  const model = cloneAgent(team, /firstperson/), root = new THREE.Group();
  model.rotation.y = Math.PI; // +Z forward → -Z (camera looks -Z)
  root.add(model);
  root.userData = { real: true, A: agentFor(team), team, model, wpn: model.getObjectByName('wpn'), guns: {}, twist: forearmTwist(model),
    mixer: new THREE.AnimationMixer(model), cur: null, curKey: '', shotT: 9, alt: false, phase: 0, swayX: 0, swayY: 0, land: 0, wasGround: true };
  return root;
}
// weapon bone-merged onto the hand's 'wpn' bone; the clips move only its parts (bolt, mag, slide)
function vmGun(u, name) {
  const g = cloneGun(name, u.team, u.wpn), bones = new Set();
  g.traverse(o => bones.add(o.name));
  return { g, bones, clips: {}, mixer: new THREE.AnimationMixer(g), act: null };
}
function updateRealViewmodel(vm, p, dt, shot, look, simTime) {
  const u = vm.userData, name = shownWeapon(p, u.team), C = u.A.clips, gun = (u.guns[name] ||= vmGun(u, name)), nade = CATALOG[name]?.slot === 'grenade';
  if (u.lastName !== name) { u.lastName = name; u.shotT = 9; } // a new weapon doesn't replay the old one's shot
  if (shot) { u.shotT = 0; u.alt = !u.alt; } else u.shotT += dt;
  u.pinT = p.pin ? (u.pinT || 0) + dt : 0;
  // grenade: pin pull (held on its last frame), then the overhand / underhand throw
  const shootKey = vmKey(C, name, nade ? ((p.throwStrength ?? 1) >= 0.5 ? 'throw_overhand' : 'throw_underhand')
    : classOf(name) === 'knife' ? (u.alt ? 'light_miss1' : 'heavy_miss1') : u.alt ? 'shoot_left1' : 'shoot1');
  const r = p.reloadFrac ?? -1, deploy = p.deployFrac ?? 1, dur = k => C[k]?.body.duration || 0;
  let key, t;
  if (deploy < 1) { key = vmKey(C, name, 'draw'); t = deploy * dur(key); }
  else if (r >= 0) { key = vmKey(C, name, 'reload'); t = r * dur(key); }
  else if (shootKey && u.shotT < dur(shootKey)) { key = shootKey; t = u.shotT; }
  else if (p.plantT >= 0 && vmKey(C, name, 'plant')) { key = vmKey(C, name, 'plant'); t = Math.min(p.plantT, dur(key) - 1e-3); } // C4 code typing
  else if (p.pin && vmKey(C, name, 'pullpin')) { key = vmKey(C, name, 'pullpin'); t = Math.min(u.pinT, dur(key) - 1e-3); }
  else if (p.inspectT >= 0 && vmKey(C, name, 'lookat01') && p.inspectT < dur(vmKey(C, name, 'lookat01'))) { key = vmKey(C, name, 'lookat01'); t = p.inspectT; } // F
  else { key = vmKey(C, name, 'idle'); t = dur(key) ? simTime % dur(key) : 0; }
  if (C[key] && key !== u.curKey) {
    u.cur?.stop();
    u.cur = u.mixer.clipAction(C[key].body).play(); u.cur.timeScale = 0;
    gun.act?.stop();
    const src = C[key].gun, c = src && (gun.clips[key] ||= new THREE.AnimationClip(key, src.duration, src.tracks.filter(t => gun.bones.has(trackNode(t)))));
    gun.act = c?.tracks.length ? gun.mixer.clipAction(c).play() : null;
    if (gun.act) gun.act.timeScale = 0;
    u.curKey = key;
  }
  for (const k in u.guns) u.guns[k].g.visible = k === name;
  if (gun.act) { gun.act.time = t; gun.mixer.update(0); }
  if (u.cur) { u.cur.time = t; u.mixer.update(0); }
  applyTwist(u.twist);
  // On top of the clip: lag behind the mouse, figure-eight bob with distance, dip on landing (inches, camera space).
  const speed = Math.hypot(p.vel?.[0] || 0, p.vel?.[1] || 0), air = p.onGround === false;
  u.swayX = smooth(u.swayX, Math.max(-3, Math.min(3, -look.yaw * 0.6)), 10, dt);
  u.swayY = smooth(u.swayY, Math.max(-3, Math.min(3, look.pitch * 0.6)), 10, dt);
  if (!air) u.phase += speed * dt / 30;
  const bob = air ? 0 : Math.min(speed / 250, 1);
  if (!air && !u.wasGround) u.land = 1;
  u.wasGround = !air; u.land = Math.max(0, u.land - dt / 0.25);
  // CS2 defaults viewmodel_offset_x 1 (right), _y 1 (forward), _z -1 (up) → camera space (+X right, +Y up, -Z forward)
  vm.position.set(1 + Math.sin(u.phase) * 0.4 * bob + u.swayX * 0.3,
    -1 - Math.abs(Math.cos(u.phase)) * 0.35 * bob + u.swayY * 0.25 - Math.sin(u.land * Math.PI) * 1.0 + (air ? 0.5 : 0), -1);
  vm.rotation.set(u.swayY * 0.015, u.swayX * 0.02, Math.sin(u.phase) * 0.01 * bob);
}
