/* device.js — the installed-app inventory, and the token scheme over it.
 *
 * The page makes one argument and proves it in the reader's own browser.
 *
 * Apple stores each installed application twice in the same file: once as a
 * plaintext reverse-DNS bundle id, and once as a 44-character base64 token that
 * reads like an anonymised handle. The token is unsalted base64(sha256(bundle
 * id)). The bundle-id vocabulary is public and finite. So the token conceals
 * nothing from anyone willing to compute a list — it defeats browsing, and it
 * does not defeat guessing.
 *
 * Rather than assert that, the centre of this page is a live demonstration:
 * the reader types an identifier, crypto.subtle hashes it here, and the result
 * is tested against the real tokens the server read out of the store. The
 * padding trap is shown rather than hidden — the naive 43-character
 * construction never equals the 44-character stored form, and the page displays
 * both comparisons side by side so the failure mode is visible.
 *
 * The capability classification is a rule set written HERE, in code, over
 * generic capability words. It contains no product name, no vendor name and no
 * value out of this store — which is why it deliberately under-matches, and why
 * the page reports its own coverage instead of implying completeness.
 *
 * Nothing on this page is written in this file. Every app, publisher, token,
 * count and date comes from /api/device at render time.
 */

import { api } from '../app.js';
import { h, figure, statTile, bars, columns, stackedBar, hero, legend,
         tableView, compact, full, pct, day, month, SERIES } from '../viz.js';

export const meta = {
  id: 'device',
  nav: 'Installed apps',
  group: 'The machinery',
  kicker: 'Installed applications',
  title: 'Every app on this Mac is written down in plain text',
  blurb: 'The graph lists the apps on this Mac by bundle id. Where it adds a token beside each one, this page re-derives it in your browser from the public id.',
};

/* ------------------------------------------------------------------ rules
 *
 * A capability classifier over bundle-id STRINGS. Every pattern below is a
 * generic capability word — no vendor, no product, nothing read off this
 * machine. That is a deliberate handicap: it means the rule set cannot have
 * been fitted to this device, and it means the counts it produces are a floor.
 * A full catalogue of bundle identifiers would classify all of it.
 */

const CLASS_RULES = [
  {
    name: 'Credential vaults & key stores',
    lead: true,
    re: /passw|passcode|passkey|keychain|keystore|vault|credential|authenticat|\botp\b|\b2fa\b|totp|lockbox/,
    stake: 'passwords and keys',
  },
  {
    name: 'Messaging, mail & calling',
    re: /messag|messeng|\bchat\b|\bsms\b|\bmms\b|\bmail\b|\bcall\b|incall|conferenc|\bmeet\b|\bvoip\b|telephon|\bphone\b|\btalk\b/,
    stake: 'messages and calls',
  },
  {
    name: 'Browsers & web engines',
    re: /browser|webkit|\bweb\b|\bwww\b|\bhtml\b|\bhttps?\b/,
    stake: 'browsing sessions and saved logins',
  },
  {
    name: 'Developer & AI tooling',
    re: /termin|\bshell\b|compil|debug|\bsdk\b|devtool|develop|\bdev\b|simulat|instrument|script|\bcode\b|automat|\bgit\b|repositor|\bai\b|\bllm\b|\bgpt\b/,
    stake: 'code and developer credentials',
  },
  {
    name: 'Finance & payments',
    re: /\bbank|\bpay\b|payment|wallet|invest|trading|stock|crypto|\bcoins?\b|financ|\bmoney\b|budget|\btax\b|expense|invoice|billing|\bcash\b|\bcard\b|checkout|ledger/,
    stake: 'financial accounts',
  },
  {
    name: 'VPN, proxy & tunnels',
    re: /vpn|wireguard|tunnel|\bproxy\b|\btor\b|\brelay\b|anonym|shadowsock/,
    stake: 'network tunnels',
  },
];

/* Records that are support processes rather than things a person launches.
 * Also generic words, and also measured rather than assumed. */
