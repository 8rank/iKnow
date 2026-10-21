"""social.py — the social graph: who the store links to whom, and how.

The store holds `group of humans` entities and their membership facets, a pile
of calendar invitation rows, a per-person closeness scorecard, and a log of
interaction metadata keyed to opaque handles. This endpoint draws them as one
graph and clusters the calendar overlap and the chat overlap into circles. The
payload still labels every cluster and every edge kind with its `origin` —
"stored" for rows read out of the store as they stand, "derived" for the
measurements made at request time — so a page can choose the right fallback
when a block of evidence comes back empty.

Four cut points are request parameters with defaults, not anything the store
says. Each is clamped to the range declared beside it, and `cuts` reports the
value ACTUALLY applied rather than the one that was asked for. `sensitivity`
sweeps the two clustering cuts across a fixed short list so a reader can see
how the circle count moves with the threshold.

`/api/social/component` opens one cluster: what it is, who is in it, and the
evidence that put them there — the stored statements with their confidence and
decoded ingest source for a stored group, the measured pairwise overlap, cut
included, for a derived one.
"""

import collections
import itertools
import sqlite3

from . import comms, db, faces, vocab

GRAPH = "graph/graph.db"
TAGGING = "graph/Artifacts__entityTagging__entityTagging.db"
REMEMBERS = "graph/Artifacts__siri__remembers__view.db"
VIEWS = "graph/Artifacts__internal__views.db"

# --- the clustering cuts: request parameters with defaults ------------------
# Each is a request parameter with a default and a hard range. A value outside
# the range is clamped rather than refused, and `cuts` says that it was.
JACCARD_CUT = 0.5        # a PAIR is joined when half their meetings coincide; a
                         # circle is a component of that, so two people can share
                         # one without ever clearing this between themselves
JACCARD_RANGE = (0.05, 0.95)
CLOSENESS_CUT = 0.5      # closeness head above which we draw an edge to the owner
CLOSENESS_RANGE = (0.0, 1.0)
CHANNEL_SHARE_CUT = 2    # shared handles before two group chats are called related
CHANNEL_SHARE_RANGE = (1, 10)
COLOUR_SLOTS = 8         # categorical slots; a ninth cluster folds into "other"

# The cuts `sensitivity` actually tries: a fixed short list rather than a
# continuous curve, travelling in the payload so the page can name the values
# swept instead of implying it swept everything.
JACCARD_SWEEP = tuple(round(0.05 * i, 2) for i in range(1, 20))
CHANNEL_SWEEP = tuple(range(CHANNEL_SHARE_RANGE[0], CHANNEL_SHARE_RANGE[1] + 1))

# Caps on the evidence one component returns. Both the cap and the true total
# travel with the rows, so a truncated list can never read as a complete one.
PAIR_LIMIT = 120
SHARED_LIMIT = 40
EXAMPLE_LIMIT = 5

# The reified shapes this page reads. Named here so the SQL below stays legible.
P_ATTENDEE = "PS232"
P_ORGANIZER = "PS578"
P_SENDER = "PS580"
P_GROUP_MEMBER = "PS753"
P_EMPLOYER = "PS500"
F_PERSON = "PS143"       # the facet of an attendance/organizer statement holding the person
F_MEMBER = "PS566"       # the facet of the group statement holding a member
F_ORG = "PS45"           # the facet of an employment statement holding the organisation
F_START = "PS29"         # the facet of nm_hasDate holding the serialised start components

LEAF_KINSHIP = ("mother", "father", "sister", "brother", "partner",
                "son", "daughter", "myself")

SOCIAL_IDS_SQL = f"""
  SELECT DISTINCT CAST(substr(object,4) AS INTEGER) AS pid FROM event_graph
    WHERE predicate IN ('{P_ATTENDEE}','{P_ORGANIZER}') AND relationshipPredicate='{F_PERSON}'
  UNION SELECT DISTINCT CAST(substr(object,4) AS INTEGER) FROM event_graph
    WHERE predicate='{P_SENDER}'
  UNION SELECT DISTINCT CAST(substr(object,4) AS INTEGER) FROM stable_graph
    WHERE predicate='{P_GROUP_MEMBER}' AND relationshipPredicate='{F_MEMBER}'
  UNION SELECT subject FROM stable_graph WHERE predicate='nm_isCurrentUser'
"""


# ---------------------------------------------------------------- helpers

def _attach(conn, alias, filename):
    """ATTACH once per pooled connection; the handle outlives the request."""
    already = {row[1] for row in conn.execute("pragma database_list")}
    if alias not in already:
        # The file: URI, not a bare path: ATTACH given a plain filename opens
        # the store read-write even from this read-only handle, and against the
        # live stores that is a write handle on a database a daemon owns.
        path = db.resolve("graph/" + filename)
        try:
            conn.execute("attach database ? as " + alias, (f"file:{path}?mode=ro",))
        except sqlite3.OperationalError as exc:
            # Said on the page; the statements that name the alias then read as
            # empty, and say so too.
            db.note("graph/" + filename, *(db.why_not(path) or ("open", f"could not be attached — {exc}")))


def _rows(conn, sql, params=()):
    return db.rows(conn, sql, params)


# label_source for a name the live graph no longer holds (vocab.withdrawn_names).
WITHDRAWN_NAME = "name only in the retraction archive"


def _label_chain(eid, names, parts, handles, withdrawn=None):
    """PS33 -> PS312+PS441 -> a name in the retraction archive -> a contact
    handle -> the bare id.

    Many entities in this store carry no name at all, and some of the people
    on this page are named only by the address they were invited at. Inventing a
    placeholder would hide that, so the handle is shown as the label.
    """
    if names.get(eid):
        return names[eid], "full name"
    bits = [b for b in parts.get(eid, ()) if b]
    if bits:
        return " ".join(bits), "name fragments"
    if withdrawn and withdrawn.get(eid):
        return withdrawn[eid], WITHDRAWN_NAME
    if handles.get(eid):
        return handles[eid][0], "contact handle only"
    return vocab.sid(eid), "no name in the store"


def _clamp(raw, lo, hi, default, cast):
    """One request parameter -> (value applied, how it got that way).

    Clamped, never refused: a reader dragging a slider past the end of its range
    should see the end of the range, and the payload should admit that is what
    happened rather than echoing back what was asked for.
    """
    if raw is None or raw == "":
        return default, "default"
    try:
        value = cast(float(raw))
    except (TypeError, ValueError):
        return default, "unreadable, so the default"
    if value < lo:
        return lo, "clamped up to the floor of the range"
    if value > hi:
        return hi, "clamped down to the ceiling of the range"
    return value, "as asked"


def _cuts(params):
    """Every cut this request ran with, and where each value came from."""
    jac, jhow = _clamp(params.get("jaccard"), JACCARD_RANGE[0], JACCARD_RANGE[1],
                       JACCARD_CUT, lambda v: round(v, 4))
    clo, chow = _clamp(params.get("closeness"), CLOSENESS_RANGE[0], CLOSENESS_RANGE[1],
                       CLOSENESS_CUT, lambda v: round(v, 4))
    shr, show = _clamp(params.get("channel_share"), CHANNEL_SHARE_RANGE[0],
                       CHANNEL_SHARE_RANGE[1], CHANNEL_SHARE_CUT, lambda v: int(round(v)))
    return {
        # what was applied — read these, not `requested`
        "jaccard": jac, "closeness": clo, "channel_share": shr, "slots": COLOUR_SLOTS,
        "requested": {"jaccard": params.get("jaccard"),
                      "closeness": params.get("closeness"),
                      "channel_share": params.get("channel_share")},
        "how": {"jaccard": jhow, "closeness": chow, "channel_share": show},
        "defaults": {"jaccard": JACCARD_CUT, "closeness": CLOSENESS_CUT,
                     "channel_share": CHANNEL_SHARE_CUT},
        "ranges": {"jaccard": list(JACCARD_RANGE), "closeness": list(CLOSENESS_RANGE),
                   "channel_share": list(CHANNEL_SHARE_RANGE)},
        "swept": {"jaccard": sorted(set(JACCARD_SWEEP) | {jac}),
                  "channel_share": sorted(set(CHANNEL_SWEEP) | {shr})},
        "adjusted": sorted(k for k, v in
                           (("jaccard", jhow), ("closeness", chow), ("channel_share", show))
                           if v.startswith(("clamped", "unreadable"))),
    }


def _strip_label(value):
    """Apple CNLabel sentinels are markup, not display text."""
    if isinstance(value, str) and value.startswith("_$!<") and value.endswith(">!$_"):
        return value[4:-4]
    return value


# ---------------------------------------------------------------- the graph

def _person_facts(conn):
    """Everything the graph layer holds about each person on this page."""
    return _rows(conn, f"""
    WITH social AS ({SOCIAL_IDS_SQL})
    SELECT s.pid AS eid,
      (SELECT COUNT(DISTINCT subject) FROM event_graph
         WHERE predicate='{P_ATTENDEE}' AND relationshipPredicate='{F_PERSON}'
           AND object='md:'||s.pid) AS attended,
      (SELECT COUNT(DISTINCT subject) FROM event_graph
         WHERE predicate='{P_ORGANIZER}' AND relationshipPredicate='{F_PERSON}'
           AND object='md:'||s.pid) AS organized,
      (SELECT COUNT(DISTINCT subject) FROM event_graph
         WHERE predicate='{P_SENDER}' AND object='md:'||s.pid) AS invited,
      (SELECT COUNT(*) FROM stable_graph WHERE subject=s.pid) AS facts,
      (SELECT COUNT(*) FROM stable_graph WHERE object='md:'||s.pid) AS stable_refs,
      (SELECT COUNT(*) FROM event_graph WHERE object='md:'||s.pid) AS event_refs,
      (SELECT COUNT(*) FROM stable_graph
         WHERE subject=s.pid AND relationshipPredicate='PS407') AS phones,
      (SELECT COUNT(*) FROM stable_graph
         WHERE subject=s.pid AND relationshipPredicate='PS406') AS emails,
      (SELECT COUNT(*) FROM stable_graph
         WHERE subject=s.pid AND predicate='{P_GROUP_MEMBER}') AS is_group,
      (SELECT COUNT(*) FROM stable_graph
         WHERE subject=s.pid AND predicate='nm_isCurrentUser') AS is_owner
    FROM social s
    """)


def _names_and_handles(conn, ids):
    """The fallback chain's raw material, fetched in three sweeps not 3n."""
    names, parts, handles, spaces = {}, collections.defaultdict(list), \
        collections.defaultdict(list), collections.defaultdict(set)
    want = set(ids)
    for r in _rows(conn, "SELECT subject, predicate, object FROM stable_graph "
                         "WHERE predicate IN ('PS33','PS312','PS441') AND object<>''"):
        if r["subject"] not in want:
            continue
        if r["predicate"] == "PS33":
            names.setdefault(r["subject"], r["object"])
        else:
            parts[r["subject"]].append(r["object"])
    for r in _rows(conn, "SELECT subject, relationshipPredicate, object FROM stable_graph "
                         "WHERE relationshipPredicate IN ('PS406','PS407','PS740')"):
        if r["subject"] not in want:
            continue
        if r["relationshipPredicate"] == "PS740":
            continue
        handles[r["subject"]].append(r["object"])
    for r in _rows(conn, "SELECT subject, object FROM stable_graph WHERE predicate='PS102'"):
        if r["subject"] not in want:
            continue
        ns = vocab.ns_of(r["object"])
        if ns:
            spaces[r["subject"]].add(ns)
    return names, parts, handles, spaces


def _attendance(conn):
    """{person -> set(event)} and {event -> start day}, over the attendee-bearing events."""
    att = collections.defaultdict(set)
    for r in _rows(conn, f"SELECT subject, CAST(substr(object,4) AS INTEGER) AS pid "
                         f"FROM event_graph WHERE predicate='{P_ATTENDEE}' "
                         f"AND relationshipPredicate='{F_PERSON}'"):
        att[r["pid"]].add(r["subject"])
    days = {}
    for r in _rows(conn, f"""SELECT subject,
            json_extract(object,'$.year') AS y, json_extract(object,'$.month') AS m,
            json_extract(object,'$.day') AS d
          FROM event_graph WHERE relationshipPredicate='{F_START}'"""):
        if r["y"] is None:
            continue
        day = "%04d-%02d-%02d" % (r["y"], r["m"], r["d"])
        # a recurring event carries several start facets; keep the span
        lo, hi = days.get(r["subject"], (day, day))
        days[r["subject"]] = (min(lo, day), max(hi, day))
    return att, days


def _overlap_pairs(attendance, ids):
    """Every pair with at least one meeting in common: (a, b, shared, union, jaccard).

    Measured once and handed to the clustering, to the sensitivity sweep and to
    the component endpoint, so all three are guaranteed to be arguing about the
    same numbers.
    """
    out = []
    for a, b in itertools.combinations(ids, 2):
        A, B = attendance[a], attendance[b]
        shared = len(A & B)
        if not shared:
            continue
        union = len(A | B)
        out.append((a, b, shared, union, shared / union))
    return out


