/* home.js — the landing page: the graph first, then the specifics.
 *
 * Order of argument, deliberately:
 *
 *   1. the social graph, coloured by what the store says each node is to you —
 *      the whole file at a glance, every node a real row;
 *   2. the faces the photo library keeps, largest clusters first, each one a
 *      door into its photographs and the people it is photographed with;
 *   3. the specifics: family as the scorecard has it, the handles exactly as
 *      stored, the logged correspondents, the groups kept by name, and the
 *      events still ahead;
 *   4. every other view of the same file, with its headline number counted live.
 *
 * Nothing on this page is written down here. Every name, handle, count, tag and
 * date arrives from seven endpoints at request time, fetched in parallel. Each
 * section degrades on its own if its endpoint cannot be read, and says so in
 * one line rather than inventing a substitute.
 */

import { api } from '../app.js';
import { h, legend, keyList, full, pct, day, SERIES, showTip, hideTip } from '../viz.js';
import { forceGraph } from '../force.js';
import { openCluster, faceCrop, nodeFace } from '../facedrawer.js';
import { originsOf, predicatesOf, dashDerived, augmentNote, scorecardSwitch, edgeTip, NOT_DRAWN, SCORECARD_KIND,
         SCORECARD_COLOUR, RECORD_KINDS, RECORD_NODE_COLOUR, RECORD_LINK_COLOUR,
         RECORD_LINK_WORD, WITHDRAWN_KIND, WITHDRAWN_COLOUR, WITHDRAWN_STYLE } from '../linkorigin.js';

export const meta = {
  id: 'home',
  nav: 'What your Mac knows',
  group: 'Start here',
  kicker: 'What your Mac knows about you',
  title: 'What your Mac knows about you',
  blurb: '',
  headless: true,          // the graph card draws its own header — see app.js
};

/* ---------- this page's own caps, announced wherever one bites ---------- */

const VIEW_W = 960;
const VIEW_H = 640;
const FAMILY_CAP = 8;
const REACH_CAP = 12;
const TALK_CAP = 8;
const CHAT_CAP = 8;
const ORG_CAP = 6;
const EVENT_CAP = 6;
const LEG_CAP = 4;
const DOMAIN_CAP = 5;
const WHO_CAP = 3;
const FACE_STRIP = 14;
const PANEL_HANDLES = 6;
const PANEL_EVENTS = 6;
const LABEL_MAX = 36;
const LABEL_CHARS = 36;

/* Which layer of the graph a node or an edge belongs to — the same split the
 * social page draws, so the two pictures agree on what "employers" mean. The
 * records layer is always drawn, the scorecard layer is the switch's, and the
 * group chats are no longer drawn at all. */
const LAYER_OF_KIND = {
  employed_by: 'employment', channel_member: 'chats', shared_handles: 'chats',
  [SCORECARD_KIND]: 'scorecard', [WITHDRAWN_KIND]: 'withdrawn',
  ...Object.fromEntries(RECORD_KINDS.map(k => [k, 'records'])),
};
function layerOfNode(n) {
  if (n.withdrawn_only) return 'withdrawn';                     // only in the retraction archive
  if (n.meta && n.meta.scorecard_only) return 'scorecard';     // here only because of a score
  if (n.kind === 'record' || n.group === 'stored_only') return 'records';
  if (n.kind === 'channel') return 'chats';
  if (n.kind === 'org' || n.group === 'employee') return 'employment';
  return 'core';
}

/* What a node is to you. Fixed order: it is the legend order and the panel order.
 * The reserved red is spent on the one grouping the store holds as an entity of
 * its own, and it never appears without its legend label beside it. */
const RELATIONS = ['you', 'group', 'family', 'close', 'org', 'chat', 'event', 'record', 'other'];
const COLOUR = {
  you: 'var(--text-primary)',
  group: 'var(--status-critical)',
  family: SERIES(1),
  close: SERIES(0),
  org: SERIES(3),
  chat: SERIES(2),
  // Aqua is the group chats' on the social page; chats are never drawn here.
  event: SERIES(2),
  record: RECORD_NODE_COLOUR,
  other: 'var(--text-muted)',
};
const RELATION_WORD = {
  you: 'you',
  group: 'a group the store holds as an entity',
  family: 'family, as scored',
  close: 'scored close to you',
  org: 'employer',
  chat: 'group chat',
  event: 'an event',
  record: 'another record: a place, an app, …',
  other: 'known, not scored close',
};

/* An entity only the retraction archive holds is coloured by what it is, as the
 * live nodes are, from the class its rows gave it; that it is gone is the dotted
 * outline, the same dots as the withdrawn lines. */
const ARCHIVED_ROLE = { person: 'other', 'group of humans': 'group', organization: 'org', 'calendar event': 'event' };
const ARCHIVED_LOOK = { dash: '2 2', fillOpacity: 0.6 };
const archivedOnly = n => Boolean(n.withdrawn_only && n.state === 'gone');
const LINK_COLOUR = {
  family_circle_member: 'var(--status-critical)',
  co_attendance: 'var(--text-muted)',          // the key's "grey"; --grid is the background's own tone
  organizer_to_attendee: 'var(--text-muted)',
  inferred_closeness: SCORECARD_COLOUR,
  employed_by: SERIES(3),
  channel_member: SERIES(2),
  shared_handles: SERIES(2),
  ...RECORD_LINK_COLOUR,
  [WITHDRAWN_KIND]: WITHDRAWN_COLOUR,
};

/* ---------- small helpers ---------- */

