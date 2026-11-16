// Builds the viewer's weapon folder from the raw Source2Viewer exports: one folder per CS2 weapon, named by its internal
// name (as in sim/weapons-cs2.js, the HUD icons and demos), plus an index:
//
//   <Maps>/weapons/index.json            name → { model, anims, shot, distant, reload, shell, nade } (paths relative to weapons/)
//   <Maps>/weapons/<name>/model.glb      the weapon (HD body only), textures next to it
//   <Maps>/weapons/<name>/textures/      <material>_color.png, _normal.png, _orm.png
//   <Maps>/weapons/<name>/anims.glb      the agents' clips for this weapon: world draw/reload/…, viewmodel vm_idle/vm_shoot1/…
//   <Maps>/weapons/<name>/sounds/        shot_01.wav…, distant_01.wav…
//
// Raw inputs (kept for rebuilding) live in <Maps>/_source: weapons/gltf (new export), weapons/old_export (AK, Glock),
// sounds/weapons (decompiled from pak01_dir.vpk). Agents' full exports: models/agents/models/<agent>/<agent>.gltf.
//   node --max-old-space-size=8192 tools/build-weapons.js [--maps D:/.../Maps] [--only deagle,nova]
// then shrink the textures (4096² HD maps → 2048²):  py tools/shrink-textures.py <Maps>/weapons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGltf } from './import-map.js';
import { packModel, glb } from './pack-model.js';
import { CS2_WEAPONS } from '../sim/weapons-cs2.js';
import { fileKey } from './import-soundevents.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NONE = /(?!)/; // keep no animations

// Shot sounds per weapon: folder in sounds/weapons, shot files, distant files (regex on the base name).
const SOUNDS = {
  ak47: ['ak47', /^ak47_0\d$/, /^ak47_distant$/], aug: ['aug', /^aug_0\d$/, /^aug_distant$/], awp: ['awp', /^awp_0\d$/, /^awp_distant$/],
  bizon: ['bizon', /^bizon_0\d$/, /^bizon-1-distant$/], cz75a: ['cz75a', /^cz75_0\d$/, /^cz75a-1-distant$/],
  deagle: ['deagle', /^deagle_0\d$/, /^deagle-1-distant$/], elite: ['elite', /^elites_0\d$/, /^elite-1-distant$/],
  famas: ['famas', /^famas_0\d$/, /^famas_distant_\d+$/], fiveseven: ['fiveseven', /^fiveseven_0\d$/, /^fiveseven-1-distant$/],
  g3sg1: ['g3sg1', /^g3sg1_0\d$/, /^g3sg1_distant_\d+$/], galilar: ['galilar', /^galil_0\d$/, /^galil_distant$/],
  glock: ['glock18', /^glock_0\d$/, /^glock18-1-distant$/], hkp2000: ['hkp2000', /^hkp2000_0\d$/, /^hkp2000-1-distant$/],
  m249: ['m249', /^m249_0\d$/, /^m249-1-distant$/], m4a1: ['m4a1', /^m4a1_0\d$/, /^m4a1_distant_\d+$/],
  m4a1_silencer: ['m4a1', /^m4a1_us_0\d$/, /^m4a1_us_distant(_\d+)?$/], mac10: ['mac10', /^mac10_0\d$/, /^mac10-1-distant$/],
  mag7: ['mag7', /^mag7_0\d$/, /^mag7_distant_\d+$/], mp5sd: ['mp5', /^mp5_0\d$/, null], mp7: ['mp7', /^mp7_0\d$/, /^mp7-1-distant$/],
  mp9: ['mp9', /^mp9_0\d$/, /^mp9-1-distant$/], negev: ['negev', /^negev_0\d$/, /^negev-1-distant$/],
  nova: ['nova', /^nova-1$/, /^nova-1-distant$/], p250: ['p250', /^p250_0\d$/, /^p250_distant_\d+$/],
  p90: ['p90', /^p90_0\d$/, /^p90-1-distant$/], revolver: ['revolver', /^revolver-1_0\d$/, /^revolver-1_distant$/],
  sawedoff: ['sawedoff', /^sawedoff-1$/, /^sawedoff-1-distant$/], scar20: ['scar20', /^scar20_0\d$/, /^scar20_distant_\d+$/],
  sg556: ['sg556', /^sg556_0\d$/, /^sg556_distant$/], ssg08: ['ssg08', /^ssg08_0\d$/, /^ssg08_distant$/],
  taser: ['taser', /^taser_shoot$/, null], tec9: ['tec9', /^tec9_0\d$/, /^tec9_distant_\d+$/],
  ump45: ['ump45', /^ump45_0\d$/, /^ump45-1-distant$/], usp_silencer: ['usp', /^usp_0\d$/, null],
  xm1014: ['xm1014', /^xm1014-1$/, /^xm1014-1-distant$/], knife: ['knife', /^knife_swish_light_0\d$/, null],
};