def _components(ids, pairs, cut):
    """Single-linkage components under `jaccard >= cut`, including the ones of
    size one — the caller decides whether a component of one is a circle."""
    parent = {i: i for i in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, _shared, _union, jac in pairs:
        if jac >= cut:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

    members = collections.defaultdict(list)
    for i in ids:
        members[find(i)].append(i)
    return dict(members)


def _circles(attendance, owner, cut=JACCARD_CUT):
    """THE APP'S OWN CLUSTERING. Single-linkage on Jaccard overlap of event sets.

    The store holds event->person invitations and nothing else; person-to-person
    proximity, and any notion of a "circle", is computed right here. Two people
    are JOINED when at least `cut` of the meetings either of them is invited to are
    meetings they are both invited to; a circle is a connected component of that
    relation, which is a strictly weaker thing. Members of one circle need not
    have cleared the cut with each other, and on real data some do not — a pair
    can be in the same circle on a chain of intermediaries while sharing nothing
    at all. So any wording that reads "everyone in a circle shares half their
    meetings" is false; the component endpoint counts the exceptions per circle
    rather than letting the sentence stand.

    The owner is excluded: they are on essentially every attendee-bearing event,
    so leaving them in merges everything into one blob and the layout collapses
    into a star. The component endpoint reports their actual coverage rather
    than asserting it.
    """
    ids = sorted(p for p in attendance if p != owner)
    comps = _components(ids, _overlap_pairs(attendance, ids), cut)
    # a component of one is not a circle; it is a person the rule could not place
    return {root: m for root, m in comps.items() if len(m) > 1}


def _jaccard_sweep(attendance, owner, applied):
    """How the calendar clustering answers to its cut, over a fixed short sweep.

    The pairwise overlap is measured once; each cut is then only a union-find
    over a few hundred pairs, so the whole sweep costs less than the queries
    that fed it. `unplaced` here means a person the calendar layer saw but left
    in a component of one — the page calls that bucket `solo`.
    """
    ids = sorted(p for p in attendance if p != owner)
    pairs = _overlap_pairs(attendance, ids)
    rows = []
    for cut in sorted(set(JACCARD_SWEEP) | {applied}):
        multi = [m for m in _components(ids, pairs, cut).values() if len(m) > 1]
        placed = sum(len(m) for m in multi)
        rows.append({"jaccard": round(cut, 4), "circles": len(multi), "placed": placed,
                     "unplaced": len(ids) - placed,
                     "largest": max((len(m) for m in multi), default=0),
                     "applied": cut == applied})
    return rows


def _channel_sweep(overlaps, rids, applied):
    """The same question for the chat layer: how many clusters survive each cut."""
    rows = []
    for cut in sorted(set(CHANNEL_SWEEP) | {applied}):
        comps = _channel_components(rids, [o for o in overlaps if o["shared"] >= cut])
        multi = [m for m in comps.values() if len(m) > 1]
        placed = sum(len(m) for m in multi)
        rows.append({"share": cut, "clusters": len(multi), "placed": placed,
                     "unplaced": len(rids) - placed,
                     "largest": max((len(m) for m in multi), default=0),
                     "applied": cut == applied})
    return rows


def _channel_layer():
    """Group chats: the MessageGroup entities, their traffic and their overlap.

    Membership here is a handle, not a person: the id the messaging app donated.
    Only the handles that appear in the internal handle index resolve to a graph
    entity at all, which is why the channel layer barely touches the calendar
    layer.
    """
    conn = db.connect(REMEMBERS)
    if conn is None:
        return [], {}, [], []
    _attach(conn, "iv", "Artifacts__internal__views.db")

    chans = _rows(conn, """
      SELECT e.rowid AS rid, json_extract(e.fields,'$.name') AS name,
             COUNT(DISTINCT i.rowid) AS message_rows,
             SUM(i.direction=?) AS incoming, SUM(i.direction=?) AS outgoing,
             COUNT(DISTINCT i.bundleId) AS apps,
             MIN(i.startDate) AS first_ts, MAX(i.startDate) AS last_ts
      FROM entities e
      JOIN interactionEntities ie ON ie.entityRowid=e.rowid
      JOIN interactions i ON i.rowid=ie.interactionRowid
      WHERE e.type='MessageGroup'
      GROUP BY e.rowid ORDER BY message_rows DESC""", comms.direction_values())

    memb = _rows(conn, """
      SELECT DISTINCT g.rowid AS grp, p.id AS handle
      FROM entities g
      JOIN interactionEntities ieg ON ieg.entityRowid=g.rowid
      JOIN interactionEntities iep ON iep.interactionRowid=ieg.interactionRowid
      JOIN entities p ON p.rowid=iep.entityRowid AND p.type='PersonHandle'
      WHERE g.type='MessageGroup'""")

    resolved = _rows(conn, """
      SELECT DISTINCT g.rowid AS grp, h.id AS eid
      FROM entities g
      JOIN interactionEntities ieg ON ieg.entityRowid=g.rowid
      JOIN interactionEntities iep ON iep.interactionRowid=ieg.interactionRowid
      JOIN entities p ON p.rowid=iep.entityRowid AND p.type='PersonHandle'
      JOIN iv.handle_id h ON h.handle = p.id
      WHERE g.type='MessageGroup'""")

    by_chan = collections.defaultdict(set)
    for m in memb:
        by_chan[m["grp"]].add(m["handle"])
    # every pair with anything in common, unfiltered: the cut is applied by the
    # caller, so one measurement can serve the graph, the sweep and the drill-down
    overlap = []
    for a, b in itertools.combinations(sorted(by_chan), 2):
        shared = len(by_chan[a] & by_chan[b])
        if shared:
            overlap.append({"a": a, "b": b, "shared": shared,
                            "union": len(by_chan[a] | by_chan[b])})
    return chans, by_chan, overlap, resolved


def _volume():
    """Interaction-log volume per GRAPH entity, via the handle index."""
    conn = db.connect(REMEMBERS)
    if conn is None:
        return {}
    _attach(conn, "iv", "Artifacts__internal__views.db")
    out = {}
    for r in _rows(conn, """
      SELECT h.id AS eid, COUNT(DISTINCT i.rowid) AS n,
             SUM(i.direction=?) AS incoming, SUM(i.direction=?) AS outgoing,
             COUNT(DISTINCT i.bundleId) AS apps,
             MIN(i.startDate) AS first_ts, MAX(i.startDate) AS last_ts
      FROM entities e
      JOIN iv.handle_id h ON h.handle = e.id
      JOIN interactionEntities ie ON ie.entityRowid=e.rowid
      JOIN interactions i ON i.rowid=ie.interactionRowid
      WHERE e.type='PersonHandle'
      GROUP BY h.id""", comms.direction_values()):
        out[r["eid"]] = r
    return out


def _kinship():
    """The scorecard, keyed by graph entity id. TEXT mdid -> INTEGER subject."""
    conn = db.connect(TAGGING)
    if conn is None:
        return {}, []
    cols = [r["name"] for r in _rows(conn, "SELECT name FROM pragma_table_info('entity_tagging')")]
    wanted = [c for c in ("familyAndFriends", "family", "friend") + LEAF_KINSHIP if c in cols]
    sel = ", ".join("t." + c for c in wanted)
    rows = _rows(conn, f"SELECT CAST(t.mdid AS INTEGER) AS eid, {sel} FROM entity_tagging t")
    bands = _rows(conn, """
      SELECT CASE WHEN familyAndFriends>=0.9 THEN '0.90-1.00'
                  WHEN familyAndFriends>=0.7 THEN '0.70-0.90'
                  WHEN familyAndFriends>=0.5 THEN '0.50-0.70'
                  WHEN familyAndFriends>=0.25 THEN '0.25-0.50'
                  WHEN familyAndFriends>0 THEN '0.00-0.25'
                  ELSE 'zero' END AS band, COUNT(*) AS people
      FROM entity_tagging GROUP BY 1 ORDER BY 1 DESC""")
    return {r["eid"]: r for r in rows}, bands


# ---------------------------------------------------------------- handler

def _graph_rows(eid):
    """Rows anywhere in graph.db, live or retracted, with this entity at either end."""
    ref = "md:%d" % eid
    return sum(db.one(GRAPH, f"SELECT COUNT(*) FROM {t} WHERE subject=? OR object=?", (eid, ref), 0) or 0
               for t in ("stable_graph", "event_graph", "expired_stable_graph", "expired_event_graph"))


def _universe(conn, kin, owner, closeness):
    """The people this page draws, in the order the force graph adds them.

    Everyone the graph layer touches socially, plus anyone the scorecard puts at
    or above the closeness cut even when the calendar never saw them — that is
    the point of the inferred layer. Factored out of the handler so the
    component endpoint places people in exactly the same buckets the graph does.
    """
    people = _person_facts(conn)
    known = {p["eid"] for p in people}
    extra = sorted(eid for eid, k in kin.items()
                   if eid != owner and (k.get("familyAndFriends") or 0) >= closeness
                   and eid not in known)
    for eid in extra:
        live = db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph WHERE subject=?", (eid,), 0) or 0
        gone = _rows(conn, "SELECT COUNT(*) AS n, MAX(timestamp) AS t "
                           "FROM expired_stable_graph WHERE subject=?", (eid,))
        people.append({"eid": eid, "attended": 0, "organized": 0, "invited": 0,
                       "facts": live, "stable_refs": 0, "event_refs": 0,
                       "phones": 0, "emails": 0, "is_group": 0, "is_owner": 0,
                       "expired": (gone[0]["n"] if gone else 0) or 0,
                       "retracted_at": db.apple_time(gone[0]["t"]) if gone else None,
                       # here only because of the score: the graph itself may not hold them at all
                       "scorecard_only": True,
                       "graph_rows": _graph_rows(eid)})
    return people


# The stored rows that tie a person to an event, by the slot the person sits in.
# Every other entity-to-entity row that touches a person is `record_link` (or,
# both ends a person, `stored_person_link`); the two the graph already draws
# as edges of their own are skipped here.
RECORD_ROLE = {
    (P_ATTENDEE, F_PERSON): "event_attendee",
    (P_ORGANIZER, F_PERSON): "event_organizer",
    (P_SENDER, ""): "event_sender",
}
DRAWN_ELSEWHERE = {(P_GROUP_MEMBER, F_MEMBER), (P_EMPLOYER, F_ORG)}
PERSON_CLASS = "SB104"


def _row_meta(predicate, facet, **more):
    """The meta of a link that is one row of the store: the row's predicate, and
    the facet the far end sits in when the statement is reified."""
    meta = {"predicate": predicate, "predicate_label": vocab.plabel(predicate)}
    if facet:
        meta["facet"] = facet
        meta["facet_label"] = vocab.plabel(facet)
    meta.update(more)
    return meta


def _stored_rows(conn, people):
    """Every live row whose object is an entity and whose subject or object is a
    person — what "stored links only" has to show.

    The person-to-person lines on this page fold the event rows into pairs; this
    is those rows as the store keeps them, plus whatever else ties a person to a
    record (a place, an app). A person is a drawn person node or anything the
    store types as one: a row can reach someone the social layer never touches.
    Returns (links, records, extra): `links` as (subject, object, kind, layer,
    (predicate, facet)); `records` maps the non-person end of each row to {class,
    name, rows}; `extra` maps each person not already drawn to their row count.
    """
    drawn = set(people)
    typed = {r["subject"] for layer in ("stable_graph", "event_graph")
             for r in _rows(conn, f"SELECT subject FROM {layer} WHERE predicate='PS1' AND object=?",
                            (PERSON_CLASS,))}
    people = set(people) | typed
    out, records, extra = [], {}, collections.Counter()
    for layer in ("stable_graph", "event_graph"):
        for r in _rows(conn, f"""
          SELECT subject, predicate, relationshipPredicate AS facet, object
          FROM {layer} WHERE object LIKE 'md:%'"""):
            obj = vocab.entity_ref(r["object"])
            if obj is None:
                continue
            s_in, o_in = r["subject"] in people, obj in people
            if not (s_in or o_in):
                continue
            slot = (r["predicate"], r["facet"] or "")
            if slot in DRAWN_ELSEWHERE:
                continue
            code = (r["predicate"], r["facet"] or "")
            for e, inside in ((r["subject"], s_in), (obj, o_in)):
                if inside and e in typed and e not in drawn:
                    extra[e] += 1
            if s_in and o_in:
                out.append((r["subject"], obj, "stored_person_link", layer, code))
                continue
            far = obj if s_in else r["subject"]
            rec = records.setdefault(far, {"rows": 0})
            rec["rows"] += 1
            out.append((r["subject"], obj, RECORD_ROLE.get(slot, "record_link"), layer, code))
    for eid, rec in records.items():
        cls = name = None
        for layer in ("stable_graph", "event_graph"):
            cls = cls or db.one(GRAPH, f"SELECT object FROM {layer} WHERE subject=? AND predicate='PS1' "
                                       "LIMIT 1", (eid,))
            name = name or db.one(GRAPH, f"SELECT object FROM {layer} WHERE subject=? AND predicate='PS33' "
                                         "AND object<>'' LIMIT 1", (eid,))
        rec["class"] = vocab.clabel(cls) if cls else None
        rec["name"] = name
    return out, records, extra


def handler(params):
    cuts = _cuts(params)
    conn = db.connect(GRAPH)
    if conn is None:
        return {"available": False, "nodes": [], "links": [], "clusters": [],
                "link_kinds": [], "counts": {}, "cuts": cuts,
                "sensitivity": [], "sensitivity_channels": []}

    owner = vocab.owner_id()
    kin, bands = _kinship()
    people = _universe(conn, kin, owner, cuts["closeness"])

    ids = [p["eid"] for p in people]
    names, parts, handles, spaces = _names_and_handles(conn, ids)
    withdrawn = vocab.withdrawn_names(i for i in ids if not names.get(i) and not parts.get(i))
    attendance, event_days = _attendance(conn)
    volume = _volume()
    # The face Photos clustered for this person, where the graph binds one to
    # them. Decoration on a node whose identity the graph already asserts; an
    # unbound person, or one whose preview cannot be read, simply has none.
    face_of = faces.by_entity()

    # ---- clusters: one explicit, the rest computed here ----------------
    circles = _circles(attendance, owner, cuts["jaccard"])
    circle_of, circle_meta = {}, {}
    for root, members in circles.items():
        key = "circle:" + vocab.sid(root)
        shared = set.intersection(*[attendance[m] for m in members]) if members else set()
        union = set().union(*[attendance[m] for m in members]) if members else set()
        for m in members:
            circle_of[m] = key
        circle_meta[key] = {
            "key": key, "origin": "derived", "layer": "calendar",
            "size": len(members), "shared_events": len(shared), "events": len(union),
        }

    group_rows = _rows(conn, f"""
      SELECT subject, relationshipId, relationshipPredicate, object, confidence,
             sources, timestamp
      FROM stable_graph WHERE predicate='{P_GROUP_MEMBER}'""")
    group_ids = sorted({r["subject"] for r in group_rows})
    group_members = collections.defaultdict(list)
    for r in group_rows:
        if r["relationshipPredicate"] == F_MEMBER:
            eid = vocab.entity_ref(r["object"])
            if eid is not None:
                group_members[r["subject"]].append(eid)

    # ---- nodes ---------------------------------------------------------
    nodes = []
    node_ix = {}

    def add_node(nid, label, group, kind, weight, meta):
        node_ix[nid] = len(nodes)
        nodes.append({"id": nid, "label": label, "group": group, "kind": kind,
                      "weight": weight, "meta": meta})

    for p in people:
        eid = p["eid"]
        label, label_source = _label_chain(eid, names, parts, handles, withdrawn)
        v = volume.get(eid) or {}
        k = kin.get(eid) or {}
        # what the node's size encodes: rows anywhere in the store that name it,
        # including the retraction archive when the live entity is gone.
        mentions = (p["facts"] + p["stable_refs"] + p["event_refs"]
                    + (v.get("n") or 0) + p.get("expired", 0))
        is_owner = bool(p["is_owner"])
        cluster = ("owner" if is_owner else circle_of.get(eid))
        if cluster is None:
            cluster = "unplaced" if not attendance.get(eid) else "solo"
        leaves = sorted(((c, k[c]) for c in LEAF_KINSHIP if (k.get(c) or 0) > 0),
                        key=lambda kv: -kv[1])
        add_node(
            vocab.sid(eid), label, cluster,
            "owner" if is_owner else "person",
            mentions,
            {
                "label_source": label_source,
                "name_withdrawn": label_source == WITHDRAWN_NAME,
                "namespaces": sorted(spaces.get(eid, ())),
                "attended": p["attended"], "organized": p["organized"],
                "invited": p["invited"], "facts": p["facts"],
                "refs": p["stable_refs"] + p["event_refs"],
                "phones": p["phones"], "emails": p["emails"],
                "interactions": v.get("n") or 0,
                "incoming": v.get("incoming") or 0, "outgoing": v.get("outgoing") or 0,
                "apps": v.get("apps") or 0,
                "first_contact": db.apple_time(v.get("first_ts")),
                "last_contact": db.apple_time(v.get("last_ts")),
                "closeness": k.get("familyAndFriends"),
                "family": k.get("family"), "friend": k.get("friend"),
                "face": face_of.get(eid),
                "claims": [{"label": c, "score": s} for c, s in leaves],
                "scored": eid in kin,
                "from_calendar": bool(attendance.get(eid) or p["invited"] or p["organized"]),
                "retracted": bool(p.get("expired") and not p["facts"]),
                "expired_rows": p.get("expired", 0),
                "retracted_at": p.get("retracted_at"),
                "scorecard_only": p.get("scorecard_only", False),
                "graph_rows": p.get("graph_rows"),
            })

    for gid in group_ids:
        rows = [r for r in group_rows if r["subject"] == gid]
        label, _src = _label_chain(gid, names, parts, handles)
        cls = db.one(GRAPH, "SELECT object FROM stable_graph WHERE subject=? "
                            "AND predicate='PS1' AND relationshipId=0", (gid,))
        tokens = _rows(conn, "SELECT DISTINCT object FROM stable_graph WHERE subject=? "
                             "AND object LIKE 'faFamilyCircle:%'", (gid,))
        subject_rows, refs = _group_weight(gid)
        # `sources` is a BITMASK: max() of two masks is neither their union nor
        # their intersection, it is whichever integer happens to be larger. OR
        # them, so the node reports every ingest source that fed the group.
        mask = 0
        for r in rows:
            mask |= r["sources"] or 0
        confs = sorted({r["confidence"] for r in rows if r["confidence"] is not None})
        add_node(vocab.sid(gid),
                 label if names.get(gid) else vocab.clabel(cls or ""),
                 "explicit", "explicit_group",
                 subject_rows + refs,
                 {"class": vocab.clabel(cls) if cls else None,
                  "class_code": cls,
                  "statements": len({r["relationshipId"] for r in rows}),
                  "members": len(group_members.get(gid, ())),
                  # what the weight counts, so the two can be checked against it
                  "rows": subject_rows, "refs": refs,
                  "statement_rows": len(rows),
                  # the weakest claim the group rests on, with the spread beside it
                  "confidence": confs[0] if confs else None,
                  "confidence_low": confs[0] if confs else None,
                  "confidence_high": confs[-1] if confs else None,
                  "confidence_uniform": len(confs) == 1,
                  "sources": vocab.source_names(mask),
                  "asserted": db.apple_time(max((r["timestamp"] for r in rows), default=None)),
                  "named": bool(names.get(gid)),
                  "circle_tokens": len(tokens)})

    # ---- links ---------------------------------------------------------
    links = []

    def add_link(src, dst, kind, weight, meta=None):
        if src in node_ix and dst in node_ix:
            links.append({"source": src, "target": dst, "kind": kind,
                          "weight": weight, "meta": meta or {}})

    co = _rows(conn, f"""
      SELECT a.object AS src, b.object AS dst, COUNT(DISTINCT a.subject) AS weight,
             GROUP_CONCAT(DISTINCT a.subject) AS evs
      FROM event_graph a JOIN event_graph b
        ON a.subject=b.subject AND a.object < b.object
      WHERE a.predicate='{P_ATTENDEE}' AND a.relationshipPredicate='{F_PERSON}'
        AND b.predicate='{P_ATTENDEE}' AND b.relationshipPredicate='{F_PERSON}'
      GROUP BY 1,2""")
    for r in co:
        span = [event_days[int(e)] for e in (r["evs"] or "").split(",")
                if e and int(e) in event_days]
        add_link(vocab.sid(vocab.entity_ref(r["src"])), vocab.sid(vocab.entity_ref(r["dst"])),
                 "co_attendance", r["weight"],
                 {"first": min(s[0] for s in span) if span else None,
                  "last": max(s[1] for s in span) if span else None})

    for r in _rows(conn, f"""
      SELECT o.object AS src, a.object AS dst, COUNT(DISTINCT a.subject) AS weight
      FROM event_graph o JOIN event_graph a ON a.subject=o.subject
      WHERE o.predicate='{P_ORGANIZER}' AND o.relationshipPredicate='{F_PERSON}'
        AND a.predicate='{P_ATTENDEE}' AND a.relationshipPredicate='{F_PERSON}'
        AND a.object<>o.object
      GROUP BY 1,2"""):
        add_link(vocab.sid(vocab.entity_ref(r["src"])), vocab.sid(vocab.entity_ref(r["dst"])),
                 "organizer_to_attendee", r["weight"])

    for gid, members in group_members.items():
        for eid in members:
            add_link(vocab.sid(gid), vocab.sid(eid), "family_circle_member", 1,
                     _row_meta(P_GROUP_MEMBER, F_MEMBER, layer="stable_graph"))

    for eid, k in kin.items():
        score = k.get("familyAndFriends") or 0
        if eid == owner or score < cuts["closeness"]:
            continue
        add_link(vocab.sid(owner), vocab.sid(eid), "inferred_closeness",
                 round(score, 4),
                 {"family": k.get("family"), "friend": k.get("friend")})

    # employment: an organisation, not a person, on the far end
    orgs = _rows(conn, f"""
      SELECT e.subject AS pid, e.object AS org, e.confidence, e.timestamp
      FROM stable_graph e
      WHERE e.predicate='{P_EMPLOYER}' AND e.relationshipPredicate='{F_ORG}'""")
    org_ids = sorted({vocab.entity_ref(r["org"]) for r in orgs} - {None})
    emp_ids = sorted({r["pid"] for r in orgs})
    onames, oparts, ohandles, _os = _names_and_handles(conn, set(org_ids) | set(emp_ids))
    for oid in org_ids:
        if vocab.sid(oid) in node_ix:
            continue
        label, _ = _label_chain(oid, onames, oparts, ohandles)
        indeg = sum(1 for r in orgs if vocab.entity_ref(r["org"]) == oid)
        add_node(vocab.sid(oid), label, "employer", "org", indeg,
                 {"employees_here": indeg,
                  "class": vocab.clabel(db.one(GRAPH,
                      "SELECT object FROM stable_graph WHERE subject=? AND predicate='PS1' "
                      "AND relationshipId=0", (oid,)) or "")})
    for pid in emp_ids:
        if vocab.sid(pid) in node_ix:
            continue
        label, src = _label_chain(pid, onames, oparts, ohandles)
        facts = db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph WHERE subject=?", (pid,), 0) or 0
        k = kin.get(pid) or {}
        add_node(vocab.sid(pid), label, "employee", "person", facts,
                 {"label_source": src, "namespaces": [], "attended": 0, "organized": 0,
                  "invited": 0, "facts": facts, "refs": 0, "phones": 0, "emails": 0,
                  "interactions": 0, "incoming": 0, "outgoing": 0, "apps": 0,
                  "closeness": k.get("familyAndFriends"), "claims": [],
                  "scored": pid in kin, "from_calendar": False})
    for r in orgs:
        add_link(vocab.sid(r["pid"]), vocab.sid(vocab.entity_ref(r["org"])),
                 "employed_by", 1, _row_meta(P_EMPLOYER, F_ORG, layer="stable_graph",
                                                confidence=r["confidence"]))

    # the store's own rows from people to events, places and apps: drawn only
    # under "stored links only", where the far ends become nodes of their own
    person_ids = {int(n["id"]) for n in nodes if n["kind"] in ("person", "owner")}
    stored_rows, records, extra = _stored_rows(conn, person_ids)
    # people a stored row reaches whom the social layer never touches: drawn on
    # the same switch, in a group of their own so no count above includes them
    xnames, xparts, xhandles, _xs = _names_and_handles(conn, set(extra))
    for eid, n in sorted(extra.items()):
        label, src = _label_chain(eid, xnames, xparts, xhandles)
        k = kin.get(eid) or {}
        add_node(vocab.sid(eid), label, "stored_only", "person", n,
                 {"label_source": src, "namespaces": [], "attended": 0, "organized": 0,
                  "invited": 0, "facts": n, "refs": 0, "phones": 0, "emails": 0,
                  "interactions": 0, "incoming": 0, "outgoing": 0, "apps": 0,
                  "closeness": k.get("familyAndFriends"), "claims": [],
                  "scored": eid in kin, "from_calendar": False})
    for eid, rec in sorted(records.items()):
        if vocab.sid(eid) in node_ix:
            continue
        add_node(vocab.sid(eid), rec["name"] or rec["class"] or "", "record", "record",
                 rec["rows"], {"class": rec["class"], "rows": rec["rows"]})
    for s, o, kind, layer, (pred, facet) in stored_rows:
        add_link(vocab.sid(s), vocab.sid(o), kind, 1, _row_meta(pred, facet, layer=layer))

    # channels
    chans, by_chan, overlaps, resolved = _channel_layer()
    rids = [c["rid"] for c in chans]
    overlap = [o for o in overlaps if o["shared"] >= cuts["channel_share"]]
    chan_cluster = _channel_clusters(overlap, rids)
    for c in chans:
        cid = "chan:%d" % c["rid"]
        add_node(cid, c["name"] or "", chan_cluster.get(c["rid"], "chatter"), "channel",
                 c["message_rows"],
                 {"message_rows": c["message_rows"], "incoming": c["incoming"],
                  "outgoing": c["outgoing"], "apps": c["apps"],
                  "handles": len(by_chan.get(c["rid"], ())),
                  "first_contact": db.apple_time(c["first_ts"]),
                  "last_contact": db.apple_time(c["last_ts"])})
    for o in overlap:
        add_link("chan:%d" % o["a"], "chan:%d" % o["b"], "shared_handles", o["shared"])
    for r in resolved:
        add_link("chan:%d" % r["grp"], vocab.sid(r["eid"]), "channel_member", 1)

    # ---- cluster catalogue, colour slots in fixed order -----------------
    # Only real multi-member clusters earn a categorical colour, largest first,
    # calendar circles before chat clusters. A ninth folds into "other"; the
    # structural buckets below are never given a hue.
    counted = collections.Counter(n["group"] for n in nodes)
    clusters = [dict(meta, members=counted.get(key, 0), name=None)
                for key, meta in circle_meta.items()]
    chat_sizes = collections.Counter(v for v in chan_cluster.values() if v != "solo_chat")
    for key in sorted(chat_sizes):
        clusters.append({"key": key, "origin": "derived", "layer": "channels",
                         "size": counted.get(key, 0), "members": counted.get(key, 0),
                         "shared_events": None, "events": None, "name": None})
    clusters.sort(key=lambda c: (0 if c["layer"] == "calendar" else 1,
                                 -c["members"], c["key"]))
    for i, c in enumerate(clusters):
        c["slot"] = i if i < COLOUR_SLOTS else None

    buckets = [
        ("explicit", "stored", "graph", "a group entity the store holds, with its membership facets"),
        ("owner", "stored", "graph", "the nm_isCurrentUser anchor — in every circle by construction"),
        ("solo", "derived", "calendar", "is invited to meetings, but overlaps no one enough to be placed"),
        ("unplaced", "derived", "graph", "known to the store, outside every circle"),
        ("solo_chat", "derived", "channels", "a group chat sharing no handle with another chat"),
        ("employer", "stored", "graph", "an organisation, not a person"),
        ("employee", "stored", "graph", "attached to an employer and to nothing else here"),
    ]
    catalogue = [{"key": k, "origin": o, "layer": ly, "members": counted.get(k, 0),
                  "size": counted.get(k, 0), "shared_events": None, "events": None,
                  "slot": None, "note": note}
                 for k, o, ly, note in buckets if counted.get(k, 0)] + clusters

    drawn_kinds = {"co_attendance", "organizer_to_attendee", "inferred_closeness",
                   "channel_member", "shared_handles"}
    stored_ends = {e for l in links if l["kind"] not in drawn_kinds for e in (l["source"], l["target"])}
    for n in nodes:
        if n["meta"].get("scorecard_only") and n["id"] in stored_ends:
            n["meta"]["scorecard_only"] = False

    kinds = collections.Counter(l["kind"] for l in links)
    kind_rows = [
        {"kind": "family_circle_member", "origin": "stored", "store": "graph.db stable_graph",
         "note": "a stored group entity's membership facets"},
        {"kind": "co_attendance", "origin": "derived", "store": "graph.db event_graph",
         "note": "computed here by pairing attendees of the same event"},
        {"kind": "organizer_to_attendee", "origin": "derived", "store": "graph.db event_graph",
         "note": "computed here by pairing an event's organizer with its attendees"},
        {"kind": "employed_by", "origin": "stored", "store": "graph.db stable_graph",
         "note": "employment statements; the far end is an organisation, not a person"},
        {"kind": "inferred_closeness", "origin": "derived", "store": "entityTagging",
         "note": "a per-person score redrawn here as an edge to the owner"},
        {"kind": "channel_member", "origin": "derived", "store": "siri remembers + handle index",
         "note": "a group chat's handle resolved to a graph person"},
        {"kind": "shared_handles", "origin": "derived", "store": "siri remembers",
         "note": "computed here: two chats sharing this many handles"},
        {"kind": "event_attendee", "origin": "stored", "store": "graph.db event_graph",
         "note": "an event's attendee facet, as stored (has attendee / attendee identifier)"},
        {"kind": "event_organizer", "origin": "stored", "store": "graph.db event_graph",
         "note": "an event's organiser facet, as stored (has organizer / attendee identifier)"},
        {"kind": "event_sender", "origin": "stored", "store": "graph.db event_graph",
         "note": "the person an event found in an app came from (calendar event sender)"},
        {"kind": "record_link", "origin": "stored", "store": "graph.db",
         "note": "any other stored row between a person and another record"},
        {"kind": "stored_person_link", "origin": "stored", "store": "graph.db",
         "note": "a stored row with a person at both ends"},
    ]
    # A stored kind is named by the predicates of the rows behind it; a drawn kind
    # has none, because no row stands behind it.
    preds = collections.defaultdict(collections.Counter)
    for l in links:
        if l["meta"].get("predicate"):
            preds[l["kind"]][l["meta"]["predicate"]] += 1
    for k in kind_rows:
        k["count"] = kinds.get(k["kind"], 0)
        k["predicates"] = [{"code": c, "label": vocab.plabel(c), "rows": n}
                           for c, n in preds[k["kind"]].most_common()]

    co_weights = collections.Counter(l["weight"] for l in links if l["kind"] == "co_attendance")

    return {
        "available": True,
        "owner": vocab.sid(owner),
        "cuts": cuts,
        "sensitivity": _jaccard_sweep(attendance, owner, cuts["jaccard"]),
        "sensitivity_channels": _channel_sweep(overlaps, rids, cuts["channel_share"]),
        "nodes": nodes,
        "links": links,
        "clusters": catalogue,
        "link_kinds": kind_rows,
        "closeness_bands": bands,
        "co_attendance_weights": [{"weight": w, "pairs": n}
                                  for w, n in sorted(co_weights.items())],
        "counts": {
            "people": sum(1 for n in nodes if n["kind"] in ("person", "owner")),
            "stored_only_people": sum(1 for n in nodes if n["group"] == "stored_only"),
            "calendar_people": sum(1 for n in nodes if n["meta"].get("from_calendar")),
            "explicit_groups": len(group_ids),
            "explicit_members": sum(len(v) for v in group_members.values()),
            "channels": len(chans),
            "channel_handles": len({h for s in by_chan.values() for h in s}),
            "channels_with_resolved_person": len({r["grp"] for r in resolved}),
            "orgs": sum(1 for n in nodes if n["kind"] == "org"),
            "records": sum(1 for n in nodes if n["kind"] == "record"),
            "scorecard_only_people": sum(1 for n in nodes if n["meta"].get("scorecard_only")),
            "derived_circles": len(circle_meta),
            "chat_clusters": len(chat_sizes),
            "circled_people": sum(1 for n in nodes
                                  if n["group"].startswith("circle:")),
            "unplaced_people": sum(1 for n in nodes if n["group"] == "unplaced"),
            "solo_people": sum(1 for n in nodes if n["group"] == "solo"),
            "scored_people": len(kin),
            # the owner is held out here exactly as the inferred_closeness edge
            # loop holds them out, so this count can never exceed the edges drawn
            "above_closeness_cut": sum(1 for eid, k in kin.items()
                                       if eid != owner
                                       and (k.get("familyAndFriends") or 0) >= cuts["closeness"]),
            "retracted_close_people": sum(1 for n in nodes if n["meta"].get("retracted")),
            "volume_resolved": len(volume),
            "volume_on_calendar_people": sum(
                1 for n in nodes if n["meta"].get("from_calendar") and n["meta"].get("interactions")),
            "events": len(event_days),
            "attendee_events": len({e for s in attendance.values() for e in s}),
        },
    }


def _channel_components(rids, overlap):
    """Single-linkage components over the shared-handle edges.

    `overlap` must already be filtered to the share cut in force; this function
    only follows the edges it is given.
    """
    parent = {r: r for r in rids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for o in overlap:
        if o["a"] not in parent or o["b"] not in parent:
            continue
        ra, rb = find(o["a"]), find(o["b"])
        if ra != rb:
            parent[rb] = ra
    members = collections.defaultdict(list)
    for r in rids:
        members[find(r)].append(r)
    return dict(members)


def _channel_clusters(overlap, rids):
    """{chat rowid -> cluster key}; a chat linked to nothing is not a cluster."""
    out = {}
    for root, members in _channel_components(rids, overlap).items():
        for r in members:
            out[r] = ("chat:%d" % root) if len(members) > 1 else "solo_chat"
    return out


def detail(params):
    """Everything the store holds about one node, for the selection panel."""
    raw = (params.get("id") or "").strip()
    if raw.startswith("chan:"):
        return _channel_detail(raw)
    try:
        eid = int(raw)
    except ValueError:
        return {"error": "unknown node"}

    conn = db.connect(GRAPH)
    if conn is None:
        return {"available": False}

    out = {"available": True, "id": vocab.sid(eid), "facts": [], "events": [],
           "handles": [], "namespaces": []}

    # Both live layers: a person's record is in the stable one, an event's — the
    # record nodes "stored links only" draws — in the event one.
    for st in (vocab.statements("stable_graph", subject=eid)
               + vocab.statements("event_graph", subject=eid)):
        facets = {vocab.plabel(k): v for k, v in (st.get("facets") or {}).items()
                  if k != "PS1"}
        out["facts"].append({
            "predicate": st["label"],
            "value": st["object"],
            "kind": (st["decoded"] or {}).get("kind"),
            "facets": facets,
            "confidence": st["confidence"],
            "sources": vocab.source_names(st["sources"]),
            "written": st["timestamp"],
        })
    out["facts"].sort(key=lambda f: (-(f["confidence"] or 0), f["predicate"]))

    for r in _rows(conn, """
      SELECT p.relationshipPredicate AS slot, p.object AS value,
             (SELECT object FROM stable_graph l WHERE l.relationshipId=p.relationshipId
              AND l.relationshipPredicate='PS740') AS label
      FROM stable_graph p
      WHERE p.subject=? AND p.relationshipPredicate IN ('PS406','PS407')""", (eid,)):
        out["handles"].append({"kind": vocab.plabel(r["slot"]),
                               "value": r["value"],
                               "label": _strip_label(r["label"])})

    seen_ns = collections.Counter()
    for r in _rows(conn, "SELECT object FROM stable_graph WHERE subject=? AND predicate='PS102'",
                   (eid,)):
        ns = vocab.ns_of(r["object"])
        if ns:
            seen_ns[ns] += 1
    out["namespaces"] = [{"namespace": ns, "refs": n,
                          "description": vocab.NAMESPACES[ns][1]}
                         for ns, n in sorted(seen_ns.items())]

    for r in _rows(conn, f"""
      SELECT e.subject AS ev, e.predicate AS role,
             (SELECT object FROM event_graph t WHERE t.subject=e.subject
                AND t.predicate='PS33' LIMIT 1) AS title,
             (SELECT json_extract(d.object,'$.year')||'-'||
                     substr('0'||json_extract(d.object,'$.month'),-2)||'-'||
                     substr('0'||json_extract(d.object,'$.day'),-2)
              FROM event_graph d WHERE d.subject=e.subject
                AND d.relationshipPredicate='{F_START}' LIMIT 1) AS day,
             (SELECT COUNT(*) FROM event_graph x WHERE x.subject=e.subject
                AND x.predicate='{P_ATTENDEE}' AND x.relationshipPredicate='{F_PERSON}') AS attendees
      FROM event_graph e
      WHERE e.object='md:'||? AND (
            (e.predicate IN ('{P_ATTENDEE}','{P_ORGANIZER}') AND e.relationshipPredicate='{F_PERSON}')
         OR e.predicate='{P_SENDER}')
      ORDER BY day DESC""", (eid,)):
        out["events"].append({"role": vocab.plabel(r["role"]), "title": r["title"],
                              "day": r["day"], "attendees": r["attendees"]})

    kin, _ = _kinship()
    k = kin.get(eid)
    if k:
        out["kinship"] = {c: k[c] for c in k if c != "eid" and (k[c] or 0) > 0}
    out["volume"] = _volume().get(eid)
    return out


def _channel_detail(nid):
    try:
        rid = int(nid.split(":", 1)[1])
    except (IndexError, ValueError):
        return {"error": "unknown node"}
    conn = db.connect(REMEMBERS)
    if conn is None:
        return {"available": False}
    rows = _rows(conn, """
      SELECT i.bundleId AS app, i.domain, COUNT(*) AS n,
             SUM(i.direction=?) AS incoming, SUM(i.direction=?) AS outgoing,
             MIN(i.startDate) AS first_ts, MAX(i.startDate) AS last_ts
      FROM interactionEntities ie JOIN interactions i ON i.rowid=ie.interactionRowid
      WHERE ie.entityRowid=? GROUP BY 1,2 ORDER BY n DESC""", comms.direction_values() + (rid,))
    for r in rows:
        r["first_ts"] = db.apple_time(r["first_ts"])
        r["last_ts"] = db.apple_time(r["last_ts"])
    name = _rows(conn, "SELECT json_extract(fields,'$.name') AS name FROM entities WHERE rowid=?",
                 (rid,))
    return {"available": True, "id": nid, "channel": True,
            "name": name[0]["name"] if name else None, "apps": rows}


# ---------------------------------------------------------------- one component
#
# Everything above draws the whole graph. This is the drill-down: one cluster key
# in, and out comes what the cluster is, who is in it, and — the reason this
# endpoint exists — the evidence that put them there. For the stored group that
# evidence is the statements themselves, with the confidence the store recorded
# and the ingest source decoded. For a clustered circle it is the overlap
# measured here, pair by pair, including the pairs that never cleared the cut
# and rode in on single linkage.

def _event_titles(conn):
    """{event subject -> its PS33 title}. Many events carry none."""
    out = {}
    for r in _rows(conn, "SELECT subject, object FROM event_graph "
                         "WHERE predicate='PS33' AND object<>''"):
        out.setdefault(r["subject"], r["object"])
    return out


def _event_card(ev, titles, days, counts):
    lo, hi = days.get(ev, (None, None))
    return {"id": vocab.sid(ev), "title": titles.get(ev), "day": lo,
            "last_day": hi if hi != lo else None, "attendees": counts.get(ev, 0),
            "label": titles.get(ev) or lo or vocab.sid(ev)}


def _group_weight(gid):
    """(rows on the group entity, rows pointing at it) — the two halves of the
    number the graph sizes a stored group by.

    Exactly the shape _node_weight uses for a person: every row on the subject,
    plus every row that names it. Both the graph and the component endpoint call
    this, so they can never disagree about how heavy the same group is — which
    is the promise _node_weight's docstring makes and which counting only the
    membership rows in one place and all of them in the other quietly broke.
    """
    rows = db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph WHERE subject=?",
                  (gid,), 0) or 0
    refs = db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph WHERE object='md:'||?",
                  (gid,), 0) or 0
    return rows, refs


