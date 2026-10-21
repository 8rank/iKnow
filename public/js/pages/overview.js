/* overview.js — the store itself: what the file holds, and how far its joins reach.
 *
 * Order of argument, deliberately:
 *
 *   1. how much is in the file at all, and what it models, by entity type;
 *   2. two real rows expanded into every namespace they reach — the claim, made
 *      concrete rather than asserted;
 *   3. every namespace the store points into, and what each one was measured to
 *      resolve to;
 *   4. the correction: the join is real, and on this device it is also sparse.
 *
 * Nothing on this page is written down here. Every name, count, token and date
 * arrives from /api/overview, which counts it at the moment you load the page.
 */

import { api } from '../app.js';
import { h, figure, bars, stackedBar, hero, legend, tableView,
         full, pct, SERIES } from '../viz.js';

export const meta = {
  id: 'overview',
  nav: 'The store',
  group: 'The machinery',
  kicker: 'The file itself',
  title: 'One file holds the join: Contacts records, handles, face clusters, the family circle, '
       + 'the calendar and the installed apps, resolved onto single entities',
  blurb: 'What the store models, by entity type; two real rows expanded into every namespace they '
       + 'reach, with the facets as stored and the confidence attached; every namespace the file '
       + 'points into, tested against the source stores on this Mac; and how far the identity join '
       + 'actually reaches on this device. Everything is counted from the file the moment you open '
       + 'this page.',
};

/* ---------- small helpers ---------- */