// Reload sounds: role by file name → moment in the reload (fraction of its length). CS2 times them with animation events
// we don't have. shortcut: fixed fractions per role (mag out ~20%, in ~55%, bolt ~85%); tune per weapon if it sounds off.
const RELOAD_ROLES = [
  ['coverup', /coverup/, 0.1], ['release', /cliprelease/, 0.15], ['out', /clip_?out|boxout|magout/, 0.2], ['in', /clip_?in|boxin|magin/, 0.55],
  ['hit', /cliphit/, 0.62], ['chain', /chain/, 0.66], ['coverdown', /coverdown/, 0.76], ['back', /boltback|slideback|sideback|pump_back/, 0.8],
  ['forward', /boltforward|sliderelease|slideforward|siderelease|pump_forward|boltpull/, 0.88], ['pump', /_pump$/, 0.9],
];
const SKIP_RELOAD = /silencer|draw|distant|inspect|lookat|special|element|zoom|jangle|catch|prepare|hammer/;
// Grenade sounds: folder + base-name regex per event ([folder, regex] borrows from another grenade's folder).
const NADE_SOUNDS = {
  hegrenade: { pin: /^pinpull$/, throw: /^grenade_throw$/, bounce: /^he_bounce-1$/, detonate: /^hegrenade_detonate_\d+$/, distant: /^hegrenade_distant_detonate_\d+$/ },
  flashbang: { pin: /^pinpull$/, throw: /^grenade_throw$/, bounce: /^grenade_hit1$/, detonate: /^flashbang_explode\d$/, distant: /^flashbang_explode\d_distant$/, ring: /^explosion_ring$/ },
  smokegrenade: { pin: /^pinpull$/, throw: /^grenade_throw$/, bounce: /^grenade_hit1$/, detonate: /^smoke_emit$/, distant: /^sg_explode_distant$/ },
  molotov: { throw: /^molotov_throw_0\d$/, detonate: /^molotov_detonate_\d$/, distant: /^molotov_detonate_\d_distant$/, air: /^molotov_detonate_air_01$/, fire: /^fire_loop_1$/, extinguish: /^molotov_extinguish$/ },
  incgrenade: { pin: /^pinpull$/, throw: /^inc_grenade_throw$/, bounce: /^inc_grenade_bounce_m$/, detonate: /^inc_grenade_detonate_\d$/, distant: /^inc_grenade_detonate_\d_distant$/,
    air: /^inc_grenade_detonate_air_01$/, fire: ['molotov', /^fire_loop_1$/], extinguish: ['molotov', /^molotov_extinguish$/] },
  decoy: { pin: /^pinpull$/, throw: /^grenade_throw$/, bounce: ['flashbang', /^grenade_hit1$/] },
  // the bomb: code keys while planting, placed, beeps (the "10sec" ones in the last seconds), defuse, explosion
  c4: { key: /^key_press\d$/, plant: /^c4_plant$/, beep: /^c4_beep2$/, beep10: /^c4_beep2_10sec$/, disarmstart: /^c4_disarmstart$/,
    disarmfinish: /^c4_disarmfinish$/, explode: /^c4_explode1$/, debris: /^c4_exp_deb\d$/ },
};

// Animation folder names that don't follow the weapon's name (anims/<world|viewmodel>/<class>/<folder>/). Tried in order;
// the agents have no viewmodel set of their own for the USP-S and M4A1-S, so those borrow the P2000's and the M4A4's.
const ANIM_ALIAS = {
  ak47: ['ak'], scar20: ['scar20', 'scar'], glock: ['glock', 'glock18'], m4a1: ['m4a4'], m4a1_silencer: ['m4a1_silencer', 'm4a4'],
  usp_silencer: ['usp', 'hkp2000'], knife: ['default_ct', 'knife_default_t'], knife_t: ['default_t', 'knife_default_t'],
  incgrenade: ['incendiary'], decoy: ['decoy', 'hegrenade'], // no decoy set: the HE's throw
};
const SKIP_CLIP = /inspect|ui_|silent|silencer_(attach|detach)|keychain/; // lookat01/02 = the inspect (F) clips

