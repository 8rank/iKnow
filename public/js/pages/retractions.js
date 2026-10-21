/* retractions.js — the expired tables, read honestly.
 *
 * The expired tables are easy to read as "the facts you deleted".
 * /api/retractions measures what they hold instead: each expired row is
 * classified against the live layer, and the archive is a short window that a
 * prune truncates.
 *
 * It opens on the archive drawn as a graph (withdrawngraph.js): the withdrawn
 * links, heavy, over the live graph, faint.
 *
 * Every number, name, date and namespace below arrives from the endpoints at
 * request time. Nothing on this page is written into the source.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, lines, heatmap, stackedBar, hero,
         legend, tableView, compact, full, pct, SERIES } from '../viz.js';
import { withdrawnGraph } from '../withdrawngraph.js';

export const meta = {
  id: 'retractions',
  nav: 'The retraction archive',
  group: 'What it recorded',
  kicker: 'Retained retractions',
  title: 'When the graph withdraws a fact, the row is not deleted — it moves to a table with no primary key, until a prune removes it',
  blurb: 'When the graph stops asserting a fact, it moves the row to an expired table, with the confidence and ' +
         'sources it had. Rows stay there until a prune removes them. This page sorts them by what the live graph ' +
         'still holds.',
};

/* ---------- local helpers ---------- */

const note = text => h('p', { class: 'card-note', text });

const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);

/** A plain card that shows a table without the chart/table toggle. */
const tableCard = (title, noteText, table, wide) => {
  const card = h('section', { class: 'card' + (wide ? ' card-wide' : '') });
  card.appendChild(h('header', { class: 'card-head' }, [h('h3', { text: title })]));
  if (noteText) card.appendChild(note(noteText));
  card.appendChild(table);
  return card;
};

const s = n => (n === 1 ? '' : 's');
const rowWord = n => (n === 1 ? 'row' : 'rows');
const ent = n => (n === 1 ? 'entity' : 'entities');

/** Bar labels are SVG text anchored at a fixed gutter: long ones would run off
 *  the left edge. Truncate for the mark only — the table carries the full value. */
