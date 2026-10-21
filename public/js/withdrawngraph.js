/* withdrawngraph.js — the retraction archive, drawn over the live graph.
 *
 * One card, for the top of the retractions page. The backdrop is the live graph
 * from /api/social, close to what the landing page draws: people, stored groups and employers,
 * returns them, in one faint grey. Over it, heavy, the links
 * /api/retractions/graph reads out of the expired layers. A link there is a
 * withdrawn row whose object was another entity (an event's attendee,
 * organiser or sender), or one that bound an entity to a calendar record an
 * event entity also carries. Endpoints that have no row left in the live graph
 * are red; the live ones a withdrawn link touches are drawn in full ink and
 * labelled.
 *
 * Most of what the archive holds is not a link: titles, times, descriptions.
 * The card says how much, and lists it on the node it sat on. Every name,
 * count and date arrives from the two payloads the caller hands in.
 *
 *   const g = withdrawnGraph(wd, social, socialWhy);   // social may be null
 *   root.appendChild(g.card);
 *   g.destroy();                                        // when the page goes
 */

import { h, legend, keyList, full } from './viz.js';
import { forceGraph } from './force.js';
import { RECORD_KINDS } from './linkorigin.js';

/* ---------- this card's own constants ---------- */

const VIEW_W = 960;
const VIEW_H = 640;
const LABEL_MAX = 48;
const LABEL_CHARS = 30;
const PANEL_LINKS = 12;
const PANEL_ATTRS = 8;

/* The backdrop is drawn to be looked through: one grey, low opacity, no labels. */
const BACK_NODE = 0.28;
const BACK_LINK = 0.2;
const WITHDRAWN_W = 2.5;

/* What a node is on this card, in legend order. */
const ROLES = ['gone', 'touched', 'back'];
const COLOUR = {
  gone: 'var(--status-critical)',
  touched: 'var(--text-primary)',
  back: 'var(--text-muted)',
};
const ROLE_WORD = {
  gone: 'gone from the live graph',
  touched: 'live, at the end of a withdrawn link',
  back: 'the rest of the live graph',
};
const LINK_COLOUR = {
  gone: 'var(--status-critical)',
  cut: 'var(--status-serious)',
  back: 'var(--text-muted)',
};

/* The landing page's layers; group chats stay out, as they do there by default. */
// The events and other records the social graph adds under "stored links only"
// are never part of this backdrop: the withdrawn rows bring their own events.
const layerOfNode = n => ((n.kind === 'record' || n.group === 'stored_only') ? 'records'
  : n.kind === 'channel' ? 'chats'
  : (n.kind === 'org' || n.group === 'employee') ? 'employment' : 'core');
const LAYER_OF_KIND = {
  employed_by: 'employment', channel_member: 'chats', shared_handles: 'chats',
  ...Object.fromEntries(RECORD_KINDS.map(k => [k, 'records'])),
};
const DRAWN = new Set(['core', 'employment']);

/* ---------- small helpers ---------- */

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = v => v !== null && v !== undefined && v !== '';
const plural = (n, one, many) => `${full(n)} ${num(n) === 1 ? one : many}`;
const note = t => h('p', { class: 'card-note', text: t });
const goTo = id => () => { location.hash = id; };
/** Minute-resolution UTC stamp. The archive's timestamp is when the row was withdrawn. */
const stamp = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

function kv(label, value) {
  const line = h('div');
  Object.assign(line.style, {
    display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12px',
    padding: '3px 0', borderBottom: '1px solid var(--border)',
  });
  line.appendChild(h('span', { class: 'muted', text: label }));
  const v = h('span', { text: has(value) ? String(value) : '—' });
  Object.assign(v.style, { textAlign: 'right', overflowWrap: 'anywhere' });
  line.appendChild(v);
  return line;
}

/* ---------- the two payloads, as one drawing ---------- */

function merge(social, wd) {
  const over = new Map(wd.nodes.map(n => [String(n.id), n]));
  const roleOf = w => (!w ? 'back' : w.state === 'gone' ? 'gone' : 'touched');

  const nodes = [];
  const seen = new Set();
  const socialNodes = social ? social.nodes.filter(n => layerOfNode(n) !== 'records') : [];
  const socialById = new Map(socialNodes.map(n => [String(n.id), n]));
  for (const n of socialNodes) {
    const id = String(n.id);
    if (!DRAWN.has(layerOfNode(n)) && !over.has(id)) continue;
    const w = over.get(id) || null;
    nodes.push(Object.assign({}, n, { role: roleOf(w), withdrawn: w, onSocial: true }));
    seen.add(id);
  }
  for (const w of wd.nodes) {
    const id = String(w.id);
    if (seen.has(id)) continue;
    const s = socialById.get(id);
    nodes.push(Object.assign({}, s || w, { role: roleOf(w), withdrawn: w, onSocial: !!s }));
    seen.add(id);
  }

  // The backdrop first and the withdrawn links last: links paint in order.
  const back = (social ? social.links : [])
    .filter(l => DRAWN.has(LAYER_OF_KIND[l.kind] || 'core'))
    .filter(l => seen.has(String(l.source)) && seen.has(String(l.target)))
    .map(l => Object.assign({}, l, { tier: 'back' }));
  const front = wd.links.map(l => Object.assign({}, l, { tier: l.state === 'cut' ? 'cut' : 'gone' }));

  const counts = {};
  for (const n of nodes) counts[n.role] = (counts[n.role] || 0) + 1;
  return { nodes, back, front, counts, byId: new Map(nodes.map(n => [String(n.id), n])) };
}

