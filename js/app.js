import * as Elo from './elo.js';
import { line, robotScores, ROBOT, PRESETS, defaultFilters, poolFor } from './stats.js';
import { shareUrl, readShared, renderImage, canvasBlob, headshot } from './share.js';

const KEY = 'nbaRanker.v1';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- state ----------

let DATA, ROBOTS, byId;
let S = fresh();
let R = new Map();   // Elo ratings for the current pool, rebuilt from the picks

function fresh() {
  return { filters: defaultFilters(), preset: 'rotation', pool: null, picks: [], current: null, name: '', showStats: true, imgN: 10 };
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) S = { ...fresh(), ...saved, filters: { ...defaultFilters(), ...saved.filters } };
  } catch {}
}
let saveWarned = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch { if (!saveWarned) toast("Couldn't save in this browser (storage full or blocked).", true); saveWarned = true; }
}
function rebuild() {
  // Players who've left every roster since the pool was made drop out quietly.
  if (S.pool) S.pool = S.pool.filter(id => byId.has(id));
  R = Elo.ratings(S.pool || [], S.picks);
}

const player = id => byId.get(id);
const team = p => DATA.teams[p.team] || { name: p.team, color: '#555', logo: '' };

function robotRanks(ids) {
  const order = [...ids].sort((a, b) => ROBOTS.get(b).score - ROBOTS.get(a).score);
  return new Map(order.map((id, i) => [id, i + 1]));
}
function myOrder() {
  return Elo.ranking(R, robotRanks(S.pool || [])).map(r => r.id);
}

// Spearman rank correlation between two orderings of the same ids.
function agreement(orderA, orderB) {
  const common = orderA.filter(id => orderB.includes(id));
  const n = common.length;
  if (n < 3) return null;
  const ra = new Map(common.map((id, i) => [id, i + 1]));
  const rb = new Map(orderB.filter(id => ra.has(id)).map((id, i) => [id, i + 1]));
  let d2 = 0, gap = 0;
  for (const id of common) { const d = ra.get(id) - rb.get(id); d2 += d * d; gap += Math.abs(d); }
  return { rho: 1 - (6 * d2) / (n * (n * n - 1)), gap: gap / n, n, ra, rb };
}

// ---------- ui helpers ----------

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

let view = null;
function show(v) {
  view = v;
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + v;
  $('#tabs').hidden = v === 'loading';
  document.body.classList.toggle('started', !!S.pool);
  for (const b of $$('#tabs button')) {
    b.classList.toggle('on', b.dataset.view === v);
    if (b.dataset.view !== 'setup') b.hidden = !S.pool;
  }
  ({ setup: renderSetup, play: renderPlay, rank: renderRank, compare: renderCompare, share: renderShare }[v] || (() => {}))();
  window.scrollTo(0, 0);
}
for (const b of $$('#tabs button')) b.onclick = () => {
  if (location.hash) history.replaceState(null, '', location.pathname);
  show(b.dataset.view);
};

