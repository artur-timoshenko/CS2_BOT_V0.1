// Footstep surfaces. CS2 map exports carry no physics surface property, so the type comes from the material's own name
// (not its folder: dust_windows/dust_window_bars_metal is metal). Shared by tools/surface-map.js and the viewer.
export const SURFACES = [[/glass|windows/, 'glass'], [/grate|vent/, 'metal_grate'],
  [/metal|corrugated|trap_door|garbage|dumpster|oil_drum|propane|electric|ac_unit|car_wreck|300d|r5_|flatbed|truck|satellite|rollupdoor/, 'metal'],
  [/wood|crate|pallet|shelf|door|ladder|cart|basket/, 'wood'], [/tile|brick_ground/, 'tile'], [/sand|mudbrick_piles/, 'sand'],
  [/groundrough|groundsmooth|groundsweeds|weeds|dirt/, 'dirt'], [/rock|gravel|stone_ground|groundstone/, 'gravel'],
  [/awning|fabric|cloth|tarp|sacks/, 'carpet']];
export const NAMES = ['concrete', ...new Set(SURFACES.map(s => s[1]))];

export function surfaceOf(material = '') {
  const n = material.toLowerCase().split('/').pop();
  return (SURFACES.find(([re]) => re.test(n)) || [0, 'concrete'])[1];
}

// Surface under the feet from a surfaces.json map: the highest layer at most a step above the feet and at most 40 below
// (the voxel floor sits up to a voxel above the visible one). Falls back to concrete.
export function surfaceAt(sm, [x, y, z]) {
  if (!sm) return 'concrete';
  const i = Math.floor((x - sm.origin[0]) / sm.cell), j = Math.floor((y - sm.origin[1]) / sm.cell);
  if (i < 0 || j < 0 || i >= sm.dims[0] || j >= sm.dims[1]) return 'concrete';
  sm.index ||= new Map(sm.cells.map(c => [c[0], c]));
  const c = sm.index.get(i + sm.dims[0] * j);
  let best = -Infinity, s = 'concrete';
  for (let k = 1; c && k < c.length; k += 2) if (c[k] <= z + 12 && c[k] >= z - 40 && c[k] > best) { best = c[k]; s = sm.surfaces[c[k + 1]]; }
  return s;
}
