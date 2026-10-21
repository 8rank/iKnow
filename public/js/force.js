/* force.js — a force-directed graph in hand-rolled SVG. No dependencies.
 *
 * One reusable component, written to the same rules as viz.js:
 *
 *   simulation   velocity Verlet — link springs, many-body repulsion, a pull to
 *                centre, collision relaxation. Alpha decays geometrically over a
 *                fixed tick budget and the loop STOPS. There is no permanent
 *                animation; a settled graph costs nothing.
 *   no walls     the pull to centre is sized against the repulsion, so the
 *                layout's own forces settle it into the room it needs. Nothing
 *                presses it into a frame: a wall lines the loosest nodes up
 *                along its sides, and a straight row of nodes reads as
 *                structure the data does not have.
 *   stability    every division is guarded by a floor, every tick ends with a
 *                speed clamp and a far rail a settled layout never reaches, and
 *                any non-finite coordinate is reset to the centre. The layout
 *                cannot run away to NaN.
 *   determinism  initial placement is a phyllotaxis spiral and the jiggle used
 *                to separate coincident nodes comes from a seeded LCG, so the
 *                same graph draws the same picture every time.
 *   marks        node = filled circle + 2px ring in the surface colour, so
 *                overlapping nodes stay legible. Links sit beneath the nodes,
 *                1px, --grid unless the caller colours them, opacity by weight.
 *   faces        a node may carry a picture, clipped to a disc inside its own
 *                circle so a rim of the node colour survives and the legend
 *                still reads. The picture is decoration over an identity the
 *                caller has already established: one that never loads leaves
 *                the plain circle behind, and nothing else changes.
 *   text         labels only on the larger nodes, --text-secondary, never the
 *                node's own colour, with a surface-coloured halo (paint-order)
 *                so a name stays readable where it crosses a link.
 *   text safety  every label goes in via textContent. Names here come from a
 *                personal store and routinely contain characters that would
 *                break an innerHTML string.
 *
 * Size: the drawing is as wide as its container and as tall as the window
 *   allows, one viewBox unit to one CSS pixel, so labels keep their 11px and
 *   hit targets their size on any screen. It follows the container and the
 *   window as they change: the view is re-fitted, or, once the reader has
 *   panned or zoomed, kept centred where they left it. The layout itself does
 *   not depend on the window: the same graph draws the same picture at any
 *   size, and only the view is fitted to it. `width` and `height` set the
 *   layout's own space and the drawing's shape on a wide screen.
 *
 * Interaction: drag a node to place it (it stays pinned; double-click unpins),
 * click to select, click the background to deselect, drag the background to
 * pan, pinch or ⌘/Ctrl-scroll to zoom, double-click the background to zoom in.
 * A plain scroll is the page's: it scrolls past the graph and shows a hint,
 * except with the graph filling the window, where it zooms. Buttons in the
 * corner zoom in, zoom out, re-fit, and fill the window. Zoomed in past the
 * fit, every node may carry a label. Keyboard: Tab walks the nodes in weight
 * order, Enter or Space selects, Escape clears (or leaves the filled window),
 * arrows pan, +/- zoom, 0 re-fits, f fills the window.
 *
 * prefers-reduced-motion settles the whole layout in one synchronous pass and
 * paints the result once — no frames, no tweens.
 *
 *   const g = forceGraph(el, { nodes, links, width, height, colorFor, onSelect });
 *   // optional: expand — the element that fills the window when asked to
 *   //           (the graph and the panel beside it, say). Default: the graph.
 *   // optional: labelFor(raw) -> true (always carry a label) | false (never) |
 *   //           undefined (the weight rule); labelMax, labelShare and labelChars
 *   //           override the standing-label budget and the truncation length.
 *   // optional: faceFor(raw) -> { href, x, y, size, blur } | null — a picture
 *   //           for this node, with the subject's centre at (x, y) as fractions
 *   //           of the image and `size` its width as a fraction of the longer
 *   //           side; `blur` draws it through a blur scaled to the disc, for a
 *   //           screen that is being shared. force.js builds no URLs: the
 *   //           caller knows its own routes. It is asked again on every
 *   //           update(), so a page can offer the pictures as a switch: return
 *   //           null and they are taken down.
 *   // optional: linkStyleFor(raw) -> { width, opacity, minOpacity, dash } | null
 *   //           — a link drawn heavier, fainter or dashed than the weight rule
 *   //           would draw it; any field left out keeps the default. `opacity`
 *   //           replaces the weight rule, `minOpacity` only floors it (a dash
 *   //           drops ink, so a dashed link may need one). Links paint in
 *   //           array order, so the ones meant to be read go last.
 *   // optional: onLinkHover(raw | null, event, also) — called as the pointer
 *   //           enters and moves along a link (with the caller's link object)
 *   //           and with null when it leaves. `also` lists the other visible
 *   //           links between the same two nodes, which draw exactly on top of
 *   //           it and so cannot be told apart by pointing. When given, each link gets a wider
 *   //           invisible hit line so a 1px edge can be pointed at, and the
 *   //           hovered one is drawn heavier. force.js shows nothing itself:
 *   //           the caller knows what a link means.
 *   // optional: nodeStyleFor(raw) -> { dash, fillOpacity } | null — a node
 *   //           drawn as an outline in its own colour (dashed by `dash`)
 *   //           over a fill lightened to `fillOpacity`, for a node that is
 *   //           the same kind of thing as its neighbours but in another state.
 *   // optional: nodeOpacityFor(raw) -> 0..1 — a ceiling on the node's opacity,
 *   //           for a graph drawn as the backdrop of another. The selected
 *   //           node always shows in full.
 *   g.setLinkFilter(new Set(['knows']));   // hide the rest AND reflow
 *   g.focus('42');                          // centre + dim everything 2+ hops out
 *   g.update({ nodes, links });             // keeps positions of surviving ids
 *   g.fit();                                // glide back to the whole graph
 *   g.destroy();
 */

const NS = 'http://www.w3.org/2000/svg';

// clipPath ids are document-global, and a page may hold more than one graph.
let faceSeq = 0;

/* ---------- tunables (all in viewBox px) ---------- */

const R_MIN = 5;            // smallest visual radius
const R_MAX = 22;           // largest visual radius
const HIT_MIN = 12;         // hit radius floor -> a 24px target at 1:1
const HIT_PAD = 6;

const FACE_RIM = 1.5;       // node-colour rim left around a face, in viewBox px
const FACE_FILL = 1.8;      // face box -> disc: the crop the drawer uses
const FACE_BLUR = 0.4;      // blur deviation as a share of the disc radius

const LINK_GAP = 34;        // resting gap between two node rims
const LEAF_LINK = 0.5;      // ...as a share of that, when one end has no other link
const CHARGE_BASE = -150;   // many-body strength, before the size term
const CHARGE_PER_R = -8;
const CHARGE_LEAF = -40;    // a node with one link: light, so it stays by the node it belongs to
const ROOM = 1.6;           // the layout's area, as a multiple of what its circles cover
const RAIL = 2.5;           // no free node goes further out, as a multiple of that radius
const RECENTRE = 0.6;       // share of the centroid error corrected per tick
const VELOCITY_DECAY = 0.62;
const MAX_SPEED = 30;       // px/tick — the hard anti-divergence rail
const MIN_D2 = 16;          // never divide by a separation under 4px
const COLLIDE_PAD = 3;
const ALPHA_MIN = 0.005;
const FRAME_MS = 11;        // work per animation frame

const LABEL_MAX = 24;       // at most this many standing labels
const LABEL_SHARE = 0.3;    // ...or this share of the nodes, whichever is fewer
const LABEL_GAP = 12;       // screen px between a node's rim and its label
const LABEL_CHARS = 28;

const H_MIN = 300;          // CSS px: the drawing is never shorter than this
const H_FILL = 0.62;        // ...aims for this share of the window's height
const H_MAX = 0.85;         // ...and never takes more than this share of it
const TALL = 1.5;           // ...and is never taller than this many times its width

const K_MIN = 0.2, K_MAX = 8;
const FIT_K_MAX = 1.6;      // a fitted view never magnifies past this
const FOLLOW = 0.16;        // share of the way to the fit closed per frame while the layout runs
const ZOOM_STEP = 1.5;      // one press of a zoom button
const CONTROLS_W = 30;      // CSS px the corner buttons take from a fitted view's right margin
const ZOOM_LABELS = 1.5;    // this far past the fit, every node may carry a label
const HINT_MS = 1600;       // how long the "how to zoom" hint stays up
const DIM = 0.12;           // more than one hop from the focused node
const DIM_LINK = 0.16;
const ISOLATED = 0.3;       // no links under the current filter — fade, not vanish
const LINK_O_MIN = 0.25, LINK_O_MAX = 0.85;
const LINK_HIT_WIDTH = 9;   // screen px of pointer target around each link, when links can be hovered

