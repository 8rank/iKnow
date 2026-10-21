/* comms.js — the interaction log's communication metadata, and not one message body.
 *
 * Every number on this page is computed from Artifacts__siri__remembers__view.db
 * at request time. Nothing here is written down: not a name, not a count, not a
 * date, not a clock hour.
 */

import { api } from '../app.js';
import {
  h, figure, statTile, bars, columns, lines, heatmap, stackedBar,
  hero, meter, legend, tableView, compact, full, day, month, SERIES,
} from '../viz.js';

export const meta = {
  id: 'comms',
  nav: 'Who you talked to',
  group: 'What it recorded',
  kicker: 'Communication metadata',
  title: 'It keeps a log of who you talked to, when, and on which app — but not what was said',
  blurb: 'No message text is stored in this file. Volume, direction and timing alone rank the people you '
       + 'talk to most, show the hours you go quiet (which might be used to infer when you sleep), and show '
       + 'which app you use with each person.',
};

/* ---------- small local helpers (formatting only, never data) ---------- */

const hourLabel = n => String(n).padStart(2, '0');
const clock = n => hourLabel(n) + ':00';

/** Short weekday name for a 0=Sunday index, from the browser's own calendar. */
const dowLabel = i =>
  new Date(Date.UTC(2017, 0, 1 + i))            // 2017-01-01 was a Sunday
    .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

const shortMonth = ts =>
  new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

const fixed = (n, d = 1) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));
const share = (n, d) => (!d ? '0%' : (100 * n / d).toFixed(n / d < 0.01 ? 2 : 0) + '%');
const mins = n => compact(Math.round(n)) + ' min';

const para = (cls, text) => h('p', { class: cls, text });

function callout({ title, body, tone }) {
  return h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);
}

function sectionRule(text) {
  return h('div', { class: 'rule' }, [h('span', { class: 'muted', text })]);
}

/* ---------------------------------------------------------------- render */

