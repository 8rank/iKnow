/* faces.js — the Photos face layer, told at the strength the data supports.
 *
 * The face layer is easy to over-read, so the page is organised around six
 * measurements, all computed by /api/faces at request time and none of them
 * written here:
 *
 *   1. The face-cluster reference is NOT an opaque token, though it is easy
 *      to take for a 32-byte one-way one. It is plaintext of a documented shape,
 *      and the page shows the anatomy and the resolution rate.
 *   2. The graph points at many clusters and can NAME almost none of them.
 *      The funnel counts how many clusters are actually joined to names,
 *      phones and family scores, and the page leads with that number.
 *   3. The soft-biometric columns are charted as COVERAGE, never as a profile —
 *      no code-to-label table ships in the bundle, so a demographics chart would
 *      be inventing the meaning of integers.
 *   4. The location columns are measured, not assumed: the page says whether
 *      they hold anything, and counts the assets with a latitude in range.
 *   5. Cluster size always comes from the real face join. The cached count is
 *      shown only as the size of its own error.
 *   6. Scene classification needs a two-hop path. Taking the short one does not
 *      fail — it silently answers about a different set of photographs, which
 *      is worse, so both numbers are shown side by side.
 *
 * The part that IS populated is a co-occurrence
 * network of who stands next to whom in photographs, with no names in it.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, columns, lines, meter, hero, legend,
         tableView, full, pct, day, month, SERIES } from '../viz.js';
import { forceGraph } from '../force.js';
import { openCluster, clusterFace } from '../facedrawer.js';

export const meta = {
  id: 'faces',
  nav: 'The face index',
  group: 'What it concluded',
  kicker: 'Photo face clusters',
  title: 'Your Mac keeps a face index of the people in your photo library',
  blurb: 'The reference that binds a person in the graph to a face cluster in Photos is plaintext, '
       + 'not a hash, so iKnow can join them with one string comparison. This page counts how many of '
       + 'those faces have a name, and draws who appears in photos with whom (iKnow’s analysis).',
};

/* ---------- formatting only. No value is written in this file. ---------- */

const ACCENT = SERIES(0);
const SECOND = SERIES(1);
const MUTED = 'var(--text-muted)';

const NET_W = 1080;
const NET_H = 620;

const grid = kids => h('div', { class: 'grid' }, kids.filter(Boolean));

const note = text => h('p', { class: 'card-note', text });

const s = n => (n === 1 ? '' : 's');
const isAre = n => (n === 1 ? 'is' : 'are');
const clusterWord = n => (n === 1 ? 'cluster' : 'clusters');

/* Bar values carry their own noun so a count of one does not read "1 clusters".
 * `unit` cannot do this — it is a fixed string appended to every row. */
const counted = (one, many) => v => `${full(v)} ${v === 1 ? one : many}`;

/* A `wide` card sets grid-column: 1 / -1, which keeps the tracks it spans
 * occupied; a normal card sharing that grid is then squeezed into one narrow
 * track. So wide cards always get a grid of their own. */
const wideGrid = card => h('div', { class: 'grid' }, [card]);

/** A cluster label: a fragment of its local UUID. There are no names to show. */
const tag = c => (c.prefix || c.label || String(c.id || '')).toLowerCase();

const bytes = n => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const conf = v => (v === null || v === undefined ? '—' : Number(v).toFixed(3));

/** 'YYYY-MM' -> unix seconds at the first of that month, for the time axis. */
const monthTs = m => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1) / 1000;

/** Sparse month rows -> a dense run, so empty months read as empty. */
function denseMonths(rows) {
  if (!rows.length) return [];
  const by = new Map(rows.map(r => [r.month, r]));
  const out = [];
  const [y0, m0] = [Number(rows[0].month.slice(0, 4)), Number(rows[0].month.slice(5, 7))];
  const last = rows[rows.length - 1].month;
  let y = y0, m = m0;
  for (let guard = 0; guard < 1200; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(by.get(key) || { month: key, assets: 0, videos: 0, people: 0, assets_with_face: 0 });
    if (key === last) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/* ================================================================== page */

export async function render(root) {
  const [d, net] = await Promise.all([api('faces'), api('faces/network')]);

  const f = d.funnel;
  const cl = d.clusters;
  const an = d.anatomy;

  /* The graph half of this page works without the photo library; nothing else
   * does. Say so and stop, rather than drawing empty charts. */
  if (!cl || !cl.person_rows) {
    root.appendChild(hero({
      value: f.total,
      label: 'face-cluster references in the graph, pointing at a photo library that is not here',
      detail: 'The references, their shape and their resolution machinery are all still readable. '
            + 'Everything they point AT lives in the photo library, which this bundle does not '
            + 'carry — so cluster sizes, the co-appearance network, the biometric columns and the '
            + 'Memories are all unavailable, not empty.',
    }));
    root.appendChild(sectionIdentifier(d, an));
    root.appendChild(h('div', { class: 'grid' }, [
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h3', { text: 'The photo library is not in this bundle' })]),
        note('Every panel below this point reads the photo library directly: cluster sizes, the '
           + 'face co-appearance graph, the soft-biometric columns, the location columns, the '
           + 'monthly volume, the Memories and the scene classifier. None of them can be computed '
           + 'from the graph alone, and this page will not draw a chart of nothing.'),
      ]),
    ]));
    return;
  }

  /* ---------------- lead ---------------- */

  root.appendChild(hero({
    value: `${full(f.named_anywhere)} of ${full(f.total)}`,
    label: 'face clusters the graph points at can be given a name anywhere on this machine',
    detail: `Every one of the ${full(f.total)} references resolves into the photo library — the `
          + `identifier is plaintext, and the match rate is ${pct(f.resolved_in_photos, f.total)}. `
          + `What the graph cannot do is say who any of them are: ${full(f.named_in_graph)} carry a `
          + `name in the graph, ${full(f.named_in_photos)} ${isAre(f.named_in_photos)} named inside `
          + `Photos` + (f.named_anywhere === f.named_in_graph && f.named_anywhere === f.named_in_photos
              ? `, and the two sets are the same ${clusterWord(f.named_anywhere)}.`
              : `; ${full(f.named_anywhere)} ${clusterWord(f.named_anywhere)} carry a name in either.`),
  }));

  root.appendChild(h('div', { class: 'grid grid-tight' }, [
    statTile({
      label: 'face clusters referenced by the graph',
      value: f.total,
      sub: `out of ${full(cl.person_rows)} clusters Photos holds, `
         + `${full(cl.with_faces)} of which have at least one face in them`,
    }),
    statTile({
      label: 'of those that carry a dialable handle',
      value: f.steps.find(x => x.key === 'handle').n,
      sub: `and ${full(f.steps.find(x => x.key === 'card').n)} carry a Contacts card reference`,
    }),
    statTile({
      label: 'faces detected and stored',
      value: cl.face_rows,
      sub: `${full(cl.faces_clustered)} of them assigned to a cluster, `
         + `${full(cl.faceprints.n)} with a stored faceprint (${bytes(cl.faceprints.bytes)})`,
    }),
    statTile({
      label: 'people in the co-appearance network',
      value: net.nodes.length,
      sub: `linked by ${full(net.links.length)} co-appearance edge${s(net.links.length)} over `
         + `${full(net.assets_with_two)} photographs holding more than one face`
         + (d.messaging ? ` · the messaging store reaches ${full(d.messaging.handles)} handles` : ''),
    }),
  ]));

  /* ---------------- 1. the identifier is plaintext ---------------- */

  root.appendChild(sectionIdentifier(d, an));

  /* ---------------- 2. what it can and cannot name ---------------- */

  root.appendChild(sectionFunnel(d, f, cl));

  /* ---------------- 3. the co-appearance network ---------------- */

  root.appendChild(sectionNetwork(d, net));

  /* ---------------- 4. cluster sizes, from the real join ---------------- */

  root.appendChild(sectionClusters(d, cl));

  /* ---------------- 5. the stale cache ---------------- */

  root.appendChild(sectionCache(cl));

  /* ---------------- 6. soft biometrics, as coverage ---------------- */

  if (d.biometrics) root.appendChild(sectionBiometrics(d.biometrics));

  /* ---------------- 7. the location column that holds nothing ------------- */

  if (d.geography) root.appendChild(sectionGeography(d.geography));

  /* ---------------- 8. volume over time ---------------- */

  root.appendChild(sectionTimeline(d.timeline));

  /* ---------------- 9. the narratives it wrote by itself ---------------- */

  if (d.memories) root.appendChild(sectionMemories(d.memories));

  /* ---------------- 10. the scene classifier and its two hops ------------- */

  if (d.scenes) root.appendChild(sectionScenes(d.scenes));
}

