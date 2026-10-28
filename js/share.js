// Sharing: a link that carries the whole ranking, and a PNG image of the top of it.

// ---------- links ----------
// ESPN player ids fit in 3 bytes, so a ranking is just ids packed back to back, base64url encoded.

const toB64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function encodeIds(ids) {
  const bytes = new Uint8Array(ids.length * 3);
  ids.forEach((id, i) => {
    const n = Number(id);
    bytes[i * 3] = (n >> 16) & 255;
    bytes[i * 3 + 1] = (n >> 8) & 255;
    bytes[i * 3 + 2] = n & 255;
  });
  return toB64(bytes);
}

export function decodeIds(s) {
  const b = fromB64(s);
  const ids = [];
  for (let i = 0; i + 2 < b.length; i += 3) ids.push(String((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]));
  return ids;
}

export function shareUrl({ ids, name, date }) {
  const q = new URLSearchParams();
  if (name) q.set('n', name);
  if (date) q.set('d', date);
  q.set('r', encodeIds(ids));
  return location.origin + location.pathname.replace(/index\.html$/, '') + '#' + q.toString();
}

export function readShared(hash = location.hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  if (!q.has('r')) return null;
  try {
    return { ids: decodeIds(q.get('r')), name: q.get('n') || '', date: q.get('d') || '' };
  } catch {
    return null;
  }
}

// ---------- image ----------

const W = 1080;
const LAYOUTS = {
  10: { cols: 1, rowH: 104 },
  25: { cols: 2, rowH: 118 },
  50: { cols: 2, rowH: 66 },
};

export const headshot = (id, w = 260) =>
  `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=${w}&h=${Math.round(w * 0.73)}&scale=crop`;

function loadImage(src) {
  return new Promise(res => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
    setTimeout(() => res(null), 8000);
  });
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

// "Shai Gilgeous-Alexander" -> "S. Gilgeous-Alexander" before resorting to an ellipsis.
function fitName(ctx, name, max) {
  if (ctx.measureText(name).width <= max) return name;
  const [first, ...rest] = name.split(' ');
  return rest.length ? fit(ctx, `${first[0]}. ${rest.join(' ')}`, max) : fit(ctx, name, max);
}

// Draws img into the box, cropped to fill it (like object-fit: cover, anchored at the top).
function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, 0, sw, sh, x, y, w, h);
}

// rows: [{ id, name, team, robotRank }] in ranked order. Returns a canvas.
export async function renderImage({ rows, n, title, subtitle, footer, teams }) {
  const L = LAYOUTS[n] || LAYOUTS[10];
  const shown = rows.slice(0, n);
  const perCol = Math.ceil(shown.length / L.cols);
  const head = 230, foot = 90, pad = 48;
  const H = head + perCol * L.rowH + foot;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  await document.fonts?.load?.('700 40px "Space Grotesk"').catch(() => {});
  const font = (w, s) => `${w} ${s}px "Space Grotesk", system-ui, sans-serif`;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#16110c'); g.addColorStop(1, '#0a0a0d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ff7a1a'; ctx.fillRect(0, 0, W, 10);

  ctx.fillStyle = '#ff9a4a'; ctx.font = font(600, 26);
  ctx.fillText(subtitle.toUpperCase(), pad, 78);
  ctx.fillStyle = '#f4f1ec'; ctx.font = font(700, 62);
  ctx.fillText(fit(ctx, title, W - 2 * pad), pad, 150);

  const imgs = await Promise.all(shown.map(r => loadImage(headshot(r.id, 200))));
  const colW = (W - 2 * pad - (L.cols - 1) * 28) / L.cols;
  shown.forEach((r, i) => {
    const col = Math.floor(i / perCol), row = i % perCol;
    const x = pad + col * (colW + 28), y = head + row * L.rowH;
    const h = L.rowH - 10;
    const team = teams[r.team] || {};
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.roundRect(x, y, colW, h, 14); ctx.fill();
    ctx.fillStyle = team.color || '#777';
    ctx.beginPath(); ctx.roundRect(x, y, 8, h, [14, 0, 0, 14]); ctx.fill();

    // One wide column (top 10), two roomy columns (top 25) or two tight ones (top 50).
    const wide = L.cols === 1, tight = L.rowH < 90;
    ctx.fillStyle = i < 3 ? '#ff9a4a' : '#f4f1ec';
    ctx.font = font(700, wide ? 40 : tight ? 26 : 32);
    ctx.textAlign = 'right';
    const rankW = wide ? 78 : tight ? 52 : 58;
    ctx.fillText(String(i + 1), x + rankW, y + h / 2 + (wide ? 14 : tight ? 9 : 11));
    ctx.textAlign = 'left';

    const ih = h - 8, iw = wide ? ih * 1.37 : ih, ix = x + rankW + 12, iy = y + 4;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(ix, iy, iw, ih, 10); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(ix, iy, iw, ih);
    if (imgs[i]) cover(ctx, imgs[i], ix, iy, iw, ih);
    ctx.restore();

    const tx = ix + iw + 14, maxW = x + colW - tx - 12;
    const robot = r.robotRank ? ` · robot #${r.robotRank}` : '';
    ctx.fillStyle = '#f4f1ec'; ctx.font = font(700, wide ? 34 : tight ? 22 : 27);
    if (tight) {
      ctx.fillText(fitName(ctx, r.name, maxW), tx, y + h / 2 + 8);
    } else {
      ctx.fillText(fitName(ctx, r.name, maxW), tx, y + h / 2 - 4);
      ctx.fillStyle = '#a49c92'; ctx.font = font(500, wide ? 22 : 19);
      ctx.fillText(fit(ctx, (wide ? team.name || r.team : r.team) + robot, maxW), tx, y + h / 2 + (wide ? 30 : 26));
    }
  });

  ctx.fillStyle = '#a49c92'; ctx.font = font(500, 24);
  ctx.fillText(footer, pad, H - 38);
  return c;
}

export function canvasBlob(c) {
  return new Promise(res => c.toBlob(res, 'image/png'));
}