/* ---------- tiny helpers ---------- */

const el = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = v => (v === null || v === undefined ? '' : String(v));
const trunc = (s, n = LABEL_CHARS) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const now = () =>
  (typeof performance === 'object' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();

const raf = fn => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16));

const caf = id => {
  if (!id) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
};

const reducedMotion = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
};

/** An id from either a bare id or a {id} object — links may arrive either way. */
const idOf = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v.id === null || v.id === undefined ? null : String(v.id);
  return String(v);
};

/* ================================================================== */

export function forceGraph(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('forceGraph: a DOM container is required');
  }

  /* Two spaces. The layout runs in a fixed one, layoutW x layoutH, centred on
   * its middle, so a resize never disturbs it. The drawing on screen is vw x vh
   * CSS px, measured from the container; the view transform maps one onto the
   * other. Until the container has been measured, the drawing takes the
   * layout's size. */
  const layoutW = Math.max(80, num(options.width) || 640);
  const layoutH = Math.max(80, num(options.height) || 420);
  let vw = layoutW, vh = layoutH, sized = false, pendingRun = false;
  const expandEl = options.expand && typeof options.expand.appendChild === 'function'
    ? options.expand : container;
  const colorFor = typeof options.colorFor === 'function' ? options.colorFor : () => 'var(--series-1)';
  const linkColorFor = typeof options.linkColorFor === 'function' ? options.linkColorFor : null;
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  const cutoff2 = Math.pow(Math.max(layoutW, layoutH, 400) * 1.3, 2);
  const labelMax = Math.max(1, Math.round(num(options.labelMax)) || LABEL_MAX);
  const labelShare = Number.isFinite(Number(options.labelShare))
    ? clamp(Number(options.labelShare), 0, 1) : LABEL_SHARE;
  const labelChars = Math.max(4, Math.round(num(options.labelChars)) || LABEL_CHARS);
  const labelFor = typeof options.labelFor === 'function' ? options.labelFor : null;
  const faceFor = typeof options.faceFor === 'function' ? options.faceFor : null;
  const linkStyleFor = typeof options.linkStyleFor === 'function' ? options.linkStyleFor : null;
  const nodeOpacityFor = typeof options.nodeOpacityFor === 'function' ? options.nodeOpacityFor : null;
  const nodeStyleFor = typeof options.nodeStyleFor === 'function' ? options.nodeStyleFor : null;
  const onLinkHover = typeof options.onLinkHover === 'function' ? options.onLinkHover : null;

  /* ---------- state ---------- */

  let rawNodes = options.nodes, rawLinks = options.links;
  let nodes = [], links = [], active = [];
  let byId = new Map();            // id -> node
  let adj = new Map();             // id -> Set(id), from the ACTIVE links only
  let recs = new Map();            // id -> {g, hit, dot, sel, pin, label, big}
  let order = [];                  // nodes in weight order == tab order == z order

  let linkFilter = null;           // null means "every kind"
  let selected = null, focused = null, hovered = null;
  let hotLink = null;                  // the link under the pointer, when onLinkHover is set
  const hitOf = new WeakMap();         // hit line -> its link

  /** Point at a link (or at none): draw it heavier and tell the caller. */
  function setHotLink(l, ev) {
    if (l !== hotLink) {
      if (hotLink && hotLink.line) hotLink.line.classList.remove('force-link-hot');
      hotLink = l;
      if (l && l.line) l.line.classList.add('force-link-hot');
    }
    if (!onLinkHover) return;
    if (!l) { onLinkHover(null, ev, []); return; }
    const also = links.filter(x => x !== l && x.visible && x.line
      && ((x.source === l.source && x.target === l.target) || (x.source === l.target && x.target === l.source)));
    onLinkHover(l.src, ev, also.map(x => x.src));
  }
  let reach = 0, pull = 0;         // the layout's radius, and the pull to centre that holds it there

  let alpha = 0, alphaDecay = 0.05, ticksLeft = 0;
  let simRaf = 0, tweenRaf = 0, labelRaf = 0, sizeRaf = 0, dragOff = null, wantFit = false;
  let userMoved = false;           // the viewer panned/zoomed — don't yank the view
  let expanded = false;            // filling the window
  let hintTimer = 0;
  let dead = false;

  const view = { tx: 0, ty: 0, k: 1 };

  let seed = 0x2f6e2b1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const jiggle = () => (rnd() - 0.5) * 1e-3;

  /* ---------- DOM ---------- */

  const bin = [];
  const on = (t, type, fn, opts) => {
    if (!t || typeof t.addEventListener !== 'function') return;
    t.addEventListener(type, fn, opts);
    bin.push([t, type, fn, opts]);
  };
  const offAll = () => {
    while (bin.length) {
      const [t, type, fn, opts] = bin.pop();
      try { t.removeEventListener(type, fn, opts); } catch { /* gone already */ }
    }
  };

  container.textContent = '';
  container.setAttribute('role', 'application');
  container.setAttribute('tabindex', '-1');
  container.classList.add('force-host');

  const svg = el('svg', {
    class: 'force-graph',
    viewBox: `0 0 ${vw} ${vh}`,
    width: vw, height: vh,
    preserveAspectRatio: 'xMidYMid meet',
    focusable: 'false',
  });
  svg.style.display = 'block';
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
  svg.style.touchAction = 'none';
  svg.style.cursor = 'grab';
  svg.style.userSelect = 'none';

  const defs = el('defs');
  const root = el('g', { class: 'force-root' });
  const gLinks = el('g', { class: 'force-links', fill: 'none', 'stroke-linecap': 'round' });
  const gHits = el('g', { class: 'force-link-hits', fill: 'none', stroke: 'transparent' });
  const gNodes = el('g', { class: 'force-nodes' });
  const gLabels = el('g', {
    class: 'force-labels',
    'text-anchor': 'middle',
    'pointer-events': 'none',
    'font-size': 11,
    fill: 'var(--text-secondary)',
    stroke: 'var(--surface-1)',
    'stroke-width': 3,
    'stroke-linejoin': 'round',
    'paint-order': 'stroke',
  });
  gLabels.style.fontFamily = 'var(--font)';

  const empty = el('text', {
    class: 'force-empty',
    x: vw / 2, y: vh / 2,
    'text-anchor': 'middle',
    fill: 'var(--text-muted)',
    'font-size': 12.5,
    display: 'none',
  });
  empty.textContent = 'nothing to draw here';

  root.appendChild(gLinks);
  if (onLinkHover) root.appendChild(gHits);
  root.appendChild(gNodes);
  root.appendChild(gLabels);
  svg.appendChild(defs);
  svg.appendChild(root);
  svg.appendChild(empty);

  /* The corner buttons: HTML over the drawing, and ahead of it in the DOM so
   * Tab reaches them before it walks hundreds of nodes. Icons are drawn, not
   * typed, so they read the same in every font. */
  const ICONS = {
    in: 'M8 3.5v9M3.5 8h9',
    out: 'M3.5 8h9',
    fit: 'M3 6.5V3h3.5M9.5 3H13v3.5M13 9.5V13H9.5M6.5 13H3V9.5',
    expand: 'M9.5 3H13v3.5M13 3L9 7M6.5 13H3V9.5M3 13l4-4',
    collapse: 'M13 3L9.5 6.5M9.5 3.5v3h3M3 13l3.5-3.5M3.5 9.5h3v3',
  };
  const controls = document.createElement('div');
  controls.className = 'force-controls';
  const relabel = (b, icon, label) => {
    b.querySelector('path').setAttribute('d', ICONS[icon]);
    b.setAttribute('aria-label', label);
    b.title = label;
  };
  const ctl = (icon, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'force-ctl';
    const ico = el('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor',
                            'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    ico.appendChild(el('path'));
    b.appendChild(ico);
    relabel(b, icon, label);
    on(b, 'click', ev => { if (b.getAttribute('aria-disabled') !== 'true') fn(ev); });
    controls.appendChild(b);
    return b;
  };
  const btnIn = ctl('in', 'Zoom in (+)', () => zoomBy(ZOOM_STEP, true));
  const btnOut = ctl('out', 'Zoom out (−)', () => zoomBy(1 / ZOOM_STEP, true));
  ctl('fit', 'Fit the graph to the frame (0)', () => refit(true));
  const btnExpand = ctl('expand', 'Fill the window (f)', () => setExpanded(!expanded));

  /* Says how to zoom when a plain scroll goes past the graph to the page. */
  const hint = document.createElement('div');
  hint.className = 'force-hint';
  hint.setAttribute('aria-hidden', 'true');
  const mac = typeof navigator === 'object' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  hint.textContent = `Pinch or ${mac ? '⌘' : 'Ctrl'}-scroll to zoom`;

  container.appendChild(controls);
  container.appendChild(svg);
  container.appendChild(hint);

  /* ---------- ingest: normalise, dedupe, drop the impossible ---------- */

  function ingest(rn, rl) {
    const prev = byId;
    const map = new Map();
    const list = [];

    for (const raw of Array.isArray(rn) ? rn : []) {
      if (!raw || raw.id === null || raw.id === undefined) continue;
      const id = String(raw.id);
      if (map.has(id)) continue;                      // duplicate id — first wins
      const old = prev.get(id);
      const p = {
        id, src: raw,
        label: raw.label === null || raw.label === undefined ? id : String(raw.label),
        group: str(raw.group), kind: str(raw.kind),
        weight: num(raw.weight),
        x: old ? old.x : NaN, y: old ? old.y : NaN,
        vx: 0, vy: 0,
        fx: old ? old.fx : null, fy: old ? old.fy : null,
        r: (R_MIN + R_MAX) / 2, hit: HIT_MIN, charge: CHARGE_BASE, deg: 0,
      };
      map.set(id, p);
      list.push(p);
    }

    /* radius from weight, sqrt so area reads as the quantity */
    let lo = Infinity, hi = -Infinity;
    for (const p of list) { if (p.weight < lo) lo = p.weight; if (p.weight > hi) hi = p.weight; }
    const span = hi - lo;
    for (const p of list) {
      p.r = span > 0
        ? R_MIN + (R_MAX - R_MIN) * Math.sqrt(clamp((p.weight - lo) / span, 0, 1))
        : (R_MIN + R_MAX) / 2;
      p.hit = Math.max(HIT_MIN, p.r + HIT_PAD);
    }

    /* seed anything new on a phyllotaxis spiral — never two nodes on one point */
    const cx = layoutW / 2, cy = layoutH / 2;
    let fresh = 0;
    for (const p of list) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) continue;
      const i = fresh++;
      const rad = 11 * Math.sqrt(0.5 + i);
      const ang = i * Math.PI * (3 - Math.sqrt(5));
      p.x = cx + rad * Math.cos(ang);
      p.y = cy + rad * Math.sin(ang);
    }

    const ls = [];
    let wlo = Infinity, whi = -Infinity;
    for (const raw of Array.isArray(rl) ? rl : []) {
      if (!raw) continue;
      const s = idOf(raw.source), t = idOf(raw.target);
      const a = s === null ? null : map.get(s);
      const b = t === null ? null : map.get(t);
      if (!a || !b || a === b) continue;              // unknown endpoint or self-link: drop
      const w = num(raw.weight);
      if (w < wlo) wlo = w; if (w > whi) whi = w;
      ls.push({
        src: raw, source: a, target: b, kind: str(raw.kind), weight: w,
        nw: 0.5, bias: 0.5, strength: 0.3, distance: LINK_GAP, line: null, style: null,
      });
    }
    const wspan = whi - wlo;
    for (const l of ls) l.nw = wspan > 0 ? clamp((l.weight - wlo) / wspan, 0, 1) : 0.5;

    nodes = list; byId = map; links = ls;

    order = nodes.slice().sort((a, b) =>
      b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    /* how much room does this many circles need? The layout grows into a disc
     * of that area; the view is fitted to it afterwards. */
    let need = 0;
    for (const p of nodes) need += Math.PI * Math.pow(p.r + COLLIDE_PAD + 8, 2);
    reach = Math.max(40, Math.sqrt((need * ROOM) / Math.PI));
  }

  const allowed = l => !linkFilter || linkFilter.has(l.kind);

  function recomputeActive() {
    active = links.filter(allowed);
    for (const p of nodes) p.deg = 0;
    for (const l of active) { l.source.deg++; l.target.deg++; }
    adj = new Map();
    for (const l of active) {
      let a = adj.get(l.source.id); if (!a) adj.set(l.source.id, a = new Set());
      let b = adj.get(l.target.id); if (!b) adj.set(l.target.id, b = new Set());
      a.add(l.target.id); b.add(l.source.id);
    }
    for (const l of active) {
      const ds = Math.max(1, l.source.deg), dt = Math.max(1, l.target.deg);
      l.bias = ds / (ds + dt);
      l.strength = clamp((1 / Math.min(ds, dt)) * (0.7 + 0.6 * l.nw), 0.02, 1);
      l.distance = l.source.r + l.target.r
        + LINK_GAP * (1 - 0.35 * l.nw) * (Math.min(ds, dt) === 1 ? LEAF_LINK : 1);
    }

    /* A node with one link is light: at full charge, a person's records push
     * each other, and the rest of the graph, away from that person, and the
     * reader can no longer tell whose they are. */
    let total = 0;
    for (const p of nodes) {
      p.charge = p.deg === 1 ? CHARGE_LEAF : CHARGE_BASE + CHARGE_PER_R * p.r;
      total -= p.charge;
    }
    /* The pull that holds the graph at `reach`. Spread evenly over a disc of
     * radius R, a total charge Q pushes a node at distance d from the centre
     * outward by Q·d/R²; a pull of Q/R² per px of distance cancels it at every
     * d. So the repulsion spaces the nodes, the pull keeps the whole the size
     * it needs, and no wall has to. */
    pull = total / (reach * reach);
  }

  /* ---------- the simulation ---------- */

  function tick(a) {
    const cx = layoutW / 2, cy = layoutH / 2;
    const n = nodes.length;

    /* 1 — link springs (predictive, d3-style: read x+vx) */
    for (let i = 0; i < active.length; i++) {
      const l = active[i], p = l.source, q = l.target;
      let dx = (q.x + q.vx) - (p.x + p.vx);
      let dy = (q.y + q.vy) - (p.y + p.vy);
      let d = Math.sqrt(dx * dx + dy * dy);
      if (!(d > 1e-6)) { dx = jiggle(); dy = jiggle(); d = Math.sqrt(dx * dx + dy * dy) || 1e-6; }
      const f = ((d - l.distance) / d) * a * l.strength;
      const fx = dx * f, fy = dy * f;
      q.vx -= fx * l.bias; q.vy -= fy * l.bias;
      p.vx += fx * (1 - l.bias); p.vy += fy * (1 - l.bias);
    }

    /* 2 — many-body repulsion, O(n^2) with a distance cutoff. A few hundred
     *     nodes is the design ceiling; past that the cutoff does the work. */
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j];
        let dx = q.x - p.x, dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cutoff2) continue;
        if (!(d2 > 1e-6)) { dx = jiggle(); dy = jiggle(); d2 = dx * dx + dy * dy; }
        if (d2 < MIN_D2) d2 = MIN_D2;                 // floor the divisor, keep dx small
        const wq = (q.charge * a) / d2;               // q acting on p
        const wp = (p.charge * a) / d2;               // p acting on q
        p.vx += dx * wq; p.vy += dy * wq;
        q.vx -= dx * wp; q.vy -= dy * wp;
      }
    }

    /* 3 — pull to centre, damping, integration */
    const rail2 = Math.pow(RAIL * reach, 2);
    let mx = 0, my = 0, free = 0;

    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      if (p.fx !== null && p.fy !== null) {
        p.x = p.fx; p.y = p.fy; p.vx = 0; p.vy = 0;
      } else {
        p.vx += (cx - p.x) * pull * a;
        p.vy += (cy - p.y) * pull * a;
        p.vx *= VELOCITY_DECAY; p.vy *= VELOCITY_DECAY;
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (sp > MAX_SPEED) { const s = MAX_SPEED / sp; p.vx *= s; p.vy *= s; }
        p.x += p.vx; p.y += p.vy;
        free++;
        /* the far rail: a settled layout sits well inside it */
        const ox = p.x - cx, oy = p.y - cy, o2 = ox * ox + oy * oy;
        if (o2 > rail2) {
          const s = Math.sqrt(rail2 / o2);
          p.x = cx + ox * s; p.y = cy + oy * s; p.vx = 0; p.vy = 0;
        }
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {   // belt and braces
        p.x = cx + (rnd() - 0.5) * 40; p.y = cy + (rnd() - 0.5) * 40;
        p.vx = 0; p.vy = 0;
      }
      mx += p.x; my += p.y;
    }

    /* 4 — collision: nodes never overlap. Position-only relaxation. */
    const iters = n > 150 ? 1 : 2;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const p = nodes[i];
        const rp = p.r + COLLIDE_PAD;
        for (let j = i + 1; j < n; j++) {
          const q = nodes[j];
          const min = rp + q.r + COLLIDE_PAD;
          let dx = q.x - p.x, dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (!(d > 1e-6)) { dx = jiggle(); dy = jiggle(); d = Math.sqrt(dx * dx + dy * dy) || 1e-6; }
          const push = ((min - d) / d) * 0.5;
          const px = dx * push, py = dy * push;
          const pFixed = p.fx !== null, qFixed = q.fx !== null;
          if (pFixed && qFixed) continue;
          if (pFixed) { q.x += px * 2; q.y += py * 2; }
          else if (qFixed) { p.x -= px * 2; p.y -= py * 2; }
          else { p.x -= px; p.y -= py; q.x += px; q.y += py; }
        }
      }
    }

    /* 5 — recentre on the centroid: keeps the drawing in frame without adding
     *     energy, so it can never fight the damping. */
    if (free && n) {
      const ex = (cx - mx / n) * RECENTRE, ey = (cy - my / n) * RECENTRE;
      if (Number.isFinite(ex) && Number.isFinite(ey) && (ex || ey)) {
        for (let i = 0; i < n; i++) {
          const p = nodes[i];
          if (p.fx !== null) continue;
          p.x += ex; p.y += ey;
        }
      }
    }
  }

  const budget = () => Math.round(clamp(120 + nodes.length, 90, 420));

  function reheat(a = 1, refit = false) {
    if (dead) return;
    alpha = Math.max(alpha, clamp(a, ALPHA_MIN * 2, 1));
    ticksLeft = budget();
    alphaDecay = 1 - Math.pow(ALPHA_MIN / alpha, 1 / ticksLeft);
    run(refit);
  }

  function step() {
    tick(alpha);
    alpha -= alpha * alphaDecay;
    ticksLeft--;
  }

  function run(refit = false) {
    if (dead) return;
    if (refit) wantFit = true;
    /* A page builds its graph before attaching it. Start once the frame is
     * known, so the view that follows the layout is fitted to the real one:
     * the resize observer starts the run as soon as the container has a size. */
    if (!sized && ro) { pendingRun = true; return; }
    if (!nodes.length) { render(); settle(); return; }
    /* prefers-reduced-motion: settle the whole layout in one pass, paint once */
    if (reducedMotion()) {
      let guard = budget() + 8;                   // never trust the loop bound alone
      while (ticksLeft > 0 && alpha > ALPHA_MIN && guard-- > 0) step();
      render();
      settle();
      return;
    }
    if (simRaf) return;
    simRaf = raf(frame);
  }

  function frame() {
    simRaf = 0;
    if (dead) return;
    const t0 = now();
    do { step(); } while (ticksLeft > 0 && alpha > ALPHA_MIN && now() - t0 < FRAME_MS);
    render();
    /* The view follows the layout as it grows, a share of the way each frame,
     * so the settled fit is a short glide rather than a jump. */
    if (wantFit && !userMoved && !tweenRaf) {
      const t = fitView();
      const c = centreOf(view), e = centreOf(t);
      viewAt(c.x + (e.x - c.x) * FOLLOW, c.y + (e.y - c.y) * FOLLOW,
             view.k * Math.pow(t.k / view.k, FOLLOW));
    }
    if (ticksLeft > 0 && alpha > ALPHA_MIN) simRaf = raf(frame);
    else settle();
  }

  /** The loop has stopped. Nothing animates until something reheats it. */
  function settle() {
    alpha = 0; ticksLeft = 0;
    arrangeIsolated();
    render();                      // the rings just moved the loose nodes
    if (wantFit && !userMoved) fit(true);
    placeLabels();
    wantFit = false;
  }

  /**
   * Park the nodes that have no surviving link in tidy rings just outside the
   * connected core, instead of leaving them wherever the seed spiral put them.
   *
   * They are not noise: they are people the store knows and has drawn no link
   * to under the current filter, which is worth seeing. But scattered through
   * the empty field they read as a rendering fault, and — because `fit()`
   * measures every node — they inflate the bounding box until the part of the
   * graph that has structure is squeezed into a corner. A deliberate band says
   * the same thing and leaves the core legible.
   */
  function arrangeIsolated() {
    if (!nodes.length || !links.length) return;
    const linked = new Set();
    for (const l of links) {
      if (!allowed(l)) continue;
      linked.add(l.source); linked.add(l.target);
    }
    if (!linked.size) return;
    const loose = nodes.filter(p => !linked.has(p) && p.fx === null);
    if (!loose.length) return;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of nodes) {
      if (!linked.has(p)) continue;
      x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
      y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r);
    }
    if (!Number.isFinite(x0)) return;

    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let r = Math.max(x1 - x0, y1 - y0) / 2 + 44;
    let i = 0;
    while (i < loose.length) {
      const per = Math.max(8, Math.floor((2 * Math.PI * r) / 26));
      const take = Math.min(per, loose.length - i);
      for (let j = 0; j < take; j++, i++) {
        const a = (j / take) * Math.PI * 2 + r * 0.011;   // offset each ring
        const p = loose[i];
        p.x = cx + r * Math.cos(a);
        p.y = cy + r * Math.sin(a);
        p.vx = 0; p.vy = 0;
      }
      r += 30;
    }
  }

  /**
   * Place labels greedily in weight order; a label that would collide with one
   * already placed is dropped rather than drawn over it. Two overlapping names
   * are less readable than one, and the dropped one stays reachable by hover,
   * keyboard focus and the list beside the graph — so nothing is gated on it.
   *
   * Zoomed in well past the fit, the nodes stand far enough apart for more
   * names: every node may then carry one, unless the caller ruled it out, and
   * the same collision rule decides which.
   */
  function placeLabels() {
    labelRaf = 0;
    const taken = [];
    const zoomed = nodes.length > 0 && view.k >= fitView().k * ZOOM_LABELS;
    for (const p of order) {
      const rec = recs.get(p.id);
      if (!rec) continue;
      let show = !!rec.wantLabel || (zoomed && !rec.never && rec.op > DIM);
      if (show) {
        const chars = Math.min(labelChars, String(p.label || '').length) || 1;
        const w = (chars * 6.2) / view.k;          // ~6.2px per char at 11px
        const hh = 13 / view.k;
        const x = p.x - w / 2;
        const y = p.y + p.r + LABEL_GAP / view.k;
        // What the reader asked for always wins a collision.
        const forced = p.id === selected || p.id === focused || p.id === hovered;
        if (!forced) {
          for (const b of taken) {
            if (x < b.x + b.w && x + w > b.x && y < b.y + b.hh && y + hh > b.y) { show = false; break; }
          }
        }
        if (show) taken.push({ x, y, w, hh });
      }
      if (show !== rec.labelOn) {
        rec.labelOn = show;
        rec.label.setAttribute('display', show ? 'inline' : 'none');
      }
      if (show) {
        rec.label.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
        rec.label.setAttribute('y', (p.r + LABEL_GAP / view.k).toFixed(1));
      }
    }
  }

  /** Re-place the labels once per frame at most, after the view's scale moved. */
  function scheduleLabels() {
    if (!labelRaf && !dead) labelRaf = raf(placeLabels);
  }

  /* ---------- painting ---------- */

  function render() {
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (!l.line || !l.visible) continue;
      l.line.setAttribute('x1', l.source.x.toFixed(1));
      l.line.setAttribute('y1', l.source.y.toFixed(1));
      l.line.setAttribute('x2', l.target.x.toFixed(1));
      l.line.setAttribute('y2', l.target.y.toFixed(1));
      if (l.hit) {
        l.hit.setAttribute('x1', l.source.x.toFixed(1));
        l.hit.setAttribute('y1', l.source.y.toFixed(1));
        l.hit.setAttribute('x2', l.target.x.toFixed(1));
        l.hit.setAttribute('y2', l.target.y.toFixed(1));
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i], rec = recs.get(p.id);
      if (!rec) continue;
      const t = `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`;
      rec.g.setAttribute('transform', t);
      if (rec.labelOn) rec.label.setAttribute('transform', t);
    }
  }

  /** Everything that is state rather than position: colour, opacity, rings. */
  function paint() {
    const near = focused ? neighbourhood(focused) : null;
    const anyLinks = active.length > 0;

    for (const p of nodes) {
      const rec = recs.get(p.id);
      if (!rec) continue;
      const marked = p.id === selected || p.id === focused;
      let o = marked ? 1 : ceiling(p);
      if (anyLinks && !p.deg) o = Math.min(o, ISOLATED);
      if (near && !near.has(p.id)) o = Math.min(o, DIM);
      rec.g.setAttribute('opacity', o.toFixed(3));

      rec.sel.setAttribute('opacity', marked ? '1' : '0');
      rec.pin.setAttribute('opacity', p.fx !== null ? '0.9' : '0');
      rec.g.setAttribute('aria-pressed', p.id === selected ? 'true' : 'false');

      rec.op = o;
      rec.wantLabel = (rec.big || marked || hovered === p.id) && o > DIM;
      rec.label.setAttribute('opacity', o.toFixed(3));
    }

    placeLabels();

    for (const l of links) {
      if (!l.line) continue;
      const vis = allowed(l);
      l.visible = vis;
      l.line.setAttribute('display', vis ? 'inline' : 'none');
      if (l.hit) l.hit.setAttribute('display', vis ? 'inline' : 'none');
      if (!vis) { if (l === hotLink) setHotLink(null, null); continue; }
      const so = l.style ? l.style.opacity : null;
      let o = (so !== null && so !== undefined && Number.isFinite(Number(so)))
        ? clamp(Number(so), 0, 1)
        : LINK_O_MIN + (LINK_O_MAX - LINK_O_MIN) * l.nw;
      const floor = l.style ? Number(l.style.minOpacity) : NaN;
      if (Number.isFinite(floor)) o = Math.max(o, clamp(floor, 0, 1));
      if (near && l.source.id !== focused && l.target.id !== focused) o *= DIM_LINK;
      l.line.setAttribute('stroke-opacity', o.toFixed(3));
    }
  }

  /** The caller's opacity ceiling for a node; 1 when it sets none. */
  function ceiling(p) {
    if (!nodeOpacityFor) return 1;
    const v = nodeOpacityFor(p.src);
    return (v === null || v === undefined || !Number.isFinite(Number(v))) ? 1 : clamp(Number(v), 0, 1);
  }

  function neighbourhood(id) {
    const set = new Set([id]);
    const nb = adj.get(id);
    if (nb) for (const other of nb) set.add(other);
    return set;
  }

  /* ---------- DOM build (keyed, so keyboard focus survives an update) ---------- */

  function build() {
    for (const [id, rec] of recs) {
      if (byId.has(id)) continue;
      if (rec.g.parentNode) rec.g.parentNode.removeChild(rec.g);
      if (rec.label.parentNode) rec.label.parentNode.removeChild(rec.label);
      dropFace(rec);
      recs.delete(id);
    }

    const labelled = Math.max(1, Math.min(labelMax, Math.ceil(order.length * labelShare)));

    order.forEach((p, i) => {
      let rec = recs.get(p.id);
      if (!rec) { rec = makeNode(p); recs.set(p.id, rec); }
      /* labelFor may force a label on (true), off (false), or leave it to the
       * weight rule (undefined). A forced label still yields to a collision
       * unless the node is selected, focused or hovered. */
      const want = labelFor ? labelFor(p.src) : undefined;
      rec.big = (want === undefined || want === null) ? i < labelled : !!want;
      rec.never = want === false;
      syncFace(rec, p);
      styleNode(rec, p);
      gNodes.appendChild(rec.g);       // re-append = z order and tab order, by weight
      gLabels.appendChild(rec.label);
    });

    gLinks.textContent = '';
    gHits.textContent = '';
    if (hotLink) setHotLink(null, null);     // the links it pointed into are being replaced
    for (const l of links) {
      l.style = linkStyleFor ? linkStyleFor(l.src) || null : null;
      const w = l.style ? Number(l.style.width) : NaN;
      l.line = el('line', {
        class: 'force-link',
        stroke: (linkColorFor && linkColorFor(l.src)) || 'var(--grid)',
        'stroke-width': Number.isFinite(w) && w > 0 ? w : 1,
        'stroke-dasharray': l.style && l.style.dash ? String(l.style.dash) : null,
        'vector-effect': 'non-scaling-stroke',
      });
      gLinks.appendChild(l.line);
      if (onLinkHover) {
        l.hit = el('line', { 'stroke-width': LINK_HIT_WIDTH, 'vector-effect': 'non-scaling-stroke',
                             'pointer-events': 'stroke' });
        hitOf.set(l.hit, l);
        gHits.appendChild(l.hit);
      }
    }

    empty.setAttribute('display', nodes.length ? 'none' : 'inline');
    container.setAttribute('aria-label',
      `Force-directed graph: ${nodes.length} nodes, ${links.length} links. ` +
      'Tab moves between nodes in size order, Enter selects, Escape clears, ' +
      'arrow keys pan, plus and minus zoom, 0 fits the graph, f fills the window.');
  }

  function makeNode(p) {
    const g = el('g', { class: 'force-node', tabindex: '0', role: 'button' });
    g.style.cursor = 'pointer';
    g.style.outline = 'none';

    const hit = el('circle', { class: 'force-hit', fill: 'transparent', stroke: 'none' });
    const sel = el('circle', {
      class: 'force-ring', fill: 'none', stroke: 'var(--text-primary)',
      'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', opacity: 0,
    });
    const pin = el('circle', {
      class: 'force-pin', fill: 'none', stroke: 'var(--text-muted)',
      'stroke-width': 1, 'stroke-dasharray': '2 3',
      'vector-effect': 'non-scaling-stroke', opacity: 0,
    });
    const dot = el('circle', {
      class: 'force-dot', stroke: 'var(--surface-1)',
      'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
    });

    g.appendChild(hit); g.appendChild(sel); g.appendChild(pin); g.appendChild(dot);

    const label = el('text', { class: 'force-label', display: 'none' });
    label.textContent = trunc(p.label, labelChars);

    const rec = { g, hit, sel, pin, dot, label, face: null, big: false, never: false, op: 1, labelOn: false };

    /* Handlers resolve the node by id at event time. update() replaces every
     * node object, and a listener holding the old one would move a ghost. */
    const id = p.id;
    const live = () => byId.get(id);

    on(g, 'pointerdown', ev => { const q = live(); if (q) startDrag(q, rec, ev); });
    on(g, 'dblclick', ev => {
      const q = live(); if (!q) return;
      if (ev.preventDefault) ev.preventDefault();
      q.fx = null; q.fy = null; paint(); reheat(0.3);        // release the pin
    });
    on(g, 'keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        if (ev.preventDefault) ev.preventDefault();
        const q = live(); if (q) select(q);
      }
    });
    on(g, 'focus', () => { const q = live(); if (!q) return; hovered = id; paint(); ensureVisible(q); });
    on(g, 'blur', () => { if (hovered === id) { hovered = null; paint(); } });
    on(g, 'pointerenter', () => { if (live()) { hovered = id; paint(); } });
    on(g, 'pointerleave', () => { if (hovered === id) { hovered = null; paint(); } });

    return rec;
  }

  /** The picture inside the node, laid out against the node's current radius.
   *
   *  Deferred until the image has reported its natural size, because the crop
   *  is expressed in fractions of it: `size` is the subject's width over the
   *  longer side, and (x, y) its centre. Both are re-applied whenever the
   *  radius changes, so a node that grows on an update grows its face with it.
   */
  function placeFace(rec) {
    const f = rec.face;
    if (!f || !f.nw || !f.nh || !(f.r > 0)) return;
    const clipR = Math.max(2, f.r - FACE_RIM);
    const d = clipR * 2;
    f.hole.setAttribute('r', clipR.toFixed(2));
    // The subject's box in source pixels, floored so a degenerate size cannot
    // blow the scale up to infinity.
    const side = Math.max(8, (f.size || 0.2) * Math.max(f.nw, f.nh));
    // Scale to sit the subject in the disc — but never so far down that the
    // photograph stops covering the disc. A wide group shot with one small
    // face in it would otherwise be drawn smaller than the hole it fills.
    const k = Math.max(d / (side * FACE_FILL), d / Math.min(f.nw, f.nh));
    const w = f.nw * k, h = f.nh * k;
    // Centre the subject, then slide back inside the photograph. A face near
    // an edge — and on this store half of them are — would otherwise pull the
    // picture off the disc and leave a bare wedge of node colour behind it.
    // Off-centre beats a hole: the clamp is what keeps every circle a picture.
    const x = clamp(-f.x * w, clipR - w, -clipR);
    const y = clamp(-f.y * h, clipR - h, -clipR);
    f.img.setAttribute('width', w.toFixed(2));
    f.img.setAttribute('height', h.toFixed(2));
    f.img.setAttribute('x', x.toFixed(2));
    f.img.setAttribute('y', y.toFixed(2));
    // In the node's own units, so the blur keeps its strength at any node size
    // and any zoom.
    if (f.blur) f.blur.firstChild.setAttribute('stdDeviation', (clipR * FACE_BLUR).toFixed(2));
    f.img.setAttribute('opacity', '1');
  }

  /** Take a node's picture down, with the clip that shaped it. */
  function dropFace(rec) {
    const f = rec.face;
    if (!f) return;
    if (f.img.parentNode) f.img.parentNode.removeChild(f.img);
    if (f.clip.parentNode) defs.removeChild(f.clip);
    if (f.blur && f.blur.parentNode) defs.removeChild(f.blur);
    rec.face = null;
  }

  /** Bring a node's picture into line with what faceFor says now.
   *
   *  Asked on every build rather than only at birth, so a page can offer the
   *  pictures as a switch: faceFor returning null takes down the <image> and
   *  its clip and leaves the circle that was underneath all along. Same href,
   *  nothing to do — an update that changes only the layout never reloads a
   *  picture it is already showing.
   */
  function syncFace(rec, p) {
    const spec = faceFor ? faceFor(p.src) : null;
    const href = (spec && spec.href) ? spec.href : null;
    const blur = !!(href && spec.blur);
    if (href === (rec.face ? rec.face.href : null)
        && blur === !!(rec.face && rec.face.blur)) return;
    dropFace(rec);
    // Over the dot, so the colour fill backs the picture while it loads and
    // shows through as the rim once it is there.
    if (href) rec.g.appendChild(makeFace(rec, spec));
  }

  /** Hang a picture on a node, or leave the plain circle if there is none.
   *
   *  The <image> is clipped to a disc a rim inside the node circle, so the
   *  colour the legend explains stays visible around it. Natural dimensions
   *  come from a probe rather than the <image>: SVGImageElement does not expose
   *  them. A probe that errors takes the picture out and leaves the circle.
   */
  function makeFace(rec, spec) {
    const id = `force-face-${++faceSeq}`;
    const clip = el('clipPath', { id, clipPathUnits: 'userSpaceOnUse' });
    const hole = el('circle', { cx: 0, cy: 0, r: 1 });
    clip.appendChild(hole);
    defs.appendChild(clip);

    const img = el('image', {
      class: 'force-face',
      'clip-path': `url(#${id})`,
      preserveAspectRatio: 'none',
      'pointer-events': 'none',
      opacity: 0,
    });
    img.setAttribute('href', spec.href);

    // A filter rather than CSS filter: blur(), which not every browser applies
    // to an SVG element. Its deviation is set in placeFace, once the disc is known.
    let blur = null;
    if (spec.blur) {
      blur = el('filter', { id: `${id}-blur` });
      blur.appendChild(el('feGaussianBlur', { stdDeviation: 0, edgeMode: 'duplicate' }));
      defs.appendChild(blur);
      img.setAttribute('filter', `url(#${id}-blur)`);
    }

    rec.face = {
      img, clip, hole, blur, href: spec.href, nw: 0, nh: 0, r: 0,
      x: num(spec.x), y: num(spec.y), size: num(spec.size),
    };

    const probe = new Image();
    on(probe, 'load', () => {
      if (dead || !rec.face || rec.face.img !== img) return;
      rec.face.nw = probe.naturalWidth;
      rec.face.nh = probe.naturalHeight;
      placeFace(rec);
    });
    // Only if this is still the picture on the node: a switch flicked twice
    // while the probe was in flight would otherwise take down its successor.
    on(probe, 'error', () => { if (rec.face && rec.face.img === img) dropFace(rec); });
    probe.src = spec.href;
    return img;
  }

  function styleNode(rec, p) {
    rec.hit.setAttribute('r', p.hit.toFixed(1));
    rec.dot.setAttribute('r', p.r.toFixed(1));
    const colour = colorFor(p.src) || 'var(--series-1)';
    rec.dot.setAttribute('fill', colour);
    // Every attribute is set either way: update() reuses a node's elements.
    const look = nodeStyleFor ? nodeStyleFor(p.src) : null;
    rec.dot.setAttribute('stroke', look ? colour : 'var(--surface-1)');
    rec.dot.setAttribute('fill-opacity', look && Number.isFinite(Number(look.fillOpacity))
      ? String(clamp(Number(look.fillOpacity), 0, 1)) : '1');
    if (look && look.dash) rec.dot.setAttribute('stroke-dasharray', String(look.dash));
    else rec.dot.removeAttribute('stroke-dasharray');
    rec.sel.setAttribute('r', (p.r + 3.5).toFixed(1));
    rec.pin.setAttribute('r', (p.r + 6).toFixed(1));
    rec.label.textContent = trunc(p.label, labelChars);
    rec.label.setAttribute('y', (p.r + LABEL_GAP / view.k).toFixed(1));
    if (rec.face) { rec.face.r = p.r; placeFace(rec); }
    const parts = [p.label];
    if (p.kind) parts.push(p.kind);
    else if (p.group) parts.push(p.group);
    parts.push(`weight ${Math.round(p.weight * 100) / 100}`);
    parts.push(`${p.deg} link${p.deg === 1 ? '' : 's'}`);
    rec.g.setAttribute('aria-label', parts.join(', '));
  }

  function restyleLabels() {
    for (const p of nodes) {
      const rec = recs.get(p.id);
      if (rec && rec.labelOn) rec.label.setAttribute('y', (p.r + LABEL_GAP / view.k).toFixed(1));
    }
  }

  /* ---------- view transform ---------- */

  let goal = null;                 // where a running tween is headed

  /** The zoom floor: a fifth, or half the fit for a graph that needs less than
   *  a fifth to be seen whole on this screen. */
  const kLo = () => Math.min(K_MIN, fitView().k * 0.5);

  function setView(tx, ty, k) {
    const before = view.k;
    view.k = clamp(Number.isFinite(k) ? k : 1, 0.01, K_MAX);
    view.tx = Number.isFinite(tx) ? tx : 0;
    view.ty = Number.isFinite(ty) ? ty : 0;
    root.setAttribute('transform',
      `translate(${view.tx.toFixed(2)},${view.ty.toFixed(2)}) scale(${view.k.toFixed(4)})`);
    gLabels.setAttribute('font-size', (11 / view.k).toFixed(2));
    gLabels.setAttribute('stroke-width', (3 / view.k).toFixed(2));
    restyleLabels();
    // A running layout places its labels when it settles.
    if (!alpha && Math.abs(view.k / before - 1) > 0.004) scheduleLabels();
    btnIn.setAttribute('aria-disabled', String(view.k >= K_MAX * 0.999));
    btnOut.setAttribute('aria-disabled', String(view.k <= kLo() * 1.001));
  }

  /** The graph point at the middle of the drawing, under view v. */
  const centreOf = v => ({ x: (vw / 2 - v.tx) / v.k, y: (vh / 2 - v.ty) / v.k });

  /** Put graph point (x, y) at the middle of the drawing, at scale k. */
  function viewAt(x, y, k) {
    const kk = clamp(k, 0.01, K_MAX);
    setView(vw / 2 - kk * x, vh / 2 - kk * y, kk);
  }

  /** The view that shows every node, padded, magnified no further than FIT_K_MAX.
   *  The right margin also clears the corner buttons. */
  function fitView(pad = 26) {
    const padR = pad + CONTROLS_W;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of nodes) {
      x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
      y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return { tx: 0, ty: 0, k: 1 };
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const k = clamp(Math.min(Math.max(1, vw - pad - padR) / bw, Math.max(1, vh - pad * 2) / bh), 0.02, FIT_K_MAX);
    return { tx: (vw - padR + pad) / 2 - k * (x0 + x1) / 2, ty: vh / 2 - k * (y0 + y1) / 2, k };
  }

  function fit(animate = false) {
    const t = fitView();
    if (animate) { tweenTo(t.tx, t.ty, t.k); return; }
    caf(tweenRaf); tweenRaf = 0; goal = null;
    setView(t.tx, t.ty, t.k);
  }

  /** Back to the whole graph — and keep it whole through later resizes. */
  function refit(animate) { userMoved = false; fit(animate); }

  /* Eased in the space the eye reads: the centre moves in a line, the scale
   * geometrically, so a zoom by 4 takes as long as a zoom by 1/4. */
  function tweenTo(tx, ty, k) {
    caf(tweenRaf); tweenRaf = 0;
    const kk = clamp(k, 0.01, K_MAX);
    if (reducedMotion()) { goal = null; setView(tx, ty, kk); return; }
    const t0 = now(), d = 260;
    const a = centreOf(view), ka = view.k;
    const b = centreOf({ tx, ty, k: kk });
    goal = { tx, ty, k: kk };
    const hop = ts => {
      tweenRaf = 0;
      if (dead) return;
      const e = clamp(((typeof ts === 'number' ? ts : now()) - t0) / d, 0, 1);
      const s = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2;
      viewAt(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, ka * Math.pow(kk / ka, s));
      if (e < 1) tweenRaf = raf(hop); else goal = null;
    };
    tweenRaf = raf(hop);
  }

  function centreOn(p, k) {
    const kk = clamp(k === undefined ? Math.max(view.k, 0.9) : k, kLo(), K_MAX);
    wantFit = false;          // a pending settle must not yank the view back
    tweenTo(vw / 2 - kk * p.x, vh / 2 - kk * p.y, kk);
  }

  /** Zoom about the middle of the drawing; a second press during the glide
   *  counts from where the first was going, not from where it has got to. */
  function zoomBy(f, animate = false) {
    const from = tweenRaf && goal ? goal : view;
    const k = clamp(from.k * f, kLo(), K_MAX);
    if (k === from.k) return;
    const c = centreOf(from);
    userMoved = true;
    if (animate) tweenTo(vw / 2 - k * c.x, vh / 2 - k * c.y, k);
    else { caf(tweenRaf); tweenRaf = 0; goal = null; viewAt(c.x, c.y, k); }
  }

  /** Zoom keeping the graph point under `pt` (drawing px) where it is. */
  function zoomAt(pt, k, animate = false) {
    const kk = clamp(k, kLo(), K_MAX);
    if (kk === view.k) return;
    const g = toGraph(pt);
    userMoved = true;
    if (animate) { tweenTo(pt.x - g.x * kk, pt.y - g.y * kk, kk); return; }
    caf(tweenRaf); tweenRaf = 0; goal = null;
    setView(pt.x - g.x * kk, pt.y - g.y * kk, kk);
  }

  function panBy(dx, dy) { userMoved = true; setView(view.tx + dx, view.ty + dy, view.k); }

  /** Keyboard focus must not land on something off-screen. */
  function ensureVisible(p) {
    const sx = p.x * view.k + view.tx, sy = p.y * view.k + view.ty;
    const m = 28;
    if (sx < m || sy < m || sx > vw - m || sy > vh - m) centreOn(p, view.k);
  }

  /* ---------- size: follow the container and the window ---------- */

  /** The drawing's size for the container as it is now; null while it has none
   *  (detached, or hidden). Filling the window, it is the container's own box,
   *  which the stylesheet sets. On the page, it is the container's width and a
   *  height drawn from the window: the layout's shape where that fits, at least
   *  H_FILL of the window, never more than H_MAX of it, never under H_MIN. */
  function measure() {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
    const padX = cs ? num(parseFloat(cs.paddingLeft)) + num(parseFloat(cs.paddingRight)) : 0;
    const padY = cs ? num(parseFloat(cs.paddingTop)) + num(parseFloat(cs.paddingBottom)) : 0;
    const w = Math.floor(num(container.clientWidth) - padX);
    if (!(w > 0)) return null;
    if (expanded) {
      const h = Math.floor(num(container.clientHeight) - padY);
      return h > 0 ? { w, h } : null;
    }
    const win = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 800;
    let h = Math.max(w * layoutH / layoutW, win * H_FILL);
    h = Math.min(h, win * H_MAX, w * TALL);
    return { w, h: Math.round(Math.max(h, H_MIN)) };
  }

  function applySize() {
    sizeRaf = 0;
    if (dead) return;
    const m = measure();
    if (!m) return;
    const first = !sized;
    sized = true;
    if (!first && m.w === vw && m.h === vh) return;
    const ow = vw, oh = vh;
    vw = m.w; vh = m.h;
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    svg.setAttribute('width', vw);
    svg.setAttribute('height', vh);
    empty.setAttribute('x', vw / 2);
    empty.setAttribute('y', vh / 2);
    if (first || !userMoved) fit();
    else setView(view.tx + (vw - ow) / 2, view.ty + (vh - oh) / 2, view.k);   // same centre
    if (pendingRun) { pendingRun = false; run(); }
  }

  /* Measured a frame later rather than inside the observer: the drawing's new
   * height changes the container's, and answering that in the same callback is
   * a resize loop. */
  function scheduleSize() { if (!sizeRaf && !dead) sizeRaf = raf(applySize); }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleSize) : null;
  if (ro) ro.observe(container);
  if (typeof window === 'object' && window) on(window, 'resize', scheduleSize);

  /* ---------- filling the window ---------- */

  /** A sheet over the page rather than the Fullscreen API: in fullscreen only
   *  the one element is drawn, and the tooltips and drawers the pages hang on
   *  document.body would vanish behind it. */
  function setExpanded(want) {
    want = !!want;
    if (dead || want === expanded) return;
    expanded = want;
    expandEl.classList.toggle('force-expanded', want);
    document.documentElement.classList.toggle('force-locked', want);
    relabel(btnExpand, want ? 'collapse' : 'expand', want ? 'Back to the page (Esc)' : 'Fill the window (f)');
    btnExpand.setAttribute('aria-pressed', String(want));
    userMoved = false;                          // a new frame: show the whole graph in it
    scheduleSize();
    try { (want ? container : btnExpand).focus({ preventScroll: true }); } catch { /* fine */ }
  }

  /* Escape leaves the sheet from anywhere on it — unless something is open over
   * it, such as a drawer, which has the key first. Capture, so the graph's own
   * Escape does not also clear the selection. */
  if (typeof window === 'object' && window) on(window, 'keydown', ev => {
    if (!expanded || ev.key !== 'Escape') return;
    const top = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(innerWidth / 2, innerHeight / 2) : null;
    if (top && !expandEl.contains(top)) return;
    ev.stopPropagation();
    setExpanded(false);
  }, true);

  function showHint() {
    hint.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('on'), HINT_MS);
  }

  /* ---------- pointer plumbing ---------- */

  function local(ev) {
    const ctm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    if (ctm && typeof ctm.a === 'number') {
      const det = ctm.a * ctm.d - ctm.b * ctm.c;
      if (det) {
        const x = ev.clientX - ctm.e, y = ev.clientY - ctm.f;
        return { x: (x * ctm.d - y * ctm.c) / det, y: (y * ctm.a - x * ctm.b) / det };
      }
    }
    const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) {
      return { x: (ev.clientX - r.left) * (vw / r.width), y: (ev.clientY - r.top) * (vh / r.height) };
    }
    return { x: num(ev.clientX), y: num(ev.clientY) };
  }

  const toGraph = pt => ({ x: (pt.x - view.tx) / view.k, y: (pt.y - view.ty) / view.k });

  function startDrag(p, rec, ev) {
    if (dead) return;
    if (ev.button !== undefined && ev.button !== null && ev.button !== 0) return;
    if (ev.stopPropagation) ev.stopPropagation();
    if (ev.preventDefault) ev.preventDefault();
    if (dragOff) dragOff();

    const id = ev.pointerId;
    const start = local(ev);
    let moved = false;

    if (rec.g.setPointerCapture && id !== undefined && id !== null) {
      try { rec.g.setPointerCapture(id); } catch { /* not supported */ }
    }

    const live = () => byId.get(p.id) || null;

    const move = e => {
      if (id !== undefined && e.pointerId !== undefined && e.pointerId !== id) return;
      const q = live();
      if (!q) { dragOff(); return; }
      const pt = local(e);
      if (!moved && Math.abs(pt.x - start.x) + Math.abs(pt.y - start.y) < 3) return;
      moved = true;
      wantFit = false;          // the view holds still under a node being placed
      const g = toGraph(pt);
      q.fx = g.x; q.fy = g.y; q.x = g.x; q.y = g.y;   // dragged nodes stay pinned
      render();
      reheat(0.35);
    };
    const up = e => {
      if (id !== undefined && e && e.pointerId !== undefined && e.pointerId !== id) return;
      dragOff();
      const q = live();
      if (!q) return;
      if (!moved) select(q);
      else { paint(); reheat(0.2); }
    };

    const target = typeof window === 'object' && window ? window : svg;
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    dragOff = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (rec.g.releasePointerCapture && id !== undefined && id !== null) {
        try { rec.g.releasePointerCapture(id); } catch { /* fine */ }
      }
      dragOff = null;
    };
  }

  /* background: pan with one pointer, pinch-zoom with two */
  const pointers = new Map();
  let panFrom = null, pinch = null, bgMoved = false;

  /* links: hover, delegated to the hit-line group; a gesture in progress wins.
   * The hit lines only say the pointer is near some link. Which one is the link
   * whose line passes closest to it: in a dense patch the topmost hit line is
   * often a neighbour's, not the line the pointer is on. */
  function nearestLink(ev, fallback) {
    const pt = local(ev);
    const x = (pt.x - view.tx) / view.k, y = (pt.y - view.ty) / view.k;
    let best = fallback, bd = Infinity;
    for (const l of links) {
      if (!l.hit || !l.visible) continue;
      const ax = l.source.x, ay = l.source.y, dx = l.target.x - ax, dy = l.target.y - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
  on(gHits, 'pointermove', ev => {
    if (pointers.size) return;
    const under = hitOf.get(ev.target) || null;
    setHotLink(under ? nearestLink(ev, under) : null, ev);
  });
  on(gHits, 'pointerleave', ev => setHotLink(null, ev));

  on(svg, 'pointerdown', ev => {
    if (hotLink) setHotLink(null, ev);
    if (ev.button !== undefined && ev.button !== null && ev.button !== 0) return;
    if (ev.preventDefault) ev.preventDefault();
    pointers.set(ev.pointerId, local(ev));
    caf(tweenRaf); tweenRaf = 0; goal = null;   // a hand on the graph stops any glide
    if (svg.setPointerCapture) { try { svg.setPointerCapture(ev.pointerId); } catch { /* ok */ } }
    if (pointers.size === 1) {
      bgMoved = false;
      panFrom = { pt: local(ev), tx: view.tx, ty: view.ty };
      svg.style.cursor = 'grabbing';
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        tx: view.tx, ty: view.ty, k: view.k,
      };
      panFrom = null;
    }
  });

  on(svg, 'pointermove', ev => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, local(ev));
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const k = clamp(pinch.k * (d / pinch.d), kLo(), K_MAX);
      const g = { x: (pinch.mid.x - pinch.tx) / pinch.k, y: (pinch.mid.y - pinch.ty) / pinch.k };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      bgMoved = true; userMoved = true;
      setView(mid.x - g.x * k, mid.y - g.y * k, k);
      return;
    }
    if (!panFrom) return;
    const pt = local(ev);
    const dx = pt.x - panFrom.pt.x, dy = pt.y - panFrom.pt.y;
    if (!bgMoved && Math.abs(dx) + Math.abs(dy) < 3) return;
    bgMoved = true; userMoved = true;
    setView(panFrom.tx + dx, panFrom.ty + dy, view.k);
  });

  const endPointer = ev => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      svg.style.cursor = 'grab';
      const wasPan = panFrom !== null;
      panFrom = null;
      if (wasPan && !bgMoved) { focused = null; select(null); }   // empty space: deselect
    }
  };
  on(svg, 'pointerup', endPointer);
  on(svg, 'pointercancel', endPointer);
  on(svg, 'pointerleave', ev => {
    /* With capture held the gesture is still live; only clean up when it is not. */
    if (svg.hasPointerCapture && svg.hasPointerCapture(ev.pointerId)) return;
    endPointer(ev);
  });

  /* The wheel. A pinch on a trackpad arrives as ctrl + wheel, and ⌘ or Ctrl
   * held over a mouse wheel asks for the same; those zoom. A plain scroll is
   * the page's — a graph that swallowed it would trap the reader halfway down —
   * so it scrolls on past and the hint says how to zoom. Filling the window
   * there is no page to scroll, and a plain scroll zooms. */
  on(svg, 'wheel', ev => {
    const pinchy = !!ev.ctrlKey;
    if (!pinchy && !ev.metaKey && !expanded) {
      if (Math.abs(num(ev.deltaY)) > Math.abs(num(ev.deltaX))) showHint();
      return;
    }
    if (ev.preventDefault) ev.preventDefault();
    const dy = num(ev.deltaY) * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? vh : 1);
    /* A pinch reports small deltas and a wheel notch about a hundred: each is
     * scaled to feel alike, and one event's step is capped so no wheel leaps. */
    const step = clamp(-dy * (pinchy ? 0.01 : 0.002), -0.5, 0.5);
    zoomAt(local(ev), view.k * Math.pow(2, step));
  }, { passive: false });

  /* Double-click the background to zoom in there; with Shift, out. A node's
   * own double-click is its unpin. */
  on(svg, 'dblclick', ev => {
    if (ev.target && gNodes.contains(ev.target)) return;
    if (ev.preventDefault) ev.preventDefault();
    zoomAt(local(ev), view.k * (ev.shiftKey ? 0.5 : 2), true);
  });

  on(container, 'keydown', ev => {
    const k = ev.key;
    if (k === 'Escape') { focused = null; select(null); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;      // the browser's: ⌘+ zoom, ⌘F find
    let handled = true;
    if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === '0') refit(true);
    else if (k === 'f' || k === 'F') setExpanded(!expanded);
    else if (k === 'ArrowLeft') panBy(40, 0);
    else if (k === 'ArrowRight') panBy(-40, 0);
    else if (k === 'ArrowUp') panBy(0, 40);
    else if (k === 'ArrowDown') panBy(0, -40);
    else handled = false;
    if (handled && ev.preventDefault) ev.preventDefault();
  });

  function select(p) {
    selected = p ? p.id : null;
    paint();
    onSelect(p ? p.src : null);
  }

  /* ---------- public API ---------- */

  function update(next) {
    if (dead) return;
    const n = next || {};
    if (n.nodes !== undefined) rawNodes = n.nodes;
    if (n.links !== undefined) rawLinks = n.links;
    ingest(rawNodes, rawLinks);
    if (selected && !byId.has(selected)) selected = null;
    if (focused && !byId.has(focused)) focused = null;
    if (hovered && !byId.has(hovered)) hovered = null;
    recomputeActive();
    build();
    paint();
    render();
    userMoved = false;                 // new data, new picture — refit is welcome
    reheat(1, true);
  }

  function setLinkFilter(kinds) {
    if (dead) return;
    linkFilter = kinds === null || kinds === undefined ? null
      : kinds instanceof Set ? new Set([...kinds].map(String))
      : Array.isArray(kinds) ? new Set(kinds.map(String))
      : new Set([String(kinds)]);
    recomputeActive();
    for (const p of nodes) { const rec = recs.get(p.id); if (rec) styleNode(rec, p); }
    paint();
    render();
    reheat(0.85, true);                // hiding links must reflow the graph
  }

  function focus(id) {
    if (dead) return;
    const p = id === null || id === undefined ? null : byId.get(String(id));
    focused = p ? p.id : null;
    paint();
    if (p) { userMoved = true; centreOn(p); }   // a placed view: a resize keeps it centred
  }

  function destroy() {
    if (dead) return;
    if (expanded) {
      expandEl.classList.remove('force-expanded');
      document.documentElement.classList.remove('force-locked');
      expanded = false;
    }
    dead = true;
    caf(simRaf); caf(tweenRaf); caf(labelRaf); caf(sizeRaf);
    simRaf = 0; tweenRaf = 0; labelRaf = 0; sizeRaf = 0;
    clearTimeout(hintTimer);
    if (ro) ro.disconnect();
    if (dragOff) dragOff();
    if (hotLink) setHotLink(null, null);
    offAll();
    pointers.clear();
    recs.clear(); byId.clear(); adj.clear();
    nodes = []; links = []; active = []; order = [];
    container.textContent = '';
    container.removeAttribute('role');
    container.removeAttribute('aria-label');
    container.removeAttribute('tabindex');
    container.classList.remove('force-host');
  }

  /* ---------- first paint ---------- */

  ingest(rawNodes, rawLinks);
  recomputeActive();
  build();
  paint();
  setView(0, 0, 1);
  applySize();                     // now, if the container is already in the page
  render();
  reheat(1, true);

  return { update, setLinkFilter, focus, fit: () => refit(true), destroy };
}

export default forceGraph;
