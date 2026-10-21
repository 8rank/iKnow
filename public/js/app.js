/* app.js — the shell: page registry, navigation, hash routing, fetch helper.
 *
 * Pages are self-contained modules in js/pages/. Each exports:
 *
 *   export const meta = {
 *     id:       'kinship',            // url hash and registry key
 *     nav:      'What it inferred',   // sidebar label
 *     group:    'The inferences',     // sidebar section
 *     kicker:   'Inferred relationships',
 *     title:    'Your Mac scored N people on M kinds of closeness',
 *     blurb:    'one or two sentences, shown under the title',
 *     headless: true,                 // optional: the page draws its own header
 *   };
 *   export async function render(root) { ... }   // fills the view element
 *   export function unmount() { ... }            // optional: release graphs and
 *                                                // timers when the reader leaves
 *
 * Adding a page means writing the module and adding one import below.
 */

import { h } from './viz.js';

import * as home from './pages/home.js';
import * as overview from './pages/overview.js';
import * as social from './pages/social.js';
import * as kinship from './pages/kinship.js';
import * as comms from './pages/comms.js';
import * as identity from './pages/identity.js';
import * as calendar from './pages/calendar.js';
import * as faces from './pages/faces.js';
import * as retractions from './pages/retractions.js';
import * as certainty from './pages/certainty.js';
import * as device from './pages/device.js';
import * as exposure from './pages/exposure.js';

// Order here is the order within each sidebar group.
const PAGES = [home, kinship, faces, certainty, social, comms, calendar,
               identity, retractions, overview, device, exposure];

const GROUPS = ['Start here', 'What it concluded', 'What it recorded', 'The machinery'];

/* ---------- redaction ---------- */

/* The switch at the foot of the sidebar, for sharing the screen. While it is on,
 * every request asks the server for the redacted payload (names, phone numbers,
 * mail and postal addresses become numbered stand-ins: api/redact.py) and every
 * photograph is blurred. It is the one thing this page remembers across a
 * reload, so reloading in the middle of a call cannot put the real names back. */
const REDACT_KEY = 'iknow.redact';
let redacted = false;
try { redacted = localStorage.getItem(REDACT_KEY) === '1'; } catch { /* no storage: off */ }

/** Whether the screen is redacted. Pages that draw photographs ask this. */
export const redacting = () => redacted;

function applyRedaction() {
  document.documentElement.classList.toggle('redacted', redacted);
  const sw = document.querySelector('.redact-switch');
  if (sw) sw.setAttribute('aria-checked', String(redacted));
}

function setRedacted(on) {
  redacted = on;
  try {
    if (on) localStorage.setItem(REDACT_KEY, '1');
    else localStorage.removeItem(REDACT_KEY);
  } catch { /* it still holds for this tab */ }
  applyRedaction();
  route();          // the page on screen is rebuilt from the other payloads
}

/* ---------- fetch ---------- */

const cache = new Map();

/** GET /api/<path>. Results are memoised for the life of the page; the redacted
 *  and the plain payloads are cached apart, under their own URLs. What the
 *  server could not read for it goes on the notice of the page that asked. */
export function api(path, params = {}) {
  const qs = new URLSearchParams(redacted ? { ...params, redact: 1 } : params).toString();
  const url = `/api/${path}${qs ? '?' + qs : ''}`;
  const owner = ledger;
  const p = cache.get(url) || load(url);
  return p.then(
    body => { noteGaps(owner, body && body._gaps); return body; },
    err => {
      noteGaps(owner, [...(err.gaps || []),
                       { kind: 'request', store: `/api/${path}`, detail: String(err.message || err) }]);
      throw err;
    });
}

