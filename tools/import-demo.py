"""CS2 .dem -> demo for the viewer (format "arena-demo-1", see public/demo.js), written to public/demos/<name>.json.gz.
Opens at /?demo=<name>. Coordinates and angles are CS2's, the same as the imported map (checked with getpos).
Needs demoparser2 (py -m pip install demoparser2).

    py tools/import-demo.py match.dem [--out name] [--step 4]

--step: source ticks between frames (4 at 64 tick = 16 frames/s; the viewer interpolates between them).
"""
import argparse
import gzip
import json
import math
import os
import re
import sys

try:
    from demoparser2 import DemoParser
except ImportError:
    sys.exit('needs demoparser2: py -m pip install demoparser2')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = ['X', 'Y', 'Z', 'yaw', 'pitch', 'health', 'armor_value', 'is_alive', 'team_num', 'active_weapon_name']
# display name (lowercase, punctuation stripped) -> CS2 internal name, as in weapons.vdata, the sim's CATALOG and the HUD icons
ALIAS = {'deserteagle': 'deagle', 'dualberettas': 'elite', 'zeusx27': 'taser', 'c4explosive': 'c4', 'usps': 'usp_silencer',
         'm4a1s': 'm4a1_silencer', 'm4a4': 'm4a1', 'p2000': 'hkp2000', 'sg553': 'sg556', 'r8revolver': 'revolver', 'ppbizon': 'bizon',
         'cz75auto': 'cz75a', 'ssg08': 'ssg08', 'galilar': 'galilar', 'highexplosivegrenade': 'hegrenade', 'incendiarygrenade': 'incgrenade',
         'decoygrenade': 'decoy', 'flashbang': 'flashbang', 'smokegrenade': 'smokegrenade', 'molotov': 'molotov', 'mp5sd': 'mp5sd',
         'glock18': 'glock', 'c4': 'c4', 'mp5': 'mp5sd'}
# knives by display name ("Karambit", "Stiletto Knife", "★ Butterfly Knife") -> weapons.vdata names
KNIVES = {'bayonet': 'bayonet', 'm9bayonet': 'knife_m9_bayonet', 'karambit': 'knife_karambit', 'butterfly': 'knife_butterfly',
          'flip': 'knife_flip', 'gut': 'knife_gut', 'huntsman': 'knife_tactical', 'falchion': 'knife_falchion', 'bowie': 'knife_survival_bowie',
          'shadowdaggers': 'knife_push', 'navaja': 'knife_gypsy_jackknife', 'stiletto': 'knife_stiletto', 'talon': 'knife_widowmaker',
          'ursus': 'knife_ursus', 'classic': 'knife_css', 'paracord': 'knife_cord', 'survival': 'knife_canis', 'nomad': 'knife_outdoor',
          'skeleton': 'knife_skeleton', 'kukri': 'knife_kukri'}
# parse_grenades() projectile classes -> grenade names (molotov vs incendiary is decided by the thrower's team)
PROJECTILES = {'CHEGrenadeProjectile': 'hegrenade', 'CFlashbangProjectile': 'flashbang', 'CSmokeGrenadeProjectile': 'smokegrenade',
               'CMolotovProjectile': 'molotov', 'CDecoyProjectile': 'decoy'}


def weapon_key(name):
    """Display ("AK-47", "Desert Eagle", "★ Karambit") or entity ("weapon_ak47") weapon name -> the CS2 internal name used by
    sim/weapons-cs2.js, the HUD icons and the weapon folders (ak47, deagle, knife_karambit, hegrenade...)."""
    if not isinstance(name, str) or not name:
        return ''
    n = re.sub(r'[^a-z0-9_]', '', name.lower().replace('weapon_', ''))  # entity names keep their underscores (knife_t)
    if n in ('knife', 'knife_t') or n.startswith('knife_') or n == 'bayonet':
        return n
    k = KNIVES.get(re.sub(r'knife$', '', n))
    if k:
        return k
    n = ALIAS.get(n, n)
    return 'knife_' + n if '★' in name and not n.startswith('knife') else n


def team_of(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    return 0 if n == 2 else 1 if n == 3 else None  # 2 = T, 3 = CT; spectators/unassigned are left out


def num(v, nd=1):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, nd)


