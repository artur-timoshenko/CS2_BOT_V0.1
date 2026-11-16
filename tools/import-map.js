// Imports a real map exported from your own CS2 install (Source2Viewer → glTF/GLB) into the arena:
// voxelizes the geometry for collision/bullets and writes map.json + grid.bin.gz next to the file.
//
//   node tools/import-map.js D:/maps/de_dust2.gltf --name de_dust2 --t X,Y,Z --ct X,Y,Z
//        [--collision phys.glb] [--voxel 8] [--scale 39.37] [--skip sky] [--bounds x0,y0,z0,x1,y1,z1]
// Writes public/maps/<name>/{map.json,grid.bin.gz}; the export itself is not copied.
//
// --t / --ct: any point in each spawn, e.g. from `getpos` in CS2 (snapped down to the floor).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { hullHit, STAND_H } from '../sim/core.js';

const COMP = { 5126: ['getFloat32', 4], 5125: ['getUint32', 4], 5123: ['getUint16', 2], 5121: ['getUint8', 1] };

export function readGltf(file) {
  const raw = fs.readFileSync(file), dir = path.dirname(file);
  let json, bin;
  if (raw.readUInt32LE(0) === 0x46546c67) { // 'glTF' binary
    const jsonLen = raw.readUInt32LE(12);
    json = JSON.parse(raw.subarray(20, 20 + jsonLen).toString());
    if (raw.length > 20 + jsonLen) bin = raw.subarray(28 + jsonLen, 28 + jsonLen + raw.readUInt32LE(20 + jsonLen));
  } else json = JSON.parse(raw.toString());
  const bad = (json.extensionsRequired || []).filter(e => /draco|meshopt|quantiz/i.test(e));
  if (bad.length) throw new Error(`compressed glTF not supported (${bad}); export without compression`);
  const bufs = (json.buffers || []).map(b => !b.uri ? bin
    : b.uri.startsWith('data:') ? Buffer.from(b.uri.split(',')[1], 'base64') : fs.readFileSync(path.join(dir, decodeURIComponent(b.uri))));
  return { json, bufs };
}

function readAccessor({ json, bufs }, idx) {
  const a = json.accessors[idx], bv = json.bufferViews[a.bufferView], buf = bufs[bv.buffer];
  const n = { SCALAR: 1, VEC3: 3 }[a.type], [get, size] = COMP[a.componentType];
  const stride = bv.byteStride || n * size, base = buf.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(buf.buffer), out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = dv[get](base + i * stride + c * size, true);
  return out;
}

function trs(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r, [sx, sy, sz] = s;
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, ...t, 1];
}
const mul = (a, b) => Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[k * 4 + (i % 4)] * b[(i >> 2) * 4 + k], 0));

// Non-solid in CS2: effect cards (dust/steam/light shafts), tool meshes, dev black fillers, overlays/decals (alpha BLEND),
// wires and foliage leaves. Matched against "node mesh material shader alpha:MODE" of each primitive.
export const SKIP_DEFAULT = 'sky|csgo_effects|\\bgeneric\\.vfx|black_unlit|static_overlay|alpha:BLEND|dust_wire|palm_frond|agave|sagebrush|sumac|dust_weeds|weeds_cressa|grape_leaves|olive_branch|zebra_grass';

