import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Env, inaccuracy, hullHit, eye, CATALOG, NADE } from './sim/core.js';
import { MAP } from './sim/map.js';
import { readGltf, triangles, toSource, voxelize, makeSpawns } from './tools/import-map.js';
import { writeGlb } from './tools/boxes-to-glb.js';
import { packModel, glb } from './tools/pack-model.js';
import fs from 'node:fs';
import { radarHeights } from './public/radar.js';
import { footstep, falloff } from './public/sound.js';
import { surfaceAt, surfaceOf } from './public/surfaces.js';
import { surfaceMap } from './tools/surface-map.js';
import { stateAt, eventsBetween, modelSlot, scoreAt, roundAt, killsAt } from './public/demo.js';

const FLOOR = [-4000, -4000, -64, 4000, 4000, 0];
const arena = (boxes = []) => new Env({ opponent: 'agent', frameSkip: 1, map: { boxes: [FLOOR, ...boxes], spawns: [[[0, 0, 0, 0]], [[500, 0, 0, 180]]] }, seed: 1 });
const place = (env, a, b) => { [env.players[0].pos, env.players[1].pos] = [a, b]; env.players.forEach(p => { p.yaw = 0; p.pitch = 0; }); };
const idle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const aimHead = (e, p, q) => { const l = e.look(p, e.headOf(q)); return [0, 0, l.yawErr, l.pitchErr]; };