def _node_weight(p, volume):
    """The number the force graph sizes a person node by, recomputed here so a
    component and the graph never disagree about how heavy someone is."""
    v = volume.get(p["eid"]) or {}
    return (p.get("facts", 0) + p.get("stable_refs", 0) + p.get("event_refs", 0)
            + (v.get("n") or 0) + p.get("expired", 0))


def _person_members(conn, rows, volume, extras=None):
    """Member records for people, labelled by the same fallback chain as the graph."""
    ids = [p["eid"] for p in rows]
    names, parts, handles, spaces = _names_and_handles(conn, ids)
    withdrawn = vocab.withdrawn_names(i for i in ids if not names.get(i) and not parts.get(i))
    out = []
    for p in rows:
        eid = p["eid"]
        label, src = _label_chain(eid, names, parts, handles, withdrawn)
        m = {"id": vocab.sid(eid), "label": label,
             "kind": "owner" if p.get("is_owner") else "person",
             "weight": _node_weight(p, volume),
             "namespaces": sorted(spaces.get(eid, ())),
             "label_source": src,
             "name_withdrawn": src == WITHDRAWN_NAME}
        m.update((extras or {}).get(eid) or {})
        out.append(m)
    out.sort(key=lambda m: (-m["weight"], m["label"] or ""))
    return out