function injBadge(p) {
  if (!p.inj) return '';
  const cls = p.inj.status === 'Out' ? 'out' : 'dtd';
  return `<span class="badge ${cls}" title="${esc(p.inj.note)}">${esc(p.inj.status)}</span>`;
}
function hsImg(p, w = 120) {
  return `<img class="hs" src="${esc(headshot(p.id, w))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}
function sub(p) {
  return `${esc(p.team)} · ${esc(p.pos)}${p.age ? ' · ' + p.age : ''}`;
}
function deltaHtml(mine, robot) {
  const d = robot - mine;
  if (!d) return '<span class="delta same">=</span>';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}" title="Robot has them #${robot}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

// ---------- setup ----------

function renderPresets() {
  $('#presets').innerHTML = Object.entries(PRESETS).map(([k, p]) =>
    `<button class="preset ghost ${S.preset === k ? 'on' : ''}" data-preset="${k}"><b>${esc(p.label)}</b><span>${esc(p.hint)}</span></button>`).join('');
}
$('#presets').addEventListener('click', e => {
  const k = e.target.closest('[data-preset]')?.dataset.preset;
  if (!k) return;
  const f = S.filters;
  S.filters = { ...defaultFilters(), ...PRESETS[k].f, include: f.include, exclude: f.exclude };
  S.preset = k;
  save();
  renderSetup();
});

function changed() {
  S.preset = null;
  save();
  renderSetup();
}

function bindRange(id, key, label) {
  const el = $(id);
  el.oninput = () => { S.filters[key] = +el.value; $(id + '-val').textContent = label(+el.value); changed(); };
}
bindRange('#f-min', 'minMinutes', v => (v ? v.toLocaleString() + '+' : 'any'));
bindRange('#f-games', 'minGames', v => (v ? v + '+' : 'any'));
bindRange('#f-mpg', 'minMpg', v => (v ? v + '+' : 'any'));
$('#f-top').oninput = () => { S.filters.robotTop = +$('#f-top').value; changed(); };
$('#f-basis').onchange = () => { S.filters.basis = $('#f-basis').value; changed(); };
$('#f-new').onchange = () => { S.filters.newcomers = $('#f-new').checked; changed(); };
$('#f-out').onchange = () => { S.filters.hideOut = $('#f-out').checked; changed(); };
$('#f-role').onclick = e => { const v = e.target.dataset.v; if (v) { S.filters.role = v; changed(); } };
$('#f-conf').onclick = e => { const v = e.target.dataset.v; if (v) { S.filters.conf = v; changed(); } };
$('#f-pos').onclick = e => {
  const v = e.target.dataset.v;
  if (!v) return;
  S.filters.pos[v] = !S.filters.pos[v];
  if (!Object.values(S.filters.pos).some(Boolean)) S.filters.pos[v] = true; // keep at least one
  changed();
};
$('#f-teams').onclick = e => {
  const t = e.target.closest('[data-team]')?.dataset.team;
  if (!t) return;
  const set = new Set(S.filters.teams);
  set.has(t) ? set.delete(t) : set.add(t);
  S.filters.teams = [...set];
  changed();
};

function poolPreview() {
  return poolFor(DATA, ROBOTS, S.filters);
}

function renderSetup() {
  const f = S.filters, { prevLabel, curLabel } = DATA.seasons;
  renderPresets();
  $('#f-basis').innerHTML = [['prev', `Last season (${prevLabel})`], ['cur', `This season so far (${curLabel})`], ['both', 'Both seasons combined']]
    .map(([v, l]) => `<option value="${v}" ${f.basis === v ? 'selected' : ''}>${l}</option>`).join('');
  for (const [id, key, lab] of [['#f-min', 'minMinutes', v => (v ? v.toLocaleString() + '+' : 'any')], ['#f-games', 'minGames', v => (v ? v + '+' : 'any')], ['#f-mpg', 'minMpg', v => (v ? v + '+' : 'any')]]) {
    $(id).value = f[key];
    $(id + '-val').textContent = lab(f[key]);
  }
  $('#f-top').value = f.robotTop;
  $('#f-top-val').textContent = f.robotTop ? f.robotTop : 'no limit';
  for (const b of $$('#f-role button')) b.classList.toggle('on', b.dataset.v === f.role);
  for (const b of $$('#f-conf button')) b.classList.toggle('on', b.dataset.v === f.conf);
  for (const b of $$('#f-pos button')) b.classList.toggle('on', !!f.pos[b.dataset.v]);
  $('#f-new').checked = f.newcomers;
  $('#f-new-label').textContent = f.basis === 'cur'
    ? `Include players who haven't played yet this season`
    : `Include rookies and players with no ${f.basis === 'both' ? 'NBA' : prevLabel} stats (judged on this season, ${f.newcomerMin}+ minutes)`;
  $('#f-out').checked = f.hideOut;
  $('#f-teams').innerHTML = Object.entries(DATA.teams).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([abbr, t]) =>
    `<button class="ghost ${f.teams.includes(abbr) ? 'on' : ''}" data-team="${abbr}"><img src="${esc(t.logo)}" alt="" loading="lazy">${esc(abbr)}</button>`).join('');
  $('#f-teams-sum').textContent = f.teams.length ? f.teams.join(', ') : 'All 30';

  const ids = poolPreview();
  const n = ids.length;
  $('#pool-count').textContent = n;
  const est = l => Math.ceil((l * n) / 2).toLocaleString();
  $('#pool-est').textContent = n < 2 ? 'Pick at least 2 players.'
    : `About ${est(4)} picks for a rough ranking, ${est(8)} for a solid one. Stop whenever you like.`;

  const started = !!S.pool;
  $('#setup-title').textContent = started ? 'Players in your ranking' : 'Rank every NBA player.';
  $('#setup-lede').hidden = started;
  if (started) {
    const cur = new Set(S.pool), next = new Set(ids);
    const add = ids.filter(id => !cur.has(id)).length, rm = S.pool.filter(id => !next.has(id)).length;
    $('#start-btn').textContent = add || rm ? `Apply changes (+${add} / −${rm})` : 'Back to matchups';
  } else {
    $('#start-btn').textContent = 'Start ranking';
  }
  $('#start-btn').disabled = n < 2;

  const robotOrder = [...ids].sort((a, b) => ROBOTS.get(b).score - ROBOTS.get(a).score);
  $('#pool-list').innerHTML = robotOrder.map(id => poolRow(player(id), true)).join('');
  renderPoolSearch();
  renderRobotAbout();
  $('#data-note').textContent = `Stats from ESPN, updated ${new Date(DATA.generated).toLocaleString()}. Last season = ${prevLabel} regular season; this season = ${curLabel} so far. Rosters and injuries refresh daily.`;
}