/* ================================================================ sections */

function sectionIdentifier(d, an) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'The face reference is plaintext, not a hash' }));

  const car = d.carriers.filter(c => c.present);
  const carrierRows = car.map(c => ({
    label: c.table,
    value: c.resolved,
    meta: `of ${c.identifiers} identifier${s(c.identifiers)} carried — ${c.blurb}`,
    color: c.resolved === c.identifiers ? ACCENT : MUTED,
  }));

  const shape = an ? an.masked_shapes[0] : null;

  box.appendChild(grid([
    figure({
      title: 'Every store that carries the identifier, and whether it resolves',
      note: an
        ? `Measured now: all ${full(an.values)} distinct `
        + `identifiers are ${an.lengths.join(' / ')} characters drawn from a `
        + `${full(an.charset_size)}-character alphabet — "${an.charset}" — where base64 needs `
        + `${full(an.base64_alphabet_size)}. Decoding one as base64 yields `
        + `${an.b64_decoded_bytes.join(' / ')} bytes, not the ${full(an.sha256_bytes)} a SHA-256 `
        + `would give, because the decoder silently drops the characters that are not in its `
        + `alphabet. That is why it passes for a hash: an unpadded base64 of a 32-byte hash is `
        + `also this length. Compared as plain text against the photo library's own person `
        + `identifiers, every store here resolves at ${pct(d.resolution.resolved, d.resolution.identifiers)}.`
        : 'No face-cluster reference is present in this graph.',
      chart: carrierRows.length
        ? bars(carrierRows, { width: 760, labelW: 190, rowH: 34, unit: ' resolved' })
        : h('div', { class: 'empty', text: 'no store in this bundle carries a face reference' }),
      table: tableView(
        ['store', 'table', 'rows carrying it', 'distinct identifiers', 'stored forms', 'resolved in Photos'],
        d.carriers.map(c => [c.store, c.table, full(c.rows), full(c.identifiers),
                             full(c.forms), c.present ? full(c.resolved) : 'store absent'])),
    }),
    figure({
      title: 'What the value is made of',
      note: an
        ? `The shape below is the real value with every hexadecimal digit replaced by x, so the `
        + `structure is visible and no identifier is. ` + (an.masked_shapes.length === 1
          ? `All ${full(an.values)} take this one shape: a `
          : `The commonest shape is a `)
        + `${an.head_len.join('/')}-character identifier, ${full(an.heads_distinct)} of them `
        + `distinct, followed by a ${full(an.scope_len)}-character library-scope marker` + (an.scopes_distinct === 1
          ? ` that is the same on every value. A hash would not have a constant tail, and it would not be `
            + `built from hexadecimal.`
          : `, ${full(an.scopes_distinct)} distinct markers across the whole set.`)
        : '',
      chart: an ? anatomyCard(an) : h('div', { class: 'empty', text: 'nothing to describe' }),
      table: an ? tableView(['property', 'measured'], [
        ['distinct identifiers', full(an.values)],
        ['length in characters', an.lengths.join(' / ')],
        ['alphabet actually used', an.charset],
        ['alphabet size', `${full(an.charset_size)} (base64 uses ${full(an.base64_alphabet_size)})`],
        ['identifier part', `${an.head_len.join('/')} chars, ${full(an.heads_distinct)} distinct`],
        ['constant scope suffix', `${full(an.scope_len)} chars, ${full(an.scopes_distinct)} distinct value`],
        ['bytes from a base64 decode', an.b64_decoded_bytes.join(' / ')],
        ['bytes a SHA-256 would give', full(an.sha256_bytes)],
      ]) : null,
    }),
  ]));

  /* how the reference is stored: the reified statement and its facets */
  const st = d.statement;
  const facetRows = st.facets.map(x => ({
    label: x.label || x.facet,
    value: x.distinct_objects,
    meta: `distinct value${s(x.distinct_objects)} across ${full(x.n)} row${s(x.n)}`,
    color: x.distinct_objects > 1 ? ACCENT : MUTED,
  }));

  const layerRows = d.layers.filter(l => l.rows > 0);
  const retracted = d.layers.filter(l => l.retracted && l.rows > 0).length;

  box.appendChild(grid([
    figure({
      title: `How the binding is written: "${d.namespace.statement_label}"`,
      note: `The face link is not a plain attribute — it is a reified statement, one row per facet, `
          + `all sharing a statement id. The facets are shown by how many distinct values each one `
          + `holds, which is what separates the facet that identifies a cluster from the two that `
          + `label the statement. Every facet here was asserted by `
          + `${(st.facets[0] && st.facets[0].sources.join(', ')) || 'an unnamed source'} at a `
          + `confidence of ${conf(st.facets[0] && st.facets[0].confidence_lo)}, identical on every `
          + `row — so confidence separates nothing here. The same identifier is also written twice `
          + `more on the same subject, under "${d.namespace.predicate_label}" and under `
          + `"${d.namespace.identifier_label}". `
          + (layerRows.length === 1
              ? `All of it sits in the ${layerRows[0].layer} layer, and none of it in a retracted one.`
              : `${full(retracted)} of the populated layers are retraction layers.`),
      chart: bars(facetRows, { width: 760, labelW: 170, rowH: 32, unit: ' distinct' }),
      table: tableView(['facet', 'label', 'rows', 'distinct values', 'subjects', 'confidence', 'ingest source'],
        st.facets.map(x => [x.facet, x.label || '—', full(x.n), full(x.distinct_objects),
                            full(x.subjects), conf(x.confidence_lo),
                            x.sources.join(', ') || '—'])),
    }),
    figure({
      title: 'Why the machine says it made each link',
      note: `Every binding carries a stated reason. `
          + (st.reasons.length
              ? `${full(st.reasons[0].n)} of ${full(st.reasons.reduce((t, r) => t + r.n, 0))} read `
              + `"${st.reasons[0].reason}". `
              : '')
          + (d.statement.rejections === null
              ? ''
              : `The projection that records a person rejecting one of these guesses holds `
              + `${full(d.statement.rejections)} row${s(d.statement.rejections)}, so `
              + (d.statement.rejections === 0
                  ? 'not one of these assertions has ever been challenged.'
                  : 'a few have been challenged.')),
      chart: bars(st.reasons.map(r => ({
        label: r.reason, value: r.n, meta: 'binding' + s(r.n),
      })), { width: 760, labelW: 230, rowH: 32, emphasis: 0,
             valueFmt: counted('binding', 'bindings') }),
      table: tableView(['stated reason', 'bindings'],
        st.reasons.map(r => [r.reason, full(r.n)])),
    }),
  ]));

  return box;
}