def _shell(key, name, origin, layer, text, rule_params, requested=None,
           is_component=True):
    """The envelope every component answer fills in, so the page can render a
    cluster it has never seen before without special-casing."""
    return {
        "available": True,
        "key": key,
        "requested_key": key if requested is None else requested,
        "name": name,
        "origin": origin,
        "layer": layer,
        "is_component": is_component,
        "rule": {"text": text, "params": rule_params},
        "members": [],
        "cohesion": None,
        "evidence": {"kind": "none", "shared_kind": None, "note": "",
                     "shared": [], "shared_total": 0, "shared_shown": 0,
                     "pairs": [], "pairs_total": 0, "pairs_shown": 0,
                     "pairs_fired": 0, "pairs_not_fired": 0,
                     "pairs_shown_fired": 0, "pairs_shown_not_fired": 0,
                     "pairs_with_overlap": 0, "summary": {},
                     "limits": {"pairs": PAIR_LIMIT, "shared": SHARED_LIMIT,
                                "examples": EXAMPLE_LIMIT}},
        "triples": [],
    }


def _unknown(key, cuts, why):
    out = _shell(key, None, "derived", "graph",
                 "Nothing on this page carries that key, so there is no rule to show.",
                 dict(cuts), is_component=False)
    out["available"] = False
    out["error"] = why
    return out


