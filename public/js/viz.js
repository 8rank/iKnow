/* viz.js — the chart primitives. Hand-rolled SVG, no dependencies.
 *
 * Every chart in this app is built from these. The specs below are fixed and
 * deliberate, not preferences:
 *
 *   bars      <=24px thick, 4px rounded data-end, square at the baseline
 *   lines     2px, round join and cap
 *   markers   >=8px diameter, 2px ring in the surface colour
 *   areas     the series hue at 10% opacity — a wash, never a block
 *   grid      1px solid, one step off the surface, recessive
 *   gaps      2px of surface between touching marks, one consistent width
 *   legend    always present at >=2 series, never for 1
 *   labels    selective — the endpoint, the extreme, the one that matters
 *   text      always a text token; identity comes from the swatch beside it
 *
 * Series colours are assigned in fixed slot order and never cycled. A ninth
 * series folds into "other" — there is no ninth hue.
 *
 * All label text goes in via textContent. Names here come from a personal data
 * store and routinely contain characters that would break an innerHTML string.
 */

export const SERIES = n => `var(--series-${(n % 8) + 1})`;
export const SERIES_MAX = 8;

const NS = 'http://www.w3.org/2000/svg';

/* ---------- small helpers ---------- */

export const el = (tag, attrs = {}, kids = []) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
};

export const h = (tag, attrs = {}, kids = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;      // never innerHTML
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
};

/** Compact for display: 1,284 · 12.9K · 4.2M. Full value stays in the tooltip. */
export const compact = n => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

export const full = n =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 4 });

export const pct = (n, d) => (!d ? '0%' : Math.round((n / d) * 100) + '%');

export const day = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—');
export const month = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 7) : '—');

/** Axis ticks on clean numbers. */
export const ticks = (max, count = 4) => {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
};

/* ---------- the tooltip (one per page) ---------- */