function anatomyCard(an) {
  const wrap = h('div');
  wrap.style.padding = '18px 4px 8px';
  const line = h('div', { class: 'mono', text: an.masked_shapes[0].shape });
  Object.assign(line.style, {
    fontSize: '17px', letterSpacing: '0.04em', wordBreak: 'break-all',
    color: 'var(--text-primary)', lineHeight: '1.7',
  });
  wrap.appendChild(line);

  const key = h('div', { class: 'muted' });
  key.style.marginTop = '10px';
  key.style.fontSize = '12px';
  key.appendChild(h('span', { text: `x = one hexadecimal digit · everything else is literal · ` }));
  key.appendChild(h('span', { text: `${full(an.masked_shapes[0].n)} of ${full(an.values)} values take this shape` }));
  wrap.appendChild(key);

  const tail = h('div');
  tail.style.marginTop = '14px';
  tail.appendChild(h('span', { class: 'pill', text: `identifier · ${an.head_len.join('/')} chars` }));
  tail.appendChild(h('span', { text: ' ' }));
  tail.appendChild(h('span', {
    class: 'pill',
    text: `constant scope · ${an.scope} · ${full(an.scopes_distinct)} distinct`,
  }));
  wrap.appendChild(tail);
  return wrap;
}

function sectionFunnel(d, f, cl) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'How many of the faces it can name' }));

  const steps = f.steps;
  const chain = steps.map(x => ({
    label: x.label,
    value: x.n,
    meta: `of ${full(f.total)} referenced ${clusterWord(f.total)}`,
    color: x.n >= f.total ? ACCENT : (x.n > f.total / 10 ? SECOND : MUTED),
  }));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'What else the graph can attach to a face',
      note: `One bar per thing that can come attached to a face cluster, counted `
          + `against the same denominator: the ${full(f.total)} clusters the graph references. `
          + `The question is whether these clusters are joined to names, phones and family `
          + `scores. The closeness score is true of `
          + `${full((steps.find(x => x.key === 'score') || { n: 0 }).n)}. The name is true of `
          + `${full(f.named_in_graph)}. The phone number is true of `
          + `${full(steps.find(x => x.key === 'handle').n)}. Colour marks how far each bar falls short of the `
          + `denominator and carries no other meaning.`,
      legend: legend([
        { label: 'true of every referenced cluster', color: ACCENT },
        { label: 'true of a minority', color: SECOND },
        { label: 'true of almost none', color: MUTED },
      ]),
      chart: bars(chain, { width: 1120, labelW: 300, rowH: 36,
                           valueFmt: counted('cluster', 'clusters') }),
      table: tableView(['what the graph can attach', 'clusters', 'share of referenced'],
        steps.map(x => [x.label, full(x.n), pct(x.n, f.total)])),
    })));

  const kinds = Object.keys(d.statement.extra).map(k => d.statement.extra[k]);

  box.appendChild(grid([
    figure({
      title: 'Which name predicate, if any, fires',
      note: `The graph has three predicates that can hold a display name. Across the `
          + `${full(f.total)} face-bound people, this is how often each one is present. `
          + `Inside the photo library itself the picture is the same: `
          + `${full(cl.named_in_photos)} of ${full(cl.person_rows)} clusters carry a typed-in name, `
          + `and ${full(cl.with_contact_dict)} carry the dictionary that would bridge to a contact `
          + `card. The naming machinery is built, wired and idle.`,
      chart: bars(f.per_name_predicate.map(p => ({
        label: `${p.label} (${p.predicate})`,
        value: p.subjects,
        meta: `of ${full(f.total)} face-bound people`,
      })), { width: 760, labelW: 190, rowH: 32, valueFmt: counted('person', 'people') }),
      table: tableView(['predicate', 'label', 'face-bound people carrying it'],
        f.per_name_predicate.map(p => [p.predicate, p.label, full(p.subjects)])),
    }),
    figure({
      title: 'What it does say about them',
      note: `${full(kinds.length)} predicate${s(kinds.length)} classify the ${full(f.total)} `
          + `face-bound people; the chart shows the values ${kinds.length === 1 ? 'it holds' : 'they hold'}.`,
      chart: bars(kinds.flatMap(k => k.values.map(v => ({
        label: `${k.label}: ${v.value}`,
        value: v.n,
        meta: `of ${full(f.total)} face-bound people`,
      }))), { width: 760, labelW: 240, rowH: 30, valueFmt: counted('person', 'people') }),
      table: tableView(['predicate', 'stated value', 'people'],
        kinds.flatMap(k => k.values.map(v => [k.label, v.value, full(v.n)]))),
    }),
  ]));
  return box;
}