function poolRow(p, inPool) {
  const f = S.filters;
  const forced = f.include.includes(p.id) ? ' <span class="badge">added by you</span>' : '';
  return `<li class="clickable" data-player="${p.id}">${hsImg(p, 90)}
    <div class="t-main"><div class="t-name">${esc(p.name)}${injBadge(p)}${forced}</div><div class="t-sub">${sub(p)} · robot #${ROBOTS.get(p.id).leagueRank}</div></div>
    <button class="ghost small" data-toggle-pool="${p.id}">${inPool ? 'Remove' : 'Add'}</button></li>`;
}

function renderPoolSearch() {
  const q = $('#pool-search').value.trim().toLowerCase();
  if (q.length < 2) { $('#pool-results').innerHTML = ''; return; }
  const inPool = new Set(poolPreview());
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hits = DATA.players.filter(p => norm(p.name).includes(norm(q))).slice(0, 8);
  $('#pool-results').innerHTML = hits.map(p => poolRow(p, inPool.has(p.id))).join('') || '<li><span></span><span class="hint">No player by that name on a current roster.</span></li>';
}
$('#pool-search').addEventListener('input', renderPoolSearch);

$('#view-setup').addEventListener('click', e => {
  const id = e.target.closest('[data-toggle-pool]')?.dataset.togglePool;
  if (id) {
    e.stopPropagation();
    const f = S.filters, inPool = poolPreview().includes(id);
    f.include = f.include.filter(x => x !== id);
    f.exclude = f.exclude.filter(x => x !== id);
    (inPool ? f.exclude : f.include).push(id);
    save();
    renderSetup();
    return;
  }
  const pid = e.target.closest('[data-player]')?.dataset.player;
  if (pid) showPlayer(pid);
});

$('#start-btn').onclick = () => {
  const ids = poolPreview();
  if (ids.length < 2) return;
  if (!S.pool) {
    S.pool = ids;
    S.picks = [];
    S.current = null;
  } else {
    const before = new Set(S.pool);
    const add = ids.filter(id => !before.has(id)).length;
    S.pool = ids;
    if (S.current && !S.current.every(id => ids.includes(id))) S.current = null;
    if (add) toast(`${add} new player${add > 1 ? 's' : ''} start at ${Elo.START} and get matched up first.`);
  }
  rebuild();
  save();
  show('play');
};

function renderRobotAbout() {
  const w = ROBOT.weights, { prevLabel, curLabel } = DATA.seasons;
  $('#robot-about').innerHTML = `
    <p>The robot only looks at stats. Its score blends three things:</p>
    <ul>
      <li><b>${Math.round(w.per36 * 100)}%: production per 36 minutes.</b> John Hollinger's Game Score: points, rebounds, assists, steals and blocks, minus missed shots, turnovers and fouls.</li>
      <li><b>${Math.round(w.perGame * 100)}%: production per game.</b> The same score per game played, which rewards players who carry a big role.</li>
      <li><b>${Math.round(w.onCourt * 100)}%: team plus-minus with him on court.</b> Heavily smoothed, because it's noisy.</li>
    </ul>
    <p><b>${prevLabel}</b> and <b>${curLabel}</b> are pooled, with this season's games counting ${ROBOT.curWeight}×, so the robot leans on last season now and shifts to this one as games pile up.
    Players with few minutes are pulled toward a fringe-rotation level (as if they'd also played ${ROBOT.priorMin} quiet minutes), so a hot week can't make a star.</p>
    <p>What it misses: most defense, injuries (a player who missed the year has little to go on) and anything the box score can't see. That's where you come in.</p>`;
}

