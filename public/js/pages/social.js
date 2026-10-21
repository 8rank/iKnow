/* social.js — the social graph: who the store links to whom, and how.
 *
 * Four layers, drawn as one picture: a stored group entity with its membership
 * facets, calendar co-attendance, the per-person closeness scorecard, and a
 * year of group-chat metadata. The calendar overlap is clustered into circles
 * at a cut the reader can move; the group chats are clustered the same way on
 * shared participants. The catalogue also carries fixed buckets — the owner
 * anchor, the employers and their employees, and the residue the rule could not
 * place — and those are counted apart from the circles, so the table never
 * claims more structure than the data holds.
 *
 * The component inspector is the second half of the page. Open a circle and the
 * rule that formed it is on screen in words, with the parameters it ran with,
 * its members, its cohesion, and the measured pairwise overlap it fired on — or,
 * for the stored group, the actual statements with their confidence and ingest
 * sources. The cut controls and the sensitivity sweep show how the circle count
 * moves with the threshold.
 *
 * Nothing on this page is hardcoded from the store. Every name, count, cut and
 * threshold on screen arrives in a payload at request time.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, columns, lines, hero, meter, legend, keyList, tableView,
         full, pct, day, SERIES, showTip, hideTip } from '../viz.js';
import { forceGraph } from '../force.js';
import { nodeFace } from '../facedrawer.js';
import { originsOf, predicatesOf, dashDerived, augmentNote, scorecardSwitch, edgeTip, NOT_DRAWN, SCORECARD_KIND,
         SCORECARD_COLOUR, RECORD_KINDS, RECORD_NODE_COLOUR,
         RECORD_LINK_COLOUR } from '../linkorigin.js';

export const meta = {
  id: 'social',
  nav: 'Social graph',
  group: 'What it recorded',
  kicker: 'Who knows whom',
  title: 'Who your Mac links to whom: the graph as the store keeps it, and the circles iKnow finds in it',
  blurb: 'The store holds a group entity with its members, the people invited to each calendar event, '
       + 'a family-and-friends score per person in its kinship scorecard, and a log of message '
       + 'metadata in its interaction log. The graph draws the store’s rows as they are, with the '
       + 'scorecard on top. Everything marked iKnow’s analysis is this app’s own work over those rows, '
       + 'stored nowhere: it clusters shared invitations into meeting circles and group chats into '
       + 'chat clusters, at cuts you can move, and opens any circle to its members and the evidence '
       + 'behind it.',
};

/* ---------- static UI copy and API bounds. No row values live here. ---------- */

const VIEW_W = 1080;
const VIEW_H = 660;

/* The accepted parameter ranges of /api/social. The endpoint reports its own
 * ranges in `cuts.ranges` and its own defaults in `cuts.defaults`, and those win
 * wherever they arrive; these are the contract's bounds, used only as a fallback
 * so the sliders still have ends if the endpoint stops saying. The value actually
 * APPLIED is never assumed — it comes back in `cuts` and resets the control. */
const FALLBACK_RANGE = { jaccard: [0.05, 0.95], channel_share: [1, 10] };
const FALLBACK_STEP = { jaccard: 0.05, channel_share: 1 };

/* This page's own caps, on top of whatever the endpoint already capped. Both are
 * announced on screen whenever either one bites. */
const MEMBER_CAP = 80;
const PAIR_CAP = 200;
const TRIPLE_CAP = 200;
const SHARED_CAP = 60;
const EXAMPLE_CAP = 3;
const COMPONENT_CAP = 80;

/* Fixed slot order for edge kinds, counted DOWN from the top of the palette so
 * that in the default view the link scale and the node-cluster scale (counted
 * up from slot 0) do not meet. Both are the same eight-slot categorical scale,
 * used in fixed order and never cycled. */
const KIND_ORDER = ['family_circle_member', 'co_attendance', 'organizer_to_attendee',
                    'inferred_closeness', 'employed_by', 'channel_member', 'shared_handles',
                    'stored_person_link', ...RECORD_KINDS];
/* The first seven own those slots; the kinds after them carry the colours
 * linkorigin.js gives them, so adding a kind never repaints an existing one. */
const KIND_SLOTS = 7;

const KIND_LABEL = {
  family_circle_member: 'Family-circle membership',
  co_attendance: 'Invited to the same meeting',
  organizer_to_attendee: 'Organised a meeting they were invited to',
  inferred_closeness: 'Scored as close to you',
  employed_by: 'Employed by',
  channel_member: 'In this group chat',
  shared_handles: 'Chats sharing a participant',
  stored_person_link: 'Stored person-to-person statement',
  event_attendee: 'Listed as an event’s attendee',
  event_organizer: 'Listed as an event’s organiser',
  event_sender: 'Sent an event found in an app',
  record_link: 'Other stored link to a record',
};

const BUCKET_LABEL = {
  explicit: 'Stored group',
  owner: 'You',
  solo: 'In meetings, in no circle',
  unplaced: 'Known, but placed in no circle',
  solo_chat: 'Chat overlapping no other chat',
  employer: 'Organisation, not a person',
  employee: 'Reached only through an employer',
};

/* The catalogue keys that are fixed buckets rather than an output of the
 * clustering rule. These are protocol keys of /api/social, not row values.
 * `explicit` is in the list too — but it is the one key the store can back with
 * a group entity of its own, so kindOf() lets the payload's nodes overrule this
 * set rather than the other way round. */
const FIXED_BUCKETS = new Set(Object.keys(BUCKET_LABEL));

const LAYERS = [
  { key: 'core', label: 'People, meetings, the stored group', fixed: true },
  { key: 'employment', label: 'Employers' },
];

const LAYER_OF_KIND = {
  employed_by: 'employment',
  channel_member: 'chats',
  shared_handles: 'chats',
  [SCORECARD_KIND]: 'scorecard',
  ...Object.fromEntries(RECORD_KINDS.map(k => [k, 'records'])),
};

/* evidence.kind, as the component endpoint reports it. */
const EVIDENCE_LABEL = {
  calendar: 'Measured calendar overlap — the meetings each pair actually shared',
  channels: 'Measured chat overlap — the participant handles each pair of chats shares',
  employer: 'Stored employment statements, read out of the graph',
  group: 'Group-membership facets on the group entity the store types as a group',
  none: 'No positive evidence — this is where the rule puts what it could not place',
};

const ISOLATE_MODES = [
  { key: 'highlight', label: 'Highlight it in place',
    hint: 'every node stays on screen; the component keeps its colour and everything else greys out' },
  { key: 'only', label: 'Show only this component',
    hint: 'the graph is rebuilt from this component’s nodes and the links between them' },
  { key: 'none', label: 'Show everything',
    hint: 'drop the isolation and put every node back — the component stays open below' },
];

/* ---------- small helpers ---------- */

const sty = (node, props) => { for (const k in props) node.style[k] = props[k]; return node; };
const grid = (...kids) => h('div', { class: 'grid' }, kids.filter(Boolean));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const score = v => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(3));

/** "1 meeting circle" / "3 meeting circles" — every count on this page is
 *  computed, and the cuts are adjustable, so any count can be 1 on some setting.
 *  A hardcoded plural beside a live number is a small lie waiting for a slider. */
const plural = (n, one, many) => `${full(n)} ${num(n) === 1 ? one : many}`;
const near = (a, b) => Math.abs(num(a) - num(b)) < 1e-9;

let uid = 0;
const nextId = prefix => `${prefix}-${++uid}`;

/** Values arrive from a personal store and may be anything. Never assume. */
function textOf(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return full(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    for (const k of ['label', 'title', 'name', 'handle', 'day', 'text', 'value', 'id']) {
      if (v[k] !== undefined && v[k] !== null && typeof v[k] !== 'object') return textOf(v[k]);
    }
    try { return JSON.stringify(v).slice(0, 90); } catch { return '—'; }
  }
  return String(v);
}

/** An evidence row: its own words, plus the day behind it when it has one. */
function evidenceText(v) {
  const head = textOf(v);
  if (v && typeof v === 'object' && v.day && String(v.day) !== head) return `${head} · ${v.day}`;
  return head;
}

/** A table cell for a field whose shape the contract leaves open. */
function cellOf(v) {
  if (Array.isArray(v)) {
    if (!v.length) return '—';
    const head = v.slice(0, EXAMPLE_CAP).map(evidenceText).join(' · ');
    return v.length > EXAMPLE_CAP ? `${head} · +${full(v.length - EXAMPLE_CAP)} more` : head;
  }
  return evidenceText(v);
}

function layerOfNode(n) {
  if (n.meta && n.meta.scorecard_only) return 'scorecard';     // here only because of a score
  if (n.kind === 'record' || n.group === 'stored_only') return 'records';
  if (n.kind === 'channel') return 'chats';
  if (n.kind === 'org' || n.group === 'employee') return 'employment';
  return 'core';
}

/* The mark on everything this page computes itself — clusters, cuts, sweeps,
 * pairings: iKnow's work over the store's rows, stored nowhere. */
const oursPill = () => h('span', {
  class: 'pill pill-ours', text: 'iKnow’s analysis',
  title: 'Computed by iKnow from the store’s rows when the page loads; the store holds none of it',
});
/** Mark a card built by figure() as iKnow's analysis. */
function ours(card) {
  const head = card.querySelector('.card-head');
  if (head) head.insertBefore(oursPill(), head.querySelector('button'));
  return card;
}

function callout({ title, body, tone }) {
  return h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);
}

function swatch(colour) {
  const key = h('span', { class: 'viz-key viz-key-rect' });
  key.style.background = colour;
  sty(key, { marginRight: '6px', verticalAlign: 'middle' });
  return key;
}

function subhead(text) {
  const el = h('div', { class: 'card-note', text });
  sty(el, { fontWeight: '620', color: 'var(--text-primary)', marginTop: '14px' });
  return el;
}

function kvRow(label, value) {
  const line = h('div');
  sty(line, { display: 'flex', justifyContent: 'space-between', gap: '10px',
              fontSize: '12px', padding: '3px 0', borderBottom: '1px solid var(--border)' });
  line.appendChild(h('span', { class: 'muted', text: label }));
  line.appendChild(h('span', { text: value }));
  return line;
}