const sty = (node, props) => { Object.assign(node.style, props); return node; };
const goTo = id => () => { location.hash = id; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = v => v !== null && v !== undefined && v !== '';
const text = v => (has(v) ? String(v) : '—');
const score = v => (has(v) ? Number(v).toFixed(3) : '—');
const clock = hh => `${String(num(hh)).padStart(2, '0')}:00`;
const plural = (n, one, many) => `${full(n)} ${num(n) === 1 ? one : many}`;

function card(title, kids, { wide } = {}) {
  const box = h('section', { class: 'card' + (wide ? ' card-wide' : '') });
  box.appendChild(h('header', { class: 'card-head' }, [h('h3', { text: title })]));
  for (const k of kids) if (k) box.appendChild(k);
  return box;
}
const note = t => h('p', { class: 'card-note', text: t });
const lead = t => h('p', { class: 'home-lead', text: t });
const sub = t => h('div', { class: 'home-sub', text: t });

/** One finding: a name, an optional tag, a value, an optional second line. */
function row({ name, tag, value, sub: subText, onclick }) {
  const line = h('div', { class: 'home-row' });
  const nm = h('span', { class: 'home-row-name' });
  if (onclick) nm.appendChild(h('button', { class: 'ghost', type: 'button', text: name, onclick }));
  else nm.appendChild(h('span', { text: name }));
  if (tag) {
    nm.appendChild(h('span', { text: ' ' }));
    nm.appendChild(h('span', { class: 'pill', text: tag }));
  }
  if (subText) nm.appendChild(h('span', { class: 'home-row-sub', text: subText }));
  line.appendChild(nm);
  if (has(value)) line.appendChild(h('span', { class: 'home-row-value', text: String(value) }));
  return line;
}

/** A key → value line for the detail panel. */
function kv(label, value) {
  const line = sty(h('div'), {
    display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12px',
    padding: '3px 0', borderBottom: '1px solid var(--border)',
  });
  line.appendChild(h('span', { class: 'muted', text: label }));
  line.appendChild(sty(h('span', { text: text(value) }), { textAlign: 'right', overflowWrap: 'anywhere' }));
  return line;
}

/** Every card ends on the view that holds the rest of what it showed. */
function more(label, page) {
  return h('div', { class: 'home-more' }, [
    h('button', { class: 'ghost', type: 'button', text: label + ' →', onclick: goTo(page) }),
  ]);
}

/** A section whose endpoint could not be read: the title, one line, nothing invented. */
function cannot(title, what, why, page) {
  return card(title, [
    h('div', { class: 'empty', text: `The ${what} could not be read on this device${why ? ' — ' + why : ''}.` }),
    page ? more('Open the view anyway', page) : null,
  ]);
}

/* Every sibling view owns its own label and headline. Read those from
 * the modules themselves rather than restating them here; one that fails to load
 * degrades to its id and the row still renders with its live number. */
const metaCache = new Map();
function pageMeta(id) {
  if (!metaCache.has(id)) {
    metaCache.set(id, import(`./${id}.js`).then(m => m.meta || null).catch(() => null));
  }
  return metaCache.get(id);
}


/** Leaf kinship labels that carry the same score and are bit-identical columns
 *  are one claim wearing several names; show them as one ("father = sister"). */
function collapse(leaves, twinsOf) {
  const out = [];
  const used = new Set();
  for (const leaf of leaves) {
    if (used.has(leaf.label)) continue;
    const twins = twinsOf(leaf.label);
    const group = leaves.filter(x => !used.has(x.label) && num(x.score) === num(leaf.score)
                                     && twins.includes(x.label));
    if (!group.length) group.push(leaf);
    for (const x of group) used.add(x.label);
    out.push({ labels: group.map(x => x.label), score: num(leaf.score) });
  }
  return out;
}

/** The collapsed groups as the store holds them: "a x · b = c y". */
const scoreLine = groups => groups.map(g => `${g.labels.join(' = ')} ${score(g.score)}`).join(' · ');

/* ---------- what the graph, the panel and the cards share ---------- */

/**
 * Computed once from the payloads. "Family" keys off the leaf kinship scores
 * (mother, father, …) above zero and the stored group's membership edges —
 * never off the broad `family` head, which is above zero for almost everyone the
 * graph scored.
 *
 * No relationship word is picked for a person. The store holds a number per
 * column and applies no cut, so taking the highest column and printing its name
 * would be this page's inference, not Apple's; the scores are shown instead.
 * Columns the scorecard finds to be exact sums of others are kept too: with few
 * people scored and scores in steps of 0.125 a sum can hold by coincidence, and
 * dropping a column on that basis let a lower score stand in for a higher one.
 */
function derive(social, kinship) {
  const cut = num(social.cuts && social.cuts.closeness);
  const identical = (kinship && kinship.structure && Array.isArray(kinship.structure.identical))
    ? kinship.structure.identical : [];
  const twinsOf = label => identical.find(k => Array.isArray(k) && k.includes(label)) || [label];

  const byId = new Map(social.nodes.map(n => [String(n.id), n]));
  const groupIds = new Set(social.nodes.filter(n => n.kind === 'explicit_group').map(n => String(n.id)));
  const famLink = new Set();
  for (const l of social.links) {
    if (l.kind !== 'family_circle_member') continue;
    const s = String(l.source), t = String(l.target);
    if (groupIds.has(s) && byId.has(t) && !groupIds.has(t)) famLink.add(t);
    if (groupIds.has(t) && byId.has(s) && !groupIds.has(s)) famLink.add(s);
  }

  const kinScores = new Map();              // id -> { score, leaves }
  for (const n of social.nodes) {
    if (n.kind !== 'person') continue;      // the owner's own row carries 'myself'
    const claims = n.meta && Array.isArray(n.meta.claims) ? n.meta.claims : [];
    const leaves = claims.filter(c => c && num(c.score) > 0)
                         .sort((a, b) => num(b.score) - num(a.score));
    if (!leaves.length) continue;
    kinScores.set(String(n.id), { score: num(leaves[0].score), leaves });
  }

  const isFamily = n => kinScores.has(String(n.id)) || (n.kind === 'person' && famLink.has(String(n.id)));
  const isClose = n => {
    const c = n.meta ? n.meta.closeness : null;
    return n.kind === 'person' && has(c) && num(c) >= cut;
  };
  const relationOf = n => (n.kind === 'owner' ? 'you'
    : n.kind === 'explicit_group' ? 'group'
    : isFamily(n) ? 'family'
    : isClose(n) ? 'close'
    : n.kind === 'org' ? 'org'
    : n.kind === 'channel' ? 'chat'
    : n.kind === 'record' ? ((n.meta && n.meta.class) === 'calendar event' ? 'event' : 'record') : 'other');
  const role = new Map(social.nodes.map(n => [String(n.id), relationOf(n)]));

  return {
    cut, twinsOf, byId, groupIds, famLink, kinScores,
    roleOf: n => role.get(String(n.id)) || 'other',
    /** the people a stored group names, in the order the edges arrive */
    membersOf: g => {
      const out = [];
      for (const l of social.links) {
        if (l.kind !== 'family_circle_member') continue;
        const s = String(l.source), t = String(l.target);
        const other = s === String(g.id) ? t : t === String(g.id) ? s : null;
        if (other && byId.has(other) && !groupIds.has(other)) out.push(byId.get(other));
      }
      return out;
    },
  };
}

/* ---------- 1 · the graph ---------- */

/* The rows the graph has withdrawn (/api/retractions/graph), in this graph's
 * terms. Their node ids are the social graph's own, so a withdrawn link lands on
 * the live node it touches; an entity the live graph does not draw becomes a
 * node of its own. Only links that touch a person or an event are drawn, the
 * rule the live rows follow here; the rest (an app's row to its publisher, say)
 * stay on the retractions page and are counted, with what they said. */
const SOCIAL_CLASSES = new Set(['person', 'calendar event', 'group of humans']);

function withdrawnLayer(social, wd) {
  const out = { nodes: [], links: [], byId: new Map(), rows: 0, left: 0, leftRoles: new Map() };
  if (!social || !wd || !Array.isArray(wd.links) || !wd.links.length) return out;
  const live = new Set(social.nodes.map(n => String(n.id)));
  const archived = new Map((wd.nodes || []).map(n => [String(n.id), n]));
  const touches = id => live.has(id) || SOCIAL_CLASSES.has(((archived.get(id) || {}).meta || {}).class);
  const ends = new Set();
  for (const l of wd.links) {
    const s = String(l.source), t = String(l.target);
    if (!touches(s) && !touches(t)) {
      out.left += num(l.weight);
      for (const r of (l.meta && l.meta.roles) || []) out.leftRoles.set(r, (out.leftRoles.get(r) || 0) + num(l.weight));
      continue;
    }
    out.links.push(Object.assign({}, l, { source: s, target: t, kind: WITHDRAWN_KIND }));
    out.rows += num(l.weight);
    ends.add(s);
    ends.add(t);
  }
  for (const id of ends) {
    if (live.has(id) || !archived.has(id)) continue;
    const n = Object.assign({}, archived.get(id), { withdrawn_only: true });
    out.nodes.push(n);
    out.byId.set(id, n);
  }
  return out;
}

/* What the withdrawn links said, most rows first: "has attendee N, …". */
function rolesOf(links) {
  const by = new Map();
  for (const l of links) for (const r of (l.meta && l.meta.roles) || []) by.set(r, (by.get(r) || 0) + num(l.weight));
  return [...by.entries()].sort((a, b) => b[1] - a[1]);
}

function graphCard(social, F, why, wd) {
  const box = h('section', { class: 'card card-wide home-hero' });
  const head = h('div', { class: 'home-hero-head' });
  head.appendChild(h('div', { class: 'view-kicker', text: meta.kicker }));

  if (!social) {
    head.appendChild(h('h1', { class: 'home-title', text: meta.title }));
    box.appendChild(head);
    box.appendChild(h('div', { class: 'empty', text:
      `The social layer could not be read on this device${why ? ' — ' + why : ''}.` }));
    box.appendChild(more('Open the social graph', 'social'));
    return box;
  }

  const c = social.counts || {};
  const W = withdrawnLayer(social, wd);
  const peopleInGraph = social.nodes.filter(n => (n.kind === 'person' || n.kind === 'owner')
                                                 && !(n.meta && n.meta.scorecard_only)).length;
  head.appendChild(h('h1', { class: 'home-title', text:
    `${plural(peopleInGraph, 'person', 'people')}, ${plural(c.records, 'event and other record', 'events and other records')}, `
    + `${plural(c.orgs, 'employer', 'employers')} and `
    + `${plural(c.explicit_groups, 'stored group', 'stored groups')} — as the store on this Mac links them` }));
  head.appendChild(note('Read live just now. Colour is what each node is to you: the stored group in red, '
    + 'family and closeness by iKnow’s rules on the kinship scorecard. Size is how many rows in the store name '
    + 'it. Click a node to read its record; drag to pin, double-click to unpin; pinch or ⌘-scroll to zoom, '
    + 'or use the buttons in its corner.'));
  box.appendChild(head);

  /* -- the key, with live counts; a hidden layer says so rather than vanishing -- */
  const layers = new Set(['core', 'employment', 'records', 'scorecard', 'withdrawn']);
  const scorecardOn = () => layers.has('scorecard');
  const withdrawnOn = () => layers.has('withdrawn');
  /* Family and closeness are the scorecard's: with it off, those people are plain.
   * An entity drawn only from the archive takes the colour of its class. */
  const roleOf = n => {
    if (n.withdrawn_only) return ARCHIVED_ROLE[(n.meta || {}).class] || 'record';
    const r = F.roleOf(n);
    return !scorecardOn() && (r === 'family' || r === 'close') ? 'other' : r;
  };
  const allNodes = () => social.nodes.concat(W.nodes);
  const hiddenRelation = r => r === 'org' && !layers.has('employment');
  // Counted over what can be drawn, a hidden employer layer included so it can say so.
  const roleCount = r => allNodes().filter(n => layerOfNode(n) !== 'chats'
    && (layerOfNode(n) !== 'scorecard' || scorecardOn())
    && (layerOfNode(n) !== 'withdrawn' || withdrawnOn()) && roleOf(n) === r).length;
  const legendRows = () => RELATIONS
    .filter(r => roleCount(r))
    .map(r => ({
      label: `${RELATION_WORD[r]} · ${full(roleCount(r))}${hiddenRelation(r) ? ' · hidden' : ''}`,
      color: COLOUR[r],
    }));
  const makeLegend = () => {
    const el = legend(legendRows(), 'rect') || h('div', { class: 'viz-legend' });
    const gone = withdrawnOn() ? W.nodes.filter(archivedOnly).length : 0;
    if (gone) {
      el.appendChild(h('span', { class: 'viz-legend-item' }, [
        h('span', { class: 'viz-key viz-key-ring' }),
        h('span', { text: `dotted outline · only in the retraction archive · ${full(gone)}` }),
      ]));
    }
    return el;
  };
  let legendEl = makeLegend();
  box.appendChild(legendEl);

  /* The two scorecard colours are iKnow's rules, not labels the store holds:
   * the store keeps a number per column and applies no cut. Said under the key
   * whenever either colour is on screen, with the cut the request ran with. */
  const rulesNote = () => {
    if (!scorecardOn() || !(roleCount('family') || roleCount('close'))) return h('div');
    return h('p', { class: 'card-note' }, [
      h('span', { class: 'pill pill-ours', text: 'iKnow’s analysis',
                  title: 'Computed by iKnow from the store’s rows when the page loads; the store holds none of it' }),
      document.createTextNode(' “Family” and “close” are iKnow’s rules, not labels the store holds, '
        + 'and the scorecard applies no cut of its own. Family: any score above zero in a column that '
        + 'names a specific relative (mother, father, …), or membership of the stored group. Close: a '
        + `family-and-friends score of ${full(num(social.cuts && social.cuts.closeness))} or more.`),
    ]);
  };
  let rulesEl = rulesNote();
  box.appendChild(rulesEl);

  /* -- which lines the store holds, and which are drawn from its other records -- */
  const origins = originsOf(social);
  const kindsPresent = new Set(social.links.map(l => l.kind));
  // A stored line is named by its rows' predicate first, then in plain words.
  const predicates = predicatesOf(social);
  const byPredicate = (k, gloss) => (predicates.get(k) ? `${predicates.get(k)} — ${gloss}` : gloss);
  const aug = augmentNote(social, origins);
  box.appendChild(aug.el);
  box.appendChild(scorecardSwitch(scorecardOn(), on => {
    if (on) layers.add('scorecard'); else layers.delete('scorecard');
    redraw();
    if (!selected) showDetail(null);      // the key names the lines on screen
  }).el);

  /* -- the retraction archive: the rows the graph withdrew, over the live graph -- */
  const wdNote = h('p', { class: 'card-note' });
  function syncWdNote() {
    wdNote.textContent = '';
    if (!W.links.length) return;
    const gone = W.nodes.filter(archivedOnly).length;
    const said = rolesOf(W.links).map(([r, n]) => `${r} ${full(n)}`).join(', ');
    const left = W.left
      ? ` ${plural(W.left, 'more withdrawn row links', 'more withdrawn rows link')} entities no person or event `
        + `touches (${[...W.leftRoles.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${full(n)}`).join(', ')}); `
        + 'The retraction archive draws those.'
      : '';
    wdNote.appendChild(h('strong', { text: 'And what the graph withdrew.' }));
    wdNote.appendChild(document.createTextNode(withdrawnOn()
      ? ` The dotted violet lines are ${plural(W.rows, 'row', 'rows')} the graph no longer holds, read from its `
        + `retraction archive (the expired layers of graph.db): ${said}.`
        + (gone ? ` ${plural(gone, 'entity they reach has', 'entities they reach have')} no row left in the live `
                  + 'graph: ' + (gone === 1 ? 'it is' : 'they are') + ' drawn as a dotted outline, in the colour of '
                  + 'what ' + (gone === 1 ? 'it is' : 'each is') + '.' : '')
        + left
      : ` The ${plural(W.rows, 'row', 'rows')} from the retraction archive, and the entities only they reach, `
        + 'are switched off.'));
  }
  if (W.links.length) {
    const key = h('span', { class: 'viz-key viz-key-line viz-key-dot' });
    key.style.setProperty('--key-colour', WITHDRAWN_COLOUR);
    const btn = h('button', {
      class: 'pill', type: 'button',
      title: 'Rows the graph has withdrawn, kept in the expired layers of graph.db',
      onclick: () => {
        if (withdrawnOn()) layers.delete('withdrawn'); else layers.add('withdrawn');
        syncBtn();
        redraw();
        if (!selected) showDetail(null);
      },
    }, [key, h('span', { text: `withdrawn rows · retraction archive · ${full(W.rows)}` })]);
    const syncBtn = () => {
      btn.setAttribute('aria-pressed', String(withdrawnOn()));
      btn.style.opacity = withdrawnOn() ? '1' : '0.45';
    };
    syncBtn();
    box.appendChild(wdNote);
    box.appendChild(h('div', { class: 'viz-legend' }, [btn]));
    syncWdNote();
  }

  /* -- layers: people and their records are always drawn; employers can be taken off -- */
  const toggles = h('div', { class: 'viz-legend' });
  toggles.appendChild(h('span', { class: 'muted', text: 'also draw:' }));
  const pills = new Map();
  for (const L of [{ key: 'employment', label: `employers · ${full(c.orgs)}` }]) {
    const btn = h('button', {
      class: 'pill', type: 'button', text: L.label,
      onclick: () => {
        if (layers.has(L.key)) layers.delete(L.key); else layers.add(L.key);
        syncPills();
        redraw();
      },
    });
    pills.set(L.key, btn);
    toggles.appendChild(btn);
  }
  function syncPills() {
    for (const [k, btn] of pills) {
      const on = layers.has(k);
      btn.setAttribute('aria-pressed', String(on));
      btn.style.opacity = on ? '1' : '0.45';
    }
  }
  syncPills();
  box.appendChild(toggles);

  /* -- graph + panel -- */
  const split = h('div', { class: 'home-hero-split' });
  const holder = h('div', { class: 'home-hero-graph' });
  const panel = h('aside', { class: 'home-hero-panel', 'aria-live': 'polite' });
  split.appendChild(holder);
  split.appendChild(panel);
  box.appendChild(split);

  /* Shallow copies, so the cached payload is never mutated. The label is the
   * stored name alone: the scores sit in the panel, not in a word beside it. */
  const drawNodes = () => allNodes().filter(n => layers.has(layerOfNode(n))).map(n => {
    const name = n.label || '(unnamed)';
    return Object.assign({}, n, { label: name, name, role: roleOf(n) });
  });
  // The links the layers allow, the scorecard's kept in even when it is off so
  // the note can say how many the switch hides; never the kinds no row stands behind.
  const layerLinks = () => social.links.filter(l => !NOT_DRAWN.has(l.kind)
    && (layers.has(LAYER_OF_KIND[l.kind] || 'core') || LAYER_OF_KIND[l.kind] === 'scorecard'));
  const drawLinks = () => layerLinks().filter(l => layers.has(LAYER_OF_KIND[l.kind] || 'core'))
    .concat(withdrawnOn() ? W.links : []);
  const nameOf = id => (F.byId.get(id) || W.byId.get(id) || {}).label || '(unnamed)';
  const scoreOnly = social.nodes.filter(n => n.meta && n.meta.scorecard_only);
  const noteCounts = () => ({
    scorecard: scorecardOn(),
    records: drawNodes().filter(n => n.kind === 'record').length,
    scoreOnly: scoreOnly.length,
    notInGraph: scoreOnly.filter(n => n.meta.graph_rows === 0).length,
  });

  live = forceGraph(holder, {
    nodes: drawNodes(),
    links: drawLinks(),
    width: VIEW_W,
    height: VIEW_H,
    expand: split,
    colorFor: n => COLOUR[n.role] || COLOUR.other,
    linkColorFor: l => LINK_COLOUR[l.kind] || null,
    linkStyleFor: l => (l.kind === WITHDRAWN_KIND ? WITHDRAWN_STYLE : dashDerived(origins)(l)),
    nodeStyleFor: n => (archivedOnly(n) ? ARCHIVED_LOOK : null),
    onLinkHover: (l, ev, also) => {
      if (!l) { hideTip(); return; }
      const t = edgeTip(l, { nameOf, origins,
                            cut: social.cuts && social.cuts.closeness,
                            colourOf: x => LINK_COLOUR[x.kind] || 'var(--grid)',
                            graphRowsOf: id => { const m = (F.byId.get(id) || {}).meta || {};
                                                 return m.scorecard_only ? m.graph_rows : undefined; } }, also);
      showTip(ev, t.title, t.rows);
    },
    labelFor: n => (n.withdrawn_only
      ? (n.meta && n.meta.class === 'person' && n.meta.named ? true : undefined)
      : (n.role === 'other' || n.role === 'chat' || n.role === 'record' || n.role === 'event') ? undefined : true),
    faceFor: nodeFace,
    labelMax: LABEL_MAX,
    labelChars: LABEL_CHARS,
    onSelect: node => showDetail(node),
  });
  aug.update(layerLinks(), noteCounts());

  function redraw() {
    if (!live) return;
    live.update({ nodes: drawNodes(), links: drawLinks() });
    aug.update(layerLinks(), noteCounts());
    syncWdNote();
    const fresh = makeLegend();
    legendEl.replaceWith(fresh);
    legendEl = fresh;
    const rules = rulesNote();
    rulesEl.replaceWith(rules);
    rulesEl = rules;
  }

  /* -- the detail panel: what the store holds on the selected node -- */
  let selected = null;

  function showDetail(node) {
    selected = node;
    panel.textContent = '';
    if (!node) {
      panel.appendChild(h('div', { class: 'card-note', text: 'How to read this' }));
      panel.appendChild(note('Click a node, or Tab to one and press Enter. Every name here is a row in '
        + 'the store; nothing is summarised that is not in the record.'));
      panel.appendChild(keyList([
        ['node size', 'rows in the store naming it'],
        ['node colour', 'what it is to you — see the key; family and closeness are iKnow’s rules on the scorecard'],
        ['red line', byPredicate('family_circle_member', 'membership of the stored group')],
        ['yellow line', byPredicate('employed_by', 'an employment statement')],
        ['aqua node', 'an event a person is linked to'],
        ['light node', 'another record a person is linked to: a place, an app, …'],
        ...Object.keys(RECORD_LINK_WORD).filter(k => kindsPresent.has(k))
          .map(k => [RECORD_LINK_WORD[k][0], byPredicate(k, RECORD_LINK_WORD[k][1])]),
        ...(scorecardOn() ? [['blue dashed line', 'from outside the graph: a family-and-friends score of '
                              + `${full(num(social.cuts && social.cuts.closeness))} or more on the kinship scorecard`]] : []),
        ...(withdrawnOn() && W.links.length
          ? [['violet dotted line', 'a row the graph withdrew, kept in its retraction archive'],
             ['dotted outline', 'an entity with no row left in the live graph, coloured by what it is']] : []),
        ['faded node', 'no link in the layers drawn'],
      ]));
      panel.appendChild(note('Keyboard: Tab walks the nodes in size order, Enter selects, Escape clears, '
        + 'arrows pan, + and − zoom, 0\u00a0re-fits, f\u00a0fills the window.'));
      return;
    }

    const m = node.meta || {};
    const id = String(node.id);
    const role = node.role || F.roleOf(node);
    panel.appendChild(h('div', { class: 'card-note', text: 'Selected node' }));
    panel.appendChild(h('h3', { text: node.name || node.label || '(unnamed)' }));
    if (node.withdrawn_only) { archivedDetail(node, m, id); return; }

    const tags = h('div', { class: 'viz-legend' });
    const roleWord = {
      you: 'you · the owner of this Mac', group: 'a group the store holds as an entity',
      family: 'family, as scored', close: 'scored close to you', org: 'organisation',
      chat: 'group chat', other: 'person',
    }[role] || 'person';
    tags.appendChild(h('span', { class: 'pill' + (role === 'group' ? ' pill-critical' : ''),
                                 text: (role === 'record' || role === 'event') ? (m.class || role) : roleWord }));
    const t = F.kinScores.get(id);
    if (t) {
      for (const g of collapse(t.leaves, F.twinsOf)) {
        tags.appendChild(h('span', { class: 'pill', text: `${g.labels.join(' = ')} · ${score(g.score)}` }));
      }
    }
    if (F.famLink.has(id)) tags.appendChild(h('span', { class: 'pill', text: 'named by the stored group' }));
    if (role !== 'you' && node.kind === 'person' && has(m.closeness)) {
      tags.appendChild(h('span', { class: 'pill', text: `closeness ${score(m.closeness)}` }));
    }
    if (m.retracted) tags.appendChild(h('span', { class: 'pill pill-critical', text: 'entity retracted' }));
    if (m.name_withdrawn) tags.appendChild(h('span', { class: 'pill', text: 'name only in the retraction archive' }));
    panel.appendChild(tags);

    if (node.kind === 'channel') {
      panel.appendChild(kv('message rows', full(m.message_rows)));
      panel.appendChild(kv('incoming / outgoing', `${full(m.incoming)} / ${full(m.outgoing)}`));
      panel.appendChild(kv('distinct handles seen', full(m.handles)));
      panel.appendChild(kv('apps', full(m.apps)));
      panel.appendChild(kv('first / last', `${day(m.first_contact)} → ${day(m.last_contact)}`));
    } else if (node.kind === 'explicit_group') {
      panel.appendChild(kv('class', m.class || '—'));
      panel.appendChild(kv('members', full(m.members)));
      const members = F.membersOf(node).map(p => p.label || '(unnamed)');
      if (members.length) panel.appendChild(kv('named', members.join(', ')));
      panel.appendChild(kv('confidence', score(m.confidence)));
      panel.appendChild(kv('asserted', day(m.asserted)));
      panel.appendChild(kv('ingest sources', (m.sources || []).join(', ') || '—'));
    } else if (node.kind === 'org') {
      panel.appendChild(kv('class', m.class || '—'));
      panel.appendChild(kv('people employed here', full(m.employees_here)));
    } else if (node.kind === 'record') {
      panel.appendChild(kv('class', m.class || '—'));
      panel.appendChild(kv('stored rows to people', full(m.rows)));
    } else {
      panel.appendChild(kv('events invited to · has attendee', full(m.attended)));
      panel.appendChild(kv('events organised · has organizer', full(m.organized)));
      panel.appendChild(kv('events sent · calendar event sender', full(m.invited)));
      panel.appendChild(kv('phones / emails', `${full(m.phones)} / ${full(m.emails)}`));
      panel.appendChild(kv('graph facts', full(m.facts)));
      panel.appendChild(kv('interactions in the log', full(m.interactions)));
      if (m.interactions) {
        panel.appendChild(kv('incoming / outgoing', `${full(m.incoming)} / ${full(m.outgoing)}`));
        panel.appendChild(kv('first / last contact', `${day(m.first_contact)} → ${day(m.last_contact)}`));
      }
      if (Array.isArray(m.namespaces) && m.namespaces.length) {
        panel.appendChild(kv('resolves into', m.namespaces.join(', ')));
      }
      if (m.retracted) {
        panel.appendChild(note(`The live entity is gone — ${full(m.expired_rows)} rows survive in the `
          + `retraction archive, retracted ${day(m.retracted_at)}, and the closeness score was kept.`));
      }
    }

    const wdRows = withdrawnRowsAt(id);
    if (wdRows) panel.appendChild(kv('withdrawn rows linking it', full(wdRows)));

    const btns = h('div', { class: 'viz-legend' });
    sty(btns, { marginTop: '10px' });
    btns.appendChild(h('button', { class: 'ghost', type: 'button', text: 'open in the social graph →',
                                   onclick: goTo('social') }));
    if (t) {
      btns.appendChild(h('button', { class: 'ghost', type: 'button', text: 'open the scorecard →',
                                     onclick: goTo('kinship') }));
    }
    panel.appendChild(btns);

    panel.appendChild(h('div', { class: 'card-note', text: 'reading the rest of the record…' }));
    loadDetail(node);
  }

  /* How many withdrawn rows end on this node, among the links drawn. */
  function withdrawnRowsAt(id) {
    if (!withdrawnOn()) return 0;
    return W.links.reduce((s, l) => s + ((l.source === id || l.target === id) ? num(l.weight) : 0), 0);
  }

  /* An entity drawn only because a withdrawn row reaches it: what the archive
   * holds on it, from /api/retractions/graph. Nothing live to load. */
  function archivedDetail(node, m, id) {
    const tags = h('div', { class: 'viz-legend' });
    tags.appendChild(h('span', { class: node.state === 'gone' ? 'pill pill-critical' : 'pill',
      text: node.state === 'gone' ? 'no row left in the live graph' : 'live, not on this graph' }));
    if (m.class) tags.appendChild(h('span', { class: 'pill', text: m.class }));
    panel.appendChild(tags);
    if (m.named === 'archive') panel.appendChild(kv('named', 'by its withdrawn rows'));
    panel.appendChild(kv('rows in the retraction archive', full(m.archived_rows)));
    panel.appendChild(kv('rows still in the live graph', full(m.live_rows)));
    panel.appendChild(kv('withdrawn rows linking it', full(withdrawnRowsAt(id))));
    if (m.retracted_at) panel.appendChild(kv('withdrawn', day(m.retracted_at)));
    if (num(m.participants)) panel.appendChild(kv('participants', full(m.participants)));
    if (m.month) panel.appendChild(kv('month', m.month));
    const attrs = Array.isArray(m.attributes) ? m.attributes : [];
    if (attrs.length) {
      panel.appendChild(h('div', { class: 'card-note', text: 'what else the archive holds on it' }));
      for (const a of attrs.slice(0, PANEL_EVENTS)) panel.appendChild(kv(a.label, `${full(a.rows)} rows`));
      if (attrs.length > PANEL_EVENTS) {
        panel.appendChild(note(`showing ${full(PANEL_EVENTS)} of ${full(attrs.length)} kinds of row`));
      }
    }
    const btns = h('div', { class: 'viz-legend' });
    sty(btns, { marginTop: '10px' });
    btns.appendChild(h('button', { class: 'ghost', type: 'button', text: 'open the retraction archive →',
                                   onclick: goTo('retractions') }));
    panel.appendChild(btns);
  }

  async function loadDetail(node) {
    let detail;
    try {
      detail = await api('social/node', { id: node.id });
    } catch (err) {
      detail = { error: String((err && err.message) || err) };
    }
    if (selected !== node) return;
    const tail = panel.lastChild;
    if (tail) tail.remove();
    if (detail.error) { panel.appendChild(note(detail.error)); return; }
    if (detail.channel) {
      const apps = Array.isArray(detail.apps) ? detail.apps : [];
      if (apps.length) {
        panel.appendChild(h('div', { class: 'card-note', text: 'apps carrying this chat' }));
        for (const a of apps) {
          panel.appendChild(kv(a.app || a.domain || '—', `${full(a.n)} · ${day(a.first_ts)} → ${day(a.last_ts)}`));
        }
      }
      return;
    }
    const handles = Array.isArray(detail.handles) ? detail.handles : [];
    if (handles.length) {
      panel.appendChild(h('div', { class: 'card-note', text: `reachable at · ${full(handles.length)}` }));
      for (const hd of handles.slice(0, PANEL_HANDLES)) panel.appendChild(kv(hd.label || hd.kind || '—', hd.value));
      if (handles.length > PANEL_HANDLES) {
        panel.appendChild(note(`showing ${full(PANEL_HANDLES)} of ${full(handles.length)}`));
      }
    }
    const events = Array.isArray(detail.events) ? detail.events : [];
    if (events.length) {
      panel.appendChild(h('div', { class: 'card-note', text: `calendar record · ${full(events.length)} rows` }));
      for (const e of events.slice(0, PANEL_EVENTS)) {
        panel.appendChild(kv(`${e.day || '—'} · ${e.role || ''}`.trim(), e.title || '(untitled)'));
      }
      if (events.length > PANEL_EVENTS) {
        panel.appendChild(note(`showing the ${full(PANEL_EVENTS)} most recent of ${full(events.length)}`));
      }
    }
    const facts = Array.isArray(detail.facts) ? detail.facts : [];
    if (facts.length) {
      panel.appendChild(note(`${plural(facts.length, 'statement', 'statements')} in the graph — the social `
        + 'graph lists them.'));
    }
  }

  showDetail(null);
  return box;
}

/* ---------- 2 · the faces ---------- */

function facesCard(t, why) {
  const title = 'The faces it keeps';
  if (!t) return cannot(title, 'photo library', why, 'faces');
  if (t.available === false) {
    return card(title, [
      h('div', { class: 'empty', text: `The photo library could not be read on this device — ${t.reason || 'no reason given'}.` }),
      t.fix ? note(`To make it work: ${t.fix}.`) : null,
      more('Open the face index', 'faces'),
    ], { wide: true });
  }
  const kids = [];
  kids.push(lead(`${plural(t.with_faces, 'face cluster', 'face clusters')} in the photo library, over `
    + `${plural(t.assets_with_face, 'photograph', 'photographs')} — ${full(t.named)} carry a name in Photos, `
    + `${full(t.referenced)} are bound to a person in the graph.`));
  const T = t.thumbs || {};
  if (T.available === false) {
    kids.push(h('div', { class: 'callout callout-warning' }, [
      h('div', { class: 'callout-icon', text: '!' }),
      h('div', {}, [h('h4', { text: 'Previews cannot be shown' }),
                    h('p', { text: `${T.why}. To make it work: ${T.fix}.` })]),
    ]));
  }
  const strip = h('div', { class: 'home-face-strip' });
  for (const c of t.clusters || []) {
    const name = c.name || c.graph_name || null;
    const btn = h('button', {
      class: 'home-face' + (c.referenced || c.graph_bound ? ' home-face-referenced' : ''),
      type: 'button',
      title: `${name || 'cluster ' + c.prefix} · ${plural(c.faces, 'face', 'faces')} in `
           + `${plural(c.assets, 'photograph', 'photographs')} — open`,
      onclick: () => openCluster(c.id),
    });
    btn.appendChild(faceCrop(c.key_face, 88));
    btn.appendChild(h('span', { class: 'home-face-name', text: name || `cluster ${c.prefix}` }));
    btn.appendChild(h('span', { class: 'home-face-sub',
      text: `${full(c.assets)} photo${c.assets === 1 ? '' : 's'}${c.is_owner ? ' · you' : ''}` }));
    strip.appendChild(btn);
  }
  if (!(t.clusters || []).length) {
    kids.push(h('div', { class: 'empty', text: 'No face cluster in the photo library holds a face.' }));
  } else {
    kids.push(strip);
    kids.push(note(`The ${full(t.shown)} largest of ${full(t.with_faces)}, by faces. A ring marks a cluster the `
      + 'graph binds to a person. A name is what Photos calls them, or what the graph calls the person '
      + 'the cluster is bound to; a code means iKnow found no name for it in Photos or in the graph\'s name fields. '
      + 'Click a face for its photographs and who it appears with.'));
  }
  kids.push(more('Open the face index', 'faces'));
  return card(title, kids, { wide: true });
}

/* ---------- 3 · the specifics ---------- */

function familyCard(kin, social, F, why) {
  const title = 'Family, as the scorecard has it';
  if (!kin && !social) return cannot(title, 'kinship scorecard', why, 'kinship');
  const kids = [];

  if (kin) {
    kids.push(note(`${plural(kin.total, 'person', 'people')} scored on `
      + `${plural((kin.column_order || []).length, 'relationship column', 'relationship columns')}. `
      + 'The scores are the device\'s; by its shipped feature list, some inputs are relationships you declared.'));
    const identical = (kin.structure && Array.isArray(kin.structure.identical)) ? kin.structure.identical : [];
    const twinsOf = label => identical.find(k => Array.isArray(k) && k.includes(label)) || [label];
    const people = (Array.isArray(kin.claim_people) ? kin.claim_people : []).map(p => {
      const leaves = (Array.isArray(p.labels) ? p.labels : [])
        .filter(l => l && num(l.score) > 0)
        .sort((a, b) => num(b.score) - num(a.score));
      return { p, leaves, best: leaves.length ? num(leaves[0].score) : 0 };
    }).filter(x => x.leaves.length).sort((a, b) => b.best - a.best);

    if (!people.length) {
      kids.push(h('div', { class: 'empty', text: 'No person carries a specific relationship score above zero on this device.' }));
    }
    // Every non-zero column, highest first, with bit-identical columns folded
    // into one group. No column is promoted to a badge: the store holds a
    // number per column and no cut, so naming the top one would be this page's
    // call. Columns that happen to be exact sums of others stay in the line.
    for (const x of people.slice(0, FAMILY_CAP)) {
      const flags = [x.p.reachable ? 'reachable handle' : null, x.p.face ? 'face cluster' : null].filter(Boolean);
      kids.push(row({
        name: x.p.name || `unnamed · ${String(x.p.id).slice(-4)}`,
        sub: [scoreLine(collapse(x.leaves, twinsOf)), ...flags].join(' · ') || null,
      }));
    }
    if (people.length > FAMILY_CAP) {
      kids.push(note(`Showing ${full(FAMILY_CAP)} of ${full(people.length)} people with a score above zero `
        + 'in a specific relationship column.'));
    }

    const conv = kin.convergence || {};
    const rows = Array.isArray(conv.rows) ? conv.rows : [];
    const checks = Array.isArray(conv.checks) ? conv.checks : [];
    if (rows.length && checks.length) {
      kids.push(sub(`How many of iKnow’s ${full(checks.length)} checks each person passes`));
      kids.push(h('p', { class: 'card-note' }, [
        h('span', { class: 'pill pill-ours', text: 'iKnow’s analysis',
                    title: 'Computed by iKnow from the store’s rows when the page loads; the store holds none of it' }),
        document.createTextNode(' An unweighted count of iKnow’s checks; the store ranks nobody this way.')]));
      const top = rows[0];
      const agreed = checks.filter(ck => top.checks && top.checks[ck.key]).map(ck => ck.label);
      kids.push(row({
        name: top.name || `unnamed · ${String(top.id).slice(-4)}`,
        value: `${full(top.n)} of ${full(checks.length)}`,
        sub: agreed.join(' · ') || null,
      }));
      for (const r of rows.slice(1, 4)) {
        kids.push(row({ name: r.name || `unnamed · ${String(r.id).slice(-4)}`,
                        value: `${full(r.n)} of ${full(checks.length)}` }));
      }
    }
  } else {
    kids.push(note(`The kinship scorecard could not be read${why ? ' — ' + why : ''}; what follows is `
      + 'read from the graph alone.'));
    const scored = social.nodes.filter(n => F.kinScores.has(String(n.id)));
    for (const n of scored.slice(0, FAMILY_CAP)) {
      const t = F.kinScores.get(String(n.id));
      kids.push(row({ name: n.label || '(unnamed)', sub: scoreLine(collapse(t.leaves, F.twinsOf)) }));
    }
  }

  if (social) {
    const groups = social.nodes.filter(n => n.kind === 'explicit_group');
    if (groups.length) {
      kids.push(sub('The group the store asserts'));
      for (const g of groups) {
        const gm = g.meta || {};
        const members = F.membersOf(g).map(p => p.label || '(unnamed)');
        const srcs = Array.isArray(gm.sources) ? gm.sources : [];
        kids.push(row({
          name: g.label || gm.class || 'group',
          tag: plural(gm.members, 'member', 'members'),
          value: has(gm.confidence) ? `confidence ${score(gm.confidence)}` : null,
          sub: (members.length ? members.join(', ') + ' · ' : '')
             + (srcs.length ? `asserted by ${srcs.join(' + ')}` : 'no ingest source decoded'),
        }));
      }
    }
  }

  kids.push(more('Open the kinship scorecard', 'kinship'));
  return card(title, kids);
}

function reachCard(idn, F, why) {
  const title = 'Reachable, exactly as stored';
  if (!idn || !idn.handles) return cannot(title, 'join table', why, 'identity');
  const H = idn.handles;
  const rows = Array.isArray(H.rows) ? H.rows : [];
  const fan = idn.fanout || {};
  const kids = [];
  kids.push(lead(`${plural(H.handles, 'handle', 'handles')} for ${plural(H.people, 'person', 'people')} — `
    + `${plural(H.phone, 'phone number', 'phone numbers')}, ${plural(H.mail, 'mail address', 'mail addresses')}, `
    + 'plaintext.'));
  kids.push(note(`${full(fan.named)} of ${plural(fan.people, 'person entity', 'person entities')} carry a `
    + `name; ${full(fan.with_handle)} carry a handle. Numbers are dialable and addresses mailable as stored.`));
  if (!rows.length) {
    kids.push(h('div', { class: 'empty', text: 'No contact-information statement on this device carries a phone or mail value.' }));
  }
  /* you first, then the family, then whoever the graph scores close, then the named */
  const rank = r => {
    const id = String(r.id);
    if (r.is_owner) return 0;
    if (F && (F.kinScores.has(id) || F.famLink.has(id))) return 1;
    if (F && F.roleOf({ id }) === 'close') return 2;
    return r.name ? 3 : 4;
  };
  const ordered = rows.map((r, i) => ({ r, i, k: rank(r) }))
                      .sort((a, b) => a.k - b.k || a.i - b.i)
                      .map(x => x.r);
  for (const r of ordered.slice(0, REACH_CAP)) {
    kids.push(row({
      name: (r.name || 'unnamed entity') + (r.is_owner ? ' · you' : ''),
      tag: r.label || r.kind,
      value: r.value,
    }));
  }
  if (rows.length > REACH_CAP) {
    kids.push(note(`Showing ${full(REACH_CAP)} of ${full(rows.length)} — the join table lists every one, `
      + 'with where each resolves.'));
  }
  kids.push(more('Open the join table', 'identity'));
  return card(title, kids);
}

function talkCard(c, why) {
  const title = 'Who you talked to';
  if (!c) return cannot(title, 'interaction log', why, 'comms');
  if (c.present === false) return cannot(title, 'interaction log', c.store ? `${c.store} is not present` : null, 'comms');
  const t = c.totals || {};
  const P = c.people || {};
  const kids = [];
  kids.push(lead(`${plural(t.interactions, 'interaction', 'interactions')} over ${plural(t.days, 'day', 'days')}, `
    + `${plural(P.all, 'correspondent', 'correspondents')} (${full(P.named)} named), `
    + `${plural(t.apps, 'app', 'apps')} — and not one word of text.`));
  const top = Array.isArray(P.top) ? P.top : [];
  if (!top.length) kids.push(h('div', { class: 'empty', text: 'No interaction on this device resolves to a person.' }));
  for (const r of top.slice(0, TALK_CAP)) {
    kids.push(row({
      name: r.label || r.name || 'unnamed',
      value: full(r.n),
      sub: `${full(r.incoming)} in · ${full(r.outgoing)} out`
         + (r.calls ? ` · ${plural(r.calls, 'call', 'calls')}` : '')
         + (r.last_ts ? ` · last ${day(r.last_ts)}` : ''),
    }));
  }
  if (top.length > TALK_CAP) {
    kids.push(note(`Showing ${full(TALK_CAP)} of the ${full(top.length)} the endpoint ranks, out of `
      + `${full(P.all)} correspondents.`));
  }
  const q = c.rhythm && c.rhythm.quiet;
  const tz = c.rhythm && c.rhythm.tz;
  if (q && num(q.length) > 0) {
    kids.push(sub('The hours the log goes quiet (iKnow\'s heuristic)'));
    kids.push(note(`Quietest stretch ${clock(q.start)}–${clock(q.end)}${tz && tz.name ? ' ' + tz.name : ''}: `
      + `${full(q.interactions)} of the log's ${full(t.interactions)} interactions, `
      + `${pct(q.interactions, t.interactions)}, fall in those ${plural(q.length, 'hour', 'hours')}.`));
  }
  kids.push(more('Open who you talked to', 'comms'));
  return card(title, kids);
}