{ // standing still stays on the floor (feet 0.03125 above it); standing jump apex 54.66 (impulse − half a tick of gravity)
  const e = arena(); place(e, [0, 0, 0], [500, 0, 0]);
  for (let i = 0; i < 64; i++) e.step([idle, idle]);
  assert.ok(Math.abs(e.players[0].pos[2]) < 0.05, 'on ground');
  e.step([[0, 0, 0, 0, 1], idle]); let top = 0;
  for (let i = 0; i < 64; i++) { e.step([idle, idle]); top = Math.max(top, e.players[0].pos[2]); }
  assert.ok(top > 54 && top < 55, `jump apex ${top}`);
  assert.ok(Math.abs(e.players[0].pos[2]) < 0.05, 'landed');
}
{ // AK headshot one-taps through helmet at 500u; glock body shot = floor(30*.47*.9^~1)
  const e = arena(); place(e, [0, 0, 0], [500, 0, 0]);
  e.step([[...aimHead(e, e.players[0], e.players[1]), 0, 0, 0, 1, 0, 0], idle]);
  assert.equal(e.players[1].alive, false, 'AK headshot kills');
  assert.equal(e.done, true); assert.equal(e.winner, 0);

  const g = arena(); place(g, [0, 0, 0], [500, 0, 0]);
  const p = g.players[0], q = g.players[1], l = g.look(p, [500, 0, 0.7 * 72]);
  g.step([[0, 0, l.yawErr, l.pitchErr, 0, 0, 0, 0, 0, 2], idle]); // switch to glock (1 s deploy, CS2 vdata)
  let shots = 0; const count = () => g.events.forEach(ev => (shots += ev.type === 'shot' && ev.by === 0));
  for (let i = 0; i < 128; i++) { g.step([[0, 0, 0, 0, 0, 0, 0, 1, 0, 0], idle]); count(); }
  assert.equal(shots, 1, 'glock is semi-auto: holding fire = one shot');
  assert.ok(q.hp < 100 && q.alive, `glock hits body, hp ${q.hp}`);
  assert.equal(q.velMod < 1, true, 'getting shot slows (tagging)');
  for (let i = 0; i < 64; i++) { g.step([[0, 0, 0, 0, 0, 0, 0, i % 16 < 2, 0, 0], idle]); count(); }
  assert.ok(shots >= 4, `tapping fires again (${shots} shots)`);
}
{ // AK spray climbs with recoil, then recovers after a pause; running ruins accuracy
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
  const p = e.players[0], ups = [], fireA = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
  const upOf = ev => Math.atan2(ev.to[2] - ev.from[2], Math.hypot(ev.to[0] - ev.from[0], ev.to[1] - ev.from[1])) * 180 / Math.PI;
  const rights = [], rightOf = ev => -Math.atan2(ev.to[1] - ev.from[1], ev.to[0] - ev.from[0]) * 180 / Math.PI;
  for (let i = 0; i < 64 * 3.2; i++) { e.step([fireA, idle]); e.events.forEach(ev => ev.type === 'shot' && (ups.push(upOf(ev)), rights.push(rightOf(ev)))); }
  assert.ok(Math.abs(ups[0]) < 0.5 && ups[7] > 5, `spray climbs: shot1 ${ups[0].toFixed(2)}°, shot8 ${ups[7].toFixed(1)}°`);
  const mean = (a, i, j) => a.slice(i, j).reduce((s, v) => s + v, 0) / (j - i);
  assert.ok(mean(rights, 10, 17) > 1.2 && mean(rights, 18, 28) < -0.5, // CS2 AK: up, then right, then left
    `spray sweeps right then left: shots 11-17 ${mean(rights, 10, 17).toFixed(2)}°, shots 19-28 ${mean(rights, 18, 28).toFixed(2)}°`);
  for (let i = 0; i < 40; i++) e.step([idle, idle]); // 0.625 s pause
  assert.ok(Math.hypot(...p.punch) < 0.3 && p.recoilIndex < 1, `recoil recovered: punch ${Math.hypot(...p.punch).toFixed(2)}, index ${p.recoilIndex.toFixed(2)}`);
  assert.ok(inaccuracy(p) < 0.01, `standing accuracy back: ${inaccuracy(p).toFixed(4)}`);
  for (let i = 0; i < 64; i++) e.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
  assert.ok(inaccuracy(p) > 0.15, `running inaccuracy ${inaccuracy(p).toFixed(3)}`);
}
{ // sub-tick: shot happens at its fraction of the tick; movement starting mid-tick accelerates for the remaining part only
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
  e.step([[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0.5], idle]);
  const shot = e.events.find(ev => ev.type === 'shot');
  assert.ok(Math.abs(shot.t - 0.5 / 64) < 1e-9, `shot at sub-tick ${shot.t}`);
  const full = arena(), half = arena(); place(full, [0, 0, 0], [3000, 3000, 0]); place(half, [0, 0, 0], [3000, 3000, 0]);
  full.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]); half.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5], idle]);
  const vf = full.players[0].vel[0], vh = half.players[0].vel[0];
  assert.ok(Math.abs(vh - vf / 2) < 0.5, `half-tick press: v ${vh.toFixed(2)} vs full ${vf.toFixed(2)}`);
}
{ // duck ramp: 10 ticks (6.4/s), hull switches when full; eye level 64.09 standing → 46.08 ducked (Valve reference)
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
  const p = e.players[0], crouchA = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0], eyeZ = () => e.players[0].pos[2] + 64.093811 + (46.076218 - 64.093811) * p.duck;
  assert.ok(Math.abs(e.look(p, [100, 0, 0]).dz + 64.09 + 0.03) < 0.05, 'standing eye level 64.09');
  for (let i = 0; i < 5; i++) e.step([crouchA, idle]);
  assert.ok(Math.abs(p.duck - 0.5) < 1e-6 && !p.crouch, `half-way duck ${p.duck.toFixed(2)}`);
  for (let i = 0; i < 5; i++) e.step([crouchA, idle]);
  assert.ok(p.duck === 1 && p.crouch, 'fully ducked after 10 ticks');
  assert.ok(Math.abs(eyeZ() - p.pos[2] - 46.076) < 0.01, 'ducked eye level 46.08');
}
const run = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], jumpRun = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
{ // Valve Mapper's Reference, 64 tick: highest block you can get on — standing jump 54, jump while crouched 56,
  // jump then crouch 63, crouch then jump 65 (and one unit more is out of reach)
  const techniques = { // tick → [jump, crouch]
    standing: t => [t === 2, 0], crouched: t => [t === 15, 1], jumpThenCrouch: t => [t === 2, t >= 3], crouchThenJump: t => [t === 4, t >= 2],
  };
  const reach = (tech, h) => {
    const e = arena([[0, -100, 0, 2000, 100, h]]); place(e, [-16 - 0.05, 0, 0], [3000, 3000, 0]);
    for (let t = 0; t < 120; t++) { const [j, c] = techniques[tech](t); e.step([[1, 0, 0, 0, +j, +c, 0, 0, 0, 0], idle]); }
    return e.players[0].pos[2] > h - 0.1;
  };
  for (const [tech, h] of [['standing', 54], ['crouched', 56], ['jumpThenCrouch', 63], ['crouchThenJump', 65]]) {
    assert.ok(reach(tech, h), `${tech}: gets on ${h}`);
    // 66 after crouch-then-jump sits exactly at the apex (Valve: possible on 64 tick only with edge strafing), so not asserted
    if (tech !== 'crouchThenJump') assert.ok(!reach(tech, h + 1), `${tech}: can't get on ${h + 1}`);
  }
}
{ // landing penalty: speed clamped to ~80% of max on touchdown, back to full within ~0.3 s; bhop jump capped at 1.1 × max;
  // walk = 52% of run speed
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
  const p = e.players[0], hs = () => Math.hypot(p.vel[0], p.vel[1]);
  for (let i = 0; i < 128; i++) e.step([run, idle]);
  e.step([jumpRun, idle]);
  while (!p.onGround) e.step([run, idle]);
  assert.ok(hs() > 0.7 * 215 && hs() < 0.9 * 215, `landing clamp: ${hs().toFixed(1)}`);
  for (let i = 0; i < 24; i++) e.step([run, idle]);
  assert.ok(hs() > 214, `recovered after landing: ${hs().toFixed(1)}`);
  p.vel[0] = 400; p.vel[1] = 0; e.step([run, idle]); e.step([jumpRun, idle]);
  assert.ok(hs() <= 1.1 * 215 + 1e-6, `bhop cap at jump: ${hs().toFixed(1)}`);
  const w = arena(); place(w, [0, 0, 0], [3000, 3000, 0]);
  for (let i = 0; i < 128; i++) w.step([[1, 0, 0, 0, 0, 0, 1, 0, 0, 0], idle]);
  const vw = Math.hypot(...w.players[0].vel.slice(0, 2));
  assert.ok(Math.abs(vw - 111.8) < 0.5, `AK walk plateau ${vw.toFixed(2)} (CS2 111.79)`);
  // crouch-walk holds 34% of the weapon speed: acceleration scales with the weapon's speed, not the ducked wish speed
  // (with the ducked one, AK friction beat acceleration and crouch-walking ground to a halt)
  const c = arena(); place(c, [0, 0, 0], [3000, 3000, 0]);
  for (let i = 0; i < 192; i++) c.step([[1, 0, 0, 0, 0, 1, 0, 0, 0, 0], idle]);
  const vc = Math.hypot(...c.players[0].vel.slice(0, 2));
  assert.ok(Math.abs(vc - 215 * 0.34) < 0.5, `AK crouch-walk plateau ${vc.toFixed(2)} (CS2 73.1)`);
}
{ // weapon catalog from CS2 weapons.vdata: same AK/Glock numbers the sim was tuned with; loadouts; shotguns
  const ak = CATALOG.ak47, gl = CATALOG.glock;
  assert.deepEqual([ak.dmg, ak.cycle, ak.mag, ak.reserve, ak.pen, ak.rm, ak.speed, ak.spread, ak.inacc.move, ak.recoil.seed], [36, 0.1, 30, 3, 0.775, 0.98, 215, 0.0006, 0.17506, 223]);
  assert.deepEqual([gl.dmg, gl.cycle, gl.mag, gl.reserve, gl.burst.gap, gl.burst.cycle], [30, 0.15, 20, 6, 0.05, 0.5]);
  assert.ok(Object.keys(CATALOG).length > 50 && CATALOG.awp && CATALOG.m4a1_silencer && CATALOG.usp_silencer, 'every CS2 weapon');
  assert.throws(() => new Env({ loadout: ['ak47', 'nope', 'knife'] }), /loadout/, 'unknown weapon refused');
  const e = new Env({ opponent: 'agent', frameSkip: 1, seed: 1, loadout: ['nova', 'deagle', 'knife'], map: { boxes: [FLOOR], spawns: [[[0, 0, 0, 0]], [[3000, 3000, 0, 0]]] } });
  const p = e.players[0], fire = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], reload = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
  assert.deepEqual([p.ammo[0], p.reserve[0], p.ammo[1], p.reserve[1]], [8, 32, 7, 3], 'Nova 8 + 32 shells, Deagle 7 + 3 magazines');
  for (let i = 0; i < 70; i++) e.step([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]); // deploy
  e.step([fire, idle]);
  assert.equal(e.events.filter(ev => ev.type === 'shot').length, 9, 'Nova: 9 pellets per shot');
  assert.equal(p.ammo[0], 7, 'one shell per shot');
  for (let i = 0; i < 64; i++) e.step([idle, idle]);
  e.step([reload, idle]); for (let i = 0; i < 64; i++) e.step([idle, idle]);
  assert.deepEqual([p.ammo[0], p.reserve[0]], [8, 31], 'shells are loaded one by one from loose rounds, nothing discarded');
}
{ // demo playback: interpolation between frames, yaw across ±180, weapon → model, events, score, a missing player
  // fields: x y z yaw pitch hp armor alive team weapon duck
  const demo = { tickrate: 64, players: [{ name: 'a' }, { name: 'b' }], weapons: ['ak47', 'usp_silencer', 'knife_t', 'm4a1_silencer'],
    frames: { ticks: [0, 4], data: [0, 0, 0, 170, 0, 100, 100, 1, 0, 0, 0, ...Array(11).fill(null), 64, 0, 0, -170, 10, 90, 100, 1, 0, 1, 1, ...Array(11).fill(null)] },
    events: [{ tick: 1, type: 'shot', by: 0 }, { tick: 3, type: 'kill', by: 0, victim: 1 }, { tick: 5, type: 'shot', by: 1 }],
    rounds: [{ start: 0, freezeEnd: 0, end: 3, winner: 1 }, { start: 4, freezeEnd: 4, end: null, winner: -1 }] };
  const [p, q] = stateAt(demo, 2);
  assert.ok(Math.abs(p.pos[0] - 32) < 1e-9 && Math.abs(p.vel[0] - 64 / (4 / 64)) < 1e-6, 'position and speed interpolate');
  assert.ok(Math.abs(Math.abs(p.yaw) - 180) < 1e-9, `yaw goes through 180, not 0: ${p.yaw}`);
  assert.equal(p.weapon, 0, 'AK model while the frame says ak47');
  assert.equal(q.present, false, 'player missing from the frames');
  assert.equal(stateAt(demo, 4)[0].weapon, 1, 'USP-S shown with the pistol model');
  assert.deepEqual([modelSlot('m4a1_silencer'), modelSlot('deagle'), modelSlot('knife_t'), modelSlot('hegrenade')], [0, 1, 2, 2]);
  assert.deepEqual(eventsBetween(demo, 0, 3).map(e => e.type), ['shot', 'kill'], 'events passed over (t0, t1]');
  assert.deepEqual(scoreAt(demo, 3), [0, 1]); assert.equal(roundAt(demo, 5), 1); assert.deepEqual(killsAt(demo, 3), [1, 0]);
}
{ // true floor height: a voxel floor stands you up to a voxel above the real (render) floor; with the map's surfaces
  // (tools/surface-map.js) eyes and hitboxes drop to the real floor while collision stays on the voxels
  const dims = [40, 40, 30], bits = new Uint8Array(Math.ceil(dims[0] * dims[1] * dims[2] / 8));
  for (let i = 0; i < 1600; i++) for (let k = 0; k < 2; k++) { const n = i + 1600 * k; bits[n >> 3] |= 1 << (n & 7); } // voxel floor top: 8
  const cells = []; for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) cells.push([i + 10 * j, 5, 0]); // render floor: 5
  const surfaces = { cell: 16, origin: [0, 0], dims: [10, 10], surfaces: ['concrete'], cells };
  const mk = s => new Env({ opponent: 'none', frameSkip: 1, seed: 1, map: { grid: { origin: [0, 0, 0], size: 4, dims, bits }, surfaces: s, spawns: [[[80, 80, 8.1, 0]], [[80, 80, 8.1, 0]]] } });
  const a = mk(surfaces), b = mk(undefined);
  for (let i = 0; i < 32; i++) { a.step([idle]); b.step([idle]); }
  const pa = a.players[0], pb = b.players[0];
  assert.ok(Math.abs(pa.pos[2] - pb.pos[2]) < 1e-9, 'collision unchanged: both stand on the voxel floor');
  assert.ok(Math.abs(eye(pb)[2] - eye(pa)[2] - (pb.pos[2] - 5)) < 0.01, `eyes drop to the real floor: ${eye(pa)[2].toFixed(2)} vs ${eye(pb)[2].toFixed(2)}`);
  assert.ok(Math.abs(eye(pa)[2] - (5 + 64.093811)) < 0.01, 'eye = real floor + 64.09');
}
{ // practice alone (viewer setting "no bot"): no enemy team, the round only ends on the clock or your death
  const e = new Env({ opponent: 'none', frameSkip: 1, seed: 1 });
  assert.equal(e.players.length, 1, 'only you');
  for (let i = 0; i < 64; i++) e.step([idle]);
  assert.equal(e.done, false, 'no enemy left is not a win');
  e.tick = e.cfg.maxSeconds * 64; e.step([idle]); // time is derived from the tick
  assert.equal(e.done, true, 'the clock still ends it');
}
{ // CS2 magazines (March 2026): reserve = spare magazines (AK 3), a reload throws away what is left in the current one,
  // and with no spare magazine left there is no reload
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]); const p = e.players[0], fire = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], reload = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
  assert.deepEqual([p.ammo[0], p.reserve[0]], [30, 3], 'AK starts 30 + 3 magazines');
  assert.deepEqual([p.ammo[1], p.reserve[1]], [20, 6], 'Glock starts 20 + 6 magazines');
  for (let i = 0; i < 64; i++) e.step([fire, idle]); // ~10 rounds out
  const left = p.ammo[0]; assert.ok(left > 0 && left < 30, `rounds left ${left}`);
  e.step([reload, idle]); for (let i = 0; i < 64 * 3; i++) e.step([idle, idle]);
  assert.deepEqual([p.ammo[0], p.reserve[0]], [30, 2], `reload: fresh magazine, the ${left} rounds left are gone`);
  for (let m = 0; m < 2; m++) { e.step([reload, idle]); for (let i = 0; i < 64 * 3; i++) e.step([idle, idle]); }
  assert.equal(p.reserve[0], 2, 'full magazine: no reload');
  p.ammo[0] = 5; p.reserve[0] = 0; e.step([reload, idle]); for (let i = 0; i < 64 * 3; i++) e.step([idle, idle]);
  assert.equal(p.ammo[0], 5, 'no spare magazine: no reload');
}
{ // running off a ledge: under 20 units you stick to the ground, 20+ you fall (Valve reference)
  for (const [h, sticks] of [[19, true], [21, false]]) {
    const e = arena([[-300, -100, 0, 100, 100, h]]); place(e, [0, 0, h + 0.03125], [3000, 3000, 0]);
    const p = e.players[0]; let air = 0;
    for (let i = 0; i < 64; i++) { e.step([run, idle]); if (!p.onGround) air++; }
    assert.equal(air === 0, sticks, `${h}-unit ledge: airborne ticks ${air}`);
  }
}
{ // walking off a 16-unit step keeps you on the ground; 300-unit drop hurts
  const e = arena([[-200, -100, 0, 100, 100, 16]]); place(e, [0, 0, 16.01], [3000, 3000, 0]);
  const p = e.players[0]; let air = 0;
  for (let i = 0; i < 128; i++) { e.step([run, idle]); if (!p.onGround) air++; }
  assert.ok(p.pos[0] > 200 && Math.abs(p.pos[2]) < 0.1 && air === 0, `stepped down without going airborne (air ticks ${air}, pos ${p.pos.map(Math.round)})`);
  const f = arena(); place(f, [0, 0, 300], [3000, 3000, 0]); f.players[0].onGround = false;
  for (let i = 0; i < 64; i++) f.step([idle, idle]);
  assert.ok(f.players[0].hp >= 70 && f.players[0].hp <= 80, `fall damage, hp ${f.players[0].hp}`);
}
{ // players are solid (mp_solid_teammates 1): you can't walk through someone, but you can stand on their head
  const e = arena(); place(e, [0, 0, 0], [100, 0, 0]);
  for (let i = 0; i < 64; i++) e.step([run, idle]);
  assert.ok(e.players[0].pos[0] <= 100 - 32 + 0.1, `blocked by player x=${e.players[0].pos[0].toFixed(2)}`);
  const h = arena(); place(h, [0, 0, 80], [0, 0, 0]); h.players[0].onGround = false;
  for (let i = 0; i < 64; i++) h.step([idle, idle]);
  assert.ok(Math.abs(h.players[0].pos[2] - 72) < 0.1, `standing on a head z=${h.players[0].pos[2].toFixed(2)}`);
}
{ // wall penetration (m_flPenetration): AK goes through 8 units with reduced damage, not through 48
  for (const [thick, through] of [[8, true], [48, false]]) {
    const e = arena([[200, -100, 0, 200 + thick, 100, 200]]); place(e, [0, 0, 0], [400, 0, 0]);
    const l = e.look(e.players[0], [400, 0, 0.7 * 72]);
    e.step([[0, 0, l.yawErr, l.pitchErr, 0, 0, 0, 1, 0, 0], idle]);
    const dmg = 100 - e.players[1].hp;
    if (through) assert.ok(dmg > 0 && dmg < 27, `wallbang through ${thick}: ${dmg} dmg (open shot 27)`);
    else assert.equal(dmg, 0, `no wallbang through ${thick}`);
  }
}
{ // Glock burst mode (right-click toggle): one click fires 3 shots 0.05 s apart; knife backstab 90 / stab 180
  const g = arena(); place(g, [0, 0, 0], [3000, 3000, 0]);
  g.step([[0, 0, 0, 0, 0, 0, 0, 0, 0, 2], idle]);
  for (let i = 0; i < 70; i++) g.step([idle, idle]); // deploy
  g.step([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], idle]); // toggle burst
  let shots = []; for (let i = 0; i < 40; i++) { g.step([[0, 0, 0, 0, 0, 0, 0, +(i === 1), 0, 0], idle]); g.events.forEach(ev => ev.type === 'shot' && shots.push(ev.t)); }
  assert.equal(shots.length, 3, `burst of 3 (got ${shots.length})`);
  assert.ok(Math.abs(shots[1] - shots[0] - 0.05) < 1e-9, 'burst gap 0.05 s');
  for (const [stab, dmgWanted] of [[false, 90], [true, 180]]) {
    const k = arena(); place(k, [0, 0, 0], [40, 0, 0]); k.players[1].yaw = 0; k.players[1].armor = 0; k.players[1].hp = 200; // facing away
    k.step([[0, 0, 0, 0, 0, 0, 0, 0, 0, 3], idle]);
    for (let i = 0; i < 70; i++) k.step([idle, idle]);
    k.step([[0, 0, 0, 0, 0, 0, 0, +!stab, 0, 0, 0, 0, +stab], idle]);
    assert.equal(200 - k.players[1].hp, dmgWanted, `${stab ? 'stab' : 'slash'} in the back`);
  }
}
{ // counter-strafe: from full AK speed, pressing the opposite key gets under 34% (accurate) quickly; just releasing is slower
  for (const counter of [true, false]) {
    const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
    for (let i = 0; i < 128; i++) e.step([[0, 1, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
    let ticks = 0; while (Math.abs(e.players[0].vel[1]) > 215 * 0.34 && ticks < 64) { e.step([[0, counter ? -1 : 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]); ticks++; }
    console.log(`${counter ? 'counter-strafe' : 'release'}: accurate after ${ticks} ticks (${(ticks * 1000 / 64).toFixed(0)} ms)`);
    if (counter) assert.ok(ticks <= 8, 'counter-strafe within ~125 ms');
  }
}
{ // wall blocks bullets and movement
  const e = arena([[200, -100, 0, 232, 100, 200]]); place(e, [0, 0, 0], [500, 0, 0]);
  for (let i = 0; i < 20; i++) e.step([[0, 0, 0, 0, 0, 0, 0, 1, 0, 0], idle]);
  assert.equal(e.players[1].hp, 100, 'wall stops bullets');
  for (let i = 0; i < 200; i++) e.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
  assert.ok(e.players[0].pos[0] <= 200 - 16 + 0.01, `stopped at wall x=${e.players[0].pos[0]}`);
}
{ // 16-unit step is climbed, 64-unit crate is not
  const e = arena([[100, -100, 0, 300, 100, 16], [600, -100, 0, 700, 100, 64]]); place(e, [0, 0, 0], [2000, 2000, 0]);
  for (let i = 0; i < 64; i++) e.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
  assert.ok(Math.abs(e.players[0].pos[2] - 16) < 0.05, `on step z=${e.players[0].pos[2]}`);
  for (let i = 0; i < 200; i++) e.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
  assert.ok(e.players[0].pos[0] < 600 - 15, 'crate blocks');
  const speed = Math.hypot(...e.players[0].vel.slice(0, 2));
  assert.ok(speed < 1, 'pressed into crate');
}
{ // forward, sideways and diagonal (W+A) all reach the same top speed — diagonal input is normalised, not slower or faster
  for (const [fwd, strafe] of [[0, 1], [1, -1], [-1, 1]]) {
    const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]); e.players[0].yaw = 37;
    for (let i = 0; i < 128; i++) e.step([[fwd, strafe, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
    const v = Math.hypot(...e.players[0].vel.slice(0, 2));
    assert.ok(Math.abs(v - 215) < 1, `input fwd ${fwd} strafe ${strafe}: speed ${v.toFixed(1)}`);
  }
}
{ // run speed caps at weapon max speed (AK 215)
  const e = arena(); place(e, [0, 0, 0], [3000, 3000, 0]);
  for (let i = 0; i < 128; i++) e.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]);
  const v = Math.hypot(...e.players[0].vel.slice(0, 2));
  assert.ok(Math.abs(v - 215) < 1, `speed ${v}`);
}
{ // bad network input is clamped, not crashing
  const e = arena(); e.step([['x', null, 1e9, -1e9, 'y', {}, [], 5, -3, 99], null]);
  assert.ok(Math.abs(e.players[0].pitch) <= 89);
}
{ // default map: bot vs bot rounds finish; obs size matches
  const e = new Env({ seed: 3 });
  assert.equal(e.observeAll()[0].length, e.obsSize);
  let rounds = 0, winners = [0, 0, 0];
  const t = performance.now();
  let steps = 0;
  for (let r = 0; r < 20; r++) { e.reset(r); while (!e.done) { e.step([e.botAction(e.players[0])]); steps++; } winners[e.winner + 1]++; rounds++; }
  const ms = performance.now() - t;
  console.log(`bot vs bot: ${rounds} rounds, draw/T/CT = ${winners}, ${(steps / ms * 1000).toFixed(0)} env-steps/s single core`);
}
{ // column-bitmask hull test == brute-force voxel scan (random grid with a 40-voxel-tall column layout, hulls poking out of it)
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const dims = [20, 18, 45], bits = new Uint8Array(Math.ceil(dims[0] * dims[1] * dims[2] / 8));
  for (let i = 0; i < dims[0] * dims[1] * dims[2]; i++) if (rnd() < 0.08) bits[i >> 3] |= 1 << (i & 7);
  const grid = { origin: [0, 0, 0], size: 4, dims, bits };
  const brute = (x, y, z, h) => { // reference: one lookup per voxel, outside counts as solid
    const s = 4, b = [Infinity, Infinity, Infinity, -1e9, -1e9, -1e9];
    for (let k = Math.floor(z / s); k <= Math.ceil((z + h) / s) - 1; k++) for (let j = Math.floor((y - 16) / s); j <= Math.ceil((y + 16) / s) - 1; j++) for (let i = Math.floor((x - 16) / s); i <= Math.ceil((x + 16) / s) - 1; i++) {
      const inside = i >= 0 && j >= 0 && k >= 0 && i < dims[0] && j < dims[1] && k < dims[2], n = i + dims[0] * (j + dims[1] * k);
      if (inside && !(bits[n >> 3] & (1 << (n & 7)))) continue;
      b[0] = Math.min(b[0], i * s); b[1] = Math.min(b[1], j * s); b[2] = Math.min(b[2], k * s); b[3] = Math.max(b[3], (i + 1) * s); b[4] = Math.max(b[4], (j + 1) * s); b[5] = Math.max(b[5], (k + 1) * s);
    }
    return b[0] === Infinity ? null : b;
  };
  for (let n = 0; n < 3000; n++) {
    const x = rnd() * 100 - 10, y = rnd() * 90 - 10, z = rnd() * 200 - 20, h = rnd() < 0.5 ? 72 : 54;
    assert.deepEqual(hullHit({ grid }, x, y, z, h), brute(x, y, z, h), `hull query ${n} at ${[x, y, z, h].map(v => v.toFixed(1))}`);
  }
}
{ // jumping while running up a voxel ramp (1:2, 4-unit risers) keeps the speed instead of stopping dead on a riser
  const dims = [200, 20, 60], bits = new Uint8Array(Math.ceil(dims[0] * dims[1] * dims[2] / 8));
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) for (let k = 0; k < Math.min(50, 2 + Math.max(0, (i - 40) >> 1)); k++) {
    const n = i + dims[0] * (j + dims[1] * k); bits[n >> 3] |= 1 << (n & 7);
  }
  const map = { grid: { origin: [0, -40, 0], size: 4, dims, bits }, spawns: [[[60, 0, 8.01, 0]], [[20, 0, 8.01, 0]]] };
  const e = new Env({ map, opponent: 'agent', frameSkip: 1, seed: 1 }), p = e.players[0], run = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  place(e, [60, 0, 8.01], [20, 0, 8.01]);
  for (let i = 0; i < 80; i++) e.step([run, idle]); // up to speed, onto the ramp
  assert.ok(p.onGround && p.pos[0] > 200, `running up the ramp x=${p.pos[0].toFixed(0)}`);
  const x0 = p.pos[0];
  e.step([[1, 0, 0, 0, 1, 0, 0, 0, 0, 0], idle]);
  for (let i = 0; i < 47; i++) e.step([run, idle]);
  assert.ok(p.pos[0] - x0 > 120, `jump on the ramp keeps going: ${(p.pos[0] - x0).toFixed(0)} units in 0.75 s`);
}
{ // radar overview: floors reachable by walking from the spawn (ramp up to a plateau), not the top of a tall pillar
  const dims = [80, 24, 60], bits = new Uint8Array(Math.ceil(dims[0] * dims[1] * dims[2] / 8));
  const top = (i, j) => (i >= 4 && i < 10 && j >= 4 && j < 10 ? 40 : Math.min(22, 2 + Math.max(0, (i - 30) >> 1))); // pillar | floor→ramp→plateau
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) for (let k = 0; k < top(i, j); k++) { const n = i + dims[0] * (j + dims[1] * k); bits[n >> 3] |= 1 << (n & 7); }
  const r = radarHeights({ origin: [0, 0, 0], size: 4, dims, bits }, [[100, 60, 8]], 2), at = (x, y) => r.heights[Math.floor(x / 8) + r.W * Math.floor(y / 8)];
  assert.equal(at(100, 60), 8, 'ground at the spawn');
  assert.equal(at(300, 60), 88, 'plateau reached up the ramp');
  assert.ok(Number.isNaN(at(28, 28)) && r.solid[Math.floor(28 / 8) + r.W * Math.floor(28 / 8)], 'pillar top unreachable, drawn as solid');
}
{ // footstep pacing (CS): running steps every 0.3 s, walk key / crouch-walk silent, airborne silent, landing always heard
  const count = (speed, ground, secs) => { const s = { t: 0, air: false }, out = []; for (let i = 0; i < secs * 64; i++) { const f = footstep(s, speed, ground, 1 / 64); if (f) out.push(f); } return out; };
  assert.equal(count(250, true, 3).length, 10, 'full run: a step every 0.3 s');
  assert.equal(count(112, true, 3).length, 0, 'walk key (shift) is silent');
  assert.equal(count(250, false, 1).length, 0, 'no steps in the air');
  const s = { t: 0, air: false }; footstep(s, 250, false, 1 / 64);
  assert.equal(footstep(s, 250, true, 1 / 64), 'land', 'landing makes a sound');
  assert.equal(footstep(s, 250, false, 1 / 64, 290), 'jump', 'take-off makes a sound');
  const w = { t: 0, air: false }; assert.equal(footstep(w, 250, false, 1 / 64, -20), null, 'walking off a ledge is silent');
  // volume over distance: full near, silent exactly at the CS range (footsteps ~1100), falling in between
  assert.equal(falloff(30, 40, 1100), 1); assert.equal(falloff(1100, 40, 1100), 0); assert.equal(falloff(1500, 40, 1100), 0);
  assert.ok(falloff(400, 40, 1100) > falloff(800, 40, 1100) && falloff(800, 40, 1100) > 0, 'monotonic fade');
}
{ // footstep surface map: sand floor, a wooden crate on it, a wall that must not count as floor
  const quad = (x0, y0, x1, y1, z) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
  const wall = [0, 300, 0, 300, 300, 0, 300, 300, 200, 0, 300, 0, 300, 300, 200, 0, 300, 200];
  const tris = new Float64Array([...quad(0, 0, 300, 300, 0), ...quad(100, 100, 164, 164, 40), ...wall]);
  const sm = surfaceMap(tris, [['materials/de_dust/hr_dust_sand_02.vmat', 2], ['models/props/dust_crates/dust_shipping_crate_01_wood_color.vmat', 2], ['hr_dust_plaster_17', 2]]);
  assert.equal(surfaceAt(sm, [50, 50, 0]), 'sand', 'floor');
  assert.equal(surfaceAt(sm, [130, 130, 40]), 'wood', 'standing on the crate');
  assert.equal(surfaceAt(sm, [130, 130, 0]), 'sand', 'below the crate top: the floor at your feet');
  assert.equal(surfaceAt(sm, [150, 299, 100]), 'concrete', 'wall is no floor: default');
  assert.equal(surfaceOf('models/props/de_dust/hr_dust/dust_windows/dust_window_bars_metal_01'), 'metal', 'name, not folder');
}
{ // real-map import pipeline: GLB (meters, Y up, nested nodes, sky to skip) → voxels → same physics
  const file = path.join(os.tmpdir(), 'arena-test.glb');
  writeGlb(file);
  const raw = triangles(readGltf(file));
  assert.equal(raw.length / 9, MAP.boxes.length * 12, 'sky node skipped');
  const { tris, scale } = toSource(raw);
  assert.ok(Math.abs(scale - 39.37) < 0.01, 'meters detected');
  const grid = voxelize(tris, 8), map = { grid, spawns: makeSpawns({ grid }, [0, -1750, 0], [0, 1700, 0]) };
  for (const s of map.spawns.flat()) assert.ok(s[2] >= 0 && s[2] <= 8.1, `spawn on floor z=${s[2]}`);
  assert.equal(map.spawns[0][0][3], 90, 'T faces CT');

  const e = new Env({ map, opponent: 'agent', frameSkip: 1, seed: 2 });
  place(e, [0, -1750, 8.01], [0, -1400, 8.01]);
  for (let i = 0; i < 10; i++) e.step([idle, idle]);
  assert.ok(Math.abs(e.players[0].pos[2] - 8) < 0.1, `stands on voxel floor z=${e.players[0].pos[2]}`);
  e.step([[...aimHead(e, e.players[0], e.players[1]), 0, 0, 0, 1, 0, 0], idle]);
  assert.equal(e.players[1].alive, false, 'headshot on voxel map');

  const w = new Env({ map, opponent: 'agent', frameSkip: 1, seed: 2 });
  place(w, [-1200, -800, 8.01], [1350, -800, 8.01]);
  assert.equal(w.look(w.players[0], w.headOf(w.players[1])).visible, false, 'buildings occlude');
  w.players[0].yaw = 90;
  for (let i = 0; i < 64 * 16; i++) w.step([[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle]); // walk north up B lane into B site
  const y = w.players[0].pos[1];
  assert.ok(y > 1900 && y < 1984 - 16, `stopped by north wall y=${y}`);
}
{ // agent packer: keeps only the wanted clips, drops their data, remaps accessors, writes a readable GLB
  const f32 = a => Buffer.from(new Float32Array(a).buffer);
  const data = [f32([0, 0, 0, 1, 0, 0, 0, 1, 0]), f32([0, 1]), f32([0, 0, 0, 0, 2, 0]), f32([0, 9]), f32([5, 5, 5, 6, 6, 6])];
  const offs = data.reduce((o, d, i) => [...o, o[i] + d.length], [0]);
  const acc = (i, count, type) => ({ bufferView: i, componentType: 5126, count, type });
  const clip = (name, input, output) => ({ name, channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input, output }] });
  const src = { json: {
    asset: { version: '2.0' }, nodes: [{ name: 'pelvis', mesh: 0 }], images: [{ uri: 'body.png' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [acc(0, 3, 'VEC3'), acc(1, 2, 'SCALAR'), acc(2, 2, 'VEC3'), acc(3, 2, 'SCALAR'), acc(4, 2, 'VEC3')],
    bufferViews: data.map((d, i) => ({ buffer: 0, byteOffset: offs[i], byteLength: d.length })), buffers: [{ byteLength: offs[5] }],
    animations: [clip('animation/anims/world/rifle/_default_rifle/run_n_rifle', 1, 2), clip('animation/anims/ui_anims/menu_wave', 3, 4)],
  }, bufs: [Buffer.concat(data)] };
  const { json, bin } = packModel(src);
  assert.deepEqual(json.animations.map(a => a.name), ['animation/anims/world/rifle/_default_rifle/run_n_rifle'], 'only viewer clips kept');
  assert.equal(json.accessors.length, 3, 'unused clip data dropped');
  const file = path.join(os.tmpdir(), 'arena-agent.glb');
  fs.writeFileSync(file, glb(json, bin));
  const back = readGltf(file), s = back.json.animations[0].samplers[0], a = back.json.accessors[s.output], bv = back.json.bufferViews[a.bufferView];
  assert.deepEqual([...new Float32Array(back.bufs[0].buffer.slice(back.bufs[0].byteOffset + bv.byteOffset, back.bufs[0].byteOffset + bv.byteOffset + bv.byteLength))], [0, 0, 0, 0, 2, 0], 'clip data survives the remap');
  assert.equal(back.json.images[0].uri, 'body.png', 'textures stay external');
}
{ // scopes: attack2 zooms (AWP 2 levels), scoped accuracy and speed from weapons.vdata, AWP leaves the scope for the bolt
  const flat = { boxes: [[-4000, -4000, -64, 4000, 4000, 0]], spawns: [[[0, 0, 0, 0]], [[400, 0, 0, 180]]] };
  const A = (o = {}) => Object.assign(new Array(13).fill(0), o);
  const e = new Env({ opponent: 'none', frameSkip: 1, seed: 1, map: flat, loadout: ['awp', 'glock', 'knife'] }), p = e.players[0];
  for (let i = 0; i < 90; i++) e.step([A()]); // deploy
  const noscope = inaccuracy(p);
  e.step([A({ 12: 1 })]); assert.equal(p.zoom, 1); e.step([A()]); e.step([A({ 12: 1 })]); assert.equal(p.zoom, 2);
  const scoped = inaccuracy(p);
  assert.ok(scoped < noscope / 20, `scoped AWP is accurate: ${scoped} vs ${noscope}`);
  assert.equal(e.state().players[0].zoomFov, 10);
  e.step([A({ 7: 1 })]); assert.equal(p.zoom, 0, 'out of the scope for the bolt');
  for (let i = 0; i < 100; i++) e.step([A()]);
  assert.equal(p.zoom, 2, 'back in after the bolt');
  let top = 0; for (let i = 0; i < 128; i++) { e.step([A({ 0: 1 })]); top = Math.max(top, Math.hypot(p.vel[0], p.vel[1])); }
  assert.ok(top > 95 && top <= 100.5, `scoped AWP walks at 100: ${top}`);
  e.step([A({ 12: 1 })]); assert.equal(p.zoom, 0, 'third press: out');
  console.log(`scope: AWP inaccuracy ${noscope.toFixed(4)} → ${scoped.toFixed(4)} rad scoped, speed 100`);
}
{ // grenades: inventory, throw physics, HE / flash / smoke / fire
  const flat = { boxes: [[-4000, -4000, -64, 4000, 4000, 0], [600, -400, 0, 640, 400, 300]], spawns: [[[0, 0, 0, 0]], [[400, 0, 0, 180]]] };
  const A = (o = {}) => Object.assign(new Array(13).fill(0), o);
  assert.throws(() => new Env({ grenades: ['flashbang', 'flashbang', 'flashbang'] }), /grenades/);
  assert.throws(() => new Env({ grenades: ['molotov', 'incgrenade'] }), /grenades/);
  const mk = () => new Env({ opponent: 'agent', frameSkip: 1, seed: 2, map: flat, grenades: ['hegrenade', 'flashbang', 'smokegrenade', 'molotov'] });
  let e = mk(), [p, q] = e.players;
  assert.deepEqual(q.nades, ['hegrenade', 'flashbang', 'smokegrenade', 'incgrenade'], 'CT carry an incendiary');
  // throw: slot 4, pin out while held, released → flies 0.1 s later at 675 u/s, back to the rifle, HE goes off 1.5 s after
  e.step([A({ 9: 4 }), A()]); assert.equal(e.state().players[0].weaponName, 'hegrenade');
  for (let i = 0; i < 70; i++) e.step([A({ 7: 1 }), A()]);
  assert.ok(p.pin && !e.nades.length, 'pin pulled, nothing thrown while held');
  for (let i = 0; i < 8; i++) e.step([A(), A()]);
  assert.equal(e.nades.length, 1); assert.ok(Math.abs(Math.hypot(...e.nades[0].vel) - 675) < 15, `throw speed ${Math.hypot(...e.nades[0].vel)}`);
  assert.equal(p.weapon, 0, 'back to the primary'); assert.equal(p.nades.length, 3);
  const born = e.nades[0].born;
  let boom = null; for (let i = 0; i < 120 && !boom; i++) { e.step([A(), A()]); boom = e.events.find(x => x.type === 'detonate'); }
  assert.ok(boom && Math.abs(e.time - born - NADE.fuse) < 2 / 64, `HE detonates 1.5 s after the throw: ${boom && (e.time - born).toFixed(3)}`);
  // HE right next to the CT: hurts through armor, not through the wall
  e = mk(); [p, q] = e.players;
  e.detonate({ id: 9, type: 'hegrenade', by: p.id, pos: [q.pos[0] - 40, q.pos[1], 4], state: 'rest' });
  assert.ok(q.hp < 60 && q.hp > 0, `HE at 40 units: ${100 - q.hp} damage`);
  const hp = q.hp; e.detonate({ id: 10, type: 'hegrenade', by: p.id, pos: [700, 0, 20], state: 'rest' });
  assert.equal(q.hp, hp, 'behind a wall: no damage');
  // flash in front of the T: blind (can't see the CT) for seconds; behind the CT it barely works
  e = mk(); [p, q] = e.players;
  assert.ok(e.look(p, e.headOf(q)).visible);
  e.detonate({ id: 11, type: 'flashbang', by: q.id, pos: [150, 0, 60], state: 'fly' });
  assert.ok(p.flashEnd - e.time > 3 && !e.look(p, e.headOf(q)).visible, `flashed ${(p.flashEnd - e.time).toFixed(2)} s`);
  assert.ok(q.flashEnd === 0 || q.flashEnd - e.time < p.flashEnd - e.time, 'the thrower looking away: less');
  // smoke between them hides each other; fire burns 40 hp/s; a smoke puts the fire out
  e = mk(); [p, q] = e.players;
  e.smokes.push({ id: 12, pos: [200, 0, 0], born: e.time - 2, until: e.time + 10 });
  assert.ok(!e.look(p, e.headOf(q)).visible && !e.look(q, e.headOf(p)).visible, 'smoke blocks sight');
  e = mk(); [p, q] = e.players;
  e.detonate({ id: 13, type: 'molotov', by: p.id, pos: [q.pos[0], q.pos[1], 2], state: 'fly' });
  for (let i = 0; i < 64; i++) e.step([A(), A()]);
  assert.ok(Math.abs(q.hp - 60) <= 1, `1 s in fire: ${100 - q.hp} damage`);
  e.detonate({ id: 14, type: 'smokegrenade', by: q.id, pos: [q.pos[0] + 50, q.pos[1], 2], state: 'rest' });
  assert.equal(e.fires.length, 0, 'smoke puts the fire out');
  console.log(`grenades: HE ${100 - hp} at 40u, flash ${(NADE.flashHold + NADE.flashFade).toFixed(2)} s max, fire 40/s`);
}
{ // walking on a ramp: the real floor under the hull is continuous (no steps at cell edges), so the eyes glide
  const { floorDrop } = await import('./sim/core.js');
  const cells = []; for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) cells.push([i + 10 * j, 12 + i * 0.75, 0]); // rises 0.75 per 16-unit cell
  const map = { grid: { origin: [0, 0, 0], size: 4, dims: [40, 40, 30] }, surfaces: { cell: 16, origin: [0, 0], dims: [10, 10], surfaces: ['concrete'], cells } };
  let worst = 0, prev = null;
  for (let x = 40; x <= 120; x += 0.5) { const d = floorDrop(map, [x, 80, 20]); if (prev != null) worst = Math.max(worst, Math.abs(d - prev)); prev = d; }
  assert.ok(prev > 0 && worst < 0.05, `floor under the feet changes smoothly: max step ${worst.toFixed(3)} per 0.5 unit`);
  assert.ok(Math.abs(floorDrop(map, [80, 80, 20]) - (20 - (12 + 0.75 * (95 / 16 - 0.5)))) < 0.01, 'rests on the uphill edge of the hull (x + 15)');
}
{ // CS2 sound events: distance curves, child events, which file plays from which event
  const { soundEvents } = await import('./tools/import-soundevents.js');
  const { curveAt } = await import('./public/sound.js');
  const se = soundEvents([`<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->
  { Weapon_AK47.Single = { volume = 1.1 occlusion_intensity = 0.6 broadcast_distance_override = 9000.0
      distance_volume_mapping_curve = [ [ 25.0, 0.8, 0.0, 0.0, 1.0, 1.0, ], [ 440.0, 0.735294, 0.0, 0.0, 1.0, 1.0, ], [ 2500.0, 0.014706, 0.0, 0.0, 2.0, 3.0, ], ]
      vsnd_files_track_01 = [ "sounds/weapons/ak47/ak47_01.vsnd", ] soundevent_01 = [ "Weapon_AK47.SingleDistant", ] } }`]);
  const ak = se.events['Weapon_AK47.Single'];
  assert.equal(se.byFile['ak47/ak47_01'], 'Weapon_AK47.Single'); assert.deepEqual(ak.children, ['Weapon_AK47.SingleDistant']);
  assert.equal(ak.max, 9000); assert.equal(ak.occlusion, 0.6);
  assert.equal(curveAt(ak.curve, 0), 0.8); assert.ok(Math.abs(curveAt(ak.curve, 440) - 0.735294) < 1e-9);
  assert.ok(Math.abs(curveAt(ak.curve, 1470) - (0.735294 + (0.014706 - 0.735294) * 0.5)) < 1e-6); assert.equal(curveAt(ak.curve, 5000), 0.014706);
}
{ // demo grenades: flights interpolated, smokes / fires live between their start and end
  const { utilityAt } = await import('./public/demo.js');
  const demo = { tickrate: 64, nades: [{ id: 7, type: 'hegrenade', ticks: [100, 104], pos: [0, 0, 0, 40, 0, 8] }],
    smokes: [{ start: 100, end: 200, pos: [1, 2, 3] }], fires: [{ start: 150, end: 160, pos: [0, 0, 0], type: 'molotov' }] };
  const u = utilityAt(demo, 102);
  assert.deepEqual(u.nades[0].pos, [20, 0, 4]); assert.equal(u.smokes.length, 1); assert.equal(u.fires.length, 0);
  assert.ok(Math.abs(u.smokes[0].r - 144 * (2 / 64) / 0.8) < 1e-9, 'smoke grows');
  assert.equal(utilityAt(demo, 155).fires[0].type, 'molotov'); assert.equal(utilityAt(demo, 300).smokes.length, 0);
}
{ // demo rounds and bomb: the game's team totals (follow teams across the half), team names, bomb states, kills from the match start
  const { scoreAt, teamsAt, bombAt, killsAt } = await import('./public/demo.js');
  const demo = { tickrate: 64, matchStart: 100, players: [{}, {}], events: [{ tick: 50, type: 'kill', by: 0, victim: 1 }, { tick: 300, type: 'kill', by: 1, victim: 0 }],
    rounds: [{ start: 100, freezeEnd: 200, end: 1000, winner: 0, score: [1, 0], teams: ['A', 'B'] }, { start: 1200, freezeEnd: 1300, end: 9000, winner: 1, score: [1, 1], teams: ['B', 'A'] }],
    bombs: [{ planted: 1500, by: 0, pos: [1, 2, 3], end: 1500 + 40 * 64, result: 'exploded' }], drops: [{ start: 1300, end: 1400, pos: [5, 5, 0] }] };
  assert.deepEqual(scoreAt(demo, 500), [0, 0]); assert.deepEqual(scoreAt(demo, 1100), [1, 0]); assert.deepEqual(scoreAt(demo, 9500), [1, 1]);
  assert.deepEqual(teamsAt(demo, 1500), ['B', 'A'], 'sides swapped');
  assert.deepEqual(killsAt(demo, 400), [0, 1], 'warmup kill not counted');
  assert.equal(bombAt(demo, 1350).drop.pos[0], 5); assert.equal(bombAt(demo, 1450).drop, null);
  assert.equal(bombAt(demo, 2000).bomb.state, 'ticking'); assert.equal(bombAt(demo, 1500 + 40 * 64 + 10).bomb.state, 'exploded');
  assert.equal(bombAt(demo, 1500 + 42 * 64).bomb, null, 'gone after the explosion');
}
{ // weapon folders: which agent clips a weapon gets, under readable names
  const { weaponClips } = await import('./tools/build-weapons.js');
  const A = 'animation/anims/', names = [
    'world/rifle/rifle_ak/draw_ak', 'world/rifle/rifle_ak/reload_ak_silent', 'viewmodel/rifle/rifle_ak/shoot1_ak', 'viewmodel/rifle/rifle_ak/lookat01_ak',
    'world/knife/default_ct/draw_default_ct', 'viewmodel/knife/knife_default_t/heavy_miss1_default_t', 'viewmodel/knife/_default_knife/idle_knife',
    'world/pistol/pistol_usp/draw_crouch_pistol', 'viewmodel/pistol/pistol_hkp2000/shoot1_hkp2000', 'world/rifle/_default_rifle/run_n_rifle',
  ].map(n => A + n);
  const keys = n => [...weaponClips(CATALOG[n], names).keys()].sort().join(' ');
  assert.equal(keys('ak47'), 'draw vm_lookat01 vm_shoot1');    // silent clips dropped, inspect (lookat) kept, weapon suffix cut
  assert.equal(keys('knife'), 'draw vm_heavy_miss1');          // CT world set + T viewmodel set, two-word suffixes
  assert.equal(keys('usp_silencer'), 'draw_crouch vm_shoot1'); // no USP-S viewmodel set: the P2000's
  console.log('weapon clips ok');
}
console.log('all tests passed');