// World-space triangles in glTF units (flat [x,y,z]*3 per tri), skipping primitives whose description matches `skip`.
// mats (optional): receives [material name, triangle count] per primitive, in output order.
export function triangles(gltf, skip = new RegExp(SKIP_DEFAULT, 'i'), mats = null) {
  const { json } = gltf, chunks = [];
  const visit = (ni, parent) => {
    const node = json.nodes[ni], m = mul(parent, node.matrix || trs(node.translation, node.rotation, node.scale));
    const mesh = node.mesh != null ? json.meshes[node.mesh] : null;
    for (const prim of mesh?.primitives || []) {
      const mat = json.materials?.[prim.material] || {};
      if (skip.test(`${node.name} ${mesh.name} ${mat.name} ${mat.extras?.vmat?.ShaderName} alpha:${mat.alphaMode || 'OPAQUE'}`)) continue;
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION == null) continue;
      const pos = readAccessor(gltf, prim.attributes.POSITION);
      const idx = prim.indices != null ? readAccessor(gltf, prim.indices) : pos.map((_, i) => i).slice(0, pos.length / 3);
      const out = new Float64Array(idx.length * 3);
      idx.forEach((i, k) => {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        out[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      });
      chunks.push(out);
      mats?.push([mat.extras?.vmat?.Name || mat.name || '', idx.length / 3]);
    }
    for (const c of node.children || []) visit(c, m);
  };
  const I = trs();
  for (const ni of json.scenes[json.scene || 0].nodes) visit(ni, I);
  const all = new Float64Array(chunks.reduce((s, c) => s + c.length, 0));
  chunks.reduce((o, c) => (all.set(c, o), o + c.length), 0);
  return all;
}

// Source2Viewer writes glTF as (y, z, x) of Source coordinates, in meters (auto-detected by map extent).
export function toSource(tris, { scale } = {}) {
  if (!scale) {
    let ext = 0;
    for (let c = 0; c < 3; c++) { let lo = Infinity, hi = -Infinity; for (let i = c; i < tris.length; i += 3) { lo = Math.min(lo, tris[i]); hi = Math.max(hi, tris[i]); } ext = Math.max(ext, hi - lo); }
    scale = ext < 1000 ? 1 / 0.0254 : 1;
  }
  const out = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    out[i] = tris[i + 2] * scale; out[i + 1] = tris[i] * scale; out[i + 2] = tris[i + 1] * scale;
  }
  return { tris: out, scale };
}

// SAT triangle/cube overlap over the 13 candidate axes.
function triBox(c, h, t, o) {
  const v = [0, 1, 2].map(k => [t[o + k * 3] - c[0], t[o + k * 3 + 1] - c[1], t[o + k * 3 + 2] - c[2]]);
  const e = [0, 1, 2].map(k => v[(k + 1) % 3].map((x, j) => x - v[k][j]));
  const X = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const axes = [...X, cross(e[0], e[1])];
  for (const ei of e) for (const x of X) axes.push(cross(ei, x));
  for (const a of axes) {
    const p = v.map(q => q[0] * a[0] + q[1] * a[1] + q[2] * a[2]), r = h * (Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]));
    if (Math.min(...p) > r || Math.max(...p) < -r) return false;
  }
  return true;
}

export function voxelize(tris, size = 8, bounds = null) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) { const c = i % 3; lo[c] = Math.min(lo[c], tris[i]); hi[c] = Math.max(hi[c], tris[i]); }
  if (bounds) for (let c = 0; c < 3; c++) { lo[c] = Math.max(lo[c], bounds[c]); hi[c] = Math.min(hi[c], bounds[c + 3]); }
  hi[2] += 128; // headroom above the highest surface (open sky)
  const origin = lo.map(v => Math.floor(v / size - 1) * size), dims = hi.map((v, c) => Math.ceil((v - origin[c]) / size) + 1);
  const cells = dims[0] * dims[1] * dims[2];
  if (cells > 4e9) throw new Error(`grid ${dims.join('x')} too big: crop with --bounds or raise --voxel`);
  const bits = new Uint8Array(Math.ceil(cells / 8)), h = size / 2;
  const cell = (v, c) => Math.max(0, Math.min(dims[c] - 1, Math.floor((v - origin[c]) / size)));
  outer: for (let o = 0; o < tris.length; o += 9) {
    const r0 = [], r1 = [];
    for (let c = 0; c < 3; c++) {
      const a = Math.min(tris[o + c], tris[o + 3 + c], tris[o + 6 + c]), b = Math.max(tris[o + c], tris[o + 3 + c], tris[o + 6 + c]);
      if (b < origin[c] || a > origin[c] + dims[c] * size) continue outer; // cropped away by --bounds
      r0.push(cell(a, c)); r1.push(cell(b, c));
    }
    if (r0[0] === r1[0] && r0[1] === r1[1] && r0[2] === r1[2]) { // tiny triangle: inside one cell, no SAT needed
      const i = r0[0] + dims[0] * (r0[1] + dims[1] * r0[2]); bits[i >> 3] |= 1 << (i & 7); continue;
    }
    for (let z = r0[2]; z <= r1[2]; z++) for (let y = r0[1]; y <= r1[1]; y++) for (let x = r0[0]; x <= r1[0]; x++) {
      const i = x + dims[0] * (y + dims[1] * z);
      if (bits[i >> 3] & (1 << (i & 7))) continue;
      if (triBox([origin[0] + (x + 0.5) * size, origin[1] + (y + 0.5) * size, origin[2] + (z + 0.5) * size], h, tris, o)) bits[i >> 3] |= 1 << (i & 7);
    }
  }
  return { origin, size, dims, bits };
}