let tip;
const tipEl = () => {
  if (!tip) {
    tip = h('div', { class: 'viz-tip', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(tip);
  }
  return tip;
};

/** rows: [{label, value, color?}] — value leads, label follows, line keys not boxes. */
export function showTip(ev, title, rows) {
  const t = tipEl();
  t.textContent = '';
  if (title) t.appendChild(h('div', { class: 'viz-tip-title', text: title }));
  for (const r of rows) {
    const row = h('div', { class: 'viz-tip-row' });
    if (r.color) {
      const key = h('span', { class: 'viz-tip-key' });
      key.style.background = r.color;
      row.appendChild(key);
    }
    row.appendChild(h('span', { class: 'viz-tip-val', text: r.value }));
    row.appendChild(h('span', { class: 'viz-tip-lab', text: r.label }));
    t.appendChild(row);
  }
  t.classList.add('on');
  moveTip(ev);
}

export function moveTip(ev) {
  if (!tip) return;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

export const hideTip = () => tip && tip.classList.remove('on');

/* ---------- legend + table view ---------- */

/** Always for >=2 series, never for 1. `mark` mirrors the chart: rect or line. */
export function legend(items, mark = 'rect') {
  if (!items || items.length < 2) return null;
  const box = h('div', { class: 'viz-legend' });
  for (const it of items) {
    const key = h('span', { class: `viz-key viz-key-${mark}` });
    key.style.background = it.color;
    box.appendChild(h('span', { class: 'viz-legend-item' }, [key, h('span', { text: it.label })]));
  }
  return box;
}

/** A key that explains a figure in words: term on the left, definition on the
 *  right. The terms share one column sized to the longest, so a term never
 *  breaks and every definition wraps from the same left edge. */
export function keyList(rows) {
  const box = h('div', { class: 'key-list' });
  for (const [term, def] of rows) {
    box.appendChild(h('div', { class: 'key-row' }, [
      h('span', { class: 'key-term', text: term }),
      h('span', { class: 'key-def', text: def }),
    ]));
  }
  return box;
}

/** Every chart ships a table view: the tooltip enhances, it never gates. */
export function tableView(columns, rows) {
  const wrap = h('div', { class: 'viz-table-wrap' });
  const table = h('table', { class: 'viz-table' });
  const thead = h('thead');
  thead.appendChild(h('tr', {}, columns.map(c => h('th', { text: c }))));
  table.appendChild(thead);
  const tbody = h('tbody');
  for (const r of rows) {
    tbody.appendChild(h('tr', {}, r.map(v => h('td', { text: v === null || v === undefined ? '—' : String(v) }))));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** Wraps a chart in a card with a title and a "table" toggle that reveals rows. */
export function figure({ title, note, chart, table, wide, legend: leg }) {
  const card = h('section', { class: 'card' + (wide ? ' card-wide' : '') });
  const head = h('header', { class: 'card-head' });
  if (title) head.appendChild(h('h3', { text: title }));
  if (table) {
    const btn = h('button', {
      class: 'ghost', type: 'button', text: 'table', 'aria-expanded': 'false',
      onclick: () => {
        const open = table.classList.toggle('on');
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'chart' : 'table';
      },
    });
    head.appendChild(btn);
  }
  card.appendChild(head);
  if (note) card.appendChild(h('p', { class: 'card-note', text: note }));
  if (leg) card.appendChild(leg);
  if (chart) card.appendChild(chart);
  if (table) { table.classList.add('viz-table-toggle'); card.appendChild(table); }
  return card;
}

/* ---------- stat tile & hero ---------- */

/** label · value · sub · 12-point sparkline. The number IS the chart. */
export function statTile({ label, value, sub, trend, tone, onclick }) {
  const tile = h('div', { class: 'stat' + (tone ? ' stat-' + tone : '') + (onclick ? ' stat-click' : '') });
  if (onclick) {
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.addEventListener('click', onclick);
    tile.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(e); } });
  }
  tile.appendChild(h('div', { class: 'stat-label', text: label }));
  tile.appendChild(h('div', { class: 'stat-value', text: typeof value === 'number' ? compact(value) : String(value) }));
  if (sub) tile.appendChild(h('div', { class: 'stat-sub', text: sub }));
  if (trend && trend.length > 1) tile.appendChild(sparkline(trend));
  return tile;
}

/** The one number a view leads with. Exactly one per view. */
export function hero({ value, label, detail }) {
  const box = h('div', { class: 'hero' });
  box.appendChild(h('div', { class: 'hero-value', text: typeof value === 'number' ? compact(value) : String(value) }));
  box.appendChild(h('div', { class: 'hero-label', text: label }));
  if (detail) box.appendChild(h('div', { class: 'hero-detail', text: detail }));
  return box;
}

export function sparkline(values, { w = 120, hgt = 28, color } = {}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = i => (i / (values.length - 1)) * (w - 2) + 1;
  const y = v => hgt - 2 - ((v - min) / span) * (hgt - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const svg = el('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, 'aria-hidden': 'true' });
  svg.appendChild(el('path', { d, fill: 'none', stroke: color || 'var(--text-muted)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const lx = x(values.length - 1), ly = y(values[values.length - 1]);
  svg.appendChild(el('circle', { cx: lx, cy: ly, r: 3, fill: color || 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  return svg;
}

/** A single ratio against a limit. Track is a lighter step of the fill's ramp. */
export function meter({ value, max, label, tone = 'seq' }) {
  const frac = max ? Math.max(0, Math.min(1, value / max)) : 0;
  const box = h('div', { class: 'meter' });
  if (label) box.appendChild(h('div', { class: 'meter-label', text: label }));
  const track = h('div', { class: 'meter-track meter-' + tone });
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = (frac * 100).toFixed(1) + '%';
  track.appendChild(fill);
  box.appendChild(track);
  return box;
}

/* ---------- bars ---------- */

/**
 * Horizontal bars. One series -> one colour (slot 1); never a value-ramp on
 * nominal categories. Pass `emphasis` to highlight one row and grey the rest —
 * the honest form when the story is a single item.
 *
 * data: [{label, value, color?, meta?, onclick?}]
 */
export function bars(data, { width = 620, rowH = 30, emphasis = null, labelW = 170, valueFmt = compact, unit = '' } = {}) {
  const n = data.length;
  const barH = Math.min(24, rowH - 8);                 // <=24px, leftover is air
  const gap = 2;                                        // surface gap
  const h0 = Math.max(1, n) * rowH + 8;
  const plotW = width - labelW - 64;
  const max = Math.max(...data.map(d => d.value), 1);
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${h0}`, width: '100%', height: h0, role: 'img' });

  data.forEach((d, i) => {
    const y = i * rowH + 4;
    const w = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * plotW);
    const colour = d.color || (emphasis === null ? 'var(--series-1)'
      : (emphasis === i || emphasis === d.label ? 'var(--series-1)' : 'var(--text-muted)'));

    const g = el('g', { class: 'bar-row' + (d.onclick ? ' clickable' : ''), tabindex: '0' });

    const lab = el('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'ax-label' });
    lab.textContent = d.label;
    g.appendChild(lab);

    // 4px rounded data-end, square at the baseline: a path, not a rounded rect.
    const x0 = labelW, x1 = labelW + w, r = Math.min(4, w);
    g.appendChild(el('path', {
      d: `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + barH - r} Q${x1},${y + barH} ${x1 - r},${y + barH} H${x0} Z`,
      fill: colour,
    }));

    const val = el('text', { x: x1 + 8, y: y + barH / 2 + 4, class: 'ax-value' });
    val.textContent = valueFmt(d.value) + unit;
    g.appendChild(val);

    // hit target spans the whole row, always wider than the mark
    const hit = el('rect', { x: 0, y: y - gap, width, height: barH + gap * 2, fill: 'transparent' });
    const rows = [{ label: d.meta || 'count', value: full(d.value), color: colour }];
    hit.addEventListener('pointerenter', ev => showTip(ev, d.label, rows));
    hit.addEventListener('pointermove', moveTip);
    hit.addEventListener('pointerleave', hideTip);
    if (d.onclick) {
      hit.addEventListener('click', d.onclick);
      g.addEventListener('keydown', e => { if (e.key === 'Enter') d.onclick(e); });
    }
    g.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      showTip({ clientX: b.right, clientY: b.top }, d.label, rows);
    });
    g.addEventListener('blur', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
  });
  return svg;
}

/* ---------- columns over time ---------- */

/** data: [{label, value, sub?}] — one series. */
export function columns(data, { width = 620, height = 190, color = 'var(--series-1)', labelEvery = 1 } = {}) {
  const pad = { t: 14, r: 12, b: 26, l: 44 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = data.length || 1;
  const band = plotW / n;
  const barW = Math.min(24, Math.max(2, band - 2));     // <=24px; 2px surface gap
  const max = Math.max(...data.map(d => d.value), 1);
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });

  for (const t of ticks(max)) {
    const y = pad.t + plotH - (t / max) * plotH;
    svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = el('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', class: 'ax-tick' });
    tx.textContent = compact(t);
    svg.appendChild(tx);
  }

  data.forEach((d, i) => {
    const x = pad.l + i * band + (band - barW) / 2;
    const bh = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * plotH);
    const y = pad.t + plotH - bh;
    const r = Math.min(4, bh);
    const g = el('g', { class: 'bar-row', tabindex: '0' });
    g.appendChild(el('path', {
      d: `M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + bh} Z`,
      fill: color,
    }));
    if (i % labelEvery === 0) {
      const lx = el('text', { x: x + barW / 2, y: height - 8, 'text-anchor': 'middle', class: 'ax-tick' });
      lx.textContent = d.label;
      g.appendChild(lx);
    }
    const hit = el('rect', { x: pad.l + i * band, y: pad.t, width: band, height: plotH, fill: 'transparent' });
    const rows = [{ label: d.sub || 'count', value: full(d.value), color }];
    hit.addEventListener('pointerenter', ev => showTip(ev, d.label, rows));
    hit.addEventListener('pointermove', moveTip);
    hit.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      showTip({ clientX: b.left + b.width / 2, clientY: b.top }, d.label, rows);
    });
    g.addEventListener('blur', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
  });
  svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: pad.t + plotH, y2: pad.t + plotH, stroke: 'var(--axis)', 'stroke-width': 1 }));
  return svg;
}

/* ---------- stacked bar (part-to-whole) ---------- */

/** segments: [{label, value, color?}] — <=6, 2px surface gap between every pair. */
export function stackedBar(segments, { width = 620, height = 34 } = {}) {
  const total = segments.reduce((s, d) => s + d.value, 0) || 1;
  const gap = 2;
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  let x = 0;
  segments.forEach((s, i) => {
    const w = Math.max(0, (s.value / total) * (width - gap * (segments.length - 1)));
    const colour = s.color || SERIES(i);
    const g = el('g', { tabindex: '0', class: 'bar-row' });
    g.appendChild(el('rect', { x, y: 0, width: w, height, rx: i === 0 || i === segments.length - 1 ? 4 : 0, fill: colour }));
    const rows = [{ label: s.label, value: `${full(s.value)} · ${pct(s.value, total)}`, color: colour }];
    const hit = el('rect', { x, y: 0, width: w, height, fill: 'transparent' });
    hit.addEventListener('pointerenter', ev => showTip(ev, s.label, rows));
    hit.addEventListener('pointermove', moveTip);
    hit.addEventListener('pointerleave', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
    x += w + gap;
  });
  return svg;
}

/* ---------- line over time, with crosshair ---------- */

/**
 * series: [{label, color?, points: [{x, y}]}] — x numeric (unix seconds or index).
 * One tooltip lists every series at the snapped X; the reader aims at a date.
 */
export function lines(series, { width = 620, height = 200, xFmt = day, yFmt = compact, area = false } = {}) {
  const pad = { t: 14, r: 16, b: 26, l: 46 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const xs = series.flatMap(s => s.points.map(p => p.x));
  const ys = series.flatMap(s => s.points.map(p => p.y));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = Math.max(...ys, 1);
  const X = v => pad.l + ((v - x0) / (x1 - x0 || 1)) * plotW;
  const Y = v => pad.t + plotH - (v / yMax) * plotH;

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });

  for (const t of ticks(yMax)) {
    const y = Y(t);
    svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = el('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', class: 'ax-tick' });
    tx.textContent = compact(t);
    svg.appendChild(tx);
  }

  const cross = el('line', { y1: pad.t, y2: pad.t + plotH, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cross);

  series.forEach((s, i) => {
    const colour = s.color || SERIES(i);
    const pts = s.points.slice().sort((a, b) => a.x - b.x);
    if (!pts.length) return;
    if (area && series.length === 1) {
      const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')
        + ` L${X(pts[pts.length - 1].x).toFixed(1)},${pad.t + plotH} L${X(pts[0].x).toFixed(1)},${pad.t + plotH} Z`;
      svg.appendChild(el('path', { d, fill: colour, opacity: 0.1 }));
    }
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    svg.appendChild(el('path', { d, fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    const last = pts[pts.length - 1];
    svg.appendChild(el('circle', { cx: X(last.x), cy: Y(last.y), r: 4, fill: colour, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  });

  const dots = series.map((s, i) =>
    el('circle', { r: 4, fill: s.color || SERIES(i), stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 }));
  dots.forEach(d => svg.appendChild(d));

  const surface = el('rect', { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: 'transparent' });
  surface.addEventListener('pointermove', ev => {
    const box = svg.getBoundingClientRect();
    const rel = ((ev.clientX - box.left) / box.width) * width;
    const xv = x0 + ((rel - pad.l) / plotW) * (x1 - x0);
    const rows = [];
    let snapped = null;
    series.forEach((s, i) => {
      let best = null;
      for (const p of s.points) if (!best || Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
      if (!best) { dots[i].setAttribute('opacity', 0); return; }
      if (snapped === null) snapped = best.x;
      dots[i].setAttribute('cx', X(best.x));
      dots[i].setAttribute('cy', Y(best.y));
      dots[i].setAttribute('opacity', 1);
      rows.push({ label: s.label, value: yFmt(best.y), color: s.color || SERIES(i) });
    });
    if (snapped === null) return;
    cross.setAttribute('x1', X(snapped));
    cross.setAttribute('x2', X(snapped));
    cross.setAttribute('opacity', 1);
    showTip(ev, xFmt(snapped), rows);
  });
  surface.addEventListener('pointerleave', () => {
    hideTip();
    cross.setAttribute('opacity', 0);
    dots.forEach(d => d.setAttribute('opacity', 0));
  });
  svg.appendChild(surface);

  [x0, x1].forEach((v, i) => {
    const tx = el('text', { x: X(v), y: height - 8, 'text-anchor': i ? 'end' : 'start', class: 'ax-tick' });
    tx.textContent = xFmt(v);
    svg.appendChild(tx);
  });
  return svg;
}

/* ---------- heatmap grid ---------- */

/**
 * cells: [{row, col, value}] — sequential, one hue light->dark.
 *
 * `colInfo(col)` is optional and makes the column headers explain themselves:
 * return `{title, rows}` in the shape `showTip` takes, and the header becomes
 * hoverable and keyboard-focusable. Column headers are often abbreviated to fit
 * the band, and an abbreviation the reader cannot expand is a guess they have to
 * make — so the expansion lives one hover away, and in a `<title>` for assistive
 * technology, rather than only in the prose above the chart.
 */
export function heatmap(cells, rows, cols, { width = 620, cellH = 22, labelW = 120, unit = '', colInfo = null } = {}) {
  const max = Math.max(...cells.map(c => c.value), 1);
  const cw = (width - labelW - 8) / (cols.length || 1);
  const height = rows.length * cellH + 24;
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  // The heat ramp, not the plain sequential one: it is defined per theme so a
  // high cell is always the prominent one, whichever surface it sits on.
  const steps = ['--heat-100', '--heat-200', '--heat-300', '--heat-400', '--heat-500', '--heat-600', '--heat-700'];
  const key = (r, c) => JSON.stringify([r, c]);
  const index = new Map(cells.map(c => [key(c.row, c.col), c.value]));

  cols.forEach((c, j) => {
    const info = colInfo ? colInfo(c) : null;
    const cls = 'ax-tick' + (info ? ' ax-head' : '');
    const tx = el('text', { x: labelW + j * cw + cw / 2, y: 14, 'text-anchor': 'middle', class: cls });
    tx.textContent = c;

    if (!info) { svg.appendChild(tx); return; }

    const g = el('g', { class: 'bar-row ax-head-g', tabindex: '0' });
    // A native <title> so screen readers and a no-JS render still expand it.
    const t = el('title');
    t.textContent = info.title + (info.rows && info.rows.length ? ' — ' + info.rows[0].value : '');
    g.appendChild(t);
    g.appendChild(tx);

    const hit = el('rect', {
      x: labelW + j * cw, y: 0, width: cw, height: 22, fill: 'transparent',
    });
    const show = ev => showTip(ev, info.title, info.rows || []);
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointermove', moveTip);
    hit.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      showTip({ clientX: b.left + b.width / 2, clientY: b.bottom }, info.title, info.rows || []);
    });
    g.addEventListener('blur', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);
  });

  rows.forEach((r, i) => {
    const y = 24 + i * cellH;
    const lab = el('text', { x: labelW - 10, y: y + cellH / 2 + 4, 'text-anchor': 'end', class: 'ax-label' });
    lab.textContent = r;
    svg.appendChild(lab);
    cols.forEach((c, j) => {
      const v = index.get(key(r, c)) || 0;
      const step = v === 0 ? null : steps[Math.min(steps.length - 1, Math.floor((v / max) * steps.length))];
      const x = labelW + j * cw;
      const g = el('g', { tabindex: '0', class: 'bar-row' });
      g.appendChild(el('rect', {
        x: x + 1, y: y + 1, width: Math.max(0, cw - 2), height: cellH - 2, rx: 3,   // 2px surface gap
        fill: step ? `var(${step})` : 'var(--surface-2)',
      }));
      const hit = el('rect', { x, y, width: cw, height: cellH, fill: 'transparent' });
      hit.addEventListener('pointerenter', ev => showTip(ev, `${r} · ${c}`, [{ label: unit || 'value', value: full(v) }]));
      hit.addEventListener('pointermove', moveTip);
      hit.addEventListener('pointerleave', hideTip);
      g.appendChild(hit);
      svg.appendChild(g);
    });
  });
  return svg;
}
