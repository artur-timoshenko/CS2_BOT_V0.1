// CS2 sound events (soundevents/game_sounds_*.vsndevts, decompiled with Source2Viewer) → <Maps>/sounds/soundevents.json:
// how far and how loud the game plays each sound. Per event: volume, the distance → volume curve
// (distance_volume_mapping_curve: [units, volume] points), cut-off distance, occlusion intensity (how much walls muffle
// it), reverb, and child events played with it (a gunshot's distant layer). byFile: sound file → the event that plays it,
// keyed by "<folder>/<name>" (e.g. "ak47/ak47_01", "footsteps/concrete_ct_01").
//   node tools/import-soundevents.js <dir with *.vsndevts> [<Maps>/sounds/soundevents.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKV3 } from './import-weapons.js';

export const fileKey = p => p.replace(/\\/g, '/').replace(/\.[^./]+$/, '').split('/').slice(-2).join('/').toLowerCase();

export function soundEvents(texts) {
  const all = Object.assign({}, ...texts.map(parseKV3));
  const resolve = (name, seen = new Set()) => { // "base" inheritance, if an event uses it
    const e = all[name];
    if (!e || seen.has(name)) return e || {};
    seen.add(name);
    return typeof e.base === 'string' ? { ...resolve(e.base, seen), ...e } : e;
  };
  const events = {}, byFile = {};
  for (const name of Object.keys(all)) {
    const e = resolve(name);
    if (!e || typeof e !== 'object') continue;
    const curve = e.use_distance_volume_mapping_curve !== false && Array.isArray(e.distance_volume_mapping_curve)
      ? e.distance_volume_mapping_curve.filter(p => Array.isArray(p) && p.length >= 2).map(p => [+p[0], +p[1]]) : [];
    const files = Object.keys(e).filter(k => /^vsnd_files/.test(k)).flatMap(k => [].concat(e[k])).filter(f => typeof f === 'string');
    const children = Object.keys(e).filter(k => /^soundevent_\d+$/.test(k)).flatMap(k => [].concat(e[k])).filter(c => typeof c === 'string');
    events[name] = { volume: +(e.volume ?? 1), ...(curve.length && { curve }), ...(e.broadcast_distance_override && { max: +e.broadcast_distance_override }),
      occlusion: +(e.occlusion_intensity ?? 0), reverb: +(e.reverb_wet ?? 0), ...(children.length && { children }) };
    for (const f of files) byFile[fileKey(f)] ??= name;
  }
  return { events, byFile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.log('usage: node tools/import-soundevents.js <dir with *.vsndevts> [out.json]'); process.exit(1); }
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.vsndevts'));
  const se = soundEvents(list.map(f => fs.readFileSync(path.join(dir, f), 'utf8')));
  const dst = out || path.join(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/models/models.json'), 'utf8')).srcDir, 'sounds/soundevents.json');
  fs.writeFileSync(dst, JSON.stringify(se));
  const withCurve = Object.values(se.events).filter(e => e.curve).length;
  console.log(`${dst}: ${Object.keys(se.events).length} events (${withCurve} with a distance curve), ${Object.keys(se.byFile).length} files`);
  for (const n of ['Weapon_AK47.Single', 'Weapon_AK47.SingleDistant', 'Weapon_AK47.Clipout']) console.log(n, JSON.stringify(se.events[n]));
}
