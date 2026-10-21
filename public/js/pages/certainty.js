/* certainty.js — guessed or given.
 *
 * The store keeps an inferred fact and a copied one in the same table, in the
 * same nine columns, under the same predicate vocabulary. Every number on this
 * page is computed by /api/certainty
 * at request time.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, heatmap, stackedBar, hero, legend,
         tableView, full, pct, SERIES } from '../viz.js';

export const meta = {
  id: 'certainty',
  nav: 'Guessed or given',
  group: 'What it concluded',
  kicker: 'Confidence and provenance',
  title: 'Facts copied into your Mac and facts it inferred sit in the same table, in the same shape',
  blurb: 'Every row carries a confidence score and a source bitmask. This page shows how the score is spread, decodes ' +
         'the bitmask into ingest sources (iKnow\'s decode), and lists what sits at the top score.',
};

/* ---------- local helpers ---------- */

const note = text => h('p', { class: 'card-note', text });

const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);

const s = n => (n === 1 ? '' : 's');
const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** The stored value, exactly as stored. JSON turns 1.0 into 1; the store did not. */
const conf = v => {
  if (v === null || v === undefined) return '—';
  const t = String(v);
  return t.indexOf('.') === -1 && t.indexOf('e') === -1 ? t + '.0' : t;
};

/** pct() rounds sub-1% shares to zero, which reads as "none". Keep one decimal. */
const share = (n, d) => {
  if (!d) return '0%';
  const p = (n / d) * 100;
  if (p > 0 && p < 1) return p.toFixed(1) + '%';
  return Math.round(p) + '%';
};

const listOf = xs => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : (xs[0] || ''));

/* ---------- the page ---------- */