const SUPPORT_RE = /helper|agent|daemon|extension|launcher|instal|updater|framework|service|\bstub\b|plugin|widget|\bxpc\b|monitor|assistant|container|\bui\b/;

/** A bundle id, split into lowercase words: dots, dashes and camelCase humps
 *  are all word boundaries. The rules above match against this, not the raw
 *  string, so `\bweb\b` means the word and not the letters. */
function words(bundle) {
  const spaced = String(bundle)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return ' ' + spaced.replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase() + ' ';
}

/** The vendor half of a reverse-DNS id: the first two labels, after dropping a
 *  leading developer-team prefix when one is present. A string rule, not a
 *  lookup table. */
function vendorOf(bundle) {
  let parts = String(bundle).split('.');
  if (parts.length > 1 && parts[0].length === 10 && /^[0-9A-Z]+$/.test(parts[0])) parts = parts.slice(1);
  return parts.length > 1 ? parts.slice(0, 2).join('.') : parts[0];
}

/* ------------------------------------------------------------------ crypto */

const strip = s => String(s).replace(/=+$/, '');

/** The construction under test, run in this tab. localhost is a secure context,
 *  so crypto.subtle is available; if it is not, the page says so rather than
 *  quietly falling back to a claim. */
async function digest(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const octets = new Uint8Array(buf);
  let binary = '';
  for (const b of octets) binary += String.fromCharCode(b);
  return {
    bytes: octets.length,
    hex: [...octets].map(b => b.toString(16).padStart(2, '0')).join(''),
    b64: btoa(binary),
  };
}

/* ------------------------------------------------------------------ bits */

const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);

const note = text => h('p', { class: 'card-note', text });

function card(title, kids, wide) {
  const box = h('section', { class: 'card' + (wide ? ' card-wide' : '') });
  box.appendChild(h('header', { class: 'card-head' }, [h('h3', { text: title })]));
  for (const kid of kids) if (kid) box.appendChild(kid);
  return box;
}

/** One labelled line in the demo's read-out. */
function readout(label, valueNode) {
  const row = h('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = 'minmax(150px, 190px) 1fr';
  row.style.gap = '10px';
  row.style.padding = '5px 0';
  row.style.borderTop = '1px solid var(--grid)';
  row.style.alignItems = 'baseline';
  const key = h('span', { class: 'muted', text: label });
  key.style.fontSize = '11.5px';
  row.appendChild(key);
  row.appendChild(valueNode);
  return row;
}

function monoValue(text, tone) {
  const node = h('span', { class: 'mono', text });
  node.style.overflowWrap = 'anywhere';
  if (tone) node.style.color = `var(--status-${tone})`;
  return node;
}

function verdict(ok, text) {
  const node = h('span', { text: (ok ? '✓  ' : '✗  ') + text });
  node.style.fontSize = '12.5px';
  node.style.color = ok ? 'var(--status-good)' : 'var(--status-critical)';
  return node;
}

function field(placeholder) {
  const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder });
  Object.assign(input.style, {
    flex: '1 1 320px', minWidth: '0', padding: '7px 10px',
    border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)',
    background: 'var(--surface-2)', color: 'var(--text-primary)',
    font: 'inherit', fontFamily: 'var(--mono)', fontSize: '12px',
  });
  return input;
}

const button = (label, onclick) => h('button', { class: 'ghost', type: 'button', text: label, onclick });

/* ------------------------------------------------------------------ page */