function groupsCard(social, F, why) {
  const title = 'Groups it keeps by name';
  if (!social) return cannot(title, 'social layer', why, 'social');
  const c = social.counts || {};
  const kids = [];
  kids.push(lead(`${plural(c.explicit_groups, 'group entity', 'group entities')}, `
    + `${plural(c.orgs, 'employer', 'employers')} and ${plural(c.channels, 'group chat', 'group chats')} `
    + 'named in the store.'));

  const groups = social.nodes.filter(n => n.kind === 'explicit_group');
  if (groups.length) {
    kids.push(sub('Stored as a group entity'));
    for (const g of groups) {
      const gm = g.meta || {};
      const members = F.membersOf(g).map(p => p.label || '(unnamed)');
      kids.push(row({
        name: g.label || gm.class || 'group',
        tag: plural(gm.members, 'member', 'members'),
        value: (Array.isArray(gm.sources) && gm.sources.length) ? gm.sources.join(' + ') : null,
        sub: members.join(', ') || null,
      }));
    }
  }

  const chans = social.nodes.filter(n => n.kind === 'channel')
                            .sort((a, b) => num(b.weight) - num(a.weight));
  if (chans.length) {
    kids.push(sub(`Group chats · ${full(c.channels)}`));
    for (const n of chans.slice(0, CHAT_CAP)) {
      const m = n.meta || {};
      kids.push(row({
        name: n.label || '(unnamed)',
        value: `${full(m.message_rows)} rows`,
        sub: m.last_contact ? `last ${day(m.last_contact)}` : null,
      }));
    }
    if (chans.length > CHAT_CAP) {
      kids.push(note(`Showing ${full(CHAT_CAP)} of ${full(chans.length)} — the social graph lists them all.`));
    }
  }

  const orgs = social.nodes.filter(n => n.kind === 'org')
                           .sort((a, b) => num(b.meta && b.meta.employees_here) - num(a.meta && a.meta.employees_here));
  if (orgs.length) {
    kids.push(sub(`Employers · ${full(c.orgs)}`));
    for (const n of orgs.slice(0, ORG_CAP)) {
      kids.push(row({ name: n.label || '(unnamed)',
                      value: plural(n.meta && n.meta.employees_here, 'person', 'people') }));
    }
    if (orgs.length > ORG_CAP) kids.push(note(`Showing ${full(ORG_CAP)} of ${full(orgs.length)}.`));
  }

  if (num(c.derived_circles) > 0) {
    kids.push(h('p', { class: 'card-note' }, [
      h('span', { class: 'pill pill-ours', text: 'iKnow’s analysis',
                  title: 'Computed by iKnow from the store’s rows when the page loads; the store holds none of it' }),
      document.createTextNode(` iKnow clusters ${plural(c.circled_people, 'person', 'people')} into `
        + `${plural(c.derived_circles, 'meeting circle', 'meeting circles')} from the events they are invited to `
        + `together (a Jaccard cut of ${full(social.cuts && social.cuts.jaccard)}); the store holds no such circles.`)]));
  }
  kids.push(more('Open the social graph', 'social'));
  return card(title, kids);
}