// "weapons/models/knife/knife_karambit/weapon_knife_karambit.vmdl" → folder "knife_karambit", stem "karambit"
function names(w) {
  const parts = w.model.replace(/\.vmdl$/, '').split('/'), dir = parts[parts.length - 2], file = parts[parts.length - 1];
  return { rel: parts.slice(2).join('/') + '.gltf', dir, stem: file.replace(/^weapon_/, '').replace(/^(rif|pist|snip|smg|shot|mach|knife)_/, '') };
}

// Clips of one weapon from the agent's animation list: "anims/viewmodel/pistol/pistol_deagle/shoot1_deagle" → "vm_shoot1".
export function weaponClips(w, animNames) {
  const { dir, stem } = names(w), cands = [...(ANIM_ALIAS[w.name] || []), w.name, dir, stem];
  const out = new Map();
  for (const side of ['world', 'viewmodel']) {
    const re = new RegExp(`/anims/${side}/([^/]+)/([^/]+)/([^/]+)$`), folders = new Map();
    for (const n of animNames) {
      const m = n.match(re);
      if (m && !m[2].startsWith('_default')) (folders.get(m[2]) || folders.set(m[2], []).get(m[2])).push([n, m[3]]);
    }
    const c = cands.find(c => [...folders.keys()].some(f => f === c || f.endsWith('_' + c)));
    const folder = c && [...folders.keys()].find(f => f === c || f.endsWith('_' + c));
    // the weapon suffix: the folder's name ("default_ct", "knife_default_t" → "default_t") or else the last word ("_m4a1s")
    const tails = folder ? [folder, folder.slice(folder.indexOf('_') + 1)] : [];
    for (const [full, base] of folder ? folders.get(folder) : []) {
      if (SKIP_CLIP.test(base)) continue;
      const tail = tails.find(t => base.endsWith('_' + t)), cut = tail ? base.length - tail.length - 1 : base.lastIndexOf('_');
      const action = (cut > 0 ? base.slice(0, cut) : base).replace(/_+/g, '_');
      const key = (side === 'viewmodel' ? 'vm_' : '') + action;
      if (!out.has(key)) out.set(key, full);
    }
  }
  return out; // key → full clip name
}

// Drops the legacy (CS:GO) body when an HD one exists, then everything only it used.
function pruneModel(json) {
  const hd = (json.meshes || []).some(m => /body_hd$/.test(m.name || ''));
  const keep = (json.meshes || []).map(m => !(hd && /body_legacy$/.test(m.name || '')));
  const meshMap = new Map(); let k = 0;
  keep.forEach((y, i) => y && meshMap.set(i, k++));
  json.meshes = json.meshes.filter((_, i) => keep[i]);
  for (const n of json.nodes || []) if (n.mesh != null) { if (meshMap.has(n.mesh)) n.mesh = meshMap.get(n.mesh); else delete n.mesh; }
  const remap = (list, used) => { const map = new Map([...used].sort((a, b) => a - b).map((o, i) => [o, i])); return [list.filter((_, i) => used.has(i)), map]; };
  const usedMat = new Set(json.meshes.flatMap(m => m.primitives.map(p => p.material).filter(x => x != null)));
  const [materials, matMap] = remap(json.materials || [], usedMat);
  json.meshes.forEach(m => m.primitives.forEach(p => { if (p.material != null) p.material = matMap.get(p.material); }));
  const texRefs = mat => [mat.pbrMetallicRoughness?.baseColorTexture, mat.pbrMetallicRoughness?.metallicRoughnessTexture, mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture].filter(Boolean);
  const usedTex = new Set(materials.flatMap(m => texRefs(m).map(t => t.index)));
  const [textures, texMap] = remap(json.textures || [], usedTex);
  materials.forEach(m => texRefs(m).forEach(t => (t.index = texMap.get(t.index))));
  const usedImg = new Set(textures.map(t => t.source));
  const [images, imgMap] = remap(json.images || [], usedImg);
  textures.forEach(t => (t.source = imgMap.get(t.source)));
  Object.assign(json, { materials, textures, images });
  return json;
}