def _plural(n, word, many=None):
    return "%d %s" % (n, word if n == 1 else (many or word + "s"))


def _cap(rows, limit):
    return rows[:limit], len(rows)


def _order_pairs(pairs, limit=PAIR_LIMIT):
    """Order the evidence rows so that truncating at `limit` cannot delete the story.

    The two informative ends of this table are the pair that only just cleared
    the cut and the pair that only just missed it: together they are the whole
    of what a reader needs to see that a component is held together by a chain
    rather than by everyone overlapping everyone. Sorting every firing pair
    ahead of every near miss and then cutting the list deletes the near misses
    outright — precisely the rows the rule text points at when it says single
    linkage carried someone in. So each side of the cut gets a reserved share of
    the cap, and both sides are ordered from the cut outwards: weakest firing
    pair first, closest near miss first.
    """
    fired = sorted((p for p in pairs if p["fired"]),
                   key=lambda p: (p["jaccard"], -p["shared"]))
    rest = sorted((p for p in pairs if not p["fired"]),
                  key=lambda p: (-p["jaccard"], -p["shared"]))
    if limit is None or len(fired) + len(rest) <= limit:
        return fired + rest
    # An equal share of the cap to each side of the cut; whichever side has fewer
    # rows than its share hands the remainder to the other, so nothing is wasted
    # and neither side can be squeezed out. The mix in a capped table is therefore
    # NOT the mix in the component — the counts that travel beside it are.
    half = limit // 2
    keep_fired = min(len(fired), max(half, limit - len(rest)))
    keep_rest = min(len(rest), limit - keep_fired)
    keep_fired = min(len(fired), limit - keep_rest)
    return fired[:keep_fired] + rest[:keep_rest]


def _cohesion(pairs, n, cut, note, weakest_by=None):
    """Measured over EVERY pair in the component, not only the ones that fired.

    `weakest_by` names the quantity the CALLER'S rule fires on, so the pair this
    reports as the weakest link is the one that is actually closest to failing
    under that rule. The calendar rule fires on the Jaccard, so the default is
    the Jaccard; the chat rule fires on the count of shared handles, and calling
    the lowest-Jaccard pair its weakest would name a pair that is nowhere near
    the cut the rule applied.
    """
    possible = n * (n - 1) // 2
    fired = [p for p in pairs if p["fired"]]
    js = [p.get("jaccard_exact", p["jaccard"]) for p in pairs]
    order = weakest_by or (lambda p: (p.get("jaccard_exact", p["jaccard"]),
                                      -p["shared"]))
    weak = min(fired, key=order) if fired else None
    return {
        "internal_edges": len(fired),
        "possible_pairs": possible,
        "density": round(len(fired) / possible, 4) if possible else None,
        "min_jaccard": round(min(js), 4) if js else None,
        "mean_jaccard": round(sum(js) / len(js), 4) if js else None,
        "weakest_pair": ({"a_label": weak["a_label"], "b_label": weak["b_label"],
                          "jaccard": weak["jaccard"], "shared": weak["shared"],
                          "union": weak["union"]} if weak else None),
        "cut": cut,
        "note": note,
    }


# ------------------------------------------------------------ derived: calendar

def _circle_component(conn, key, cuts):
    try:
        anchor = int(key.split(":", 1)[1])
    except (IndexError, ValueError):
        return _unknown(key, cuts, "that is not a circle key")

    owner = vocab.owner_id()
    kin, _bands = _kinship()
    attendance, days = _attendance(conn)
    ids = sorted(p for p in attendance if p != owner)
    comps = _components(ids, _overlap_pairs(attendance, ids), cuts["jaccard"])

    members = None
    for root, m in comps.items():
        if anchor in m:
            members, key = sorted(m), "circle:" + vocab.sid(root)
            break
    if members is None:
        return _unknown(key, cuts,
                        "no one with that id is invited to a meeting in this store, so the "
                        "calendar rule never built a component around them")

    volume = _volume()
    known = {p["eid"]: p for p in _universe(conn, kin, owner, cuts["closeness"])}
    rows = [known.get(m) or {"eid": m, "facts": 0, "stable_refs": 0, "event_refs": 0}
            for m in members]
    mem = _person_members(conn, rows, volume)
    lab = {m["id"]: m["label"] for m in mem}

    titles = _event_titles(conn)
    counts = collections.Counter()
    for evs in attendance.values():
        for ev in evs:
            counts[ev] += 1

    cut = cuts["jaccard"]
    pairs = []
    for a, b in itertools.combinations(members, 2):
        A, B = attendance[a], attendance[b]
        both, either = A & B, A | B
        # the ratio the clustering compared, unrounded. Rounding first and then
        # testing it against the cut marks pairs as having fired that the
        # union-find rejected, and inflates every count derived from `fired`.
        jac = len(both) / len(either) if either else 0.0
        sa, sb = vocab.sid(a), vocab.sid(b)
        pairs.append({
            "a": sa, "b": sb, "a_label": lab.get(sa), "b_label": lab.get(sb),
            "shared": len(both), "union": len(either), "jaccard": round(jac, 4),
            "jaccard_exact": jac,
            "fired": jac >= cut,
            "examples": [_event_card(e, titles, days, counts)
                         for e in sorted(both, key=lambda e: days.get(e, ("", ""))[0]
                                         )[:EXAMPLE_LIMIT]],
        })

    shared_all = set.intersection(*[attendance[m] for m in members]) if members else set()
    union_all = set().union(*[attendance[m] for m in members]) if members else set()
    shared_rows = [_event_card(e, titles, days, counts)
                   for e in sorted(shared_all, key=lambda e: days.get(e, ("", ""))[0])]

    lead = mem[0]["label"] if mem else None
    name = lead if len(mem) < 2 else "%s + %d others" % (lead, len(mem) - 1)
    # how much of this circle the rule actually joined, counted here rather than
    # asserted: single linkage needs a spanning chain, not a clique, so the pairs
    # that never cleared the cut are a property of THIS circle and get measured.
    fired_here = sum(1 for p in pairs if p["fired"])
    missed_here = len(pairs) - fired_here
    measured_events = {e for st in attendance.values() for e in st}
    owner_events = attendance.get(owner, set())
    text = (
        "A meeting circle. Two people were joined when at least %s of the "
        "meetings either of them is invited to are meetings they are both invited to, and the circle "
        "is one connected component of that relation. It is single linkage, not a "
        "clique: being in this circle does NOT mean you cleared the cut with everyone "
        "else in it."
        % ("%.0f%%" % (cut * 100))
    )
    if pairs and missed_here:
        text += (" Of the %s inside this one, %d cleared the cut and %d did not; those "
                 "%d were carried in by a chain of pairs that did, and are the rows "
                 "below marked as not firing."
                 % (_plural(len(pairs), "member pair"), fired_here, missed_here,
                    missed_here))
    elif pairs:
        text += (" All %s inside this one cleared the cut, so nothing here rests on a "
                 "chain — that is a property of this circle, not a guarantee of the rule."
                 % _plural(len(pairs), "member pair"))
    text += (
        " The owner is excluded: they are on %d of the %d meetings measured here, and "
        "leaving them in collapses the whole graph into one blob."
        % (len(owner_events), len(measured_events)))
    if len(members) < 2:
        text += (" At the cut now applied this person is joined to nobody: what you are "
                 "looking at is a component of one, not a circle. The catalogue that "
                 "named this key was built at a different cut.")
    out = _shell(key, name, "derived", "calendar", text, {
        "jaccard": cut, "linkage": "single", "measure": "Jaccard overlap of event sets",
        "owner_excluded": True, "people_considered": len(ids),
        "events_considered": len({e for s in attendance.values() for e in s}),
    }, requested=key)
    out["members"] = mem
    out["cohesion"] = _cohesion(pairs, len(members), cut,
                                "density counts the pairs that cleared the cut against "
                                "every possible pair; min and mean run over every pair, "
                                "so a chain-shaped circle shows a minimum below its own "
                                "cut")
    if out["cohesion"]["weakest_pair"]:
        out["cohesion"]["weakest_pair"]["note"] = (
            "lowest overlap of the pairs that fired — the quantity the rule fires on, "
            "so this is the join that breaks first as the cut rises")
    # every pair is eligible for the table, including the ones sharing nothing at
    # all: a pair with no meeting in common that is nevertheless in this circle is
    # the plainest possible evidence that single linkage carried someone in, and
    # dropping those rows leaves the chaining claim above with nothing under it.
    with_overlap = sum(1 for p in pairs if p["shared"])
    shown = _order_pairs(pairs, PAIR_LIMIT)
    fired_shown = sum(1 for p in shown if p["fired"])
    shared_shown, shared_total = _cap(shared_rows, SHARED_LIMIT)
    out["evidence"].update({
        "kind": "calendar", "shared_kind": "event",
        "note": "shared: meetings every member of this circle was invited to. pairs: the "
                "measured overlap between two members, with the meetings behind it — "
                "a pair with nothing in common is shown as such rather than left out. "
                "The overlap column is rounded for reading; the rule compared the "
                "unrounded ratio, carried beside it as jaccard_exact, so a row that "
                "reads as equal to the cut can still be marked as not firing. Where "
                "the list is capped it is capped on both sides of the cut in equal "
                "share, working outwards from it, so the mix of rows in the table is "
                "not the mix in the circle — the counts beside it are.",
        "shared": shared_shown, "shared_total": shared_total,
        "shared_shown": len(shared_shown),
        "pairs": shown, "pairs_total": len(pairs), "pairs_shown": len(shown),
        "pairs_with_overlap": with_overlap,
        "pairs_fired": sum(1 for p in pairs if p["fired"]),
        "pairs_not_fired": sum(1 for p in pairs if not p["fired"]),
        # what survived the cap, either side of it, so a reader can check the table
        # against the claim the rule text makes about chains
        "pairs_shown_fired": fired_shown,
        "pairs_shown_not_fired": len(shown) - fired_shown,
        "summary": {"people": len(members), "events_any": len(union_all),
                    "events_all": len(shared_all), "cut": cut,
                    "pairs_without_overlap": len(pairs) - with_overlap,
                    "pairs_in_this_circle_that_never_fired":
                        sum(1 for p in pairs if not p["fired"])},
    })
    return out