/* ---------- the card ---------- */

export function withdrawnGraph(wd, social, socialWhy) {
  const c = wd.counts || {};
  const box = h('section', { class: 'card card-wide' });
  const title = h('h3');
  box.appendChild(h('header', { class: 'card-head' }, [title]));
  let live = null;
  const handle = {
    card: box,
    destroy() {
      if (live) {
        try { live.destroy(); } catch { /* already gone */ }
        live = null;
      }
    },
  };

  if (!wd.links.length) {
    title.textContent = 'No withdrawn row was a link';
    box.appendChild(h('div', { class: 'empty', text:
      `The archive holds ${plural(c.rows, 'withdrawn row', 'withdrawn rows')} and none of them was a link `
      + 'between two entities that the live graph no longer holds, so there is nothing to draw over it.' }));
    return handle;
  }

  const M = merge(social, wd);
  const edgeRows = num(c.link_rows) + num(c.binding_rows);

  title.textContent = social
    ? `${plural(c.links, 'link', 'links')} the graph withdrew, over ${full(M.back.length)} live ones`
    : `${plural(c.links, 'link', 'links')} the graph withdrew`;
  box.appendChild(note(
    `${full(edgeRows)} of the archive's ${full(c.rows)} rows were links, merged here into ${full(c.links)} lines, `
    + `one per pair of entities, and ${full(c.facet_rows)} more qualified those links. ${full(c.gone_nodes)} of the `
    + `${full(c.nodes)} entities they join have no row left anywhere in the live graph. The other `
    + `${full(c.attribute_rows)} rows were attributes (titles, times, descriptions, handles) and are listed on the `
    + 'node they sat on. Click a node to read it.'));
  if (!social) {
    box.appendChild(note(`The live graph could not be read${socialWhy ? ' — ' + socialWhy : ''}, so the `
      + 'withdrawn links are drawn on their own.'));
  }

  const nodeKey = legend(ROLES.filter(r => M.counts[r]).map(r => ({
    label: `${ROLE_WORD[r]} · ${full(M.counts[r])}`, color: COLOUR[r],
  })), 'rect');
  if (nodeKey) box.appendChild(nodeKey);
  const linkKey = legend([
    { n: c.gone_links, label: 'withdrawn with an entity that is gone', color: LINK_COLOUR.gone },
    { n: c.cut_links, label: 'withdrawn between two live entities, dashed', color: LINK_COLOUR.cut },
    { n: M.back.length, label: 'live', color: LINK_COLOUR.back },
  ].filter(x => num(x.n)).map(x => ({ label: `${x.label} · ${full(x.n)}`, color: x.color })), 'line');
  if (linkKey) box.appendChild(linkKey);

  const split = h('div', { class: 'home-hero-split' });
  const holder = h('div', { class: 'home-hero-graph' });
  const panel = h('aside', { class: 'home-hero-panel', 'aria-live': 'polite' });
  split.appendChild(holder);
  split.appendChild(panel);
  box.appendChild(split);

  live = forceGraph(holder, {
    nodes: M.nodes,
    links: M.back.concat(M.front),
    width: VIEW_W,
    height: VIEW_H,
    expand: split,
    colorFor: n => COLOUR[n.role] || COLOUR.back,
    linkColorFor: l => LINK_COLOUR[l.tier] || null,
    linkStyleFor: l => (l.tier === 'back'
      ? { opacity: BACK_LINK }
      : { width: WITHDRAWN_W, opacity: 0.95, dash: l.tier === 'cut' ? '6 4' : null }),
    nodeOpacityFor: n => (n.role === 'back' ? BACK_NODE : 1),
    labelFor: n => n.role !== 'back',
    labelMax: LABEL_MAX,
    labelChars: LABEL_CHARS,
    onSelect: node => show(node),
  });

  /* -- the panel: the ledger when nothing is selected, the node when one is -- */

  const linksOf = id => M.front.filter(l => String(l.source) === id || String(l.target) === id);

  function show(node) {
    panel.textContent = '';
    if (!node) {
      panel.appendChild(h('div', { class: 'card-note', text: 'How to read this' }));
      panel.appendChild(keyList([
        ['grey', 'the live graph'],
        ['red node', 'an entity with no row left in the live graph'],
        ['dark node', 'a live entity at the end of a withdrawn link'],
        ['red line', 'withdrawn together with an entity that is gone'],
        ['orange dashed line', 'withdrawn between two entities that both still exist'],
        ['node size', 'rows in the store naming it'],
      ]));

      panel.appendChild(h('div', { class: 'card-note', text: `What the archive holds · ${full(c.rows)} rows` }));
      panel.appendChild(kv('a link to another entity', full(c.link_rows)));
      panel.appendChild(kv('a facet of one of those links', full(c.facet_rows)));
      panel.appendChild(kv('a binding to a calendar record', full(c.binding_rows)));
      panel.appendChild(kv('an attribute of one entity', full(c.attribute_rows)));
      panel.appendChild(kv('re-asserted identically, not drawn', full(c.reasserted_rows)));
      if (num(c.still_linked_rows)) panel.appendChild(kv('link still live under another row', full(c.still_linked_rows)));
      if (num(c.unresolved_rows)) panel.appendChild(kv('binding to a record no entity carries', full(c.unresolved_rows)));
      panel.appendChild(note('Keyboard: Tab walks the nodes in size order, Enter selects, Escape clears, '
        + 'arrows pan, + and − zoom, 0\u00a0re-fits, f\u00a0fills the window.'));
      return;
    }

    const id = String(node.id);
    const w = node.withdrawn;
    const m = (w && w.meta) || {};
    panel.appendChild(h('div', { class: 'card-note', text: 'Selected node' }));
    panel.appendChild(h('h3', { text: node.label || '(unnamed)' }));

    const tags = h('div', { class: 'viz-legend' });
    tags.appendChild(h('span', {
      class: 'pill' + (node.role === 'gone' ? ' pill-critical' : ''),
      text: node.role === 'back' ? 'live · no withdrawn row touches it' : ROLE_WORD[node.role],
    }));
    const cls = m.class || (node.meta && node.meta.class) || (node.kind === 'owner' ? 'you' : node.kind);
    if (cls) tags.appendChild(h('span', { class: 'pill', text: cls }));
    panel.appendChild(tags);

    if (w) {
      panel.appendChild(kv('rows left in the live graph', full(m.live_rows)));
      panel.appendChild(kv('rows in the archive', full(m.archived_rows)));
      if (m.archived_rows) panel.appendChild(kv('withdrawn at', stamp(m.retracted_at)));
      if (w.kind === 'event') {
        panel.appendChild(kv('scheduled', m.month || '—'));
        panel.appendChild(kv('participants named', full(m.participants)));
        if (m.descriptions) panel.appendChild(kv('descriptions', full(m.descriptions)));
        if (m.urls) panel.appendChild(kv('meeting links', full(m.urls)));
        if (m.dial_ins) panel.appendChild(kv('dial-in numbers', full(m.dial_ins)));
      }
      if (m.named === 'archive') {
        panel.appendChild(note('The name above is read from the withdrawn rows; the live graph no longer holds it.'));
      }

      const attrs = Array.isArray(m.attributes) ? m.attributes : [];
      if (attrs.length) {
        panel.appendChild(h('div', { class: 'card-note', text:
          `withdrawn from this node, not a link · ${full(m.attribute_rows)} rows` }));
        for (const a of attrs.slice(0, PANEL_ATTRS)) panel.appendChild(kv(a.label, full(a.rows)));
        if (attrs.length > PANEL_ATTRS) panel.appendChild(note(`showing ${full(PANEL_ATTRS)} of ${full(attrs.length)}`));
      }

      const mine = linksOf(id);
      panel.appendChild(h('div', { class: 'card-note', text: `withdrawn links · ${full(mine.length)}` }));
      for (const l of mine.slice(0, PANEL_LINKS)) {
        const other = M.byId.get(String(l.source) === id ? String(l.target) : String(l.source));
        panel.appendChild(kv(
          `${other ? other.label || '(unnamed)' : '—'}${l.state === 'cut' ? ' · both live' : ''}`,
          (l.meta.roles || []).join(', ')));
      }
      if (mine.length > PANEL_LINKS) panel.appendChild(note(`showing ${full(PANEL_LINKS)} of ${full(mine.length)}`));
    } else {
      panel.appendChild(note('A live node of the landing graph. No withdrawn row names it; it is drawn here '
        + 'for where it sits.'));
    }

    if (node.onSocial) {
      const btns = h('div', { class: 'viz-legend' });
      btns.style.marginTop = '10px';
      btns.appendChild(h('button', { class: 'ghost', type: 'button', text: 'open in the social graph →',
                                     onclick: goTo('social') }));
      panel.appendChild(btns);
    }
  }

  show(null);
  return handle;
}
