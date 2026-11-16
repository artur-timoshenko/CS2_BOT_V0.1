// Footstep surface map of an imported map: per 32-unit cell, the walkable (upward-facing) surfaces — height and type —
// from the render glTF's material names. Written once, looked up per step in the viewer (raycasting the map is ~100 ms).
//   node --max-old-space-size=8192 tools/surface-map.js de_dust2   → public/maps/de_dust2/surfaces.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGltf, triangles, toSource } from './import-map.js';
import { NAMES, surfaceOf } from '../public/surfaces.js';

// tris: Source-space triangles (9 numbers each); mats: [material name, triangle count] runs in the same order.
export function surfaceMap(tris, mats, cell = 16, maxLayers = 6) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) { x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]); y0 = Math.min(y0, tris[i + 1]); y1 = Math.max(y1, tris[i + 1]); }
  x0 = Math.floor(x0 / cell) * cell; y0 = Math.floor(y0 / cell) * cell;
  const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1, cells = new Map();
  let t = 0;
  for (const [name, n] of mats) {
    const sid = NAMES.indexOf(surfaceOf(name));
    for (let end = t + n; t < end; t++) {
      const o = t * 9, ax = tris[o], ay = tris[o + 1], az = tris[o + 2], bx = tris[o + 3] - ax, by = tris[o + 4] - ay, bz = tris[o + 5] - az;
      const cx = tris[o + 6] - ax, cy = tris[o + 7] - ay, cz = tris[o + 8] - az;
      const nxv = by * cz - bz * cy, nyv = bz * cx - bx * cz, nzv = bx * cy - by * cx, len = Math.hypot(nxv, nyv, nzv);
      if (!len || Math.abs(nzv) / len < 0.6) continue; // walls and steep faces are not walked on (either winding)
      const add = (k, z) => {
        const layers = cells.get(k) || [];
        const same = layers.find(l => Math.abs(l[0] - z) < 24); // one layer per floor: the top face wins
        if (same) { if (z > same[0]) { same[0] = z; same[1] = sid; } }
        else if (layers.length < maxLayers) layers.push([z, sid]);
        cells.set(k, layers);
      };
      // like a ray straight down at each cell centre: cells whose centre lies in the triangle, at the plane's height there
      const det = bx * cy - by * cx;
      const i0 = Math.floor((Math.min(ax, ax + bx, ax + cx) - x0) / cell), i1 = Math.floor((Math.max(ax, ax + bx, ax + cx) - x0) / cell);
      const j0 = Math.floor((Math.min(ay, ay + by, ay + cy) - y0) / cell), j1 = Math.floor((Math.max(ay, ay + by, ay + cy) - y0) / cell);
      let hit = false;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell - ax, py = y0 + (j + 0.5) * cell - ay;
        const u = (px * cy - py * cx) / det, v = (bx * py - by * px) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        add(i + nx * j, az + u * bz + v * cz); hit = true;
      }
      if (!hit) { // smaller than a cell: its centroid's cell
        const gx = ax + (bx + cx) / 3, gy = ay + (by + cy) / 3;
        add(Math.floor((gx - x0) / cell) + nx * Math.floor((gy - y0) / cell), az + (bz + cz) / 3);
      }
    }
  }
  return { cell, origin: [x0, y0], dims: [nx, ny], surfaces: NAMES,
    cells: [...cells].map(([k, l]) => [k, ...l.flatMap(([z, s]) => [Math.round(z), s])]) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) { console.log('usage: node --max-old-space-size=8192 tools/surface-map.js <imported map name>'); process.exit(1); }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maps', name);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')), t0 = Date.now(), mats = [];
  const raw = triangles(readGltf(path.join(map.srcDir, map.render.replace(/^src\//, ''))), undefined, mats);
  const sm = surfaceMap(toSource(raw, { scale: map.renderScale }).tris, mats);
  fs.writeFileSync(path.join(dir, 'surfaces.json'), JSON.stringify(sm));
  const count = {}; for (const c of sm.cells) for (let k = 2; k < c.length; k += 2) count[sm.surfaces[c[k]]] = (count[sm.surfaces[c[k]]] || 0) + 1;
  console.log(`${name}/surfaces.json: ${sm.cells.length} cells, ${JSON.stringify(count)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