def _solo_component(conn, cuts):
    """Not a component: the people the calendar rule looked at and could not place."""
    owner = vocab.owner_id()
    kin, _bands = _kinship()
    attendance, days = _attendance(conn)
    ids = sorted(p for p in attendance if p != owner)
    pairs = _overlap_pairs(attendance, ids)
    placed = {i for m in _components(ids, pairs, cuts["jaccard"]).values() if len(m) > 1
              for i in m}

    people = _universe(conn, kin, owner, cuts["closeness"])
    rows = [p for p in people
            if p["eid"] != owner and attendance.get(p["eid"]) and p["eid"] not in placed]
    volume = _volume()

    best = {}
    for a, b, shared, union, jac in pairs:
        for x, y in ((a, b), (b, a)):
            if x not in best or jac > best[x][4]:
                best[x] = (x, y, shared, union, jac)

    cut = cuts["jaccard"]
    owner_events = attendance.get(owner, set())
    extras = {}
    for p in rows:
        eid = p["eid"]
        b = best.get(eid)
        # "nobody" always means nobody the RULE compares them against. The owner is
        # held out of the clustering and is on most of this store's meetings, so
        # saying these people share their meetings with no one on this page is
        # false — the same payload draws the co-attendance edge that disproves it.
        attends = len(attendance[eid])
        with_owner = len(attendance[eid] & owner_events)
        held_out = ((" The owner is held out of the clustering: of the %s this person "
                     "is invited to, the owner is on %d."
                     % (_plural(attends, "meeting"), with_owner)) if with_owner else "")
        if b is None:
            extras[eid] = {"best_jaccard": None, "best_with": None,
                           "shared_with_owner": with_owner,
                           "why": "is invited to %s and shares not one of them with anyone "
                                  "the rule considers.%s"
                                  % (_plural(attends, "meeting"), held_out)}
        else:
            extras[eid] = {"best_jaccard": round(b[4], 4), "best_with": vocab.sid(b[1]),
                           "best_shared": b[2], "best_union": b[3],
                           "shared_with_owner": with_owner,
                           "why": "closest anyone the rule considers came: %d of %s in "
                                  "common, Jaccard %.2f — under the %.2f cut.%s"
                                  % (b[2], _plural(b[3], "meeting"), b[4], cut, held_out)}
    mem = _person_members(conn, rows, volume, extras)
    lab = {m["id"]: m["label"] for m in mem}
    for m in mem:
        if m.get("best_with"):
            m["best_with_label"] = lab.get(m["best_with"])

    titles = _event_titles(conn)
    counts = collections.Counter()
    for evs in attendance.values():
        for ev in evs:
            counts[ev] += 1
    names, parts, handles, _sp = _names_and_handles(conn, ids)
    near, seen = [], set()
    for p in rows:
        b = best.get(p["eid"])
        if not b:
            continue
        pair = tuple(sorted((b[0], b[1])))
        if pair in seen:
            continue
        seen.add(pair)
        a, z = pair
        both = attendance[a] & attendance[z]
        near.append({"a": vocab.sid(a), "b": vocab.sid(z),
                     "a_label": _label_chain(a, names, parts, handles)[0],
                     "b_label": _label_chain(z, names, parts, handles)[0],
                     "shared": b[2], "union": b[3], "jaccard": round(b[4], 4),
                     "fired": False,
                     "examples": [_event_card(e, titles, days, counts)
                                  for e in sorted(both, key=lambda e: days.get(e, ("", ""))[0]
                                                  )[:EXAMPLE_LIMIT]]})
    near.sort(key=lambda p: -p["jaccard"])
    shown, total = _cap(near, PAIR_LIMIT)

    measured = {e for s in attendance.values() for e in s}
    text = ("A catalogue bucket, not a circle. These people do attend meetings, but no "
            "pairing with anyone the rule compares them against cleared the %.2f "
            "Jaccard cut, so the rule left each of them standing alone. Alone means "
            "alone under this rule, not alone in the store: the owner is held out of "
            "the clustering and is on %d of the %d meetings measured here, so every "
            "person below does share meetings — with them. The pairs below are the "
            "near misses among the people the rule did compare: they did NOT fire, "
            "and lowering the cut is what would pull them in."
            % (cut, len(owner_events), len(measured)))
    out = _shell("solo", "Left alone by the calendar rule", "derived", "calendar", text,
                 {"jaccard": cut, "linkage": "single", "people_considered": len(ids),
                  "owner_excluded": True,
                  "owner_meetings": len(owner_events),
                  "meetings_considered": len(measured)},
                 is_component=False)
    out["members"] = mem
    out["evidence"].update({
        "kind": "calendar", "shared_kind": None,
        "note": "these pairs did not fire, and none of them was ever going to: nothing "
                "was carried in here. Each row is one unplaced person's closest "
                "approach to anybody else the rule compares them against, measured at "
                "the cut in force. The owner is not among those, by construction.",
        "pairs": shown, "pairs_total": total, "pairs_shown": len(shown),
        "pairs_fired": 0, "pairs_not_fired": total,
        "pairs_shown_fired": 0, "pairs_shown_not_fired": len(shown),
        "pairs_with_overlap": total,
        "summary": {"people": len(rows), "placed_elsewhere": len(placed),
                    "calendar_people": len(ids), "cut": cut,
                    "owner_meetings": len(owner_events),
                    "meetings_considered": len(measured)},
    })
    return out


def _unplaced_component(conn, cuts):
    """Not a component: people the calendar rule never had a measurement for."""
    owner = vocab.owner_id()
    kin, _bands = _kinship()
    attendance, _days = _attendance(conn)
    people = _universe(conn, kin, owner, cuts["closeness"])
    rows = [p for p in people if p["eid"] != owner and not attendance.get(p["eid"])]
    volume = _volume()

    in_group = {vocab.entity_ref(r["object"]) for r in _rows(
        conn, "SELECT object FROM stable_graph WHERE predicate='%s' "
              "AND relationshipPredicate='%s'" % (P_GROUP_MEMBER, F_MEMBER))}
    employed = {r["subject"] for r in _rows(
        conn, "SELECT subject FROM stable_graph WHERE predicate='%s' "
              "AND relationshipPredicate='%s'" % (P_EMPLOYER, F_ORG))}

    extras = {}
    for p in rows:
        eid, why = p["eid"], []
        if p.get("invited"):
            why.append("named as the sender of %s, never as an attendee"
                       % _plural(p["invited"], "calendar invitation"))
        if p.get("organized"):
            why.append("organised %s" % _plural(p["organized"], "event"))
        score = (kin.get(eid) or {}).get("familyAndFriends")
        if score:
            why.append("scored %.2f on the closeness scorecard" % score)
        if eid in in_group:
            why.append("a member of the stored group")
        if eid in employed:
            why.append("carries a stored employer statement")
        if p.get("expired") and not p.get("facts"):
            why.append("its live facts are gone; only the retraction archive still "
                       "names them")
        if not why:
            why.append("named by other rows in the store")
        extras[eid] = {"why": "no attendee row to measure — " + "; ".join(why),
                       "attendee_rows": 0, "sender_events": p.get("invited", 0),
                       "organized_events": p.get("organized", 0),
                       "closeness": score}
    mem = _person_members(conn, rows, volume, extras)

    text = ("A catalogue bucket, not a circle. The calendar rule compares attendee lists, and "
            "none of these people appear on one. They reach this page down some other "
            "edge: a scorecard reading, an invitation they sent, an employer, a stored "
            "group membership. No overlap could be measured, so none was.")
    out = _shell("unplaced", "Outside the calendar layer", "derived", "graph", text,
                 {"jaccard": cuts["jaccard"], "closeness": cuts["closeness"],
                  "measure": "none — there are no invitations to overlap"},
                 is_component=False)
    out["members"] = mem
    out["evidence"].update({
        "kind": "none",
        "note": "there is no overlap to show: the rule had nothing to measure on these "
                "people. The reason each of them is on the page is on their row.",
        "summary": {"people": len(rows),
                    "with_sender_events": sum(1 for p in rows if p.get("invited")),
                    "with_closeness": sum(1 for p in rows
                                          if (kin.get(p["eid"]) or {}).get("familyAndFriends")),
                    "with_employer": sum(1 for p in rows if p["eid"] in employed),
                    "retracted": sum(1 for p in rows
                                     if p.get("expired") and not p.get("facts"))},
    })
    return out


# ------------------------------------------------------------ derived: channels

def _chat_members(rids, chans, by_chan, resolved_by_chan):
    index = {c["rid"]: c for c in chans}
    out = []
    for rid in rids:
        c = index.get(rid) or {}
        name = c.get("name")
        out.append({"id": "chan:%d" % rid, "label": name or ("chat %d" % rid),
                    "kind": "channel", "weight": c.get("message_rows") or 0,
                    "namespaces": [], "named": bool(name),
                    "handles": len(by_chan.get(rid, ())),
                    "resolved_people": len(resolved_by_chan.get(rid, ())),
                    "first_contact": db.apple_time(c.get("first_ts")),
                    "last_contact": db.apple_time(c.get("last_ts"))})
    out.sort(key=lambda m: (-m["weight"], m["label"] or ""))
    return out


