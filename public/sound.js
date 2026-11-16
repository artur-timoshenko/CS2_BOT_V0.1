// CS-style sound from the game's own files (Source2Viewer export, listed in public/models/models.json "sounds"):
// positional one-shots (HRTF direction, CS-like range), a looping soundscape, footsteps paced like CS.
// Your own sounds (steps, shots, landing) are played "in your head", as CS2 does for the local player.

// Per group: max = distance (Source units) at which it fades out completely, ref = full volume up to here, vol = loudness.
// CS2 ranges: running footsteps / landings ~1100, gunshots carry across the map (distant layer past farFrom).
const GROUPS = {
  step: { ref: 40, max: 1100, vol: 0.55 }, land: { ref: 40, max: 1100, vol: 0.65 }, jump: { ref: 40, max: 700, vol: 0.4 },
  suit: { ref: 40, max: 600, vol: 0.3 },
  ak47: { ref: 300, max: 8000, vol: 0.9, far: 'ak47_distant', farFrom: 1800 }, ak47_distant: { ref: 0, max: 12000, vol: 0.8 },
  glock: { ref: 250, max: 5000, vol: 0.8, far: 'glock_distant', farFrom: 1500 }, glock_distant: { ref: 0, max: 9000, vol: 0.7 },
  knife: { ref: 40, max: 500, vol: 0.7 },
  hit: { ref: 100, max: 900, vol: 0.8 }, headshot: { ref: 150, max: 1500, vol: 1 }, death: { ref: 150, max: 1400, vol: 0.7 },
  kill: { vol: 0.8 }, headshot_kill: { vol: 0.9 }, ambient: { vol: 0.22 }, ambient_random: { vol: 0.18 },
};
const settings = group => GROUPS[group] || GROUPS[group.replace(/_.*/, '')] || {}; // step_sand → step, suit_t → suit

// Volume at distance d: full up to ref, then falls to silence exactly at max (squared: −12 dB at mid-range, like a dB curve).
export function falloff(d, ref, max) {
  if (d <= ref) return 1;
  if (d >= max) return 0;
  const k = 1 - (d - ref) / (max - ref);
  return k * k;
}

// CS footsteps: only while running — the walk key (≈112 u/s) and crouch-walking are silent — every 0.3 s at full speed,
// 0.4 s slower; landing from the air always makes a sound, so does a jump take-off. s: per-player state {t, air}.
// Returns 'step', 'land', 'jump' or null.
export function footstep(s, speed, onGround, dt, vz = 0) {
  const landed = onGround && s.air, jumped = !onGround && !s.air && vz > 100;
  s.air = !onGround;
  if (landed) { s.t = 0.3; return 'land'; }
  if (jumped) return 'jump';
  if (!onGround || speed < 135) { s.t = 0.1; return null; } // the first step comes shortly after starting to run
  s.t -= dt;
  if (s.t > 0) return null;
  s.t = speed > 200 ? 0.3 : 0.4;
  return 'step';
}

// CS2 distance_volume_mapping_curve ([units, volume] points), linear between points; before the first point its value,
// past the last one the last value (an event's broadcast distance cuts it off).
export function curveAt(curve, d) {
  if (!curve?.length) return 1;
  if (d <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) if (d <= curve[i][0]) {
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    return y0 + (y1 - y0) * (d - x0) / ((x1 - x0) || 1);
  }
  return curve[curve.length - 1][1];
}
// "<folder>/<name>" of a sound file: how tools/import-soundevents.js keys the game's files
export const fileKey = p => p.replace(/\\/g, '/').replace(/\.[^./]+$/, '').split('/').slice(-2).join('/').toLowerCase();