function sectionNetwork(d, net) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'The part that is fully populated: who appears with whom' }));

  const tiers = d.network_tiers;
  let floor = tiers.find(t => t.min_shared === 2) ? 2 : tiers[0].min_shared;

  const byId = new Map(net.nodes.map(n => [n.id, n]));
  const EDGE_ROWS = 60;      // the network table's own cap, stated on screen
  const EDGE_BARS = 24;      // the strongest-pairs cap, stated on screen
  const PARTNER_ROWS = 12;   // the selection panel's cap, stated on screen

  const holder = h('div');
  const panel = h('div');
  Object.assign(panel.style, { minHeight: '48px', marginTop: '10px' });

  const visibleLinks = () => net.links.filter(l => l.weight >= floor);
  const visibleNodes = () => {
    const keep = new Set();
    for (const l of visibleLinks()) { keep.add(l.source); keep.add(l.target); }
    return net.nodes.filter(n => keep.has(n.id));
  };

  /* force.js hands the RAW node to colorFor and to onSelect, not its internal copy. */
  const colorFor = n => (n && n.referenced ? ACCENT : MUTED);

  const card = figure({
    wide: true,
    title: 'The face co-occurrence graph',
    note: `Two people are linked when they appear in the same photograph. Nothing in this picture `
        + `came from a contact, a message or a calendar: it is built entirely from `
        + `${full(d.clusters.faces_clustered)} clustered faces over `
        + `${full(net.assets_with_two)} photographs that hold more than one of them. Node size is `
        + `the number of faces in that cluster; edge weight is the number of shared photographs. `
        + `Labels are fragments of each cluster's local identifier, because there are no names to `
        + `show. Clusters the graph itself points at are highlighted; the rest are people the `
        + `photo library knows about and the graph has never mentioned. Drag to place a node, `
        + `pinch or ⌘-scroll to zoom; click a node and the cluster opens with its photographs and who it `
        + `appears with. Each node can wear its own face; that is one photo preview per `
        + `node read out of the library, so it is off until you ask for it. The table view `
        + `lists the ${EDGE_ROWS} heaviest edges of ${full(net.links.length)}.`,
    legend: legend([
      { label: 'referenced by the graph', color: ACCENT },
      { label: 'known only to the photo library', color: MUTED },
    ]),
    chart: holder,
    table: tableView(['cluster a', 'cluster b', 'shared photographs'],
      net.links.slice(0, EDGE_ROWS).map(l => {
        const a = byId.get(l.source), b = byId.get(l.target);
        return [a ? tag(a) : String(l.source), b ? tag(b) : String(l.target), full(l.weight)];
      })),
  });

  /* threshold control — every option labelled with what it actually shows */
  const controls = h('div', { class: 'viz-legend' });
  controls.style.marginBottom = '8px';
  const buttons = [];
  for (const t of tiers) {
    const btn = h('button', {
      class: 'ghost', type: 'button',
      text: `${t.min_shared}+ shared — ${full(t.nodes)} people, ${full(t.edges)} links`,
      onclick: () => {
        floor = t.min_shared;
        for (const b of buttons) b.classList.toggle('on', b === btn);
        graph.update({ nodes: visibleNodes(), links: visibleLinks() });
        faceBtn.textContent = faceLabel();
        panel.textContent = '';
      },
    });
    if (t.min_shared === floor) btn.classList.add('on');
    buttons.push(btn);
    controls.appendChild(btn);
  }

  /* Faces on the nodes: one preview fetched per visible node, so this starts
   * off and says what turning it on will cost. force.js asks faceFor again on
   * every update, so flipping it is a redraw rather than a rebuild. */
  let faces = false;
  /* Counted over what the current threshold actually draws, not over the whole
   * payload: the label is a promise about this picture, so it is re-counted
   * whenever the threshold moves the picture underneath it. */
  const faceLabel = () => {
    const vis = visibleNodes();
    const n = vis.filter(x => x.key_face && x.key_face.thumb).length;
    return `photographs on the nodes — ${full(n)} of ${full(vis.length)} drawn here have one`;
  };
  const faceBtn = h('button', {
    class: 'ghost', type: 'button', 'aria-pressed': 'false',
    text: faceLabel(),
    onclick: () => {
      faces = !faces;
      faceBtn.classList.toggle('on', faces);
      faceBtn.setAttribute('aria-pressed', String(faces));
      graph.update({ nodes: visibleNodes(), links: visibleLinks() });
    },
  });
  controls.appendChild(faceBtn);
  card.insertBefore(controls, holder);

  const graph = forceGraph(holder, {
    nodes: visibleNodes(),
    links: visibleLinks(),
    width: NET_W, height: NET_H,
    colorFor,
    faceFor: n => (faces ? clusterFace(n) : null),
    /* force.js draws links in --grid, which is a hairline against this ground.
     * One neutral colour for every edge: the edges carry no category here. */
    linkColorFor: () => MUTED,
    onSelect: node => {
      panel.textContent = '';
      if (!node) return;
      const n = node;
      const partners = visibleLinks()
        .filter(l => l.source === n.id || l.target === n.id)
        .sort((a, b) => b.weight - a.weight);
      panel.appendChild(note(
        `Cluster ${tag(n)} — ${full(n.faces)} face${s(n.faces)} across ${full(n.assets)} `
      + `photograph${s(n.assets)}, ${partners.length} co-appearance link${s(partners.length)} at `
      + `this threshold`
      + (partners.length > PARTNER_ROWS ? `, the ${PARTNER_ROWS} heaviest listed below` : '')
      + `. ${n.referenced ? 'The graph points at this cluster.' : 'The graph has never mentioned this cluster.'}`
      + `${n.named ? ' It carries a name inside Photos.' : ''}`));
      panel.appendChild(h('button', {
        class: 'ghost', type: 'button', text: `open cluster ${tag(n)} again → its photographs and who it appears with`,
        onclick: () => openCluster(n.id),
      }));
      panel.appendChild(tableView(['appears with', 'shared photographs'],
        partners.slice(0, PARTNER_ROWS).map(l => {
          const other = byId.get(l.source === n.id ? l.target : l.source);
          return [other ? tag(other) : '—', full(l.weight)];
        })));
      /* a click on a node is a request to see the person: open the drawer at once;
       * the panel above stays behind it for when the drawer is closed */
      openCluster(n.id);
    },
  });
  card.appendChild(panel);
  box.appendChild(wideGrid(card));

  /* the honest comparison with the other social network in the bundle */
  const top = net.links.slice(0, EDGE_BARS).map(l => {
    const a = byId.get(l.source), b = byId.get(l.target);
    return {
      label: `${a ? tag(a) : l.source} · ${b ? tag(b) : l.target}`,
      value: l.weight,
      meta: 'shared photographs',
      color: (a && a.referenced) || (b && b.referenced) ? ACCENT : MUTED,
    };
  });

  box.appendChild(grid([
    figure({
      title: 'The strongest pairs',
      legend: legend([
        { label: 'at least one end referenced by the graph', color: ACCENT },
        { label: 'neither end referenced', color: MUTED },
      ]),
      note: `The ${top.length} heaviest edges of ${full(net.links.length)}, by how many photographs `
          + `the pair share. A heavy edge is a household, a couple, a colleague you are `
          + `photographed beside — inferred with no name, no handle and no calendar entry. `
          + `Highlighted where at least one end is a cluster the graph references.`,
      chart: bars(top, { width: 760, labelW: 150, rowH: 26,
                         valueFmt: counted('photograph', 'photographs') }),
      table: tableView(['pair', 'shared photographs'], top.map(t => [t.label, full(t.value)])),
    }),
    d.messaging ? figure({
      title: 'Two social networks in the same bundle',
      note: `Both are reconstructed from metadata alone. The messaging store reaches ${full(d.messaging.handles)} people over `
          + `${full(d.messaging.messages)} messages. The photo library places `
          + `${full(net.nodes.length)} people in the same frame as somebody else. Different `
          + `denominators — a handle is an address, a cluster is a face — so the meters are shown `
          + `against the same axis rather than combined into one chart.`,
      chart: h('div', {}, [
        meter({
          value: net.nodes.length,
          max: Math.max(net.nodes.length, d.messaging.handles),
          label: `${full(net.nodes.length)} people appear in a photograph with somebody else`,
        }),
        meter({
          value: d.messaging.handles,
          max: Math.max(net.nodes.length, d.messaging.handles),
          label: `${full(d.messaging.handles)} handles exchanged at least one message`,
        }),
        meter({
          value: d.funnel.total,
          max: Math.max(net.nodes.length, d.messaging.handles),
          label: `${full(d.funnel.total)} of those faces are referenced by the graph itself`,
        }),
      ]),
      table: tableView(['network', 'people reached', 'built from'], [
        ['photo co-appearance', full(net.nodes.length), 'clustered faces sharing a photograph'],
        ['messaging', full(d.messaging.handles), 'handles with at least one message'],
        ['graph face references', full(d.funnel.total), 'cross-store references in the triple store'],
      ]),
    }) : null,
  ]));

  return box;
}

