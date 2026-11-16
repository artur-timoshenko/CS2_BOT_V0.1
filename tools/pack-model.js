// Packs a Source2Viewer agent export (glTF + .bin with ~2000 animations, >1 GB) into a small GLB with only the
// animations the viewer plays. Textures stay external (relative URIs), so write the GLB next to the source PNGs.
//   node --max-old-space-size=8192 tools/pack-model.js <agent.gltf> [--out agent.glb] [--anims REGEX]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGltf } from './import-map.js';

// Same set as the ready-made tm_phoenix.glb: world locomotion/idle/reload/draw/shoot for AK, Glock and knife + viewmodel.
export const DEFAULT_ANIMS = new RegExp('^animation/anims/(' + [
  'world/(knife/_default_knife|pistol/_default_pistol|rifle/_default_rifle)/((run|walk|crouch)_(n|ne|e|se|s|sw|w|nw)|inair_stand|inair_crouch_stand|jump_stand)_(knife|pistol|rifle)',
  'world/(rifle/rifle_ak|pistol/pistol_glock|knife/default_ct|knife/default_t)/(idle|idle_crouch|reload|reload_crouch|draw|shoot)_(ak|glock|default_ct|default_t)',
  'world/knife/_default_knife/(frontswing|frontstab|frontswing_crouching)_knife',
  'viewmodel/(rifle/rifle_ak/(shoot1|reload|idle|draw)_ak|pistol/pistol_glock18/(shoot1|reload|idle|draw)_glock|knife/knife_default_(ct|t)/(heavy_miss1|light_hit1|light_miss1|draw|idle)_default_(ct|t))',
].join('|') + ')$');

export function packModel({ json, bufs }, keep = DEFAULT_ANIMS) {
  json = { ...json, animations: (json.animations || []).filter(a => keep.test(a.name || '')) };
  // Accessors still referenced by meshes, skins and the kept animations; everything else (the other 2000 clips) is dropped.
  const usedAcc = new Set(), add = i => i != null && usedAcc.add(i);
  for (const m of json.meshes || []) for (const p of m.primitives) {
    Object.values(p.attributes).forEach(add); add(p.indices);
    (p.targets || []).forEach(t => Object.values(t).forEach(add));
  }
  (json.skins || []).forEach(s => add(s.inverseBindMatrices));
  json.animations.forEach(a => a.samplers.forEach(s => { add(s.input); add(s.output); }));
  const accMap = new Map([...usedAcc].sort((a, b) => a - b).map((old, i) => [old, i]));

  const usedBv = new Set();
  for (const i of accMap.keys()) {
    const a = json.accessors[i];
    if (a.bufferView != null) usedBv.add(a.bufferView);
    if (a.sparse) { usedBv.add(a.sparse.indices.bufferView); usedBv.add(a.sparse.values.bufferView); }
  }
  (json.images || []).forEach(im => im.bufferView != null && usedBv.add(im.bufferView));
  const bvMap = new Map(), chunks = [], bufferViews = [];
  let offset = 0;
  for (const old of [...usedBv].sort((a, b) => a - b)) {
    const bv = json.bufferViews[old], src = bufs[bv.buffer];
    const data = src.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), pad = (4 - (offset % 4)) % 4;
    if (pad) chunks.push(Buffer.alloc(pad)), (offset += pad);
    const { buffer, byteOffset, ...rest } = bv;
    bvMap.set(old, bufferViews.length); bufferViews.push({ ...rest, buffer: 0, byteOffset: offset });
    chunks.push(data); offset += data.length;
  }
  const bin = Buffer.concat(chunks);
  const accessors = [...accMap.keys()].map(i => {
    const a = structuredClone(json.accessors[i]);
    if (a.bufferView != null) a.bufferView = bvMap.get(a.bufferView);
    if (a.sparse) { a.sparse.indices.bufferView = bvMap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = bvMap.get(a.sparse.values.bufferView); }
    return a;
  });
  const acc = i => (i == null ? i : accMap.get(i));
  const meshes = (json.meshes || []).map(m => ({ ...m, primitives: m.primitives.map(p => ({
    ...p, indices: acc(p.indices), attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, acc(v)])),
    ...(p.targets && { targets: p.targets.map(t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, acc(v)]))) }),
  })) }));
  const out = {
    ...json, meshes, accessors, bufferViews, buffers: [{ byteLength: bin.length }],
    skins: (json.skins || []).map(s => ({ ...s, inverseBindMatrices: acc(s.inverseBindMatrices) })),
    animations: json.animations.map(a => ({ ...a, samplers: a.samplers.map(s => ({ ...s, input: acc(s.input), output: acc(s.output) })) })),
    images: (json.images || []).map(im => (im.bufferView != null ? { ...im, bufferView: bvMap.get(im.bufferView) } : im)),
  };
  if (!out.images.length) delete out.images;
  return { json: out, bin };
}

export function glb(json, bin) {
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, b]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const outFile = opt('--out'), re = opt('--anims'), [inFile] = args;
  if (!inFile) { console.log('usage: node --max-old-space-size=8192 tools/pack-model.js <agent.gltf> [--out agent.glb] [--anims REGEX]'); process.exit(1); }
  const dst = outFile || inFile.replace(/\.gltf$/i, '') + '.glb';
  if (path.resolve(path.dirname(dst)) !== path.resolve(path.dirname(inFile))) console.warn('warning: textures are referenced relative to the GLB — keep it next to the source PNGs');
  const t0 = Date.now(), src = readGltf(inFile);
  const { json, bin } = packModel(src, re ? new RegExp(re) : DEFAULT_ANIMS);
  fs.writeFileSync(dst, glb(json, bin));
  console.log(`${dst}: ${json.animations.length}/${src.json.animations?.length || 0} animations, ${(fs.statSync(dst).size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