export async function render(root) {
  const d = await api('device');
  const apps = d.apps || [];
  const c = d.counts || {};
  // 'graph', or 'biome' when the graph holds no application records and the
  // inventory is read from the App.InstalledApp set macOS 27 keeps instead.
  const inv = d.inventory || { source: 'graph', withdrawn_apps: 0 };
  const fromSet = inv.source === 'biome';
  const withdrawnApps = inv.withdrawn_apps
    ? `it withdrew ${full(inv.withdrawn_apps)}, which its retraction archive still holds`
    : '';

  if (!apps.length) {
    root.appendChild(h('div', { class: 'empty', text:
      'This store holds no application records on this device'
      + (withdrawnApps ? ` — ${withdrawnApps} — and no App.InstalledApp set could be read either.` : '.') }));
    return;
  }

  /* ---------- classification, computed here from the strings ---------- */

  const classified = apps.map(a => {
    const w = words(a.bundle);
    return {
      app: a,
      hits: CLASS_RULES.filter(r => r.re.test(w)).map(r => r.name),
      support: SUPPORT_RE.test(w),
      vendor: vendorOf(a.bundle),
    };
  });
  const byApp = new Map(classified.map(r => [r.app.id, r]));
  const byClass = new Map(CLASS_RULES.map(r => [r.name, []]));
  for (const row of classified) for (const name of row.hits) byClass.get(name).push(row.app);
  const matched = classified.filter(r => r.hits.length).length;
  const supportCount = classified.filter(r => r.support).length;

  const vendors = new Map();
  for (const row of classified) vendors.set(row.vendor, (vendors.get(row.vendor) || 0) + 1);
  const vendorRows = [...vendors.entries()].sort((a, b) => b[1] - a[1]);
  const topVendor = vendorRows[0];

  /* ---------- the namespace measurements ---------- */

  const nsRows = d.namespaces || [];
  const appNs = nsRows.find(n => n.ns === 'lsBundleRecord');
  const invertible = nsRows.filter(n => n.inverted > 0);
  const invertedTotal = nsRows.reduce((s, n) => s + n.inverted, 0);
  const notDigest = nsRows.filter(n => n.distinct && n.decodes_to_digest === 0);
  // Only the namespaces whose values really do decode to a 32-byte digest can
  // be "cracked" at all; the others are a different animal and are excluded
  // from the denominator rather than padding it.
  const digestDistinct = nsRows.reduce((s, n) => s + n.decodes_to_digest, 0);

  /* ---------- lead ---------- */

  root.appendChild(hero(fromSet ? {
    value: apps.length,
    label: 'applications this Mac keeps by name, in plain text, in one Biome set',
    detail: `The graph holds no application records on this Mac${withdrawnApps ? ` — ${withdrawnApps}` : ''}. `
          + `This inventory is read from App.InstalledApp, a Biome set macOS keeps: each app's bundle `
          + `id, display name and version. It stores no token, no publisher and no first-seen date, so the panels `
          + `that measured those have nothing to read.`,
  } : {
    value: apps.length,
    label: 'applications this Mac writes down by name, in plain text, in one file',
    detail: `${full(c.apps_with_token)} of them additionally appear as a base64 token that reads as an anonymised `
          + `handle — and for ${full(appNs ? appNs.rows_with_preimage_on_subject : 0)} of `
          + `${full(appNs ? appNs.rows : 0)} of those token rows, the string that hashes to the token is stored on `
          + `the very same subject.`,
  }));

  const liveTile = statTile({
    label: 'tokens reproduced in this browser',
    value: '—',
    sub: 'press verify in the panel below',
    tone: 'warning',
  });

  root.appendChild(h('div', { class: 'grid grid-tight' }, [
    statTile({
      label: 'references that wear a token',
      value: c.token_rows,
      sub: `${full(c.token_distinct)} distinct values across ${full(c.token_namespaces)} namespaces`,
    }),
    ...(digestDistinct ? [statTile({
      label: 'tokens re-derived from this file alone',
      value: invertedTotal,
      sub: `${pct(invertedTotal, digestDistinct)} of the ${full(digestDistinct)} that really are 32-byte digests, `
         + `using only the ${compact(c.wordlist)} strings the file already holds`,
    }), liveTile] : []),
    statTile({
      label: 'records a capability word matched',
      value: matched,
      sub: `${pct(matched, apps.length)} of the inventory — the rules below name no product, so this is a floor`,
      tone: 'warning',
    }),
  ]));

  /* ---------- 1. the live token demo ---------- */

  root.appendChild(h('hr', { class: 'rule' }));

  const demo = h('div');
  const input = field('type any identifier');
  input.setAttribute('aria-label', 'identifier to hash and look up against the store');
  const out = h('div');
  out.style.marginTop = '12px';
  const bulk = h('div');
  bulk.style.marginTop = '12px';
  bulk.style.fontSize = '12.5px';
  bulk.style.color = 'var(--text-secondary)';

  const tokens = d.tokens || [];
  const tokenIndex = new Map();
  for (const t of tokens) tokenIndex.set(strip(t.t), t);
  const appById = new Map(apps.map(a => [a.id, a]));

  let seedAt = 0;
  let runAt = 0;

  async function run() {
    const value = input.value;
    const mine = ++runAt;
    out.textContent = '';
    if (!value) return;

    let dg;
    try {
      dg = await digest(value);
    } catch (err) {
      out.appendChild(h('p', { class: 'card-note', text: 'This browser refused to expose crypto.subtle, so the hash cannot be computed here. Nothing else on the page depends on it.' }));
      return;
    }
    if (mine !== runAt) return;              // a newer keystroke already won

    const bare = strip(dg.b64);
    const hit = tokenIndex.get(bare);
    const stored = hit ? hit.t : null;

    out.appendChild(readout('you typed', monoValue(value)));
    out.appendChild(readout(`sha-256 (${dg.bytes} bytes)`, monoValue(dg.hex)));
    out.appendChild(readout(`base64, as most code emits it (${bare.length} chars)`, monoValue(bare)));
    out.appendChild(readout(`as this store writes it (${dg.b64.length} chars)`, monoValue(dg.b64)));

    if (stored) {
      out.appendChild(readout('strict equality vs the stored value',
        verdict(bare === stored, bare === stored
          ? 'equal'
          : 'not equal — the stored form keeps its base64 padding and the computed form drops it')));
      out.appendChild(readout('after stripping padding on both sides',
        verdict(true, 'identical — this token is the hash of what you just typed')));

      const parts = [`${full(hit.rows)} reference${hit.rows === 1 ? '' : 's'} in the store`,
                     `namespace ${hit.ns}`,
                     `${full(hit.subjects)} subject${hit.subjects === 1 ? '' : 's'}`];
      out.appendChild(readout('what it points at', h('span', { text: parts.join(' · '), })));

      const app = hit.app ? appById.get(hit.app) : null;
      if (app) {
        const bits = [app.name, app.publisher ? `published by ${app.publisher}` : null,
                      app.first_seen ? `first asserted ${day(app.first_seen)}` : null]
          .filter(Boolean).join(' · ');
        out.appendChild(readout('and the store says', h('span', { text: bits })));
      }
    } else {
      out.appendChild(readout('against every token in the store',
        verdict(false, `no match — none of the ${full(tokens.length)} stored tokens is the hash of that string`)));
      out.appendChild(readout('which proves', h('span', {
        class: 'muted',
        text: 'nothing about the scheme. A miss only means this particular guess was wrong; the tokens that do fall, fall on the first try.',
      })));
    }
  }

  input.addEventListener('input', () => { run().catch(() => {}); });

  const controls = h('div');
  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.gap = '8px';
  controls.style.alignItems = 'center';
  controls.appendChild(input);
  controls.appendChild(button('take one from the inventory', () => {
    const withToken = apps.filter(a => a.token);
    if (!withToken.length) return;
    input.value = withToken[seedAt++ % withToken.length].bundle;
    run();
  }));

  controls.appendChild(button('verify every stored token', async () => {
    bulk.textContent = 'hashing…';
    const t0 = performance.now();
    const withToken = apps.filter(a => a.token);
    const computed = new Set();
    let ok = 0;
    try {
      for (const a of withToken) {
        const dg = await digest(a.bundle);
        computed.add(strip(dg.b64));
        if (strip(dg.b64) === strip(a.token)) ok += 1;
      }
    } catch (err) {
      bulk.textContent = 'This browser refused to expose crypto.subtle, so the tokens cannot be recomputed here. '
        + 'The measurements above came from the server and still stand.';
      return;
    }
    const ms = Math.round(performance.now() - t0);

    // The same vocabulary, tried against every other namespace in the store.
    const others = tokens.filter(t => t.ns !== 'lsBundleRecord');
    const cracked = others.filter(t => computed.has(strip(t.t))).length;

    bulk.textContent =
      `${full(ok)} of ${full(withToken.length)} stored app tokens were reproduced in this tab, in ${full(ms)} ms, `
      + `by hashing nothing but the bundle id printed beside them. `
      + `The same ${full(computed.size)} hashes match ${full(cracked)} of the ${full(others.length)} tokens in the `
      + `other namespaces — those hide behind an identifier vocabulary that is not published, not behind the hash.`;
    liveTile.querySelector('.stat-value').textContent = `${compact(ok)} / ${compact(withToken.length)}`;
    liveTile.querySelector('.stat-sub').textContent = `recomputed live with crypto.subtle in ${full(ms)} ms`;
    liveTile.classList.remove('stat-warning');
    liveTile.classList.add('stat-critical');
  }));

  demo.appendChild(note(
    'The construction is unsalted base64(sha256(identifier)) with no key and no salt, so it is reproducible by '
    + 'anyone. Type an identifier — a bundle id, a phone number, an email address, any string at all. Your browser '
    + 'hashes it locally and compares the result against every token the server read out of the store. Nothing is '
    + 'sent anywhere, and no preimage travels with the token list: a token is only ever named here once your own '
    + 'input has produced it.',
  ));
  demo.appendChild(controls);
  demo.appendChild(out);
  demo.appendChild(bulk);

  if (tokens.length) {
    root.appendChild(card('Hash something. See if this machine already knows it.', [demo], true));
  } else {
    root.appendChild(note(`None of the ${full(c.token_distinct)} token references the graph holds on this Mac `
      + `decodes to a 32-byte digest, so there is nothing a hash typed here could match, and the demo is not shown.`));
  }

  if (appNs) root.appendChild(callout(
    'Pseudonymous is not anonymous',
    'Hashing defeats browsing: you cannot read a token. It does not defeat guessing, and guessing is all that is '
    + 'required when the input space is enumerable. Bundle identifiers are public, finite and published by the '
    + 'vendors themselves, so an "anonymised" app list over that vocabulary is not anonymised — it is an index '
    + 'anyone can build once and reuse against every copy of every store.',
    'warning',
  ));

  /* ---------- 2. the namespace experiment ---------- */

  const appNsIndex = nsRows.findIndex(n => n.ns === 'lsBundleRecord');
  const nsChart = bars(nsRows.map(n => ({
    label: n.ns,
    value: n.distinct,
    meta: 'distinct tokens',
  })), { labelW: 130, emphasis: appNsIndex < 0 ? null : appNsIndex });

  root.appendChild(figure({
    title: 'Which of these references actually hide anything',
    note: `The server built a word list out of every string this file already holds — ${compact(c.wordlist)} `
        + `literals and entity ids — hashed each one, and looked the results up against every token. `
        + (invertible.length
            ? `${invertible.map(n => `${n.ns}: ${n.inverted} of ${n.distinct} re-derived`).join('; ')}. The rest were not re-derived`
            : 'None of them were re-derived')
        + ` to this word list, which is a bounded negative and not a guarantee: their inputs simply are not strings `
        + `this file contains.`,
    chart: nsChart,
    table: tableView(
      ['namespace', 'kind', 'rows', 'distinct', 'length', 'decodes to a 32-byte digest', 're-derived from this file', 'preimage stored on the same subject'],
      nsRows.map(n => [
        n.ns, n.kind, full(n.rows), full(n.distinct), n.lengths.join('/'),
        `${full(n.decodes_to_digest)} of ${full(n.distinct)}`,
        `${full(n.inverted)} of ${full(n.distinct)}`,
        `${full(n.rows_with_preimage_on_subject)} of ${full(n.rows)}`,
      ]),
    ),
    wide: true,
  }));

  if (notDigest.length) {
    root.appendChild(callout(
      notDigest.length === 1 ? 'One of these namespaces is not a hash' : `${full(notDigest.length)} of these namespaces are not hashes`,
      notDigest.map(n => `${n.ns} holds ${full(n.distinct)} values of ${n.lengths.join('/')} characters over an `
        + `alphabet of only ${n.alphabet_size} distinct characters, and not one of them decodes to a 32-byte digest`)
        .join('; ')
      + '. A 64-character base64 alphabet does not produce that. Those values are structured plaintext wearing the '
      + 'shape of a token, which is why they resolve by string comparison and not by hashing — and why reading '
      + 'the namespace as "opaque" understates what it gives away.',
      'warning',
    ));
  }

  if ((d.alias_tokens || []).length) {
    const aliases = d.alias_tokens;
    const resolved = aliases.filter(a => a.resolves_to_app).length;
    const aliasTable = tableView(
      ['subject', 'class', 'carries a team identifier', 'its token is the hash of'],
      aliases.map(a => [
        a.name || 'unnamed',
        (a.classes || []).join(', ') || '—',
        a.has_team_identifier ? 'yes' : 'no',
        a.resolves_to_name || 'nothing in this file',
      ]),
    );
    root.appendChild(card('The token rows that are not apps', [
      note(`${full(aliases.length)} of the ${full(appNs ? appNs.rows : 0)} app-namespace rows sit on a subject that `
         + `carries no bundle id of its own. ${full(resolved)} of them hash a bundle id belonging to one of that `
         + `publisher's own applications — so the publisher entity is addressed by a digest of a product it ships. `
         + `A per-subject "every token hashes its own row" check scores these as neither match nor mismatch and `
         + `quietly drops them.`),
      aliasTable,
    ], true));
  }

  /* ---------- 3. capability classes ---------- */

  root.appendChild(h('hr', { class: 'rule' }));

  const classRows = CLASS_RULES.map(r => ({
    rule: r,
    items: byClass.get(r.name),
  }));

  const detail = h('div');
  detail.style.marginTop = '10px';
  detail.style.fontSize = '12px';

  function showClass(row) {
    detail.textContent = '';
    if (!row.items.length) {
      detail.appendChild(h('p', { class: 'card-note', text: `No record in this inventory matched ${row.rule.name}. That is the measurement, not a redaction.` }));
      return;
    }
    detail.appendChild(h('p', { class: 'card-note', text: `${row.rule.name} — ${row.rule.stake}. ${full(row.items.length)} record${row.items.length === 1 ? '' : 's'}:` }));
    const wrap = h('div');
    wrap.style.display = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '6px';
    for (const a of row.items) wrap.appendChild(h('span', { class: 'pill mono', text: a.bundle }));
    detail.appendChild(wrap);
  }

  const leadIndex = Math.max(0, CLASS_RULES.findIndex(r => r.lead));

  const classFigure = figure({
    title: 'What the strings alone say this machine can do',
    note: `Each bundle id is split into words and tested against ${CLASS_RULES.length} rules written in this page's `
        + `source. The rules contain generic capability words only — no vendor, no product, nothing taken from this `
        + `store — so they match ${full(matched)} of ${full(apps.length)} records (${pct(matched, apps.length)}) and `
        + `miss everything that is branded rather than described. Click a bar for the records behind it; the patterns `
        + `themselves are in the table.`,
    chart: bars(classRows.map((row, i) => ({
      label: row.rule.name,
      value: row.items.length,
      meta: 'records matched',
      onclick: () => showClass(row),
    })), { labelW: 210, emphasis: leadIndex }),
    table: tableView(
      ['capability class', 'records matched', 'what this kind of app holds', 'pattern'],
      classRows.map(row => [row.rule.name, full(row.items.length), row.rule.stake, row.rule.re.source]),
    ),
    wide: true,
  });

  classFigure.appendChild(detail);
  root.appendChild(classFigure);
  if (classRows[leadIndex]) showClass(classRows[leadIndex]);

  /* ---------- 4. vendors and publishers ---------- */

  const VENDOR_CAP = 12;
  const shownVendors = vendorRows.slice(0, VENDOR_CAP);
  const tail = vendorRows.slice(VENDOR_CAP).reduce((s, v) => s + v[1], 0);

  root.appendChild(figure({
    title: 'Who wrote the software, read off the identifier',
    note: `The reverse-DNS prefix of a bundle id names its vendor without any lookup. `
        + `${full(vendorRows.length)} distinct vendor prefixes appear across the inventory; the largest carries `
        + `${full(topVendor[1])} records (${pct(topVendor[1], apps.length)}). `
        + `Top ${full(shownVendors.length)} shown; the table has all ${full(vendorRows.length)}.`,
    chart: bars(shownVendors.map(([v, n]) => ({ label: v, value: n, meta: 'records' })), { labelW: 180 }),
    table: tableView(['vendor prefix', 'records', 'share'],
      vendorRows.map(([v, n]) => [v, full(n), pct(n, apps.length)])
        .concat(tail ? [['(not charted)', full(tail), pct(tail, apps.length)]] : [])),
    wide: true,
  }));

  const pubs = d.publishers || [];
  const unlinked = apps.length - (c.apps_with_publisher || 0);
  if (fromSet) {
    root.appendChild(card('Who published each application', [note(
      'App.InstalledApp records no publisher, and the graph\'s "published by" edges went with its application '
      + 'records' + (inv.withdrawn_apps ? ' into the retraction archive' : '') + ', so the live stores no longer say '
      + 'who published each app. The vendor prefixes above, read off the bundle ids, are what is left.')]));
  } else root.appendChild(figure({
    title: 'The publisher edge the graph drew for itself',
    note: `${full(c.apps_with_publisher)} of ${full(apps.length)} applications carry a "published by" edge to an `
        + `organization entity in this same graph; ${full(unlinked)} carry none. `
        + (d.publisher_duplicate_names
            ? `${full(d.publisher_duplicate_entities)} of the ${full(pubs.length)} publisher entities share a display `
              + `name with another, so a rollup keyed on the name silently merges entities the graph keeps apart.`
            : `No two publisher entities share a display name.`),
    chart: bars(pubs.map(p => ({ label: p.name || 'unnamed', value: p.apps, meta: 'applications' })), { labelW: 180 }),
    table: tableView(
      ['publisher entity', 'class', 'applications', 'carries a team identifier'],
      pubs.map(p => [p.name || 'unnamed', (p.classes || []).join(', ') || '—', full(p.apps),
                     p.has_team_identifier ? 'yes' : 'no']),
    ),
    wide: true,
  }));

  /* ---------- 5. the inventory itself ---------- */

  const segs = [
    { label: 'support processes (helper, agent, daemon, extension…)', value: supportCount, color: SERIES(1) },
    { label: 'everything else', value: apps.length - supportCount, color: SERIES(0) },
  ];

  const supportNote = `A generic suffix rule marks ${full(supportCount)} of the records as support processes rather `
    + `than things a person launches, so a count of "apps installed" taken from this table without that filter is `
    + `inflated.`;
  root.appendChild(figure(fromSet ? {
    title: 'The full inventory, as the set holds it',
    note: `Every live item in App.InstalledApp: the plaintext bundle id, the display name and the version string. `
        + `${full(c.apps_with_name)} of ${full(apps.length)} carry a display name. `
        + (inv.skipped ? `${full(inv.skipped)} item${inv.skipped === 1 ? '' : 's'} did not decode and `
                         + `${inv.skipped === 1 ? 'is' : 'are'} not shown. ` : '')
        + supportNote,
    chart: stackedBar(segs),
    legend: legend(segs.map(s => ({ label: s.label, color: s.color }))),
    table: tableView(['bundle id', 'name', 'version', 'capability class'],
      apps.map(a => {
        const row = byApp.get(a.id);
        return [a.bundle, a.name || '—', a.version || '—',
                row && row.hits.length ? row.hits.join(', ') : '—'];
      })),
    wide: true,
  } : {
    title: 'The full inventory, as the store holds it',
    note: `Every application record, with the plaintext bundle id, the display name the graph resolved, the publisher `
        + `edge and the stored token. ${full(c.apps_with_name)} of ${full(apps.length)} carry a display name and `
        + `${full(c.apps_with_app_identifier)} additionally carry a team-qualified application identifier. `
        + supportNote,
    chart: stackedBar(segs),
    legend: legend(segs.map(s => ({ label: s.label, color: s.color }))),
    table: tableView(
      ['bundle id', 'name', 'publisher', 'capability class', 'first asserted', 'stored token'],
      apps.map(a => {
        const row = byApp.get(a.id);
        return [
          a.bundle,
          a.name || '—',
          a.publisher || '—',
          row && row.hits.length ? row.hits.join(', ') : '—',
          a.first_seen ? day(a.first_seen) : '—',
          a.token || '—',
        ];
      }),
    ),
    wide: true,
  }));

  /* ---------- 6. when it learned ---------- */

  const byMonth = new Map();
  for (const a of apps) {
    if (!a.first_seen) continue;
    const key = month(a.first_seen);
    byMonth.set(key, (byMonth.get(key) || 0) + 1);
  }
  const monthRows = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  if (monthRows.length) {
    const sweep = monthRows.reduce((best, r) => (r[1] > best[1] ? r : best), monthRows[0]);
    const after = monthRows.filter(r => r[0] > sweep[0]).reduce((s, r) => s + r[1], 0);
    root.appendChild(figure({
      title: 'When the graph wrote each application down',
      note: `The timestamp on a bundle-id fact is when the graph asserted it, not when the app was installed. The `
          + `busiest month carries ${full(sweep[1])} of ${full(apps.length)} records (${pct(sweep[1], apps.length)}), `
          + `which looks like one bulk write rather than ${full(sweep[1])} installs. ${full(after)} records were `
          + `asserted after it.`,
      chart: columns(monthRows.map(([m, n]) => ({ label: m, value: n, sub: 'records' })), { labelEvery: 2 }),
      table: tableView(['month', 'records first asserted'], monthRows.map(([m, n]) => [m, full(n)])),
      wide: true,
    }));
  }

  /* ---------- 7. the logs disagree with the inventory ---------- */

  const logs = d.interaction_bundles || [];
  if (logs.length) {
    const perBundle = new Map();
    for (const l of logs) {
      const got = perBundle.get(l.bundle)
        || { bundle: l.bundle, n: 0, installed: l.installed, logs: [] };
      got.n += l.n;
      got.logs.push(l.log);
      perBundle.set(l.bundle, got);
    }
    const rows = [...perBundle.values()].sort((a, b) => b.n - a.n);
    const tables = new Set(logs.map(l => l.log));
    const here = rows.filter(l => l.installed);
    const elsewhere = rows.filter(l => !l.installed);
    const items = [
      { label: 'also in this Mac’s inventory', color: SERIES(0) },
      { label: 'not in this Mac’s inventory', color: SERIES(1) },
    ];
    root.appendChild(figure({
      title: 'App ids in the activity logs, against this Mac’s inventory',
      note: `Scanning both artifact stores for a column that names an application turns up ${full(tables.size)} `
          + `logs and ${full(rows.length)} distinct bundle ids. ${full(here.length)} of those are in this Mac's `
          + `inventory and ${full(elsewhere.length)} are not. An id missing from the inventory is not by itself an `
          + `app on another device; the inventory may not list system components. Where a log has columns such as `
          + `isLocal or remoteDeviceId, their meaning is not documented, so iKnow does not use them to place an app `
          + `on a device.`,
      chart: bars(rows.map(l => ({
        label: l.bundle,
        value: l.n,
        meta: 'log rows',
        color: l.installed ? SERIES(0) : SERIES(1),
      })), { labelW: 230 }),
      legend: legend(items),
      table: tableView(['bundle id', 'logs it appears in', 'rows', 'in this Mac’s inventory'],
        rows.map(l => [l.bundle, [...new Set(l.logs)].join(', '), full(l.n), l.installed ? 'yes' : 'no'])),
      wide: true,
    }));
  }
}
