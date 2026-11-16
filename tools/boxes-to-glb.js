// Writes a box map as a GLB laid out like a Source2Viewer export (meters, Y up, nested node transforms,
// plus a far "sky" node the importer must skip). Used to test the import pipeline without Valve files.
//   node tools/boxes-to-glb.js out.glb      (default: built-in sandstone map)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAP } from '../sim/map.js';

const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const T = [1, 2, 3]; // root node translation (meters) — vertices are stored pre-offset to exercise transforms

export function writeGlb(file, boxes = MAP.boxes) {
  const pos = [];
  for (const b of boxes) {
    const c = [[b[0], b[1], b[2]], [b[3], b[1], b[2]], [b[3], b[4], b[2]], [b[0], b[4], b[2]], [b[0], b[1], b[5]], [b[3], b[1], b[5]], [b[3], b[4], b[5]], [b[0], b[4], b[5]]];
    for (const [a, bb, cc, d] of FACES) for (const i of [a, bb, cc, a, cc, d]) {
      const [x, y, z] = c[i];
      pos.push(y * 0.0254 - T[0], z * 0.0254 - T[1], x * 0.0254 - T[2]); // Source2Viewer axis order (y, z, x)
    }
  }
  const bin = Buffer.from(new Float32Array(pos).buffer);
  const min = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2] }],
    nodes: [{ name: 'world', translation: T, children: [1] }, { name: 'geo', mesh: 0 }, { name: 'sky_dome', mesh: 0, translation: [500, 0, 0] }],
    meshes: [{ name: 'map', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.68, 0.45, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([header, jh, j, bh, bin]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeGlb(process.argv[2] || 'sandstone.glb');
