/* kinship.js — the inferred relationship scorecard.
 *
 * One store on this machine holds a row per person and a score column per
 * relationship: mother, father, partner, child, sibling. The scores are the
 * device's; a pair of classifiers wrote a number into every cell.
 *
 * The page is built around four things that are easy to get wrong, each of
 * which is measured at render time rather than assumed:
 *
 *   1. columns that are zero on every row are drawn as unused columns, never
 *      as a score of zero;
 *   2. whether the broad heads are rollups of other columns is tested on
 *      screen, decomposition by decomposition;
 *   3. a column that is a bit-for-bit copy of another is shown as one, and
 *      iKnow's own checks across other tables sit beside it, marked as iKnow's;
 *   4. the device owner is dropped from every ranking.
 *
 * No value on this page is written in this file. Column names, people, scores,
 * counts, thresholds and even the abbreviations on the heatmap axis are all
 * derived at runtime from /api/kinship.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, heatmap, hero, meter, tableView,
         compact, full, pct } from '../viz.js';

export const meta = {
  id: 'kinship',
  nav: 'Kinship scorecard',
  group: 'What it concluded',
  kicker: 'Inferred relationships',
  title: 'Your Mac scores the people it knows on how likely each one is to be family, and writes the scores down',
  blurb: 'One table on this machine holds a score per relationship column for each person the device chose to score. By the model\'s shipped feature list, its inputs include things you declared (a relation or a shared address on a Contacts card, a favourite, an emergency contact, Family Sharing) and how often you message, call and appear in photos with each person. Nobody typed the scores themselves.',
};

/* ---------- presentation helpers (no values, only formatting) ---------- */

