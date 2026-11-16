// Demo playback. Format "arena-demo-1" — written by tools/import-demo.py from a CS2 .dem (or tools/record-demo.js from
// the sim), served gzipped from public/demos/<name>.json.gz. CS2 world units and angles, same as the sim and the map:
// {
//   format, map (imported map name or null = built-in), tickrate, step (source ticks between frames),
//   weapons: [names],                                   // index used by the weapon field
//   players: [{ name, steamid }],
//   frames: { ticks: [t...], data: [...] },             // data[(frame * players + player) * FIELDS.length + field]
//   events: [{ tick, type: 'shot'|'hit'|'kill', ... }],  // sorted by tick; ids = player indexes
//   rounds: [{ start, freezeEnd, end, winner, reason?, score?: [T, CT], teams?: [T name, CT name] }], // winner 0 = T, 1 = CT, -1 = none
//   matchStart?,                                        // tick the match began (begin_new_match): rounds/kills count from here
//   nades?, smokes?, fires?, bombs?: [{ planted, by, pos, site, end, result }], drops?: [{ start, end, pos }]
// }
// A player missing from a frame (not connected yet, left) has null fields there.
export const FIELDS = ['x', 'y', 'z', 'yaw', 'pitch', 'hp', 'armor', 'alive', 'team', 'weapon', 'duck'];
const N = FIELDS.length, F = Object.fromEntries(FIELDS.map((f, i) => [f, i]));

// The viewer has three player models; every CS2 weapon is shown with the closest one.
export function modelSlot(name = '') {
  if (/glock|usp|hkp2000|p2000|p250|deagle|fiveseven|tec9|cz75|elite|revolver|taser/.test(name)) return 1;
  if (/knife|bayonet|karambit|melee|grenade|flash|smoke|molotov|decoy|c4|healthshot/.test(name)) return 2; // one-handed
  return 0; // rifles, SMGs, shotguns, snipers, machine guns
}

const wrap180 = a => ((((a + 180) % 360) + 360) % 360) - 180;
// Largest index i with arr[i] <= v (arr sorted ascending), -1 if none.
function floorIndex(arr, v, key = x => x) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (key(arr[m]) <= v) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// Every player at a (fractional) source tick, interpolated between the two frames around it.
// Returns sim-state-like players: { id, name, team, pos, vel, yaw, pitch, hp, armor, alive, duck, crouch, weapon, weaponName }.
export function stateAt(demo, tick) {
  const { ticks, data } = demo.frames, P = demo.players.length;
  const i = Math.max(0, floorIndex(ticks, tick)), j = Math.min(ticks.length - 1, i + 1);
  const dt = ticks[j] - ticks[i], a = dt > 0 ? Math.min(1, Math.max(0, (tick - ticks[i]) / dt)) : 0;
  const at = (f, p, k) => data[(f * P + p) * N + k];
  return demo.players.map((pl, p) => {
    const x0 = at(i, p, F.x), x1 = at(j, p, F.x);
    if (x0 == null) return { id: p, name: pl.name, team: 0, pos: [0, 0, -1e4], vel: [0, 0, 0], yaw: 0, pitch: 0, hp: 0, armor: 0, alive: false, duck: 0, crouch: false, weapon: 0, present: false };
    const b = x1 == null ? 0 : a, J = x1 == null ? i : j, lerp = k => at(i, p, k) + (at(J, p, k) - at(i, p, k)) * b;
    const pos = [lerp(F.x), lerp(F.y), lerp(F.z)], secs = (ticks[J] - ticks[i]) / demo.tickrate || 1;
    const vel = J === i ? [0, 0, 0] : [0, 1, 2].map(k => (at(J, p, k) - at(i, p, k)) / secs);
    const y0 = at(i, p, F.yaw), yaw = wrap180(y0 + wrap180(at(J, p, F.yaw) - y0) * b);
    const duck = lerp(F.duck), name = demo.weapons[at(i, p, F.weapon)] || '';
    return { id: p, name: pl.name, team: at(i, p, F.team), pos, vel, yaw, pitch: lerp(F.pitch), hp: at(i, p, F.hp), armor: at(i, p, F.armor),
      alive: !!at(i, p, F.alive), duck, crouch: duck > 0.5, weapon: modelSlot(name), weaponName: name, present: true };
  });
}

