// CS-style radar (minimap): an overview image built once from the map, then drawn each frame centred on the player,
// rotating with the view; teammates always, enemies only while spotted.

const CLEAR = 72, STEP = 18; // standing headroom; the highest step a walk takes (sv_stepsize)

// Overview of a voxel map: per cell (stride × stride voxel columns) the height of the highest floor reachable from the
// spawns by walking (steps ≤ 18 up, any drop down), NaN where none. Roofs, crate tops and walls stay unreachable, so
// tunnels and rooms show their floor instead of the roof above them. solid[c] = 1 where the cell has any geometry.
export function radarHeights(grid, starts, stride = Math.max(1, Math.round(8 / grid.size))) {
  const [nx, ny, nz] = grid.dims, s = grid.size, o = grid.origin, bits = grid.bits, nxy = nx * ny;
  const W = Math.floor(nx / stride), H = Math.floor(ny / stride), F = 6, clear = Math.ceil(CLEAR / s), up = Math.ceil(STEP / s);
  const floors = new Int16Array(W * H * F).fill(-1), solid = new Uint8Array(W * H); // floors: voxel z, highest first
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const c = cx + W * cy, col = cx * stride + nx * cy * stride;
    let empty = 0, n = 0; // above the grid counts as solid, as in the sim
    for (let k = nz - 1; k >= 0; k--) {
      const idx = col + nxy * k;
      if ((bits[idx >> 3] >> (idx & 7)) & 1) { solid[c] = 1; if (empty >= clear && n < F) floors[c * F + n++] = k + 1; empty = 0; }
      else empty++;
    }
  }
  const seen = new Uint8Array(W * H * F), queue = new Int32Array(W * H * F);
  let head = 0, tail = 0;
  for (const [x, y, z] of starts) { // the floor nearest each spawn's feet
    const cx = Math.floor((x - o[0]) / s / stride), cy = Math.floor((y - o[1]) / s / stride), kz = (z - o[2]) / s;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    let best = -1;
    for (let f = 0, c = cx + W * cy; f < F && floors[c * F + f] >= 0; f++)
      if (best < 0 || Math.abs(floors[c * F + f] - kz) < Math.abs(floors[best] - kz)) best = c * F + f;
    if (best >= 0 && !seen[best]) { seen[best] = 1; queue[tail++] = best; }
  }
  while (head < tail) {
    const v = queue[head++], c = (v / F) | 0, z = floors[v], cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
      for (let f = 0, n = (ax + W * ay) * F; f < F && floors[n + f] >= 0; f++)
        if (floors[n + f] - z <= up && !seen[n + f]) { seen[n + f] = 1; queue[tail++] = n + f; }
    }
  }
  const heights = new Float32Array(W * H).fill(NaN);
  for (let c = 0; c < W * H; c++)
    for (let f = 0; f < F && floors[c * F + f] >= 0; f++) if (seen[c * F + f]) { heights[c] = o[2] + floors[c * F + f] * s; break; }
  return { W, H, cell: s * stride, x0: o[0], y0: o[1], heights, solid };
}

// The game's own radar when exported (CS2 panorama/images/overheadmaps/<map>_radar_psd + resource/overviews/<map>.txt:
// pos_x/pos_y = world position of the image's top-left corner, scale = units per pixel); otherwise built from the map.
export async function loadRadar(map, src, base = '/models/src/') {
  if (src) try {
    const [img, txt] = await Promise.all([new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = base + src.image; }),
      fetch(base + src.overview).then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))]);
    const num = k => Number(txt.match(new RegExp(`"${k}"\\s+"([-\\d.]+)"`))?.[1]), scale = num('scale');
    if (scale > 0) return { img, x0: num('pos_x'), y1: num('pos_y'), w: img.width * scale, h: img.height * scale };
  } catch (e) { console.warn('CS2 radar not loaded, building one from the map:', e); }
  return makeRadar(map);
}

// Overview image (north up) + its placement in world units.
export function makeRadar(map) {
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  if (!map.grid) { // built-in box map: floor and boxes, 8 units per pixel
    const [f, ...boxes] = map.boxes, k = 8;
    cv.width = (f[3] - f[0]) / k; cv.height = (f[4] - f[1]) / k;
    ctx.fillStyle = '#8a7f6c'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const b of boxes) {
      ctx.fillStyle = b[5] - b[2] > 160 ? '#2a2723' : '#b8ab92';
      ctx.fillRect((b[0] - f[0]) / k, (f[4] - b[4]) / k, (b[3] - b[0]) / k, (b[4] - b[1]) / k);
    }
    return { img: cv, x0: f[0], y1: f[4], w: f[3] - f[0], h: f[4] - f[1] };
  }
  const r = radarHeights(map.grid, map.spawns.flat());
  cv.width = r.W; cv.height = r.H;
  let lo = Infinity, hi = -Infinity;
  for (const z of r.heights) if (z === z) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  const img = ctx.createImageData(r.W, r.H), d = img.data, ok = c => r.heights[c] === r.heights[c];
  for (let cy = 0; cy < r.H; cy++) for (let cx = 0; cx < r.W; cx++) {
    const c = cx + r.W * cy, p = (cx + r.W * (r.H - 1 - cy)) * 4;
    if (ok(c)) {
      const edge = cx === 0 || cy === 0 || cx === r.W - 1 || cy === r.H - 1 || !ok(c - 1) || !ok(c + 1) || !ok(c - r.W) || !ok(c + r.W);
      const v = edge ? 235 : 70 + 140 * (r.heights[c] - lo) / Math.max(1, hi - lo); // brighter = higher, light outline
      d[p] = v; d[p + 1] = v * 0.96; d[p + 2] = v * 0.86; d[p + 3] = 255;
    } else if (r.solid[c]) { d[p] = d[p + 1] = d[p + 2] = 28; d[p + 3] = 200; }
  }
  ctx.putImageData(img, 0, 0);
  return { img: cv, x0: r.x0, y1: r.y0 + r.H * r.cell, w: r.W * r.cell, h: r.H * r.cell };
}

const TEAM_COLOR = ['#e8b23a', '#5aa0ff']; // T, CT
// Draws the radar centred on `me` (Source position), rotated so the view direction points up. shown(q) → draw player q.
export function drawRadar(cv, radar, players, me, yaw, shown, range = 1400) {
  const dpr = devicePixelRatio || 1, size = cv.clientWidth;
  if (cv.width !== Math.round(size * dpr)) cv.width = cv.height = Math.round(size * dpr);
  const ctx = cv.getContext('2d'), R = size / 2, k = R / range;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, size, size, 10); ctx.clip();
  ctx.fillStyle = 'rgba(10,10,10,0.55)'; ctx.fillRect(0, 0, size, size);
  ctx.translate(R, R); ctx.rotate((yaw - 90) * Math.PI / 180); ctx.scale(k, k); ctx.translate(-me.pos[0], me.pos[1]); // canvas y = −Y
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(radar.img, radar.x0, -radar.y1, radar.w, radar.h);
  for (const q of players) {
    if (q === me || !q.alive || !shown(q)) continue;
    ctx.fillStyle = TEAM_COLOR[q.team]; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 / k;
    ctx.beginPath(); ctx.arc(q.pos[0], -q.pos[1], 5 / k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  if (me.alive) { // own arrow: always at the centre, pointing up (the radar turns instead)
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(R, R - 8); ctx.lineTo(R + 6, R + 6); ctx.lineTo(R, R + 3); ctx.lineTo(R - 6, R + 6); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(0.5, 0.5, size - 1, size - 1, 10); ctx.stroke();
}