/** A plain read-only table, for evidence that is a table and not a chart. */
function plainTable(cols, rows) {
  const wrap = h('div', { class: 'viz-table-wrap' });
  const table = h('table', { class: 'viz-table' });
  const thead = h('thead');
  thead.appendChild(h('tr', {}, cols.map(c => h('th', { text: c }))));
  table.appendChild(thead);
  const tbody = h('tbody');
  for (const r of rows) {
    tbody.appendChild(h('tr', {}, r.map(v => h('td', { text: v === null || v === undefined ? '—' : String(v) }))));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ---------- render ---------- */

export async function render(root) {
  const first = await api('social');

  if (!first.available) {
    root.appendChild(h('div', { class: 'empty' },
      [h('span', { text: 'The graph store is not present on this device, so no social layer can be read.' })]));
    return;
  }

  /* The defaults are whatever the endpoint applied on the untouched request —
   * read at runtime, never typed in. */
  const DEFAULTS = {
    jaccard: num(first.cuts && first.cuts.jaccard),
    channel_share: num(first.cuts && first.cuts.channel_share),
  };

  /* State that must survive a re-cluster. */
  const ui = {
    layers: new Set(['core']),
    offKinds: new Set(),
    scorecard: true,         // the one addition from outside the graph, on until switched off
    sortKey: 'weight', sortDir: -1,
    compKey: 'members', compDir: -1,
    openKey: null,
    lostKey: null,               // a component that vanished when the cut moved
    mode: ISOLATE_MODES[0].key,
    requested: null,             // the cuts we last asked for, before clamping
    fetchError: null,
  };

  const detailCache = new Map();

  /* Whether a layer is drawn. The records are always drawn, the scorecard is the
   * switch's, and the group chats no longer are (their lines had no row behind them). */
  const layerOn = key => (key === 'records' ? true
    : key === 'scorecard' ? ui.scorecard
    : key === 'chats' ? false : ui.layers.has(key));

  let d = first;
  let graph = null;
  let openComp = null;           // the last /api/social/component payload
  let isoSet = new Set();        // node ids of the open component
  let reqToken = 0;
  let compToken = 0;
  let busyEl = null;
  let cutInputs = [];

  build();

  /* ---------------- re-cluster ---------------- */

  function rebuild() {
    const y = typeof scrollY === 'number' ? scrollY : 0;
    if (graph) { try { graph.destroy(); } catch { /* already gone */ } graph = null; }
    root.textContent = '';
    build();
    if (typeof scrollTo === 'function') scrollTo(0, y);
  }

  async function requestCuts(patch) {
    const req = {
      jaccard: patch.jaccard !== undefined ? patch.jaccard : num(d.cuts && d.cuts.jaccard),
      channel_share: patch.channel_share !== undefined ? patch.channel_share
                                                       : num(d.cuts && d.cuts.channel_share),
    };
    const mine = ++reqToken;
    ui.requested = req;
    ui.fetchError = null;
    setBusy(true);
    let next;
    try {
      next = await api('social', req);
    } catch (err) {
      if (mine !== reqToken) return;
      ui.fetchError = String((err && err.message) || err);
      setBusy(false);
      return;
    }
    if (mine !== reqToken) return;
    if (!next || !next.available) {
      ui.fetchError = 'the endpoint answered, but reported no social layer at that cut';
      setBusy(false);
      return;
    }
    d = next;
    openComp = null;
    rebuild();
  }

  function setBusy(on) {
    for (const inp of cutInputs) inp.disabled = on;
    if (!busyEl) return;
    if (on) {
      busyEl.textContent = 're-clustering the whole graph at the new cut…';
      busyEl.className = 'card-note';
    } else if (ui.fetchError) {
      busyEl.textContent = `the re-cluster failed — ${ui.fetchError}. The picture below is still the last cut that worked.`;
      busyEl.className = 'card-note';
    }
  }

  /* ---------------- the page ---------------- */

  function build() {
    const c = d.counts || {};
    const cuts = d.cuts || {};
    let inspectorCard = null;

    /* cluster display names, numbered at runtime in catalogue order */
    const names = new Map();
    let circleN = 0, chatN = 0;
    for (const cl of d.clusters) {
      if (cl.key.startsWith('circle:')) names.set(cl.key, `Meeting circle ${++circleN}`);
      else if (cl.key.startsWith('chat:')) names.set(cl.key, `Chat cluster ${++chatN}`);
      else names.set(cl.key, BUCKET_LABEL[cl.key] || cl.key);
    }
    const clusterName = k => names.get(k) || k;
    const clusterOf = k => d.clusters.find(x => x.key === k) || null;

    /* an open component may not survive a move of the cut — that is the point */
    if (ui.openKey && !clusterOf(ui.openKey)) { ui.lostKey = ui.openKey; ui.openKey = null; }

    const slotColour = new Map();
    for (const cl of d.clusters) {
      if (cl.slot !== null && cl.slot !== undefined) slotColour.set(cl.key, SERIES(cl.slot));
    }
    const clusterColour = k => (k === 'explicit' ? 'var(--status-critical)'
      : slotColour.get(k) || 'var(--text-muted)');

    const nodeById = new Map(d.nodes.map(n => [String(n.id), n]));

    /* What kind of catalogue row each one is. `is_component` is the endpoint's
     * own answer wherever it sends one — it says false for the residue. A stored
     * group is one this payload's own nodes prove: an entity the store types as a
     * group IS the group. A meeting circle or a chat cluster is an output of the
     * clustering rule; everything else is a fixed bucket. */
    const groupEntityKeys = new Set(d.nodes
      .filter(n => n.kind === 'explicit_group' && n.group !== null && n.group !== undefined)
      .map(n => String(n.group)));
    const kindOf = cl => {
      if (!cl) return 'bucket';
      if (cl.is_component === false) return 'bucket';
      const key = String(cl.key);
      if (groupEntityKeys.has(key)) return 'stored group';
      if (FIXED_BUCKETS.has(key)) return 'bucket';
      if (key.startsWith('circle:')) return 'meeting circle';
      if (key.startsWith('chat:')) return 'chat cluster';
      return 'bucket';
    };

    /* Whether the owner is one of the members the stored group's facets name —
     * read off the payload's own links, never assumed. */
    const groupNodes = d.nodes.filter(n => n.kind === 'explicit_group');
    const ownerId = (d.owner === null || d.owner === undefined) ? null : String(d.owner);
    const groupNodeIds = new Set(groupNodes.map(gn => String(gn.id)));
    const ownerIsNamedMember = ownerId !== null && d.links.some(l => {
      const a = String(l.source), b = String(l.target);
      return (groupNodeIds.has(a) && b === ownerId) || (groupNodeIds.has(b) && a === ownerId);
    });

    const colorFor = n => {
      if (ui.openKey && ui.mode === 'highlight' && !isoSet.has(String(n.id))) return 'var(--axis)';
      if (n.kind === 'owner') return 'var(--text-primary)';
      if (n.kind === 'explicit_group') return 'var(--status-critical)';
      if (n.kind === 'record') return RECORD_NODE_COLOUR;
      return slotColour.get(n.group) || 'var(--text-muted)';
    };

    const kindMeta = k => d.link_kinds.find(x => x.kind === k) || {};
    const presentKinds = KIND_ORDER.filter(k => kindMeta(k).count > 0 && !NOT_DRAWN.has(k));
    const kindColour = new Map(
      KIND_ORDER.map((k, i) => [k, k === SCORECARD_KIND ? SCORECARD_COLOUR
                                  : i < KIND_SLOTS ? SERIES(KIND_SLOTS - 1 - i) : RECORD_LINK_COLOUR[k]]));
    const origins = originsOf(d);
    const predicates = predicatesOf(d);
    /* A kind the filters and layers allow, the scorecard's whatever its switch says
     * (so the note can count what the switch hides), and never a kind no row stands
     * behind; then the ones the scorecard switch holds off. */
    const kindAllowed = k => !ui.offKinds.has(k) && !NOT_DRAWN.has(k)
      && (layerOn(LAYER_OF_KIND[k] || 'core') || LAYER_OF_KIND[k] === 'scorecard');
    const kindHeld = k => LAYER_OF_KIND[k] === 'scorecard' && !ui.scorecard;
    const activeKindSet = () => new Set(presentKinds.filter(k => kindAllowed(k) && !kindHeld(k)));
    const scoreOnly = d.nodes.filter(n => n.meta && n.meta.scorecard_only);
    const linkColorFor = l => {
      if (ui.openKey && ui.mode === 'highlight'
          && !(isoSet.has(String(l.source)) && isoSet.has(String(l.target)))) return 'var(--grid)';
      return kindColour.get(l.kind) || 'var(--grid)';
    };

    /* ---------------- 1. the lead number ---------------- */

    root.appendChild(hero({
      value: c.people,
      label: c.people === 1 ? 'person on the graph' : 'people on the graph',
      detail: `Linked, as the store keeps it, to ${plural(c.records, 'event and other record', 'events and other records')}, `
            + `${plural(c.explicit_groups, 'stored group', 'stored groups')} and `
            + `${plural(c.orgs, 'employer', 'employers')}`
            + (c.scorecard_only_people ? `; ${full(c.scorecard_only_people)} of them are here only for a kinship-scorecard score. ` : '. ')
            + `iKnow’s analysis: ${plural(c.derived_circles, 'meeting circle', 'meeting circles')} and `
            + `${plural(c.chat_clusters, 'chat cluster', 'chat clusters')}, clustered from overlap at `
            + 'the cuts below — open any one and the rule, its parameters and the evidence it fired on '
            + 'are on screen.',
    }));

    root.appendChild(h('div', { class: 'grid grid-tight' }, [
      statTile({
        label: 'Links drawn',
        // every row-backed kind and the scorecard; the person-to-person joins are not drawn
        value: d.links.filter(l => !NOT_DRAWN.has(l.kind)).length,
        sub: `${plural(presentKinds.length, 'kind', 'kinds')} `
           + 'of link, including '
           + `${full(c.explicit_members)} group-membership facets`
           + (ownerIsNamedMember ? ', one of them you' : ''),
      }),
      statTile({
        label: 'Meeting circles · iKnow’s analysis',
        value: c.derived_circles,
        sub: `at a Jaccard cut of ${full(cuts.jaccard)}; `
           + `${plural(c.chat_clusters, 'chat cluster', 'chat clusters')} at ${full(cuts.channel_share)} shared participants`,
      }),
      statTile({
        label: 'People on the graph',
        value: c.people,
        sub: `${full(c.calendar_people)} reached through the calendar`,
      }),
      statTile({
        label: 'People iKnow places in a meeting circle',
        value: c.circled_people,
        sub: `${full(num(c.unplaced_people) + num(c.solo_people))} outside any circle — open the inspector`,
        tone: 'warning',
        onclick: () => { if (inspectorCard) inspectorCard.scrollIntoView({ block: 'start' }); },
      }),
      statTile({
        label: 'Group chats the interaction log names',
        value: c.channels,
        sub: `outside the graph; ${full(c.channels_with_resolved_person)} contain a person iKnow can match to it`,
      }),
      statTile({
        label: 'People on the kinship scorecard',
        value: c.scored_people,
        sub: `outside the graph; ${full(c.above_closeness_cut)} at or above iKnow’s cut of ${full(cuts.closeness)}`,
      }),
    ]));

    /* ---------------- 2. the clustering cuts, live ---------------- */

    const controls = h('section', { class: 'card card-wide' });
    controls.appendChild(h('header', { class: 'card-head' }, [
      h('h3', { text: 'Clustering cuts — move them and every circle below is redrawn' }), oursPill(),
    ]));
    controls.appendChild(h('p', {
      class: 'card-note',
      text: 'Two thresholds, stored nowhere: the share of meetings two people must have in common '
          + 'to be joined into one circle, and the number of participants two group chats must share '
          + 'to be clustered together. Move either and only the circles are recomputed; the '
          + 'statements under them do not change.',
    }));

    const cutRow = h('div');
    sty(cutRow, { display: 'flex', flexWrap: 'wrap', gap: '18px 26px', alignItems: 'flex-end',
                  margin: '4px 0 10px' });
    cutInputs = [];

    const ranges = (cuts.ranges && typeof cuts.ranges === 'object') ? cuts.ranges : {};
    const defaults = (cuts.defaults && typeof cuts.defaults === 'object') ? cuts.defaults : DEFAULTS;
    const swept = (cuts.swept && typeof cuts.swept === 'object') ? cuts.swept : {};
    const rangeOf = k => (Array.isArray(ranges[k]) && ranges[k].length === 2 ? ranges[k] : FALLBACK_RANGE[k]);
    /* the step is the spacing of the endpoint's own sweep, so the slider can only
     * stop where the sensitivity chart has a measured point */
    const stepOf = k => {
      const list = Array.isArray(swept[k]) ? swept[k].map(num).sort((a, b) => a - b) : [];
      if (list.length > 1) {
        const gap = Math.round(Math.min(...list.slice(1).map((v, i) => v - list[i])) * 1e6) / 1e6;
        if (gap > 0) return gap;
      }
      return FALLBACK_STEP[k];
    };
    const jr = rangeOf('jaccard'), sr = rangeOf('channel_share');

    const jac = cutControl({
      label: 'Meeting-circle cut · Jaccard overlap of two people’s meeting sets',
      hint: 'two people are joined at or above this share of the meetings either is invited to — or are '
          + 'joined to someone who is, because single linkage needs only a chain'
          + ` · the endpoint accepts ${full(jr[0])} to ${full(jr[1])}`,
      min: jr[0], max: jr[1], step: stepOf('jaccard'),
      value: num(cuts.jaccard), fmt: v => v.toFixed(2),
      onchange: v => requestCuts({ jaccard: Math.round(v * 1e6) / 1e6 }),
    });
    const shr = cutControl({
      label: 'Chat-cluster cut · participant handles two group chats share',
      hint: 'two chats join the same cluster at or above this many shared participants'
          + ` · the endpoint accepts ${full(sr[0])} to ${full(sr[1])}`,
      min: sr[0], max: sr[1], step: stepOf('channel_share'),
      value: num(cuts.channel_share), fmt: v => String(Math.round(v)),
      onchange: v => requestCuts({ channel_share: Math.round(v) }),
    });
    cutRow.appendChild(jac.box);
    cutRow.appendChild(shr.box);

    const resetBox = h('div');
    sty(resetBox, { display: 'flex', flexDirection: 'column', gap: '6px' });
    const atDefault = near(cuts.jaccard, defaults.jaccard) && near(cuts.channel_share, defaults.channel_share);
    const reset = h('button', {
      class: 'ghost', type: 'button',
      text: `Back to the defaults · ${full(defaults.jaccard)} / ${full(defaults.channel_share)}`,
      onclick: () => requestCuts({ jaccard: num(defaults.jaccard), channel_share: num(defaults.channel_share) }),
    });
    reset.disabled = atDefault;
    resetBox.appendChild(reset);
    cutRow.appendChild(resetBox);
    controls.appendChild(cutRow);

    /* What the endpoint says it did with the request — its words, not a guess
     * made here by comparing numbers. */
    busyEl = h('p', { class: 'card-note' });
    const how = (cuts.how && typeof cuts.how === 'object') ? cuts.how : {};
    const asked = (cuts.requested && typeof cuts.requested === 'object') ? cuts.requested : {};
    const adjusted = (Array.isArray(cuts.adjusted) ? cuts.adjusted : [])
      .filter(k => asked[k] !== null && asked[k] !== undefined);
    const applied = `Applied by the endpoint: Jaccard ${full(cuts.jaccard)}, `
                  + `${full(cuts.channel_share)} shared participants, closeness ${full(cuts.closeness)}. `
                  + `At most ${full(cuts.slots)} circles can carry a colour; any beyond that are grey.`;
    busyEl.textContent = ui.fetchError
      ? `the re-cluster failed — ${ui.fetchError}. The picture below is still the last cut that worked.`
      : adjusted.length
        ? `The endpoint did not use every value as asked. `
          + adjusted.map(k => `${k}: asked for ${textOf(asked[k])}, ${textOf(how[k])}, applied `
                            + `${full(cuts[k])}`).join('; ')
          + '. Everything below is the applied cut, never the requested one.'
        : applied;
    controls.appendChild(busyEl);
    root.appendChild(grid(controls));

    /* ---------------- 3. how the rule responds to its own cut ---------------- */

    const sweep = Array.isArray(d.sensitivity) ? d.sensitivity.filter(r => r && r.jaccard !== undefined) : [];
    const sweepC = Array.isArray(d.sensitivity_channels)
      ? d.sensitivity_channels.filter(r => r && r.share !== undefined) : [];

    if (!sweep.length && !sweepC.length) {
      const missing = h('section', { class: 'card card-wide' });
      missing.appendChild(h('header', { class: 'card-head' }, [
        h('h3', { text: 'How the clustering responds to the cut' }), oursPill(),
      ]));
      missing.appendChild(h('div', { class: 'empty' }, [h('span', {
        text: 'This endpoint is not reporting a sensitivity sweep, so this panel cannot show how '
            + 'the circle count moves with the cut. Rather than draw a curve from one point, it '
            + 'shows nothing — move the controls above and watch the counts change instead.',
      })]));
      root.appendChild(grid(missing));
    } else {
      const figs = [];
      const isApplied = (r, k, v) => (r.applied === undefined ? near(r[k], v) : Boolean(r.applied));
      if (sweep.length) {
        const atCut = sweep.find(r => isApplied(r, 'jaccard', cuts.jaccard));
        const circles = sweep.map(r => num(r.circles));
        const lo = Math.min(...circles), hi = Math.max(...circles);
        const sweepRows = sweep.map(r => [
          full(r.jaccard), full(r.circles), full(r.placed), full(r.unplaced), full(r.largest),
          isApplied(r, 'jaccard', cuts.jaccard) ? 'applied now' : '',
        ]);
        const sweepCols = ['Jaccard cut', 'circles', 'people placed', 'people unplaced',
                           'largest circle', 'the cut applied'];

        figs.push(ours(figure({
          title: 'The same store yields a different number of circles at every cut',
          note: `Nothing in the graph changes across this sweep — only the threshold does, `
              + `and the count of circles runs from ${full(lo)} to ${full(hi)}. `
              + (atCut
                  ? `At the ${full(cuts.jaccard)} now applied the rule finds ${full(atCut.circles)} `
                    + `circles and leaves ${full(atCut.unplaced)} people unplaced.`
                  : `The cut now applied, ${full(cuts.jaccard)}, is not one of the sweep’s steps, `
                    + `so read the curve either side of it.`),
          chart: lines([{ label: 'circles the rule finds', points: sweep.map(r => ({ x: num(r.jaccard), y: num(r.circles) })) }],
            { xFmt: v => v.toFixed(2), yFmt: full }),
          table: tableView(sweepCols, sweepRows),
        })));

        figs.push(ours(figure({
          title: 'And a different set of people inside them',
          note: 'Three counts of people, on one axis because they are all counts of people: how '
              + 'many the rule places in some circle, how many it leaves out, and how many end up '
              + 'in the single largest circle. Raising the cut shrinks the circles and grows the '
              + 'unplaced pile; lowering it eventually collapses everyone into one blob.',
          legend: legend([
            { label: 'people placed in a circle', color: SERIES(0) },
            { label: 'people the rule cannot place', color: SERIES(1) },
            { label: 'people in the largest circle', color: SERIES(2) },
          ], 'line'),
          chart: lines([
            { label: 'placed', color: SERIES(0), points: sweep.map(r => ({ x: num(r.jaccard), y: num(r.placed) })) },
            { label: 'unplaced', color: SERIES(1), points: sweep.map(r => ({ x: num(r.jaccard), y: num(r.unplaced) })) },
            { label: 'largest circle', color: SERIES(2), points: sweep.map(r => ({ x: num(r.jaccard), y: num(r.largest) })) },
          ], { xFmt: v => v.toFixed(2), yFmt: full }),
          table: tableView(sweepCols, sweepRows),
        })));
      }

      if (sweepC.length) {
        const idx = sweepC.findIndex(r => isApplied(r, 'share', cuts.channel_share));
        const cl = sweepC.map(r => num(r.clusters));
        figs.push(ours(figure({
          title: 'The chat cut does the same thing to the group chats',
          note: `Two chats are called related when they share this many participant handles. `
              + `Across the sweep the cluster count runs from ${full(Math.min(...cl))} to `
              + `${full(Math.max(...cl))}; the highlighted bar is the ${full(cuts.channel_share)} `
              + `now applied. Everything else is greyed — one story, one colour.`,
          chart: bars(sweepC.map(r => ({
            label: `${full(r.share)} shared`, value: num(r.clusters),
            meta: 'chat clusters',
          })), { emphasis: idx >= 0 ? idx : null, labelW: 120 }),
          table: tableView(['shared participants', 'chat clusters', 'chats placed', 'largest cluster', 'the cut applied'],
            sweepC.map(r => [full(r.share), full(r.clusters), full(r.placed), full(r.largest),
                             isApplied(r, 'share', cuts.channel_share) ? 'applied now' : ''])),
        })));
      }
      root.appendChild(grid(...figs));
    }

    /* ---------------- 4. the component inspector ---------------- */

    inspectorCard = h('section', { class: 'card card-wide' });
    inspectorCard.appendChild(h('header', { class: 'card-head' }, [
      h('h3', { text: 'Open a circle: who is in it, and what put them there' }), oursPill(),
    ]));

    const listed = d.clusters.filter(x => num(x.members) > 0);
    const empties = d.clusters.length - listed.length;
    const comps = listed.filter(x => kindOf(x) !== 'bucket');
    const filed = listed.filter(x => kindOf(x) === 'bucket');
    const storedN = comps.filter(x => kindOf(x) === 'stored group').length;
    const circleRows = comps.filter(x => kindOf(x) === 'meeting circle').length;
    const chatRows = comps.filter(x => kindOf(x) === 'chat cluster').length;
    const filedNodes = filed.reduce((t, x) => t + num(x.members), 0);

    inspectorCard.appendChild(h('p', {
      class: 'card-note',
      text: `${full(comps.length)} of these rows are circles — `
          + `${plural(storedN, 'stored group', 'stored groups')}, `
          + `${plural(circleRows, 'meeting circle', 'meeting circles')} and `
          + `${plural(chatRows, 'chat cluster', 'chat clusters')}. The other `
          + `${full(filed.length)} rows, holding ${full(filedNodes)} nodes between them, are catalogue `
          + `buckets: the owner, the employers and their employees, chats overlapping no other chat, `
          + `and the people no circle holds. They are listed because the reason a node is NOT in a `
          + `circle is evidence too, and they are counted apart so the table never claims more `
          + `structure than the data holds. `
          + `Click any row to open it: the rule that made it in words, the parameters it ran with, `
          + `its members, and the evidence — measured pairwise overlap for a clustered circle, the `
          + `actual statements with their confidence and ingest sources for the stored group. `
          + (empties ? `${full(empties)} catalogue entries hold nothing here and are not listed. ` : '')
          + 'Sort by any column; the header you sorted on carries an arrow.',
    }));

    if (ui.lostKey) {
      inspectorCard.appendChild(callout({
        tone: 'warning',
        title: 'The circle you had open does not exist at this cut',
        body: `"${clusterName(ui.lostKey)}" was a circle of the previous cut and is not a `
            + 'circle of this one. No record was added or removed to make that happen — only '
            + 'the threshold moved.',
      }));
      ui.lostKey = null;
    }

    const COMP_COLS = [
      { key: 'name', label: 'component', num: false, get: x => clusterName(x.key) },
      { key: 'kind', label: 'kind', num: false, get: x => kindOf(x) },
      { key: 'members', label: 'members', num: true, get: x => num(x.members) },
      { key: 'layer', label: 'read from', num: false, get: x => String(x.layer || '—') },
      { key: 'rule', label: 'the rule that put them there', num: false, get: x => ruleLine(x) },
    ];

    function ruleLine(cl) {
      const kind = kindOf(cl);
      if (kind === 'bucket') {
        return cl.note ? String(cl.note) : 'a catalogue bucket — nothing in the store groups these together';
      }
      if (cl.note) return String(cl.note);
      if (kind === 'stored group') return 'a group entity in the store, with its membership facets';
      if (kind === 'meeting circle') {
        return `single-linkage on shared meetings, joined at Jaccard ≥ ${full(cuts.jaccard)} — `
             + 'a chain of joins is enough, so not every pair inside cleared it';
      }
      if (kind === 'chat cluster') {
        return `single-linkage on group chats sharing ≥ ${full(cuts.channel_share)} participant handles — `
             + 'a chain of joins is enough, so not every pair inside cleared it';
      }
      return 'clustered from measured overlap';
    }

    const compWrap = h('div', { class: 'viz-table-wrap' });
    sty(compWrap, { maxHeight: '360px', overflowY: 'auto' });
    const compTable = h('table', { class: 'viz-table' });
    const compHead = h('thead');
    const compBody = h('tbody');
    compTable.appendChild(compHead);
    compTable.appendChild(compBody);
    compWrap.appendChild(compTable);
    inspectorCard.appendChild(compWrap);

    const capNote = h('p', { class: 'card-note' });
    inspectorCard.appendChild(capNote);

    const detailBox = h('div');
    sty(detailBox, { marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border)' });
    inspectorCard.appendChild(detailBox);

    function drawComponents() {
      compHead.textContent = '';
      const tr = h('tr');
      for (const col of COMP_COLS) {
        tr.appendChild(h('th', {
          text: col.label + (ui.compKey === col.key ? (ui.compDir < 0 ? ' ↓' : ' ↑') : ''),
          title: 'sort by ' + col.label,
          onclick: () => {
            if (ui.compKey === col.key) ui.compDir = -ui.compDir;
            else { ui.compKey = col.key; ui.compDir = col.num ? -1 : 1; }
            drawComponents();
          },
        }));
      }
      compHead.appendChild(tr);

      const col = COMP_COLS.find(x => x.key === ui.compKey) || COMP_COLS[2];
      const inSort = (a, b) => {
        const va = col.get(a), vb = col.get(b);
        if (col.num) return (num(va) - num(vb)) * ui.compDir;
        return String(va).localeCompare(String(vb)) * ui.compDir;
      };
      /* the components sort as a block and the filing as a block: a residue row
       * sorted up among the components is how the two get read as one thing */
      const rows = comps.slice().sort(inSort).concat(filed.slice().sort(inSort));
      const shown = rows.slice(0, COMPONENT_CAP);

      compBody.textContent = '';
      let dividerDone = false;
      for (const cl of shown) {
        if (kindOf(cl) === 'bucket' && !dividerDone) {
          dividerDone = true;
          const sep = h('tr');
          const cell = h('td', {
            text: 'Below this line: catalogue buckets, not circles — the owner, the employers and '
                + 'their employees, chats overlapping no other chat, and the people no circle holds. '
                + 'They are not in the tally above.',
          });
          cell.setAttribute('colspan', String(COMP_COLS.length));
          sty(cell, { background: 'var(--wash)', color: 'var(--text-secondary)', fontSize: '11.5px' });
          sep.appendChild(cell);
          compBody.appendChild(sep);
        }
        const tr2 = h('tr');
        if (cl.key === ui.openKey) {
          sty(tr2, { background: 'var(--wash)' });
          tr2.setAttribute('aria-selected', 'true');
        }
        tr2.setAttribute('title', 'open this component');
        sty(tr2, { cursor: 'pointer' });
        tr2.addEventListener('click', () => openComponent(cl.key));

        const nameCell = h('td');
        nameCell.appendChild(swatch(clusterColour(cl.key)));
        nameCell.appendChild(h('button', {
          class: 'ghost', type: 'button', text: clusterName(cl.key),
          title: 'open this component',
          onclick: ev => { ev.stopPropagation(); openComponent(cl.key); },
        }));
        tr2.appendChild(nameCell);

        tr2.appendChild(h('td', { text: kindOf(cl) }));

        tr2.appendChild(h('td', { text: full(num(cl.members)) }));
        tr2.appendChild(h('td', { text: String(cl.layer || '—') }));
        tr2.appendChild(h('td', { text: ruleLine(cl) }));
        compBody.appendChild(tr2);
      }

      capNote.textContent = rows.length > shown.length
        ? `Showing ${full(shown.length)} of ${full(rows.length)} catalogue rows — the list is capped `
          + `at ${full(COMPONENT_CAP)} rows.`
        : `All ${full(rows.length)} catalogue rows with members are listed — ${full(comps.length)} `
          + `components and ${full(filed.length)} that are not; nothing is capped.`;
    }
    drawComponents();
    root.appendChild(grid(inspectorCard));

    /* ---------------- 5. the graph ---------------- */

    const visibleNodes = () => {
      let ns = d.nodes.filter(n => layerOn(layerOfNode(n)));
      if (ui.openKey && ui.mode === 'only') ns = ns.filter(n => isoSet.has(String(n.id)));
      return ns;
    };
    const visibleLinks = (withScorecard = false) => {
      let ls = d.links.filter(l => !NOT_DRAWN.has(l.kind) && (layerOn(LAYER_OF_KIND[l.kind] || 'core')
        || (withScorecard && LAYER_OF_KIND[l.kind] === 'scorecard')));
      if (ui.openKey && ui.mode === 'only') {
        ls = ls.filter(l => isoSet.has(String(l.source)) && isoSet.has(String(l.target)));
      }
      return ls;
    };

    const card = h('section', { class: 'card card-wide' });
    card.appendChild(h('header', { class: 'card-head' }, [
      h('h3', { text: 'The social graph' }),
    ]));
    card.appendChild(h('p', {
      class: 'card-note',
      text: 'Every solid edge is a row of the store, coloured by its predicate; hover one to read it. '
          + 'Node colour is iKnow’s analysis: the meeting circle its clustering put the node in, which '
          + 'the store does not hold. Node size counts the rows that name the node: its graph facts '
          + 'and references, and its interactions in the log. Drag to pin, double-click '
          + 'to unpin, click to inspect. Opening a circle in the inspector above isolates it here.',
    }));

    /* -- node-colour legend -- */
    /* One entry per colour, never one entry per row. Everything the endpoint gave no
     * colour slot is painted the same grey, and six identical swatches under six
     * different labels is a legend that explains nothing — they fold into one row
     * that says how many rows and how many nodes are hiding in it. */
    const nodeLegendRows = [];
    const greyNames = [];
    let greyNodes = 0;
    for (const cl of d.clusters) {
      if (!cl.members) continue;
      if (cl.layer === 'channels') continue;      // group chats are no longer drawn
      if (clusterColour(cl.key) === 'var(--text-muted)') {
        greyNames.push(clusterName(cl.key));
        greyNodes += num(cl.members);
        continue;
      }
      nodeLegendRows.push({ label: `${clusterName(cl.key)} · ${full(cl.members)}`, color: clusterColour(cl.key) });
    }
    if (greyNames.length) {
      nodeLegendRows.push({
        label: `no colour slot · ${full(greyNames.length)} rows, ${full(greyNodes)} nodes, all grey`,
        color: 'var(--text-muted)',
      });
    }
    card.appendChild(h('div', {
      class: 'card-note',
      text: 'Node colour — which meeting circle iKnow placed it in (iKnow’s analysis). Red marks the '
          + 'group the store holds as an entity of its own; it is the reserved alarm colour, and it is '
          + 'labelled wherever it appears. Grey means only “no colour slot left” — at most '
          + `${full(cuts.slots)} circles get one.`,
    }));
    card.appendChild(legend(nodeLegendRows, 'rect') || h('div'));

    /* -- the graph as the store keeps it, and the one thing added from outside it -- */
    const aug = augmentNote(d, origins);
    const refreshNote = () => aug.update(visibleLinks(true).filter(l => kindAllowed(l.kind)), {
      scorecard: ui.scorecard,
      records: visibleNodes().filter(n => n.kind === 'record').length,
      scoreOnly: scoreOnly.length,
      notInGraph: scoreOnly.filter(n => n.meta.graph_rows === 0).length,
    });
    card.appendChild(aug.el);
    card.appendChild(scorecardSwitch(ui.scorecard, on => {
      ui.scorecard = on;
      syncKindButtons();
      redrawGraph();
    }).el);

    /* -- edge-kind legend, doubling as the filter -- */
    card.appendChild(h('div', { class: 'card-note', text: 'Edge colour — which kind of link (click to filter)' }));
    const kindRow = h('div', { class: 'viz-legend' });
    const kindButtons = new Map();
    for (const k of presentKinds) {
      const km = kindMeta(k);
      const drawn = km.origin === 'derived';
      // A stored kind goes by the predicate of its rows; a drawn one has none to go by.
      const pred = predicates.get(k);
      const btn = h('button', {
        class: 'pill', type: 'button', 'aria-pressed': 'true',
        title: drawn ? `joined from ${km.store}; no predicate, because no row of the store stands behind it`
                     : `${KIND_LABEL[k] || k}; read from ${km.store}`,
        onclick: () => {
          if (ui.offKinds.has(k)) ui.offKinds.delete(k); else ui.offKinds.add(k);
          syncKindButtons();
          graph.setLinkFilter(activeKindSet());
          refreshNote();
        },
      });
      const key = h('span', { class: `viz-key viz-key-line${drawn ? ' viz-key-dash' : ''}` });
      if (drawn) key.style.setProperty('--key-colour', kindColour.get(k));
      else key.style.background = kindColour.get(k);
      btn.appendChild(key);
      btn.appendChild(h('span', {
        text: `${(!drawn && pred) || KIND_LABEL[k] || k} · ${full(km.count || 0)}`,
      }));
      kindButtons.set(k, btn);
      kindRow.appendChild(btn);
    }
    function syncKindButtons() {
      for (const [k, btn] of kindButtons) {
        // The scorecard's kind is held off by its switch, whatever its own pill says.
        const held = kindHeld(k);
        const on = !ui.offKinds.has(k) && !held;
        btn.disabled = held;
        btn.setAttribute('aria-pressed', String(on));
        btn.style.opacity = on ? '1' : '0.4';
      }
    }
    syncKindButtons();
    card.appendChild(kindRow);

    /* -- layer toggles -- */
    const layerRow = h('div', { class: 'viz-legend' });
    const layerButtons = new Map();
    for (const L of LAYERS) {
      const count = d.nodes.filter(n => layerOfNode(n) === L.key).length;
      const btn = h('button', {
        class: 'pill', type: 'button',
        text: `${L.label} · ${full(count)}`,
        onclick: () => {
          if (L.fixed) return;
          if (ui.layers.has(L.key)) ui.layers.delete(L.key); else ui.layers.add(L.key);
          syncLayerButtons();
          redrawGraph();
        },
      });
      if (L.fixed) btn.disabled = true;
      layerButtons.set(L.key, btn);
      layerRow.appendChild(btn);
    }
    function syncLayerButtons() {
      for (const [k, btn] of layerButtons) {
        const on = ui.layers.has(k);
        btn.setAttribute('aria-pressed', String(on));
        btn.style.opacity = on ? '1' : '0.4';
      }
    }
    syncLayerButtons();
    card.appendChild(h('div', { class: 'card-note', text: 'Layers' }));
    card.appendChild(layerRow);

    /* -- isolate controls: they scope the graph, so they sit above it -- */
    card.appendChild(h('div', { class: 'card-note', text: 'Isolation — what the picture is showing' }));
    const isoRow = h('div', { class: 'viz-legend' });
    const isoButtons = new Map();
    for (const M of ISOLATE_MODES) {
      const btn = h('button', {
        class: 'pill', type: 'button', title: M.hint,
        text: M.label,
        onclick: () => {
          ui.mode = M.key;
          refreshIso();
          syncIso();
          renderDetail();
          redrawGraph();
          if (graph) graph.focus(null);
        },
      });
      isoButtons.set(M.key, btn);
      isoRow.appendChild(btn);
    }
    card.appendChild(isoRow);
    const isoBanner = h('p', { class: 'card-note' });
    card.appendChild(isoBanner);

    function syncIso() {
      const open = Boolean(ui.openKey);
      for (const [k, btn] of isoButtons) {
        const active = open ? ui.mode === k : k === 'none';
        btn.setAttribute('aria-pressed', String(active));
        btn.style.opacity = active ? '1' : '0.45';
        btn.style.borderColor = active ? 'var(--border-strong)' : '';
        btn.disabled = !open && k !== 'none';
      }
      const total = d.nodes.filter(n => layerOn(layerOfNode(n))).length;
      const hit = d.nodes.filter(n => layerOn(layerOfNode(n)) && isoSet.has(String(n.id))).length;
      isoBanner.textContent = !open
        ? `SHOWING EVERYTHING the layers allow — ${full(total)} nodes. Open a component above to isolate it.`
        : ui.mode === 'only'
          ? `SHOWING ONLY “${clusterName(ui.openKey)}” — ${full(hit)} of ${full(total)} nodes, and only `
            + 'the links whose both ends are inside it. One click on “Show everything” puts the rest back.'
          : ui.mode === 'highlight'
            ? `HIGHLIGHTING “${clusterName(ui.openKey)}” in place — ${full(hit)} of ${full(total)} nodes keep `
              + 'their colour, the rest are greyed but still drawn. One click on “Show everything” clears it.'
            : `SHOWING EVERYTHING — ${full(total)} nodes. “${clusterName(ui.openKey)}” is still open below, `
              + 'it is just not isolated here any more.';
    }

    /* -- graph + detail panel -- */
    const split = h('div');
    sty(split, { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start', marginTop: '10px' });
    const holder = h('div');
    sty(holder, { flex: '1 1 560px', minWidth: '0' });
    const panel = h('aside');
    sty(panel, { flex: '0 1 310px', minWidth: '250px' });
    split.appendChild(holder);
    split.appendChild(panel);
    card.appendChild(split);
    card.appendChild(h('p', {
      class: 'card-note',
      text: `iKnow’s analysis, for the node colours: two people are JOINED when at least `
          + `${full(cuts.jaccard)} of the events either is invited to are events they are both invited to — but `
          + `a circle is one connected component of those joins, not a clique, so two people share a `
          + `circle when they clear that cut between them OR are joined to someone who is. Single `
          + `linkage needs only a chain, so a pair inside a circle can share less than the cut, or `
          + `nothing at all. Open a circle above and the pair table marks `
          + `exactly which rows fired and which were carried in. A scorecard line is drawn at `
          + `${full(cuts.closeness)} or more; two chats are called related at ${full(cuts.channel_share)} shared `
          + `participants. At most ${full(cuts.slots)} circles carry a colour — any beyond that are grey.`,
    }));
    root.appendChild(grid(card));

    refreshIso();

    graph = forceGraph(holder, {
      nodes: visibleNodes(),
      links: visibleLinks(),
      width: VIEW_W,
      height: VIEW_H,
      expand: split,
      colorFor,
      linkColorFor,
      linkStyleFor: dashDerived(origins),
      onLinkHover: (l, ev, also) => {
        if (!l) { hideTip(); return; }
        const t = edgeTip(l, { nameOf: id => (nodeById.get(id) || {}).label || '(unnamed)', origins,
                              cut: cuts.closeness, colourOf: x => kindColour.get(x.kind) || 'var(--grid)',
                              graphRowsOf: id => { const m = (nodeById.get(id) || {}).meta || {};
                                                   return m.scorecard_only ? m.graph_rows : undefined; } }, also);
        showTip(ev, t.title, t.rows);
      },
      faceFor: nodeFace,
      onSelect: node => showDetail(node),
    });
    graph.setLinkFilter(activeKindSet());
    refreshNote();

    function redrawGraph() {
      if (!graph) return;
      graph.update({ nodes: visibleNodes(), links: visibleLinks() });
      graph.setLinkFilter(activeKindSet());
      refreshNote();
    }

    function refreshIso() {
      const s = new Set();
      if (ui.openKey) {
        for (const n of d.nodes) if (String(n.group) === String(ui.openKey)) s.add(String(n.id));
        if (openComp && Array.isArray(openComp.members)) {
          for (const m of openComp.members) {
            if (m && m.id !== null && m.id !== undefined) s.add(String(m.id));
          }
        }
      }
      isoSet = s;
    }

    /* ---------------- 6. opening one component ---------------- */

    function closeComponent() {
      ui.openKey = null;
      openComp = null;
      refreshIso();
      syncIso();
      drawComponents();
      renderDetail();
      redrawGraph();
      if (graph) graph.focus(null);
    }

    async function openComponent(key) {
      const mine = ++compToken;
      ui.openKey = key;
      if (ui.mode === 'none') ui.mode = ISOLATE_MODES[0].key;
      openComp = null;
      refreshIso();
      /* turn on whatever layer the component lives in, or "only" shows nothing */
      let layersChanged = false;
      for (const n of d.nodes) {
        if (!isoSet.has(String(n.id))) continue;
        const L = layerOfNode(n);
        if (!ui.layers.has(L)) { ui.layers.add(L); layersChanged = true; }
      }
      syncIso();
      drawComponents();
      renderDetail({ loading: true });
      if (layersChanged) syncLayerButtons();
      redrawGraph();
      if (graph) graph.focus(null);

      let payload;
      try {
        payload = await api('social/component', {
          key,
          jaccard: num(cuts.jaccard),
          channel_share: num(cuts.channel_share),
        });
      } catch (err) {
        if (mine !== compToken) return;
        renderDetail({ error: String((err && err.message) || err) });
        return;
      }
      if (mine !== compToken || ui.openKey !== key) return;
      openComp = payload;
      refreshIso();
      syncIso();
      renderDetail();
      redrawGraph();
    }

    function renderDetail(status) {
      detailBox.textContent = '';
      if (!ui.openKey) {
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: 'No circle is open. Pick a row above — the largest meeting circle is a good first one.',
        }));
        return;
      }
      const cl = clusterOf(ui.openKey) || {};
      const reported = openComp || {};
      const layer = reported.layer || cl.layer;
      const kind = kindOf(Object.assign({ key: ui.openKey }, cl, {
        is_component: reported.is_component !== undefined ? reported.is_component : cl.is_component,
      }));
      const head = h('div');
      sty(head, { display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' });
      head.appendChild(swatch(clusterColour(ui.openKey)));
      head.appendChild(h('h3', { text: clusterName(ui.openKey) }));
      head.appendChild(h('span', { class: 'pill', text: kind }));
      head.appendChild(h('span', { class: 'pill', text: `${full(num(cl.members))} members` }));
      head.appendChild(h('span', { class: 'pill', text: `read from ${String(layer || '—')}` }));
      if (reported.name && String(reported.name) !== clusterName(ui.openKey)) {
        head.appendChild(h('span', {
          class: 'pill', title: 'the name the endpoint gives this component',
          text: `endpoint calls it: ${textOf(reported.name)}`,
        }));
      }
      head.appendChild(h('span', { class: 'pill mono', title: 'the catalogue key', text: String(ui.openKey) }));
      const spacer = h('span');
      sty(spacer, { flex: '1 1 auto' });
      head.appendChild(spacer);
      head.appendChild(h('button', {
        class: 'ghost', type: 'button', text: 'see it in the graph ↓',
        onclick: () => holder.scrollIntoView({ block: 'center' }),
      }));
      head.appendChild(h('button', { class: 'ghost', type: 'button', text: 'close', onclick: closeComponent }));
      detailBox.appendChild(head);

      detailBox.appendChild(h('p', {
        class: 'card-note',
        text: `In the graph below: ${ui.mode === 'only'
          ? 'only this component is drawn'
          : ui.mode === 'highlight'
            ? 'this component keeps its colour and everything else is greyed in place'
            : 'nothing is isolated — every node is drawn, this one included'}.`,
      }));

      if (status && status.loading) {
        detailBox.appendChild(h('div', { class: 'loading', text: 'reading the evidence behind this component…' }));
        return;
      }
      if (status && status.error) {
        detailBox.appendChild(h('div', { class: 'error' }, [
          h('strong', { text: 'The evidence for this component could not be read. ' }),
          h('span', { text: status.error }),
        ]));
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: 'The component is still isolated in the graph below — only the rule, the members '
              + 'and the evidence behind it are missing, so nothing here is being guessed at in '
              + 'their place.',
        }));
        return;
      }
      if (!openComp) {
        detailBox.appendChild(h('div', { class: 'loading', text: 'reading the evidence behind this component…' }));
        return;
      }
      if (openComp.available === false) {
        detailBox.appendChild(h('div', { class: 'empty' }, [h('span', {
          text: 'The endpoint holds no record of this component at the cut now applied.',
        })]));
        return;
      }
      renderComponent(openComp, cl);
    }

    function renderComponent(comp, cl) {
      /* `origin` is the endpoint's own word for whether the rows under this
       * component were measured at request time or read out of the store; it
       * decides only which fallback note is shown when a block comes back empty. */
      const origin = comp.origin || cl.origin;
      const derived = origin !== 'stored';
      const kind = kindOf(Object.assign({}, cl, {
        is_component: comp.is_component !== undefined ? comp.is_component : cl.is_component,
      }));

      /* -- the rule -- */
      detailBox.appendChild(subhead('The rule that put these together'));
      const ruleBox = h('div');
      sty(ruleBox, { border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                     padding: '10px 12px', margin: '4px 0 2px' });
      ruleBox.appendChild(h('p', {
        class: 'card-note',
        text: (comp.rule && comp.rule.text) ? String(comp.rule.text) : ruleLine(cl),
      }));
      const params = (comp.rule && comp.rule.params && typeof comp.rule.params === 'object')
        ? comp.rule.params : null;
      const pkeys = params ? Object.keys(params) : [];
      if (pkeys.length) {
        ruleBox.appendChild(h('div', { class: 'card-note', text: 'the parameters it ran with' }));
        for (const k of pkeys) ruleBox.appendChild(kvRow(k, cellOf(params[k])));
      }
      ruleBox.appendChild(h('p', {
        class: 'card-note',
        text: kind === 'stored group'
          ? 'No cut produced this group. The store holds it as an entity, and the statements below '
            + 'are what assert it.'
          : kind !== 'bucket'
            ? 'Set by the cuts above. Move one and this circle can grow, shrink or disappear — no '
              + 'record in the store moves.'
            : derived
              ? 'A catalogue bucket, not a circle: it is where the rule puts what it could not '
                + 'place, so moving a cut moves people in and out of it without a single record '
                + 'in the store changing.'
              : 'A catalogue bucket, not a circle: the statements under it are stored outright, '
                + 'and nothing in the store groups them this way.',
      }));
      detailBox.appendChild(ruleBox);

      /* -- members -- */
      const members = Array.isArray(comp.members) ? comp.members : [];
      detailBox.appendChild(subhead(`Members · ${full(members.length)}`));
      if (!members.length) {
        detailBox.appendChild(h('p', { class: 'card-note', text: 'The endpoint listed no members for this component.' }));
      } else {
        const chips = h('div', { class: 'viz-legend' });
        for (const m of members.slice(0, MEMBER_CAP)) {
          const id = String(m.id);
          const node = nodeById.get(id) || null;
          const bits = [textOf(m.label), textOf(m.kind), `${full(num(m.weight))} rows`];
          if (m.role) bits.push(textOf(m.role));
          if (Array.isArray(m.namespaces) && m.namespaces.length) {
            bits.push(m.namespaces.map(textOf).join(', '));
          }
          const btn = h('button', {
            class: 'pill', type: 'button',
            title: node ? 'centre this node in the graph and open its record'
                        : 'this member is not drawn in the current graph view',
            text: bits.join(' · '),
            onclick: () => {
              if (!node) return;
              if (!ui.layers.has(layerOfNode(node))) {
                ui.layers.add(layerOfNode(node));
                syncLayerButtons();
                redrawGraph();
              }
              graph.focus(node.id);
              showDetail(node);
              holder.scrollIntoView({ block: 'center' });
            },
          });
          if (!node) btn.style.opacity = '0.55';
          chips.appendChild(btn);
        }
        detailBox.appendChild(chips);
        if (members.length > MEMBER_CAP) {
          detailBox.appendChild(h('p', {
            class: 'card-note',
            text: `Showing ${full(MEMBER_CAP)} of ${full(members.length)} members — this page caps the list here.`,
          }));
        }
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: 'Each name opens the record the store holds on that node, in the panel beside the graph.',
        }));
      }

      /* -- cohesion -- */
      const coh = comp.cohesion;
      if (coh && typeof coh === 'object') {
        detailBox.appendChild(subhead('How solid it is'));
        const dens = num(coh.density);
        detailBox.appendChild(meter({
          value: Math.max(0, Math.min(1, dens)), max: 1,
          label: `${pct(num(coh.internal_edges), num(coh.possible_pairs))} of the pairs inside this `
               + 'component actually cleared the cut — single-linkage only needs a chain, not a clique',
        }));
        detailBox.appendChild(kvRow('pairs that cleared the cut', full(coh.internal_edges)));
        detailBox.appendChild(kvRow('pairs there could have been', full(coh.possible_pairs)));
        detailBox.appendChild(kvRow('density', score(coh.density)));
        detailBox.appendChild(kvRow('weakest overlap inside it', score(coh.min_jaccard)));
        detailBox.appendChild(kvRow('mean overlap inside it', score(coh.mean_jaccard)));
        if (coh.cut !== undefined && coh.cut !== null) {
          detailBox.appendChild(kvRow('the cut it was measured against', full(coh.cut)));
        }
        if (coh.note) {
          detailBox.appendChild(h('p', { class: 'card-note', text: String(coh.note) }));
        }
        const wp = coh.weakest_pair;
        if (wp) {
          const detail = (wp.shared !== undefined && wp.union !== undefined)
            ? ` — ${cellOf(wp.shared)} in common out of ${cellOf(wp.union)} either side has` : '';
          detailBox.appendChild(callout({
            tone: 'warning',
            title: 'The thread this component hangs by',
            body: `${textOf(wp.a_label)} and ${textOf(wp.b_label)} overlap at only `
                + `${score(wp.jaccard)}${detail} — the weakest join anywhere inside it. `
                + (wp.note ? `The endpoint’s own note on it: ${textOf(wp.note)}. ` : '')
                + 'Single-linkage keeps a group together as long as one chain of joins survives, so '
                + 'moving the cut past that number is enough to split this component in two. Nothing '
                + 'about the people in it changes when it does.',
          }));
        }
      } else if (derived) {
        detailBox.appendChild(subhead('How solid it is'));
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: 'The endpoint reported no cohesion measurement for this component, so none is shown. '
              + 'A density drawn from a single pair would be a decoration, not a measurement.',
        }));
      }

      /* -- evidence -- */
      const ev = comp.evidence && typeof comp.evidence === 'object' ? comp.evidence : {};
      const evKind = String(ev.kind || 'none');
      const limits = (ev.limits && typeof ev.limits === 'object') ? ev.limits : {};
      detailBox.appendChild(subhead('The evidence'));
      detailBox.appendChild(h('p', {
        class: 'card-note',
        text: EVIDENCE_LABEL[evKind] || `Evidence of kind “${evKind}”, as the endpoint reports it.`,
      }));
      if (ev.note) detailBox.appendChild(h('p', { class: 'card-note', text: String(ev.note) }));

      const summary = (ev.summary && typeof ev.summary === 'object') ? ev.summary : null;
      if (summary) {
        const skeys = Object.keys(summary);
        if (skeys.length) {
          detailBox.appendChild(h('div', { class: 'card-note', text: 'what was measured, in numbers' }));
          for (const k of skeys) detailBox.appendChild(kvRow(k.replace(/_/g, ' '), cellOf(summary[k])));
        }
      }

      const shared = Array.isArray(ev.shared) ? ev.shared : [];
      const sharedTotal = ev.shared_total === undefined ? shared.length : num(ev.shared_total);
      if (shared.length) {
        detailBox.appendChild(h('div', {
          class: 'card-note',
          text: `What every member of this component has in common · ${full(sharedTotal)}`
              + (ev.shared_kind ? ` · ${textOf(ev.shared_kind)}` : ''),
        }));
        const chips = h('div', { class: 'viz-legend' });
        for (const sh of shared.slice(0, SHARED_CAP)) {
          chips.appendChild(h('span', { class: 'pill', text: evidenceText(sh) }));
        }
        detailBox.appendChild(chips);
        const shownShared = Math.min(shared.length, SHARED_CAP);
        if (shownShared < sharedTotal) {
          detailBox.appendChild(h('p', {
            class: 'card-note',
            text: `Showing ${full(shownShared)} of ${full(sharedTotal)}`
                + (limits.shared !== undefined && shared.length < sharedTotal
                    ? ` — the endpoint sends at most ${full(limits.shared)} of them`
                    : ' — capped here')
                + '. A capped list is not a complete one.',
          }));
        }
      }

      const pairs = Array.isArray(ev.pairs) ? ev.pairs : [];
      const pairsTotal = ev.pairs_total === undefined ? pairs.length : num(ev.pairs_total);
      if (pairs.length) {
        const ordered = pairs.slice().sort((a, b) => num(a.jaccard) - num(b.jaccard));
        const shownPairs = ordered.slice(0, PAIR_CAP);
        const knowsFired = pairs.some(x => x.fired !== undefined);
        const firedN = ev.pairs_fired !== undefined ? num(ev.pairs_fired)
          : (knowsFired ? pairs.filter(x => x.fired).length : null);
        const sentFired = knowsFired ? pairs.filter(x => x.fired).length : null;
        const partial = pairs.length < pairsTotal;
        // Three cases, not two. Chaining is only part of the story when some
        // pairs fired and some did not; a component where EVERY pair cleared the
        // cut has no "rest" to have been carried in, and saying otherwise
        // invents a weakness this particular circle does not have.
        const allFired = firedN !== null && pairsTotal > 0 && firedN >= pairsTotal;
        const carried = firedN !== null && firedN > 0 && !allFired;
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: `${full(pairs.length)} of the ${full(pairsTotal)} pairs the rule measured here are on `
              + 'the table, weakest measured overlap of those first. '
              + (partial
                  ? 'The endpoint chose which ones to send, so the weakest row on screen need not be '
                    + 'the weakest pair in the set — the cohesion block above reports that number '
                    + 'over all of them. '
                  : 'That is every pair the rule had to work with. ')
              + 'Every number here was counted at request time; none of it is a score the store holds. '
              + (firedN === null ? ''
                  : allFired
                    ? `Every one of the ${full(pairsTotal)} cleared the cut, so nothing here leans on `
                      + 'a chain: each member meets each other member directly above the threshold. '
                      + 'That is the strongest shape a circle on this page can have, and it is not '
                      + 'the usual one.'
                  : carried
                    ? `${full(firedN)} of the ${full(pairsTotal)} cleared the cut`
                      + (partial && sentFired !== null ? ` (${full(sentFired)} of them on this table)` : '')
                      + '; the rest are in this component only because single linkage carried them in '
                      + 'on a chain of pairs that did.'
                    : 'Not one of them cleared the cut — which is exactly why the rule left each of '
                      + 'these standing alone instead of joining them into anything. Nothing was '
                      + 'carried in here, because nothing fired: these are the near misses, and '
                      + 'lowering the cut above is what would pull them in.'),
        }));
        const cols = ['one', 'the other', 'in common', 'either side', 'overlap'];
        if (knowsFired) cols.push('cleared the cut?');
        cols.push('examples');
        const scroll = h('div');
        sty(scroll, { maxHeight: '340px', overflowY: 'auto' });
        scroll.appendChild(plainTable(cols, shownPairs.map(pr => {
          const r = [
            textOf(pr.a_label !== undefined ? pr.a_label : pr.a),
            textOf(pr.b_label !== undefined ? pr.b_label : pr.b),
            cellOf(pr.shared), cellOf(pr.union), score(pr.jaccard),
          ];
          if (knowsFired) {
            r.push(pr.fired ? 'yes — it fired'
              : carried ? 'no — carried in by the chain'
                        : 'no — and nothing here fired, so nothing carried it in');
          }
          r.push(cellOf(pr.examples));
          return r;
        })));
        detailBox.appendChild(scroll);
        const capBits = [];
        if (shownPairs.length < pairs.length) {
          capBits.push(`this page shows the ${full(shownPairs.length)} weakest of the `
                     + `${full(pairs.length)} rows it was sent`);
        }
        if (pairs.length < pairsTotal) {
          capBits.push(`the endpoint sent ${full(pairs.length)} of ${full(pairsTotal)} pairs`
                     + (limits.pairs !== undefined ? `, capping at ${full(limits.pairs)}` : ''));
        }
        if (limits.examples !== undefined) {
          capBits.push(`each row carries at most ${full(limits.examples)} concrete examples`);
        }
        if (capBits.length) {
          detailBox.appendChild(h('p', {
            class: 'card-note', text: `Capped: ${capBits.join('; ')}.`,
          }));
        }
      } else if (derived) {
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: 'The endpoint reported no pairwise overlap for this component. Where the rule could '
              + 'not place a node, there is no pair to show — the absence is the finding.',
        }));
      }

      /* -- the statements, for a stored component -- */
      const triples = Array.isArray(comp.triples) ? comp.triples : [];
      if (triples.length) {
        detailBox.appendChild(subhead(kind === 'bucket'
          ? `The statements underneath it · ${full(triples.length)}`
          : `The statements that assert it · ${full(triples.length)}`));
        const confs = triples.map(t => Number(t.confidence)).filter(Number.isFinite);
        const lo = confs.length ? Math.min(...confs) : null;
        const hi = confs.length ? Math.max(...confs) : null;
        const srcs = [];
        for (const t of triples) {
          for (const src of (Array.isArray(t.sources) ? t.sources : [])) {
            const txt = textOf(src);
            if (txt !== '—' && !srcs.includes(txt)) srcs.push(txt);
          }
        }
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: (kind === 'bucket'
                  ? `${full(triples.length)} statements in the store sit under this row. `
                  : `${full(triples.length)} statements in the store assert this group. `)
              + (confs.length
                  ? (near(lo, hi)
                      ? `Every one of them carries confidence ${score(lo)}. `
                      : `Their confidence runs from ${score(lo)} to ${score(hi)}. `)
                  : '')
              + (srcs.length
                  ? `The ingest sources decoded on them: ${srcs.join(', ')}.`
                  : 'No ingest source is decoded on them.'),
        }));
        const tscroll = h('div');
        sty(tscroll, { maxHeight: '340px', overflowY: 'auto' });
        tscroll.appendChild(plainTable(
          ['subject', 'predicate', 'object', 'confidence', 'ingest sources', 'asserted'],
          triples.slice(0, TRIPLE_CAP).map(t => [
            textOf(t.subject_label), textOf(t.predicate), cellOf(t.object),
            score(t.confidence), cellOf(t.sources),
            t.asserted ? day(t.asserted) : '—',
          ])));
        detailBox.appendChild(tscroll);
        if (triples.length > TRIPLE_CAP) {
          detailBox.appendChild(h('p', {
            class: 'card-note',
            text: `Showing ${full(TRIPLE_CAP)} of ${full(triples.length)} statements — capped here.`,
          }));
        }
      } else if (!derived) {
        detailBox.appendChild(subhead('The statements that assert it'));
        detailBox.appendChild(h('p', {
          class: 'card-note',
          text: `The statements under this row are reported as stored, but the endpoint returned `
              + 'none of them. Without them there is nothing to show a reader, so nothing is shown.',
        }));
      }
    }

    syncIso();
    renderDetail();
    if (ui.openKey) openComponent(ui.openKey);

    /* ---------------- 7. the node detail panel ---------------- */

    function panelShell(title, kids) {
      panel.textContent = '';
      panel.appendChild(h('div', { class: 'card-note', text: title }));
      for (const k of kids) if (k) panel.appendChild(k);
    }

    const row = kvRow;

    let selectedNode = null;

    function showDetail(node) {
      selectedNode = node;
      if (!node) {
        panelShell('How to read this', [
          h('p', { class: 'card-note',
            text: 'Click a node — or a name in the list below — to see what the store actually '
                + 'holds about it. Nothing is summarised here that is not in the record.' }),
          keyList([
            ['node size', 'rows in the store naming it'],
            ['node colour', 'the circle it landed in'],
            ['red node', 'the group the store holds as an entity'],
            ['grey node', 'outside the component you isolated'],
            ['edge colour', 'the predicate of the row it is — see the pills above'],
            ['dashed edge', 'from outside the graph: a kinship scorecard score at or above the cut'],
            ['faded node', 'no link survives the current filter'],
          ]),
          h('p', { class: 'card-note',
            text: 'Keyboard: Tab walks the nodes in size order, Enter selects, Escape clears, '
                + 'arrows pan, + and − zoom, 0\u00a0re-fits, f\u00a0fills the window.' }),
        ]);
        return;
      }
      const m = node.meta || {};
      const kids = [];
      kids.push(h('h3', { text: node.label || '' }));
      const tags = h('div', { class: 'viz-legend' });
      tags.appendChild(h('span', {
        class: 'pill' + (node.kind === 'explicit_group' ? ' pill-critical' : ''),
        text: node.kind === 'explicit_group' ? 'stored group · an entity in the graph'
            : node.kind === 'owner' ? 'you · the nm_isCurrentUser anchor'
            : node.kind === 'org' ? 'organisation'
            : node.kind === 'channel' ? 'group chat'
            : node.kind === 'record' ? (m.class || 'record')
            : m.scorecard_only ? (m.graph_rows === 0 ? 'person · in the scorecard only, no row in the graph'
                                                     : 'person · here only for a scorecard score')
            : 'person',
      }));
      if (layerOfNode(node) !== 'records') {   // the switch's nodes are in no component
        tags.appendChild(h('button', {
          class: 'pill', type: 'button', text: clusterName(node.group),
          title: 'open the meeting circle iKnow placed this node in (iKnow’s analysis)',
          onclick: () => { openComponent(node.group); if (inspectorCard) inspectorCard.scrollIntoView({ block: 'start' }); },
        }));
      }
      if (m.retracted) tags.appendChild(h('span', { class: 'pill pill-critical', text: 'entity retracted' }));
      kids.push(tags);

      if (node.kind === 'channel') {
        kids.push(row('message rows', full(m.message_rows)));
        kids.push(row('incoming / outgoing', `${full(m.incoming)} / ${full(m.outgoing)}`));
        kids.push(row('distinct handles seen', full(m.handles)));
        kids.push(row('apps', full(m.apps)));
        kids.push(row('first / last', `${day(m.first_contact)} → ${day(m.last_contact)}`));
      } else if (node.kind === 'explicit_group') {
        kids.push(row('class', m.class || '—'));
        kids.push(row('members', full(m.members)));
        kids.push(row('confidence', score(m.confidence)));
        kids.push(row('asserted', day(m.asserted)));
        kids.push(row('ingest sources', (m.sources || []).join(', ') || '—'));
        kids.push(row('named in the store', m.named ? 'yes' : 'no'));
        kids.push(row('shared circle tokens', full(m.circle_tokens)));
      } else if (node.kind === 'org') {
        kids.push(row('class', m.class || '—'));
        kids.push(row('people attached here', full(m.employees_here)));
      } else if (node.kind === 'record') {
        kids.push(row('class', m.class || '—'));
        kids.push(row('stored rows to people', full(m.rows)));
      } else {
        kids.push(row('how it is named', m.label_source || '—'));
        kids.push(row('events invited to · has attendee', full(m.attended)));
        kids.push(row('events organised · has organizer', full(m.organized)));
        kids.push(row('events sent · calendar event sender', full(m.invited)));
        kids.push(row('phones / emails', `${full(m.phones)} / ${full(m.emails)}`));
        kids.push(row('graph facts', full(m.facts)));
        kids.push(row('interactions in the log', full(m.interactions)));
        if (m.interactions) {
          kids.push(row('incoming / outgoing', `${full(m.incoming)} / ${full(m.outgoing)}`));
          kids.push(row('first / last contact', `${day(m.first_contact)} → ${day(m.last_contact)}`));
        }
        kids.push(row('family-and-friends · scorecard', score(m.closeness)));
        if (m.claims && m.claims.length) {
          kids.push(h('div', { class: 'card-note', text: 'what the scorecard claims' }));
          for (const cl2 of m.claims) kids.push(row(cl2.label, score(cl2.score)));
        }
        if (m.namespaces && m.namespaces.length) {
          kids.push(row('resolves into', m.namespaces.join(', ')));
        }
        if (m.retracted) {
          kids.push(h('p', { class: 'card-note',
            text: `The live entity is gone — ${full(m.expired_rows)} rows survive in the retraction `
                + `archive, retracted ${day(m.retracted_at)}, and the closeness score was kept.` }));
        }
      }
      kids.push(h('div', { class: 'card-note', text: 'loading the rest of the record…' }));
      panelShell('Selected node', kids);
      loadDetail(node);
    }

    async function loadDetail(node) {
      let detail = detailCache.get(node.id);
      if (!detail) {
        try {
          detail = await api('social/node', { id: node.id });
        } catch (err) {
          detail = { error: String(err.message || err) };
        }
        detailCache.set(node.id, detail);
      }
      if (selectedNode !== node) return;
      const tail = panel.lastChild;
      if (tail) tail.remove();
      if (detail.error) {
        panel.appendChild(h('p', { class: 'card-note', text: detail.error }));
        return;
      }
      if (detail.channel) {
        panel.appendChild(h('div', { class: 'card-note', text: 'apps carrying this chat' }));
        for (const a of detail.apps || []) {
          panel.appendChild(row(a.app || a.domain || '—', `${full(a.n)} · ${day(a.first_ts)}→${day(a.last_ts)}`));
        }
        return;
      }
      if ((detail.handles || []).length) {
        panel.appendChild(h('div', { class: 'card-note', text: 'reachable at' }));
        for (const hd of detail.handles) {
          panel.appendChild(row(hd.label || hd.kind, hd.value));
        }
      }
      if ((detail.events || []).length) {
        panel.appendChild(h('div', { class: 'card-note',
          text: `calendar record · ${full(detail.events.length)} rows` }));
        for (const e of detail.events.slice(0, 8)) {
          panel.appendChild(row(`${e.day || '—'} · ${e.role}`, e.title || '(untitled)'));
        }
        if (detail.events.length > 8) {
          panel.appendChild(h('p', { class: 'card-note',
            text: `showing the 8 most recent of ${full(detail.events.length)}` }));
        }
      }
      if ((detail.facts || []).length) {
        panel.appendChild(h('div', { class: 'card-note',
          text: `graph statements · ${full(detail.facts.length)}` }));
        for (const f of detail.facts.slice(0, 10)) {
          panel.appendChild(row(f.predicate, f.kind === 'entity' ? 'an entity reference'
            : String(f.value ?? '').slice(0, 60)));
        }
        if (detail.facts.length > 10) {
          panel.appendChild(h('p', { class: 'card-note',
            text: `showing 10 of ${full(detail.facts.length)} statements` }));
        }
      }
    }

    showDetail(null);

    /* ---------------- 8. the circles, as a list ---------------- */

    {
      const bySize = (a, b) => num(b.members) - num(a.members);
      const drawn = comps.slice().sort(bySize).concat(filed.slice().sort(bySize));
      root.appendChild(grid(ours(figure({
        title: 'The circles, and the people no circle holds',
        note: `Single-linkage on meeting overlap at ${full(cuts.jaccard)}, and on group chats sharing `
            + `${full(cuts.channel_share)} participant handles. The first ${full(comps.length)} bars are `
            + `the circles; the ${full(filed.length)} below them are catalogue buckets — the owner, the `
            + `employers and their employees, chats overlapping no other chat, and the people no circle `
            + `holds. A circle of one is not a circle, so those people are reported as unplaced rather `
            + `than dressed up as a group. One series, one colour: the row label is the identity here, `
            + `not the bar. Click any bar to open that row in the inspector above.`,
        chart: bars(drawn.map(x => ({
          label: clusterName(x.key),
          value: x.members,
          meta: 'nodes',
          onclick: () => {
            openComponent(x.key);
            if (inspectorCard) inspectorCard.scrollIntoView({ block: 'start' });
          },
        })), { labelW: 240 }),
        table: tableView(['row', 'nodes', 'kind', 'layer', 'meetings all members share'],
          drawn.map(x => [
            clusterName(x.key), full(x.members), kindOf(x), x.layer,
            x.shared_events === null || x.shared_events === undefined ? '—' : full(x.shared_events),
          ])),
      }))));
    }

    /* ---------------- 9. what the edge weight really means ---------------- */

    const co = d.co_attendance_weights || [];
    const coPairs = co.reduce((s, r) => s + r.pairs, 0);
    root.appendChild(grid(
      ours(figure({
        title: 'Meeting overlap is density, not intimacy',
        note: `iKnow pairs every two people invited to the same event — ${full(coPairs)} pairs over `
            + `${full(c.attendee_events)} calendar events with attendees. The pairs feed the meeting `
            + 'circles and are not drawn in the graph, because no row of the store links two invitees. '
            + 'A recurring meeting is one event in the store, so it counts once however often it '
            + 'repeats; many events in common means many shared invitations, not a friendship.',
        chart: columns(co.map(r => ({ label: String(r.weight), value: r.pairs })),
          { labelEvery: 2 }),
        table: tableView(['meetings in common', 'pairs'],
          co.map(r => [full(r.weight), full(r.pairs)])),
      })),
      figure({
        title: 'The family-and-friends score on the kinship scorecard',
        note: `${full(c.scored_people)} people carry a family-and-friends score in the kinship `
            + 'scorecard, a separate table of the store, outside the graph. The bands are iKnow’s. '
            + `Nearly all of the people sit in one flat band, and only ${full(c.above_closeness_cut)} `
            + `reach iKnow’s cut of ${full(cuts.closeness)} — which is what makes the top of the `
            + 'list a shortlist rather than a ranking.',
        chart: (() => {
          const rows = (d.closeness_bands || []).map(b => ({ label: b.band, value: b.people }));
          let top = 0;
          rows.forEach((r, i) => { if (r.value > rows[top].value) top = i; });
          return bars(rows, { emphasis: top, labelW: 110 });
        })(),
        table: tableView(['band', 'people'],
          (d.closeness_bands || []).map(b => [b.band, full(b.people)])),
      }),
    ));

    /* ---------------- 10. the layers barely touch ---------------- */

    root.appendChild(grid(
      ours(figure({
        title: 'How far the calendar and the message log reach the same people',
        note: 'Two populations: the people reached through calendar events in the graph, and the '
            + 'people the interaction log, a separate store, resolves to through its '
            + 'handle index. “In both” is iKnow’s join of the two by graph id; the store keeps no '
            + 'such count.',
        chart: bars([
          { label: 'people reached via the calendar', value: c.calendar_people },
          { label: 'people with resolved log volume', value: c.volume_resolved },
          { label: 'in both', value: c.volume_on_calendar_people },
          { label: 'group chats naming a resolvable person', value: c.channels_with_resolved_person },
          { label: 'group chats in total', value: c.channels },
        ], { emphasis: 2, labelW: 230 }),
        table: tableView(['population', 'people'], [
          ['reached via the calendar', full(c.calendar_people)],
          ['resolved log volume', full(c.volume_resolved)],
          ['in both', full(c.volume_on_calendar_people)],
          ['distinct chat handles seen', full(c.channel_handles)],
          ['chats with a resolvable person', full(c.channels_with_resolved_person)],
          ['chats in total', full(c.channels)],
        ]),
      })),
      (() => {
        const chans = d.nodes.filter(n => n.kind === 'channel')
          .sort((a, b) => b.weight - a.weight);
        const cap = Math.min(20, chans.length);
        return figure({
          title: 'The group chats the store keeps by name',
          note: `${full(chans.length)} channels in the interaction log, a separate store outside the `
              + `graph; they are not drawn in it. Showing the busiest ${full(cap)} of `
              + `${full(chans.length)}; the table holds them all.`,
          chart: bars(chans.slice(0, cap).map(n => ({
            label: n.label || '(unnamed)', value: n.weight,
          })), { labelW: 210 }),
          table: tableView(['channel', 'message rows', 'in', 'out', 'handles', 'last'],
            chans.map(n => [n.label || '(unnamed)', full(n.meta.message_rows), full(n.meta.incoming),
                            full(n.meta.outgoing), full(n.meta.handles), day(n.meta.last_contact)])),
        });
      })(),
    ));

    /* ---------------- 11. the fallback list ---------------- */

    const roster = h('section', { class: 'card card-wide' });
    roster.appendChild(h('header', { class: 'card-head' }, [
      h('h3', { text: 'Every node as a list — the graph is not the only way in' }),
    ]));
    roster.appendChild(h('p', {
      class: 'card-note',
      text: `All ${full(d.nodes.length)} nodes, sortable, with the meeting circle iKnow placed each in. `
          + 'Selecting a row centres that node in the graph above and fills the detail panel. '
          + 'Nothing here is hidden behind the picture.',
    }));

    const COLS = [
      { key: 'label', label: 'name', get: n => n.label || '', num: false },
      { key: 'kind', label: 'kind', get: n => n.kind, num: false },
      { key: 'group', label: 'circle (iKnow)', get: n => clusterName(n.group), num: false },
      { key: 'weight', label: 'rows naming it', get: n => num(n.weight), num: true },
      { key: 'attended', label: 'events invited to', get: n => num(n.meta.attended), num: true },
      { key: 'interactions', label: 'log msgs', get: n => num(n.meta.interactions ?? n.meta.message_rows), num: true },
      { key: 'closeness', label: 'family-and-friends', get: n => n.meta.closeness ?? null, num: true },
    ];

    const wrap = h('div', { class: 'viz-table-wrap' });
    const table = h('table', { class: 'viz-table' });
    const thead = h('thead');
    const tbody = h('tbody');

    function drawRoster() {
      thead.textContent = '';
      const tr = h('tr');
      for (const col of COLS) {
        tr.appendChild(h('th', {
          text: col.label + (ui.sortKey === col.key ? (ui.sortDir < 0 ? ' ↓' : ' ↑') : ''),
          onclick: () => {
            if (ui.sortKey === col.key) ui.sortDir = -ui.sortDir;
            else { ui.sortKey = col.key; ui.sortDir = col.num ? -1 : 1; }
            drawRoster();
          },
        }));
      }
      thead.appendChild(tr);

      const col = COLS.find(x => x.key === ui.sortKey) || COLS[0];
      const rows = d.nodes.slice().sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        if (col.num) return (num(va) - num(vb)) * ui.sortDir;
        return String(va).localeCompare(String(vb)) * ui.sortDir;
      });

      tbody.textContent = '';
      for (const n of rows) {
        const tr2 = h('tr');
        const reveal = () => {
          if (!ui.layers.has(layerOfNode(n))) {
            ui.layers.add(layerOfNode(n));
            syncLayerButtons();
            redrawGraph();
          }
          graph.focus(n.id);
          showDetail(n);
          holder.scrollIntoView({ block: 'center' });
        };
        for (const cdef of COLS) {
          const v = cdef.get(n);
          const text = cdef.key === 'closeness' ? score(v)
                     : cdef.num ? full(num(v)) : String(v);
          if (cdef.key === 'label') {
            // the row's handle is a real button: reachable by keyboard, and it
            // carries the pointer affordance from the shared .ghost style
            tr2.appendChild(h('td', {}, [
              h('button', { class: 'ghost', type: 'button', text, onclick: reveal,
                            title: 'centre this node in the graph above' }),
            ]));
          } else {
            tr2.appendChild(h('td', { text }));
          }
        }
        tbody.appendChild(tr2);
      }
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    roster.appendChild(wrap);
    drawRoster();
    root.appendChild(grid(roster));

    /* ---------------- 12. the stakes ---------------- */

    if (c.retracted_close_people) {
      root.appendChild(callout({
        title: 'Scores for people the live graph no longer holds',
        body: `${full(c.retracted_close_people)} of the people this page draws above the closeness `
            + `cut have no live entity left in the graph at all — the graph keeps their facts only in its `
            + `retraction archive, while the scorecard still carries their closeness score. `
            + 'The score outlived the record.',
      }));
    }

    root.appendChild(h('p', {
      class: 'card-note',
      text: `Read from ${full(c.attendee_events)} calendar events with attendees, `
          + `${full(c.scored_people)} scored people and ${full(c.channels)} named channels, at a `
          + `Jaccard cut of ${full(cuts.jaccard)} and ${full(cuts.channel_share)} shared chat `
          + 'participants. Everything on this page is computed at page load; nothing is stored by it.',
    }));
  }

  /* ---------- one slider, labelled and read out ---------- */

  function cutControl({ label, hint, min, max, step, value, fmt, onchange }) {
    const id = nextId('cut');
    const box = h('div');
    sty(box, { display: 'flex', flexDirection: 'column', gap: '5px', flex: '1 1 280px', minWidth: '240px' });
    box.appendChild(h('label', { class: 'card-note', for: id, text: label }));
    const row = h('div');
    sty(row, { display: 'flex', alignItems: 'center', gap: '10px' });
    const input = h('input', { type: 'range', id, min, max, step, value: String(value) });
    sty(input, { flex: '1 1 auto', minWidth: '0' });
    const out = h('span', { class: 'mono', text: fmt(num(value)) });
    sty(out, { minWidth: '44px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
               color: 'var(--text-primary)' });
    input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); });
    input.addEventListener('change', () => onchange(Number(input.value)));
    row.appendChild(input);
    row.appendChild(out);
    box.appendChild(row);
    box.appendChild(h('div', { class: 'card-note', text: hint }));
    cutInputs.push(input);
    return { box, input, out };
  }
}