def _chat_component(key, cuts):
    try:
        anchor = int(key.split(":", 1)[1])
    except (IndexError, ValueError):
        return _unknown(key, cuts, "that is not a chat-cluster key")

    chans, by_chan, overlaps, resolved = _channel_layer()
    if not chans:
        out = _unknown(key, cuts, "this bundle holds no group-chat entities")
        out["layer"] = "channels"
        return out
    rids = [c["rid"] for c in chans]
    cut = cuts["channel_share"]
    comps = _channel_components(rids, [o for o in overlaps if o["shared"] >= cut])

    members = None
    for root, m in comps.items():
        if anchor in m:
            members, key = sorted(m), "chat:%d" % root
            break
    if members is None:
        return _unknown(key, cuts, "no group chat in this bundle carries that rowid")

    res = collections.defaultdict(set)
    for r in resolved:
        res[r["grp"]].add(r["eid"])
    mem = _chat_members(members, chans, by_chan, res)
    lab = {m["id"]: m["label"] for m in mem}

    pairs = []
    for a, b in itertools.combinations(members, 2):
        A, B = by_chan.get(a, set()), by_chan.get(b, set())
        both, either = A & B, A | B
        jac = len(both) / len(either) if either else 0.0
        pairs.append({"a": "chan:%d" % a, "b": "chan:%d" % b,
                      "a_label": lab.get("chan:%d" % a), "b_label": lab.get("chan:%d" % b),
                      "shared": len(both), "union": len(either),
                      "jaccard": round(jac, 4), "jaccard_exact": jac,
                      "fired": len(both) >= cut,
                      "examples": [{"label": h, "handle": h}
                                   for h in sorted(both)[:EXAMPLE_LIMIT]]})

    shared_all = set.intersection(*[by_chan.get(m, set()) for m in members]) if members else set()
    everywhere = collections.Counter()
    for h in shared_all:
        everywhere[h] = sum(1 for rid in rids if h in by_chan.get(rid, ()))
    shared_rows = [{"label": h, "handle": h, "chats_here": len(members),
                    "chats_anywhere": everywhere[h]} for h in sorted(shared_all)]

    lead = mem[0]["label"] if mem else None
    name = lead if len(mem) < 2 else "%s + %d others" % (lead, len(mem) - 1)
    text = ("A chat cluster. Two group chats were called related when they "
            "share at least %s, and the cluster is one connected "
            "component of that relation — single linkage again, so chats at opposite "
            "ends may share nobody. A handle is an address the messaging app donated, "
            "not a resolved person: only the few that appear in the internal handle "
            "index become someone this graph knows."
            % _plural(cut, "participant handle"))
    if len(members) < 2:
        text += (" At the cut now applied this chat links to nothing: what you are "
                 "looking at is a component of one, not a cluster. The catalogue that "
                 "named this key was built at a different cut.")
    out = _shell(key, name, "derived", "channels", text,
                 {"channel_share": cut, "linkage": "single",
                  "measure": "count of participant handles two chats have in common",
                  "chats_considered": len(rids)}, requested=key)
    out["members"] = mem
    # the weakest link here is the pair with the FEWEST SHARED HANDLES, because
    # that count is what the rule fires on: raise the cut by one and that pair is
    # the first join to break. Picking the lowest-Jaccard pair instead names a
    # pair that may be nowhere near failing, and contradicts min_shared below.
    out["cohesion"] = _cohesion(pairs, len(members), cut,
                                "the rule fires on the COUNT of shared handles, not on "
                                "the Jaccard: the Jaccard columns are reported for scale "
                                "and a large chat overlapping a small one scores low on "
                                "it while still firing. The weakest pair below, and "
                                "min_shared, are therefore chosen on the count",
                                weakest_by=lambda p: (p["shared"],
                                                      p.get("jaccard_exact", p["jaccard"])))
    weak = out["cohesion"]["weakest_pair"]
    if weak:
        weak["note"] = ("fewest shared handles of the pairs that fired — the quantity "
                        "the rule fires on, so this is the join that breaks first")
    # derived from the same pair, so the two can never disagree
    out["cohesion"]["min_shared"] = weak["shared"] if weak else None
    with_overlap = sum(1 for p in pairs if p["shared"])
    shown = _order_pairs(pairs, PAIR_LIMIT)
    fired_shown = sum(1 for p in shown if p["fired"])
    shared_shown, shared_total = _cap(shared_rows, SHARED_LIMIT)
    out["evidence"].update({
        "kind": "channels", "shared_kind": "handle",
        "note": "shared: handles present in every chat of this cluster. pairs: the "
                "handles two chats have in common, which is what the rule fired on — "
                "two chats sharing nobody are shown as such rather than left out, "
                "because in a single-linkage cluster that is the normal case. Where "
                "the list is capped it is capped on both sides of the cut in equal "
                "share, working outwards from it, so the mix of rows in the table is "
                "not the mix in the cluster — the counts beside it are.",
        "shared": shared_shown, "shared_total": shared_total,
        "shared_shown": len(shared_shown),
        "pairs": shown, "pairs_total": len(pairs), "pairs_shown": len(shown),
        "pairs_with_overlap": with_overlap,
        "pairs_fired": sum(1 for p in pairs if p["fired"]),
        "pairs_not_fired": sum(1 for p in pairs if not p["fired"]),
        "pairs_shown_fired": fired_shown,
        "pairs_shown_not_fired": len(shown) - fired_shown,
        "summary": {"chats": len(members),
                    "handles": len({h for m in members for h in by_chan.get(m, ())}),
                    "handles_in_every_chat": len(shared_all),
                    "handles_resolved_to_a_person": len({e for m in members for e in res.get(m, ())}),
                    "cut": cut,
                    "pairs_without_overlap": len(pairs) - with_overlap,
                    "pairs_in_this_cluster_that_never_fired":
                        sum(1 for p in pairs if not p["fired"])},
    })
    return out


def _solo_chat_component(cuts):
    chans, by_chan, overlaps, resolved = _channel_layer()
    cut = cuts["channel_share"]
    if not chans:
        out = _shell("solo_chat", "Chats that link to no other chat", "derived",
                     "channels", "This bundle holds no group-chat entities at all.",
                     {"channel_share": cut}, is_component=False)
        out["evidence"]["kind"] = "channels"
        return out
    rids = [c["rid"] for c in chans]
    comps = _channel_components(rids, [o for o in overlaps if o["shared"] >= cut])
    alone = sorted(r for root, m in comps.items() if len(m) == 1 for r in m)

    best = {}
    for o in overlaps:
        for x, y in ((o["a"], o["b"]), (o["b"], o["a"])):
            if x not in best or o["shared"] > best[x][1]:
                best[x] = (y, o["shared"], o["union"])

    res = collections.defaultdict(set)
    for r in resolved:
        res[r["grp"]].add(r["eid"])
    mem = _chat_members(alone, chans, by_chan, res)
    lab = {m["id"]: m["label"] for m in mem}
    pairs = []
    for rid in alone:
        b = best.get(rid)
        for m in mem:
            if m["id"] != "chan:%d" % rid:
                continue
            if b is None:
                m["why"] = ("shares not one handle with any other chat here"
                            if by_chan.get(rid) else
                            "no participant handle was donated for this chat at all")
                m["best_shared"] = 0
            else:
                m["why"] = ("shares at most %s with any other chat — under the cut of %d"
                            % (_plural(b[1], "handle"), cut))
                m["best_shared"] = b[1]
        if b is not None:
            other = "chan:%d" % b[0]
            pairs.append({"a": "chan:%d" % rid, "b": other, "a_label": lab.get("chan:%d" % rid),
                          "b_label": (next((c.get("name") for c in chans if c["rid"] == b[0]), None)
                                      or "chat %d" % b[0]),
                          "shared": b[1], "union": b[2],
                          "jaccard": round(b[1] / b[2], 4) if b[2] else 0.0,
                          "fired": False,
                          "examples": [{"label": h, "handle": h} for h in
                                       sorted(by_chan.get(rid, set()) & by_chan.get(b[0], set())
                                              )[:EXAMPLE_LIMIT]]})
    pairs.sort(key=lambda p: (-p["shared"], -p["jaccard"]))
    shown, total = _cap(pairs, PAIR_LIMIT)

    text = ("A catalogue bucket, not a cluster. Each of these group chats shares fewer than %d "
            "participant handles with every other chat, so the rule had nothing to join "
            "them to. The rows below are near misses that did NOT fire." % cut)
    out = _shell("solo_chat", "Chats that link to no other chat", "derived", "channels",
                 text, {"channel_share": cut, "chats_considered": len(rids)},
                 is_component=False)
    out["members"] = mem
    out["evidence"].update({
        "kind": "channels", "shared_kind": None,
        "note": "these pairs did not fire, and none of them was carried in by anything: "
                "each row is one lone chat's closest approach to any other chat.",
        "pairs": shown, "pairs_total": total, "pairs_shown": len(shown),
        "pairs_fired": 0, "pairs_not_fired": total,
        "pairs_shown_fired": 0, "pairs_shown_not_fired": len(shown),
        "pairs_with_overlap": total,
        "summary": {"chats": len(alone), "chats_considered": len(rids),
                    "clustered_elsewhere": sum(len(m) for m in comps.values() if len(m) > 1),
                    "with_no_overlap_at_all": sum(1 for r in alone if r not in best),
                    "cut": cut},
    })
    return out


# -------------------------------------------------------------------- stored

def _statement_rows(conn, predicate):
    """Whole statements, facets kept as a LIST.

    vocab.statements() keys facets by relationshipPredicate, which silently
    drops all but one of a statement's repeated facets — and the one group
    statement in this store carries two PS566 members. Here every facet row
    survives.
    """
    out = collections.OrderedDict()
    for r in _rows(conn, "SELECT subject, relationshipId, relationshipPredicate, object, "
                         "confidence, sources, sourceDuplicates, timestamp "
                         "FROM stable_graph WHERE predicate=? ORDER BY subject, relationshipId",
                   (predicate,)):
        st = out.get(r["relationshipId"])
        if st is None:
            st = out[r["relationshipId"]] = {
                "subject": r["subject"], "rid": r["relationshipId"],
                "confidence": r["confidence"], "sources": r["sources"],
                "token": r["sourceDuplicates"],
                "asserted": db.apple_time(r["timestamp"]), "facets": []}
        st["facets"].append((r["relationshipPredicate"], r["object"]))
    return list(out.values())


def _common_sources(masks):
    """The ingest sources present on every statement — what they all have in common."""
    sets = [set(vocab.source_names(m or 0)) for m in masks]
    if not sets:
        return []
    common = set.intersection(*sets)
    counted = collections.Counter(s for one in sets for s in one)
    return [{"label": s, "statements": counted[s]} for s in sorted(common)]


def _employment_component(conn, key, cuts):
    """employer / employee: the PS500 statements, exactly as the store wrote them."""
    owner = vocab.owner_id()
    kin, _bands = _kinship()
    sts = _statement_rows(conn, P_EMPLOYER)
    subjects = sorted({s["subject"] for s in sts})
    orgs = sorted({vocab.entity_ref(o) for s in sts for p, o in s["facets"]
                   if p == F_ORG and vocab.entity_ref(o) is not None})

    # the graph adds people first, then the group, then organisations; an id
    # already drawn elsewhere keeps its own cluster, so the bucket is what is left
    taken = {p["eid"] for p in _universe(conn, kin, owner, cuts["closeness"])}
    taken |= {r["subject"] for r in _rows(
        conn, "SELECT DISTINCT subject FROM stable_graph WHERE predicate='%s'" % P_GROUP_MEMBER)}

    names, parts, handles, spaces = _names_and_handles(conn, set(subjects) | set(orgs))
    label_of = {e: _label_chain(e, names, parts, handles)[0]
                for e in set(subjects) | set(orgs)}

    triples = []
    for s in sts:
        facets = dict(s["facets"])
        org = vocab.entity_ref(facets.get(F_ORG))
        extra = [{"label": vocab.plabel(p), "value": o} for p, o in s["facets"]
                 if p not in (F_ORG, "PS1")]
        triples.append({
            "subject": vocab.sid(s["subject"]),
            "subject_label": label_of.get(s["subject"]),
            "predicate": vocab.plabel(P_EMPLOYER),
            "predicate_code": P_EMPLOYER,
            "object": label_of.get(org),
            "object_id": vocab.sid(org),
            "object_ref": facets.get(F_ORG),
            "statement_class": vocab.clabel(facets.get("PS1") or ""),
            "facet": vocab.plabel(F_ORG),
            "confidence": s["confidence"],
            "sources": vocab.source_names(s["sources"]),
            "source_mask": s["sources"],
            "asserted": s["asserted"],
            "extra_facets": extra,
        })
    triples.sort(key=lambda t: (-(t["confidence"] or 0), t["object"] or "",
                                t["subject_label"] or ""))

    volume = _volume()
    if key == "employer":
        ids = [o for o in orgs if o not in taken]
        indeg = collections.Counter(vocab.entity_ref(o) for s in sts
                                    for p, o in s["facets"] if p == F_ORG)
        mem = [{"id": vocab.sid(o), "label": label_of.get(o), "kind": "org",
                "weight": indeg[o], "namespaces": sorted(spaces.get(o, ())),
                "employees_here": indeg[o],
                "class": vocab.clabel(db.one(
                    GRAPH, "SELECT object FROM stable_graph WHERE subject=? "
                           "AND predicate='PS1' AND relationshipId=0", (o,)) or "")}
               for o in ids]
        mem.sort(key=lambda m: (-m["weight"], m["label"] or ""))
        name, layer_name = "Employer organisations", "the far end of the statement"
    else:
        ids = [p for p in subjects if p not in taken]
        rows = [{"eid": p, "facts": db.one(
            GRAPH, "SELECT COUNT(*) FROM stable_graph WHERE subject=?", (p,), 0) or 0,
            "stable_refs": 0, "event_refs": 0} for p in ids]
        mem = _person_members(conn, rows, {})
        by_person = collections.defaultdict(list)
        for t in triples:
            by_person[t["subject"]].append(t["object"])
        for m in mem:
            m["employers"] = by_person.get(m["id"], [])
        name, layer_name = "People the store gives an employer", "the near end"

    confs = sorted({s["confidence"] for s in sts})
    text = ("A catalogue bucket, not a circle. The store never says these people form a "
            "group; it says, once per person, that a person has an employer, and they "
            "are gathered here on that shared property: one reified statement per "
            "person — predicate %s, relationship class %s, the organisation hanging "
            "off the %s facet — read exactly as written. Every row below carries the "
            "confidence the store recorded and the ingest source it came from, decoded."
            % (vocab.plabel(P_EMPLOYER),
               vocab.clabel(next((dict(s["facets"]).get("PS1") for s in sts), "") or ""),
               vocab.plabel(F_ORG)))
    # `origin` is "stored" because every statement under these rows is a stored
    # fact. `is_component` is False because the GROUPING is not: the store never
    # says "these nineteen people form a group", it says nineteen separate times
    # that a person has an employer, and they are gathered here on that shared
    # property. Those are different claims and the payload must not merge them.
    out = _shell(key, name, "stored", "graph", text,
                 {"predicate": P_EMPLOYER, "facet": F_ORG, "reified": True,
                  "clustered": False, "side": layer_name},
                 is_component=False)
    out["members"] = mem
    out["cohesion"] = None       # a filing has no rule to be cohesive under
    out["triples"] = triples
    shared = _common_sources([s["sources"] for s in sts])
    out["evidence"].update({
        "kind": "employer", "shared_kind": "source",
        "note": "shared: the ingest sources every one of these statements carries. "
                "There are no measured pairs here — nothing was compared, the store "
                "simply says so.",
        "shared": shared, "shared_total": len(shared), "shared_shown": len(shared),
        "summary": {"statements": len(sts), "people": len(subjects),
                    "organisations": len(orgs),
                    "confidences": confs,
                    "uniform_confidence": confs[0] if len(confs) == 1 else None,
                    "sources": sorted({s["label"] for s in shared}),
                    "single_source": len(shared) == 1,
                    "first_asserted": min((s["asserted"] for s in sts), default=None),
                    "last_asserted": max((s["asserted"] for s in sts), default=None),
                    "drawn_in_this_bucket": len(mem)},
    })
    return out