function load(url) {
  const p = fetch(url).then(async res => {
    // The server was restarted: it minted a new token and this tab's cookie
    // carries the old one. A reload brings up the server's own page saying where
    // the new link is; until then the page stays on "reading the store…".
    if (res.status === 401) {
      location.reload();
      return new Promise(() => {});
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${res.status} — the server did not return JSON`);
    }
    if (!res.ok || body.error) {
      const err = new Error(body.detail ? `${body.error}: ${body.detail}` : (body.error || `HTTP ${res.status}`));
      err.gaps = body.gaps;
      throw err;
    }
    return body;
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));   // a failure must not be remembered
  return p;
}

/* ---------- what the server could not read ---------- */

/* A payload carries `_gaps` when the server could not read all of it: a store
 * missing from this Mac, one macOS would not open, or a statement this Mac's
 * copy of a store cannot run. The page on screen lists them in one notice under
 * its title, so an empty chart or a zero is not taken for a measurement. A
 * request that failed outright goes on it too: some pages build without it and
 * would otherwise say nothing. */
let ledger = null;                // { slot, items } for the page on screen

function noteGaps(owner, list) {
  if (!owner || owner !== ledger || !Array.isArray(list) || !list.length) return;
  let added = false;
  for (const g of list) {
    const key = [g.kind, g.store, g.detail].join('\u0000');
    if (!owner.items.has(key)) { owner.items.set(key, g); added = true; }
  }
  if (added) drawGaps(owner);
}

function drawGaps({ slot, items }) {
  const all = [...items.values()];
  const kinds = new Set(all.map(g => g.kind));
  const missing = all.filter(g => g.kind !== 'redact');
  const notes = [];
  if (missing.length) {
    notes.push('iKnow could not read everything this page draws on. Whatever depends on the lines below '
             + 'is shown empty or as zero, and that is not a measurement.');
  }
  if (kinds.has('query')) {
    notes.push('Apple adds and renames columns between macOS releases, so a store on this Mac can have a '
             + 'different shape from the one iKnow was written against.');
  }
  if (kinds.has('denied')) {
    notes.push('A store macOS would not open usually means the terminal running server.py lacks Full Disk Access.');
  }
  if (kinds.has('redact')) {
    notes.push('With “Redact for sharing” on, what the sources below hold is not replaced on this page.');
  }
  const box = h('div', { class: 'callout callout-warning data-gaps', role: 'status' }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [
      h('h4', { text: missing.length ? 'Some of this page may be missing' : 'Redaction may be incomplete' }),
      ...notes.map(t => h('p', { text: t })),
      h('ul', {}, all.map(g => h('li', {}, [
        h('span', { class: 'mono', text: g.store }),
        h('span', { text: ` — ${g.detail}` }),
      ]))),
      h('p', {}, [
        h('span', { text: 'If this looks wrong, ' }),
        h('a', { href: 'https://github.com/8rank/iKnow/issues', target: '_blank', rel: 'noopener noreferrer',
                 text: 'open an issue on GitHub' }),
        h('span', { text: ' with these lines and your macOS version.' }),
      ]),
    ]),
  ]);
  slot.replaceChildren(box);
}

/* ---------- navigation ---------- */

function buildNav() {
  const nav = document.getElementById('nav');
  for (const group of GROUPS) {
    const inGroup = PAGES.filter(p => p.meta.group === group);
    if (!inGroup.length) continue;
    nav.appendChild(h('div', { class: 'nav-group', text: group }));
    for (const page of inGroup) {
      const { id, nav: label } = page.meta;
      const btn = h('button', {
        class: 'nav-item',
        type: 'button',
        'data-page': id,
        onclick: () => { location.hash = id; },
      }, [h('span', { class: 'dot' }), h('span', { text: label })]);
      nav.appendChild(btn);
    }
  }
  nav.appendChild(h('div', { class: 'sidebar-foot' }, [
    h('a', { href: 'https://8rank.ai', target: '_blank', rel: 'noopener noreferrer' },
      [h('span', { text: 'from ' }), h('span', { class: 'the', text: 'the ' }), h('span', { text: 'Eighth Rank' })]),
    h('div', { class: 'sidebar-foot-line' }, [
      h('span', { text: 'iKnow is fully LLM-generated and may not be 100% accurate. If something should '
                      + 'be updated, ' }),
      h('a', { href: 'https://github.com/8rank/iKnow/issues', target: '_blank', rel: 'noopener noreferrer',
               text: 'open an issue on GitHub' }),
      h('span', { text: '.' }),
    ]),
  ]));
  nav.appendChild(h('div', { class: 'sidebar-redact' }, [
    h('button', {
      class: 'redact-switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(redacted),
      onclick: () => setRedacted(!redacted),
    }, [
      h('span', { class: 'redact-track', 'aria-hidden': 'true' }, [h('span', { class: 'redact-knob' })]),
      h('span', { class: 'redact-text' }, [
        h('span', { class: 'redact-label', text: 'Redact for sharing' }),
        h('span', { class: 'redact-sub', text:
          'Names, phone numbers and addresses become stand-ins; photographs are blurred. '
          + 'Every count and link stays as it is.' }),
      ]),
    ]),
  ]));
}

function markActive(id) {
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('on', btn.dataset.page === id);
  }
}

/* ---------- routing ---------- */

function head(meta) {
  const box = h('header', { class: 'view-head' });
  if (meta.kicker) box.appendChild(h('div', { class: 'view-kicker', text: meta.kicker }));
  box.appendChild(h('h1', { text: meta.title }));
  if (meta.blurb) box.appendChild(h('p', { text: meta.blurb }));
  return box;
}

let token = 0;
let current = null;               // the page on screen, for its unmount() hook

async function route() {
  const id = location.hash.slice(1) || PAGES[0].meta.id;
  const page = PAGES.find(p => p.meta.id === id) || PAGES[0];
  const mine = ++token;

  if (current && typeof current.unmount === 'function') {
    try { current.unmount(); } catch (err) { console.error(err); }
  }
  current = page;

  markActive(page.meta.id);
  const view = document.getElementById('view');
  view.textContent = '';
  if (!page.meta.headless) view.appendChild(head(page.meta));
  const slot = h('div', { class: 'gaps-slot' });
  view.appendChild(slot);
  ledger = { slot, items: new Map() };

  const body = h('div');
  body.appendChild(h('div', { class: 'loading', text: 'reading the store…' }));
  view.appendChild(body);
  scrollTo(0, 0);

  try {
    const fresh = h('div');
    await page.render(fresh);
    if (mine !== token) return;                 // a newer navigation won
    body.replaceWith(fresh);
  } catch (err) {
    if (mine !== token) return;
    console.error(err);
    const box = h('div', { class: 'error' });
    box.appendChild(h('strong', { text: 'This page could not be built. ' }));
    box.appendChild(h('span', { text: String(err.message || err) }));
    body.replaceWith(box);
  }
}

/* ---------- boot ---------- */

async function boot() {
  applyRedaction();
  buildNav();
  addEventListener('hashchange', route);
  route();

  try {
    const o = await api('overview');
    const sub = document.getElementById('brand-sub');
    const parts = [];
    if (o.captured) parts.push(o.captured);
    if (o.triples) parts.push(`${o.triples.toLocaleString('en-US')} facts`);
    sub.textContent = parts.join(' · ') || 'local store';
  } catch {
    document.getElementById('brand-sub').textContent = 'store unavailable';
  }
}

boot();
