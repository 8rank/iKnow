/* identity.js — the join table, and how sparse it actually is.
 *
 * Every number on this page is computed by /api/identity at request time from
 * the live stores.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, heatmap, stackedBar, hero, meter, legend,
         tableView, full, pct, day, SERIES } from '../viz.js';

export const meta = {
  id: 'identity',
  nav: 'The join table',
  group: 'What it recorded',
  kicker: 'Identity resolution',
  title: 'One predicate links a handle, a face or an app to a named person',
  blurb: 'Cross-store references in this graph flow mostly through one "same as" predicate, pointing into Contacts, ' +
         'the Photos face clusters, EventKit and the app catalogue. This page measures where each pointer lands, which ' +
         'ones still resolve against the source stores on this machine, and how often two of them land on the same person.',
};

/* ---------- small local helpers ---------- */

const pill = (text, cls) => h('span', { class: 'pill' + (cls ? ' pill-' + cls : ''), text });

const note = text => h('p', { class: 'card-note', text });

/** English plurals, so counted prose reads correctly whatever the data says. */
const s = n => (n === 1 ? '' : 's');
const entities = n => (n === 1 ? 'entity' : 'entities');
const peopleOf = n => `${full(n)} ${n === 1 ? 'person' : 'people'}`;

const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);

/** A handle is a real phone number or mail address. Masked unless asked for. */
function mask(value, kind) {
  if (!value) return '—';
  if (kind === 'mail') {
    const at = value.lastIndexOf('@');
    if (at < 1) return value.slice(0, 1) + '…';
    return value.slice(0, 1) + '…' + value.slice(at);
  }
  const keep = value.slice(-2);
  return value.slice(0, 1) + '…'.repeat(3) + keep;
}

/* ---------- the person drawer ---------- */

let drawerEl = null;

function closeDrawer() {
  if (drawerEl) { drawerEl.remove(); drawerEl = null; }
}

function drawerShell() {
  closeDrawer();
  const back = h('div');
  Object.assign(back.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.35)', zIndex: '80',
  });
  back.addEventListener('click', ev => { if (ev.target === back) closeDrawer(); });

  const panel = h('aside', { role: 'dialog', 'aria-label': 'entity detail' });
  Object.assign(panel.style, {
    position: 'absolute', top: '0', right: '0', height: '100%',
    width: 'min(560px, 94vw)', overflowY: 'auto', padding: '20px 22px 48px',
    background: 'var(--surface-1)', borderLeft: '1px solid var(--border-strong)',
  });

  const close = h('button', { class: 'ghost', type: 'button', text: 'close', onclick: closeDrawer });
  Object.assign(close.style, { float: 'right' });
  panel.appendChild(close);

  const body = h('div');
  panel.appendChild(body);
  back.appendChild(panel);
  document.body.appendChild(back);
  drawerEl = back;

  const onKey = ev => { if (ev.key === 'Escape') { closeDrawer(); removeEventListener('keydown', onKey); } };
  addEventListener('keydown', onKey);
  return body;
}

function factCard(f) {
  const box = h('div', { class: 'card' });
  box.style.padding = '12px 14px';
  box.style.marginBottom = '8px';
  const head = h('div', { class: 'card-head' });
  head.appendChild(h('h3', { text: f.statement_class_label || f.label }));
  head.appendChild(h('span', { class: 'muted mono', text: f.predicate }));
  box.appendChild(head);

  if (f.statement_class_label) box.appendChild(note(f.label));

  if (!f.facets.length) {
    box.appendChild(h('div', { class: 'mono', text: f.object_label || f.entity_name || f.object || '—' }));
  } else {
    const rows = f.facets.map(x => [
      x.label || x.facet,
      x.object_label || x.name || x.object || '—',
      x.decoded && x.decoded.kind !== 'literal' ? x.decoded.kind : '',
    ]);
    box.appendChild(tableView(['facet', 'value', 'kind'], rows));
  }

  const foot = h('div', { class: 'muted' });
  foot.style.marginTop = '6px';
  foot.appendChild(h('span', { text: `confidence ${full(f.confidence)}` }));
  if (f.sources.length) foot.appendChild(h('span', { text: ' · ' + f.sources.join(', ') }));
  if (f.timestamp) foot.appendChild(h('span', { text: ' · written ' + day(f.timestamp) }));
  box.appendChild(foot);
  return box;
}