const score = v => (v === null || v === undefined
  ? '—'
  : Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

/** camelCase column names -> short, unique axis labels. Derived, not written. */
function abbreviate(names) {
  const out = new Map();
  const taken = new Set();
  for (const n of names) {
    const words = String(n).split(/(?=[A-Z])/).filter(Boolean);
    const base = words.length > 1
      ? words.map(w => w[0]).join('').toUpperCase()
      : String(n).slice(0, 4);
    let label = base, i = 2;
    while (taken.has(label)) label = base + i++;
    taken.add(label);
    out.set(n, label);
  }
  return out;
}

const yes = b => (b ? 'yes' : '—');
const grid = kids => h('div', { class: 'grid' }, kids.filter(Boolean));
// † marks a name the live graph no longer holds; it survives only in the retraction
// archive (vocab.withdrawn_names). Every figure that shows one says so in its note.
const dagger = (name, withdrawn) => (name && withdrawn ? name + ' †' : name);
const person = p => dagger(p.name, p.name_withdrawn) || 'unnamed ' + p.id.slice(-4);
const daggerNote = rows => (rows.some(r => r.name_withdrawn || (r.archived || []).length)
  ? ' † marks what the live graph no longer holds, a name or a check: it is read from the withdrawn '
    + 'rows in expired_stable_graph, under the same entity id the scorecard scores, for people with no '
    + 'live row left.'
  : '');
// How many candidates pass every check, counted rather than stated.
const allPassLine = cv => {
  const n = cv.rows.filter(r => r.n === cv.checks.length).length;
  return n === 0 ? 'No row carries all of them.'
    : n === 1 ? 'One row carries all of them.' : `${n} rows carry all of them.`;
};
// A check's cell: yes, with † when only the retraction archive still says so.
const yesFrom = (v, row, key) => yes(v) + (v && (row.archived || []).includes(key) ? ' †' : '');

/* ---------- the page ---------- */

export async function render(root) {
  const d = await api('kinship');

  const cols = d.column_order;
  const short = abbreviate(cols);
  const headCut = d.cuts.find(c => c.column === d.head) || { ge_half: 0, nonzero: 0, max: 0 };
  const cap = 30;

  /* ---------- lead ---------- */

  root.appendChild(hero({
    value: d.total,
    label: 'people carry a relationship score in this one table',
    detail: `${cols.length} score columns each · ${d.ranked} of them ranked on this page, `
          + `with the device owner's own row excluded from every ordering`,
  }));

  root.appendChild(h('div', { class: 'grid grid-tight' }, [
    statTile({
      label: `at or above iKnow’s 0.5 cut on ${d.head}`,
      value: headCut.ge_half,
      sub: `${pct(headCut.ge_half, d.ranked)} of ${d.ranked} ranked people`,
    }),
    statTile({
      label: 'columns that never fired',
      value: d.empty_columns.length,
      sub: d.empty_columns.join(' · ') + ' — zero on every row',
      tone: 'warning',
    }),
    statTile({
      label: 'specific relationship claims',
      value: d.claims.length,
      sub: `over ${d.claim_people.length} people, in ${d.claim_columns.length} named columns`,
    }),
    statTile({
      label: 'distinct values in the whole table',
      value: d.quantisation.distinct,
      sub: `filling ${compact(d.quantisation.nonzero_cells)} non-zero cells of `
         + `${compact(d.quantisation.cells)}`,
    }),
  ]));

  /* ---------- 1. the matrix ---------- */

  const shown = d.matrix.slice(0, cap);
  const rowLabel = r => dagger(r.label, r.name_withdrawn);
  const cells = [];
  shown.forEach(r => cols.forEach((c, j) => {
    cells.push({ row: rowLabel(r), col: short.get(c), value: r.scores[j] });
  }));

  /* The axis is abbreviated to fit 17 columns into the band, so every header
   * expands on hover and on keyboard focus: the full column name as the
   * heading, then what that column actually did across the table. All of it is
   * measured at request time — the header explains itself rather than sending
   * the reader back to the paragraph above the chart. */
  const expand = new Map();
  for (const [fullName, abbr] of short) expand.set(abbr, fullName);
  const stats = new Map(d.columns.map(c => [c.name, c]));

  const colInfo = abbr => {
    const name = expand.get(abbr) || abbr;
    const s = stats.get(name);
    const rows = [];
    if (!s) return { title: name, rows };
    if (s.empty) {
      rows.push({ label: `never used — zero on all ${full(d.total)} rows`, value: '0' });
      return { title: name, rows };
    }
    rows.push({ label: `people scored above zero, of ${full(d.total)}`, value: full(s.nonzero) });
    rows.push({ label: 'highest score in this column', value: score(s.max) });
    rows.push({ label: 'at or above iKnow’s 0.5 cut', value: full(s.ge_half) });
    rows.push({ label: 'distinct non-zero values', value: full(s.distinct_nonzero) });
    return { title: name, rows };
  };

  root.appendChild(grid([figure({
    wide: true,
    title: 'Every person, every column',
    note: `Sorted by ${d.head}, the broadest head. Showing the top ${shown.length} of `
        + `${d.ranked} ranked people — the table view lists all of them. Axis labels are `
        + `abbreviated: ${cols.map(c => `${short.get(c)} = ${c}`).join(', ')}. `
        + `${d.empty_columns.length} of the ${cols.length} columns `
        + `(${d.empty_columns.join(', ')}) run flat grey from top to bottom because they are `
        + `zero on every row of the table — nobody was scored low there, the columns were never `
        + `used at all. ${d.coverage.named} of ${d.coverage.scored} people resolve to a name in `
        + `the live graph`
        + (d.coverage.named_withdrawn
            ? ` and ${d.coverage.named_withdrawn} more to a name only the retraction archive holds`
            : '')
        + `; the rest are scored anonymously and still ranked.${daggerNote(d.matrix)}`,
    chart: heatmap(cells, shown.map(rowLabel), cols.map(c => short.get(c)),
      { width: 1100, cellH: 20, labelW: 170, unit: 'score', colInfo }),
    table: tableView(['person', ...cols],
      d.matrix.map(r => [rowLabel(r), ...r.scores.map(score)])),
  })]));

  /* ---------- 2. the cut ---------- */

  const meters = h('div', {});
  for (const c of d.cuts.filter(x => x.nonzero > 0).sort((a, b) => b.ge_half - a.ge_half)) {
    meters.appendChild(meter({
      value: c.ge_half,
      max: d.ranked,
      label: `${c.column} — ${c.ge_half} of ${d.ranked} people reach 0.5 `
           + `(highest score on this column: ${score(c.max)})`,
    }));
  }

  const specific = d.cuts.filter(c => d.claim_columns.includes(c.column) && c.nonzero > 0);
  const reaching = specific.filter(c => c.ge_half > 0).length;
  const specificLine = !specific.length ? ''
    : reaching === 0
      ? `None of the ${specific.length} columns that name a specific relationship reaches 0.5 here.`
      : `${reaching} of the ${specific.length} columns that name a specific relationship reach 0.5 here.`;
  root.appendChild(grid([
    figure({
      title: `People at or above iKnow’s 0.5 cut on ${d.head}`,
      note: `The bands the scored people fall into. The 0.5 cut is iKnow’s; the store applies no cut `
          + `of its own. Bands at or above it are highlighted, the rest greyed. The ranking excludes you.`,
      chart: bars(d.bands.map(b => ({
        label: b.band,
        value: b.n,
        meta: 'people',
        color: b.above_cut ? 'var(--series-1)' : 'var(--text-muted)',
      })), { labelW: 130, rowH: 32, unit: ' people' }),
      table: tableView(['band', 'people', 'share of ranked'],
        d.bands.map(b => [b.band, b.n, pct(b.n, d.ranked)])),
    }),
    figure({
      title: 'Where iKnow’s 0.5 cut falls on every column that ever fired',
      note: `One meter per live column, all against the same denominator: the ${d.ranked} ranked `
          + `people. ${specificLine}`,
      chart: meters,
      table: tableView(['column', 'people above zero', 'people at or above 0.5', 'highest score'],
        d.cuts.map(c => [c.column, c.nonzero, c.ge_half, score(c.max)])),
    }),
  ]));

  /* ---------- 3. the named claims ---------- */

  const multi = d.claim_people.filter(p => p.n_labels > 1).length;

  root.appendChild(grid([figure({
    wide: true,
    title: 'Relationship columns that score a person above zero',
    note: `Every non-zero cell in a column that names a specific relationship: ${d.claims.length} `
        + `claims over ${d.claim_people.length} people. The bar is not a confidence — it is how `
        + `many relationship columns score that person above zero. ${multi} of the `
        + `${d.claim_people.length} have more than one. `
        + (d.rollup_labels.length
            ? `${d.rollup_labels.join(', ')} equal${d.rollup_labels.length === 1 ? 's' : ''} the sum `
              + `of other columns on every row here. That is arithmetic measured on this Mac, not `
              + `a statement about how the store computes them: with few people scored and few `
              + `distinct score values, a sum can hold by coincidence. `
              + `${d.rollup_labels.length === 1 ? 'It is' : 'They are'} flagged in the table and `
              + `never dropped. `
            : '')
        + `The owner's own row is excluded.${daggerNote(d.claim_people)}`,
    chart: bars(d.claim_people.map(p => ({
      label: person(p),
      value: p.n_labels,
      meta: 'relationship columns above zero for this person',
    })), { labelW: 210, rowH: 30, unit: ' labels', valueFmt: v => String(v) }),
    table: tableView(['relationship', 'person', 'score', 'exact sum of other columns',
                      'identical column(s)', 'reachable handle', 'photo face cluster'],
      d.claims.map(c => [c.label, dagger(c.name, c.name_withdrawn) || 'unnamed', score(c.score), yes(c.rollup),
                         c.twins.join(', ') || '—', yesFrom(c.reachable, c, 'reachable'),
                         yesFrom(c.face, c, 'face')])),
  })]));

  /* ---------- 4. the convergence ---------- */

  const cv = d.convergence;
  const checkKeys = cv.checks.map(c => c.key);
  const twinLine = cv.twin && cv.twin.length
    ? `Its values are identical, row for row, to the `
      + `${cv.twin.join(' and ')} column${cv.twin.length > 1 ? 's' : ''} across all ${d.total} rows. `
    : '';

  root.appendChild(grid([figure({
    wide: true,
    title: cv.focus
      ? `The ${cv.focus} column, next to iKnow’s checks`
      : 'The specific columns, next to iKnow’s checks',
    note: (cv.focus
        ? `The ${cv.focus} column tops out at ${score(cv.focus_max)}, with ${cv.focus_nonzero} people `
          + `at that one value. ${twinLine}`
        : '')
      + `iKnow’s checks are a separate test. Each bar counts how many of the `
      + `${cv.checks.length} checks that person passes: `
      + `${cv.checks.map(c => c.label).join('; ')}. The group the store holds as an entity has `
      + `${cv.group_size} members, the Family-Sharing circle is ${cv.circle_tokens} shared `
      + `token${cv.circle_tokens === 1 ? '' : 's'}, `
      + `and the contact ranking is drawn from the ${cv.volume_people} people whose handles resolve `
      + `into the communication log. ${allPassLine(cv)}${daggerNote(cv.rows)}`,
    chart: bars(cv.rows.map(r => ({
      label: person(r),
      value: r.n,
      meta: `of ${cv.checks.length} iKnow checks`
          + (r.n_archived ? `, ${r.n_archived} of them only in the retraction archive` : ''),
    })), { labelW: 210, rowH: 32, emphasis: 0, unit: ' checks', valueFmt: v => String(v) }),
    table: tableView(
      ['person', cv.focus ? `${cv.focus} score` : 'claim score', d.head, 'interactions',
       ...cv.checks.map(c => c.label)],
      cv.rows.map(r => [dagger(r.name, r.name_withdrawn) || 'unnamed', score(r.score), score(r.head),
                        compact(r.interactions), ...checkKeys.map(k => yesFrom(r.checks[k], r, k))])),
  })]));

  /* ---------- 5. independence, copied columns, unused columns ---------- */

  const hypMeters = h('div', {});
  for (const hy of d.structure.hypotheses) {
    hypMeters.appendChild(meter({
      value: hy.violations,
      max: hy.total,
      label: `${hy.lhs} = ${hy.terms.join(' + ')} — fails on ${hy.violations} of ${hy.total} rows`
           + (hy.lhs_below_sum
               ? `, and on ${hy.lhs_below_sum} of them the head comes out BELOW its own parts`
               : ''),
    }));
  }

  root.appendChild(grid([
    figure({
      title: 'Are the broad heads sums of the columns beside them?',
      note: `If the wide heads were rollups of the specific columns, each would equal a sum of them. `
          + `Each decomposition is tested against every row; the meters show how often it fails. `
          + (d.structure.hypotheses.some(hy => hy.lhs_below_sum > 0)
              ? `On some rows the head comes out lower than the parts it would contain, which no sum can do. `
              : '')
          + `Where a decomposition fails, adding a head to its parts double-counts. Exact sums that do `
          + `hold were found by searching every combination of up to three live columns; they are `
          + `listed in the next panel.`,
      chart: hypMeters,
      table: tableView(['tested decomposition', 'rows tested', 'rows where it fails',
                        'rows where the head is below the sum'],
        d.structure.hypotheses.map(hy =>
          [`${hy.lhs} = ${hy.terms.join(' + ')}`, hy.total, hy.violations, hy.lhs_below_sum])),
    }),
    figure({
      title: 'What each column actually holds',
      note: `Population per column over all ${d.total} rows. `
          + (d.empty_columns.length
              ? `${d.empty_columns.join(', ')} draw no bar: no one on this Mac has a score there; `
                + `the columns exist in the schema. `
              : '')
          + `The columns whose value vectors are identical row for row: `
          + (d.structure.identical.length
              ? d.structure.identical.map(k => k.join(' = ')).join('; ')
              : 'none') + `.`,
      chart: bars(d.columns.map(c => ({
        label: c.name,
        value: c.nonzero,
        meta: c.empty ? 'never used on this device' : 'people scored above zero',
      })), {
        labelW: 150, rowH: 26,
        valueFmt: v => (v === 0 ? 'never used' : compact(v) + ' people'),
      }),
      table: tableView(['column', 'people above zero', 'at or above 0.5', 'highest',
                        'distinct non-zero values', 'identical to', 'exact sum of'],
        d.columns.map(c => {
          const klass = d.structure.identical.find(k => k.includes(c.name)) || [];
          const ident = d.structure.identities.filter(i => i.target === c.name);
          return [c.name, c.nonzero, c.ge_half, score(c.max), c.distinct_nonzero,
                  klass.filter(x => x !== c.name).join(', ') || '—',
                  ident.map(i => i.terms.join(' + ')).join('  |  ') || '—'];
        })),
    }),
  ]));

  /* ---------- 6. quantisation ---------- */

  const ladder = d.quantisation.ladder.slice(0, 12);
  const covered = ladder.reduce((s, r) => s + r.n, 0);

  root.appendChild(grid([figure({
    title: `The scores take ${d.quantisation.distinct} distinct non-zero values`,
    note: `Every non-zero cell in the table, grouped by its exact value. The top ${ladder.length} `
        + `values account for ${covered} of the ${d.quantisation.nonzero_cells} non-zero cells `
        + `(${pct(covered, d.quantisation.nonzero_cells)}); the whole table uses only `
        + `${d.quantisation.distinct} distinct non-zero values across `
        + `${compact(d.quantisation.cells)} cells. A tall bar is one value repeated across many people, `
        + `possibly what the classifier gives when it has little to go on. A value here should not be read `
        + `as a percentage chance, and a low one not as a denial. Showing the `
        + `top ${ladder.length}; the table lists every value.`,
    chart: bars(ladder.map(r => ({ label: score(r.value), value: r.n, meta: 'cells at this value' })),
      { labelW: 110, rowH: 26, unit: ' cells' }),
    table: tableView(['value', 'cells', 'share of non-zero cells'],
      d.quantisation.ladder.map(r => [score(r.value), r.n, pct(r.n, d.quantisation.nonzero_cells)])),
  })]));

  /* ---------- 7. the evidence ledger ---------- */

  if (d.evidence.length) {
    const gaps = d.evidence
      .filter(e => e.evaluated > e.true)
      .sort((a, b) => (b.evaluated - b.true) - (a.evaluated - a.true));
    const widest = gaps[0];
    const evRows = d.evidence.reduce((n, e) => n + e.evaluated, 0);
    const evTrue = d.evidence.reduce((n, e) => n + e.true, 0);
    const fixedRatio = x => (x >= 10 ? String(Math.round(x)) : x.toFixed(1));

    root.appendChild(grid([
      figure({
        title: 'Which observed facts the tagger actually looked at',
        note: `The feature store keeps one row per person per question the tagger asked, and the `
            + `answer is a binary property-list blob, decoded here at request time. A row means the `
            + `question was ASKED about that person — nothing more. `
            + `${d.coverage.evaluated} of the ${d.coverage.scored} scored people went through this `
            + `pass at all, and the entire question set is ${d.evidence.length} items long: `
            + `${d.evidence.map(e => e.fact).join(', ')}. The shipped model takes other inputs too, so `
            + `this list is not the whole basis for a score.`,
        chart: bars(d.evidence.map(e => ({
          label: e.fact, value: e.evaluated, meta: 'people the question was asked about',
        })), { labelW: 190, rowH: 28, unit: ' people' }),
        table: tableView(['observed fact', 'people evaluated', 'came back true', 'came back false',
                          'answer values'],
          d.evidence.map(e => [e.fact, e.evaluated, e.true, e.false,
                               e.values.map(v => `${v.value} × ${v.n}`).join(', ')])),
      }),
      figure({
        title: 'How many of the answers were yes',
        note: `The same ledger counting only the answers that came back true. `
            + (widest
                ? `the widest gap is ${widest.fact}, asked about ${widest.evaluated} people and `
                  + `true for ${widest.true}. `
                : '')
            + (evTrue > 0
                ? `Counting rows instead of answers would count ${fixedRatio(evRows / evTrue)} times as many facts. `
                : `None of the answers came back true. `)
            + `Facts whose answer is a category rather than a yes/no carry an `
            + `opaque knowledge-base identifier; they count as answered here and their values are `
            + `in the table above.`,
        chart: bars(d.evidence.filter(e => e.true > 0).sort((a, b) => b.true - a.true).map(e => ({
          label: e.fact, value: e.true, meta: 'people the fact is true for',
        })), { labelW: 190, rowH: 28, unit: ' people' }),
        table: tableView(['observed fact', 'evaluated', 'true', 'true share'],
          d.evidence.map(e => [e.fact, e.evaluated, e.true, pct(e.true, e.evaluated)])),
      }),
    ]));
  } else {
    root.appendChild(grid([figure({
      title: 'Which observed facts the tagger actually looked at',
      note: 'The feature store holds nothing on this device, so the evidence behind the scores '
          + 'cannot be reconstructed here. The scores themselves remain, unexplained.',
      chart: h('div', { class: 'empty', text: 'no evidence rows captured in this snapshot' }),
    })]));
  }

  /* ---------- 8. how deep it goes ---------- */

  const prof = d.coverage.profiled || { people: 0, features: 0 };

  root.appendChild(grid([figure({
    title: 'How deep the modelling actually goes',
    note: `Three populations out of the same machinery. Everyone gets a score. A subset gets the `
        + `discrete-fact pass. A smaller group gets the full behavioural profile — `
        + `${prof.features} features per person. `
        + `${d.coverage.expired_only} of the scored rows point at entities that no longer exist in `
        + `the live graph: the score is still there, the entity is not.`,
    chart: bars([
      { label: 'carry a relationship score', value: d.coverage.scored, meta: 'people' },
      { label: 'resolve to a live graph entity', value: d.coverage.in_graph, meta: 'people' },
      { label: 'resolve to a name in the live graph', value: d.coverage.named, meta: 'people' },
      ...(d.coverage.named_withdrawn
        ? [{ label: 'named only in the retraction archive', value: d.coverage.named_withdrawn, meta: 'people' }]
        : []),
      { label: 'went through the fact pass', value: d.coverage.evaluated, meta: 'people' },
      { label: 'have the full behavioural profile', value: prof.people, meta: 'people' },
    ], { labelW: 230, rowH: 30, unit: ' people' }),
    table: tableView(['population', 'people', 'share of scored'], [
      ['carry a relationship score', d.coverage.scored, pct(d.coverage.scored, d.coverage.scored)],
      ['resolve to a live graph entity', d.coverage.in_graph, pct(d.coverage.in_graph, d.coverage.scored)],
      ['exist only among retracted facts', d.coverage.expired_only, pct(d.coverage.expired_only, d.coverage.scored)],
      ['resolve to a name in the live graph', d.coverage.named, pct(d.coverage.named, d.coverage.scored)],
      ...(d.coverage.named_withdrawn
        ? [['named only in the retraction archive', d.coverage.named_withdrawn,
            pct(d.coverage.named_withdrawn, d.coverage.scored)]]
        : []),
      ['went through the discrete-fact pass', d.coverage.evaluated, pct(d.coverage.evaluated, d.coverage.scored)],
      [`have all ${prof.features} behavioural features`, prof.people, pct(prof.people, d.coverage.scored)],
    ]),
  })]));
}
