/* calendar.js — the forward-looking layer.
 *
 * Every other page in this app describes something that already happened. This
 * one describes appointments the owner had not kept yet when the copy was made:
 * a date, an hour, a room, a list of people, a dial-in bridge. That is what
 * makes the calendar layer different in kind from the rest of the graph, and it
 * is what the page leads with.
 *
 * Four things this page is careful about, because the store punishes each one:
 *
 *   1. the layer is TWO populations fed by two ingests that share no event at
 *      all — one carries the people, the other carries the prose. Every panel
 *      says which side it is standing on, and the emptiness of the overlap is
 *      measured rather than asserted;
 *   2. "descriptions are N% of all text" is not a fact until the denominator is
 *      named, so three denominators are drawn and the share is given under each;
 *   3. the `tel:` values here are conference bridges, not anybody's phone, and
 *      the page proves it against every phone handle in the bundle rather than
 *      simply saying so;
 *   4. no description text is rendered anywhere. This prose was mostly typed by
 *      other people about meetings their attendees never agreed to have stored
 *      here; the page measures it and leaves it closed.
 *
 * Nothing on this page is written in this file. Dates, names, titles, domains,
 * venues, counts and shares all arrive from /api/calendar at render time.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, columns, lines, stackedBar, hero, legend,
         tableView, compact, full, SERIES } from '../viz.js';

export const meta = {
  id: 'calendar',
  nav: 'The calendar',
  group: 'What it recorded',
  kicker: 'The forward-looking layer',
  title: 'Your graph holds your meetings, including the ones still ahead: when, where, and who is invited',
  blurb: 'For each meeting it keeps the time, the place, the people invited and the dial-in number. Many of those meetings include other people, who may not know this is kept.',
};

/* ---------- presentation helpers (no values, only shapes) ---------- */

const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);

const grid = kids => h('div', { class: 'grid' }, kids.filter(Boolean));
const tight = kids => h('div', { class: 'grid-tight' }, kids.filter(Boolean));

/** 'YYYY-MM-DD' -> '11 Sep', formatted by the browser, never by a table here. */
const dayLabel = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

const trim = v => v.toFixed(1).replace(/\.0$/, '');

/** Minutes -> a duration a human reads without doing arithmetic. */
const dur = m => {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const hrs = m / 60;
  if (hrs < 24) return `${trim(hrs)} h`;
  const days = hrs / 24;
  return `${trim(days)} d`;
};

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const share = (part, whole) => (whole ? (part / whole) * 100 : 0);
const share1 = (part, whole) => share(part, whole).toFixed(1) + '%';

/** Top-N with an explicit "other" row. One measure, one colour; the tail greys. */
function topWithOther(rows, n, valueOf, labelOf) {
  const head = rows.slice(0, n).map((r, i) => ({ label: labelOf(r, i), value: valueOf(r) }));
  const rest = rows.slice(n);
  if (rest.length) {
    head.push({
      label: `other (${rest.length})`,
      value: rest.reduce((s, r) => s + valueOf(r), 0),
      color: 'var(--text-muted)',
    });
  }
  return head;
}

/* ---------- the page ---------- */