// Copies the model's textures into textures/<material>_<role>.png and points the images there.
function moveTextures(json, srcDir, outDir) {
  const role = new Map(); // image → readable name
  for (const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {}, name = (m.name || 'material').replace(/[^\w-]/g, '_');
    for (const [r, t] of [['color', pbr.baseColorTexture], ['orm', pbr.metallicRoughnessTexture], ['normal', m.normalTexture], ['orm', m.occlusionTexture], ['emissive', m.emissiveTexture]]) {
      const img = t && json.textures[t.index]?.source;
      if (img != null && !role.has(img)) role.set(img, `${name}_${r}`);
    }
  }
  fs.mkdirSync(path.join(outDir, 'textures'), { recursive: true });
  json.images.forEach((im, i) => {
    if (!im.uri) return; // embedded
    const src = path.join(srcDir, decodeURIComponent(im.uri)), ext = path.extname(im.uri) || '.png', file = `textures/${role.get(i) || 'image_' + i}${ext}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, file));
    else console.warn(`  missing texture ${src}`);
    im.uri = file;
  });
}

const base = f => f.replace(/\.\w+$/, '');
const audio = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(wav|mp3)$/i.test(f)).sort() : []);
// copies files from src into <outDir>/sounds/<prefix>_01.wav…; returns their paths relative to weapons/ (index.json).
// ORIGINS: copied path → the game file's "<folder>/<name>", to find its CS2 sound event (tools/import-soundevents.js)
const ORIGINS = {};
function copyAs(name, src, outDir, files, prefix) {
  return files.map((f, i) => {
    const out = `sounds/${prefix}_${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`;
    fs.mkdirSync(path.join(outDir, 'sounds'), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(outDir, out));
    ORIGINS[`${path.basename(outDir)}/${out}`] = fileKey(path.join(src, f));
    return `${path.basename(outDir)}/${out}`;
  });
}

function copySounds(name, srcRoot, outDir) {
  const s = SOUNDS[name];
  if (!s) return { shot: [], distant: [] };
  const [dir, shotRe, farRe] = s, src = path.join(srcRoot, dir), files = audio(src);
  if (!files.length) { console.warn(`  no sounds in ${src}`); return { shot: [], distant: [] }; }
  const take = (re, prefix) => copyAs(name, src, outDir, files.filter(f => re && re.test(base(f))), prefix);
  return { shot: take(shotRe, 'shot'), distant: take(farRe, 'distant') };
}

// reload: [{ at: fraction of the reload, files }] in order; shell: one per loaded shell (shotguns)
function reloadSounds(name, srcRoot, outDir) {
  const s = SOUNDS[name], src = s && path.join(srcRoot, s[0]), files = src ? audio(src).filter(f => !SKIP_RELOAD.test(base(f))) : [];
  const shells = files.filter(f => /insertshell/.test(base(f))), reload = [];
  for (const [role, re, at] of RELOAD_ROLES) {
    let pick = files.filter(f => re.test(base(f)));
    if (!pick.length && role === 'in' && !shells.length) pick = files.filter(f => /addammo/.test(base(f))); // AK & co: the mag-in is "addammo"
    if (pick.length) reload.push({ at, files: copyAs(name, src, outDir, pick, `reload_${role}`) });
  }
  return { reload, shell: copyAs(name, src, outDir, shells, 'reload_shell') };
}

// draw: the weapon's own deploy sound(s), else CS2's generic weapon movement; inspect: [{ t: seconds, files }] — CS2 names
// these files after the animation frame they play on ("ak47_inspect_f013", "deagle_special_lookat_f036"), clips run at 30 fps
function handlingSounds(name, srcRoot, outDir, melee) {
  const dir = melee ? 'knife' : SOUNDS[name]?.[0] ?? (NADE_SOUNDS[name] ? name : null), src = dir && path.join(srcRoot, dir), files = src ? audio(src) : [];
  let draw = copyAs(name, src, outDir, files.filter(f => /draw/.test(base(f))), 'draw');
  if (!draw.length) draw = copyAs(name, srcRoot, outDir, audio(srcRoot).filter(f => /^movement\d$/.test(base(f))), 'draw');
  const inspect = files.map(f => [f, base(f).match(/(?:inspect|lookat)_f(\d+)$/)]).filter(([, m]) => m)
    .map(([f, m], i) => ({ t: +m[1] / 30, files: copyAs(name, src, outDir, [f], `inspect_${String(i + 1).padStart(2, '0')}`) }));
  return { draw, inspect };
}

// grenade events → files: pin, throw, bounce, detonate, distant, air, fire, ring, extinguish
function nadeSounds(name, srcRoot, outDir) {
  const out = {};
  for (const [ev, spec] of Object.entries(NADE_SOUNDS[name] || {})) {
    const [dir, re] = Array.isArray(spec) ? spec : [name, spec], src = path.join(srcRoot, dir);
    out[ev] = copyAs(name, src, outDir, audio(src).filter(f => re.test(base(f))), ev);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const maps = opt('--maps', JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/models.json'), 'utf8')).srcDir);
  const only = opt('--only', null)?.split(',');
  const src = path.join(maps, '_source'), out = path.join(maps, 'weapons'), modelRoots = [path.join(src, 'weapons/gltf'), path.join(src, 'weapons/old_export')];
  const indexFile = path.join(out, 'index.json'), index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  const list = CS2_WEAPONS.filter(w => w.model && (!only || only.includes(w.name)));

  const soundsOnly = args.includes('--sounds'); // only re-copy sounds: models, textures (already shrunk) and anims stay
  const keepModels = soundsOnly || args.includes('--anims'); // --anims: animations + sounds, models/textures stay
  let agent = null, animNames = [], bones = null;
  if (!soundsOnly) {
    console.log('reading the agent animations (≈1 GB)…');
    agent = readGltf(path.join(maps, 'models/agents/models/tm_phoenix/tm_phoenix.gltf')); // both agents have the same clips and skeleton
    animNames = agent.json.animations.map(a => a.name);
    bones = { ...agent.json, meshes: [], skins: [], materials: [], textures: [], images: [], samplers: [],
      nodes: agent.json.nodes.map(({ mesh, skin, ...n }) => n) }; // skeleton only: the clips bind to the agent's bones by name
  }

  for (const w of list) {
    const dst = path.join(out, w.name), entry = { model: null, anims: null, shot: [], distant: [] };
    fs.mkdirSync(dst, { recursive: true });
    if (keepModels) Object.assign(entry, { model: index[w.name]?.model ?? null, anims: index[w.name]?.anims ?? null });
    // model
    const { rel } = names(w), file = !keepModels && modelRoots.map(r => path.join(r, rel)).find(f => fs.existsSync(f));
    if (keepModels) { /* kept */ } else if (file) {
      const { json, bufs } = readGltf(file);
      pruneModel(json);
      moveTextures(json, path.dirname(file), dst);
      const packed = packModel({ json, bufs }, NONE);
      fs.writeFileSync(path.join(dst, 'model.glb'), glb(packed.json, packed.bin));
      entry.model = `${w.name}/model.glb`;
    } else console.warn(`${w.name}: no model (${rel})`);
    // animations
    const clips = soundsOnly ? new Map() : weaponClips(w, animNames);
    if (clips.size) {
      const byName = new Map(agent.json.animations.map(a => [a.name, a]));
      const animations = [...clips].map(([key, full]) => ({ ...byName.get(full), name: key }));
      const packed = packModel({ json: { ...bones, animations }, bufs: agent.bufs }, /./);
      fs.writeFileSync(path.join(dst, 'anims.glb'), glb(packed.json, packed.bin));
      entry.anims = `${w.name}/anims.glb`;
    }
    // sounds (every knife swings like the default one)
    const sroot = path.join(src, 'sounds/weapons');
    Object.assign(entry, copySounds(w.melee ? 'knife' : w.name, sroot, path.join(out, w.melee ? 'knife' : w.name)));
    if (w.mag) Object.assign(entry, reloadSounds(w.name, sroot, dst));
    if (NADE_SOUNDS[w.name]) entry.nade = nadeSounds(w.name, sroot, dst);
    Object.assign(entry, handlingSounds(w.name, sroot, dst, w.melee));
    index[w.name] = entry;
    const extra = entry.nade ? `  nade ${Object.entries(entry.nade).map(([k, v]) => `${k}:${v.length}`).join(' ')}`
      : entry.reload ? `  reload ${entry.reload.length}${entry.shell.length ? ' +shell' : ''}` : '';
    console.log(`${w.name.padEnd(22)} model ${entry.model ? 'ok' : '—'}  anims ${clips.size}  shot ${entry.shot.length}  distant ${entry.distant.length}${extra}`);
  }
  fs.writeFileSync(indexFile, JSON.stringify(Object.fromEntries(Object.entries(index).sort()), null, 1));
  const originsFile = path.join(out, 'origins.json'), old = fs.existsSync(originsFile) ? JSON.parse(fs.readFileSync(originsFile, 'utf8')) : {};
  fs.writeFileSync(originsFile, JSON.stringify({ ...old, ...ORIGINS }));
  console.log(`${indexFile}: ${Object.keys(index).length} weapons`);
}