// ---------- matchups ----------

function statTable(p) {
  const { prev, cur, prevLabel, curLabel } = DATA.seasons;
  const rows = [[prevLabel, line(p.s[prev])], [curLabel, line(p.s[cur])]].filter(([, l]) => l);
  if (!rows.length) return '<p class="hint">No NBA regular-season stats yet.</p>';
  return `<table class="statline"><tr><th></th><th>PTS</th><th>REB</th><th>AST</th><th class="wide">STL</th><th class="wide">BLK</th><th>TS%</th><th class="wide">MIN</th><th>GP</th></tr>
    ${rows.map(([lab, l]) => `<tr><td>${lab.slice(2)}</td><td>${fmt1(l.ppg)}</td><td>${fmt1(l.rpg)}</td><td>${fmt1(l.apg)}</td><td class="wide">${fmt1(l.spg)}</td><td class="wide">${fmt1(l.bpg)}</td><td>${Math.round(l.ts * 100)}</td><td class="wide">${Math.round(l.mpg)}</td><td>${l.gp}</td></tr>`).join('')}
  </table>`;
}

function sideHtml(p, side) {
  const t = team(p);
  return `<div class="photo" style="--tc:${esc(t.color)}">
      <img class="face" src="${esc(headshot(p.id, 520))}" alt="" onerror="this.style.visibility='hidden'">
      ${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="${esc(t.name)}">` : ''}
    </div>
    <div class="side-body">
      <h2>${esc(p.name)}</h2>
      <p class="sub">${esc(t.nick || t.name)} · ${esc(p.pos)}${p.age ? ' · ' + p.age : ''}${injBadge(p)}</p>
      ${statTable(p)}
      <button class="pick primary big" data-pick="${side}">${side === 'a' ? 'This one <kbd>←</kbd>' : 'This one <kbd>→</kbd>'}</button>
    </div>`;
}

const undoStack = [];
function ensurePair() {
  const valid = S.current && S.current.every(id => R.has(id)) && S.current[0] !== S.current[1];
  if (!valid) {
    const last = S.picks[S.picks.length - 1];
    S.current = Elo.nextPair(R, { avoid: last ? [last[0], last[1]] : [] });
    save();
  }
  return S.current;
}

function renderPlay() {
  if (!S.pool) return show('setup');
  const pr = Elo.progress(R, S.picks.length);
  $('#lvl-label').textContent = pr.label;
  $('#lvl-detail').textContent = `${S.picks.length.toLocaleString()} picks · ${R.size} players · ${fmt1(pr.avg)} matchups each` +
    (pr.next ? ` · ${pr.picksToNext.toLocaleString()} more to "${pr.next.label}"` : '');
  $('#lvl-bar').style.width = Math.min(100, pr.frac * 100) + '%';
  $('#undo-btn').disabled = !S.picks.length;
  $('#show-stats').checked = S.showStats;
  $('#matchup').classList.toggle('hide-stats', !S.showStats);
  const pair = ensurePair();
  if (!pair) return;
  pair.forEach((id, i) => {
    const el = $(`.side[data-side=${i ? 'b' : 'a'}]`);
    el.classList.remove('chosen');
    el.innerHTML = sideHtml(player(id), i ? 'b' : 'a');
  });
}

function choose(w) {
  if (view !== 'play' || !S.current) return;
  const [a, b] = S.current;
  const res = w === 'a' ? 1 : w === 'b' ? 0 : 0.5;
  undoStack.push(S.current);
  S.picks.push([a, b, res]);
  if (w !== 't') $(`.side[data-side=${w}]`).classList.add('chosen');
  S.current = null;
  rebuild();
  save();
  setTimeout(renderPlay, w === 't' ? 0 : 140);
}
function skip() {
  if (!S.current) return;
  const avoid = [...S.current];
  S.current = Elo.nextPair(R, { avoid });
  save();
  renderPlay();
}
function undo() {
  if (!S.picks.length) return toast('Nothing to undo');
  const [a, b] = S.picks.pop();
  S.current = undoStack.pop() || [a, b];
  rebuild();
  save();
  renderPlay();
  toast('Undone');
}

$('#matchup').addEventListener('click', e => {
  const p = e.target.closest('[data-pick]')?.dataset.pick;
  if (p) return choose(p);
});
$('#tie-btn').onclick = () => choose('t');
$('#skip-btn').onclick = skip;
$('#undo-btn').onclick = undo;
$('#show-stats').onchange = () => { S.showStats = $('#show-stats').checked; save(); renderPlay(); };

document.addEventListener('keydown', e => {
  if (view !== 'play' || e.target.matches?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey || $('#player-dlg').open) return;
  const act = {
    arrowleft: () => choose('a'), 1: () => choose('a'),
    arrowright: () => choose('b'), 2: () => choose('b'),
    arrowdown: () => choose('t'), t: () => choose('t'),
    s: skip, z: undo, backspace: undo,
  }[e.key.toLowerCase()];
  if (act) { e.preventDefault(); act(); }
});

// ---------- my ranking ----------

function renderRank() {
  if (!S.pool) return show('setup');
  const order = Elo.ranking(R, robotRanks(S.pool));
  const rr = robotRanks(S.pool);
  const pr = Elo.progress(R, S.picks.length);
  $('#rank-summary').textContent = `${order.length} players · ${S.picks.length.toLocaleString()} picks · ${pr.label.toLowerCase()} (${fmt1(pr.avg)} matchups each). The arrows show where the robot has them.`;
  const q = $('#rank-search').value.trim().toLowerCase();
  const pos = $('#rank-pos').dataset.v || '';
  for (const b of $$('#rank-pos button')) b.classList.toggle('on', b.dataset.v === pos);
  $('#rank-list').innerHTML = order.map((r, i) => {
    const p = player(r.id);
    if (q && !p.name.toLowerCase().includes(q)) return '';
    if (pos && p.pos !== pos) return '';
    return `<li class="clickable" data-player="${p.id}"><span class="pos">${i + 1}</span>${hsImg(p)}
      <div class="t-main"><div class="t-name">${esc(p.name)}${injBadge(p)}</div><div class="t-sub">${sub(p)} · ${r.w}–${r.l}${r.t ? '–' + r.t : ''}</div></div>
      <div class="t-right"><b>${Math.round(r.r)}</b> ${deltaHtml(i + 1, rr.get(r.id))}</div></li>`;
  }).join('');
}
$('#rank-search').addEventListener('input', renderRank);
$('#rank-pos').onclick = e => { if (e.target.dataset.v !== undefined) { $('#rank-pos').dataset.v = e.target.dataset.v; renderRank(); } };
$('#rank-list').addEventListener('click', e => { const id = e.target.closest('[data-player]')?.dataset.player; if (id) showPlayer(id); });

// ---------- you vs the robot ----------

function tiles(a, extra = []) {
  if (!a) return '';
  const pctAgree = Math.round(Math.max(0, a.rho) * 100);
  return [[pctAgree + '%', 'rank agreement (Spearman)'], [fmt1(a.gap), 'places apart on average'], ...extra]
    .map(([num, lbl]) => `<div class="tile"><div class="num">${num}</div><div class="lbl">${esc(lbl)}</div></div>`).join('');
}

function diffList(rows) {
  return rows.map(({ id, mine, robot }) => {
    const p = player(id);
    return `<li class="clickable" data-player="${id}"><span class="pos">${mine}</span>${hsImg(p, 90)}
      <div class="t-main"><div class="t-name">${esc(p.name)}</div><div class="t-sub">You #${mine} · robot #${robot}</div></div>
      <div class="t-right">${deltaHtml(mine, robot)}</div></li>`;
  }).join('');
}

function scatterSvg(ids, mine, robot) {
  const n = ids.length, S2 = 600, pad = 36, sc = v => pad + ((v - 1) / Math.max(1, n - 1)) * (S2 - 2 * pad);
  const dots = ids.map(id => {
    const m = mine.get(id), r = robot.get(id), d = r - m;
    const col = Math.abs(d) <= n * 0.05 ? '#a49c92' : d > 0 ? '#4ade80' : '#f87171';
    return `<circle class="dot" data-player="${id}" cx="${sc(r).toFixed(1)}" cy="${sc(m).toFixed(1)}" r="${n > 200 ? 3.5 : 5}" fill="${col}" fill-opacity=".8"><title>${esc(player(id).name)}: you #${m}, robot #${r}</title></circle>`;
  }).join('');
  return `<svg viewBox="0 0 ${S2} ${S2}" role="img" aria-label="Your rank against the robot's rank for every player">
    <line x1="${pad}" y1="${pad}" x2="${S2 - pad}" y2="${S2 - pad}" stroke="#2c2a33" stroke-width="2"/>
    <text x="${S2 / 2}" y="${S2 - 8}" fill="#a49c92" font-size="14" text-anchor="middle">Robot's rank (1 → ${n})</text>
    <text x="14" y="${S2 / 2}" fill="#a49c92" font-size="14" text-anchor="middle" transform="rotate(-90 14 ${S2 / 2})">Your rank (1 → ${n})</text>
    ${dots}</svg>`;
}