function aheadCard(cal, why) {
  const title = 'Events still ahead in the calendar';
  if (!cal) return cannot(title, 'calendar layer', why, 'calendar');
  const ev = cal.events || {};
  if (!cal.capture || !num(ev.date_facets)) {
    return cannot(title, 'calendar layer', 'no dated event in the store', 'calendar');
  }
  const fwd = cal.forward || {};
  const rows = Array.isArray(fwd.rows) ? fwd.rows : [];
  const kids = [];
  if (!rows.length) {
    kids.push(h('div', { class: 'empty', text: 'No event in the store starts after its last write.' }));
  } else {
    kids.push(lead(`${plural(fwd.event_dates, 'upcoming date', 'upcoming dates')} over `
      + `${plural(fwd.days, 'day', 'days')}, after the graph's last write; `
      + `${full(fwd.owner_invited)} of them list you as invited. `
      + `${plural(fwd.people, 'person', 'people')} invited, `
      + `${full(fwd.with_links)} with a dial-in or video link.`));
    for (const r of rows.slice(0, EVENT_CAP)) {
      const who = Array.isArray(r.who) ? r.who : [];
      const when = `${r.weekday || ''} ${r.date || ''}${r.time ? ' ' + r.time : ''}`.trim();
      kids.push(row({
        name: r.title || '(untitled)',
        value: when,
        sub: who.length
          ? `with ${who.slice(0, WHO_CAP).join(', ')}${who.length > WHO_CAP ? ` +${full(who.length - WHO_CAP)}` : ''}`
          : (num(r.attendees) ? `${full(r.attendees)} invited` : null),
      }));
    }
    if (rows.length > EVENT_CAP) {
      kids.push(note(`Showing ${full(EVENT_CAP)} of ${full(rows.length)} upcoming dates, soonest first.`));
    }
  }

  const legs = (cal.travel && Array.isArray(cal.travel.legs)) ? cal.travel.legs : [];
  if (legs.length) {
    kids.push(sub(`Travel · ${full(legs.length)}`));
    for (const l of legs.slice(0, LEG_CAP)) {
      const fromTo = `${l.from || '?'}${l.from_code ? ` (${l.from_code})` : ''} → `
                   + `${l.to || '?'}${l.to_code ? ` (${l.to_code})` : ''}`;
      kids.push(row({
        name: [l.carrier, l.number].filter(Boolean).join(' ') || l.title || 'reservation',
        value: l.when || null,
        sub: fromTo,
      }));
    }
    if (legs.length > LEG_CAP) kids.push(note(`Showing ${full(LEG_CAP)} of ${full(legs.length)} legs.`));
  }

  const doms = Array.isArray(cal.domains)
    ? cal.domains.slice().sort((a, b) => num(b.people) - num(a.people)) : [];
  if (doms.length) {
    kids.push(sub(`Mail domains on the invitations · ${full(doms.length)}`));
    for (const dmn of doms.slice(0, DOMAIN_CAP)) {
      kids.push(row({ name: dmn.domain,
                      value: `${plural(dmn.people, 'person', 'people')} · ${plural(dmn.events, 'event', 'events')}` }));
    }
    kids.push(note('A company domain can name an employer without naming a person.'));
  }

  kids.push(more('Open the calendar', 'calendar'));
  return card(title, kids);
}