// Grenades in flight, smokes and fires at a tick, shaped like the sim's state (nades / smokes / fires; times in seconds).
// Optional demo keys: nades [{ id, type, by, ticks, pos: [x,y,z,...] }], smokes / fires [{ start, end, pos, type? }].
export function utilityAt(demo, tick, smokeRadius = 144, smokeGrow = 0.8) {
  const R = demo.tickrate, nades = [];
  for (const n of demo.nades || []) {
    if (tick < n.ticks[0] || tick > n.ticks[n.ticks.length - 1]) continue;
    const i = Math.max(0, floorIndex(n.ticks, tick)), j = Math.min(n.ticks.length - 1, i + 1), dt = n.ticks[j] - n.ticks[i];
    const a = dt > 0 ? (tick - n.ticks[i]) / dt : 0;
    nades.push({ id: n.id, type: n.type, state: 'fly', pos: [0, 1, 2].map(k => n.pos[i * 3 + k] + (n.pos[j * 3 + k] - n.pos[i * 3 + k]) * a) });
  }
  const live = (list, tag) => (list || []).map((s, i) => ({ ...s, i })).filter(s => tick >= s.start && tick < s.end)
    .map(s => ({ id: `${tag}${s.i}`, type: s.type, pos: s.pos, born: s.start / R, until: s.end / R }));
  return { nades, smokes: live(demo.smokes, 's').map(s => ({ ...s, r: smokeRadius * Math.min(1, (tick / R - s.born) / smokeGrow) })),
    fires: live(demo.fires, 'f').map(f => ({ ...f, r: 120 })) };
}

// Events with t0 < tick <= t1 (what playback just passed over).
export function eventsBetween(demo, t0, t1) {
  const ev = demo.events, i = floorIndex(ev, t0, e => e.tick) + 1, out = [];
  for (let k = i; k < ev.length && ev[k].tick <= t1; k++) out.push(ev[k]);
  return out;
}

// Round index at a tick (the last one started by then), and the score [T side, CT side] after the rounds finished by then:
// the game's own team totals when the demo has them (rounds[].score — they follow the teams across the half-time switch),
// else won rounds per side.
export const roundAt = (demo, tick) => Math.max(0, floorIndex(demo.rounds, tick, r => r.start));
export function scoreAt(demo, tick) {
  const i = floorIndex(demo.rounds, tick, r => (r.end == null ? Infinity : r.end));
  if (demo.rounds.some(r => r.score)) { for (let k = i; k >= 0; k--) if (demo.rounds[k].score) return [...demo.rounds[k].score]; return [0, 0]; }
  const s = [0, 0];
  for (let k = 0; k <= i; k++) if (demo.rounds[k].winner >= 0) s[demo.rounds[k].winner]++;
  return s;
}
// Team names [T side, CT side] at a tick (rounds[].teams), or null.
export function teamsAt(demo, tick) { // read at each round's end, while the sides were still those of that round
  return demo.rounds[roundAt(demo, tick)]?.teams || demo.rounds.find(r => r.teams)?.teams || null;
}
// Kills per player up to a tick (scoreboard), from the match start: a running count per kill, found by binary search.
export function killsAt(demo, tick) {
  if (!demo._kills) {
    const k = demo.players.map(() => 0), from = demo.matchStart ?? -Infinity;
    demo._kills = demo.events.filter(e => e.type === 'kill' && e.tick >= from).map(e => { if (e.by >= 0 && e.by !== e.victim) k[e.by]++; return { tick: e.tick, k: [...k] }; });
  }
  const i = floorIndex(demo._kills, tick, e => e.tick);
  return i < 0 ? demo.players.map(() => 0) : demo._kills[i].k;
}
// The bomb at a tick: planted ({ pos, planted, end (s), result, state: 'ticking' | 'defused' | 'exploded', by }) — shown
// until the next round starts (exploded: gone), and dropped on the ground ({ pos }). Optional demo keys bombs / drops.
export function bombAt(demo, tick) {
  const R = demo.tickrate, nextStart = t => demo.rounds.find(r => r.start > t)?.start ?? Infinity;
  let bomb = null, drop = null;
  for (const b of demo.bombs || []) {
    if (tick < b.planted || tick >= nextStart(b.planted)) continue;
    const over = b.end != null && tick >= b.end;
    if (over && b.result === 'exploded' && tick > b.end + R) continue;
    bomb = { pos: b.pos, by: b.by, planted: b.planted / R, end: b.end == null ? null : b.end / R, result: b.result, state: over ? b.result : 'ticking' };
  }
  for (const d of demo.drops || []) if (tick >= d.start && tick < (d.end ?? nextStart(d.start)) && d.pos) drop = { pos: d.pos };
  return { bomb, drop };
}
// The last event of a sorted list at or before a tick (binary search), or null.
export function lastAt(list, tick) {
  const i = floorIndex(list, tick, e => e.tick);
  return i < 0 ? null : list[i];
}