function renderCompare() {
  if (!S.pool) return show('setup');
  const mineOrder = myOrder();
  const robotOrder = [...S.pool].sort((a, b) => ROBOTS.get(b).score - ROBOTS.get(a).score);
  const a = agreement(mineOrder, robotOrder);
  const top10 = mineOrder.slice(0, 10).filter(id => robotOrder.slice(0, 10).includes(id)).length;
  $('#cmp-tiles').innerHTML = tiles(a, [[`${top10}/10`, 'of your top 10 are in the robot\'s'], [esc(player(robotOrder[0]).name.split(' ').slice(-1)[0]), "is the robot's #1"]]);
  if (S.picks.length < R.size) {
    $('#cmp-tiles').innerHTML += `<div class="tile"><div class="lbl">Heads up: with ${S.picks.length} picks for ${R.size} players your ranking is still mostly unsorted, so this comparison will move a lot.</div></div>`;
  }
  // Biggest disagreements, scaled so a 5-place gap at the top counts more than 5 places at #250.
  const rows = mineOrder.map((id, i) => ({ id, mine: i + 1, robot: a.rb.get(id) }));
  const weight = r => (r.robot - r.mine) / Math.sqrt((r.robot + r.mine) / 2);
  $('#cmp-you').innerHTML = diffList([...rows].sort((x, y) => weight(y) - weight(x)).filter(r => r.robot > r.mine).slice(0, 10));
  $('#cmp-robot').innerHTML = diffList([...rows].sort((x, y) => weight(x) - weight(y)).filter(r => r.robot < r.mine).slice(0, 10));
  $('#scatter').innerHTML = scatterSvg(mineOrder, a.ra, a.rb);
  const top = 25, inBoth = new Set(mineOrder.slice(0, top).filter(id => robotOrder.slice(0, top).includes(id)));
  const col = (title, order) => `<div><h3>${title}</h3>${order.slice(0, top).map((id, i) =>
    `<div class="sbs-row ${inBoth.has(id) ? 'match' : ''}"><span class="n">${i + 1}</span><span class="name">${esc(player(id).name)}</span></div>`).join('')}</div>`;
  $('#cmp-top').innerHTML = col('You', mineOrder) + col('Robot', robotOrder);
}
$('#view-compare').addEventListener('click', e => { const id = e.target.closest('[data-player]')?.getAttribute('data-player'); if (id) showPlayer(id); });

