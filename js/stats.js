// Player data helpers: season lines, the robot's own ranking, and pool filters.

export const pct = (n, d) => (d ? n / d : 0);

// Per-game line for one season's totals.
export function line(s) {
  if (!s || !s.gp) return null;
  const g = s.gp;
  return {
    gp: g, gs: s.gs || 0, min: s.min || 0,
    mpg: s.min / g, ppg: s.pts / g, rpg: ((s.oreb || 0) + (s.dreb || 0)) / g, apg: s.ast / g,
    spg: s.stl / g, bpg: s.blk / g,
    ts: pct(s.pts, 2 * (s.fga + 0.44 * s.fta)),
    fg3: pct(s.fg3m, s.fg3a),
  };
}

// John Hollinger's Game Score, summed over a season's totals.
export function gameScore(s) {
  return (s.pts || 0) + 0.4 * (s.fgm || 0) - 0.7 * (s.fga || 0) - 0.4 * ((s.fta || 0) - (s.ftm || 0))
    + 0.7 * (s.oreb || 0) + 0.3 * (s.dreb || 0) + (s.stl || 0) + 0.7 * (s.ast || 0)
    + 0.7 * (s.blk || 0) - 0.4 * (s.pf || 0) - (s.tov || 0);
}

// The robot. Last season and this season are pooled, with this season's games counting double.
// Per-36 production is pulled toward a fringe-rotation level until a player has real minutes.
export const ROBOT = {
  curWeight: 2,
  prior36: 6,        // Game Score per 36 of a fringe rotation player
  priorMin: 600,     // minutes of "fringe player" mixed into everyone's per-36 rate
  pmPrior: 1500,     // plus-minus is noisy: smoothed with 1,500 minutes of zero
  weights: { per36: 0.55, perGame: 0.30, onCourt: 0.15 },
};

export function robotScores(data) {
  const { prev, cur } = data.seasons;
  const rows = data.players.map(p => {
    let min = 0, gp = 0, gs = 0, pm = 0, raw = 0;
    for (const [s, w] of [[p.s[prev], 1], [p.s[cur], ROBOT.curWeight]]) {
      if (!s) continue;
      min += w * (s.min || 0); gp += w * (s.gp || 0); gs += w * gameScore(s); pm += w * (s.pm || 0);
      raw += s.min || 0;
    }
    return {
      id: p.id, raw,
      per36: ((gs + ROBOT.prior36 * ROBOT.priorMin / 36) / (min + ROBOT.priorMin)) * 36,
      perGame: gp ? gs / gp : 0,
      onCourt: (pm / (min + ROBOT.pmPrior)) * 36,
    };
  });
  // Standardise each part against players with a real sample, then blend.
  const base = rows.filter(r => r.raw >= 300);
  const norm = {};
  for (const k of Object.keys(ROBOT.weights)) {
    const vals = base.map(r => r[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    norm[k] = { mean, sd };
  }
  const out = new Map();
  for (const r of rows) {
    const z = Object.fromEntries(Object.keys(ROBOT.weights).map(k => [k, (r[k] - norm[k].mean) / norm[k].sd]));
    const score = Object.entries(ROBOT.weights).reduce((a, [k, w]) => a + w * z[k], 0);
    out.set(r.id, { score, z, per36: r.per36, perGame: r.perGame, onCourt: r.onCourt });
  }
  const order = [...out.entries()].sort((a, b) => b[1].score - a[1].score);
  order.forEach(([, v], i) => (v.leagueRank = i + 1));
  return out;
}

// ---------- pool filters ----------

export const PRESETS = {
  stars: { label: 'Stars', hint: "The robot's top 60", f: { robotTop: 60, minMinutes: 0, minGames: 0, minMpg: 0, role: 'all' } },
  starters: { label: 'Starters', hint: 'Started at least half their games', f: { robotTop: 0, minMinutes: 500, minGames: 0, minMpg: 0, role: 'starters' } },
  rotation: { label: 'Rotation players', hint: '1,000+ minutes', f: { robotTop: 0, minMinutes: 1000, minGames: 0, minMpg: 0, role: 'all' } },
  everyone: { label: 'Everyone', hint: 'Every rostered player', f: { robotTop: 0, minMinutes: 0, minGames: 0, minMpg: 0, role: 'all', newcomers: true, newcomerMin: 0 } },
};

export function defaultFilters() {
  return {
    basis: 'prev',          // which season the minute/games/role filters read: prev | cur | both
    minMinutes: 1000,
    minGames: 0,
    minMpg: 0,
    role: 'all',            // all | starters | bench
    newcomers: true,        // players with no stats in the basis season, judged on this season instead
    newcomerMin: 60,
    hideOut: false,         // injured and listed as out
    pos: { G: true, F: true, C: true },
    conf: 'all',
    teams: [],              // empty = every team
    robotTop: 0,            // 0 = no cap
    include: [],            // always in
    exclude: [],            // always out
  };
}

// Season totals the filters judge a player on.
function basisStats(p, f, seasons) {
  const a = p.s[seasons.prev], b = p.s[seasons.cur];
  if (f.basis === 'cur') return b;
  if (f.basis === 'both') {
    if (!a && !b) return null;
    const out = {};
    for (const s of [a, b]) if (s) for (const [k, v] of Object.entries(s)) out[k] = (out[k] || 0) + (v || 0);
    return out;
  }
  return a;
}

export function poolFor(data, robot, f) {
  const include = new Set(f.include), exclude = new Set(f.exclude);
  const ok = data.players.filter(p => {
    if (exclude.has(p.id)) return false;
    if (include.has(p.id)) return true;
    if (!f.pos[p.pos] && p.pos in f.pos) return false;
    if (f.conf !== 'all' && data.teams[p.team]?.conf !== f.conf) return false;
    if (f.teams.length && !f.teams.includes(p.team)) return false;
    if (f.hideOut && p.inj?.status === 'Out') return false;
    const s = basisStats(p, f, data.seasons);
    if (!s || !s.gp) {
      if (!f.newcomers) return false;
      const c = p.s[data.seasons.cur];
      return (c?.min || 0) >= f.newcomerMin;
    }
    if ((s.min || 0) < f.minMinutes) return false;
    if ((s.gp || 0) < f.minGames) return false;
    if (s.min / s.gp < f.minMpg) return false;
    const starter = (s.gs || 0) >= 0.5 * s.gp;
    if (f.role === 'starters' && !starter) return false;
    if (f.role === 'bench' && starter) return false;
    return true;
  });
  let ids = ok.map(p => p.id);
  if (f.robotTop > 0) {
    ids = ids.sort((a, b) => robot.get(b).score - robot.get(a).score)
      .filter((id, i) => i < f.robotTop || include.has(id));
  }
  return ids;
}