/* ---------- 4 · every other view ---------- */

async function indexCard(o, why) {
  const title = 'Every other view of the same file';
  if (!o || !Array.isArray(o.index)) return cannot(title, 'store summary', why, 'overview');
  const metas = {};
  await Promise.all(o.index.map(async r => { metas[r.page] = await pageMeta(r.page); }));

  const box = h('section', { class: 'card card-wide' }, [
    h('header', { class: 'card-head' }, [
      h('h3', { text: `${full(o.index.length)} more views of the same file` })]),
    note('Every number here was counted from the store just now, the same way the view it points at '
       + 'counts its own.'),
  ]);
  for (const r of o.index) {
    const m = metas[r.page];
    const btn = h('button', { type: 'button', class: 'nav-index', onclick: goTo(r.page) });
    btn.appendChild(h('span', { class: 'nav-index-value', text: full(r.value) }));
    const txt = h('span', { class: 'nav-index-text' });
    txt.appendChild(h('span', { class: 'nav-index-caption', text: r.caption }));
    txt.appendChild(h('span', { class: 'nav-index-title', text: (m && m.title) || `the ${r.page} page` }));
    btn.appendChild(txt);
    const right = h('span', { class: 'nav-index-right' });
    right.appendChild(h('span', { class: 'muted', text: (m && m.nav) || r.page }));
    btn.appendChild(right);
    box.appendChild(btn);
  }
  return box;
}