const sty = (node, props) => { Object.assign(node.style, props); return node; };
const goTo = id => () => { location.hash = id; };
const clip = (value, n) => {
  const s = String(value ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const plural = (n, one, many) => `${full(n)} ${n === 1 ? one : many}`;
/* full() renders 1.0 as "1", which reads like a count rather than a certainty. */
const conf = v => (v === 1 ? '1.0' : full(v));

/* A store that holds nothing is a legitimate state, and saying so is more
 * useful than a chart of zero. */
function nothingHere(title, what) {
  return h('section', { class: 'card' }, [
    h('header', { class: 'card-head' }, [h('h3', { text: title })]),
    h('div', { class: 'empty', text: what }),
  ]);
}

/* ---------- 1 · what is in the file ---------- */

function whatIsInIt(d) {
  const census = d.store.census;
  const lead = census.slice(0, 3).map(c => `${c.label} (${full(c.entities)})`).join(', ');
  const tail = census.slice(3);
  const rest = tail.reduce((s, c) => s + c.entities, 0);
  const others = d.triples - d.store.owner_rows;
  const detail = census.length
    ? `${plural(d.store.owner_rows, 'row', 'rows')} in all of them ${d.store.owner_rows === 1 ? 'says' : 'say'} which person is you. `
      + `The other ${full(others)} are what it holds about everyone and everything else it `
      + `models — ${lead}`
      + (tail.length ? `, and ${full(rest)} more entities across `
                     + `${plural(tail.length, 'further type', 'further types')}` : '')
      + ` — and the links between them.`
    : 'This store holds nothing on this device.';

  const card = h('section', { class: 'card' }, [
    hero({
      value: full(d.triples),
      label: 'facts this Mac asserts about its owner and the people around them',
      detail,
    }),
  ]);

  card.appendChild(sty(h('hr', { class: 'rule' }), { margin: '18px 0 14px' }));

  const facts = [
    [`${full(d.store.stable)} + ${full(d.store.event)}`,
     'rows in the person layer and the calendar layer'],
    [full(d.store.statements),
     'of those rows are facets that reassemble into whole statements'],
    [full(d.store.entities), 'entities carry at least one fact'],
  ];
  const list = sty(h('div'), { display: 'grid', gap: '9px' });
  for (const [value, label] of facts) {
    const row = sty(h('div'), { display: 'flex', gap: '10px', alignItems: 'baseline' });
    row.appendChild(sty(h('span', { text: value }), {
      flex: 'none', minWidth: '92px', fontWeight: '620',
      fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)',
    }));
    row.appendChild(h('span', { class: 'muted', text: label }));
    list.appendChild(row);
  }
  card.appendChild(list);

  const dates = [
    d.store.built && `built from scratch ${d.store.built}`,
    d.store.last_write && `last written ${d.store.last_write}`,
    d.store.pruned && `retraction archive pruned ${d.store.pruned}`,
  ].filter(Boolean).join(' · ');
  card.appendChild(sty(h('p', { class: 'card-note', text: dates }), { margin: '14px 0 0' }));
  return card;
}

function censusFigure(d) {
  const census = d.store.census;
  if (!census.length) {
    return nothingHere('What the graph models, by entity type',
                       'No entity carries a type on this device.');
  }
  const total = census.reduce((s, c) => s + c.entities, 0);
  const top = census[0];
  const people = census.find(c => c.label === 'person') || { entities: 0 };
  return figure({
    title: 'What the graph models, by entity type',
    note: `The largest population in the personal knowledge graph is ${top.label}: `
        + `${full(top.entities)} of ${full(total)} entities, ${pct(top.entities, total)} of everything `
        + `it holds a fact about. People are ${pct(people.entities, total)}.`,
    chart: bars(census.map(c => ({ label: c.label, value: c.entities, meta: 'entities' })),
                { labelW: 160, rowH: 28 }),
    table: tableView(['entity type', 'class', 'entities', 'share'],
                     census.map(c => [c.label, c.code, full(c.entities), pct(c.entities, total)])),
  });
}

/* ---------- 2 · one row, every namespace ---------- */

function namespaceBlock(group, d) {
  const box = sty(h('div'), {
    border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
    padding: '10px 12px', background: 'var(--surface-2)',
  });

  const head = sty(h('div'), { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' });
  head.appendChild(sty(h('span', { class: 'mono', text: group.ns + ':' }), {
    color: 'var(--text-primary)', fontWeight: '620',
  }));
  head.appendChild(h('span', { class: 'pill', text: group.kind }));
  box.appendChild(head);
  box.appendChild(sty(h('div', { class: 'muted', text: group.desc }),
                      { fontSize: '11.5px', marginTop: '3px' }));

  for (const r of group.rows) {
    const row = sty(h('div'), { marginTop: '9px' });
    const line = sty(h('div'), { display: 'flex', gap: '8px', alignItems: 'baseline' });
    line.appendChild(sty(h('span', { text: r.facet_label || r.label }), {
      flex: 'none', minWidth: '104px', fontSize: '11.5px', color: 'var(--text-muted)',
    }));
    line.appendChild(sty(h('span', { class: 'mono', text: clip(r.value, 44), title: String(r.value) }), {
      color: 'var(--text-primary)', overflowWrap: 'anywhere',
    }));
    row.appendChild(line);

    const face = d.join.photos[r.value];
    const detail = [
      `confidence ${conf(r.confidence)}`,
      r.sources.length ? `asserted by ${r.sources.join(' + ')}` : null,
      face ? `${plural(face.faces, 'face', 'faces')} in the photo library${face.named ? ', named there too' : ''}` : null,
    ].filter(Boolean).join(' · ');
    row.appendChild(sty(h('div', { class: 'muted', text: detail }), {
      fontSize: '11px', marginLeft: '112px',
    }));
    box.appendChild(row);
  }

  if (group.resolution) {
    box.appendChild(sty(h('div', { text: '→ ' + group.resolution }), {
      marginTop: '9px', fontSize: '11px', color: 'var(--text-secondary)',
    }));
  }
  return box;
}

function entityCard(card, d) {
  const ROLES = { owner: 'the owner of this Mac', widest: 'the person whose row reaches furthest' };
  const box = sty(h('div'), {
    border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', padding: '14px 15px',
  });

  box.appendChild(sty(h('div', { class: 'muted', text: ROLES[card.role] || card.role }), {
    fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase',
  }));
  box.appendChild(sty(h('div', { text: card.name || 'no name anywhere in the store' }), {
    marginTop: '4px', fontSize: '18px', fontWeight: '620', letterSpacing: '-0.02em',
    color: card.name ? 'var(--text-primary)' : 'var(--text-muted)',
  }));

  const meta = [
    card.class_label,
    `${plural(card.facts, 'fact', 'facts')}`,
    `${plural(card.statements, 'statement', 'statements')}`,
    `${plural(card.namespaces.length, 'namespace', 'namespaces')}`,
    card.name_variants > 1 ? `${full(card.name_variants)} name forms` : null,
  ].filter(Boolean).join(' · ');
  box.appendChild(sty(h('div', { class: 'muted', text: meta }), { fontSize: '11.5px', marginTop: '4px' }));
  box.appendChild(sty(h('div', { class: 'mono muted', text: card.id }), { marginTop: '2px' }));

  const stack = sty(h('div'), { display: 'grid', gap: '8px', marginTop: '12px' });
  for (const group of card.namespaces) stack.appendChild(namespaceBlock(group, d));
  box.appendChild(stack);

  if (card.backlinks.length) {
    const back = sty(h('div'), { marginTop: '12px' });
    back.appendChild(sty(h('div', { class: 'muted', text: 'and pointed at, from elsewhere in the same file' }),
                         { fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase' }));
    for (const b of card.backlinks) {
      const line = sty(h('div'), { display: 'flex', gap: '8px', alignItems: 'baseline', marginTop: '5px' });
      line.appendChild(sty(h('span', { text: b.label }), {
        flex: 'none', minWidth: '160px', fontSize: '12px', color: 'var(--text-secondary)',
      }));
      const where = b.layer === 'event_graph'
        ? ['calendar event', 'calendar events'] : ['entity', 'entities'];
      line.appendChild(h('span', { class: 'muted', text: plural(b.subjects, where[0], where[1]) }));
      back.appendChild(line);
    }
    box.appendChild(back);
  }
  return box;
}

function joinFigure(d) {
  if (!d.join.cards.length) {
    return nothingHere('One row, every namespace',
                       'No person entity in this store, so there is no row to expand.');
  }
  const wrap = h('div');
  const grid = sty(h('div'), {
    display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  });
  for (const card of d.join.cards) grid.appendChild(entityCard(card, d));
  wrap.appendChild(grid);

  for (const s of d.join.shared) {
    wrap.appendChild(sty(h('div', {}, [
      h('span', { text: 'Both rows carry the identical ' }),
      h('span', { class: 'mono', text: s.ns + ':' }),
      h('span', { text: ' token — ' }),
      h('span', { class: 'mono', text: clip(s.value.split(':').slice(1).join(':'), 28), title: s.value }),
      h('span', { text: '. iKnow does not resolve that token. Entities that share it are in the same '
                      + 'Family Sharing circle, by iKnow’s reading.' }),
    ]), {
      marginTop: '14px', padding: '10px 12px', fontSize: '12.5px',
      color: 'var(--text-secondary)', background: 'var(--wash)',
      borderRadius: 'var(--r-sm)', overflowWrap: 'anywhere',
    }));
  }

  const rows = [];
  for (const card of d.join.cards) {
    for (const group of card.namespaces) {
      for (const r of group.rows) {
        rows.push([card.name || card.id, group.ns, r.label, r.facet_label || '—',
                   r.value, conf(r.confidence), r.sources.join(' + ') || '—']);
      }
    }
  }

  const probes = Object.entries(d.join.calendar_probe)
    .map(([, p]) => p.values).reduce((a, b) => Math.max(a, b), 0);

  return figure({
    wide: true,
    title: 'One row, every namespace',
    note: 'These are real statement rows, expanded. Each block is one namespace the entity actually '
        + 'resolves into, with the facets as they are stored and the confidence the machine attached. '
        + 'Where a resolution could be tested it was tested just now, against the address book, the '
        + `photo library, chat.db and the calendar store on this Mac${probes ? ` — the last of those by searching all ${full(probes)} of its short text values` : ''}.`,
    chart: wrap,
    table: tableView(['entity', 'namespace', 'statement', 'facet', 'value', 'confidence', 'asserted by'], rows),
  });
}

/* ---------- 3 · the namespace ledger ---------- */

function ledgerFigure(d) {
  const sorted = d.ledger.slice().sort((a, b) => b.occurrences - a.occurrences);
  const chart = bars(sorted.map(l => ({
    label: l.ns, value: l.occurrences, meta: `occurrences · ${full(l.distinct)} distinct`,
  })), { labelW: 150, rowH: 26 });

  const table = tableView(
    ['namespace', 'points at', 'occurrences', 'distinct', 'on the owner row', 'on the widest row', 'what it resolves to'],
    d.ledger.map(l => [l.ns, l.kind, full(l.occurrences), full(l.distinct),
                       l.on_owner ? 'yes' : '—', l.on_peer ? 'yes' : '—', l.note]));

  return figure({
    wide: true,
    title: 'Every namespace this store points into',
    note: `A namespace is recognised by an allowlisted head, never by splitting on a colon: `
        + `${full(d.decoys)} live objects contain a colon and are not references at all — calendar `
        + `descriptions, serialised dates, free-text locations. The ${'handle'} row is the exception: it is `
        + `not a namespace but the phone and mail values stored bare on contact-information statements, `
        + `counted here because they are the most directly usable thing in the file. Open the table for `
        + `what each one was measured to resolve to.`,
    chart,
    table,
  });
}

/* ---------- 4 · the correction ---------- */

function islandsFigure(d) {
  const buckets = d.islands.buckets;
  if (!buckets.length) {
    return nothingHere('How far the identity join actually reaches',
                       'This store models no people, so there is no join to measure.');
  }
  const total = d.islands.people;
  const segments = buckets.map((b, i) => ({ label: b.label, value: b.people, color: SERIES(i) }));

  return figure({
    wide: true,
    title: 'How far the identity join actually reaches',
    note: `Every one of the ${full(total)} person entities in the store, by how many external `
        + `namespaces its own rows resolve into. Contacts people and Photos face clusters overlap in `
        + `exactly ${plural(d.islands.contacts_and_photos, 'person', 'people')}.`,
    legend: legend(segments, 'rect'),
    chart: stackedBar(segments, { height: 38 }),
    table: tableView(['how many namespaces', 'people', 'share of all people'],
                     buckets.map(b => [b.label, full(b.people), pct(b.people, total)])),
  });
}

function correction(d) {
  const i = d.islands;
  if (!i.people) return null;
  return h('div', { class: 'callout' }, [
    h('div', { class: 'callout-icon', text: 'i' }),
    h('div', {}, [
      h('h4', { text: 'How many people land in more than one store' }),
      h('p', { text:
        `By the references each person entity carries: `
        + i.buckets.filter(b => / only$/.test(b.label))
                  .map(b => `${full(b.people)} to ${b.label.replace(/ only$/, '')} alone`).join(', ')
        + `, ${full(i.none)} to nothing outside this file, and `
        + `${plural(i.multi, 'person', 'people')} of ${full(i.people)} into two or more. `
        + `${full(i.multi_in_circle)} of those ${full(i.multi)} are members of the Family Sharing circle.` }),
    ]),
  ]);
}

/* ---------- render ---------- */

export async function render(root) {
  const d = await api('overview');

  const top = h('div', { class: 'grid' });
  top.appendChild(whatIsInIt(d));
  top.appendChild(censusFigure(d));
  root.appendChild(top);

  root.appendChild(h('hr', { class: 'rule' }));
  root.appendChild(joinFigure(d));

  root.appendChild(ledgerFigure(d));

  root.appendChild(h('hr', { class: 'rule' }));
  root.appendChild(islandsFigure(d));
  const fix = correction(d);
  if (fix) root.appendChild(fix);
}