// Drop a point onto the floor below it (hull fits, solid underneath). Returns feet position or null.
export function snapToFloor(map, x, y, z) {
  const g = map.grid;
  for (let k = Math.floor((z + 80 - g.origin[2]) / g.size); k >= 0 && g.origin[2] + k * g.size > z - 600; k--) {
    const fz = g.origin[2] + k * g.size + 0.01;
    if (!hullHit(map, x, y, fz, STAND_H) && hullHit(map, x, y, fz - 1, STAND_H)) return [x, y, fz];
  }
  return null;
}

export function makeSpawns(map, t, ct) {
  return [[t, ct], [ct, t]].map(([me, enemy], team) => {
    const yaw = Math.round(Math.atan2(enemy[1] - me[1], enemy[0] - me[0]) * 180 / Math.PI);
    const pts = [[0, 0], [64, 0], [-64, 0], [0, 64], [0, -64], [64, 64], [-64, -64]]
      .map(([dx, dy]) => snapToFloor(map, me[0] + dx, me[1] + dy, me[2])).filter(Boolean).slice(0, 5);
    if (!pts.length) throw new Error(`no floor under ${team ? 'CT' : 'T'} spawn ${me}: check coordinates / --scale`);
    return pts.map(p => [...p.map(v => Math.round(v * 100) / 100), yaw]);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), file = args[0]?.startsWith('--') ? null : args[0];
  const opt = k => { const i = args.indexOf(`--${k}`); return i < 0 ? undefined : args[i + 1]; };
  const nums = s => s?.split(',').map(Number);
  if (!file || !opt('t') || !opt('ct')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 10).join('\n')); process.exit(1); }
  const skip = new RegExp(opt('skip') || SKIP_DEFAULT, 'i');
  const t0 = Date.now();
  const raw = triangles(readGltf(opt('collision') || file), skip);
  const { tris, scale } = toSource(raw, { scale: Number(opt('scale')) || undefined });
  console.log(`${tris.length / 9} triangles, scale ${scale.toFixed(3)}`);
  const grid = voxelize(tris, Number(opt('voxel')) || 8, nums(opt('bounds')));
  const ext = grid.dims.map(d => d * grid.size);
  console.log(`grid ${grid.dims.join('x')} @ ${grid.size}u, origin ${grid.origin}, extent ${ext}`);
  const spawns = makeSpawns({ grid }, nums(opt('t')), nums(opt('ct')));
  // Output goes to the arena; the (large) export stays where it is and is served from srcDir.
  const name = opt('name') || path.basename(path.dirname(path.resolve(file)));
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maps', name);
  const inPlace = path.resolve(path.dirname(file)) === path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'grid.bin.gz'), zlib.gzipSync(grid.bits));
  fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify({ name, render: (inPlace ? '' : 'src/') + path.basename(file), renderScale: scale,
    srcDir: inPlace ? undefined : path.resolve(path.dirname(file)), grid: { origin: grid.origin, size: grid.size, dims: grid.dims }, spawns }, null, 1));
  console.log(`wrote ${dir}/map.json + grid.bin.gz in ${((Date.now() - t0) / 1000).toFixed(1)}s; spawns T ${JSON.stringify(spawns[0][0])} CT ${JSON.stringify(spawns[1][0])}`);
}