/* ---------- render ---------- */

let live = null;           // the landing graph, destroyed on navigation
let gen = 0;               // render generation; a newer render or unmount() wins

export function unmount() {
  gen++;
  if (live) {
    try { live.destroy(); } catch { /* already gone */ }
    live = null;
  }
}

export async function render(root) {
  const mine = ++gen;
  const want = ['social', 'kinship', 'identity', 'comms', 'calendar', 'overview', 'faces/top',
                'retractions/graph'];
  const got = await Promise.allSettled(want.map(p => api(p)));
  if (mine !== gen) return;                      // the reader has already moved on

  const d = {}, why = {};
  want.forEach((p, i) => {
    if (got[i].status === 'fulfilled') d[p] = got[i].value;
    else why[p] = String((got[i].reason && got[i].reason.message) || got[i].reason);
  });

  const social = (d.social && d.social.available !== false) ? d.social : null;
  const F = social ? derive(social, d.kinship || null) : null;
  const socialWhy = d.social && !social ? 'the graph store is not present' : why.social;

  root.appendChild(graphCard(social, F, socialWhy, d['retractions/graph'] || null));
  root.appendChild(facesCard(d['faces/top'] || null, why['faces/top']));
  root.appendChild(h('div', { class: 'grid' }, [
    familyCard(d.kinship || null, social, F, why.kinship),
    reachCard(d.identity || null, F, why.identity),
    talkCard(d.comms || null, why.comms),
    groupsCard(social, F, socialWhy),
    aheadCard(d.calendar || null, why.calendar),
  ]));
  root.appendChild(h('hr', { class: 'rule' }));
  root.appendChild(await indexCard(d.overview || null, why.overview));
}