export async function render(root) {
  const d = await api('certainty');
  const { layers, live, hist, bands, certain_by_pred, uncertain_by_pred,
          subject_classes, split, sources, conf_source, duplicates, dossier } = d;

  const byTable = Object.fromEntries(layers.map(l => [l.table, l]));
  if (!live.rows) {
    root.appendChild(h('div', { class: 'empty',
      text: 'The triple store this page reads is not present in this bundle, so there is no confidence column to measure.' }));
    return;
  }
  const liveLayers = layers.filter(l => l.live);
  const archived = layers.filter(l => !l.live);
  const archivedRows = archived.reduce((n, l) => n + l.rows, 0);
  const archivedCertain = archived.reduce((n, l) => n + l.certain, 0);
  const bandShort = Object.fromEntries(bands.spec.map(b => [b.key, b.short]));

  /* ---- 1. the lead ---- */

  const noneCertain = liveLayers.filter(l => l.rows > 0 && l.certain === 0);
  const detail = [
    `${full(live.certain)} live fact${s(live.certain)} (${share(live.certain, live.rows)}) carry the highest score the ` +
    `store uses; the rest sit below it, in the same columns. A lower score does not by itself mean a fact was inferred.`,
  ];
  if (noneCertain.length) {
    detail.push(cap(`${listOf(noneCertain.map(l => l.note))} — ${full(noneCertain.reduce((n, l) => n + l.rows, 0))} of ` +
                `those rows — ${noneCertain.length === 1 ? 'contains' : 'contain'} no certain fact at all.`));
  }
  root.appendChild(hero({
    value: live.uncertain,
    label: `of ${full(live.rows)} live facts are stored below a confidence of 1.0`,
    detail: detail.join(' '),
  }));

  const tiles = h('div', { class: 'grid' });
  tiles.appendChild(statTile({
    label: 'at a confidence of 1.0',
    value: live.certain,
    sub: `${share(live.certain, live.rows)} of the live store`,
  }));
  tiles.appendChild(statTile({
    label: 'below 1.0',
    value: live.uncertain,
    sub: `${share(live.uncertain, live.rows)} of the live store`,
  }));
  tiles.appendChild(statTile({
    label: 'distinct confidence values',
    value: live.values,
    sub: `the whole scale the store actually uses, across ${full(live.rows)} rows`,
  }));
  tiles.appendChild(statTile({
    label: 'predicates found on both sides of the line',
    value: split.rows.length,
    sub: `of ${full(split.predicates)} in ${byTable.stable_graph.note} — with rows at the top score and rows below it`,
    tone: 'warning',
  }));
  tiles.appendChild(statTile({
    label: 'ingest bits seen in the data',
    value: sources.bits.filter(b => (b.live_rows || 0) > 0).length,
    sub: sources.phase_idle.length
      ? `${full(sources.phase_idle.length)} more ingest${s(sources.phase_idle.length)} ran and wrote nothing`
      : 'every registered ingest contributed',
  }));
  root.appendChild(tiles);

  /* ---- 2. the histogram, at true resolution ---- */

  const stable = byTable.stable_graph;
  const sh = hist.stable_graph || [];
  const bulk = sh.filter(r => r.rows / (stable.rows || 1) >= 0.01);
  const tail = sh.filter(r => r.rows / (stable.rows || 1) < 0.01);
  const bulkRows = bulk.reduce((n, r) => n + r.rows, 0);
  const tailRows = tail.reduce((n, r) => n + r.rows, 0);

  root.appendChild(figure({
    title: `Every confidence value in ${stable.note}, at the resolution it is stored`,
    wide: true,
    note: `${full(stable.distinct_values)} distinct values across ${full(stable.rows)} rows. Nothing on this chart is ` +
          `bucketed: one bar is one exact stored number. ${full(bulk.length)} value${s(bulk.length)} carry ` +
          `${full(bulkRows)} rows (${share(bulkRows, stable.rows)}) and the remaining ${full(tail.length)} carry ` +
          `${full(tailRows)} between them, which is why most of this chart is hairlines. A four-bucket summary of the ` +
          `same column would hide how few distinct values the scale really uses.`,
    chart: bars(sh.map(r => ({
      label: conf(r.confidence),
      value: r.rows,
      meta: `${full(r.entities)} entit${r.entities === 1 ? 'y' : 'ies'} · ${full(r.predicates)} predicate${s(r.predicates)}`,
    })), { labelW: 200, rowH: 26 }),
    table: tableView(
      ['confidence', 'rows', 'share of layer', 'plain attributes', 'reified statements', 'predicates', 'entities'],
      sh.map(r => [conf(r.confidence), full(r.rows), share(r.rows, stable.rows), full(r.attributes),
                   full(r.statements), full(r.predicates), full(r.entities)]),
    ),
  }));

  /* ---- 3. the tail, at its own scale, with the measured correction ---- */

  if (tail.length) {
    const threes = tail.filter(r => r.rows === 3);
    const others = tail.filter(r => r.rows !== 3);
    const tailNote =
      `The same rows, on their own scale. The cut is stated rather than eyeballed: every stored value carrying under ` +
      `1% of the layer. The store does not say how these values are produced. ` +
      `If each value came from one statement written as three facets, it would arrive in groups of three. ` +
      `Measured here, ${full(threes.length)} of ${full(tail.length)} value${s(tail.length)} do exactly that` +
      (others.length
        ? `, and ${full(others.length)} do not — ${listOf(others.map(r => `${conf(r.confidence)} carries ${full(r.rows)}`))}.`
        : `, with no exception.`);
    root.appendChild(figure({
      title: 'The thin tail, at its own scale',
      note: tailNote,
      chart: bars(tail.map(r => ({
        label: conf(r.confidence),
        value: r.rows,
        meta: `${full(r.attributes)} plain attribute${s(r.attributes)} · ${full(r.statements)} statement${s(r.statements)}`,
      })), { labelW: 200, rowH: 26 }),
      table: tableView(
        ['confidence', 'rows', 'plain attributes', 'reified statements', 'entities'],
        tail.map(r => [conf(r.confidence), full(r.rows), full(r.attributes), full(r.statements), full(r.entities)]),
      ),
    }));
  }

  /* ---- 4. the split, layer by layer ---- */

  const segs = bands.bands.map((b, i) => ({ label: b.label, value: b.live, color: SERIES(i) }));
  root.appendChild(figure({
    title: 'Certain and uncertain, across the live store',
    note: `These four groups are bands, not stored values — the chart above is the exact distribution. ` +
          cap(`${liveLayers.map(l => `${l.note} holds ${full(l.rows)} row${s(l.rows)} over ${full(l.distinct_values)} ` +
            `distinct value${s(l.distinct_values)}`).join('; ')}. `) +
          (archivedRows
            ? `The ${full(archivedRows)} retracted rows are kept out of these totals; each one still carries the score it ` +
              `had on the day the fact was withdrawn, and ${archivedCertain === 0 ? 'none of them is certain' :
               `${full(archivedCertain)} of them are certain`}.`
            : ''),
    legend: legend(segs.map(x => ({ label: x.label, color: x.color })), 'rect'),
    chart: stackedBar(segs),
    table: tableView(
      ['layer', 'what it holds', 'rows', 'at 1.0', 'below 1.0', 'distinct values', 'lowest', 'highest'],
      layers.map(l => [l.label, l.note, full(l.rows), full(l.certain), full(l.uncertain),
                       full(l.distinct_values), conf(l.min), conf(l.max)]),
    ),
  }));

  root.appendChild(h('hr', { class: 'rule' }));

  /* ---- 5. the dossier: what sorting by confidence gives you ---- */

  root.appendChild(figure({
    title: 'Sort the store by confidence, and this is what the top of the list is made of',
    wide: true,
    note: `${full(dossier.rows)} row${s(dossier.rows)} sit at the store's highest score (${conf(dossier.threshold)}), ` +
          `spread over ${full(dossier.entities)} entit${dossier.entities === 1 ? 'y' : 'ies'} — ` +
          `${full(dossier.people)} of them people, ${full(dossier.named)} of them carrying a name, ` +
          `${full(dossier.reachable)} of them carrying contact information` +
          (dossier.owner_marked ? `, and one of them flagged as the device owner` : '') + `. ` +
          `One ORDER BY on the confidence column produces this list; nothing else is filtered or inferred.`,
    chart: bars(certain_by_pred.map(r => ({
      label: r.label,
      value: r.rows,
      meta: `${full(r.entities)} entit${r.entities === 1 ? 'y' : 'ies'}`,
    })), { labelW: 210 }),
    table: tableView(
      ['predicate', 'what it asserts', 'rows', 'entities', 'rows about a person', 'people'],
      certain_by_pred.map(r => [r.predicate, r.label, full(r.rows), full(r.entities),
                                full(r.person_rows), full(r.person_entities)]),
    ),
  }));

  /* ---- 6. what it is unsure about ---- */

  const CAP = 20;
  const shown = uncertain_by_pred.slice(0, CAP);
  const capped = uncertain_by_pred.length > CAP;
  const biggestClass = subject_classes.slice().sort((a, b) => b.rows - a.rows)[0];
  const classRows = subject_classes.reduce((n, c) => n + c.rows, 0);

  root.appendChild(figure({
    title: 'What your Mac is unsure about, ranked by what it is asserting',
    wide: true,
    note: `${full(stable.uncertain)} row${s(stable.uncertain)} in ${stable.note} sit below the top score, over ` +
          `${full(uncertain_by_pred.length)} predicate${s(uncertain_by_pred.length)}. ` +
          (capped ? `The chart shows the largest ${CAP}; the table lists all ${full(uncertain_by_pred.length)}. ` : '') +
          (biggestClass
            ? `Read this one carefully before being alarmed by it: the subjects carrying these rows are ` +
              `${subject_classes.map(c => `${full(c.rows)} on ${c.label}`).join(', ')}, so the single biggest block of ` +
              `uncertainty in the graph sits on ${biggestClass.label} (${share(biggestClass.rows, classRows)} of it), ` +
              `not on people. The "rows about a person" column is the one that matters, and it is the smaller number.`
            : ''),
    chart: bars(shown.map(r => ({
      label: r.label,
      value: r.rows,
      meta: `${full(r.person_rows)} on a person · ${conf(r.min_conf)} to ${conf(r.max_conf)}`,
    })), { labelW: 210 }),
    table: tableView(
      ['predicate', 'what it asserts', 'rows', 'entities', 'rows about a person', 'people', 'lowest', 'highest', 'distinct values'],
      uncertain_by_pred.map(r => [r.predicate, r.label, full(r.rows), full(r.entities), full(r.person_rows),
                                  full(r.person_entities), conf(r.min_conf), conf(r.max_conf), full(r.distinct_values)]),
    ),
  }));

  /* ---- 7. the same predicate on both sides ---- */

  if (split.rows.length) {
    // heatmap() indexes by row label, so the labels must be unique: two
    // predicates sharing one ontology label would silently merge.
    const seen = new Map();
    for (const r of split.rows) seen.set(r.label, (seen.get(r.label) || 0) + 1);
    const labelOf = Object.fromEntries(split.rows.map(r =>
      [r.predicate, seen.get(r.label) > 1 ? `${r.label} (${r.predicate})` : r.label]));
    const rowNames = split.rows.map(r => labelOf[r.predicate]);
    const colNames = bands.spec.map(b => b.short);
    const cells = split.cells.map(c => ({ row: labelOf[c.predicate], col: bandShort[c.band], value: c.share }));
    root.appendChild(figure({
      title: 'Predicates with rows on both sides of the line',
      wide: true,
      note: `${full(split.rows.length)} predicate${s(split.rows.length)} in ${stable.note} appear at the top score AND ` +
            `below it, on different rows (the table's key keeps any one claim to a single row). ` +
            `${full(split.one_side_only)} of the layer's ${full(split.predicates)} predicates stay on one side. ` +
            `Cells show the share of each predicate's rows in each band; the table gives the counts. The confidence alone ` +
            `does not say whether a given "same as" or "name" row was copied or concluded.`,
      chart: heatmap(cells, rowNames, colNames, { labelW: 200, cellH: 26, unit: "% of this predicate's rows" }),
      table: tableView(
        ['predicate', 'what it asserts', 'at 1.0', 'below 1.0', 'entities', 'distinct values'],
        split.rows.map(r => [r.predicate, r.label, full(r.certain), full(r.uncertain),
                             full(r.entities), full(r.distinct_values)]),
      ),
    }));
  }

  root.appendChild(h('hr', { class: 'rule' }));

  /* ---- 8. the provenance decode ---- */

  const dup = duplicates;

  const undercount = sources.bits.reduce((n, b) => n + b.undercount, 0);
  const multiBitRows = sources.values.filter(v => v.bits > 1).reduce((n, v) => n + v.rows, 0);
  const worstBit = sources.bits.slice().sort((a, b) => b.undercount - a.undercount)[0];

  root.appendChild(figure({
    title: 'Where each fact came from, decoded out of the bitmask',
    wide: true,
    note: `The ${sources.bits.length} ingest source${s(sources.bits.length)} that wrote this store, recovered from the ` +
          `\`sources\` column. That column is a bitmask, not an id: ${full(sources.multi_bit_values)} of the ` +
          `${full(sources.values.length)} distinct values observed set more than one bit, because several ingests asserted ` +
          `the same fact. ${full(multiBitRows)} live rows are like that, and a GROUP BY on the raw column files every one ` +
          `of them under a combination number that names no ingest at all — so they drop out of every ingest total at ` +
          `once, ${full(undercount)} attributions lost` +
          (worstBit ? `, ${full(worstBit.undercount)} of them from ${worstBit.name} alone` : '') + `. ` +
          `The bars below test bits instead, so a fact asserted by several ingests is counted once under each of them and ` +
          `the bars deliberately sum past the ${full(live.rows)} live rows. ` +
          (sources.unnamed_bits.length
            ? `${full(sources.unnamed_bits.length)} bit${s(sources.unnamed_bits.length)} in use cannot be named. `
            : `No bit in use is left unnamed, and ${full(sources.zero_mask_rows)} rows set no bit at all. `) +
          `This decode is derived, not documented — no shipped Apple resource in this bundle names these bits.`,
    chart: bars(sources.bits.map(b => ({
      label: b.name,
      value: b.live_rows,
      meta: `${full(b.entities)} entit${b.entities === 1 ? 'y' : 'ies'} · bit ${b.bit}`,
    })), { labelW: 200 }),
    table: tableView(
      ['ingest source', 'bit', 'mask', 'ingest id', ...layers.map(l => l.label),
       'entities', 'a raw GROUP BY would say', 'rows it would miss'],
      sources.bits.map(b => [b.name, b.bit, b.mask, b.phase_source, ...layers.map(l => full(b[l.table])),
                             full(b.entities), full(b.naive_rows), full(b.undercount)]),
    ),
  }));

  const proof = dup.proof || [];
  const exclusive = proof.filter(p => p.exclusive);
  const agreeing = proof.filter(p => p.agrees);
  if (proof.length) {
    root.appendChild(figure({
      title: 'The decode, re-derived on this machine rather than taken on trust',
      wide: true,
      note: `No resource shipped in this bundle names the bits, so the mapping above has to be earned. Two independent ` +
            `tests, both run against this store just now. First: on every row that sets exactly one bit, look at which ` +
            `provenance namespace the row cites — if a bit is one ingest, it should always be the same one. ` +
            `${full(exclusive.length)} of ${full(proof.length)} bits cite exactly one namespace and nothing else. ` +
            `Second: count every row carrying that namespace anywhere in the store and compare it to every row with that ` +
            `bit set — ${full(agreeing.length)} of ${full(proof.length)} match exactly.`,
      chart: bars(proof.map(p => ({
        label: p.name,
        value: p.single_bit_rows,
        meta: `cites ${p.namespace || 'nothing'} · ${full(p.namespaces)} namespace${s(p.namespaces)} seen`,
      })), { labelW: 200 }),
      table: tableView(
        ['ingest source', 'bit', 'provenance namespace it cites', 'namespaces seen on single-bit rows',
         'single-bit rows', 'rows with that namespace', 'rows with that bit', 'counts agree'],
        proof.map(p => [p.name, p.bit, p.namespace || '—', full(p.namespaces), full(p.single_bit_rows),
                        full(p.namespace_rows), full(p.bit_rows), p.agrees ? 'yes' : 'no']),
      ),
    }));
  }

  if (sources.phase_idle.length) {
    root.appendChild(figure({
      title: 'Ingests that ran and contributed nothing',
      note: `${full(sources.phase_total)} ingest source${s(sources.phase_total)} are registered in the build-status ` +
            `table and ${full(sources.bits.filter(b => (b.live_rows || 0) > 0).length)} bits appear in the data. The other ` +
            `${full(sources.phase_idle.length)} completed with no triple on this device. ` +
            (sources.phase_statuses.length === 1
              ? `Every registered ingest reports the same terminal status (${String(sources.phase_statuses[0])}), so this snapshot cannot tell you what other status `
              : `The registered ingests report ${full(sources.phase_statuses.length)} terminal statuses (${sources.phase_statuses.map(String).join(', ')}); this snapshot cannot tell you what each status `) +
            `values would mean.`,
      chart: tableView(
        ['ingest id', 'implied bitmask', 'reported status', ...liveLayers.map(l => l.note)],
        sources.phase_idle.map(r => [r.source, r.mask, r.status,
                                     ...liveLayers.map(l => full(l.table === 'stable_graph' ? r.stable_rows : r.event_rows))]),
      ),
    }));
  }

  /* ---- 9. confidence is a property of the ingest ---- */

  const srcCells = conf_source.cells.map(c => ({ row: c.source, col: bandShort[c.band], value: c.share }));
  const oneValue = sources.bits.filter(b => b.distinct_confidences === 1);
  const concentrated = sources.bits.filter(b => b.modal_rows / (b.live_rows || 1) >= 0.95);

  root.appendChild(figure({
    title: `${full(concentrated.length)} of ${full(sources.bits.length)} ingests put at least 95% of their rows on a single confidence value`,
    wide: true,
    note: `Each row is one ingest; each cell is the share of that ingest's live output landing in that band. ` +
          `${full(concentrated.length)} of the ${full(sources.bits.length)} ingests put at least 95% of ` +
          `their rows on a single value ` +
          `(${concentrated.map(b => `${b.name} at ${conf(b.modal_confidence)}`).join(', ')})` +
          (oneValue.length ? ` — ${listOf(oneValue.map(b => b.name))} never reach${oneValue.length === 1 ? 'es' : ''} for ` +
            `a second value at all` : '') +
          `. Taking each confidence value and guessing the ingest that wrote most of its rows places ` +
          `${full(conf_source.rule_hits)} of ${full(conf_source.rule_rows)} live rows ` +
          `(${share(conf_source.rule_hits, conf_source.rule_rows)}) correctly` +
          (conf_source.deterministic_layers.length
            ? `, and in ${full(conf_source.deterministic_layers.length)} of the ${full(layers.length)} layers — ` +
              `${listOf(conf_source.deterministic_layers.map(l => l.note || l.label))} — the mapping is exact: ` +
              `${full(conf_source.deterministic_layers.reduce((n, l) => n + l.rows, 0))} rows in which no confidence value ` +
              `is ever shared by two ingests.`
            : `.`) +
          ` So the number is a good proxy for WHERE a fact entered the graph and a poor one for how likely it is to be true.`,
    chart: heatmap(srcCells, conf_source.sources, bands.spec.map(b => b.short),
                   { labelW: 200, cellH: 26, unit: "% of this ingest's live rows" }),
    table: tableView(
      ['confidence value', 'live rows', 'ingest on most of them', 'rows with that ingest', 'share'],
      conf_source.dominant.map(r => [conf(r.confidence), full(r.rows), r.source || '—',
                                     full(r.source_rows), share(r.source_rows, r.rows)]),
    ),
  }));

  /* ---- 10. the record-level provenance census ---- */

  const literal = Object.values(dup.literal_attributed).reduce((n, v) => n + v, 0);
  const biggestCell = dup.refs_per_cell.slice().sort((a, b) => b.refs - a.refs)[0];

  root.appendChild(figure({
    title: dup.totals.empty === 0
      ? 'Below the bitmask, every row names the record it came out of'
      : `Below the bitmask, ${full(dup.totals.rows - dup.totals.empty)} of ${full(dup.totals.rows)} rows name the record they came out of`,
    wide: true,
    note: `\`sourceDuplicates\` is the finer-grained provenance column. It is present on all ` +
          `${full(dup.totals.rows)} rows in every layer, and ${full(dup.totals.empty)} of them are empty. Each cell holds one or more ` +
          `typed, namespaced references across ${full(dup.provenance_namespaces)} namespace${s(dup.provenance_namespaces)}, ` +
          `joined by an ASCII record separator (0x1E), not a comma, a semicolon or a pipe: split on the wrong character and ` +
          `you read this store's widest cell — ${full(dup.totals.max_chars)} characters of it — as a single reference. ` +
          `${full(dup.totals.multi)} rows name more than one source ` +
          `record, and the widest cell alone holds ` +
          `${full(biggestCell ? biggestCell.refs : 0)} references.`,
    chart: bars(dup.rows.map(r => ({
      label: r.ns,
      value: r.rows,
      meta: `${full(r.records)} distinct source record${s(r.records)} · ${r.kind}`,
    })), { labelW: 170 }),
    table: tableView(
      ['namespace', 'what it names', 'rows', 'distinct source records', 'entities', 'in multi-record cells',
       ...layers.map(l => l.label)],
      dup.rows.map(r => [r.ns, r.note, full(r.rows), full(r.records), full(r.entities), full(r.multi_rows),
                         ...layers.map(l => full(r.layers[l.table] || 0))]),
    ),
  }));

  root.appendChild(figure({
    title: 'How many source records one fact is allowed to cite',
    note: `The distribution of references per cell. Rows further right cite more source records for the same row.`,
    chart: bars(dup.refs_per_cell.slice().sort((a, b) => a.refs - b.refs).map(r => ({
      label: `${full(r.refs)} record${s(r.refs)}`,
      value: r.rows,
    })), { labelW: 130, rowH: 24 }),
    table: tableView(
      ['source records cited', 'rows'],
      dup.refs_per_cell.slice().sort((a, b) => a.refs - b.refs).map(r => [full(r.refs), full(r.rows)]),
    ),
  }));

  root.appendChild(callout(
    '`sourceDuplicates` adds attribution, not join targets',
    `\`sourceDuplicates\` looks like a second join surface into Contacts, one that could reference contact records ` +
    `appearing nowhere else. Measured across all ${full(dup.totals.rows)} rows and all ` +
    `${full(dup.provenance_namespaces)} provenance namespaces, it is not one here: ${full(dup.only_in_provenance)} ` +
    `references exist in the provenance column that are not also present in the object column, in either direction. The ` +
    `column adds no new join targets. What it does add is attribution: ${full(literal)} live rows whose value is a plain ` +
    `literal — a name, a date, a handle, a description — still name the exact source record they were lifted from, so a ` +
    `reader can walk any of them back to a contact card, a photo cluster or a calendar entry without the value itself ` +
    `containing a reference.`,
    'warning'));

  /* ---- 11. the missing column ---- */

  root.appendChild(callout(
    'What the row does not have',
    `The whole row is ${listOf(dossier.derivation_columns)} — ${full(dossier.derivation_columns.length)} columns, and not ` +
    `one of them records derivation. \`sources\` names which ingest handed the fact over, which is the closest thing to an ` +
    `answer available, but an ingest is not a provenance: a face cluster arriving from Photos is already a machine ` +
    `conclusion, and a name arriving from Contacts may have been typed by someone else entirely. No column on the row ` +
    `records whether anyone confirmed it.`));
}