function sectionClusters(d, cl) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'How big each face cluster is, and how long it has been watched' }));

  const rows = cl.top.map(c => ({
    label: tag(c),
    value: c.faces,
    meta: `face${s(c.faces)} across ${full(c.assets)} photograph${s(c.assets)}`
        + (c.first ? ` · ${day(c.first)} to ${day(c.last)}` : ''),
    color: c.referenced ? ACCENT : MUTED,
    onclick: () => openCluster(c.id),
  }));

  const spanStart = cl.top.reduce((m, c) => (c.first && (!m || c.first < m) ? c.first : m), null);
  const spanEnd = cl.top.reduce((m, c) => (c.last && (!m || c.last > m) ? c.last : m), null);

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: `The ${cl.cap} largest clusters`,
      note: `Showing the ${Math.min(cl.cap, cl.with_faces)} largest of ${full(cl.with_faces)} `
          + `clusters that contain at least one face; the table lists the same capped set. Size is `
          + `counted from the face rows themselves, never from the cached count the library keeps `
          + `alongside — that cache can disagree, and the next panel measures by how much. `
          + `${full(cl.referenced)} of these clusters are referenced by the graph and are `
          + `highlighted; the graph does not reference the rest. The largest clusters here span `
          + (spanStart ? `${day(spanStart)} to ${day(spanEnd)}` : 'an unknown period')
          + `, so a cluster builds up over time. Click a bar to open the `
          + `cluster: what Photos calls the person, what the graph binds it to, the photographs `
          + `it appears in, and who it appears with.`,
      legend: legend([
        { label: 'referenced by the graph', color: ACCENT },
        { label: 'photo library only', color: MUTED },
      ]),
      chart: bars(rows, { width: 1120, labelW: 110, rowH: 26,
                          valueFmt: counted('face', 'faces') }),
      table: tableView(
        ['cluster', 'faces', 'photographs', 'first seen', 'last seen', 'referenced', 'named in Photos'],
        cl.top.map(c => [tag(c), full(c.faces), full(c.assets),
                         c.first ? day(c.first) : '—', c.last ? day(c.last) : '—',
                         c.referenced ? 'yes' : '—', c.named ? 'yes' : '—'])),
    })));

  const confirmed = cl.verified_referenced.filter(v => v.code > 0)
    .reduce((t, v) => t + v.n, 0);

  box.appendChild(grid([
    figure({
      title: 'How much of the library the graph actually watches',
      note: `The graph does not reference clusters at random: it takes the big ones. Its `
          + `${full(cl.referenced)} references cover ${full(cl.referenced_faces)} of the `
          + `${full(cl.faces_clustered)} clustered faces — `
          + `${pct(cl.referenced_faces, cl.faces_clustered)} of the face data from `
          + `${pct(cl.referenced, cl.with_faces)} of the clusters. `
          + `${full(cl.empty)} of the ${full(cl.person_rows)} cluster rows hold no face at all and `
          + `are excluded from every count on this page.`,
      chart: h('div', {}, [
        meter({
          value: cl.referenced, max: cl.with_faces,
          label: `${full(cl.referenced)} of ${full(cl.with_faces)} non-empty clusters are referenced`,
        }),
        meter({
          value: cl.referenced_faces, max: cl.faces_clustered,
          label: `${full(cl.referenced_faces)} of ${full(cl.faces_clustered)} clustered faces are inside them`,
        }),
        meter({
          value: cl.faces_clustered, max: cl.face_rows,
          label: `${full(cl.faces_clustered)} of ${full(cl.face_rows)} detected faces reached a cluster at all`,
        }),
        meter({
          value: cl.faceprints.n, max: cl.face_rows,
          label: `${full(cl.faceprints.n)} of ${full(cl.face_rows)} faces carry a stored faceprint `
               + `(${bytes(cl.faceprints.bytes)} of biometric template)`,
        }),
      ]),
      table: tableView(['measure', 'count', 'denominator', 'share'], [
        ['clusters referenced by the graph', full(cl.referenced), full(cl.with_faces), pct(cl.referenced, cl.with_faces)],
        ['faces inside referenced clusters', full(cl.referenced_faces), full(cl.faces_clustered), pct(cl.referenced_faces, cl.faces_clustered)],
        ['faces assigned to any cluster', full(cl.faces_clustered), full(cl.face_rows), pct(cl.faces_clustered, cl.face_rows)],
        ['faces with a stored faceprint', full(cl.faceprints.n), full(cl.face_rows), pct(cl.faceprints.n, cl.face_rows)],
        ['cluster rows holding no face', full(cl.empty), full(cl.person_rows), pct(cl.empty, cl.person_rows)],
      ]),
    }),
    figure({
      title: 'Confirmation codes on the clusters the graph references',
      legend: legend([
        { label: 'non-zero confirmation code', color: ACCENT },
        { label: 'code zero', color: MUTED },
      ]),
      note: `Photos keeps a numeric confirmation code on each cluster. No label table for the `
          + `codes ships in this bundle, and a non-zero code may mean a person confirmed the cluster `
          + `or that the graph did. Across the ${full(cl.referenced)} clusters the graph references, `
          + `${full(confirmed)} carry a non-zero code.`,
      chart: bars(cl.verified_referenced.map(v => ({
        label: `confirmation code ${full(v.code)}`,
        value: v.n,
        meta: `of ${full(cl.referenced)} referenced clusters`,
        color: v.code ? ACCENT : MUTED,
      })), { width: 760, labelW: 190, rowH: 30, valueFmt: counted('cluster', 'clusters') }),
      table: tableView(['confirmation code', 'referenced clusters', 'clusters library-wide'],
        cl.verified_codes.map(v => [full(v.code),
          full((cl.verified_referenced.find(x => x.code === v.code) || { n: 0 }).n),
          full(v.n)])),
    }),
  ]));
  return box;
}