def _group_component(conn, cuts):
    """The one stored group: its PS753 statement and every PS566 member facet."""
    sts = _statement_rows(conn, P_GROUP_MEMBER)
    if not sts:
        out = _shell("explicit", None, "stored", "graph",
                     "This bundle holds no group-membership statement at all.",
                     {"predicate": P_GROUP_MEMBER}, is_component=False)
        out["evidence"]["kind"] = "group"
        return out

    gids = sorted({s["subject"] for s in sts})
    member_ids = sorted({vocab.entity_ref(o) for s in sts for p, o in s["facets"]
                         if p == F_MEMBER and vocab.entity_ref(o) is not None})
    owner = vocab.owner_id()
    kin, _bands = _kinship()
    known = {p["eid"]: p for p in _universe(conn, kin, owner, cuts["closeness"])}
    volume = _volume()

    names, parts, handles, spaces = _names_and_handles(conn, set(gids) | set(member_ids))
    label_of = {e: _label_chain(e, names, parts, handles)[0]
                for e in set(gids) | set(member_ids)}

    mem = []
    for gid in gids:
        cls = db.one(GRAPH, "SELECT object FROM stable_graph WHERE subject=? "
                            "AND predicate='PS1' AND relationshipId=0", (gid,))
        rows, refs = _group_weight(gid)
        mem.append({"id": vocab.sid(gid),
                    "label": label_of.get(gid) if names.get(gid) else vocab.clabel(cls or ""),
                    "kind": "explicit_group", "weight": rows + refs,
                    "namespaces": sorted(spaces.get(gid, ())),
                    "role": "the group entity itself",
                    "named": bool(names.get(gid)),
                    "class": vocab.clabel(cls or ""), "class_code": cls})
    prows = [known.get(m) or {"eid": m, "facts": 0, "stable_refs": 0, "event_refs": 0}
             for m in member_ids]
    for m in _person_members(conn, prows, volume):
        m["role"] = ("the owner, a member of their own circle"
                     if m["id"] == vocab.sid(owner) else "named by a member facet")
        mem.append(m)

    triples = []
    for s in sts:
        cls = dict(s["facets"]).get("PS1")
        for p, o in s["facets"]:
            if p != F_MEMBER:
                continue
            eid = vocab.entity_ref(o)
            triples.append({
                "subject": vocab.sid(s["subject"]),
                "subject_label": label_of.get(s["subject"]) or vocab.clabel(
                    db.one(GRAPH, "SELECT object FROM stable_graph WHERE subject=? "
                                  "AND predicate='PS1' AND relationshipId=0",
                           (s["subject"],)) or ""),
                "predicate": vocab.plabel(P_GROUP_MEMBER),
                "predicate_code": P_GROUP_MEMBER,
                "object": label_of.get(eid), "object_id": vocab.sid(eid), "object_ref": o,
                "statement_class": vocab.clabel(cls or ""),
                "facet": vocab.plabel(F_MEMBER),
                "confidence": s["confidence"],
                "sources": vocab.source_names(s["sources"]),
                "source_mask": s["sources"],
                "asserted": s["asserted"],
                "extra_facets": [],
            })

    # The circle tokens. They are NOT carried by the membership rows this
    # component shows — they sit on other rows of the group entity, and the
    # member entities happen to carry the same string on rows of their own. So
    # every claim about them is counted here, per token, and the wording says
    # which rows they are actually on rather than implying they annotate the
    # statement below.
    gid_set, member_set = set(gids), set(member_ids)
    group_rows_total = sum(db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph "
                                         "WHERE subject=?", (g,), 0) or 0 for g in gids)
    statement_rows_total = sum(db.one(GRAPH, "SELECT COUNT(*) FROM stable_graph "
                                             "WHERE subject=? AND predicate=?",
                                      (g, P_GROUP_MEMBER), 0) or 0 for g in gids)
    tok_rows = _rows(conn, "SELECT subject, predicate, relationshipPredicate, object "
                           "FROM stable_graph WHERE object LIKE 'faFamilyCircle:%'")
    tokens = sorted({r["object"] for r in tok_rows if r["subject"] in gid_set})
    shared = []
    for t in tokens:
        here = [r for r in tok_rows if r["object"] == t]
        on_group = [r for r in here if r["subject"] in gid_set]
        on_members = {r["subject"] for r in here if r["subject"] in member_set}
        on_statement = sum(1 for r in on_group if r["predicate"] == P_GROUP_MEMBER)
        shared.append({
            "label": t, "token": t, "namespace": vocab.ns_of(t),
            "rows_on_the_group_entity": len(on_group),
            "rows_on_the_group_entity_total": group_rows_total,
            "on_the_membership_statement": on_statement,
            "membership_statement_rows": statement_rows_total,
            "member_entities_carrying_it": len(on_members),
            "member_entities": len(member_ids),
            "predicates": sorted({vocab.plabel(r["predicate"]) for r in on_group}),
            "note": "does not resolve against any source store in this bundle",
        })

    text = ("The one membership the store asserts as a group. One reified %s statement "
            "of class %s, whose %s facets name the members. The confidence and source "
            "below are the store's own." %
            (vocab.plabel(P_GROUP_MEMBER),
             vocab.clabel(next((dict(s["facets"]).get("PS1") for s in sts), "") or ""),
             vocab.plabel(F_MEMBER)))
    lead = next((m["label"] for m in mem if m["kind"] == "explicit_group"), None)
    out = _shell("explicit", lead, "stored", "graph", text,
                 {"predicate": P_GROUP_MEMBER, "facet": F_MEMBER, "reified": True,
                  "clustered": False, "statements": len(sts)})
    out["members"] = mem
    out["cohesion"] = None
    out["triples"] = triples
    on_stmt = sum(sh["on_the_membership_statement"] for sh in shared)
    all_members_carry = all(sh["member_entities_carrying_it"] == len(member_ids)
                            for sh in shared) if shared and member_ids else False
    out["evidence"].update({
        "kind": "group", "shared_kind": "token",
        "note": "shared: the source tokens attached to the GROUP ENTITY — %s of the %s "
                "rows on it carry one, and %s of the %s membership rows below do. They "
                "are shown because %s. A token is not evidence the store compared "
                "anyone: there are no measured pairs here, the store asserts the "
                "membership outright."
                % (sum(sh["rows_on_the_group_entity"] for sh in shared),
                   group_rows_total, on_stmt, statement_rows_total,
                   ("the same string also appears on a row of every member entity"
                    if all_members_carry else
                    "the same string also appears on rows of some member entities")),
        "shared": shared, "shared_total": len(shared), "shared_shown": len(shared),
        "summary": {"groups": len(gids), "statements": len(sts),
                    "member_facets": len(triples), "members": len(member_ids),
                    "rows_on_the_group_entity": group_rows_total,
                    "rows_of_the_membership_statement": statement_rows_total,
                    "token_rows_on_the_membership_statement": on_stmt,
                    "owner_is_a_member": owner in member_ids,
                    "confidences": sorted({s["confidence"] for s in sts}),
                    "sources": sorted({n for s in sts
                                       for n in vocab.source_names(s["sources"])}),
                    "asserted": max((s["asserted"] for s in sts), default=None),
                    "named": any(names.get(g) for g in gids)},
    })
    return out


def _owner_component(conn, cuts):
    owner = vocab.owner_id()
    if owner is None:
        return _unknown("owner", cuts, "this bundle flags no current user")
    kin, _bands = _kinship()
    known = {p["eid"]: p for p in _universe(conn, kin, owner, cuts["closeness"])}
    row = known.get(owner) or {"eid": owner, "facts": 0, "stable_refs": 0,
                               "event_refs": 0, "is_owner": 1}
    mem = _person_members(conn, [row], _volume())
    label = mem[0]["label"] if mem else None

    triples = []
    for r in _rows(conn, "SELECT subject, object, confidence, sources, timestamp "
                         "FROM stable_graph WHERE predicate=?", (vocab.OWNER_PREDICATE,)):
        triples.append({"subject": vocab.sid(r["subject"]), "subject_label": label,
                        "predicate": vocab.plabel(vocab.OWNER_PREDICATE),
                        "predicate_code": vocab.OWNER_PREDICATE,
                        "object": r["object"], "object_id": None, "object_ref": None,
                        "statement_class": None, "facet": None,
                        "confidence": r["confidence"],
                        "sources": vocab.source_names(r["sources"]),
                        "source_mask": r["sources"],
                        "asserted": db.apple_time(r["timestamp"]), "extra_facets": []})

    attendance, _days = _attendance(conn)
    text = ("Not a cluster and not a rule: the single entity the store flags as the "
            "current user. It is held out of the calendar clustering on purpose: it is "
            "on so many invitations that including it would join the circles through "
            "it and flatten the layout into a star.")
    out = _shell("owner", label, "stored", "graph", text,
                 {"predicate": vocab.OWNER_PREDICATE, "excluded_from_clustering": True,
                  "jaccard": cuts["jaccard"]}, is_component=False)
    out["members"] = mem
    out["triples"] = triples
    out["evidence"].update({
        "kind": "none",
        "note": "the assertion itself is the evidence: one triple, with the sources "
                "that agreed on it decoded below.",
        "summary": {"events_attended": len(attendance.get(owner, ())),
                    "facts": row.get("facts", 0),
                    "referenced_by": row.get("stable_refs", 0) + row.get("event_refs", 0),
                    "sources": sorted({n for t in triples for n in t["sources"]})},
    })
    return out


def component(params):
    """One cluster, opened: what it is, who is in it, and what put them there."""
    key = (params.get("key") or "").strip()
    cuts = _cuts(params)
    conn = db.connect(GRAPH)
    if conn is None:
        out = _unknown(key, cuts, "the graph store is not in this bundle")
        out["rule"]["params"] = dict(cuts)
        return out

    if key.startswith("circle:"):
        out = _circle_component(conn, key, cuts)
    elif key.startswith("chat:"):
        out = _chat_component(key, cuts)
    elif key in ("employer", "employee"):
        out = _employment_component(conn, key, cuts)
    elif key == "explicit":
        out = _group_component(conn, cuts)
    elif key == "owner":
        out = _owner_component(conn, cuts)
    elif key == "solo":
        out = _solo_component(conn, cuts)
    elif key == "unplaced":
        out = _unplaced_component(conn, cuts)
    elif key == "solo_chat":
        out = _solo_chat_component(cuts)
    else:
        out = _unknown(key, cuts, "no cluster on this page carries that key")

    out["requested_key"] = key
    out["cuts"] = cuts
    return out


ROUTES = {"/api/social": handler,
          "/api/social/node": detail,
          "/api/social/component": component}
