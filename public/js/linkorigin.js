/* linkorigin.js — what the social graph draws, and where each line comes from.
 *
 * The landing page and the social page draw the graph as the store keeps it:
 * every solid line is one row of graph.db, with its predicate — group
 * membership, employment, the attendee, organiser and sender rows of events,
 * and the rows tying a person to a place or an app — and the events and other
 * records those rows point at are nodes of their own. One thing is added from
 * outside the graph, on by default and marked as such: the kinship scorecard, a
 * separate table Apple keeps in the same store, drawn as a dashed line from the
 * owner to everyone scored at or above the cut, and switchable off.
 *
 * /api/social still sends the person-to-person lines iKnow used to join out of
 * shared invitations and group chats (`NOT_DRAWN`); neither page draws them.
 * Whether a kind is a row or not comes from the endpoint itself, in
 * `link_kinds[].origin`. Both pages read it through here, so the two pictures
 * draw the same lines and print the same note under them.
 *
 *   const origins = originsOf(social);
 *   forceGraph(el, { ..., linkStyleFor: dashDerived(origins) });
 *   const aug = augmentNote(social, origins);
 *   box.appendChild(aug.el);
 *   aug.update(linksBeforeTheSwitch, { scorecard, records, scoreOnly, notInGraph });
 *   box.appendChild(scorecardSwitch(true, on => { ... }).el);
 */

import { h, full } from './viz.js';

/** Edge kinds the endpoint sends that neither graph draws: person-to-person
 *  lines joined out of shared invitations and chats, which no row stands behind. */
export const NOT_DRAWN = new Set(['co_attendance', 'organizer_to_attendee', 'channel_member', 'shared_handles']);

/** The one kind drawn from outside the graph, and the colour that marks it on both pages. */
export const SCORECARD_KIND = 'inferred_closeness';
export const SCORECARD_COLOUR = 'var(--series-1)';

/** The edge kinds that tie a person to a record (an event, a place, an app). */
export const RECORD_KINDS = ['event_attendee', 'event_organizer', 'event_sender', 'record_link'];

/* Colours for the records and their rows, shared so both pages agree. Chosen
 * clear of what either page spends elsewhere: the group's red, employment, the
 * scorecard's blue, and on the social page the slots the stored kinds keep. */
export const RECORD_NODE_COLOUR = 'var(--text-secondary)';
export const RECORD_LINK_COLOUR = {
  event_attendee: 'var(--text-muted)',
  event_organizer: 'var(--text-secondary)',
  event_sender: 'var(--series-5)',
  record_link: 'var(--series-6)',
  stored_person_link: 'var(--series-8)',
};
/** The same, in words, for a key that names line colours. */
export const RECORD_LINK_WORD = {
  event_attendee: ['grey line', 'listed as an event’s attendee'],
  event_organizer: ['light grey line', 'listed as an event’s organiser'],
  event_sender: ['pink line', 'the person an event found in an app came from'],
  record_link: ['green line', 'another stored row tying a person to a record'],
  stored_person_link: ['salmon line', 'a stored statement with a person at both ends'],
};

/** The dash the scorecard's lines carry, on the graph and in its swatches. */
export const DASH = '4 3';

/** A withdrawn row (/api/retractions/graph): one or more rows of graph.db's
 *  expired layers that linked two entities. Still rows of the store, so not
 *  dashed like the scorecard: dotted, in a colour of their own. */
export const WITHDRAWN_KIND = 'withdrawn';
// Violet: the one series colour no other mark spends, clear of the group's red,
// family's orange and the scorecard's blue in both themes.
export const WITHDRAWN_COLOUR = 'var(--series-7)';
export const WITHDRAWN_DOT = '1.5 3';
export const WITHDRAWN_STYLE = { dash: WITHDRAWN_DOT, width: 1.6, minOpacity: 0.6 };
/* The one addition from outside the graph is meant to be seen: heavier than a
 * row's 1px, and never faded below this, whatever its score. */
const DASH_WIDTH = 2;
const DASH_MIN_OPACITY = 0.75;

