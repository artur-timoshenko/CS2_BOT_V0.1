// CS2 scripts/weapons.vdata (KV3 text, Source2Viewer export) → sim/weapons-cs2.js: every weapon's mechanics in the
// sim's units (seconds, radians, Source units). Entries inherit missing fields through _base (rifle → primary → weapon_base).
//   node tools/import-weapons.js <weapons.vdata>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal KV3 text reader: objects { k = v }, arrays [ a, b ], numbers, true/false, "strings", prefix:"strings".
export function parseKV3(text) {
  const s = text.replace(/<!--[\s\S]*?-->/, ''), n = s.length;
  let i = 0;
  const ws = () => { for (;;) { while (i < n && /\s/.test(s[i])) i++; if (s.startsWith('//', i)) { while (i < n && s[i] !== '\n') i++; } else return; } };
  const str = () => { let out = ''; i++; while (i < n && s[i] !== '"') { if (s[i] === '\\') i++; out += s[i++]; } i++; return out; };
  const value = () => {
    ws();
    if (s[i] === '{') { i++; const o = {}; for (;;) { ws(); if (s[i] === '}') { i++; return o; } const k = key(); ws(); i++; /* = */ o[k] = value(); } }
    if (s[i] === '[') { i++; const a = []; for (;;) { ws(); if (s[i] === ']') { i++; return a; } a.push(value()); ws(); if (s[i] === ',') i++; } }
    if (s[i] === '"') return str();
    const m = /^[A-Za-z_][\w]*:(?=")/.exec(s.slice(i, i + 40)); // resource_name:"…", soundevent:"…"
    if (m) { i += m[0].length; return str(); }
    const t = /^[^\s,\]}]+/.exec(s.slice(i, i + 64))[0]; i += t.length;
    return t === 'true' ? true : t === 'false' ? false : Number.isNaN(Number(t)) ? t : Number(t);
  };
  const key = () => { ws(); if (s[i] === '"') return str(); const t = /^[^\s=]+/.exec(s.slice(i, i + 200))[0]; i += t.length; return t; };
  return value();
}

const first = v => (Array.isArray(v) ? v[0] : v), second = v => (Array.isArray(v) ? v[1] ?? v[0] : v);
// A weapon block with its _base chain merged (own fields win).
function resolve(all, name, seen = new Set()) {
  const w = all[name];
  if (!w || seen.has(name)) return {};
  seen.add(name);
  return { ...(w._base ? resolve(all, w._base, seen) : {}), ...w };
}
const SLOT = { GEAR_SLOT_RIFLE: 'primary', GEAR_SLOT_PISTOL: 'secondary', GEAR_SLOT_KNIFE: 'melee', GEAR_SLOT_GRENADES: 'grenade', GEAR_SLOT_C4: 'c4', GEAR_SLOT_BOOSTS: 'boost' };

// vdata block → the sim's weapon entry (same shape as the hand-written ones it replaces).
export function toWeapon(v) {
  const final = (f, base) => (f > 0 ? f : base); // -1 = no separate "final" recovery time
  const inacc = pick => ({ stand: pick(v.m_flInaccuracyStand), crouch: pick(v.m_flInaccuracyCrouch), jump: pick(v.m_flInaccuracyJump),
    jumpInitial: v.m_flInaccuracyJumpInitial, land: pick(v.m_flInaccuracyLand), fire: pick(v.m_flInaccuracyFire), move: pick(v.m_flInaccuracyMove) });
  const w = {
    name: v.m_szName.replace(/^weapon_/, ''), slot: SLOT[v.m_GearSlot] || 'other', type: (v.m_WeaponType || '').replace(/^WEAPONTYPE_/, '').toLowerCase(),
    dmg: v.m_nDamage, cycle: first(v.m_flCycleTime), auto: !!v.m_bIsFullAuto, mag: v.m_iMaxClip1 || 0, reserve: v.m_nPrimaryReserveAmmoMax || 0,
    // reserve counted in magazines (CS2 2026) — except shotguns: loose shells, loaded one by one (reload time is per shell)
    clips: v.m_bReserveAmmoAsClips !== false, perShell: v.m_bReserveAmmoAsClips === false && v.m_flDisallowAttackAfterReloadStartDuration < 1,
    reload: v.m_flDisallowAttackAfterReloadStartDuration, deploy: v.m_flDeployDuration, pen: +(v.m_flArmorRatio / 2).toFixed(4),
    rm: v.m_flRangeModifier, range: v.m_flRange, speed: first(v.m_flMaxSpeed), penetration: v.m_flPenetration,
    penLayers: Math.max(1, Math.round(v.m_flPenetration)), pellets: v.m_nNumBullets || 1, hsMult: v.m_flHeadshotMultiplier,
    spread: first(v.m_flSpread), inacc: inacc(first),
    recovery: { stand: v.m_flRecoveryTimeStand, crouch: v.m_flRecoveryTimeCrouch, standFinal: final(v.m_flRecoveryTimeStandFinal, v.m_flRecoveryTimeStand),
      crouchFinal: final(v.m_flRecoveryTimeCrouchFinal, v.m_flRecoveryTimeCrouch), from: v.m_nRecoveryTransitionStartBullet, to: v.m_nRecoveryTransitionEndBullet },
    recoil: { angle: first(v.m_flRecoilAngle), angleVar: first(v.m_flRecoilAngleVariance), mag: first(v.m_flRecoilMagnitude),
      magVar: first(v.m_flRecoilMagnitudeVariance), seed: v.m_nRecoilSeed || 0 },
    zoomLevels: v.m_nZoomLevels || 0, price: v.m_nPrice || 0, killAward: v.m_nKillAward || 0, tracerEvery: v.m_nTracerFrequency || 0,
    model: v.m_szWorldModel || '', muzzle: v.m_vecMuzzlePos0 || null,
  };
  if (v.m_bMeleeWeapon) w.melee = true;
  if (v.m_bHasBurstMode) { // second-mode values ([1]) apply in burst mode (Glock, FAMAS)
    w.burst = { count: 3, gap: v.m_flTimeBetweenBurstShots, cycle: v.m_flCycleTimeWhenInBurstMode, spread: second(v.m_flSpread),
      kickScale: +(second(v.m_flRecoilMagnitude) / first(v.m_flRecoilMagnitude)).toFixed(6), inacc: inacc(second) };
  }
  if (w.zoomLevels) w.scoped = { spread: second(v.m_flSpread), inacc: inacc(second), speed: second(v.m_flMaxSpeed), fov: [v.m_nZoomFOV1, v.m_nZoomFOV2] };
  return w;
}

export function importWeapons(text) {
  const all = parseKV3(text);
  return Object.keys(all).filter(k => /^weapon_/.test(k) && all[k].m_szName).map(k => toWeapon(resolve(all, k)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) { console.log('usage: node tools/import-weapons.js <weapons.vdata>'); process.exit(1); }
  const list = importWeapons(fs.readFileSync(src, 'utf8'));
  const dst = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim', 'weapons-cs2.js');
  fs.writeFileSync(dst, `// Generated by tools/import-weapons.js from CS2 scripts/weapons.vdata — do not edit; re-run the tool after a game update.\n`
    + `export const CS2_WEAPONS = ${JSON.stringify(list, null, 0).replace(/\},\{/g, '},\n{')};\n`);
  console.log(`${dst}: ${list.length} weapons — ${list.map(w => w.name).join(', ')}`);
}