function sectionCache(cl) {
  const c = cl.cache;
  const rows = c.worst.map(x => ({
    label: tag(x),
    value: Math.abs(x.faces - x.cached),
    meta: `cache says ${full(x.cached)}, the face rows say ${full(x.faces)}`,
    color: x.referenced ? ACCENT : MUTED,
  }));

  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: c.disagree
    ? 'The cached face count disagrees with the faces, so nothing here uses it'
    : 'The cached face count matches the faces here' }));
  box.appendChild(grid([
    figure({
      title: 'The cached count and the real count, where they differ most',
      legend: legend([
        { label: 'referenced by the graph', color: ACCENT },
        { label: 'photo library only', color: MUTED },
      ]),
      note: `The photo library keeps a face count on each cluster row. It disagrees with the real `
          + `number of linked faces on ${full(c.disagree)} of ${full(cl.person_rows)} cluster rows, `
          + `and on ${full(c.disagree_referenced)} of the ${full(cl.referenced)} the graph `
          + `references. Across the whole library the cache totals ${full(c.cached_total)} faces `
          + `where ${full(c.real_total)} are actually linked` + (c.real_total > c.cached_total
              ? ` — it undercounts by ${full(c.real_total - c.cached_total)}. `
              : c.real_total < c.cached_total ? ` — it overcounts by ${full(c.cached_total - c.real_total)}. ` : `. `)
          + `Showing the ${Math.min(c.cap, c.disagree)} `
          + `largest disagreements; the bar is the size of the error, not the size of the cluster. `
          + `Every other number on this page is computed from the join.`,
      chart: bars(rows, { width: 760, labelW: 110, rowH: 28,
                          valueFmt: counted('face out', 'faces out') }),
      table: tableView(['cluster', 'cached count', 'real linked faces', 'error', 'referenced'],
        c.worst.map(x => [tag(x), full(x.cached), full(x.faces),
                          full(x.faces - x.cached), x.referenced ? 'yes' : '—'])),
    }),
    figure({
      title: 'How widespread the disagreement is',
      note: `Reading the cached column instead of counting the join would misstate `
          + `${pct(c.disagree, cl.person_rows)} of the cluster rows in this library: `
          + `${full(c.disagree_under)} too low and ${full(c.disagree_over)} too high.`,
      chart: meter({
        value: c.disagree, max: cl.person_rows,
        label: `${full(c.disagree)} of ${full(cl.person_rows)} cluster rows carry a count that differs`,
        tone: 'seq',
      }),
      table: tableView(['measure', 'value'], [
        ['cluster rows whose cached count differs', full(c.disagree)],
        ['cluster rows in the library', full(cl.person_rows)],
        ['faces the cache claims in total', full(c.cached_total)],
        ['faces actually linked in total', full(c.real_total)],
        ['shortfall', full(c.real_total - c.cached_total)],
      ]),
    }),
  ]));
  return box;
}

function sectionBiometrics(b) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'The soft-biometric schema, charted as coverage, never as a profile' }));

  const present = b.per_face.filter(x => x.present);
  const never = present.filter(x => x.computed === 0);
  const live = present.filter(x => x.computed > 0);

  const rows = present.map(x => ({
    label: x.label,
    value: x.computed,
    meta: x.computed === 0
      ? 'never computed on any face in this library'
      : `of ${full(x.total)} faces · ${full(x.distinct)} distinct code${s(x.distinct)} in use`,
    color: x.computed === 0 ? MUTED : ACCENT,
  }));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'What the face analyser was asked to decide about each face',
      note: `Photos declares ${full(present.length)} soft-biometric attributes on every detected `
          + `face — apparent age, apparent gender, apparent ethnicity, skin tone, hair, facial `
          + `hair, glasses, headgear, gaze, expression, pose. The bar is how many of the `
          + `${full(b.face_rows)} stored faces carry a computed value; zero is this schema's `
          + `"not computed" sentinel, so a bar at zero means the column was never filled in at all. `
          + (b.block
              ? (b.block.any + b.block.none === b.face_rows
                ? `The ${full(live.length)} live columns move together exactly: `
                  + `${full(b.block.any)} faces carry a value on all of them and `
                  + `${full(b.block.none)} carry a value on none, which looks like one analysis pass per face. `
                : `${full(b.block.any)} faces carry a value on all ${full(live.length)} live columns, `
                  + `${full(b.block.none)} on none, and the rest on some. `)
              : '')
          + `THIS PAGE DOES NOT CHART THE VALUES, and the reason is measurable rather than `
          + `squeamish: `
          + (b.label_table
              ? `the only label table in this store holds ${full(b.label_table.rows)} code rows and `
              + `${full(b.label_table.aliased)} of them carry a human-readable alias, `
              : 'no label table ships anywhere in this bundle, ')
          + `so every one of these codes is an integer whose meaning is not written down here. A `
          + `demographic breakdown drawn from them would be this page inventing what the numbers `
          + `mean. The capability is what is worth seeing, and the capability is the schema.`,
      legend: legend([
        { label: 'computed on part of the library', color: ACCENT },
        { label: 'never computed on any face', color: MUTED },
      ]),
      chart: bars(rows, { width: 1120, labelW: 190, rowH: 28,
                          valueFmt: counted('face', 'faces') }),
      table: tableView(['attribute', 'column', 'faces with a computed value', 'faces total', 'distinct codes stored'],
        b.per_face.map(x => [x.label, x.column,
                             x.present ? full(x.computed) : 'column absent',
                             full(x.total), x.present ? full(x.distinct) : '—'])),
    })));

  box.appendChild(grid([
    figure({
      title: 'How often the per-face values reach the cluster',
      note: `A value on a face is one thing; a value on the cluster, which is the person, is another. `
          + `Across ${full(b.person_rows)} clusters, the fullest cluster-level column carries a value on `
          + `${full(Math.max(0, ...b.per_person.map(p => p.computed)))} of them, from `
          + `${full(b.block ? b.block.any : 0)} analysed faces. Whether the step that fills them has run `
          + `is not something iKnow can tell from here.`
          + (b.flags.length
              ? ` The ${full(b.flags.length)} genuine boolean${s(b.flags.length)} ${b.flags.length === 1 ? 'is' : 'are'} `
              + `not part of this and ${b.flags.length === 1 ? 'is' : 'are'} counted separately: zero means "no", not "unknown".`
              : ''),
      chart: h('div', {}, b.per_person.map(p => meter({
        value: p.computed, max: p.total,
        label: `${p.label} — ${full(p.computed)} of ${full(p.total)} clusters carry a value`,
      })).concat(b.flags.map(fl => meter({
        value: fl.yes, max: fl.total,
        label: `${fl.label} — ${full(fl.yes)} of ${full(fl.total)} faces (a real boolean, not a sentinel)`,
      })))),
      table: tableView(['measure', 'level', 'positive', 'denominator'],
        b.per_person.map(p => [p.label, 'cluster', full(p.computed), full(p.total)])
          .concat(b.flags.map(fl => [fl.label, 'face', full(fl.yes), full(fl.total)]))),
    }),
  ]));
  return box;
}