// ---------- share ----------

function shareTitle(n) {
  return S.name ? `${S.name}'s top ${n} NBA players` : `My top ${n} NBA players`;
}
function myAgreementPct() {
  const robotOrder = [...S.pool].sort((a, b) => ROBOTS.get(b).score - ROBOTS.get(a).score);
  const a = agreement(myOrder(), robotOrder);
  return a ? Math.round(Math.max(0, a.rho) * 100) : null;
}
function link() {
  return shareUrl({ ids: myOrder(), name: S.name, date: today() });
}

let imgCanvas = null, imgSeq = 0;
async function renderImg() {
  const seq = ++imgSeq, n = S.imgN, order = myOrder();
  for (const b of $$('#img-n button')) b.classList.toggle('on', +b.dataset.v === n);
  $('#img-preview').style.opacity = .4;
  const rr = robotRanks(S.pool);
  const agree = myAgreementPct();
  const c = await renderImage({
    rows: order.map(id => ({ id, name: player(id).name, team: player(id).team, robotRank: rr.get(id) })),
    n, teams: DATA.teams,
    title: shareTitle(Math.min(n, order.length)),
    subtitle: `Ranked head to head · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    footer: `ellioshow1.github.io/nba-ranker${agree != null ? ` · ${agree}% agreement with the robot` : ''}`,
  });
  if (seq !== imgSeq) return;
  imgCanvas = c;
  $('#img-preview').src = c.toDataURL('image/png');
  $('#img-preview').style.opacity = 1;
}

function renderShare() {
  if (!S.pool) return show('setup');
  $('#share-name').value = S.name;
  renderImg();
}
$('#share-name').addEventListener('change', () => { S.name = $('#share-name').value.trim(); save(); renderImg(); });
$('#img-n').onclick = e => { const v = +e.target.dataset.v; if (v) { S.imgN = v; save(); renderImg(); } };

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast('Clipboard blocked by the browser', true); }
}
$('#copy-link').onclick = () => copy(link(), 'Link copied');
$('#share-link').onclick = async () => {
  const url = link();
  if (navigator.share) {
    try { await navigator.share({ title: shareTitle(10), text: 'My NBA player ranking. Make yours and compare:', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url, 'Link copied');
};
$('#copy-text').onclick = () => copy(
  [shareTitle(25)].concat(myOrder().slice(0, 25).map((id, i) => `${i + 1}. ${player(id).name} (${player(id).team})`)).concat(['', link()]).join('\n'),
  'Copied your top 25');
async function imageFile() {
  if (!imgCanvas) await renderImg();
  const blob = await canvasBlob(imgCanvas);
  return new File([blob], `nba-top-${S.imgN}.png`, { type: 'image/png' });
}
$('#dl-img').onclick = async () => {
  const f = await imageFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#share-img').onclick = async () => {
  const f = await imageFile();
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: shareTitle(S.imgN), text: link() }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#dl-img').click();
  toast("This browser can't share images directly, so it was downloaded instead.");
};
$('#reset').onclick = () => {
  if (!confirm('Throw away every pick and start your ranking over?')) return;
  S.pool = null; S.picks = []; S.current = null;
  rebuild();
  save();
  show('setup');
};

// ---------- someone else's ranking ----------

function renderShared(sh) {
  show('shared');
  $('#tabs').hidden = !S.pool;
  const ids = sh.ids.filter(id => byId.has(id));
  const who = sh.name || 'Someone';
  $('#shared-title').textContent = `${who}'s NBA ranking`;
  $('#shared-lede').textContent = `${ids.length} players${sh.date ? ` · ranked ${new Date(sh.date + 'T12:00').toLocaleDateString()}` : ''}${ids.length < sh.ids.length ? ` · ${sh.ids.length - ids.length} no longer on a roster` : ''}. Arrows show where the robot has them.`;
  const robotOrder = [...ids].sort((a, b) => ROBOTS.get(b).score - ROBOTS.get(a).score);
  const vsRobot = agreement(ids, robotOrder);
  let extra = [];
  let mine = null;
  if (S.pool && S.picks.length) {
    const vsMe = agreement(ids, myOrder());
    if (vsMe && vsMe.n >= 5) {
      extra = [[Math.round(Math.max(0, vsMe.rho) * 100) + '%', `agreement with your ranking (${vsMe.n} shared players)`]];
      mine = vsMe.rb;
    }
  }
  $('#shared-tiles').innerHTML = vsRobot ? tiles(vsRobot).replace('rank agreement (Spearman)', 'agreement with the robot') + extra.map(([n, l]) => `<div class="tile"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('') : '';
  const rr = new Map(robotOrder.map((id, i) => [id, i + 1]));
  $('#shared-list').innerHTML = ids.map((id, i) => {
    const p = player(id);
    return `<li class="clickable" data-player="${id}"><span class="pos">${i + 1}</span>${hsImg(p)}
      <div class="t-main"><div class="t-name">${esc(p.name)}</div><div class="t-sub">${sub(p)}${mine?.get(id) ? ` · you #${mine.get(id)}` : ''}</div></div>
      <div class="t-right">${deltaHtml(i + 1, rr.get(id))}</div></li>`;
  }).join('');
  $('#shared-mine').textContent = S.pool ? 'Back to my ranking' : 'Make my own';
}
$('#shared-mine').onclick = () => {
  history.replaceState(null, '', location.pathname);
  show(S.pool ? 'compare' : 'setup');
};
$('#shared-list').addEventListener('click', e => { const id = e.target.closest('[data-player]')?.dataset.player; if (id) showPlayer(id); });

// ---------- player card ----------

function showPlayer(id) {
  const p = player(id), t = team(p), rb = ROBOTS.get(id);
  const inPool = S.pool?.includes(id);
  let mineHtml = '';
  if (inPool) {
    const order = myOrder(), r = R.get(id);
    mineHtml = `<tr><td>Your rank</td><td>#${order.indexOf(id) + 1} of ${order.length} · Elo ${Math.round(r.r)} · ${r.w}–${r.l}${r.t ? '–' + r.t : ''}</td></tr>`;
  }
  const pctile = z => Math.round(100 * (0.5 * (1 + erf(z / Math.SQRT2))));
  $('#player-dlg').innerHTML = `
    <div class="photo" style="--tc:${esc(t.color)}"><img class="face" src="${esc(headshot(id, 520))}" alt="" onerror="this.style.visibility='hidden'">${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="">` : ''}</div>
    <div class="dlg-body">
      <h2>${esc(p.name)}${injBadge(p)}</h2>
      <p class="hint">${esc(t.name)} · ${esc(p.pos)}${p.jersey ? ' · #' + esc(p.jersey) : ''}${p.age ? ' · age ' + p.age : ''}${p.ht ? ' · ' + esc(p.ht) : ''} · ${p.exp ? p.exp + ' yrs in the NBA' : 'rookie'}</p>
      ${p.inj ? `<p class="hint">${esc(p.inj.note)}</p>` : ''}
      ${statTable(p)}
      <table class="robot-parts">
        ${mineHtml}
        <tr><td>Robot rank</td><td>#${rb.leagueRank} in the NBA</td></tr>
        <tr><td>Production per 36</td><td>${fmt1(rb.per36)} (better than ${pctile(rb.z.per36)}%)</td></tr>
        <tr><td>Production per game</td><td>${fmt1(rb.perGame)} (better than ${pctile(rb.z.perGame)}%)</td></tr>
        <tr><td>On-court plus-minus per 36</td><td>${rb.onCourt >= 0 ? '+' : ''}${fmt1(rb.onCourt)} (better than ${pctile(rb.z.onCourt)}%)</td></tr>
      </table>
      <div class="row"><button class="ghost" id="dlg-close">Close</button></div>
    </div>`;
  $('#dlg-close').onclick = () => $('#player-dlg').close();
  $('#player-dlg').showModal();
}
$('#player-dlg').addEventListener('click', e => { if (e.target.id === 'player-dlg') e.target.close(); });

// Abramowitz-Stegun approximation, for "better than X%" from a z-score.
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

// ---------- boot ----------

function route() {
  const sh = readShared();
  if (sh) return renderShared(sh);
  show(S.pool ? 'play' : 'setup');
}
window.addEventListener('hashchange', route);

async function boot() {
  try {
    const res = await fetch('data/players.json', { cache: 'no-cache' });
    DATA = await res.json();
  } catch {
    $('#view-loading').innerHTML = '<p class="lede">Couldn\'t load the player data. Check your connection and refresh.</p>';
    return;
  }
  byId = new Map(DATA.players.map(p => [p.id, p]));
  ROBOTS = robotScores(DATA);
  load();
  rebuild();
  route();
}
boot();

// Exposed for debugging in the console.
window.nbaRanker = { get state() { return S; }, get ratings() { return R; }, get data() { return DATA; }, robot: () => ROBOTS, Elo };