export async function render(root) {
  const d = await api('calendar');

  // Rule five: an absent or empty store is a finding, not a stack trace.
  if (!d.capture || !d.events || !d.events.date_facets) {
    root.appendChild(h('div', { class: 'empty',
      text: 'This device\u2019s graph holds no calendar layer: no event carries a start time, so there '
          + 'is nothing forward-looking here to measure.' }));
    return;
  }

  const pops = d.populations || [];
  const popColour = new Map(pops.map((p, i) => [p.label, SERIES(i)]));
  // A DOM node has one parent: every card that needs this legend gets its own.
  const popLegend = () => legend(pops.map(p => ({ label: p.label, color: popColour.get(p.label) })));

  const text = d.text;
  const desc = text.description || {};
  const den = new Map((text.denominators || []).map(x => [x.key, x.chars]));
  const denAll = den.get('all') || 0;
  const denRefs = den.get('minus_refs') || 0;
  const denLit = den.get('literals') || 0;

  const auth = d.authorship.split;
  const att = d.attendance;
  const src = d.source_store || {};
  const cap = d.cap;

  /* ---------- 1. the lead: what had not happened yet ---------- */

  root.appendChild(hero({
    value: d.forward.event_dates,
    label: 'appointments in this copy that had not happened yet when it was taken',
    detail: `${d.forward.events} distinct events across ${d.forward.days} days, running out to `
          + `${d.forward.last}, naming ${d.forward.people} people besides the owner. The line is the `
          + `store's own last write, ${d.capture.iso} UTC; the nearest event-date sits `
          + `${d.forward.nearest_margin_hours} h from it, so no timezone reconciliation moves anything across it.`,
  }));

  root.appendChild(tight([
    statTile({
      label: 'characters of meeting prose',
      value: desc.chars,
      sub: `${desc.rows_} descriptions · ${share1(desc.chars, denLit)} of the graph's readable text, `
         + `${share1(desc.chars, denAll)} of every object it stores`,
    }),
    statTile({
      label: 'events carrying a way to join',
      value: d.links.events,
      sub: `${d.links.rows} links in total · ${d.links.dial_in_distinct} distinct dial-in bridges `
         + `across ${d.links.prefixes.length} country codes`,
    }),
    statTile({
      label: 'people named on these invitations',
      value: att.people.length,
      sub: `${att.statements} invitation statements over ${att.events_with_attendees} events, the `
         + `owner excluded from the count; ${att.organisers.length} people ever organise one`,
    }),
    statTile({
      label: 'events with a booking type',
      value: d.travel.reservation_events,
      sub: `${d.travel.types.length} kinds, including ${d.travel.legs.length} flight legs with carrier, `
         + `number and both airports`,
      tone: 'warning',
    }),
  ]));

  /* ---------- 2. the forward timetable ---------- */

  const fwd = d.forward.rows;
  root.appendChild(figure({
    wide: true,
    title: 'Everything still ahead, hour by hour',
    note: `One row per scheduled occurrence, so a weekly meeting appears once per week. `
        + `Bar length is the number of people on the invitation; `
        + `${fwd.filter(r => !r.attendees).length} of the ${fwd.length} carry no attendee list at all and `
        + `draw as nothing. ${d.forward.with_links} carry a join link or dial-in. Times are the local `
        + `wall clock the store recorded; every date facet in this layer carries the same timezone `
        + `(${(d.events.timezones[0] || {}).tz || 'none recorded'}). `
        + `Hover a bar for its title, or open the table for the attendee list.`,
    chart: bars(fwd.map(r => ({
      label: `${r.weekday} ${dayLabel(r.date)} · ${r.time || 'all day'}`,
      value: r.attendees,
      meta: clip(r.title, 60),
    })), { width: 1100, labelW: 190, rowH: 26, unit: ' people' }),
    table: tableView(
      ['date', 'day', 'time', 'runs for', 'attendees', 'expected in the room', 'join links', 'title', 'from'],
      fwd.map(r => [r.date, r.weekday, r.time || 'all day', dur(r.minutes), r.attendees,
                    r.who.join(', ') || '—', r.conference_links, r.title, r.population])),
  }));

  /* ---------- 3. the clock ---------- */

  const hours = d.clock.hours;
  const peakHour = hours.reduce((a, b) => (b.event_dates > a.event_dates ? b : a), hours[0]);
  const wds = d.clock.weekdays;
  const peakDay = wds.reduce((a, b) => (b.event_dates > a.event_dates ? b : a), wds[0]);
  const durRows = d.clock.durations;

  root.appendChild(grid([
    figure({
      title: 'The hours somebody could count on',
      note: `All ${d.events.date_facets - d.events.all_day} timed occurrences in the layer, over `
          + `${d.events.span.first} to ${d.events.span.last}. The ${d.events.all_day} all-day entries are `
          + `excluded rather than filed under midnight. The busiest hour is `
          + `${String(peakHour.hour).padStart(2, '0')}:00 with ${peakHour.event_dates}.`,
      chart: columns(hours.map(r => ({
        label: String(r.hour).padStart(2, '0'), value: r.event_dates, sub: 'occurrences',
      })), { labelEvery: 3 }),
      table: tableView(['hour', 'occurrences'],
        hours.map(r => [String(r.hour).padStart(2, '0') + ':00', r.event_dates])),
    }),
    figure({
      title: 'The days',
      note: `${peakDay.label} carries ${peakDay.event_dates} of ${d.events.date_facets} occurrences. `
          + `Weekends hold `
          + `${wds.filter(r => r.index >= 5).reduce((s, r) => s + r.event_dates, 0)}.`,
      chart: columns(wds.map(r => ({ label: r.label, value: r.event_dates, sub: 'occurrences' }))),
      table: tableView(['weekday', 'occurrences'], wds.map(r => [r.label, r.event_dates])),
    }),
    figure({
      title: 'How long they hold you',
      note: `Median ${dur(d.clock.duration_median)}, shortest ${dur(d.clock.duration_min)}, `
          + `longest ${dur(d.clock.duration_max)}. Top ${Math.min(8, durRows.length)} lengths of `
          + `${durRows.length} distinct; the rest are folded into one row.`,
      chart: bars(topWithOther(durRows, 8, r => r.event_dates, r => dur(r.minutes)),
        { labelW: 90, rowH: 26 }),
      table: tableView(['length', 'occurrences'], durRows.map(r => [dur(r.minutes), r.event_dates])),
    }),
  ]));

  /* ---------- 4. two calendars in one layer ---------- */

  const overlap = d.population_overlap.reduce((s, o) => s + o.shared_events, 0);
  const splitRow = (label, valueOf, fmt) => {
    const row = h('div', { class: 'chart-row' });
    row.appendChild(h('div', { class: 'card-note chart-label', text: label }));
    row.appendChild(stackedBar(pops.map(p => ({
      label: `${p.label} — ${fmt(valueOf(p))}`, value: valueOf(p), color: popColour.get(p.label),
    }))));
    return row;
  };

  // Only say the two ingests split attendees from text when the counts show it.
  const withAtt = pops.filter(p => p.attendance_statements > 0);
  const withText = pops.filter(p => p.description_chars > 0);
  const splitByKind = pops.length === 2 && overlap === 0 && withAtt.length === 1 && withText.length === 1
    && withAtt[0] !== withText[0];
  root.appendChild(figure({
    wide: true,
    title: pops.length > 1
      ? `This is not one calendar: ${pops.length} ingests write into it`
      : 'One ingest writes into this layer',
    note: (pops.length > 1
        ? `${pops.length} ingests write into this layer and they share ${overlap} event${overlap === 1 ? '' : 's'}, `
          + `measured by intersecting the subject sets.`
        : `One ingest writes into this layer.`)
      + (splitByKind
        ? ` One carries every attendee and organiser and no description text; the other carries all the `
          + `description text and no attendees. So no meeting in this store has both.`
        : ''),
    legend: popLegend(),
    chart: h('div', {}, [
      splitRow('events', p => p.events, compact),
      splitRow('invitation statements', p => p.attendance_statements, compact),
      splitRow('characters of description', p => p.description_chars, compact),
      splitRow('events carrying a join link', p => p.with_conference, compact),
    ]),
    table: tableView(
      ['population', 'events', 'triples', 'with attendees', 'with a sender', 'with a description',
       'description chars', 'with a join link'],
      pops.map(p => [p.label, p.events, p.triples, p.with_attendees, p.with_sender,
                     p.with_description, p.description_chars, p.with_conference])),
  }));

  /* ---------- 5. the text, and its denominator ---------- */

  const topText = text.per_predicate;
  const descIdx = topText.findIndex(r => r.chars === desc.chars && r.rows_ === desc.rows_);

  root.appendChild(figure({
    wide: true,
    title: 'Which fields hold the most text',
    note: `Characters per field across both graph layers, top ${topText.length} of `
        + `${text.predicate_count}. Descriptions hold free text. Most of the characters under the identifier `
        + `and same-as fields are tokens and IDs, not words. This page never shows the description text, `
        + `only its size.`,
    chart: bars(topText.map(r => ({
      label: clip(r.label, 22), value: r.chars, meta: `${r.rows_} rows · longest ${r.longest} chars`,
    })), { emphasis: descIdx, labelW: 160, width: 900 }),
    table: tableView(['predicate', 'label', 'rows', 'characters', 'longest'],
      topText.map(r => [r.predicate, r.label, full(r.rows_), full(r.chars), full(r.longest)])),
  }));

  const denRows = [
    { label: 'of every object stored', chars: denAll },
    { label: 'of everything but references and dates', chars: denRefs },
    { label: 'of readable text only', chars: denLit },
  ];

  root.appendChild(figure({
    title: 'The share depends entirely on the denominator',
    note: `The same ${full(desc.chars)} characters, divided three ways: against every object in both `
        + `layers (${full(denAll)}), against that minus entity references and serialised dates `
        + `(${full(denRefs)}), and against readable text only — references, ontology codes, opaque `
        + `tokens and dates all removed (${full(denLit)}). The share moves with the denominator, so a `
        + `figure for it means nothing without one; the most cautious reading is the smallest bar.`,
    chart: bars(denRows.map(r => ({
      label: r.label, value: Number(share(desc.chars, r.chars).toFixed(1)),
      meta: `${full(desc.chars)} of ${full(r.chars)} characters`,
    })), { labelW: 240, unit: '%', valueFmt: v => v.toFixed(1) }),
    table: tableView(['denominator', 'characters', 'description share'],
      denRows.map(r => [r.label, full(r.chars), share1(desc.chars, r.chars)])),
  }));

  const buckets = text.buckets;
  root.appendChild(figure({
    title: 'How long a meeting description runs',
    note: `${desc.rows_} descriptions in ${buckets.length} buckets of `
        + `${buckets[0] ? buckets[0].step : 0} characters. Median ${full(text.median)}, mean `
        + `${full(Math.round(desc.mean))}, shortest ${full(desc.shortest)}, longest `
        + `${full(desc.longest)} — long enough to be an agenda, a dial-in block and a set of notes.`,
    chart: columns(buckets.map(b => ({
      label: compact(b.floor), value: b.events, sub: `${b.floor}–${b.floor + b.step - 1} chars`,
    }))),
    table: tableView(['length (characters)', 'descriptions'],
      buckets.map(b => [`${full(b.floor)}–${full(b.floor + b.step - 1)}`, b.events])),
  }));

  const authSegs = [
    { key: 'other', label: 'sent by somebody else', color: SERIES(0) },
    { key: 'owner', label: 'sent by the owner', color: SERIES(1) },
    { key: 'unattributed', label: 'no sender recorded', color: 'var(--text-muted)' },
  ].filter(s => auth[s.key].events > 0);

  root.appendChild(figure({
    wide: true,
    title: 'Who sent the invitations',
    note: `iKnow can see who sent each invitation, not who wrote its text. `
        + `${auth.other.events} of the ${desc.rows_} events with a description were sent by someone other `
        + `than you (${d.authorship.distinct_senders} different senders), with ${full(auth.other.chars)} `
        + `characters; you sent ${auth.owner.events}, with ${full(auth.owner.chars)}. So `
        + `${share1(auth.other.chars, desc.chars)} of the description text came in invitations from other people.`,
    legend: legend(authSegs.map(s => ({ label: s.label, color: s.color }))),
    chart: stackedBar(authSegs.map(s => ({
      label: `${s.label} — ${compact(auth[s.key].chars)} chars`,
      value: auth[s.key].chars, color: s.color,
    }))),
    table: tableView(['author', 'events', 'characters', 'share of characters'],
      authSegs.map(s => [s.label, auth[s.key].events, full(auth[s.key].chars),
                         share1(auth[s.key].chars, desc.chars)])),
  }));

  /* ---------- 6. monthly load ---------- */

  const months = d.months;
  const mLabels = months.map(m => m.month);
  const series = pops.map(p => ({
    label: p.label,
    color: popColour.get(p.label),
    points: months.map((m, i) => ({ x: i, y: m.by_population[p.label] || 0 })),
  }));

  root.appendChild(figure({
    wide: true,
    title: 'Month by month, and which ingest was awake',
    note: `${months.length} months of real meeting dates, ${mLabels[0]} to ${mLabels[mLabels.length - 1]}, `
        + `taken from the start-time objects rather than from when the triples were written. The two `
        + `can be far apart, and bucketing on the write timestamp draws a calendar that does not exist.`,
    legend: popLegend(),
    chart: lines(series, { width: 900, height: 220, xFmt: x => mLabels[Math.round(x)] || '' }),
    table: tableView(['month', 'occurrences', ...pops.map(p => p.label)],
      months.map(m => [m.month, m.event_dates, ...pops.map(p => m.by_population[p.label] || 0)])),
  }));

  /* ---------- 7. who is in the room ---------- */

  root.appendChild(figure({
    title: 'Meeting sizes',
    note: `Only ${att.events_with_attendees} of the layer's ${att.events_total} events carry an attendee `
        + `list at all; the remaining ${att.solo_events} record no participants. Largest recorded `
        + `invitation: ${att.sizes.length ? att.sizes[att.sizes.length - 1].attendees : 0} people.`,
    chart: columns(att.sizes.map(s => ({
      label: String(s.attendees), value: s.events, sub: 'events',
    }))),
    table: tableView(['people on the invitation', 'events'],
      att.sizes.map(s => [s.attendees, s.events])),
  }));

  const leaders = att.people.slice(0, cap);
  root.appendChild(figure({
    title: 'The people who share your week',
    note: `Ranked by events invited to. You are on ${att.owner ? att.owner.attended : 0} of the `
        + `${att.events_with_attendees}, so you are left out of the ranking. Showing the top ${leaders.length} of `
        + `${att.people.length}; the table lists them all. People without a name in the graph appear as `
        + `the address on the invitation.`,
    chart: bars(leaders.map(r => ({
      label: clip(r.label, 26), value: r.attended,
      meta: `${r.organised} organised · ${r.co_attendees} co-invitees`,
    })), { labelW: 190, rowH: 26 }),
    table: tableView(['person', 'events invited to', 'organised', 'invitations sent', 'distinct co-invitees'],
      att.people.map(r => [r.label, r.attended, r.organised, r.sent, r.co_attendees])),
  }));

  root.appendChild(figure({
    title: 'And the people who set the time',
    note: `${att.organisers.length} people organise the ${att.organiser_events} events that record an `
        + `organiser.`,
    chart: bars(att.organisers.map(r => ({
      label: clip(r.label, 26) + (r.is_owner ? ' (owner)' : ''), value: r.events,
    })), { labelW: 190, rowH: 26 }),
    table: tableView(['organiser', 'events', 'is the owner'],
      att.organisers.map(r => [r.label, r.events, r.is_owner ? 'yes' : '—'])),
  }));

  const doms = d.domains;
  const domTop = topWithOther(doms, 8, r => r.events, r => clip(r.domain, 26));
  root.appendChild(figure({
    title: 'Affiliation, without naming anybody',
    note: `Mail domains of everyone on these invitations, ranked by events, owner excluded. `
        + `${doms.length} distinct domains; the top `
        + `${Math.min(8, doms.length)} are drawn and the rest folded into one bar. A company domain can `
        + `name an employer without naming a person. ${doms.filter(r => r.never_in_the_room).length} of these `
        + `domains never appear as an invitee or organiser; those may be systems mailing you rather than people.`,
    chart: bars(domTop, { labelW: 200, rowH: 26 }),
    table: tableView(['domain', 'people', 'events', 'as attendee', 'as organiser', 'as sender', 'ever in the room'],
      doms.map(r => [r.domain, r.people, r.events, r.attendees, r.organisers, r.senders,
                     r.never_in_the_room ? '—' : 'yes'])),
  }));

  /* ---------- 8. where ---------- */

  const ven = d.venues;
  const venKinds = [
    { key: 'place', label: 'names a place' },
    { key: 'url', label: 'is a bare join link' },
    { key: 'url_inside', label: 'has a link buried in it' },
  ].filter(k => ven.kinds[k.key] > 0);
  const physical = ven.ranked.filter(r => r.kind === 'place').slice(0, cap);

  root.appendChild(figure({
    wide: true,
    title: ven.kinds.url + ven.kinds.url_inside > ven.kinds.place
      ? 'Most locations here are links, not places'
      : 'What the location field holds',
    note: `${ven.distinct_labels} different locations across ${ven.events} events. `
        + `${ven.kinds.url + ven.kinds.url_inside} contain a link. ${ven.kinds.place} have no link, and iKnow `
        + `counts those as places; the chart below ranks them. The graph also holds ${ven.places.length} `
        + `place entities for these events, and ${ven.named_place_entities} of the ${ven.place_entities} `
        + `places in the whole graph have a name.`,
    legend: legend(venKinds.map((k, i) => ({ label: k.label, color: SERIES(i) }))),
    chart: h('div', {}, [
      stackedBar(venKinds.map((k, i) => ({
        label: `${k.label} — ${ven.kinds[k.key]}`, value: ven.kinds[k.key], color: SERIES(i),
      }))),
      h('p', { class: 'card-note',
               text: `The ${ven.kinds.place} labels that name a place, ranked by events `
                   + `(showing ${physical.length}):` }),
      bars(physical.map(r => ({ label: clip(r.label, 34), value: r.events })),
        { labelW: 230, rowH: 26 }),
    ]),
    table: tableView(['location label', 'events', 'kind', 'characters'],
      ven.ranked.map(r => [r.kind === 'place' ? r.label : clip(r.label, 48), r.events,
                           (venKinds.find(k => k.key === r.kind) || {}).label || r.kind, r.chars])),
  }));

  /* ---------- 9. join links and dial-ins ---------- */

  const lk = d.links;
  const cross = lk.cross_check;
  const pools = cross.reduce((s, p) => s + p.size, 0);
  const hits = cross.reduce((s, p) => s + p.matches, 0);

  root.appendChild(figure({
    wide: true,
    title: hits === 0 && lk.dial_in_distinct > 0
      ? 'Ways into the meeting — and one of them looks like a phone number but is not'
      : 'Ways into the meeting',
    note: `${lk.rows} join links over ${lk.events} events. Dial-in numbers are carried by the `
        + `virtual-conference field (${lk.carriers.map(c => c.predicate).join(', ')}). Checked rather than claimed: the `
        + `${lk.dial_in_distinct} distinct dial-in numbers were compared digit-for-digit against `
        + `${full(pools)} phone handles drawn from the messages store, the graph's own contact handles `
        + `and every address book in the bundle, and matched ${hits}. `
        + (hits === 0 ? `None of them matches a person's number here.` : `Those ${hits} match a person's number.`),
    legend: legend(lk.schemes.map((s, i) => ({ label: s.scheme, color: SERIES(i) }))),
    chart: h('div', {}, [
      stackedBar(lk.schemes.map((s, i) => ({
        label: `${s.scheme} — ${s.rows} links, ${s.distinct} distinct`,
        value: s.rows, color: SERIES(i),
      }))),
      h('p', { class: 'card-note',
               text: `Dial-in bridges by country code — the conference vendors, and roughly where the `
                   + `meetings are hosted:` }),
      bars(lk.prefixes.map(p => ({ label: p.prefix, value: p.numbers })),
        { labelW: 80, rowH: 26, unit: ' numbers' }),
    ]),
    table: tableView(['checked against', 'handles in the pool', 'dial-in numbers matched'],
      cross.map(p => [p.pool.replace(/_/g, ' '), full(p.size), p.matches])),
  }));

  /* ---------- 10. travel ---------- */

  const tv = d.travel;
  root.appendChild(figure({
    wide: true,
    title: 'Events with a booking type',
    note: `${tv.reservation_events} events carry a booking type, across ${tv.types.length} kinds. `
        + `The graph does not record which app or service found them. `
        + `Their descriptions are shorter: a median of ${full(tv.reservation_median_chars)} characters, `
        + `against ${full(tv.meeting_median_chars)} for a meeting. ${tv.legs.length} of the layer's `
        + `${d.events.entities} entities are typed as `
        + `${(d.events.classes.find(c => c.class_code !== d.events.event_class) || {}).label || 'travel'} `
        + `rather than as events; the table lists their carrier, flight number and airports where the graph has them.`,
    chart: bars(tv.types.map(r => ({ label: r.type, value: r.events })),
      { labelW: 180, rowH: 26, unit: ' events' }),
    table: tableView(['flight', 'carrier', 'number', 'from', 'to', 'departs', 'description chars'],
      tv.legs.map(r => [r.title, r.carrier, r.number,
                        `${r.from || '—'}${r.from_code ? ' (' + r.from_code + ')' : ''}`,
                        `${r.to || '—'}${r.to_code ? ' (' + r.to_code + ')' : ''}`,
                        r.when, r.description_chars])),
  }));

  /* ---------- 11. the store underneath ---------- */

  if (src.present) {
    const ek = src.ek_join || {};
    const graphEvents = d.events.entities;
    const graphChars = desc.chars;

    root.appendChild(figure({
      wide: true,
      title: 'The calendar database on this Mac, next to the graph',
      note: `The calendar database on this machine holds ${full(src.events)} event definitions running `
          + `${src.first_event} to ${src.last_event}, with ${full(src.description_chars)} characters of `
          + `description over ${full(src.with_description)} of them, ${full(src.participants)} participant `
          + `rows and ${full(src.identities)} identities across ${src.domains} mail domains. The graph's `
          + `EventKit references match it ${ek.resolved} of ${ek.tokens} times, with `
          + `${ek.ambiguous} ambiguous. iKnow finds none of the graph's other population in that database. `
          + `Forward of the capture line the source store holds `
          + `${full(src.forward_occurrences)} expanded occurrences reaching ${src.last_occurrence}, `
          + `against the ${d.forward.event_dates} the graph knows about. Nothing here is a subset `
          + `claim: the two are charted separately because they are two different corpora that overlap `
          + `on one population.`,
      chart: h('div', {}, [
        h('p', { class: 'card-note chart-label', text: 'calendar events' }),
        bars([
          { label: 'in the graph layer', value: graphEvents },
          { label: 'in the calendar database', value: src.events },
        ], { labelW: 200, rowH: 26, unit: ' events' }),
        h('p', { class: 'card-note chart-label', text: 'characters of description' }),
        bars([
          { label: 'in the graph layer', value: graphChars },
          { label: 'in the calendar database', value: src.description_chars },
        ], { labelW: 200, rowH: 26 }),
      ]),
      table: tableView(['measure', 'graph calendar layer', 'calendar database'], [
        ['events', full(graphEvents), full(src.events)],
        ['characters of description', full(graphChars), full(src.description_chars)],
        ['events with a description', full(desc.rows_), full(src.with_description)],
        ['events with a join link', full(d.links.events), full(src.with_conference)],
        ['forward of the capture line', full(d.forward.event_dates),
         `${full(src.forward_events)} definitions · ${full(src.forward_occurrences)} occurrences`],
        ['first / last', `${d.events.span.first} … ${d.events.span.last}`,
         `${src.first_event} … ${src.last_event}`],
      ]),
    }));
  } else {
    root.appendChild(figure({
      title: 'The calendar database behind the graph',
      chart: h('div', { class: 'empty',
        text: 'The source calendar store is not present in this bundle, so the graph layer above cannot '
            + 'be measured against the calendar it was built from.' }),
    }));
  }

  root.appendChild(callout(
    'What this page deliberately does not show',
    `This page shows counts, lengths and shares, never the text itself. `
    + `${auth.other.events} of these ${desc.rows_} descriptions came from someone other than you, and the `
    + `people named in them may not know their agendas, dial-ins or notes are kept on this Mac.`,
    'warning',
  ));
}
