/* facedrawer.js — one face cluster, opened: what Photos calls the person, what
 * the graph binds the cluster to, the face cropped out of its own photograph,
 * the photographs it appears in, and who it appears with.
 *
 * Shared by the landing page and the face index. Thumbnails are the previews
 * Photos already renders inside the library, served by /api/faces/thumb over
 * loopback. Every way that can fail is shown in place with the fix beside it:
 * a preview that cannot be served says so instead of breaking, and a library
 * whose previews cannot be read at all says why and what would make it work.
 *
 * Text safety: every value goes in via textContent. Nothing here is quoted.
 */

import { api, redacting } from './app.js';
import { h, full, day } from './viz.js';

const note = text => h('p', { class: 'card-note', text });
const callout = (title, body, tone) =>
  h('div', { class: 'callout' + (tone ? ' callout-' + tone : '') }, [
    h('div', { class: 'callout-icon', text: '!' }),
    h('div', {}, [h('h4', { text: title }), h('p', { text: body })]),
  ]);
const s = n => (n === 1 ? '' : 's');
const isAre = n => (n === 1 ? 'is' : 'are');

/* ---------- the drawer ---------- */

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

  const panel = h('aside', { role: 'dialog', 'aria-label': 'face cluster' });
  Object.assign(panel.style, {
    position: 'absolute', top: '0', right: '0', height: '100%',
    width: 'min(640px, 94vw)', overflowY: 'auto', padding: '20px 22px 48px',
    background: 'var(--surface-1)', borderLeft: '1px solid var(--border-strong)',
  });
  const close = h('button', { class: 'ghost', type: 'button', text: 'close', onclick: closeDrawer });
  close.style.float = 'right';
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

const pill = (text, cls) => h('span', { class: 'pill' + (cls ? ' pill-' + cls : ''), text });
export const thumbUrl = asset => `/api/faces/thumb?asset=${encodeURIComponent(asset)}`;

/** One key face -> the shape force.js asks for: a picture, and where the
 *  subject sits inside it.
 *
 *  Null when there is no face to draw, or when its preview cannot be read on
 *  this Mac. Either way force.js draws the plain circle — the picture
 *  decorates an identity that is established without it, and its absence takes
 *  nothing away from the node. With the redaction switch on it comes blurred. */
const faceSpec = f => ((f && f.thumb && f.asset)
  ? { href: thumbUrl(f.asset), x: f.x, y: f.y, size: f.size, blur: redacting() }
  : null);

/** A person on the social graph: the cluster the graph binds to them, if any. */
export const nodeFace = node => faceSpec(node && node.meta && node.meta.face);

/** A cluster on the face graph, which is its own face and always carries one. */
export const clusterFace = node => faceSpec(node && node.key_face);

/** The face, cropped out of its photograph with CSS alone: the preview is scaled
 *  so the face box fills most of the ring, then shifted so the face centre sits in
 *  the middle. A preview that never arrives leaves the ring with a question mark. */
export function faceCrop(face, size) {
  const box = h('div', { class: 'face-crop' });
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  if (!face || !face.asset || !face.thumb) { box.classList.add('face-crop-empty'); return box; }
  const img = h('img', { src: thumbUrl(face.asset), alt: '' });
  img.addEventListener('load', () => {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    const side = Math.max(8, (face.size || 0.2) * Math.max(nw, nh));
    // Sit the face in the ring, but never scale the photograph below the ring
    // it has to fill, and never pan it so far that an edge comes inside —
    // a face near the edge of its own photograph would otherwise leave a bare
    // wedge. Off-centre beats a hole.
    const k = Math.max(size / (side * 1.8), size / Math.min(nw, nh));
    const w = nw * k, h = nh * k;
    const fit = (v, lo) => (v < lo ? lo : v > 0 ? 0 : v);
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.left = `${fit(size / 2 - face.x * w, size - w)}px`;
    img.style.top = `${fit(size / 2 - face.y * h, size - h)}px`;
    img.style.visibility = 'visible';
  });
  img.addEventListener('error', () => { img.remove(); box.classList.add('face-crop-empty'); });
  box.appendChild(img);
  return box;
}

