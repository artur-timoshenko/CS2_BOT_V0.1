// Records bot-vs-bot rounds of the sim as a demo (format "arena-demo-1", see public/demo.js) — test data for the demo
// player without a CS2 .dem, and a way to rewatch the bots.
//   node tools/record-demo.js [--map de_dust2] [--rounds 3] [--out arena-sample]   → public/demos/<out>.json.gz
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Env, TICK } from '../sim/core.js';
import { FIELDS } from '../public/demo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function recordDemo(map, rounds = 3, step = 4, seed = 1) {
  const env = new Env({ opponent: 'bot', frameSkip: 1, map, seed });
  const idle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const weapons = env.loadout.map(w => w.name), demo = { format: 'arena-demo-1', map: map?.name || null, tickrate: TICK, step, weapons,
    players: env.players.map(p => ({ name: `Bot ${p.team ? 'CT' : 'T'}`, steamid: String(p.id) })), frames: { ticks: [], data: [] }, events: [], rounds: [] };
  let base = 0;
  const frame = () => {
    demo.frames.ticks.push(base + env.tick);
    for (const p of env.players) demo.frames.data.push(p.pos[0], p.pos[1], p.pos[2] - (p.dz || 0), p.yaw, p.pitch, p.hp, Math.round(p.armor),
      +p.alive, p.team, p.weapon, p.duck);
  };
  for (let r = 0; r < rounds; r++) {
    env.reset(seed + r);
    demo.rounds.push({ start: base, freezeEnd: base, end: null, winner: -1 });
    frame();
    while (!env.done) {
      env.step([env.botAction(env.players[0]), idle]); // player 0 also driven by the scripted bot
      for (const e of env.events) {
        const t = base + env.tick, by = e.by ?? -1;
        if (e.type === 'shot') demo.events.push({ tick: t, type: 'shot', by, weapon: e.weapon, from: e.from, to: e.to });
        else if (e.type === 'hit') demo.events.push({ tick: t, type: 'hit', by, victim: e.victim, group: e.group, dmg: e.dmg });
        else if (e.type === 'kill') demo.events.push({ tick: t, type: 'kill', by, victim: e.victim, weapon: e.weapon, headshot: e.headshot });
      }
      if (env.tick % step === 0 || env.done) frame();
    }
    Object.assign(demo.rounds[r], { end: base + env.tick, winner: env.winner });
    base += env.tick + TICK * 3; // a short gap between rounds, like the round restart delay
  }
  if (demo.frames.data.length !== demo.frames.ticks.length * demo.players.length * FIELDS.length) throw new Error('frame layout mismatch');
  return demo;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const name = opt('--map', null), out = opt('--out', 'arena-sample'), rounds = +opt('--rounds', 3);
  let map;
  if (name) { // imported map (public/maps/<name>): voxel grid + real floor heights, as the server loads it
    const dir = path.join(ROOT, 'public', 'maps', name), json = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')), surf = path.join(dir, 'surfaces.json');
    map = { ...json, grid: { ...json.grid, bits: new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'grid.bin.gz')))) },
      surfaces: fs.existsSync(surf) ? JSON.parse(fs.readFileSync(surf, 'utf8')) : undefined };
  }
  const demo = recordDemo(map, rounds), dst = path.join(ROOT, 'public', 'demos', `${out}.json.gz`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, zlib.gzipSync(JSON.stringify(demo)));
  console.log(`${dst}: ${demo.rounds.length} rounds, ${demo.frames.ticks.length} frames, ${demo.events.length} events, ${(fs.statSync(dst).size / 1024).toFixed(0)} KB`);
}