// files: group → urls (under base). events: <Maps>/sounds/soundevents.json — with it, a group whose file the game plays
// from a sound event takes that event's distance curve, cut-off, occlusion, reverb and child events (CS2 propagation);
// groups without one keep GROUPS' ref/max falloff. origins: url → game file key, for files copied under other names.
export function createSound(files = {}, base = '/models/src/', events = null, origins = {}) {
  // master → speakers; game (shots, steps, grenades, reloads…) → master; the map's ambience goes straight to master
  const ctx = new AudioContext(), master = ctx.createGain(), game = ctx.createGain(), cache = new Map();
  master.gain.value = 0.8; master.connect(ctx.destination); game.connect(master);
  const load = url => {
    if (!cache.has(url)) cache.set(url, fetch(base + url).then(r => (r.ok ? r.arrayBuffer() : null)).then(b => b && ctx.decodeAudioData(b)).catch(() => null));
    return cache.get(url);
  };
  Object.values(files).flat().forEach(load); // decode up front: a gunshot must not wait for the network
  let ambience = null, occlude = null, voices = 0;
  const MAX_VOICES = 40;
  const ear = { x: 0, y: 0, z: 0 }, fwd = { x: 0, y: 0, z: -1 }, up = { x: 0, y: 1, z: 0 };
  // reverb send: a short synthetic room tail (CS2 runs Steam Audio reverb; this only gives distant sounds their space)
  const reverb = ctx.createConvolver(), ir = ctx.createBuffer(2, ctx.sampleRate * 1.4, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.32)); }
  reverb.buffer = ir; reverb.connect(game);
  // the sound event behind a group (first of its files the game plays from an event), and the group that plays an event
  const evCache = {}, groupOfEvent = {};
  let scanned = false;
  const eventOf = group => {
    if (group in evCache) return evCache[group];
    let E = null;
    for (const f of files[group] || []) {
      const n = events?.byFile[origins[f] || fileKey(f)];
      if (n && events.events[n]) { E = { name: n, ...events.events[n] }; break; }
    }
    if (E) groupOfEvent[E.name] ??= group;
    return (evCache[group] = E);
  };
  const groupFor = name => {
    if (!scanned) { Object.keys(files).forEach(eventOf); scanned = true; }
    return groupOfEvent[name];
  };
  const api = {
    // browsers start audio only after a click/key press
    resume() {
      if (ctx.state !== 'running') ctx.resume();
      if (ambience) return;
      ambience = true; // map soundscape: every "ambient" file loops at once (wind + distant city…), "ambient_random" one-shots now and then
      for (const url of files.ambient || []) load(url).then(b => { if (!b) return; const s = ctx.createBufferSource(), g = ctx.createGain();
        s.buffer = b; s.loop = true; g.gain.value = GROUPS.ambient.vol; s.connect(g).connect(master); s.start(); });
      const random = () => { api.play('ambient_random'); setTimeout(random, 6000 + Math.random() * 12000); };
      if (files.ambient_random?.length) setTimeout(random, 4000);
    },
    has: group => !!files[group]?.length,
    // A weapon's shots from <Maps>/weapons/index.json: group <name> (+ <name>_distant past farFrom), ranges as CS2's
    // rifles, pistols or knife swings. kind: 'rifle' | 'pistol' | 'knife'
    addWeapon(name, shot = [], distant = [], kind = 'rifle') {
      const T = { rifle: ['ak47', 'ak47_distant'], pistol: ['glock', 'glock_distant'], knife: ['knife', null] }[kind];
      files[name] = shot; GROUPS[name] = { ...GROUPS[T[0]], far: distant.length ? name + '_distant' : undefined };
      if (distant.length) { files[name + '_distant'] = distant; GROUPS[name + '_distant'] = { ...GROUPS[T[1]] }; }
      delete evCache[name]; delete evCache[name + '_distant']; scanned = false;
    },
    // decode ahead the sounds of these weapons (every group "<name>", "<name>_distant", "<name>:…"); the rest decode on first play
    preload(names) {
      const want = new Set(names);
      for (const g of Object.keys(files)) if (want.has(g.split(/[:]|_distant$/)[0])) files[g].forEach(load);
    },
    setVolume: v => { master.gain.value = Math.max(0, Math.min(1, v)); }, // 0 = sound off
    setGameVolume: v => { game.gain.value = Math.max(0, Math.min(1, v)); }, // game sounds only (not the ambience)
    // any group: files (paths under base) + its range/loudness { ref, max, vol, far?, farFrom? }
    addGroup(name, list = [], G = {}) {
      if (!list.length) return;
      files[name] = list; GROUPS[name] = G; // decoded on first play or by preload()
      delete evCache[name]; scanned = false;
    },
    // occluded(from, to): true when the map blocks the line (three.js positions) — walls muffle sounds as in CS2
    setOcclusion: f => { occlude = f; },
    eventOf,
    listen(camera) { // three.js camera (world units = Source inches)
      const L = ctx.listener, e = camera.matrixWorld.elements, t = ctx.currentTime;
      ear.x = e[12]; ear.y = e[13]; ear.z = e[14]; fwd.x = -e[8]; fwd.y = -e[9]; fwd.z = -e[10]; up.x = e[4]; up.y = e[5]; up.z = e[6];
      if (L.positionX) {
        L.positionX.setValueAtTime(ear.x, t); L.positionY.setValueAtTime(ear.y, t); L.positionZ.setValueAtTime(ear.z, t);
        L.forwardX.setValueAtTime(fwd.x, t); L.forwardY.setValueAtTime(fwd.y, t); L.forwardZ.setValueAtTime(fwd.z, t);
        L.upX.setValueAtTime(up.x, t); L.upY.setValueAtTime(up.y, t); L.upZ.setValueAtTime(up.z, t);
      } else { L.setPosition(ear.x, ear.y, ear.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
    },
    // group: key of "sounds" in models.json; pos: THREE.Vector3 in the world, or null = in your head (own sounds, UI)
    play(group, pos = null, depth = 0) {
      let G = settings(group), d = 0, gain, occluded = false;
      const E = eventOf(group);
      if (pos) d = Math.hypot(pos.x - ear.x, pos.y - ear.y, pos.z - ear.z);
      if (E?.curve) { // CS2: the event's curve and cut-off; its child events (distant layer…) play alongside
        if (pos && E.max && d > E.max) return;
        // shortcut: the game's absolute volumes go through its mixer (knife swish 0.03); only the event's relative level is kept
        gain = (G.vol ?? 1) * Math.min(1.2, Math.max(0.25, E.volume)) * (pos ? curveAt(E.curve, d) : 1);
        if (pos && E.occlusion > 0 && occlude?.(pos, ear)) { occluded = true; gain *= 1 - 0.6 * E.occlusion; }
        if (pos && depth < 2) for (const c of E.children || []) { const cg = c && groupFor(c); if (cg && cg !== group) api.play(cg, pos, depth + 1); }
      } else {
        if (pos && G.far && d > G.farFrom && api.has(G.far)) { group = G.far; G = settings(group); }
        gain = (G.vol ?? 1) * (pos ? falloff(d, G.ref ?? 0, G.max ?? 2000) : 1);
      }
      const list = files[group];
      if (!list?.length || ctx.state !== 'running' || gain < 1e-3) return;
      if (voices >= MAX_VOICES && gain < 0.3) return; // crowded (a fast-forwarded demo): drop the quiet ones, keep loud events
      load(list[(Math.random() * list.length) | 0]).then(b => {
        if (!b) return;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        voices++; src.onended = () => voices--;
        src.buffer = b; src.playbackRate.value = 0.97 + Math.random() * 0.06; g.gain.value = gain;
        src.connect(g);
        const out = group.startsWith('ambient') ? master : game;
        if (!pos) { g.connect(out); src.start(); return; }
        // behind a wall: muffled (low-pass by the event's occlusion); far away: the air takes the highs
        const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: occluded ? 500 + 3500 * (1 - E.occlusion) : 20000 - 14000 * Math.min(1, d / 3000) });
        // direction only (HRTF); the distance volume is ours above, so the panner must not attenuate again
        g.connect(lp).connect(new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0,
          positionX: pos.x, positionY: pos.y, positionZ: pos.z })).connect(out);
        if (E?.reverb > 0) { const s = ctx.createGain(); s.gain.value = E.reverb * 0.25 * Math.min(1, 0.3 + d / 1500); lp.connect(s).connect(reverb); }
        src.start();
      });
    },
  };
  return api;
}