/** kind -> 'stored' | 'derived', as the endpoint labels it. */
export function originsOf(social) {
  return new Map(((social && social.link_kinds) || []).map(k => [k.kind, k.origin]));
}

/** kind -> the store's own name for it: the predicates of the rows behind a
 *  stored kind, "has attendee (PS232)", several joined by commas. A kind with no
 *  row behind it has no entry. */
export function predicatesOf(social) {
  return new Map(((social && social.link_kinds) || [])
    .filter(k => Array.isArray(k.predicates) && k.predicates.length)
    .map(k => [k.kind, k.predicates.map(p => `${p.label} (${p.code})`).join(', ')]));
}

/** A `linkStyleFor` for forceGraph: lines no row stands behind dashed and heavier. */
export const dashDerived = origins => l => (origins.get(l.kind) === 'derived'
  ? { dash: DASH, width: DASH_WIDTH, minOpacity: DASH_MIN_OPACITY } : null);

/* What each stored kind is, in the note's words. Fixed order: the order they are listed. */
const STORED = [
  ['family_circle_member', 'membership of the stored group'],
  ['employed_by', 'employment statements'],
  ['stored_person_link', 'statements with a person at both ends'],
];
const EVENT_ROLES = [
  ['event_attendee', 'attendee'],
  ['event_organizer', 'organiser'],
  ['event_sender', 'sender'],
];

/* "a and b", "a, b and c": for plain words. */
const andList = parts => (parts.length < 2 ? parts.join('')
  : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]);
/* "a, b, and c": the parts carry their own "and", so the last one is set off. */
const series = parts => (parts.length < 2 ? parts.join('')
  : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]);

function storedWordsOf(present) {
  const words = STORED.filter(([k]) => present.has(k)).map(([, w]) => w);
  const roles = EVENT_ROLES.filter(([k]) => present.has(k)).map(([, w]) => w);
  if (roles.length) words.push(`the ${andList(roles)} rows of events`);
  if (present.has('record_link')) words.push('the rows tying a person to other records');
  return words.length > 2 ? series(words) : words.join(' and ');
}

const plural = (n, one, many) => `${full(n)} ${n === 1 ? one : many}`;

/** The note that goes under the graph. `update(links, counts)` takes the links
 *  the layers allow with the scorecard's lines still among them, so it can say
 *  how many the switch hides; `counts` is { scorecard (on or off), records (event
 *  and other record nodes drawn), scoreOnly (people on the graph only for their
 *  score), notInGraph (of those, the ones with no row in the graph at all) }. */
export function augmentNote(social, origins) {
  const el = h('p', { class: 'card-note' });
  const cut = social && social.cuts ? social.cuts.closeness : null;

  function update(links, { scorecard = true, records = 0, scoreOnly = 0, notInGraph = 0 } = {}) {
    const all = links || [];
    const rows = all.filter(l => origins.get(l.kind) === 'stored');
    const scored = all.filter(l => l.kind === SCORECARD_KIND).length;
    el.textContent = '';

    const solid = rows.length
      ? `Every solid line is one row of the graph, with its predicate: ${full(rows.length)} here, `
        + `${storedWordsOf(new Set(rows.map(l => l.kind)))}.`
      : 'No row of the graph links anything drawn here.';
    const nodes = records ? ` The ${full(records)} events and other records those rows point at are drawn `
                            + 'as nodes of their own.' : '';
    let outside = '';
    if (scored && scorecard) {
      outside = ' The dashed lines come from outside the graph: the kinship scorecard, a separate table '
        + `Apple keeps in the same store. iKnow draws one from you to each of the ${plural(scored, 'person', 'people')} `
        + `it scores ${full(cut)} or more on family-and-friends.`
        + (scoreOnly ? ` ${plural(scoreOnly, 'of them is', 'of them are')} on this graph only because of that score`
                       + (notInGraph ? `, and ${full(notInGraph)} of those ${notInGraph === 1 ? 'has' : 'have'} `
                                       + 'no row in the graph at all.' : '.') : '');
    } else if (scored) {
      outside = ` The kinship scorecard, which comes from outside the graph, is switched off: its `
        + `${plural(scored, 'line', 'lines')}${scoreOnly ? `, the ${plural(scoreOnly, 'person', 'people')} only it puts here,` : ''} `
        + 'and the family and closeness colours iKnow draws from it are hidden.';
    }
    el.appendChild(h('strong', { text: scored && scorecard
      ? 'The graph as the store keeps it, and one thing from outside it.'
      : 'The graph as the store keeps it.' }));
    el.appendChild(document.createTextNode(` ${solid}${nodes}${outside}`));
  }

  return { el, update };
}