export async function render(root) {
  const d = await api('comms');

  if (!d.present) {
    root.appendChild(h('div', { class: 'empty' }, [
      h('p', { text: 'The interaction store is not part of this bundle, so nothing on this page can be computed.' }),
      h('p', { class: 'mono muted', text: d.store }),
    ]));
    return;
  }

  const t = d.totals;
  const people = d.people;
  const caps = d.caps;
  const tz = d.rhythm.tz;
  const quiet = d.rhythm.quiet;
  const IN = d.direction.incoming_value;
  const OUT = d.direction.outgoing_value;
  const inRow = d.direction.rows.find(r => r.value === IN) || { n: 0 };
  const outRow = d.direction.rows.find(r => r.value === OUT) || { n: 0 };

  /* Which device donated a row, and through which stream, are columns later
   * migrations of the store add; an older macOS's copy lacks them, and the
   * server sends null for a count it could not take rather than a zero. */
  const devices = t.devices;
  const otherDevices = n => `${compact(n)} other device${n === 1 ? '' : 's'}`;
  const streamsKnown = d.donation.streams !== null && d.donation.streams !== undefined;

  /* ---------- the one number ---------- */

  root.appendChild(hero({
    value: t.interactions,
    label: 'interactions recorded over the rolling window, with no message text anywhere in the file',
    detail: `${compact(t.days)} days · ${day(t.first_ts)} to ${day(t.last_ts)} · `
          + `${compact(people.all)} counterparties · ${compact(d.groups.total)} group channels · `
          + `${compact(t.apps)} apps · ${compact(t.links)} entity links`,
  }));

  /* ---------- the tiles ---------- */

  const tiles = h('div', { class: 'grid-tight' });
  tiles.appendChild(statTile({
    label: 'counterparties with a display name',
    value: people.named,
    sub: `of ${compact(people.all)} people the log names at all`,
  }));
  tiles.appendChild(statTile({
    label: 'interactions donated by Siri',
    value: d.donation.siri,
    sub: `of ${compact(d.donation.total)} — ${share(d.donation.siri, d.donation.total)} of a store named for Siri`,
    tone: 'warning',
  }));
  tiles.appendChild(statTile({
    label: 'traffic in apps that are not Apple’s',
    value: share(d.vendor.third_party, t.interactions),
    sub: `${compact(d.vendor.third_party)} interactions across ${compact(d.vendor.third_party_apps)} third-party apps`,
  }));
  tiles.appendChild(statTile({
    label: 'conversations reconstructable',
    value: d.threads.distinct,
    sub: `distinct thread keys over ${compact(d.threads.interactions)} interactions`,
  }));
  tiles.appendChild(statTile({
    label: 'talk time on the voice log',
    value: mins(d.calls.totals.minutes),
    sub: `${compact(d.calls.totals.connected)} connected of ${compact(d.calls.totals.calls)} calls`,
  }));
  tiles.appendChild(statTile({
    label: 'devices donating into this file',
    value: devices === null || devices === undefined ? 'not recorded' : devices,
    sub: [
      streamsKnown ? `${compact(d.donation.streams)} donation streams` : null,
      devices === null || devices === undefined ? 'this macOS’s copy of the store has no device column'
        : devices === 0 ? 'no row names a remote device'
        : `${devices === 1 ? 'another device’s' : 'other devices’'} log, readable on this Mac`,
    ].filter(Boolean).join(' · '),
  }));
  if (quiet) {
    tiles.appendChild(statTile({
      label: `traffic inside the quiet window (${clock(quiet.start)}–${clock(quiet.end)})`,
      value: share(quiet.interactions, d.rhythm.total),
      sub: `${compact(quiet.interactions)} of ${compact(d.rhythm.total)} message and call events, ${tz.name}`,
    }));
  }
  tiles.appendChild(statTile({
    label: 'group channels carrying traffic',
    value: d.groups.total,
    sub: `attached to ${compact(d.groups.traffic)} interactions (${share(d.groups.traffic, t.interactions)} of the log)`,
  }));
  root.appendChild(tiles);

  /* ================================================================== */
  root.appendChild(sectionRule('What one row holds'));

  const keyRows = t.field_keys || [];
  const colList = (t.interaction_columns || []).join(' · ');
  root.appendChild(figure({
    title: 'There is no column for what was said',
    note:
      `Every column on an interaction row: ${colList}. `
    + `The only per-interaction payload is the ‘fields’ blob, and enumerating its keys `
    + `finds ${keyRows.length} of them across the whole corpus — `
    + `${compact(t.fields_empty)} rows carry nothing at all. `
    + `The store does hold ${compact(t.message_entities)} Message entities, and `
    + `${compact(t.message_entities_named)} of them carry a display name.`,
    chart: bars(keyRows.map(r => ({
      label: r.key,
      value: r.n,
      meta: `rows carrying this key · ${full(r.distinct_values)} distinct values · `
          + `longest ${compact(r.max_len)} chars`,
    })), { labelW: 200 }),
    table: tableView(
      ['field key', 'rows carrying it', 'distinct values', 'longest value (chars)'],
      keyRows.map(r => [r.key, full(r.n), full(r.distinct_values), full(r.max_len)])),
  }));

  root.appendChild(figure({
    title: 'What the log resolves each interaction to',
    note: 'Counterparties arrive as typed entities, most of them carrying a resolved display name. '
        + 'A message body is never one of those types.',
    chart: bars(d.entity_types.map(r => ({
      label: r.type,
      value: r.n,
      meta: `${full(r.named)} of ${full(r.n)} carry a display name`,
    })), { labelW: 150 }),
    table: tableView(['entity type', 'entities', 'with a display name'],
      d.entity_types.map(r => [r.type, full(r.n), full(r.named)])),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('Three columns read by measurement, not by enum'));

  /* --- correction 1: direction --- */
  // INInteractionDirection numbers outgoing 1 and incoming 2. Nothing shows the
  // column uses that enum, so it is only a comparison and the sender test decides.
  const enumOrder = IN === 2 && (OUT === 1 || OUT == null) ? 'same'
    : IN === 1 && (OUT === 2 || OUT == null) ? 'reverse' : 'other';
  const dirSegments = d.direction.rows.map((r, i) => ({
    label: r.measured === 'neither'
      ? 'neither (non-communication intents)'
      : `${r.measured} (direction = ${r.value})`,
    value: r.n,
    color: SERIES(i),
  }));
  root.appendChild(figure({
    title: IN == null
      ? 'No direction value carries a sender here, so incoming cannot be told apart'
      : `Direction ${IN} is incoming here` + (
        enumOrder === 'same' ? ', as INInteractionDirection numbers it'
        : enumOrder === 'reverse' ? ' — the reverse of INInteractionDirection’s numbering'
        : ', which is not INInteractionDirection’s numbering'),
    note:
      `Measured, not assumed: an interaction can only carry a ‘sender’ parameter if it came in. `
    + `Direction ${IN} carries one on ${compact(inRow.with_sender)} of its ${compact(inRow.n)} rows, pointing at `
    + `${compact(d.direction.distinct_senders)} distinct people; direction ${OUT} carries one on `
    + `${compact(outRow.with_sender)} rows and instead names recipients on ${compact(outRow.with_recipient)}. `
    + `So direction ${IN} is INCOMING and direction ${OUT} is OUTGOING`
    + (enumOrder === 'same'
      ? `, as INInteractionDirection numbers them. `
      : `. INInteractionDirection numbers them differently, but nothing shows this column uses that `
        + `enum, so it is only a comparison. `)
    + `Every chart on this page is labelled from the measurement.`,
    chart: stackedBar(dirSegments),
    legend: legend(dirSegments.map(s => ({ label: s.label, color: s.color }))),
    table: tableView(
      ['direction value', 'rows', 'rows carrying a sender', 'rows naming recipients', 'measured meaning', 'INInteractionDirection would say'],
      d.direction.rows.map(r => [
        full(r.value), full(r.n), full(r.with_sender), full(r.with_recipient),
        r.measured, r.enum_says])),
  }));

  if (d.direction.neither_types.length) {
    root.appendChild(figure({
      title: 'The third direction value is not communication at all',
      note: `The ${compact(d.direction.neither_types.reduce((s, r) => s + r.n, 0))} rows at `
          + `direction ${d.direction.neither.join(', ')} are device intents, not messages — they are excluded `
          + `from every rhythm and reciprocity chart here. They are also the only part of the store that `
          + `reveals what the owner asked a device to do rather than who they spoke to.`,
      chart: bars(d.direction.neither_types.map(r => ({ label: r.type, value: r.n, meta: 'rows' })),
        { labelW: 210 }),
      table: tableView(['intent type', 'rows'],
        d.direction.neither_types.map(r => [r.type, full(r.n)])),
    }));
  }

  /* --- correction 2: handlingStatus --- */
  const statusRows = d.handling.rows;
  const connected = statusRows.find(r => r.measured === 'connected');
  const connectedAt = statusRows.indexOf(connected);
  root.appendChild(figure({
    title: !connected
      ? 'No call carries a duration here, so the connected status cannot be identified'
      : `Call status ${connected.status} carries the minutes`
        + (connected.enum_says === 'success' ? ''
          : ` — INIntentHandlingStatus would read it as “${connected.enum_says}”`),
    note: connected
      ? `Ranking call statuses by the talk time their rows actually carry puts status `
      + `${connected.status} on top: ${compact(connected.with_duration)} of its ${compact(connected.n)} rows have a `
      + `non-zero duration, holding ${mins(connected.minutes)}.`
      + (connected.enum_says === 'success' ? ''
        : ` Read as INIntentHandlingStatus, the connected calls would be filed as “${connected.enum_says}”; `
        + `nothing shows the store uses that enum, so the minutes decide.`)
      : 'No call rows carry a duration in this snapshot, so the connected status cannot be identified.',
    chart: bars(statusRows.map(r => ({
      label: `${r.domain} · status ${r.status}`,
      value: r.n,
      meta: `${full(r.with_duration)} rows with a duration · ${fixed(r.minutes)} minutes held`,
    })), { labelW: 170, emphasis: connectedAt }),
    table: tableView(
      ['domain', 'status', 'rows', 'rows with a duration', 'minutes held', 'rows with a message entity', 'measured meaning', 'INIntentHandlingStatus would say'],
      d.handling.rows.map(r => [
        r.domain, full(r.status), full(r.n), full(r.with_duration), fixed(r.minutes),
        full(r.with_message_entity), r.measured, r.enum_says])),
  }));

  /* --- correction 3: contentHash --- */
  root.appendChild(figure({
    title: 'contentHash behaves as a thread key here, not a message hash',
    note:
      `${compact(d.threads.interactions)} interactions carry only ${compact(d.threads.distinct)} distinct hash values. `
    + `${compact(d.threads.recurring)} of those values recur and the busiest one covers `
    + `${compact(d.threads.busiest)} interactions on its own, so it cannot be a per-message digest. `
    + `Only ${compact(d.threads.multi_combo)} of the ${compact(d.threads.distinct)} values span more than one `
    + `(app, domain, direction, participant set) combination, so here it behaves as a conversation key. `
    + `Counting hashes as messages would undercount the corpus by `
    + `${share(d.threads.interactions - d.threads.distinct, d.threads.interactions)}.`,
    chart: bars(d.threads.buckets.map(r => ({
      label: r.bucket,
      value: r.interactions,
      meta: `${full(r.threads)} threads carrying ${full(r.interactions)} interactions`,
    })), { labelW: 150 }),
    table: tableView(['thread size', 'threads', 'interactions they carry'],
      d.threads.buckets.map(r => [r.bucket, full(r.threads), full(r.interactions)])),
  }));

  root.appendChild(figure({
    title: `The busiest conversations, by thread key alone (top ${caps.threads} of ${compact(d.threads.distinct)})`,
    note: 'Built entirely from the thread key, the app and the timestamps — no participant list is needed to '
        + 'see the shape of a conversation, how long it has run, and whether the owner leads or follows in it. '
        + 'The key itself is a signed 64-bit integer and is shown truncated.',
    chart: bars(d.threads.top.map(r => ({
      label: `${r.bundle} · ${r.domain || 'other'}`,
      value: r.n,
      meta: `${full(r.incoming)} in · ${full(r.outgoing)} out · ${day(r.first_ts)} to ${day(r.last_ts)}`,
    })), { labelW: 220 }),
    table: tableView(
      ['thread key', 'app', 'domain', 'interactions', 'incoming', 'outgoing', 'first', 'last'],
      d.threads.top.map(r => [
        r.thread.slice(0, 8) + '…', r.bundle, r.domain || '—', full(r.n),
        full(r.incoming), full(r.outgoing), day(r.first_ts), day(r.last_ts)])),
  }));

  /* --- the Siri finding --- */
  root.appendChild(figure({
    title: `${share(d.donation.siri, d.donation.total)} of these interactions are flagged as donated by Siri`,
    note:
      `Only ${compact(d.donation.siri)} of ${compact(d.donation.total)} interactions are flagged as donated by Siri `
    + `(${share(d.donation.siri, d.donation.total)}), and they are `
    + `${d.donation.types.map(x => x.type).join(', ')} rows rather than messages or calls. `
    + `Everything else was handed over by the apps themselves, across `
    + `${compact(d.donation.streams)} donation streams. The file is named for the assistant; the corpus belongs `
    + `to the messengers.`,
    chart: stackedBar([
      { label: 'donated by an app', value: d.donation.total - d.donation.siri, color: SERIES(0) },
      { label: 'donated by Siri', value: d.donation.siri, color: SERIES(1) },
    ]),
    legend: legend([
      { label: 'donated by an app', color: SERIES(0) },
      { label: 'donated by Siri', color: SERIES(1) },
    ]),
    table: tableView(['source', 'interactions', 'share of the corpus'], [
      ['donated by an app', full(d.donation.total - d.donation.siri),
        share(d.donation.total - d.donation.siri, d.donation.total)],
      ['donated by Siri', full(d.donation.siri), share(d.donation.siri, d.donation.total)],
    ]),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('The shape of the year'));

  const step = d.step;
  root.appendChild(figure({
    wide: true,
    title: 'The monthly timeline, and the step in the middle of it',
    note: step
      ? `The largest month-on-month jump in the series lands at ${step.month}: `
      + `${compact(step.prev)} interactions in ${step.prev_month} become ${compact(step.value)}, a rise of `
      + `${compact(step.delta)} (×${fixed(step.ratio)}). `
      + `The next chart shows which apps were donating before and after.`
      : 'The series is too short to identify a step.',
    chart: columns(d.monthly.map(r => ({
      label: shortMonth(r.ts),
      value: r.n,
      sub: `${r.month} · ${full(r.incoming)} in · ${full(r.outgoing)} out · ${full(r.apps)} apps`,
    })), { width: 880, height: 230 }),
    table: tableView(['month', 'interactions', 'incoming', 'outgoing', 'apps'],
      d.monthly.map(r => [r.month, full(r.n), full(r.incoming), full(r.outgoing), full(r.apps)])),
  }));

  if (step) {
    const onsetNames = step.onset_apps.map(a => a.bundle).join(', ');
    const estAt = step.split.find(r => r.month === step.month) || { established: 0 };
    const estBefore = step.split.find(r => r.month === step.prev_month) || { established: 0 };
    const estRatio = estBefore.established ? estAt.established / estBefore.established : null;
    root.appendChild(figure({
      wide: true,
      title: 'The step looks like a capture onset, not a life event',
      note:
        `${compact(step.onset_apps.length)} apps have no record at all before ${step.month}: ${onsetNames}. `
      + `They account for ${compact(step.onset_in_month)} of that month’s ${compact(step.value)} interactions `
      + `(${share(step.onset_in_month, step.value)}). Over the same boundary the apps that were already donating `
      + `went from ${compact(estBefore.established)} to ${compact(estAt.established)} interactions`
      + (estRatio ? ` (×${fixed(estRatio)}, against ×${fixed(step.ratio)} for the series as a whole)` : '')
      + `. A step like this is easy to read as something that changed in the owner’s life. `
      + `Measured, what changed is which apps were donating: the log widened, and the `
      + `earlier months are an undercount rather than a quiet period.`,
      chart: lines([
        {
          label: 'apps already donating before the step',
          color: SERIES(0),
          points: step.split.map(r => ({ x: r.ts, y: r.established })),
        },
        {
          label: 'apps whose record begins at the step',
          color: SERIES(1),
          points: step.split.map(r => ({ x: r.ts, y: r.onset })),
        },
      ], { width: 880, height: 230, xFmt: month }),
      legend: legend([
        { label: 'apps already donating before the step', color: SERIES(0) },
        { label: 'apps whose record begins at the step', color: SERIES(1) },
      ], 'line'),
      table: tableView(['month', 'from established apps', 'from apps that start at the step'],
        step.split.map(r => [r.month, full(r.established), full(r.onset)])),
    }));
  }

  root.appendChild(figure({
    wide: true,
    title: 'Which apps the interactions came from',
    note:
      `${compact(d.vendor.third_party)} of ${compact(t.interactions)} interactions `
    + `(${share(d.vendor.third_party, t.interactions)}) happened in apps whose bundle id is not Apple’s. `
    + `Each app’s first and last appearance is in the table.`,
    chart: bars(d.apps.map(r => ({
      label: r.bundle,
      value: r.n,
      color: r.apple ? SERIES(1) : SERIES(0),
      meta: `${full(r.incoming)} in · ${full(r.outgoing)} out · ${day(r.first_ts)} to ${day(r.last_ts)}`,
    })), { labelW: 210, width: 880 }),
    legend: legend([
      { label: 'third-party app', color: SERIES(0) },
      { label: 'Apple app', color: SERIES(1) },
    ]),
    table: tableView(['app bundle', 'interactions', 'incoming', 'outgoing', 'vendor', 'first seen', 'last seen'],
      d.apps.map(r => [r.bundle, full(r.n), full(r.incoming), full(r.outgoing),
        r.apple ? 'Apple' : 'third party', day(r.first_ts), day(r.last_ts)])),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('The daily rhythm'));

  const dows = Array.from({ length: 7 }, (_, i) => dowLabel(i));
  const hours = Array.from({ length: 24 }, (_, i) => hourLabel(i));
  const heatCells = d.rhythm.cells.map(c => ({
    row: dowLabel(c.dow), col: hourLabel(c.hour), value: c.n,
  }));
  root.appendChild(figure({
    wide: true,
    title: 'Weekday against hour of day — when the log is busy, and when it is quiet',
    note:
      `${compact(d.rhythm.total)} message and call events, placed on a ${dows.length}×${hours.length} grid; `
    + `${compact(d.rhythm.populated)} of ${compact(d.rhythm.possible)} cells are occupied. `
    + `Hours are the host’s local clock (${tz.name}, ${tz.offset}), resolved per timestamp so daylight saving `
    + `is handled rather than smeared. Non-communication intents are excluded.`,
    chart: heatmap(heatCells, dows, hours, { width: 880, cellH: 26, labelW: 60, unit: 'interactions' }),
    table: tableView(['weekday', 'hour', 'interactions', 'incoming', 'outgoing'],
      d.rhythm.cells.map(c => [dowLabel(c.dow), clock(c.hour), full(c.n), full(c.incoming), full(c.outgoing)])),
  }));

  root.appendChild(figure({
    wide: true,
    title: 'The hours the log goes quiet, by iKnow\'s heuristic',
    note: quiet
      ? `Hours carrying less than ${Math.round(caps.quiet_fraction * 100)}% of an even spread form one unbroken `
      + `run of ${compact(quiet.length)} hours, ${clock(quiet.start)} to ${clock(quiet.end)} ${tz.name}. `
      + `${compact(quiet.interactions)} of ${compact(d.rhythm.total)} events fall inside it `
      + `(${share(quiet.interactions, d.rhythm.total)}). The window is derived from the distribution by iKnow, `
      + `not by the store. The log does not say why these hours are quiet, but a run like this might be used `
      + `to infer when you sleep.`
      : 'No contiguous quiet run separates itself from the rest of the day in this snapshot.',
    chart: columns(d.rhythm.hourly.map(r => ({
      label: hourLabel(r.hour),
      value: r.n,
      sub: quiet && quiet.hours.includes(r.hour) ? 'inside the quiet window' : 'outside the quiet window',
    })), { width: 880, height: 200, labelEvery: 2 }),
    table: tableView(['hour (' + tz.name + ')', 'interactions', 'inside the quiet window'],
      d.rhythm.hourly.map(r => [clock(r.hour), full(r.n),
        quiet && quiet.hours.includes(r.hour) ? 'yes' : 'no'])),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('The people'));

  const volNote =
    `Identities are grouped by display name, so one human who appears under more than one identity is counted `
    + `once; ${compact(people.all)} groups remain, ${compact(people.named)} of them named. `
    + (people.owner_rows_removed
        ? `${compact(people.owner_rows_removed)} row(s) matching the graph owner were removed from the ranking. `
        : 'No counterparty in this store resolves to the graph owner, so no self-row had to be removed. ');

  root.appendChild(figure({
    wide: true,
    title: `Ranked correspondents (top ${caps.contacts} of ${compact(people.all)})`,
    note: volNote,
    chart: bars(people.top.map(r => ({
      label: r.label,
      value: r.n,
      meta: `${full(r.incoming)} in · ${full(r.outgoing)} out · ${full(r.apps)} apps · `
          + `${day(r.first_ts)} to ${day(r.last_ts)}`,
    })), { labelW: 210, width: 880 }),
    table: tableView(
      ['counterparty', 'interactions', 'incoming', 'outgoing', 'apps', 'calls', 'talk minutes', 'identities', 'first', 'last'],
      people.top.map(r => [r.label, full(r.n), full(r.incoming), full(r.outgoing), full(r.apps),
        full(r.calls), fixed(r.minutes), full(r.identities), day(r.first_ts), day(r.last_ts)])),
  }));

  const chases = people.reciprocity.filter(r => r.out_share > 0.5).length;
  root.appendChild(figure({
    wide: true,
    title: `Who chases whom (top ${caps.reciprocity} of ${compact(people.real)} with real history)`,
    note:
      `Share of each exchange the owner sent, sorted. Half is the balance point and the two colours split the `
    + `list at it: above it are the relationships the owner drives, below it the ones that arrive unbidden — `
    + `broadcast channels and bots sit at the bottom. `
    + `${compact(chases)} of the ${compact(people.reciprocity.length)} shown lean outbound. `
    + `Only counterparties with at least ${compact(people.real_threshold)} interactions (the median volume) are `
    + `eligible, so a single stray ping cannot look like a one-sided relationship.`,
    chart: bars(people.reciprocity.map(r => ({
      label: r.label,
      value: Math.round(100 * r.out_share),
      color: r.out_share > 0.5 ? SERIES(0) : SERIES(1),
      meta: `${full(r.outgoing)} sent · ${full(r.incoming)} received of ${full(r.n)}`,
    })), { labelW: 210, width: 880, unit: '%', valueFmt: v => String(v) }),
    legend: legend([
      { label: 'the owner sends more than they receive', color: SERIES(0) },
      { label: 'the counterparty sends more', color: SERIES(1) },
    ]),
    table: tableView(['counterparty', 'interactions', 'sent', 'received', 'share the owner sent'],
      people.reciprocity.map(r => [r.label, full(r.n), full(r.outgoing), full(r.incoming),
        share(r.outgoing, r.n)])),
  }));

  if (quiet && people.offhours.length) {
    root.appendChild(figure({
      wide: true,
      title: `Who is contacted inside the quiet window `
           + `(${compact(people.offhours.length)} of ${compact(people.real)} with real history`
           + `${people.offhours.length >= caps.offhours ? `, capped at ${caps.offhours}` : ''})`,
      note:
        `Only ${compact(people.offhours.length)} counterparties are ever contacted between `
      + `${clock(quiet.start)} and ${clock(quiet.end)} ${tz.name} at all — which is what makes the list `
      + `interesting. The bar is the share of that relationship falling inside the hours the corpus itself `
      + `marks as quiet. Off-hours contact is a proxy for intimacy or urgency that no stated relationship `
      + `field in this bundle carries, and it is visible here without a word of content. `
      + `Eligibility is the same median-volume floor of ${compact(people.real_threshold)} interactions.`,
      chart: bars(people.offhours.map(r => ({
        label: r.label,
        value: Math.round(100 * r.quiet_share),
        meta: `${full(r.quiet_n)} of ${full(r.n)} interactions inside the quiet window`,
      })), { labelW: 210, width: 880, unit: '%', valueFmt: v => String(v) }),
      table: tableView(['counterparty', 'interactions', 'inside the quiet window', 'share'],
        people.offhours.map(r => [r.label, full(r.n), full(r.quiet_n), share(r.quiet_n, r.n)])),
    }));
  }

  root.appendChild(figure({
    wide: true,
    title: `Gone quiet (top ${caps.dormant} of ${compact(people.real)} with real history)`,
    note:
      `Days since the last recorded contact, measured against the last timestamp in the corpus `
    + `(${day(t.last_ts)}) rather than against today, so these numbers do not drift. `
    + `The log covers a limited window: a counterparty can look dormant because the relationship ended, or simply `
    + `because their history aged out of the window. The chart cannot tell those apart.`,
    chart: bars(people.dormant.map(r => ({
      label: r.label,
      value: r.days_silent,
      meta: `${full(r.n)} interactions, last on ${day(r.last_ts)}`,
    })), { labelW: 210, width: 880, unit: ' d', valueFmt: v => String(v) }),
    table: tableView(['counterparty', 'lifetime interactions', 'last contact', 'days silent'],
      people.dormant.map(r => [r.label, full(r.n), day(r.last_ts), full(r.days_silent)])),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('Voice'));

  const ct = d.calls.totals;
  const callGrid = h('div', { class: 'grid' });
  callGrid.appendChild(figure({
    title: 'Calls per month',
    note: `${compact(ct.calls)} calls in the window, ${compact(ct.placed)} placed and ${compact(ct.received)} received. `
        + `Direction here uses the measured meaning, not the enum.`,
    chart: columns(d.calls.monthly.map(r => ({
      label: shortMonth(r.ts),
      value: r.calls,
      sub: `${r.month} · ${full(r.placed)} placed · ${full(r.received)} received`,
    })), { height: 200 }),
    table: tableView(['month', 'calls', 'placed', 'received', 'connected', 'minutes'],
      d.calls.monthly.map(r => [r.month, full(r.calls), full(r.placed), full(r.received),
        full(r.connected), fixed(r.minutes)])),
  }));
  callGrid.appendChild(figure({
    title: 'Talk time per month',
    note: `${mins(ct.minutes)} of connected conversation in total, longest single call ${fixed(ct.longest)} minutes, `
        + `mean connected call ${fixed(ct.avg_connected)} minutes. Unconnected attempts carry a zero duration and `
        + `are excluded from the mean, or it collapses.`,
    chart: columns(d.calls.monthly.map(r => ({
      label: shortMonth(r.ts),
      value: r.minutes,
      sub: `${r.month} · ${full(r.connected)} connected calls`,
    })), { height: 200 }),
    table: tableView(['month', 'minutes', 'connected calls', 'calls'],
      d.calls.monthly.map(r => [r.month, fixed(r.minutes), full(r.connected), full(r.calls)])),
  }));
  root.appendChild(callGrid);

  root.appendChild(figure({
    title: 'Connection rate',
    note: `${compact(ct.connected)} of ${compact(ct.calls)} calls carry a non-zero duration `
        + `(${share(ct.connected, ct.calls)}). The remainder were never answered — and an unanswered call is `
        + `still a recorded attempt, with a counterparty, a timestamp and a direction attached.`,
    chart: meter({ value: ct.connected, max: ct.calls, label: 'calls that actually connected' }),
    table: tableView(['measure', 'value'], [
      ['calls', full(ct.calls)],
      ['connected', full(ct.connected)],
      ['never connected', full(ct.calls - ct.connected)],
      ['total minutes', fixed(ct.minutes)],
      ['mean connected call (minutes)', fixed(ct.avg_connected)],
      ['longest call (minutes)', fixed(ct.longest)],
    ]),
  }));

  const topVoice = d.calls.partners[0];

  root.appendChild(figure({
    wide: true,
    title: `Voice contacts, ranked by minutes (${compact(d.calls.partners.length)} people)`,
    note:
      `A far shorter list than the messaging ranking: only ${compact(d.calls.partners.length)} of the `
    + `${compact(people.all)} counterparties in the log are ever spoken to. `
    + (topVoice
        ? `The top line holds ${share(topVoice.minutes, ct.minutes)} of all talk time across `
        + `${compact(topVoice.calls)} calls. `
        : '')
    + `${compact(d.calls.multiparty)} calls name more than one participant and are counted against each of them, `
    + `so these rows sum to slightly more than the ${compact(d.calls.attributed)} calls behind them.`,
    chart: bars(d.calls.partners.map(r => ({
      label: r.label,
      value: r.minutes,
      meta: `${full(r.calls)} calls · ${full(r.calls_in)} received · ${full(r.calls_out)} placed`,
    })), { labelW: 210, width: 880, emphasis: 0, unit: ' min', valueFmt: v => compact(Math.round(v)) }),
    table: tableView(['counterparty', 'calls', 'received', 'placed', 'talk minutes', 'all interactions'],
      d.calls.partners.map(r => [r.label, full(r.calls), full(r.calls_in), full(r.calls_out),
        fixed(r.minutes), full(r.n)])),
  }));

  /* ================================================================== */
  root.appendChild(sectionRule('Group channels'));

  root.appendChild(figure({
    wide: true,
    title: `Group channels by traffic (top ${caps.groups} of ${compact(d.groups.total)})`,
    note:
      `${compact(d.groups.traffic)} interactions name a group channel `
    + `(${share(d.groups.traffic, t.interactions)} of the log).`,
    chart: bars(d.groups.top.map(r => ({
      label: r.name,
      value: r.n,
      meta: `${full(r.incoming)} in · ${full(r.outgoing)} out · ${full(r.apps)} apps · `
          + `${day(r.first_ts)} to ${day(r.last_ts)}`,
    })), { labelW: 230, width: 880 }),
    table: tableView(['channel', 'interactions', 'incoming', 'outgoing', 'apps', 'first', 'last'],
      d.groups.top.map(r => [r.name, full(r.n), full(r.incoming), full(r.outgoing), full(r.apps),
        day(r.first_ts), day(r.last_ts)])),
  }));

  /* ---------- the callout ---------- */

  root.appendChild(callout({
    title: 'The absence of content is not the protection it sounds like',
    body:
      `Filtering this log to one app and one counterparty is a two-column query over `
    + `${compact(t.interactions)} rows, and it returns the fact that a named person and the owner correspond `
    + `privately, repeatedly, on a specific private messenger, with dates and a rhythm. For anyone whose `
    + `associations are the sensitive thing — a source, a clinician, a lawyer, a recruiter — the existence of the `
    + `correspondence is the secret, and this file discloses it in full without holding one word of it.`,
  }));

  /* ---------- what the page cannot show ---------- */

  root.appendChild(figure({
    title: 'What this page deliberately does not claim',
    note: 'Publishing the limits beside the findings is what makes the findings credible.',
    chart: h('div', {}, [
      para('card-note',
        (devices === null || devices === undefined
          ? `This macOS’s copy of the store has no remoteDeviceId column, so it cannot say which device donated `
          + `any of its ${compact(t.interactions)} rows`
          : devices === 0
          ? `None of the ${compact(t.interactions)} rows names a remote device`
          : t.device_rows === t.interactions
          ? `Every one of the ${compact(t.interactions)} rows was donated by ${otherDevices(devices)}`
          : `${compact(t.device_rows)} of the ${compact(t.interactions)} rows name one of `
          + `${otherDevices(devices)}, and the rest name none`)
      + (streamsKnown ? ` across ${compact(d.donation.streams)} streams` : '')
      + `, and only ${compact(t.apps)} app bundles ever appear. Anything the `
      + `owner does on another device, or in an app that never donates, is simply absent: this is the whole of `
      + `what the file saw, not the whole of their communication.`),
      para('card-note',
        `${compact(people.all - people.named)} of ${compact(people.all)} counterparty groups carry no display name `
      + `and appear here as opaque identities; they are still fully rankable by volume and timing.`),
      para('card-note',
        `The window is rolling, not historical: ${day(t.first_ts)} to ${day(t.last_ts)}. A relationship that ended `
      + `before it opened leaves no trace at all, so silence in this store is not evidence of silence in life.`),
      para('card-note',
        `Hours are resolved in the host’s zone (${tz.name}, ${tz.offset}). Read on a machine in another zone, `
      + `every clock statement on this page shifts with it — the underlying timestamps do not.`),
    ]),
  }));
}