const clip = (text, n = 34) => {
  const t = String(text == null ? '' : text);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

/** Second-resolution UTC stamp. The retraction column is a write time. */
const stamp = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—');
const dayOf = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—');

/** Fixed slot order for the four fates: churn first, real loss last. */
const FATE_COLOUR = {
  reasserted: 'var(--text-muted)',   // not a retraction at all: greyed, deliberately
  superseded: SERIES(1),
  withdrawn: SERIES(2),
  vanished: SERIES(0),               // the one that matters gets slot 1
};

/** The graph card, or one line saying why it cannot be drawn. */
function graphSection(wdGot, socialGot) {
  if (wdGot.status !== 'fulfilled' || wdGot.value.available === false) {
    const why = wdGot.status === 'fulfilled' ? 'the graph store is not present'
      : String((wdGot.reason && wdGot.reason.message) || wdGot.reason);
    return tableCard('The withdrawn links, drawn', null,
      h('div', { class: 'empty', text: `They could not be read on this device — ${why}.` }), true);
  }
  const social = socialGot.status === 'fulfilled' && socialGot.value.available !== false
    ? socialGot.value : null;
  const socialWhy = socialGot.status === 'fulfilled'
    ? (social ? null : 'the graph store is not present')
    : String((socialGot.reason && socialGot.reason.message) || socialGot.reason);
  graph = withdrawnGraph(wdGot.value, social, socialWhy);
  return graph.card;
}

/* ---------- the page ---------- */

let graph = null;          // the graph card, destroyed on navigation
let gen = 0;               // render generation; a newer render or unmount() wins

export function unmount() {
  gen++;
  if (graph) {
    graph.destroy();
    graph = null;
  }
}

export async function render(root) {
  const mine = ++gen;
  const [got, wdGot, socialGot] = await Promise.allSettled(
    [api('retractions'), api('retractions/graph'), api('social')]);
  if (mine !== gen) return;                      // the reader has already moved on
  if (got.status !== 'fulfilled') throw got.reason;
  const d = got.value;
  const { window: win, layers, fate, predicates, entities, entity_fate,
          calendar, dated_entities, carried, sameas, core } = d;

  /* ---- 0. the archive, drawn over the live graph ---- */

  root.appendChild(h('div', { class: 'grid' }, [graphSection(wdGot, socialGot)]));

  const layerOf = k => (layers.find(l => l.layer === k) || {}).label || k;
  /** Three predicates appear in both layers; a chart axis must not repeat a label. */
  const predName = p => (predicates.filter(q => q.label === p.label).length > 1
    ? `${p.label} (${layerOf(p.layer)})` : p.label);

  /* ---- 1. the honest headline ---- */

  root.appendChild(hero({
    value: core.row_count,
    label: `of the ${full(win.rows)} retained retraction ${rowWord(win.rows)} describe something that is gone from the live graph`,
    detail: `The other ${full(fate.churn)} share a subject and a field with a live row; ` +
            `${full(fate.totals.reasserted)} of those also have the same value. Those look like rewrites rather than ` +
            `removals. What is gone from the live graph sits on ${full(core.entities)} ${ent(core.entities)}, ` +
            `${core.classes.map(c => `${full(c.entities)} typed ${c.label}`).join(', ')}.`,
  }));

  const tiles = h('div', { class: 'grid' });
  for (const c of fate.classes) {
    const n = fate.totals[c.key] || 0;
    tiles.appendChild(statTile({
      label: c.label,
      value: n,
      sub: n === 0 ? `not one row — ${c.note}` : `${pct(n, win.rows)} of the archive · ${c.note}`,
    }));
  }
  root.appendChild(tiles);

  root.appendChild(callout(
    'How each expired row was sorted',
    `An expired row is not necessarily a fact anyone deleted. Each one was checked against the live graph: ` +
    `${full(fate.totals.reasserted)} have a live row with the same subject, field and value; ` +
    `${full(fate.totals.superseded)} belong to entities that still have the field, with a different value; ` +
    `${full(fate.totals.withdrawn)} belong to entities that are still live but no longer have the field; and ` +
    `${full(fate.totals.vanished)} belong to subjects with no row left in the live graph ` +
    `(${pct(fate.totals.vanished, win.rows)} of the total).`,
    'warning'));

  /* ---- 2. the window ---- */

  const burstTable = tableView(
    ['written at', 'rows', 'entities touched', 'layers'],
    win.bursts.map(b => [stamp(b.unix), full(b.rows), full(b.entities),
                         b.layers.map(layerOf).join(', ')]));

  root.appendChild(tableCard(
    'The archive is a window, not a history',
    `${win.prune_key} in graph_state reads ${stamp(win.prune)}. The earliest surviving retraction was written ` +
    `${full(win.gap_hours)} hours later, at ${stamp(win.first)} — everything retracted before the prune was discarded, and ` +
    `nothing on this page can speak for it. The whole archive spans ${full(win.span_hours)} hours and arrived in exactly ` +
    `${full(win.burst_seconds)} distinct second${s(win.burst_seconds)} of writing: every one of the ${full(win.rows)} rows carries ` +
    `its own sub-second timestamp (${full(win.distinct_row_timestamps)} distinct values), but they collapse into ` +
    `${full(win.burst_seconds)} moment${s(win.burst_seconds)}. The timestamp column records when the graph withdrew the fact, ` +
    `not when the fact stopped being true, so there is no retraction timeline to draw here. ` +
    `For scale: the live stable layer was built from scratch on ${dayOf(win.built)} and has been accumulating ever since.`,
    burstTable));

  /* ---- 3. churn vs loss, in one bar ---- */

  const segs = fate.classes
    .filter(c => (fate.totals[c.key] || 0) > 0)
    .map(c => ({ label: c.label, value: fate.totals[c.key], color: FATE_COLOUR[c.key] }));

  root.appendChild(figure({
    title: 'What "expired" turned out to mean',
    wide: true,
    note: `All ${full(win.rows)} retained rows, classified against the live layer they were withdrawn from. ` +
          fate.classes.map(c => `${c.label}: ${c.note}`).join(' · ') + '.',
    legend: legend(segs.map(x => ({ label: x.label, color: x.color })), 'rect'),
    chart: stackedBar(segs),
    table: tableView(
      ['layer', 'fate', 'rows', 'share of layer', 'entities', 'what it means'],
      fate.rows.map(r => {
        const layer = layers.find(l => l.layer === r.layer) || { rows: 0 };
        return [layerOf(r.layer), r.label, full(r.rows), pct(r.rows, layer.rows),
                full(r.entities), r.note];
      })),
  }));

  /* ---- 4. by layer and predicate ---- */

  root.appendChild(figure({
    title: 'Retained retractions by layer and predicate',
    wide: true,
    note: layers.map(l =>
      `${l.table} holds ${full(l.rows)} ${rowWord(l.rows)} over ${full(l.entities)} ${ent(l.entities)} ` +
      `and ${full(l.predicates)} predicate${s(l.predicates)} (${full(l.statements)} reified statement${s(l.statements)}, ` +
      `${full(l.attributes)} plain attribute${s(l.attributes)}), against ${full(l.live_rows)} live ${rowWord(l.live_rows)}`)
      .join('; ') + '. ' +
      (layers.every(l => !l.has_primary_key)
        ? 'Neither expired table declares a primary key — only indexes. That is the structural proof that withdrawal here ' +
          'is an append: there is no row to overwrite and no uniqueness to violate.'
        : 'At least one expired table declares a primary key.') +
      ' Bars show every predicate in the archive; the table adds the fate split for each.',
    chart: bars(predicates.map(p => ({
      label: clip(predName(p), 30),
      value: p.rows,
      meta: `${layerOf(p.layer)} · ${p.predicate} · ${full(p.entities)} ${ent(p.entities)}`,
    })), { labelW: 190, rowH: 26 }),
    table: tableView(
      ['layer', 'predicate', 'id', 'rows', 'entities', 'statements', 'facets',
       ...fate.classes.map(c => c.label), 'confidence'],
      predicates.map(p => [
        layerOf(p.layer), p.label, p.predicate, full(p.rows), full(p.entities),
        full(p.statements), p.facet_labels.join(', ') || '—',
        ...fate.classes.map(c => full(p[c.key])),
        p.conf_min === p.conf_max ? full(p.conf_min) : `${full(p.conf_min)} – ${full(p.conf_max)}`,
      ])),
  }));

  /* ---- 5. which predicates actually lost something ---- */

  const fateCols = fate.classes.filter(c => predicates.some(p => p[c.key] > 0)).map(c => c.label);
  // Read the split out of the data rather than asserting it in prose.
  const byRows = (a, b) => b.rows - a.rows;
  const pureChurn = predicates.filter(p => p.vanished === 0).sort(byRows);
  const pureLoss = predicates.filter(p => p.vanished === p.rows).sort(byRows);
  const mixed = predicates.filter(p => p.vanished > 0 && p.vanished < p.rows).sort(byRows);
  const heatRows = predicates.map(p => clip(predName(p), 32));
  const cells = [];
  predicates.forEach((p, i) => {
    for (const c of fate.classes) {
      if (fateCols.includes(c.label)) cells.push({ row: heatRows[i], col: c.label, value: p[c.key] });
    }
  });

  root.appendChild(figure({
    title: 'Where the loss is concentrated',
    wide: true,
    note: `The same ${full(predicates.length)} predicates, split by what happened to each row. Sequential shading: darker ` +
          `is more rows. ${full(pureLoss.length)} of the ${full(predicates.length)} predicates ` +
          `are pure loss — every expired row of them belongs to a subject with no live row — ` +
          `${full(mixed.length)} mix churn with loss, and ${full(pureChurn.length)} lost nothing at all. ` +
          (pureLoss.length
            ? `Largest pure loss: ${pureLoss[0].label}, ${full(pureLoss[0].rows)} ${rowWord(pureLoss[0].rows)} on ` +
              `${full(pureLoss[0].entities)} ${ent(pureLoss[0].entities)}. ` : '') +
          (mixed.length
            ? `Largest mixed: ${mixed[0].label}, ${full(mixed[0].rows)} ${rowWord(mixed[0].rows)} of which ` +
              `${full(mixed[0].vanished)} went with their entity.` : ''),
    chart: heatmap(cells, heatRows, fateCols, { labelW: 200, cellH: 20, unit: 'rows' }),
    table: tableView(
      ['predicate', 'layer', ...fateCols, 'total'],
      predicates.map((p, i) => [
        p.label, layerOf(p.layer),
        ...fate.classes.filter(c => fateCols.includes(c.label)).map(c => full(p[c.key])),
        full(p.rows),
      ])),
  }));

  /* ---- 6. the real timeline: when the retracted entries were scheduled ---- */

  if (calendar.length > 1) {
    const months = calendar.map(m => m.month);
    const pts = key => calendar.map((m, i) => ({ x: i, y: m[key] }));
    const series = [
      { label: 'edited — the entry still exists', color: 'var(--text-muted)', points: pts('edited') },
      { label: 'gone — the entry no longer exists', color: SERIES(0), points: pts('gone') },
    ];
    root.appendChild(figure({
      title: 'When the retracted calendar entries were actually scheduled',
      wide: true,
      note: `The retraction timestamps are useless as a timeline — they are ${full(win.burst_seconds)} seconds of writing. ` +
            `This is the other date each retracted entry carries: its own start time, read out of the serialised date object ` +
            `on the withdrawn row. ${full(dated_entities)} of the ${full(entities.length)} entities in the archive carry one, ` +
            `and they span ${months[0]} to ${months[months.length - 1]} — ${full(months.length)} months of calendar, withdrawn ` +
            `in ${full(win.burst_seconds)} write${s(win.burst_seconds)}. The series are the entity's fate, not the row's: ` +
            `an edited entry churned, a gone one was removed.`,
      legend: legend(series.map(x => ({ label: x.label, color: x.color })), 'line'),
      chart: lines(series, { xFmt: x => months[Math.max(0, Math.min(months.length - 1, Math.round(x)))], yFmt: compact }),
      table: tableView(
        ['month the entry was scheduled', 'entries edited', 'entries gone', 'total'],
        calendar.map(m => [m.month, full(m.edited), full(m.gone), full(m.edited + m.gone)])),
    }));
  }

  /* ---- 7. did the entity survive? ---- */

  const survivedColour = 'var(--text-muted)';
  const goneColour = SERIES(0);
  const fateBars = [];
  for (const f of entity_fate) {
    fateBars.push({ label: clip(`${f.label} · edited`, 30), value: f.survived, color: survivedColour,
                    meta: `${full(f.survived_rows)} retracted ${rowWord(f.survived_rows)}` });
    fateBars.push({ label: clip(`${f.label} · gone`, 30), value: f.vanished, color: goneColour,
                    meta: `${full(f.vanished_rows)} retracted ${rowWord(f.vanished_rows)}` });
  }

  root.appendChild(figure({
    title: 'Did the entity survive its own retraction?',
    note: 'Entities touched by a retraction, by whether anything of them is left. ' +
      entity_fate.map(f =>
        `${full(f.entities)} ${f.label}: ${full(f.survived)} still live, ${full(f.vanished)} gone`).join(' · ') + '. ' +
      `The gone ones account for ${full(core.row_count)} ${rowWord(core.row_count)} that no longer appear in the ` +
      `live graph. Some of that information may still be in other stores, such as Calendar.`,
    legend: legend([
      { label: 'entity still live', color: survivedColour },
      { label: 'entity gone from the live graph', color: goneColour },
    ], 'rect'),
    chart: bars(fateBars, { labelW: 210, rowH: 32 }),
    table: tableView(
      ['layer', 'entities in the archive', 'still live', 'gone', 'rows on live entities', 'rows on gone entities'],
      entity_fate.map(f => [f.label, full(f.entities), full(f.survived), full(f.vanished),
                            full(f.survived_rows), full(f.vanished_rows)])),
  }));

  /* ---- 8. what each row still carries ---- */

  const confSummary = carried.confidence_values.map(v => full(v)).join(' and ');
  root.appendChild(figure({
    title: carried.zero_confidence_rows === 0 && carried.empty_provenance_rows === 0
      ? 'Every expired row keeps its confidence and its sources'
      : 'What the expired rows still carry',
    note: `${full(carried.zero_confidence_rows)} of ${full(win.rows)} ${rowWord(win.rows)} had their confidence cleared on ` +
          `retraction and ${full(carried.empty_provenance_rows)} lost their sources; ` +
          `${full(carried.source_records)} distinct source records are still named on these rows. ` +
          `The kept score takes only ${full(carried.confidence_values.length)} values here ` +
          `(${confSummary}), and ${full(carried.mixed_confidence_sources)} of the ${full(carried.sources.length)} ingest ` +
          `sources carr${carried.sources.length === 1 ? 'ies' : 'y'} more than one. The live layers carry ` +
          `${full(carried.live_confidence_values)} distinct values, the highest of them ` +
          `${carried.live_confidence_max.toFixed(2)}. ` +
          `Where an expired row matches a live row, the two confidences differ on ` +
          `${full(carried.confidence_drift_rows)} ${rowWord(carried.confidence_drift_rows)}.`,
    chart: bars(carried.sources.map(x => ({
      label: x.label, value: x.rows,
      meta: `${full(x.entities)} ${ent(x.entities)} · confidence ` +
            carried.cells.filter(c => c.row === x.label).map(c => c.col).join(', '),
    })), { labelW: 190 }),
    table: tableView(
      ['ingest source', 'source bitmask', 'rows', 'entities', 'confidence values retained'],
      carried.sources.map(x => [
        x.label, String(x.mask), full(x.rows), full(x.entities),
        carried.cells.filter(c => c.row === x.label).map(c => `${c.col} (${full(c.value)})`).join(', '),
      ])),
  }));

  /* ---- 9. the retracted identity links ---- */

  const retractedNs = sameas.namespaces.map(n => n.ns);
  const missingNs = sameas.live_namespaces.filter(n => !retractedNs.includes(n.ns));

  root.appendChild(figure({
    title: `The retracted "${sameas.label}" links`,
    wide: true,
    note: `${full(sameas.rows)} withdrawn ${rowWord(sameas.rows)} on ${sameas.predicate} "${sameas.label}", the ` +
          `predicate that binds a graph entity to a record in another store. They cover ${full(sameas.tokens)} distinct ` +
          `record${s(sameas.tokens)} across ${full(sameas.entities)} ${ent(sameas.entities)}. ` +
          `By namespace: ${sameas.namespaces.map(n => `${n.ns}: ${full(n.rows)}`).join(', ')}; ` +
          `${full(sameas.to_entity)} point at another entity in this graph` +
          (missingNs.length
            ? `, and none at ${missingNs.map(n => n.ns).join(', ')}, all of which the live layers do use for this same predicate.`
            : '.') +
          ` Each bar is one record; its height is the number of entities the graph unbound from it in the same write.`,
    chart: bars(sameas.bindings.map(b => ({
      label: clip(b.record || b.token),
      value: b.unbound,
      color: b.vanished === b.unbound ? SERIES(0) : 'var(--text-muted)',
      meta: `${b.ns} · ${full(b.vanished)} of ${full(b.unbound)} gone entirely`,
    })), { labelW: 230, rowH: 26 }),
    legend: legend([
      { label: 'every unbound entity is gone from the live graph', color: SERIES(0) },
      { label: 'at least one unbound entity survives', color: 'var(--text-muted)' },
    ], 'rect'),
    table: tableView(
      ['record the link pointed at', 'namespace', 'what that names', 'entities unbound',
       'of those, gone', 'entity kinds', 'still bound to anything live'],
      sameas.bindings.map(b => [
        b.record || b.token, b.ns, b.ns_note, full(b.unbound), full(b.vanished),
        b.classes.join(', ') || '—', full(b.live_bindings),
      ])),
  }));

  root.appendChild(tableCard(
    'Where "same as" points, live and retracted',
    `The live layers use this predicate across ${full(sameas.live_namespaces.length)} namespaces — contact cards, face ` +
    `clusters, installed apps, calendar records. The retracted set uses ${full(sameas.namespaces.length)}; ` +
    `the table compares them.`,
    tableView(
      ['namespace', 'what it names', 'live rows', 'retracted rows', 'retracted records'],
      sameas.live_namespaces.map(n => {
        const r = sameas.namespaces.find(x => x.ns === n.ns);
        return [n.ns, n.note, full(n.rows), full(r ? r.rows : 0), full(r ? r.tokens : 0)];
      })),
    true));

  /* ---- 10. the core ---- */

  const gone = core.rows;
  root.appendChild(tableCard(
    'The entities that went, and everything still readable about them',
    `${full(core.entities)} ${ent(core.entities)} have no row left in any live layer: ` +
    `${core.classes.map(c => `${full(c.entities)} typed ${c.label}`).join(', ')}. ` +
    `Between them they hold ${full(core.row_count)} ${rowWord(core.row_count)}, of which ${full(core.named)} carry a name or ` +
    `title, ${full(core.attendee_links)} name a participant, ${full(core.descriptions)} hold free text, ` +
    `${full(core.urls)} hold a meeting link and ${full(core.dial_ins)} hold a dial-in number with its passcode. ` +
    `The participant links resolve to ${full(core.people)} distinct people, ${full(core.named_people)} of whom are still ` +
    `named entities in the live graph. Every row in this table is listed — nothing is capped.`,
    tableView(
      ['layer', 'kind', 'name or title', 'scheduled', 'retracted rows', 'predicates',
       'participants', 'descriptions', 'links', 'dial-ins', 'mail handles'],
      gone.map(e => [
        layerOf(e.layer), e.class_label || 'untyped', e.name || 'no name on the withdrawn rows',
        e.month || '—', full(e.rows), full(e.predicates), full(e.attendees),
        full(e.descriptions), full(e.urls), full(e.dial_ins), full(e.mail),
      ])),
    true));

  root.appendChild(callout(
    'What this page will not claim',
    `Withdrawing a fact adds a row to an expired table, and neither expired table has a primary key. That does not ` +
    `mean everything ever deleted is still in this file: ${full(win.gap_hours)} hours before the oldest row left, a ` +
    `prune discarded whatever came before, and ${pct(fate.churn, win.rows)} of what is left shares a subject and a ` +
    `field with a live row. What the graph withdraws is kept, with its confidence and sources, until the next prune. ` +
    `Right now that includes ${full(core.entities)} entities that no longer appear in the live graph.`,
    'warning'));

  root.appendChild(h('p', { class: 'card-note', text:
    `Every figure on this page is computed from ${layers.map(l => l.table).join(' and ')} at request time and checked ` +
    `against ${layers.map(l => l.live_table).join(' and ')} before it is counted.` }));
}