def sid(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else str(int(v)) if isinstance(v, (int, float)) else str(v)


def winner_of(w):
    s = str(w).upper()
    return 0 if s in ('2', 'T', 'TERRORIST') else 1 if s in ('3', 'CT') else -1


def unpack(path):
    """match.dem.zst (how demo sites ship them) -> match.dem next to it, unpacked once."""
    if not path.lower().endswith('.zst'):
        return path
    try:
        import zstandard
    except ImportError:
        sys.exit('needs zstandard for .zst demos: py -m pip install zstandard')
    dst = path[:-4]
    if not os.path.exists(dst):
        with open(path, 'rb') as f, open(dst + '.part', 'wb') as o:
            zstandard.ZstdDecompressor().copy_stream(f, o)
        os.replace(dst + '.part', dst)  # a half-written .dem never looks finished
    return dst


def main():
    ap = argparse.ArgumentParser(description='CS2 .dem -> viewer demo')
    ap.add_argument('dem', help='.dem or .dem.zst')
    ap.add_argument('--out', help='demo name (default: the .dem file name)')
    ap.add_argument('--step', type=int, default=4)
    a = ap.parse_args()
    dem = unpack(a.dem)
    out = a.out or os.path.splitext(os.path.basename(dem))[0]
    p = DemoParser(dem)
    header = p.parse_header()
    map_name = header.get('map_name') or None
    if map_name and not os.path.exists(os.path.join(ROOT, 'public', 'maps', map_name, 'map.json')):
        print(f'warning: map {map_name} is not imported (tools/import-map.js); the viewer will show the built-in map')
        map_name = None

    def event(name):
        try:
            return p.parse_event(name)
        except Exception as e:  # an event missing from this demo
            print(f'no {name} events ({e})')
            return None

    # every player's state, all ticks, then one frame every --step ticks
    try:
        df = p.parse_ticks(CORE + ['duck_amount'])
        duck_col = 'duck_amount'
    except Exception:
        df = p.parse_ticks(CORE)
        duck_col = None
    df = df[df['tick'] % a.step == 0]
    df = df[df['team_num'].isin([2, 3])]
    first = df.sort_values('tick').drop_duplicates('steamid')
    order = sorted(first.itertuples(index=False), key=lambda r: (team_of(r.team_num), str(r.name)))
    index = {sid(r.steamid): i for i, r in enumerate(order)}
    players = [{'name': str(r.name), 'steamid': sid(r.steamid)} for r in order]
    ticks = sorted(int(t) for t in df['tick'].unique())
    frame_of = {t: i for i, t in enumerate(ticks)}
    weapons, weapon_ix = [], {}
    F, P = 11, len(players)
    data = [None] * (len(ticks) * P * F)
    for r in df.itertuples(index=False):
        i, k = frame_of[int(r.tick)], index.get(sid(r.steamid))
        if k is None:
            continue
        w = weapon_key(r.active_weapon_name)
        if w not in weapon_ix:
            weapon_ix[w] = len(weapons)
            weapons.append(w)
        duck = num(getattr(r, duck_col), 2) if duck_col else 0
        o = (i * P + k) * F
        data[o:o + F] = [num(r.X), num(r.Y), num(r.Z), num(r.yaw), num(r.pitch), int(r.health or 0), int(r.armor_value or 0),
                         1 if r.is_alive else 0, team_of(r.team_num), weapon_ix[w], duck or 0]

    events = []
    fire = event('weapon_fire')
    if fire is not None:
        for r in fire.itertuples(index=False):
            k = index.get(sid(getattr(r, 'user_steamid', None)))
            if k is not None:
                events.append({'tick': int(r.tick), 'type': 'shot', 'by': k, 'weapon': weapon_key(getattr(r, 'weapon', ''))})
    hurt = event('player_hurt')
    if hurt is not None:
        for r in hurt.itertuples(index=False):
            v = index.get(sid(getattr(r, 'user_steamid', None)))
            if v is not None:
                g = getattr(r, 'hitgroup', '')
                events.append({'tick': int(r.tick), 'type': 'hit', 'by': index.get(sid(getattr(r, 'attacker_steamid', None)), -1), 'victim': v,
                               'group': 'head' if str(g).lower() in ('1', 'head') else str(g), 'dmg': int(getattr(r, 'dmg_health', 0) or 0)})
    death = event('player_death')
    if death is not None:
        for r in death.itertuples(index=False):
            v = index.get(sid(getattr(r, 'user_steamid', None)))
            if v is not None:
                events.append({'tick': int(r.tick), 'type': 'kill', 'by': index.get(sid(getattr(r, 'attacker_steamid', None)), -1), 'victim': v,
                               'weapon': weapon_key(getattr(r, 'weapon', '')), 'headshot': bool(getattr(r, 'headshot', False))})
    # utility: grenade flights, smokes, fires; detonations, flashes, reloads as events
    team_at = {}  # steamid -> sorted [(tick, team, x, y, z)]
    for r in df[['steamid', 'tick', 'team_num', 'X', 'Y', 'Z']].itertuples(index=False):
        team_at.setdefault(sid(r.steamid), []).append((int(r.tick), team_of(r.team_num), num(r.X), num(r.Y), num(r.Z)))
    for v in team_at.values():
        v.sort()

    def row_then(steamid, tick):
        rows = team_at.get(sid(steamid), [])
        t = [row for row in rows if row[0] <= tick]
        return t[-1] if t else (rows[0] if rows else None)

    def team_then(steamid, tick):
        row = row_then(steamid, tick)
        return row[1] if row else None

    def pos_then(steamid, tick):
        row = row_then(steamid, tick)
        return list(row[2:5]) if row else None

    def fire_kind(steamid, tick):
        return 'incgrenade' if team_then(steamid, tick) == 1 else 'molotov'

    pt = lambda r: [num(r.x), num(r.y), num(r.z)]
    nades = []
    try:
        g = p.parse_grenades()
        g = g[g['grenade_type'].isin(list(PROJECTILES)) & g['x'].notna()]
        g = g.sort_values(['grenade_entity_id', 'tick'])
        # entity ids are reused: a new flight starts where the same id jumps in time or changes thrower
        g['flight'] = ((g['grenade_entity_id'].diff() != 0) | (g['tick'].diff() > 16) | (g['steamid'] != g['steamid'].shift())).cumsum()
        for eid, path in g.groupby('flight'):
            path = path[(path['tick'] % a.step == 0) | (path['tick'] == path['tick'].max()) | (path['tick'] == path['tick'].min())]
            first = path.iloc[0]
            kind = PROJECTILES[first['grenade_type']]
            if kind == 'molotov':
                kind = fire_kind(first['steamid'], int(first['tick']))
            by = index.get(sid(first['steamid']), -1)
            nades.append({'id': int(eid), 'type': kind, 'by': by, 'ticks': [int(t) for t in path['tick']],
                          'pos': [v for r in path.itertuples(index=False) for v in pt(r)]})
            events.append({'tick': int(first['tick']), 'type': 'throw', 'by': by, 'weapon': kind, 'id': int(eid)})
    except Exception as e:
        print(f'no grenade paths ({e})')
    for name, kind in [('hegrenade_detonate', 'hegrenade'), ('flashbang_detonate', 'flashbang'), ('smokegrenade_detonate', 'smokegrenade'), ('decoy_detonate', 'decoy')]:
        d = event(name)
        for r in (d.itertuples(index=False) if d is not None else []):
            events.append({'tick': int(r.tick), 'type': 'detonate', 'weapon': kind, 'pos': pt(r), 'by': index.get(sid(r.user_steamid), -1), **({'end': True} if kind == 'decoy' else {})})

    def spans(start_ev, end_ev, kind=None):  # [{start, end, pos}] matched by entity id
        s, e = event(start_ev), event(end_ev)
        ends = {int(r.entityid): int(r.tick) for r in e.itertuples(index=False)} if e is not None else {}
        out = []
        for r in (s.itertuples(index=False) if s is not None else []):
            x = {'start': int(r.tick), 'end': ends.get(int(r.entityid), int(r.tick) + 20 * 64), 'pos': pt(r)}
            if kind:
                x['type'] = kind(r.user_steamid, int(r.tick))
                events.append({'tick': int(r.tick), 'type': 'detonate', 'weapon': x['type'], 'pos': x['pos'], 'by': index.get(sid(r.user_steamid), -1)})
            out.append(x)
        return out
    smokes = spans('smokegrenade_detonate', 'smokegrenade_expired')
    fires = spans('inferno_startburn', 'inferno_expire', fire_kind)
    blind = event('player_blind')
    for r in (blind.itertuples(index=False) if blind is not None else []):
        v = index.get(sid(r.user_steamid))
        if v is not None:
            events.append({'tick': int(r.tick), 'type': 'flashed', 'victim': v, 'by': index.get(sid(r.attacker_steamid), -1), 'duration': num(r.blind_duration, 2)})
    rel = event('weapon_reload')
    for r in (rel.itertuples(index=False) if rel is not None else []):
        k = index.get(sid(r.user_steamid))
        if k is not None:
            events.append({'tick': int(r.tick), 'type': 'reload', 'by': k})

    # the bomb: plant start, planted (where the planter stands), defuse start, defused, exploded; dropped on the ground
    bomb_ev = {n: event(n) for n in ['bomb_beginplant', 'bomb_planted', 'bomb_begindefuse', 'bomb_defused', 'bomb_exploded', 'bomb_dropped', 'bomb_pickup']}
    rows = lambda n: list(bomb_ev[n].itertuples(index=False)) if bomb_ev[n] is not None else []
    for r in rows('bomb_beginplant'):
        events.append({'tick': int(r.tick), 'type': 'bomb_beginplant', 'by': index.get(sid(r.user_steamid), -1)})
    for r in rows('bomb_begindefuse'):
        events.append({'tick': int(r.tick), 'type': 'bomb_begindefuse', 'by': index.get(sid(r.user_steamid), -1), 'kit': bool(getattr(r, 'haskit', False))})
    ends = sorted([(int(r.tick), 'defused', index.get(sid(r.user_steamid), -1)) for r in rows('bomb_defused')] +
                  [(int(r.tick), 'exploded', -1) for r in rows('bomb_exploded')])
    bombs = []
    for r in rows('bomb_planted'):
        t, pos = int(r.tick), pos_then(r.user_steamid, int(r.tick))
        end = next((e for e in ends if e[0] >= t), None)
        bombs.append({'planted': t, 'by': index.get(sid(r.user_steamid), -1), 'pos': pos, 'site': int(getattr(r, 'site', 0) or 0),
                      'end': end[0] if end else None, 'result': end[1] if end else None})
        events.append({'tick': t, 'type': 'bomb_planted', 'by': index.get(sid(r.user_steamid), -1), 'pos': pos})
        if end:
            events.append({'tick': end[0], 'type': 'bomb_' + end[1], 'by': end[2], 'pos': pos})
    pickups = sorted(int(r.tick) for r in rows('bomb_pickup'))
    drops = []
    for r in rows('bomb_dropped'):
        t = int(r.tick)
        drops.append({'start': t, 'end': next((p for p in pickups if p > t), None), 'pos': pos_then(r.user_steamid, t)})
    events.sort(key=lambda e: e['tick'])

    # rounds: start, end of the freeze time, end and winner
    rs, fe, re_ = event('round_start'), event('round_freeze_end'), event('round_end')
    starts = sorted(int(t) for t in rs['tick']) if rs is not None else []
    freezes = sorted(int(t) for t in fe['tick']) if fe is not None else []
    # the match starts at begin_new_match: warmup and restarts before it are not rounds
    bnm = event('begin_new_match')
    match_start = int(bnm['tick'].max()) if bnm is not None and len(bnm) else -1
    rounds, prev = [], ticks[0] if ticks else 0
    for r in (re_.sort_values('tick').itertuples(index=False) if re_ is not None else []):
        end = int(r.tick)
        start = max([s for s in starts if s <= end] or [prev])
        freeze = min([f for f in freezes if start <= f <= end] or [start])
        if end - start >= 64 and end > match_start:  # warmup / match-start artefacts end where they start
            reason = getattr(r, 'reason', None)
            rounds.append({'start': start, 'freezeEnd': freeze, 'end': end, 'winner': winner_of(getattr(r, 'winner', -1)),
                           'reason': reason if isinstance(reason, str) else None})
        prev = end
    # the score after each round and the team names per side, as the game counts them (team_rounds_total follows the
    # team across the half-time side switch)
    try:
        sc = p.parse_ticks(['team_rounds_total', 'team_clan_name', 'team_num'], ticks=[r['end'] + 32 for r in rounds])
        for r in rounds:
            at = sc[sc['tick'] == r['end'] + 32]
            side = lambda n: at[at['team_num'] == n].iloc[0] if len(at[at['team_num'] == n]) else None
            t, ct = side(2), side(3)
            if t is not None and ct is not None:
                r['score'] = [int(t['team_rounds_total']), int(ct['team_rounds_total'])]
                r['teams'] = [str(t['team_clan_name']), str(ct['team_clan_name'])]
    except Exception as e:
        print(f'no team scores ({e})')
    if not rounds and ticks:
        rounds = [{'start': ticks[0], 'freezeEnd': ticks[0], 'end': None, 'winner': -1}]

    demo = {'format': 'arena-demo-1', 'map': map_name, 'tickrate': 64, 'step': a.step, 'weapons': weapons, 'players': players,
            'frames': {'ticks': ticks, 'data': data}, 'events': events, 'rounds': rounds, 'nades': nades, 'smokes': smokes, 'fires': fires,
            'bombs': bombs, 'drops': drops, 'matchStart': match_start}
    dst = os.path.join(ROOT, 'public', 'demos', out + '.json.gz')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with gzip.open(dst, 'wt', encoding='utf-8') as f:
        json.dump(demo, f, separators=(',', ':'))
    print(f'{dst}: {len(players)} players, {len(rounds)} rounds, {len(ticks)} frames, {len(events)} events, '
          f'{len(nades)} grenades, {len(smokes)} smokes, {len(fires)} fires, {len(bombs)} plants, '
          f'final score {rounds[-1].get("score") if rounds else None}, '
          f'{os.path.getsize(dst) / 1e6:.1f} MB -> open /?demo={out}')


if __name__ == '__main__':
    main()