function sectionGeography(g) {
  const box = h('div');
  const dead = g.columns.filter(c => c.distinct <= 1);
  const allDead = g.columns.length > 0 && dead.length === g.columns.length;
  const zones = g.timezones;
  box.appendChild(h('h2', { class: 'rule',
    text: allDead ? 'The location columns hold nothing here' : 'Where the photographs were taken' }));

  box.appendChild(grid([
    figure({
      title: allDead || !g.with_latitude
        ? 'No photo locations in this library'
        : `${full(g.with_latitude)} of ${full(g.assets)} photographs carry a latitude in the valid range`,
      note: allDead
        ? `Each of the ${full(g.columns.length)} coordinate column${s(g.columns.length)} iKnow checks holds at `
          + `most one value across the ${full(g.assets)} photographs, so there is nothing to map.`
        : `Counted as rows whose latitude lies between −90 and 90. iKnow counts them and does not draw them.`,
      chart: h('div', {}, g.columns.map(c => meter({
        value: c.distinct, max: g.assets,
        label: `${c.column} — ${full(c.distinct)} distinct value${s(c.distinct)} across `
             + `${full(g.assets)} assets`
             + (c.distinct === 1 && c.lo !== null ? ` (every row reads ${full(c.lo)})` : '')
             + (c.nulls === g.assets ? ' · null on every row' : ''),
      }))),
      table: tableView(['column', 'distinct values', 'minimum', 'maximum', 'nulls'],
        g.columns.map(c => [c.column, full(c.distinct),
                            c.lo === null ? '—' : full(c.lo),
                            c.hi === null ? '—' : full(c.hi), full(c.nulls)])),
    }),
    zones.length ? figure({
      title: 'The time zone recorded with each photograph',
      note: `${full(zones.length)} distinct zone${s(zones.length)} across ${full(g.timezone_rows)} `
          + `photographs. A zone is coarse, but it can hint at travel.`,
      chart: bars(zones.map(z => ({
        label: z.zone, value: z.n, meta: `photograph${s(z.n)}`,
      })), { width: 760, labelW: 160, rowH: 26, emphasis: 0,
             valueFmt: counted('photograph', 'photographs') }),
      table: tableView(['time zone', 'photographs', 'share'],
        zones.map(z => [z.zone, full(z.n), pct(z.n, g.timezone_rows)])),
    }) : null,
  ]));
  return box;
}

function sectionTimeline(timeline) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'How much of this the library has been accumulating, and for how long' }));

  if (!timeline.length) {
    box.appendChild(h('div', { class: 'grid' }, [h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h3', { text: 'No dated photograph in this library' })]),
      note('Not a quiet year — no asset in the store carries a creation date, so there is no time '
         + 'axis to draw.'),
    ])]));
    return box;
  }

  const dense = denseMonths(timeline);
  const populated = timeline.length;
  const totals = timeline.reduce((t, r) => ({
    assets: t.assets + r.assets, videos: t.videos + r.videos,
  }), { assets: 0, videos: 0 });
  const peak = timeline.reduce((m, r) => (r.assets > m.assets ? r : m), timeline[0] || { assets: 0 });
  const peakPeople = timeline.reduce((m, r) => (r.people > m.people ? r : m), timeline[0] || { people: 0 });

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'Photographs and videos per month',
      note: `${full(totals.assets)} untrashed assets, ${full(totals.videos)} of them video, across `
          + `${full(populated)} month${s(populated)} that hold anything — drawn over the full `
          + `${full(dense.length)}-month span so the empty months read as empty rather than being `
          + `closed up. The busiest month holds ${full(peak.assets)} assets. Volume and the number `
          + `of distinct people are different measures on different scales, so they are two `
          + `charts, not one chart with two axes.`,
      chart: columns(dense.map(r => ({
        label: r.month, value: r.assets,
        sub: r.videos ? `${full(r.videos)} video${s(r.videos)}` : '',
      })), { width: 1120, labelEvery: 12, color: ACCENT }),
      table: tableView(['month', 'assets', 'videos', 'assets containing a face', 'distinct clusters seen'],
        timeline.map(r => [r.month, full(r.assets), full(r.videos),
                           full(r.assets_with_face), full(r.people)])),
    })));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'Distinct people seen per month',
      note: `How many separate face clusters appear in a given month. A peak here is a gathering: `
          + `the busiest month puts ${full(peakPeople.people)} distinct people in front of the `
          + `camera. This is the series that identifies when the owner was with a crowd, and it `
          + `needs no photograph, no name and no location to read.`,
      chart: lines([{
        label: 'distinct face clusters',
        color: ACCENT,
        points: dense.map(r => ({ x: monthTs(r.month), y: r.people })),
      }], { width: 1120, height: 230, xFmt: month, area: true }),
      table: tableView(['month', 'distinct clusters seen', 'assets containing a face'],
        timeline.map(r => [r.month, full(r.people), full(r.assets_with_face)])),
    })));
  return box;
}

