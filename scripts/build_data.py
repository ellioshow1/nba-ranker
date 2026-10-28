"""Builds data/players.json: every player on a current NBA roster, with last season's and this season's stats.

Source: ESPN's public JSON endpoints (rosters, injuries, per-player season stats).
Run by hand (python scripts/build_data.py) or by the daily GitHub Action.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

UA = {'User-Agent': 'Mozilla/5.0 (compatible; nba-ranker data build; +https://github.com/ellioshow1/nba-ranker)'}
SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'players.json')

EAST = {'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DET', 'IND', 'MIA', 'MIL', 'NY', 'ORL', 'PHI', 'TOR', 'WSH'}

# ESPN stat name -> our short key. Totals only; the app derives per-game and per-36 numbers.
STATS = {
    'gamesPlayed': 'gp', 'gamesStarted': 'gs', 'minutes': 'min', 'points': 'pts',
    'offensiveRebounds': 'oreb', 'defensiveRebounds': 'dreb', 'assists': 'ast', 'steals': 'stl', 'blocks': 'blk',
    'turnovers': 'tov', 'fouls': 'pf', 'fieldGoalsMade': 'fgm', 'fieldGoalsAttempted': 'fga',
    'threePointFieldGoalsMade': 'fg3m', 'threePointFieldGoalsAttempted': 'fg3a',
    'freeThrowsMade': 'ftm', 'freeThrowsAttempted': 'fta', 'plusMinus': 'pm', 'PER': 'per',
}


def get(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
        time.sleep(1.5 * 2 ** attempt)


def season_years():
    d = get('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete'
            '?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1&seasontype=2&page=1')
    cur = d['currentSeason']
    return cur['year'], cur['displayName']


def season_label(year):
    return f'{year - 1}-{str(year)[-2:]}'


def player_stats(pid, year):
    d = get(f'{CORE}/seasons/{year}/types/2/athletes/{pid}/statistics')
    if not d or 'splits' not in d:
        return None
    raw = {s['name']: s.get('value') for c in d['splits']['categories'] for s in c['stats']}
    out = {k: round(raw[n], 3) if isinstance(raw.get(n), float) else raw.get(n) for n, k in STATS.items() if raw.get(n) is not None}
    for k, v in out.items():
        if isinstance(v, float) and v.is_integer():
            out[k] = int(v)
    return out if out.get('gp') else None


def main():
    year, display = season_years()
    prev = year - 1
    print(f'current season {display} ({year}), previous {season_label(prev)} ({prev})')

    teams = {}
    for t in get(f'{SITE}/teams')['sports'][0]['leagues'][0]['teams']:
        t = t['team']
        abbr = t['abbreviation']
        logo = next((l['href'] for l in t.get('logos', []) if 'default' in l.get('rel', [])), t.get('logos', [{}])[0].get('href', ''))
        teams[abbr] = {
            'id': t['id'], 'name': t['displayName'], 'nick': t.get('name') or t.get('shortDisplayName'),
            'color': '#' + t.get('color', '777777'), 'alt': '#' + t.get('alternateColor', 'ffffff'),
            'logo': logo, 'conf': 'East' if abbr in EAST else 'West',
        }
    print('teams', len(teams))

    def roster(abbr):
        d = get(f"{SITE}/teams/{teams[abbr]['id']}/roster")
        rows = []
        for a in d.get('athletes', []):
            inj = (a.get('injuries') or [None])[0]
            rows.append({
                'id': a['id'], 'name': a['displayName'], 'team': abbr,
                'pos': (a.get('position') or {}).get('abbreviation', ''),
                'age': a.get('age'), 'exp': (a.get('experience') or {}).get('years', 0),
                'jersey': a.get('jersey', ''), 'ht': a.get('displayHeight', ''),
                'inj': {'status': inj.get('status', ''), 'note': inj.get('shortComment') or inj.get('details', {}).get('type', '')} if inj else None,
            })
        return rows

    with ThreadPoolExecutor(8) as ex:
        players = [p for rows in ex.map(roster, sorted(teams)) for p in rows]
    print('rostered players', len(players))

    # The injury report is fresher than the roster's own field, so let it win.
    # Its athletes carry no id field; the id is in their profile link (.../player/_/id/4397183/name).
    report = {}
    for team in (get(f'{SITE}/injuries') or {}).get('injuries', []):
        for i in team.get('injuries', []):
            href = next(iter((i.get('athlete') or {}).get('links', [])), {}).get('href', '')
            if '/id/' in href:
                pid = href.split('/id/')[1].split('/')[0]
                report[pid] = {'status': i.get('status', ''), 'note': i.get('shortComment', ''),
                               'back': (i.get('details') or {}).get('returnDate', '')}
    for p in players:
        if p['id'] in report:
            p['inj'] = report[p['id']]

    jobs = [(p, y) for p in players for y in (prev, year)]
    t0 = time.time()
    with ThreadPoolExecutor(10) as ex:
        results = list(ex.map(lambda job: player_stats(job[0]['id'], job[1]), jobs))
    for (p, y), s in zip(jobs, results):
        p.setdefault('s', {})
        if s:
            p['s'][str(y)] = s
    print(f'stats for {len(jobs)} player-seasons in {time.time() - t0:.0f}s:',
          sum(1 for p in players if str(prev) in p['s']), 'with last season,',
          sum(1 for p in players if str(year) in p['s']), 'with this season')

    data = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'ESPN',
        'seasons': {'prev': str(prev), 'cur': str(year), 'prevLabel': season_label(prev), 'curLabel': season_label(year)},
        'teams': teams,
        'players': sorted(players, key=lambda p: p['name']),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', os.path.normpath(OUT), os.path.getsize(OUT) // 1024, 'KB')
    if len(players) < 400:
        sys.exit('suspiciously few players; refusing to call this a good build')


if __name__ == '__main__':
    main()