async function openPerson(id) {
  const body = drawerShell();
  body.appendChild(h('div', { class: 'loading', text: 'reading the store…' }));
  let d;
  try {
    d = await api('person', { id });
  } catch (err) {
    body.textContent = '';
    body.appendChild(h('div', { class: 'error', text: String(err.message || err) }));
    return;
  }
  body.textContent = '';

  if (!d.found) {
    body.appendChild(h('div', { class: 'empty', text: d.reason || 'nothing here' }));
    return;
  }

  body.appendChild(h('div', { class: 'view-kicker', text: d.class_label || 'entity' }));
  body.appendChild(h('h2', { text: d.name || 'this entity carries no name' }));
  const tags = h('div');
  tags.style.margin = '6px 0 14px';
  if (d.is_owner) tags.appendChild(pill('the device owner'));
  tags.appendChild(pill(`${d.fact_count} facts`));
  tags.appendChild(pill(`${d.referrers.length} inbound reference${d.referrers.length === 1 ? '' : 's'}`));
  if (d.expired_facts) tags.appendChild(pill(`${d.expired_facts} retracted facts`, 'warning'));
  body.appendChild(tags);
  body.appendChild(h('div', { class: 'mono muted', text: 'entity ' + d.id }));

  /* namespaces it resolves into */
  body.appendChild(h('h3', { text: 'Resolves into' }));
  if (!d.namespaces.length) {
    body.appendChild(h('div', { class: 'empty', text: 'no external namespace — this entity exists only inside the graph' }));
  } else {
    body.appendChild(tableView(
      ['namespace', 'what it names', 'resolves to', 'via'],
      d.namespaces.map(n => [
        n.ns,
        n.note,
        n.resolves ? n.resolves.store : 'not resolvable from this bundle',
        n.resolves ? n.resolves.how : '—',
      ]),
    ));
  }

  /* aliases */
  body.appendChild(h('h3', { text: 'Name variants the graph stores' }));
  if (!d.aliases.length) {
    body.appendChild(h('div', { class: 'empty', text: 'no alias statements' }));
  } else {
    body.appendChild(tableView(
      ['alias', 'provenance', 'confidence'],
      d.aliases.map(a => [a.alias || '—', a.provenance || '—', full(a.confidence)]),
    ));
  }

  /* inbound edges */
  body.appendChild(h('h3', { text: 'What points at it' }));
  if (!d.referrer_summary.length) {
    body.appendChild(h('div', { class: 'empty', text: 'nothing in the live layers references this entity' }));
  } else {
    body.appendChild(tableView(
      ['edge', 'layer', 'count'],
      d.referrer_summary.map(r => [r.label, r.layer, full(r.edges)]),
    ));
    if (d.expired_references) {
      body.appendChild(note(`${d.expired_references} further references sit in the retracted layers.`));
    }
  }

  /* the facts */
  body.appendChild(h('h3', { text: 'Every fact carried on this entity' }));
  for (const f of d.facts) body.appendChild(factCard(f));
}

const openable = (text, id) =>
  h('button', { class: 'ghost', type: 'button', text, onclick: () => openPerson(id) });

/* ---------- the page ---------- */