/** The switch for the one addition from outside the graph. On by default;
 *  `onChange(on)` redraws. Its swatch is the scorecard line itself. */
export function scorecardSwitch(initial, onChange) {
  let on = Boolean(initial);
  const key = h('span', { class: 'viz-key viz-key-line viz-key-dash' });
  key.style.setProperty('--key-colour', SCORECARD_COLOUR);
  const btn = h('button', {
    class: 'pill', type: 'button',
    title: 'The dashed lines, and the family and closeness colours, come from the kinship scorecard: '
         + 'outside the graph, in a separate table of the same store',
    onclick: () => { on = !on; sync(); onChange(on); },
  }, [key, h('span', { text: 'kinship scorecard · from outside the graph' })]);
  function sync() {
    btn.setAttribute('aria-pressed', String(on));
    btn.style.opacity = on ? '1' : '0.45';
  }
  sync();
  return { el: h('div', { class: 'viz-legend' }, [btn]), get on() { return on; } };
}

/* The tooltip rows for one edge: a row of the graph names its predicate, the
 * facet its far end sits in, and the table it is in; a scorecard line says it
 * has no predicate and gives the score it was drawn for. */
function edgeRows(l, { origins, cut, colourOf, graphRowsOf }) {
  const m = l.meta || {};
  const color = colourOf ? colourOf(l) : null;
  if (origins.get(l.kind) === 'stored' && m.predicate) {
    const rows = [{ value: m.predicate_label || m.predicate, label: `predicate ${m.predicate}`, color }];
    if (m.facet) rows.push({ value: m.facet_label || m.facet, label: `facet ${m.facet}` });
    rows.push({ value: 'one row', label: `of ${m.layer ? 'graph.db ' + m.layer : 'the store'}` });
    return rows;
  }
  if (l.kind === WITHDRAWN_KIND) {
    const rows = [{ value: (m.roles || []).join(', ') || 'withdrawn row', label: 'what the row said', color }];
    rows.push({ value: m.rows === 1 ? 'one row' : `${full(m.rows)} rows`,
                label: 'withdrawn from graph.db, kept in its retraction archive' });
    if (m.retracted_at) {
      rows.push({ value: new Date(m.retracted_at * 1000).toISOString().slice(0, 10), label: 'withdrawn on' });
    }
    return rows;
  }
  if (l.kind === SCORECARD_KIND) {
    const rows = [
      { value: 'no predicate', label: 'from the kinship scorecard, outside the graph', color },
      { value: full(Number(l.weight)), label: `family-and-friends score, at or above the cut of ${full(cut)}` },
    ];
    if (graphRowsOf && graphRowsOf(String(l.target)) === 0) {
      rows.push({ value: 'no row', label: 'in the graph for this person: they exist only in the scorecard' });
    }
    return rows;
  }
  return [{ value: 'no predicate', label: 'not a row of the store', color }];
}

/** The tooltip for the edge under the pointer, as showTip takes it: { title,
 *  rows }. `also` are the other edges between the same two nodes: they draw on
 *  top of each other, so every one of them is listed, each opening on its own
 *  colour key. `nameOf(id)` gives an endpoint's label, `colourOf(link)` the
 *  line's colour, `graphRowsOf(id)` how many graph rows a scorecard-only person has. */
export function edgeTip(l, { nameOf, origins, cut, colourOf, graphRowsOf }, also = []) {
  const title = `${nameOf(String(l.source))} — ${nameOf(String(l.target))}`
    + (also.length ? ` · ${also.length + 1} rows between them` : '');
  const rows = [l, ...also].flatMap(x => edgeRows(x, { origins, cut, colourOf, graphRowsOf }));
  return { title, rows };
}
