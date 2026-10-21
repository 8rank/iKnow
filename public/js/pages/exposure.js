/* exposure.js — the control plane.
 *
 * Every other page in this app asks what the store holds. This one asks who
 * else is holding it: which derived views subscribe to the personal graph,
 * which addresses they name in other subsystems, how many copies of the same
 * facts sit on disk, and which ingestion streams arrive from other devices.
 *
 * Nothing on this page is quoted. Every count, name, path, byte and date comes
 * from /api/exposure, which measures it against the live stores on each
 * request.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, columns, heatmap, stackedBar, hero, legend,
         tableView, full, pct, day, SERIES } from '../viz.js';

export const meta = {
  id: 'exposure',
  nav: 'Who else reads it',
  group: 'The machinery',
  kicker: 'The control plane',
  title: '"It is on my device" is not the same as "only I can see it": this graph is read by a fleet of separate views, copied into other files, and some of the views around it are fed by your other devices',
  blurb: 'The personal graph is the first copy, not the only one. This page maps the derived views that hold a standing ' +
         'subscription on it, the addresses they name in other subsystems, the projection tables that hold the ' +
         'same facts over again, the streams that arrive from your other devices, and the parts that are set up ' +
         'but empty.',
};

/* ---------- local helpers ---------- */

const note = text => h('p', { class: 'card-note', text });
const pill = (text, cls) => h('span', { class: 'pill' + (cls ? ' pill-' + cls : ''), text });
const s = n => (n === 1 ? '' : 's');
const listOf = xs => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : (xs[0] || ''));
const bytes = n => {
  if (!n) return '0 B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
};

/** A card that carries prose and a table but no chart — used where the honest
 *  form of a finding is a list, not a shape. */
function listCard({ title, count, note: text, table, wide }) {
  const card = h('section', { class: 'card' + (wide ? ' card-wide' : '') });
  const head = h('header', { class: 'card-head' }, [h('h3', { text: title })]);
  if (count !== undefined) head.appendChild(h('span', { class: 'muted', text: count }));
  card.appendChild(head);
  if (text) card.appendChild(note(text));
  if (table) card.appendChild(table);
  return card;
}

const GREY = 'var(--text-muted)';

/* Bar lists are capped where a full list would run off the card; every cap is
 * stated on screen, because a silent cap reads as completeness. */
const UNSET_CAP = 16;

/* ---------- the page ---------- */