function sectionMemories(m) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'The narratives the device wrote about this life without being asked' }));

  const cats = m.by_category;
  const rows = cats.map(c => ({
    label: `category ${full(c.category)}${c.subcategory ? ` · ${full(c.subcategory)}` : ''}`,
    value: c.n,
    meta: `${full(c.rejected)} rejected · ${full(c.plays)} play${s(c.plays)}`
        + (c.first ? ` · ${day(c.first)} to ${day(c.last)}` : ''),
  }));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'Auto-generated Memories by category',
      note: `${full(m.total)} Memories, ${full(m.titled)} of them carrying a machine-written title. `
          + `Category codes are numeric because no label table for them ships in this bundle, so `
          + `the page does not name them. `
          + (m.viewed_rows === 0 && m.played_rows > 0
              ? `The view counter reads zero on every row, yet ${full(m.played_rows)} of these Memories `
                + `have a non-zero play count totalling ${full(m.play_sum)}, so the view counter does not `
                + `track viewing here and the page does not chart it.`
              : `${full(m.viewed_rows)} have a non-zero view count and ${full(m.played_rows)} a non-zero play count.`),
      chart: bars(rows, { width: 1120, labelW: 200, rowH: 30, emphasis: 0,
                          valueFmt: counted('memory', 'memories') }),
      table: tableView(['category', 'subcategory', 'memories', 'titled', 'rejected', 'plays', 'view count', 'first', 'last'],
        cats.map(c => [full(c.category), full(c.subcategory), full(c.n), full(c.titled),
                       full(c.rejected), full(c.plays), full(c.views),
                       c.first ? day(c.first) : '—', c.last ? day(c.last) : '—'])),
    })));

  box.appendChild(grid([
    figure({
      title: 'What happened to them',
      note: `The informative signals are the ones that record a human reacting. `
          + `${full(m.rejected_rows)} of ${full(m.total)} Memories were rejected, `
          + `${full(m.played_rows)} were played, ${full(m.shared_rows)} shared, and `
          + `${full(m.with_view_date)} carry a last-viewed date. `
          + (m.curated
              ? `Between them they curate ${full(m.curated.assets)} distinct photographs through `
              + `${full(m.curated.links)} links — the same photographs, re-cut into `
              + `${full(m.curated.memories)} stories.`
              : ''),
      chart: h('div', {}, [
        meter({ value: m.titled, max: m.total,
                label: `${full(m.titled)} of ${full(m.total)} carry a machine-written title` }),
        meter({ value: m.played_rows, max: m.total,
                label: `${full(m.played_rows)} were played at least once (${full(m.play_sum)} plays in total)` }),
        meter({ value: m.rejected_rows, max: m.total,
                label: `${full(m.rejected_rows)} were rejected` }),
        meter({ value: m.viewed_rows, max: m.total,
                label: `${full(m.viewed_rows)} have a non-zero view count` }),
      ]),
      table: tableView(['signal', 'memories', 'share of all'], [
        ['carry a machine-written title', full(m.titled), pct(m.titled, m.total)],
        ['played at least once', full(m.played_rows), pct(m.played_rows, m.total)],
        ['rejected', full(m.rejected_rows), pct(m.rejected_rows, m.total)],
        ['shared', full(m.shared_rows), pct(m.shared_rows, m.total)],
        ['carry a last-viewed date', full(m.with_view_date), pct(m.with_view_date, m.total)],
        ['non-zero view count', full(m.viewed_rows), pct(m.viewed_rows, m.total)],
      ]),
    }),
  ]));
  return box;
}

function sectionScenes(sc) {
  const box = h('div');
  box.appendChild(h('h2', { class: 'rule', text: 'The scene classifier needs two hops, and the short path lies' }));

  const rows = sc.top.map(t => ({
    label: `scene ${full(t.scene)}`,
    value: t.assets,
    meta: `${pct(t.assets, sc.linked.assets)} of classified photographs · mean confidence ${conf(t.conf)}`,
    color: ACCENT,
  }));
  const sentinels = sc.sentinels.map(t => ({
    label: `code ${full(t.scene)}`,
    value: t.assets,
    meta: `within ${full(sc.int32_max - t.scene)} of the 32-bit maximum — a derived class, not a scene`,
    color: SECOND,
  }));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: `The scene classes covering most of the library, at confidence ${conf(sc.threshold)} and above`,
      note: `${full(sc.classifications)} scene classifications sit on this library, mean confidence `
          + `${conf(sc.mean_confidence)} — so an unthresholded chart is noise, and this one is cut `
          + `at ${conf(sc.threshold)}. The classification table has no direct link to a photograph: `
          + `it points at an analysis-attributes row, which points at the asset. Taking the short `
          + `path does not return nothing, which would be obvious — it returns `
          + `${full(sc.naive.rows)} rows over ${full(sc.naive.assets)} assets against the correct `
          + `${full(sc.linked.rows)} rows over ${full(sc.linked.assets)}, a plausible-looking `
          + `answer about the wrong photographs. Showing the top ${Math.min(sc.cap, sc.real_pairs)} `
          + `of ${full(sc.real_pairs)} real scene/type pairs. The codes stay numeric because no `
          + `scene taxonomy ships in this bundle.`,
      legend: legend([
        { label: 'scene classes', color: ACCENT },
        { label: 'derived / sentinel codes, kept separate', color: SECOND },
      ]),
      chart: bars(rows.concat(sentinels), { width: 1120, labelW: 160, rowH: 26,
                                            valueFmt: counted('photograph', 'photographs') }),
      table: tableView(['scene code', 'classification type', 'photographs', 'classifications', 'mean confidence', 'kind'],
        sc.top.concat(sc.sentinels).map(t => [full(t.scene), full(t.kind), full(t.assets),
                                              full(t.n), conf(t.conf),
                                              t.sentinel ? 'derived / sentinel' : 'scene'])),
    })));

  box.appendChild(wideGrid(
    figure({
      wide: true,
      title: 'The hop that has to be taken',
      legend: legend([
        { label: 'the correct path', color: ACCENT },
        { label: 'the short path, answering about other photographs', color: SECOND },
        { label: 'the library itself, for scale', color: MUTED },
      ]),
      note: (sc.attr_rows === sc.attr_assets
              ? `The bridge table is exactly one row per photograph — ${full(sc.attr_rows)} rows over `
                + `${full(sc.attr_assets)} assets — which is why the wrong join looks right: `
              : `The bridge table holds ${full(sc.attr_rows)} rows over ${full(sc.attr_assets)} assets. `
                + `The wrong join can still look right: `)
          + `the identifiers are dense integers in the same range, so they match, just not with the `
          + `photograph you meant. ${full(sc.sentinel_pairs)} of the ${full(sc.pairs)} pairs above `
          + `the threshold are codes crowding the top of the signed 32-bit range; they reach up to `
          + `${full(sc.sentinel_assets)} photographs and would own the head of any naive ranking, `
          + `so they are segregated rather than dropped.`,
      chart: bars([
        { label: 'correct two-hop join', value: sc.linked.assets, meta: 'distinct photographs', color: ACCENT },
        { label: 'short path, wrong answer', value: sc.naive.assets, meta: 'distinct photographs', color: SECOND },
        { label: 'photographs in the library', value: sc.attr_assets, meta: 'assets with an analysis row', color: MUTED },
      ], { width: 1120, labelW: 240, rowH: 32,
           valueFmt: counted('photograph', 'photographs') }),
      table: tableView(['path', 'rows returned', 'distinct photographs'], [
        ['classification → analysis attributes → asset', full(sc.linked.rows), full(sc.linked.assets)],
        ['classification → asset directly', full(sc.naive.rows), full(sc.naive.assets)],
        ['analysis-attribute rows in the library', full(sc.attr_rows), full(sc.attr_assets)],
      ]),
    })));
  return box;
}