export async function render(root) {
  const d = await api('identity');
  const { census, funnel, fanout, contacts, photos, calendar, handles, rollup, apps, reach } = d;

  /* ---- 1. the headline correction ---- */

  root.appendChild(hero({
    value: fanout.multi,
    label: `of ${full(fanout.people)} person entities carry references into two or more identity namespaces`,
    detail: `${pct(fanout.multi, fanout.people)} of the people this graph knows. ${full(fanout.single)} land in exactly one ` +
            `directory, and ${full(fanout.event_only)} in no person directory at all — they carry only an event reference, ` +
            `which names a meeting rather than a human.`,
  }));

  const glossOf = ns => (census.rows.find(r => r.ns === ns) || {}).note || '';
  const singles = fanout.combos.filter(c => c.degree <= 1);
  const split = h('div', { class: 'grid' });
  for (const c of singles) {
    split.appendChild(statTile({
      label: c.event_only ? 'a seat at a meeting, nothing else' : `${c.key} only`,
      value: c.people,
      sub: c.event_only
        ? 'identified by an event reference, with no person record anywhere'
        : `${pct(c.people, fanout.people)} of person entities`,
    }));
  }
  split.appendChild(statTile({
    label: 'two or more namespaces',
    value: fanout.multi,
    sub: 'person entities with references into two or more namespaces',
  }));
  root.appendChild(split);

  root.appendChild(callout(
    'How far the graph fuses one person across stores',
    `One entity can carry the Contacts id, the phone and mail handles, the ` +
    `Photos face cluster, the calendar seats and the installed apps side by side. ` +
    `Entities like that exist — ${full(fanout.multi)} of ${full(fanout.people)} do. The other ${full(fanout.people - fanout.multi)} ` +
    `carry exactly one of those, or only a seat at a meeting. This page leads with the ones that land in several stores.`,
    'warning'));

  // stackedBar tops out at six segments: keep the five largest single-namespace
  // buckets, fold any remainder into one, and always show the multi bucket.
  const keep = singles.slice(0, 5);
  const folded = singles.slice(5).reduce((n, c) => n + c.people, 0);
  const segs = keep.map((c, i) => ({
    label: c.event_only ? 'event reference only' : c.key + ' only',
    value: c.people, color: SERIES(i),
  }));
  if (folded) segs.push({ label: 'other single-namespace', value: folded, color: SERIES(segs.length) });
  segs.push({ label: 'two or more', value: fanout.multi, color: SERIES(segs.length) });
  root.appendChild(figure({
    title: 'Where each person entity actually lands',
    note: `${full(fanout.people)} person entities, grouped by the set of person-naming namespaces they resolve into. ` +
          `Contacts references and face clusters overlap on ${peopleOf((fanout.overlap.find(o => o.a === 'cnContact' && o.b === 'phPerson') || { people: 0 }).people)}. ` +
          `Event-scoped references (a calendar or mail-suggestion seat) are counted separately because they name a meeting, not a human. ` +
          `The namespaces: ${fanout.namespaces.map(n => `${n} is ${glossOf(n)}`).join('; ')}.`,
    legend: legend(segs.map(s => ({ label: s.label, color: s.color })), 'rect'),
    chart: stackedBar(segs),
    table: tableView(
      ['namespace combination', 'people', 'share', 'namespaces joined'],
      fanout.combos.map(c => [c.key, full(c.people), pct(c.people, fanout.people), c.degree]),
    ),
  }));

  /* ---- 2. the few fully-resolved people ---- */

  const multi = fanout.rows.filter(r => r.degree >= 2);
  const multiCard = h('section', { class: 'card card-wide' });
  multiCard.appendChild(h('header', { class: 'card-head' }, [
    h('h3', { text: 'The people the join actually fused' }),
    h('span', { class: 'muted', text: `${full(multi.length)} of ${full(fanout.people)}` }),
  ]));
  multiCard.appendChild(note(
    'These are the entities where a contact card, a face cluster, a family circle or an Intents record meet on one node. ' +
    'Open one to see its whole fact set.'));
  const list = h('div', { class: 'grid' });
  for (const r of multi) {
    const card = h('div', { class: 'stat stat-click' });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const go = () => openPerson(r.id);
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    card.appendChild(h('div', { class: 'stat-label', text: r.is_owner ? 'the device owner' : 'person entity' }));
    card.appendChild(h('div', { class: 'stat-value', text: r.name || 'unnamed' }));
    const tagRow = h('div');
    tagRow.style.margin = '6px 0';
    for (const ns of r.namespaces) tagRow.appendChild(pill(ns));
    for (const ns of r.event_namespaces) tagRow.appendChild(pill(ns));
    card.appendChild(tagRow);
    card.appendChild(h('div', { class: 'stat-sub',
      text: `${full(r.degree)} identity namespaces · ${full(r.handles)} handles · ${full(r.events)} events invited to` }));
    list.appendChild(card);
  }
  multiCard.appendChild(list);
  root.appendChild(multiCard);

  /* ---- 3. the census ---- */

  const ext = census.rows.filter(r => r.external);
  const int = census.rows.filter(r => !r.external);
  root.appendChild(figure({
    title: 'What the graph is joinable to',
    wide: true,
    note: `${full(census.namespaced)} namespaced references across ${full(census.objects)} objects in all four layers. ` +
          `Namespace is decided by an allowlist on the head of the value, never by splitting on a colon: ` +
          `${full(census.colon_but_literal)} objects contain a colon and are NOT references — calendar prose, serialised dates, ` +
          `identifier strings. Bars show occurrences; the table adds distinct references and the entities that carry them.`,
    chart: bars(census.rows.map(r => ({
      label: r.ns, value: r.occurrences, meta: `${r.kind} · ${full(r.distinct_refs)} distinct`,
      color: r.external ? 'var(--series-1)' : 'var(--text-muted)',
    })), { labelW: 140 }),
    legend: legend([
      { label: 'points at another store', color: 'var(--series-1)' },
      { label: 'stays inside the graph (edges, URIs, enums)', color: 'var(--text-muted)' },
    ], 'rect'),
    table: tableView(
      ['namespace', 'what it names', 'occurrences', 'distinct refs', 'entities', 'live', 'retracted'],
      census.rows.map(r => [r.ns, r.note, full(r.occurrences), full(r.distinct_refs),
                            full(r.entities), full(r.live), full(r.expired)]),
    ),
  }));

  const layerNames = census.layers.map(l => l.layer);
  const cells = [];
  for (const r of census.rows) {
    for (const [layer, n] of Object.entries(r.layers)) cells.push({ row: r.ns, col: layer, value: n });
  }
  root.appendChild(figure({
    title: 'Which layer each namespace lives in',
    note: `Contacts and face-cluster references exist only in the stable layer; calendar references reach into the retracted ` +
          `layers too, so some of the join surface describes facts the graph has already withdrawn.`,
    chart: heatmap(cells, census.rows.map(r => r.ns), layerNames, { labelW: 140, unit: 'occurrences' }),
    table: tableView(['namespace', ...layerNames],
      census.rows.map(r => [r.ns, ...layerNames.map(l => full(r.layers[l] || 0))])),
  }));

  /* ---- 4. one predicate ---- */

  const funnelRows = funnel.rows.slice();
  root.appendChild(figure({
    title: funnel.exceptions.length
      ? `Almost every cross-store reference flows through one predicate, with ${full(funnel.exceptions.length)} exception${funnel.exceptions.length === 1 ? '' : 's'}`
      : 'Every cross-store reference flows through one predicate',
    note: `${full(funnel.main_occurrences)} of ${full(funnel.occurrences)} references into other stores are carried by ` +
          `${funnel.main_predicate} "${funnel.main_label}". ` +
          (funnel.exceptions.length
            ? `The measured exception: ${funnel.exceptions.map(e => `${full(e.occurrences)} ${e.ns} reference on ${e.predicate} "${e.label}"`).join(', ')}. `
            : 'No exception was found. ') +
          `${funnel.single_predicate_namespaces} of ${funnel.namespaces} namespaces use one predicate and nothing else. ` +
          (funnel.exceptions.length ? '' : `One WHERE clause is the entire join surface. `) +
          `(Internal ${full(funnel.internal_occurrences)} references — entity-to-entity edges, URIs and the association enum — ` +
          `spread across ${funnel.internal_predicates} predicates instead, which is what makes the single-predicate result meaningful.)`,
    chart: bars(ext.map(r => ({
      label: r.ns, value: r.occurrences,
      meta: (funnel.rows.filter(x => x.ns === r.ns).map(x => x.predicate).join(', ')),
    })), { labelW: 140 }),
    table: tableView(
      ['namespace', 'predicate', 'label', 'facet', 'occurrences'],
      funnelRows.map(r => [r.ns, r.predicate, r.label, r.facet_label || r.facet || '—', full(r.occurrences)]),
    ),
  }));

  /* ---- 5. contacts ---- */

  const cSeg = [];
  for (const f of contacts.forms) {
    for (const p of f.paths) {
      cSeg.push({ label: `${f.form} → ${p.path}`, value: p.values, color: SERIES(cSeg.length) });
    }
  }
  const unresolvedRows = contacts.rows.filter(r => !r.resolved);
  const unresolvedEntities = new Set(unresolvedRows.flatMap(r => r.entities)).size;
  const unresolved = contacts.values - contacts.matched;
  if (unresolved > 0) cSeg.push({ label: 'unresolved', value: unresolved, color: 'var(--text-muted)' });

  root.appendChild(figure({
    title: 'Contacts references, matched against the real address book',
    wide: true,
    note: `${full(contacts.matched)} of ${full(contacts.values)} distinct contact references (${pct(contacts.matched, contacts.values)}) ` +
          `resolve to a card in the address-book files that ship in this bundle, covering ` +
          `${full(contacts.entities_matched)} of ${full(contacts.entities)} graph entities. ` +
          (contacts.forms.length > 1
            ? `They come in ${full(contacts.forms.length)} value forms (${contacts.forms.map(f => f.form).join(', ')}), ` +
              `each with its own join path: the suffixed form matches the record's own unique id, the bare form the link id ` +
              `that unifies a card across address-book files. `
            : contacts.forms.length === 1 ? `They all come in one value form (${contacts.forms[0].form}). ` : '') +
          `The suffix is part of the stored key, so iKnow joins on the full value. ` +
          (unresolvedRows.length
            ? `Unresolved: ${full(unresolvedRows.length)} of ${full(contacts.values)}, all of them the ` +
              `${[...new Set(unresolvedRows.map(r => r.form))].join(' / ')} form, carried by ${full(unresolvedEntities)} ` +
              `${entities(unresolvedEntities)} — the graph points at cards iKnow did not find in the address book.`
            : 'Every reference resolves.'),
    legend: legend(cSeg.map(s => ({ label: s.label, color: s.color })), 'rect'),
    chart: stackedBar(cSeg),
    table: tableView(
      ['value form', 'distinct values', 'resolved', 'rate', 'join path'],
      contacts.forms.map(f => [f.form, full(f.values), full(f.matched), pct(f.matched, f.values),
                               f.paths.map(p => `${p.path} (${full(p.values)})`).join(', ') || '—']),
    ),
  }));

  root.appendChild(figure({
    title: 'Which address-book file the references land in',
    note: `${full(contacts.card_files.length)} address-book files ship in this bundle and ` +
          `${full(contacts.card_files.filter(b => b.person_cards).length)} of them hold real person cards. Every match lands in ` +
          `those; the others contribute none. Raw record counts are dominated by sync stubs and say nothing about how many ` +
          `people a file holds.`,
    chart: bars(contacts.card_files.map(b => ({
      label: b.file.split('-')[0], value: b.matches, meta: `${full(b.person_cards)} person cards`,
    })), { labelW: 110 }),
    table: tableView(['address-book file', 'records', 'person cards', 'matched references'],
      contacts.card_files.map(b => [b.file, full(b.records), full(b.person_cards), full(b.matches)])),
  }));

  /* ---- 6. the two corrections ---- */

  const corr = h('div', { class: 'grid' });

  const ph = h('section', { class: 'card' });
  ph.appendChild(h('header', { class: 'card-head' }, [
    h('h3', { text: 'Face-cluster references are plaintext, not digests' }),
  ]));
  ph.appendChild(note(
    `Measured here: all ${full(photos.values)} values share one ` +
    `length, ${full(photos.uuid_shaped)} of them begin with a plain UUID, and the remainder is a constant library-scope suffix. ` +
    `${photos.decodes_as_32_byte_hash === 0 ? 'None' : full(photos.decodes_as_32_byte_hash)} of them decode as a 32-byte value under strict base64 — ` +
    `they are plaintext identifiers with a fixed shape, not digests. ` +
    `${full(photos.resolved)} of ${full(photos.values)} match a person row in the Photos library on this machine ` +
    `(${full(photos.photos_person_rows)} clusters exist there in total).`));
  ph.appendChild(meter({ value: photos.resolved, max: photos.values, label: 'face references that resolve to a Photos cluster' }));
  ph.appendChild(tableView(
    ['measurement', 'value'],
    [['distinct references', full(photos.values)],
     ['entities carrying one', full(photos.entities)],
     ['UUID-shaped prefix', `${full(photos.uuid_shaped)} of ${full(photos.values)}`],
     ['distinct value lengths', photos.lengths.map(l => `${l.length} chars ×${full(l.values)}`).join(', ')],
     ['constant suffix', photos.suffixes.map(s => `${s.suffix} ×${full(s.values)}`).join(', ')],
     ['decodes to a 32-byte hash', full(photos.decodes_as_32_byte_hash)],
     ['resolves in Photos', `${full(photos.resolved)} of ${full(photos.values)}`],
     ['sibling plaintext facet on the same entity', full(photos.sibling_plaintext_facet)]],
  ));
  corr.appendChild(ph);

  const ek = calendar.namespaces.find(n => n.ns === 'ekEvent');
  const sg = calendar.namespaces.find(n => n.ns === 'sgEvent');
  const ev = h('section', { class: 'card' });
  ev.appendChild(h('header', { class: 'card-head' }, [
    h('h3', { text: 'Calendar tokens, re-derived from the Calendar store' }),
  ]));
  ev.appendChild(note(calendar.preimages === 0
    ? `The Calendar store is not present in this bundle, so the construction ` +
      `cannot be tested here — this panel reports that absence rather than a match rate.`
    : `Hashing the store-qualified ` +
    `composite — the calendar store's persistent id, a colon, the item's unique identifier — and base64-encoding the digest ` +
    `reproduces ${ek ? full(ek.resolved) : '0'} of ${ek ? full(ek.tokens) : '0'} tokens against the ` +
    `${full(calendar.preimages)} calendar items in this bundle. ` +
    `The same construction applied to the mail-suggestion namespace reproduces ${sg ? full(sg.resolved) : '0'} of ` +
    `${sg ? full(sg.tokens) : '0'} — that store is genuinely not in this bundle, which is a bounded negative rather than a failure.`));
  if (ek) ev.appendChild(meter({ value: ek.resolved, max: ek.tokens, label: 'calendar tokens re-derived from the Calendar store' }));
  ev.appendChild(tableView(
    ['namespace', 'distinct tokens', 'resolved', 'live', 'retracted'],
    calendar.namespaces.map(n => [n.ns, full(n.tokens), `${full(n.resolved)} (${pct(n.resolved, n.tokens)})`,
                                  full(n.resolved_live), full(n.resolved_expired)]),
  ));
  corr.appendChild(ev);

  const ap = h('section', { class: 'card' });
  ap.appendChild(h('header', { class: 'card-head' }, [
    h('h3', { text: 'The token scheme, proven inside the store' }),
  ]));
  ap.appendChild(note(
    `The app namespace is the controlled experiment, because ${full(apps.with_plaintext)} software entities carry the opaque ` +
    `token and the plaintext bundle id side by side. Re-hashing the plaintext reproduces the token ` +
    `${full(apps.reproduced)} times out of ${full(apps.with_plaintext)} — unsalted, no secret, one guess per identifier. ` +
    `That is what the calendar test above rides on, and it is why "opaque token" is not a privacy property: it defeats ` +
    `browsing, not guessing. ${full(apps.entities - apps.with_plaintext)} entities carry a token with no plaintext beside it; ` +
    `those are recoverable the same way, from a public list of bundle ids.`));
  ap.appendChild(meter({ value: apps.reproduced, max: apps.with_plaintext, label: 'app tokens reproduced from their plaintext' }));
  ap.appendChild(tableView(
    ['measurement', 'value'],
    [['entities carrying a token', full(apps.entities)],
     ['also carrying the plaintext id', full(apps.with_plaintext)],
     ['distinct tokens', full(apps.distinct_tokens)],
     ['distinct plaintext ids', full(apps.distinct_bundles)],
     ['reproduced by re-hashing', `${full(apps.reproduced)} of ${full(apps.with_plaintext)}`],
     ['padding kept / stripped', `${full(apps.padding_kept)} / ${full(apps.padding_stripped)}`]],
  ));
  corr.appendChild(ap);
  root.appendChild(corr);

  root.appendChild(callout(
    'Why resolvable matters',
    `Whether a namespace is opaque or resolvable is the whole question: it decides whether ` +
    `a copy of this file is a list of hashes or a working index into the photo library and the calendar. The panels ` +
    `above give the measured rate for each.`));

  /* ---- 7. the handle reverse index ---- */

  root.appendChild(figure({
    title: 'Contact handles by the label Apple stored',
    note: `${full(handles.phone)} phone facets and ${full(handles.mail)} mail facets hang off the reified contact-information ` +
          `statements. Labels wrapped in Apple's sentinel syntax are unwrapped here; free-text and localised labels are shown ` +
          `verbatim because the user typed them.`,
    chart: bars(handles.labels.map(l => ({
      label: l.label, value: l.facets, meta: l.sentinel ? 'Apple sentinel label' : 'free text / localised',
    })), { labelW: 130 }),
    table: tableView(['label', 'origin', 'facets'],
      handles.labels.map(l => [l.label, l.sentinel ? 'Apple sentinel' : 'free text', full(l.facets)])),
  }));

  const CAP = 60;
  const idx = h('section', { class: 'card card-wide' });
  const idxHead = h('header', { class: 'card-head' });
  idxHead.appendChild(h('h3', { text: 'Handle → person: the reverse index' }));
  let revealed = false;
  const rowsBox = h('div');
  const paint = () => {
    rowsBox.textContent = '';
    rowsBox.appendChild(tableView(
      ['handle', 'kind', 'label', 'resolves to', 'also lands in', 'asserted by', ''],
      handles.rows.slice(0, CAP).map(r => [
        revealed ? r.value : mask(r.value, r.kind),
        r.kind,
        r.label || '—',
        (r.name || 'unnamed entity') + (r.is_owner ? ' (the owner)' : ''),
        r.namespaces.join(', ') || 'nothing else',
        r.sources.join(', ') || '—',
        '',
      ]),
    ));
    // the last column becomes an open-drawer button per row
    const body = rowsBox.querySelector('tbody');
    handles.rows.slice(0, CAP).forEach((r, i) => {
      const cell = body.children[i].lastElementChild;
      cell.textContent = '';
      cell.appendChild(openable('open', r.id));
    });
  };
  const revealBtn = h('button', {
    class: 'ghost', type: 'button', text: 'reveal handles',
    onclick: () => { revealed = !revealed; revealBtn.textContent = revealed ? 'mask handles' : 'reveal handles'; paint(); },
  });
  idxHead.appendChild(revealBtn);
  idx.appendChild(idxHead);
  idx.appendChild(note(
    `${full(handles.handles)} distinct handles resolve to ${full(handles.people)} person entities, ` +
    `${full(handles.named_people)} of them carrying a name. ${full(handles.shared_handles)} handles resolve to more than one ` +
    `entity — the same human stored twice. Handles are masked until you ask; showing the first ${full(Math.min(CAP, handles.rows.length))} ` +
    `of ${full(handles.rows.length)} rows.`));
  idx.appendChild(rowsBox);
  paint();
  root.appendChild(idx);

  const hp = d.handle_predicate;
  if (hp.rows_) {
    root.appendChild(callout(
      'A predicate named like a handle store, holding no handles',
      `nm_handleIdentifier carries ${full(hp.rows_)} rows across ${full(hp.entities)} entities and exactly ` +
      `${full(hp.distinct_values)} distinct value${s(hp.distinct_values)} — ` +
      `${hp.values.map(v => `"${v.value}"`).join(', ')}. It is a field-name marker, not a phone book. ` +
      `The reachable handles are the ${full(handles.phone + handles.mail)} facets above; anything that cites the predicate's ` +
      `row count as a count of dialable values is counting the wrong thing.`,
      'warning'));
  }

  if (reach.available) {
    root.appendChild(figure({
      title: 'Where the handles stop',
      note: `The same handles, tested outward against chat.db, the conversation store on this machine. ` +
            `${full(reach.chat_reached)} of ${full(reach.chat_handles)} conversation handles can be matched back to a person the ` +
            `graph knows. ${full(reach.phone_exact)} phone values match a conversation handle exactly; relaxing the comparison to ` +
            `the last nine digits reaches ${full(reach.phone_by_tail)}, and ${full(reach.mail_exact)} mail address matches. ` +
            `The join key is exact, so the count depends only on which handles the two stores share.`,
      chart: meter({ value: reach.chat_reached, max: reach.chat_handles,
                     label: 'chat.db handles reachable from the graph' }),
      table: tableView(['measurement', 'value'],
        [['graph phone values', full(reach.phone_values)],
         ['graph mail values', full(reach.mail_values)],
         ['handles in chat.db', full(reach.chat_handles)],
         ['phone matches, exact', full(reach.phone_exact)],
         ['phone matches, last nine digits', full(reach.phone_by_tail)],
         ['mail matches, exact', full(reach.mail_exact)]]),
    }));
  } else {
    root.appendChild(figure({
      title: 'Where the handles stop',
      note: 'chat.db is not present in this bundle, so the outward handle join cannot be measured here.',
      chart: h('div', { class: 'empty', text: 'no conversation store on this device' }),
    }));
  }

  /* ---- 8. contact-information rollup ---- */

  root.appendChild(figure({
    title: 'How many reachable handles the graph holds per person',
    note: `${full(rollup.people)} of ${full(fanout.people)} person entities carry contact information at all ` +
          `(${pct(rollup.people, fanout.people)}), across ${full(rollup.phone_facets)} phone and ` +
          `${full(rollup.mail_facets)} mail facets. ` +
          `${full((rollup.histogram.find(b => b.handles === 1) || { people: 0 }).people)} of them are reachable exactly one way.`,
    chart: bars(rollup.histogram.map(b => ({
      label: `${b.handles} handle${s(b.handles)}`, value: b.people, meta: 'person entities',
    })), { labelW: 110 }),
    table: tableView(['handles held', 'people', 'share of people with contact info'],
      rollup.histogram.map(b => [b.handles, full(b.people), pct(b.people, rollup.people)])),
  }));

  const ROLL_CAP = 25;
  const rollCard = h('section', { class: 'card card-wide' });
  rollCard.appendChild(h('header', { class: 'card-head' }, [
    h('h3', { text: 'Contact-information rollup, most reachable first' }),
    h('span', { class: 'muted', text: `top ${full(Math.min(ROLL_CAP, rollup.rows.length))} of ${full(rollup.rows.length)}` }),
  ]));
  rollCard.appendChild(note(
    'One row per person entity that carries any contact information, with the Apple labels unwrapped and the identity ' +
    'namespaces the same entity resolves into. Counts only — open a row to see the values it holds.'));
  const rollTable = tableView(
    ['person', 'phones', 'mails', 'statements', 'labels', 'identity namespaces', ''],
    rollup.rows.slice(0, ROLL_CAP).map(r => [
      r.name || 'unnamed entity', full(r.phone), full(r.mail), full(r.statements),
      r.labels.join(', ') || '—', r.namespaces.join(', ') || 'none', '',
    ]),
  );
  rollCard.appendChild(rollTable);
  rollup.rows.slice(0, ROLL_CAP).forEach((r, i) => {
    const cell = rollTable.querySelector('tbody').children[i].lastElementChild;
    cell.textContent = '';
    cell.appendChild(openable('open', r.id));
  });
  root.appendChild(rollCard);

  /* ---- 9. the attendee footnote ---- */

  root.appendChild(figure({
    title: 'How calendar invitees resolve to other stores',
    note: `${full(fanout.attending)} person entities are invited to at least one event. ` +
          `${full(fanout.attendees_with_identity_ns)} of them also ` +
          `${fanout.attendees_with_identity_ns === 1 ? 'resolves' : 'resolve'} to a person record in another store; ` +
          `the rest are known to the graph by an email handle on a meeting invitation and nothing more. ` +
          `The per-namespace table shows where they land.`,
    chart: meter({ value: fanout.attendees_with_identity_ns, max: fanout.attending,
                   label: 'calendar attendees that also resolve to a person record somewhere else' }),
    table: tableView(['namespace', 'attendees also resolving there', 'all people in that namespace'],
      fanout.attendee_resolution.map(r => [
        r.ns, full(r.people),
        full((fanout.namespace_totals.find(t => t.ns === r.ns) || { people: 0 }).people)])),
  }));

  root.appendChild(figure({
    title: 'How often two identity namespaces meet on one person',
    note: 'Every pair of person-naming namespaces that share at least one entity, and how many entities they share. ' +
          'This is the whole of the cross-directory correlation in this snapshot.',
    chart: bars(fanout.overlap.map(o => ({ label: `${o.a} ∩ ${o.b}`, value: o.people, meta: 'people in both' })),
                { labelW: 200 }),
    table: tableView(['namespace pair', 'people in both'],
      fanout.overlap.map(o => [`${o.a} ∩ ${o.b}`, full(o.people)])),
  }));
}