export async function render(root) {
  const d = await api('exposure');
  const { catalogue, consumers, targets, streams, biome, freshness,
          outputs, projections, cache, stores, side_store: side, unset, context } = d;

  /* ================= 1. the lead ================= */

  const liveSubs = (consumers.by_type.find(t => t.source_type === 'knowledgeGraph') || {}).live || 0;

  root.appendChild(hero({
    value: consumers.kg_views,
    label: 'derived views hold a standing subscription on the personal graph',
    detail:
      `${full(consumers.kg_views)} of the ${full(catalogue.views)} views this platform has instantiated read the personal ` +
      `graph directly, ${full(liveSubs)} of them on a "live" schedule that fires the moment a fact changes. ` +
      `${full(consumers.primary_readers)} views read some primary source — the graph, the shipped world knowledge, or an ` +
      `ingestion stream — ${full(consumers.derived_only)} more are fed only by the output of other views, and ` +
      `${full(consumers.no_listeners)} declare no subscription at all. ` +
      `Each subscription lists the entity classes and fields it watches; some name none and watch everything.`,
  }));

  const tiles = h('div', { class: 'grid' });
  tiles.appendChild(statTile({
    label: 'views instantiated on this device',
    value: catalogue.views,
    sub: `${full(catalogue.shipped)} view configurations ship; ${full(catalogue.shipped_unused)} of them were never ` +
         `instantiated, and ${full(catalogue.compiled_in.length)} live views have no config file in the bundle`,
  }));
  tiles.appendChild(statTile({
    label: 'standing subscriptions',
    value: consumers.listeners,
    sub: `${full(consumers.by_type.reduce((n, t) => n + (t.live || 0), 0))} of them fire live; ` +
         `${full(freshness.totals.states)} subscription states are tracked`,
  }));
  tiles.appendChild(statTile({
    label: 'databases written on this disk',
    value: outputs.local,
    sub: `${bytes(outputs.local_bytes)} of derived copies, across ` +
         `${full(outputs.distinct_tables)} distinct table name${s(outputs.distinct_tables)}`,
  }));
  tiles.appendChild(statTile({
    label: 'target addresses in other subsystems',
    value: targets.databases.length,
    sub: `named by ${full(targets.rows.length)} views; no file for them in the stores iKnow reads`,
  }));
  tiles.appendChild(statTile({
    label: 'views publish deltas onto the stream fabric',
    value: streams.length,
    sub: 'other system processes can subscribe to these changes as they happen',
  }));
  const crossViews = [...new Set(biome.listeners.filter(l => l.cross_device_only > 0)
    .flatMap(l => String(l.view_names || '').split(',')).filter(Boolean))];
  tiles.appendChild(statTile({
    label: 'other devices feeding its views',
    value: biome.devices,
    sub: `${full(biome.cross_streams)} ingestion stream${s(biome.cross_streams)} are polled from other hardware the ` +
         `owner signs in on, across ${full(biome.platforms.length)} declared platform families` +
         (crossViews.length ? `, and read by ${crossViews.join(', ')}` : ''),
  }));
  root.appendChild(tiles);

  /* ================= 2. who subscribes, and on what schedule ================= */

  const mtypes = [...new Set(consumers.matrix.map(r => r.source_type))];
  const mscheds = [...new Set(consumers.matrix.map(r => r.schedule))];
  root.appendChild(figure({
    title: 'Every subscription in the platform, by what it reads and how often',
    wide: true,
    note:
      `${full(consumers.listeners)} listener configurations across ${full(catalogue.views)} views. ` +
      `"knowledgeGraph" is the personal graph itself; "biome" is the live event fabric the device publishes onto; ` +
      `"view" means one derived view feeding another, which is how a fact reaches a consumer that never touched the ` +
      `graph. A schedule of "none" does not mean disabled — it means "recompute when something upstream tells me to". ` +
      `The platform registers ${full(consumers.source_rows)} distinct sources in total.`,
    chart: heatmap(
      consumers.matrix.map(r => ({ row: r.source_type, col: r.schedule, value: r.listeners })),
      mtypes, mscheds, { labelW: 160, unit: 'listeners' }),
    table: tableView(
      ['reads', 'schedule', 'listeners', 'views'],
      consumers.matrix.map(r => [r.source_type, r.schedule, full(r.listeners), full(r.views)])),
  }));

  /* ================= 3. what the subscribers asked for ================= */

  const watched = consumers.predicates.filter(p => p.triples > 0);
  const WATCH_CAP = 18;
  const watchShown = watched.slice(0, WATCH_CAP);
  root.appendChild(figure({
    title: 'What the subscribers actually asked to be told about',
    note:
      `The ${full(consumers.kg_views)} personal-graph subscribers do not read the whole store: each one declares the ` +
      `entity classes and the predicate paths it wants. Pooled, they name ${full(consumers.predicates.length)} distinct ` +
      `predicates. Bars show how many triples the live graph currently holds for each — ` +
      (watched.length > WATCH_CAP ? `the ${full(WATCH_CAP)} largest of the ${full(watched.length)} that carry any data at all. ` : '') +
      `A predicate here is a claim about a person: a name, an address facet, a handle, a photo-cluster binding. ` +
      `Hover a bar for the consumers that subscribe to it.`,
    chart: bars(watchShown.map(p => ({
      label: p.label,
      value: p.triples,
      meta: `${p.predicate} · ${p.n_views} subscribing view${s(p.n_views)}`,
    })), { labelW: 200 }),
    table: tableView(
      ['predicate', 'id', 'triples in the live graph', 'subscribing views', 'which views'],
      consumers.predicates.map(p => [p.label, p.predicate, full(p.triples), full(p.n_views), p.views.join(', ')])),
  }));

  const dark = consumers.predicates.filter(p => p.triples === 0);
  const darkArchived = dark.filter(p => p.archived > 0).length;
  if (dark.length) {
    root.appendChild(figure({
      title: 'Subscribed fields with no rows in the live graph',
      note:
        `${full(dark.length)} of the ${full(consumers.predicates.length)} subscribed fields have no rows in the live ` +
        `graph` +
        (darkArchived ? `; ${full(darkArchived)} of those still have rows in the retraction archive. ` : '. ') +
        `The subscriptions are registered; the facts are not there. Bars show how many views subscribe to each one.`,
      chart: bars(dark.map(p => ({
        label: p.label,
        value: p.n_views,
        color: GREY,
        meta: `${p.predicate} · 0 triples held`,
      })), { labelW: 230, unit: ' views' }),
      table: tableView(
        ['predicate', 'id', 'live rows', 'rows in the archive', 'views subscribing', 'which views'],
        dark.map(p => [p.label, p.predicate, full(p.triples), full(p.archived), full(p.n_views), p.views.join(', ')])),
    }));
  }

  const subs = consumers.watch.listeners;
  const unfiltered = subs.filter(l => l.unfiltered).length;
  root.appendChild(listCard({
    title: 'Every personal-graph subscriber, and the slice it asked for',
    count: `${full(subs.length)} subscriptions`,
    wide: true,
    note:
      `One row per standing subscription on the personal graph. "Stores" says which layers it watches — the person ` +
      `graph, the calendar graph, or both. A subscription that names no class and no predicate is not the narrowest ` +
      `consumer but the widest: it sees everything. ` +
      (unfiltered
        ? `${full(unfiltered)} of these declare${unfiltered === 1 ? 's' : ''} no filter at all.`
        : 'Every one of these declares at least one filter.'),
    table: tableView(
      ['view', 'schedule', 'layers watched', 'entity classes', 'predicate paths', 'restricted to sources'],
      subs.map(l => [
        l.view, l.schedule, (l.stores || []).join(', ') || '—',
        l.classes.map(c => `${c.label} (${c.id})`).join(', ') || 'any',
        l.n_paths ? `${full(l.n_paths)}` : 'any',
        (l.sources || []).join(', ') || '—'])),
  }));

  root.appendChild(listCard({
    title: 'The reified predicate paths those subscriptions name',
    count: `${full(consumers.watch.paths.length)} paths`,
    wide: true,
    note:
      `A slash-separated path walks into a reified statement: the predicate, the statement class it opens, and the ` +
      `facet inside it. Read left to right, these are the exact fields a consumer wants — decoded here against the ` +
      `shipped ontology so they read as English rather than as identifiers.`,
    table: tableView(
      ['path', 'reads as', 'subscribing views'],
      consumers.watch.paths.map(p => [
        p.path,
        p.segments.map(seg => seg.label).join(' › '),
        p.views.join(', ')])),
  }));

  root.appendChild(h('hr', { class: 'rule' }));

  /* ================= 4. the consumer list ================= */

  root.appendChild(figure({
    title: 'Views that name a target in another subsystem',
    note:
      `${full(targets.rows.length)} views declare a target — a "Database.View" address in another subsystem. ` +
      `Grouped by database, that is ${full(targets.databases.length)} addresses, none with a file in the stores iKnow ` +
      `reads. What a target means is not documented: for some views it is where they build an index over another ` +
      `subsystem's stream, so a target does not show that data leaves the graph.`,
    chart: bars(targets.databases.map(t => ({
      label: t.database, value: t.n_views, meta: 'views naming it',
    })), { labelW: 260, unit: ' views' }),
    table: tableView(
      ['view', 'target address', 'artifact type', 'generation', 'also on the stream'],
      targets.rows.map(r => [r.name, r.target, r.artifactType, r.generationType,
                             r.writeToStream ? 'yes' : 'no'])),
  }));

  const streamRows = streams.map(r => ({
    label: r.name,
    value: r.rows_now || 0,
    color: r.local_file ? SERIES(0) : GREY,
    meta: r.local_file ? (r.whole_file ? 'rows across its whole artifact file' : 'rows in its artifact table')
                       : 'no file for it in the stores iKnow reads',
  }));
  root.appendChild(figure({
    title: 'The views that publish deltas onto the stream fabric',
    wide: true,
    note:
      `${full(streams.length)} of the ${full(catalogue.views)} views set writeToStream, which by its name sends their ` +
      `changes to a stream other processes can read. Bars show how much each one holds locally; the greyed bars name ` +
      `an address iKnow has no file for, so their volume cannot be measured here. A publisher is not proof of a subscriber — no subscribing process ` +
      `is identified anywhere in these stores — but the fan-out is declared here rather than inferred.`,
    legend: legend([
      { label: 'writes a file iKnow reads', color: SERIES(0) },
      { label: 'no file in the stores iKnow reads', color: GREY },
    ], 'rect'),
    chart: bars(streamRows, { labelW: 230 }),
    table: tableView(
      ['view', 'artifact type', 'writes into', 'table', 'rows now'],
      streams.map(r => [r.name, r.artifactType, r.artifactPath, r.artifactTable || '—',
                        r.local_file ? full(r.rows_now) : '—'])),
  }));

  /* ================= 5. the device boundary ================= */

  const crossListeners = biome.listeners.filter(l => l.cross_device_only > 0);
  const pollSchedules = [...new Set(crossListeners.map(l => l.schedule))];

  root.appendChild(figure({
    title: 'Biome ingestion — and the streams that arrive from other hardware',
    wide: true,
    note:
      `${full(biome.streams.length)} distinct ingestion streams feed this platform. ` +
      `${full(biome.cross_streams)} of them are registered twice: once locally, and once per paired device, with the ` +
      `device identity carried as a suffix on the source identifier. Counting those suffixes gives ` +
      `${full(biome.devices)} distinct device${s(biome.devices)} paired with this Mac whose activity reaches the views ` +
      `listed below. The graph itself records no device of origin. ` +
      `The cross-device subscriptions declare excludeLocal` +
      (pollSchedules.length ? ` and are polled on the ${pollSchedules.join(' / ')} schedule` : '') +
      `, across ${full(biome.platforms.length)} platform families. The device identifiers are counted here and never ` +
      `rendered: they name the owner's other hardware.`,
    legend: legend([
      { label: 'also arrives from a paired device', color: SERIES(0) },
      { label: 'read locally only', color: GREY },
    ], 'rect'),
    chart: bars(biome.streams.map(r => ({
      label: r.stream,
      value: r.rows_total,
      color: r.cross_device ? SERIES(0) : GREY,
      meta: r.cross_device
        ? `${r.local_rows} local + ${r.remote_rows} from ${r.devices} other device${s(r.devices)}`
        : 'local registrations only',
    })), { labelW: 260, unit: ' registrations' }),
    table: tableView(
      ['stream', 'local registrations', 'from paired hardware', 'devices seen', 'last moved'],
      biome.streams.map(r => [r.stream, full(r.local_rows), full(r.remote_rows),
                              r.devices ? full(r.devices) : '—', day(r.last_modified)])),
  }));

  const platformPills = h('div');
  platformPills.style.margin = '2px 0 12px';
  for (const p of biome.platforms) platformPills.appendChild(pill(p));
  const crossCard = listCard({
    title: 'The cross-device subscriptions, in full',
    count: `${full(crossListeners.length)} listener${s(crossListeners.length)}`,
    note:
      `Each row is a subscription that deliberately skips this machine's own events and reads the same stream from ` +
      `every other device the owner is signed in on. The platform families named in those subscriptions are the ` +
      `hardware classes these views are prepared to ingest from:`,
    table: tableView(
      ['stream', 'schedule', 'views', 'declared platform families'],
      crossListeners.map(l => [l.stream, l.schedule, l.view_names, full(l.device_types)])),
    wide: true,
  });
  crossCard.insertBefore(platformPills, crossCard.lastChild);
  root.appendChild(crossCard);

  root.appendChild(h('hr', { class: 'rule' }));

  /* ================= 6. the physical map ================= */

  const kv = outputs.collisions[0];
  root.appendChild(figure({
    title: 'The physical output map: which table each view writes, into which file',
    wide: true,
    note:
      `${full(outputs.pairs)} (view, table) pairs across ${full(outputs.views_with_tables)} views and ` +
      `${full(outputs.distinct_paths)} declared output paths. ${full(outputs.local)} of those paths resolve to a file ` +
      `in this bundle; ${full(outputs.external)} are addresses in subsystems that were not captured. ` +
      `${full(outputs.views_without_tables)} views declare no table at all — they write through a custom writer ` +
      `instead. Table names are not unique: ` +
      (kv ? `${full(kv.views)} different views all write a table called "${kv.table_name}", so a table name alone ` +
            `identifies nothing — the file path is the key. ` : '') +
      `Bars count the views writing into each path.`,
    legend: legend([
      { label: 'a file in this bundle', color: SERIES(0) },
      { label: 'an address outside it', color: GREY },
    ], 'rect'),
    chart: bars(outputs.files.map(f => ({
      label: f.path,
      value: f.n_views,
      color: f.external ? GREY : SERIES(0),
      meta: f.external ? 'no local file' : `${bytes(f.bytes)} on disk · ${full(f.rows_file)} rows`,
    })), { labelW: 300, unit: ' views' }),
    table: tableView(
      ['view', 'table it writes', 'output path', 'file on this disk'],
      outputs.rows.map(r => [r.view_name, r.table_name, r.path, r.file || 'not in this bundle'])),
  }));

  /* ================= 7. the copies ================= */

  const copySegments = [
    { label: 'the graph itself', value: projections.live_total, color: SERIES(0) },
    { label: "the graph's own full-text index", value: projections.graph_fts_rows, color: SERIES(1) },
    { label: 'projected copies in artifact files', value: projections.total, color: SERIES(2) },
    { label: 'full-text indexes over those copies', value: projections.fts_rows, color: SERIES(3) },
  ];
  const copyTotal = copySegments.reduce((n, c) => n + c.value, 0);

  root.appendChild(figure({
    title: 'How many times the same facts are written down',
    wide: true,
    note:
      `The live graph holds ${full(projections.live_total)} triples — ${full(projections.stable)} in the person layer ` +
      `and ${full(projections.event)} in the calendar layer. It also keeps a full-text index of their object strings. ` +
      `${full(projections.count)} projection tables in the artifact ` +
      `stores then hold ${full(projections.total)} rows of the same shape — ` +
      `${projections.ratio ? projections.ratio.toFixed(2) : '—'}× the live graph — and ` +
      `${full(projections.with_fts)} of those projections carry a further full-text index over the same object text, ` +
      `${full(projections.fts_rows)} rows of it. Each copy is refreshed by its own view on its own schedule.`,
    legend: legend(copySegments.map(c => ({ label: c.label, color: c.color })), 'rect'),
    chart: stackedBar(copySegments),
    table: tableView(
      ['where', 'rows', 'share of every written-down row'],
      copySegments.map(c => [c.label, full(c.value), pct(c.value, copyTotal)])),
  }));

  root.appendChild(figure({
    title: 'The projections, one by one',
    wide: true,
    note:
      `Each of these is a table with the graph's own five reified columns, held in a separate file, written by a ` +
      `separate view. ${full(projections.with_fts)} carry their own *_object_fts index over the same text and are ` +
      `drawn in colour. ` +
      (projections.empty.length
        ? `A further ${full(projections.empty.length)} projection table${s(projections.empty.length)} exist${projections.empty.length === 1 ? 's' : ''} ` +
          `with the same schema and hold nothing on this device.`
        : ''),
    legend: legend([
      { label: 'carries its own full-text index', color: SERIES(0) },
      { label: 'no full-text index', color: GREY },
    ], 'rect'),
    chart: bars(projections.rows.map(r => ({
      label: r.table,
      value: r.rows,
      color: r.fts.length ? SERIES(0) : GREY,
      meta: `${r.subjects} subject${s(r.subjects)} · ${r.file}`,
    })), { labelW: 250 }),
    table: tableView(
      ['projection table', 'file', 'rows', 'subjects', 'full-text index', 'indexed rows'],
      projections.rows.concat(projections.empty).map(r => [
        r.table, r.file, full(r.rows), full(r.subjects),
        r.fts.length ? r.fts.join(', ') : '—', r.fts_rows ? full(r.fts_rows) : '—'])),
  }));

  root.appendChild(h('hr', { class: 'rule' }));

  /* ================= 8. freshness ================= */

  const fired = freshness.totals.fired;
  const never = freshness.totals.never;
  const alwaysRow = freshness.by_type.find(t => t.source_type === 'alwaysUpdate');
  const alwaysNever = alwaysRow ? alwaysRow.never : 0;

  root.appendChild(figure({
    title: 'When each subscription last saw its source move',
    note:
      `${full(fired)} of the ${full(freshness.totals.states)} tracked subscriptions carry a real timestamp, spanning ` +
      `${day((freshness.by_type.reduce((m, t) => (t.oldest && (!m || t.oldest < m) ? t.oldest : m), null)))} to ` +
      `${day(freshness.capture)}. This is the last time the *source* changed, not the last time the view ran — the ` +
      `platform also stores a runByTimestamp, but that is an SLA deadline in the future ` +
      `(${full(freshness.sla.pending)} subscriptions carry one, the furthest reaching ${day(freshness.sla.furthest)}), ` +
      `so it is never plotted here as a run time. Months with no movement are absent from the axis rather than ` +
      `drawn as zero.`,
    chart: columns(freshness.months.map(m => ({ label: m.month, value: m.listeners, sub: 'subscriptions' })),
                   { labelEvery: 1 }),
    table: tableView(['month', 'subscriptions whose source last moved then'],
                     freshness.months.map(m => [m.month, full(m.listeners)])),
  }));

  if (freshness.never.length) root.appendChild(figure({
    title: 'And what has never fired at all',
    note:
      `${full(never)} subscriptions carry a source timestamp of exactly zero. Zero is not null here: it renders as ` +
      `1 January 2001 if you let it, and a freshness chart that does not filter it reports two decades of staleness ` +
      `that never happened. Of those ${full(never)}, ${full(alwaysNever)} sit on "alwaysUpdate" pseudo-sources where a ` +
      `timestamp would be meaningless by design; the remaining ${full(never - alwaysNever)} are on real sources and ` +
      `have genuinely never seen them move. Bars show the ${full(freshness.never.length)} views affected, by how many ` +
      `of their subscriptions are cold.`,
    chart: bars(freshness.never.map(r => ({
      label: r.view_name, value: r.listeners, color: GREY, meta: r.source_types,
    })), { labelW: 250, unit: ' cold' }),
    table: tableView(['view', 'subscriptions never fired', 'on which source types'],
                     freshness.never.map(r => [r.view_name, full(r.listeners), r.source_types])),
  }));

  const recentCross = freshness.recent.filter(r => r.from_paired_device).length;
  root.appendChild(listCard({
    title: 'The most recent movement, as of this snapshot',
    count: `${full(freshness.recent.length)} most recent of ${full(fired)}`,
    wide: true,
    note:
      `Capped at ${full(freshness.recent.length)} rows, most recent first. ` +
      (recentCross
        ? `${full(recentCross)} of them are subscriptions on a stream arriving from a paired device; the device ` +
          `identifier has been stripped from the stream name below — it is counted on this page, never printed. `
        : '') +
      `A knowledgeGraph row with no named source is a subscription to the whole store rather than to one stream.`,
    table: tableView(
      ['view', 'reads', 'source', 'last moved', 'from a paired device'],
      freshness.recent.map(r => [r.view_name, r.source_type, r.source_ref, day(r.ts),
                                 r.from_paired_device ? 'yes' : '—'])),
  }));

  root.appendChild(h('hr', { class: 'rule' }));

  /* ================= 9. the negatives ================= */

  root.appendChild(h('h2', { text: 'The negatives, which are findings and not gaps' }));
  root.appendChild(note(
    'A control plane is as revealing where it is idle as where it is busy. Each panel below states what was measured, ' +
    'the search that produced the negative, and what it would look like if it were not negative.'));

  /* --- 9a. the off-device cache --- */

  const cacheTiles = h('div', { class: 'grid' });
  for (const t of cache.occupancy) {
    cacheTiles.appendChild(statTile({
      label: t.table,
      value: t.rows,
      sub: t.rows
        ? `${full(t.distinct_predicates)} distinct predicates cached`
        : `rows at this snapshot, across ${t.columns.length} declared columns — one of them a time-to-live`,
    }));
  }
  cacheTiles.appendChild(statTile({
    label: 'the service flag tied to it',
    value: cache.service_flag ? 'enabled' : 'not found',
    sub: cache.service_flag
      ? `${cache.service_flag} is in the platform's enabled feature-flag list`
      : 'no enabled flag matches a world-knowledge consumer',
    tone: 'warning',
  }));
  root.appendChild(cacheTiles);

  const cacheZone = cache.zones.find(z => z.zone === 'off-device cache');
  const cacheRows = cache.occupancy.reduce((n, t) => n + (t.rows || 0), 0);
  const cacheEmpty = cacheRows === 0;
  root.appendChild(figure({
    title: 'The off-device query cache: measured occupancy, and the storage forensics behind it',
    wide: true,
    note:
      `globalKnowledge.db holds the world knowledge Apple ships with the device and, by iKnow's reading, a cache for ` +
      `answers fetched from elsewhere: iKnow picks out the cache tables by shape, because their rows carry a ` +
      `time-to-live. ` +
      (cacheEmpty
        ? `They hold no rows now. ` +
          (cacheZone
            ? `dbstat reports ${full(cacheZone.objects)} b-trees behind them, ${bytes(cacheZone.bytes)} and ` +
              `${full(cacheZone.cells)} cells in all, and iKnow finds no data in those cells. `
            : '') +
          `So iKnow finds no cached answers right now. That does not show nothing ever left this device: a ` +
          `time-to-live pruner would leave the same picture.`
        : `They hold ${full(cacheRows)} row${s(cacheRows)} now.`),
    legend: legend(cache.zones.map((z, i) => ({
      label: z.zone, color: z.zone === 'off-device cache' ? SERIES(0) : GREY,
    })), 'rect'),
    chart: bars(cache.zones.map(z => ({
      label: z.zone,
      value: z.bytes,
      color: z.zone === 'off-device cache' ? SERIES(0) : GREY,
      meta: `${full(z.objects)} b-trees · ${full(z.cells)} cells`,
    })), { labelW: 210, valueFmt: bytes }),
    table: tableView(
      ['b-tree', 'zone', 'bytes', 'cells', '4 KiB blocks'],
      cache.forensics.filter(f => f.zone === 'off-device cache')
        .map(f => [f.name, f.zone, bytes(f.bytes), full(f.cells), full(f.page_count)])),
  }));

  if (cache.forensics_error) {
    root.appendChild(note(`Storage forensics unavailable on this build: ${cache.forensics_error}`));
  }

  root.appendChild(listCard({
    title: 'What the device does read from Apple-authored knowledge',
    count: `${full(cache.gk_listeners.length)} subscriptions`,
    note:
      `The world-knowledge side of the same file is not empty: ${full(cache.assets.length)} shipped assets are loaded, ` +
      `and ${full(cache.gk_listeners.length)} views subscribe to them by name. These are Apple's own reference data ` +
      `that ship with macOS: holidays, media entities, and a table of prior confidences.`,
    table: tableView(
      ['asset', 'version', 'triples', 'entities', 'subscribed by'],
      cache.assets.map(a => [a.name, full(a.version), full(a.triples), full(a.entities),
                             cache.gk_listeners.filter(l => l.asset === a.name).map(l => l.view_name).join(', ') || '—'])),
  }));

  /* --- 9b. the empty stores --- */

  if (stores.empty.length) root.appendChild(figure({
    title: 'Stores that exist, carry a full schema, and hold nothing',
    wide: true,
    note:
      `${full(stores.empty.length)} of the ${full(stores.stores.length)} stores in this bundle hold zero data rows — ` +
      `${full(stores.artifacts_empty)} of the ${full(stores.artifacts)} artifact projections among them. They still ` +
      `occupy ${bytes(stores.empty_bytes)} of schema, indexes and migrations. Read this as "no data was captured ` +
      `here", not "no such activity happened". ` +
      `Separately, ${full(stores.rebuild.length)} full-rebuild staging copies take another ` +
      `${bytes(stores.rebuild_bytes)} and hold ${full(stores.rebuild_rows)} rows between them.`,
    chart: bars(stores.empty.map(r => ({
      label: r.store.replace(/^Artifacts__/, '').replace(/\.db$/, ''),
      value: r.bytes,
      color: GREY,
      meta: `${r.tables} table${s(r.tables)}, all empty`,
    })), { labelW: 300, valueFmt: bytes }),
    table: tableView(
      ['store', 'tables', 'rows', 'on disk'],
      stores.empty.map(r => [r.store, full(r.tables), full(r.rows), bytes(r.bytes)])),
  }));

  /* --- 9c. fields that exist and are unset --- */

  const flags = unset.filter(u => u.shape === 'flag, never set');
  const texts = unset.filter(u => u.shape === 'text, empty on every row');
  if (unset.length) root.appendChild(figure({
    title: 'Fields that exist and are unset on every row',
    wide: true,
    note:
      `Swept across every populated artifact table: ${full(unset.length)} columns carry exactly one value on every ` +
      `row, and that value is off — zero, empty, or null. ` +
      (flags.length
        ? `${full(flags.length)} of them are declared BOOLEAN and are never true here, among them ` +
          `${listOf(flags.slice(0, 3).map(u => `${u.table}.${u.column}`))}. `
        : '') +
      (texts.length
        ? `${full(texts.length)} are text columns empty on every row, among them ` +
          `${listOf(texts.slice(0, 3).map(u => `${u.table}.${u.column}`))}. `
        : '') +
      `Bars are sized by how many rows the empty column covers` +
      (unset.length > UNSET_CAP ? `, capped at the ${full(UNSET_CAP)} widest; the table below holds all ${full(unset.length)}.` : '.'),
    chart: bars(unset.slice(0, UNSET_CAP).map(u => ({
      label: `${u.table}.${u.column}`,
      value: u.rows,
      color: u.shape === 'flag, never set' ? SERIES(0) : GREY,
      meta: `${u.shape} · declared ${u.declared}`,
    })), { labelW: 300 }),
    legend: legend([
      { label: 'a declared flag, never true', color: SERIES(0) },
      { label: 'empty, null or zero on every row', color: GREY },
    ], 'rect'),
    table: tableView(
      ['store', 'table', 'column', 'declared as', 'shape', 'rows covered'],
      unset.map(u => [u.store, u.table, u.column, u.declared, u.shape, full(u.rows)])),
  }));

  /* --- 9d. the context machinery --- */

  const citedFeatures = context.rows.reduce((n, r) => n + r.model_features.length, 0);
  if (context.rows.length) root.appendChild(listCard({
    title: 'Machinery that is built, subscribed and still unfed',
    count: `${full(context.rows.length)} empty output table${s(context.rows.length)}`,
    wide: true,
    note:
      `These tables sit inside stores that do hold data, each written by a named, instantiated view with ` +
      `subscriptions — and each holds nothing here. ` +
      (citedFeatures
        ? `The relevance ranker's own explanations in the store name ${full(citedFeatures)} ` +
          `feature${s(citedFeatures)} conditioned on context these tables would supply; with the tables empty, those ` +
          `features have nothing to read on this Mac. `
        : '') +
      `The ${full(context.orphans.length)} further empty tables not listed here belong to no view at all; they sit in ` +
      `${full(context.orphan_stores.length)} stores — ` +
      context.orphan_stores.map(o => `${o.store} (${o.tables})`).join(', ') + '.',
    table: tableView(
      ['empty table', 'written by view', 'its subscriptions', 'of which never fired', 'relevance-model features naming it'],
      context.rows.map(r => [r.table, r.view || '—', full(r.listeners), full(r.listeners_never),
                             r.model_features.join(', ') || '—'])),
  }));

  if (context.supply.length) {
    const fed = context.supply.filter(c => c.rows);
    const starved = context.supply.filter(c => c.table && !c.rows);
    const timeOnly = context.supply.filter(c => !c.table);
    root.appendChild(listCard({
      title: 'Every context the ranker is written to condition on, and whether anything supplies it',
      count: `${full(context.supply.length)} contexts · ${full(context.features.length)} model features`,
      wide: true,
      note:
        `Pulled out of the relevance inferences the store itself holds: each explanation names the features that moved ` +
        `the score, and a feature name carries the context it was conditioned on. ` +
        `${full(timeOnly.length)} of those contexts need no table — they are read off the current time. ` +
        `Of the rest, ${full(fed.length)} ${fed.length === 1 ? 'has' : 'have'} a table with rows in it and ` +
        `${full(starved.length)} ${starved.length === 1 ? 'has' : 'have'} a table that is empty.`,
      table: tableView(
        ['context', 'table that would supply it', 'rows it holds', 'features conditioned on it'],
        context.supply.map(c => [
          c.context,
          c.table || 'none — read off the current time',
          c.table ? full(c.rows) : '—',
          c.features.join(', ')])),
    }));
  }

  /* --- 9e. the side store --- */

  if (side.keys) {
    const photoShape = side.shapes.find(x => /Photos/.test(x.shape));
    root.appendChild(figure({
      title: 'The side store: a key-value bag SQL cannot read, keyed by identifiers that join to other stores',
      wide: true,
      note:
        `The platform keeps ${full(side.keys)} entries across ${full(side.domains.length)} domains in a key-value ` +
        `store whose values are binary property lists — opaque on all ${full(side.opaque_domains)} domains, so no ` +
        `query can filter or aggregate on what they hold. The keys, though, are plain text, and ` +
        `${full(side.joinable)} of them are identifiers rather than labels: ` +
        (photoShape ? `${full(photoShape.keys)} are photo-library local identifiers, ` : '') +
        `and the rest map one of the graph's id spaces onto another. Classified here by shape and counted; not one ` +
        `key is printed, because printing them would republish the join. Bars are sized by keys per domain.`,
      legend: legend(side.shapes.map((x, i) => ({ label: x.shape, color: SERIES(i) })), 'rect'),
      chart: bars(side.domains.map(dn => {
        const i = side.shapes.findIndex(x => x.shape === dn.shape);
        return {
          label: dn.domain,
          value: dn.keys,
          color: SERIES(i < 0 ? 0 : i),
          meta: `${dn.shape} · ${bytes(dn.value_bytes)} of opaque values`,
        };
      }), { labelW: 320, unit: ' keys' }),
      table: tableView(
        ['domain', 'keys', 'what the keys are', 'key length', 'values', 'bytes of value'],
        side.domains.map(dn => [
          dn.domain, full(dn.keys), dn.shape,
          dn.min_key === dn.max_key ? full(dn.min_key) : `${full(dn.min_key)}–${full(dn.max_key)}`,
          dn.opaque_values ? 'binary property lists' : 'plain',
          bytes(dn.value_bytes)])),
    }));
  }

  if (catalogue.control_keys.length) {
    root.appendChild(listCard({
      title: 'Platform keys that look like machine identifiers',
      count: `${full(catalogue.control_keys.length)} control keys`,
      wide: true,
      note:
        `The view registry carries ${full(catalogue.control_keys.length)} platform-level key` +
        `${s(catalogue.control_keys.length)} beside the view configurations. By their names they look like identifiers ` +
        `of this machine and its paired devices, so only their lengths are shown.`,
      table: tableView(['control key', 'bytes'], catalogue.control_keys.map(k => [k.key, full(k.bytes)])),
    }));
  }

  root.appendChild(h('hr', { class: 'rule' }));

  /* ================= 10. what the control plane says about itself ================= */

  root.appendChild(figure({
    title: 'What ships, what is switched on, and what is dark',
    wide: true,
    note:
      `${full(catalogue.shipped)} view configurations ship in the ontology bundle; ${full(catalogue.views)} are ` +
      `instantiated here. ${full(catalogue.instantiated_with_config)} live views have a config file, ` +
      `${full(catalogue.shipped_unused)} shipped configs were never instantiated, and ` +
      `${full(catalogue.compiled_in.length)} live views have no config file in the bundle, so their configuration ` +
      `comes from elsewhere. ` +
      `${full(catalogue.flags_enabled.length)} feature flags are enabled on this device while only ` +
      `${full(catalogue.flags_referenced.length)} are referenced by an instantiated view. ` +
      `On the health side, ${full(catalogue.state.tables_created)} views have created their tables and ` +
      `${full(catalogue.state.bookmarks)} carry a resume bookmark. ` +
      `${full(catalogue.state.error_not_null)} views have a non-NULL error message and ` +
      `${full(catalogue.state.error_non_empty)} have a non-empty one` +
      (catalogue.state.error_non_empty === 0 && catalogue.state.error_not_null > 0
        ? `: every stored error is the empty string, so a plain IS NOT NULL check would count ` +
          `${full(catalogue.state.error_not_null)} failing views that are not failing.`
        : `.`),
    chart: bars(catalogue.flags.map(f => ({
      label: f.key || '(no flag — always on)',
      value: f.views,
      color: f.key && catalogue.flags_enabled.includes(f.key) ? SERIES(0) : GREY,
      meta: `${f.to_stream} of them publish to a stream`,
    })), { labelW: 260, unit: ' views' }),
    legend: legend([
      { label: 'gated by a flag that is enabled here', color: SERIES(0) },
      { label: 'ungated, or gated by a flag not enabled', color: GREY },
    ], 'rect'),
    table: tableView(
      ['feature flag', 'views it gates', 'of which publish to a stream', 'enabled on this device'],
      catalogue.flags.map(f => [f.key || '(none)', full(f.views), full(f.to_stream),
                                f.key ? (catalogue.flags_enabled.includes(f.key) ? 'yes' : 'no') : 'n/a'])),
  }));

  root.appendChild(listCard({
    title: 'The master view catalogue',
    count: `${full(catalogue.views)} views`,
    wide: true,
    note:
      `Every instantiated view, what it generates, where it writes, who it targets, how many sources it listens to and ` +
      `whether it has materialised. This is the whole control plane in one table — the list of things on this machine ` +
      `that have an opinion about the owner's data.`,
    table: tableView(
      ['view', 'generates', 'artifact type', 'writes into', 'table', 'target', 'listeners', 'schedules', 'to stream', 'materialised'],
      catalogue.rows.map(r => [
        r.name, r.generationType, r.artifactType, r.artifactPath, r.artifactTable || '—',
        r.target || '—', full(r.listeners), r.schedules || '—',
        r.writeToStream ? 'yes' : '—', r.tablesCreated ? 'yes' : 'no'])),
  }));
}