/** One photograph in the grid. A preview that cannot be served says so in place. */
function photoTile(ph) {
  const when = ph.date ? day(ph.date) : 'undated';
  const tile = h('div', {
    class: 'face-tile',
    title: `${when} · ${full(ph.people)} ${ph.people === 1 ? 'person' : 'people'} in it · ${ph.kind}`,
  });
  if (ph.thumb) {
    const img = h('img', { src: thumbUrl(ph.asset), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => {
      img.remove();
      tile.appendChild(h('div', { class: 'face-tile-missing', text: 'the preview could not be read' }));
    });
    tile.appendChild(img);
  } else {
    tile.appendChild(h('div', { class: 'face-tile-missing', text: 'no rendered preview on this Mac' }));
  }
  tile.appendChild(h('div', {
    class: 'face-tile-cap',
    text: `${ph.date ? day(ph.date) : '—'} · ${full(ph.people)}${ph.kind === 'video' ? ' · video' : ''}`,
  }));
  return tile;
}

export async function openCluster(id) {
  const body = drawerShell();
  body.appendChild(h('div', { class: 'loading', text: 'reading the photo library…' }));
  let d;
  try {
    d = await api('faces/person', { id });
  } catch (err) {
    body.textContent = '';
    body.appendChild(h('div', { class: 'error', text: `The cluster could not be read — ${String(err.message || err)}` }));
    return;
  }
  body.textContent = '';
  if (!d.found) {
    body.appendChild(h('div', { class: 'error', text: d.reason || 'nothing here' }));
    if (d.fix) body.appendChild(note(`To make it work: ${d.fix}.`));
    return;
  }

  const g = d.graph;
  const name = d.name || (g && g.name) || null;

  /* the face, the name or the code, and where the name came from */
  const head = h('div');
  Object.assign(head.style, { display: 'flex', gap: '16px', alignItems: 'center', margin: '4px 0 10px' });
  head.appendChild(faceCrop(d.key_face, 112));
  const text = h('div');
  text.style.minWidth = '0';
  text.appendChild(h('div', { class: 'view-kicker', text: 'face cluster in the photo library' }));
  text.appendChild(h('h2', { text: name || `Cluster ${d.prefix}` }));
  text.appendChild(h('div', { class: 'mono muted', text: d.uuid || '—' }));
  head.appendChild(text);
  body.appendChild(head);

  const tags = h('div', { class: 'viz-legend' });
  tags.appendChild(d.name ? pill('named in Photos') : pill('unnamed in Photos'));
  if (g) {
    tags.appendChild(pill(g.name ? `bound to a graph entity named ${g.name}` : 'bound to an unnamed graph entity'));
    if (g.is_owner) tags.appendChild(pill('the device owner'));
    for (const ns of g.namespaces || []) tags.appendChild(pill(`also resolves to ${ns}:`));
  } else {
    tags.appendChild(pill('the graph never mentions this cluster'));
  }
  tags.appendChild(pill(`${full(d.faces)} face${s(d.faces)}`));
  tags.appendChild(pill(`${full(d.assets)} photograph${s(d.assets)}`));
  if (d.first) tags.appendChild(pill(`${day(d.first)} to ${day(d.last)}`));
  body.appendChild(tags);

  body.appendChild(note(d.name
    ? `Photos calls this person ${d.name}.`
    : g && g.name
      ? `Photos has no name for this cluster, but the graph binds it to a person entity named `
        + `${g.name}` + (g.namespaces && g.namespaces.length
                           ? ` that also resolves to ${g.namespaces.join(', ')}` : '') + '.'
      : g
        ? 'Photos holds no name for this face, and '
          + 'the graph entity it is bound to carries none in the name fields iKnow reads. The photographs below are '
          + 'what the store knows about them.'
        : 'Photos holds no name for this face, and the graph has never referenced '
          + 'this cluster. The photographs below are all the library holds about them.'));

  /* the photographs */
  const section = h('div');
  section.appendChild(h('h3', { text: `Photographs · ${full(d.photos_total)}` }));
  const T = d.thumbs || {};
  if (T.available === false) {
    section.appendChild(callout('Previews cannot be shown', `${T.why}. To make it work: ${T.fix}.`, 'warning'));
  } else if (d.photos_total && d.photos_with_thumb < d.photos_total) {
    const missing = d.photos_total - d.photos_with_thumb;
    section.appendChild(note(`${full(missing)} of ${full(d.photos_total)} photograph${s(d.photos_total)} `
      + `ha${missing === 1 ? 's' : 've'} no rendered preview on this Mac — Photos → Settings → iCloud → `
      + 'Download Originals to this Mac renders them.'));
  }
  if (!d.photos.length) {
    section.appendChild(h('div', { class: 'empty', text: d.hidden_or_trashed
      ? `every photograph of this face is hidden or in the trash (${full(d.hidden_or_trashed)})`
      : 'no photograph carries this face' }));
  } else {
    const gridEl = h('div', { class: 'face-grid' });
    for (const ph of d.photos) gridEl.appendChild(photoTile(ph));
    section.appendChild(gridEl);
    if (d.photos_total > d.photos.length) {
      section.appendChild(note(`Showing ${full(d.photos.length)} of ${full(d.photos_total)} — the most recent that have a rendered preview first; capped here.`));
    }
    if (d.hidden_or_trashed) {
      section.appendChild(note(`${full(d.hidden_or_trashed)} more face${s(d.hidden_or_trashed)} `
        + `sit${d.hidden_or_trashed === 1 ? 's' : ''} in hidden or trashed photographs and ${isAre(d.hidden_or_trashed)} not shown.`));
    }
  }
  body.appendChild(section);

  /* who it appears with */
  body.appendChild(h('h3', { text: `Appears with · ${full(d.partners_total)}` }));
  if (!d.partners.length) {
    body.appendChild(h('div', { class: 'empty', text: 'no other clustered face shares a photograph with this one' }));
  } else {
    for (const p of d.partners) {
      const rowEl = h('div', { class: 'face-partner' });
      rowEl.appendChild(faceCrop(p.key_face, 40));
      const t = h('div', { class: 'face-partner-text' });
      t.appendChild(h('button', { class: 'ghost', type: 'button', text: p.name || `cluster ${p.prefix}`,
                                  onclick: () => openCluster(p.id) }));
      t.appendChild(h('span', { class: 'muted', text: ` · ${full(p.shared)} shared photograph${s(p.shared)}`
                                                     + (p.referenced ? ' · referenced by the graph' : '') }));
      rowEl.appendChild(t);
      body.appendChild(rowEl);
    }
    if (d.partners_total > d.partners.length) {
      body.appendChild(note(`Showing the ${full(d.partners.length)} heaviest of ${full(d.partners_total)} — capped here.`));
    }
  }
}
