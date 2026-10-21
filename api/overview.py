"""overview.py — everything the landing page needs, counted live.

This endpoint is the only one the app shell itself depends on: `app.js` reads
`captured` and `triples` from it for the sidebar subtitle before any page
renders. Everything else here answers one question — what is actually in this
file — and it answers it by counting, never by remembering.

Four measurements on this page are not lookups but small experiments run at
request time, because the claim they support is the whole thesis of the app and
a claim that important should not be inherited from a document:

  * every `cnContact:` reference is tested against the AddressBook stores on
    this Mac;
  * every Photos face cluster's plaintext UUID is tested against Photos.sqlite;
  * every `lsBundleRecord:` token is re-derived as base64(sha256(bundle id));
  * every calendar token is tested verbatim against every short text value in
    the local Calendar store — a negative, and the page says so.

The closing panel is the correction the rest of the app has to live with: the
identity join is real, and on this device it is also sparse.
"""

import base64
import hashlib
from datetime import datetime, timezone

from . import db, vocab

GRAPH = "graph/graph.db"
TAGGING = "graph/Artifacts__entityTagging__entityTagging.db"
REMEMBERS = "graph/Artifacts__siri__remembers__view.db"
VIEWS = "graph/views.db"

LIVE_LAYERS = ("stable_graph", "event_graph")
EXPIRED_LAYERS = ("expired_stable_graph", "expired_event_graph")

PERSON_CLASS = "SB104"

# A handle that arrives without a URI scheme is still a handle. These are the
# two contact-information facets that carry one; `vocab.NAMESPACES` cannot see
# them because they are bare literals, so they get their own bucket and the
# page labels it as such rather than pretending it is a namespace.
HANDLE_FACETS = {"PS407": "phone number", "PS406": "mail address"}
HANDLE_KEY = "handle"

# The order the join panel reads in: who they are, how to reach them, what they
# look like, who they live with, where they will be, what they run.
NS_ORDER = ["cnContact", HANDLE_KEY, "tel", "mailto", "phPerson", "faFamilyCircle",
            "ekEvent", "sgEvent", "sgContact", "inPerson", "lsBundleRecord",
            "https", "http", "md", "association"]


# ---------------------------------------------------------------- helpers

def _day(unix):
    if unix is None:
        return None
    return datetime.fromtimestamp(unix, timezone.utc).strftime("%Y-%m-%d")


def _count(table):
    return db.one(GRAPH, f"select count(*) from {table}", (), 0) or 0


def _ns_key(relationship_predicate, obj):
    """The bucket one object value belongs to: an allowlisted namespace head,
    the bare-handle bucket, or None for a literal. Never a ':' split."""
    ns = vocab.ns_of(obj)
    if ns:
        return ns
    if relationship_predicate in HANDLE_FACETS and obj:
        return HANDLE_KEY
    return None


def _display_name(entity_id):
    """The documented fallback chain, ordered by confidence.

    `vocab.name_of` takes whichever row SQLite hands back first, and two
    subjects in this store carry two `PS33` rows — for the owner those are a
    display name and a login-shaped handle. Ordering by confidence, then by
    length, picks the same string a human would.
    """
    rows = db.query(GRAPH, """
        select predicate, relationshipPredicate, object, confidence from stable_graph
        where subject = ? and (predicate in ('PS33','PS312','PS441')
                               or relationshipPredicate = 'PS89')""", (entity_id,))
    def best(pick):
        got = [r for r in rows if pick(r) and r["object"]]
        got.sort(key=lambda r: (-(r["confidence"] or 0), -len(r["object"])))
        return got[0]["object"] if got else None

    name = best(lambda r: r["predicate"] == "PS33")
    variants = len({r["object"] for r in rows if r["predicate"] == "PS33"})
    if not name:
        first = best(lambda r: r["predicate"] == "PS312")
        family = best(lambda r: r["predicate"] == "PS441")
        name = (" ".join(x for x in (first, family) if x)) or None
    if not name:
        name = best(lambda r: r["relationshipPredicate"] == "PS89")
    return name, variants


def _graph_state():
    out = {}
    for row in db.query(GRAPH, "select key, value from graph_state"):
        try:
            out[row["key"]] = float(row["value"])
        except (TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------- the store

def _captured(state):
    """The sidebar subtitle's left half. graph_state first, triples as backstop."""
    if "buildFromScratchTimestamp" in state:
        return "built " + _day(db.apple_time(state["buildFromScratchTimestamp"]))
    if state:
        return "written " + _day(db.apple_time(max(state.values())))
    last = db.one(GRAPH, "select max(timestamp) from stable_graph")
    return ("last write " + _day(db.apple_time(last))) if last else "store present"


def _class_census():
    rows = db.query(GRAPH, """
        select object as class_code, count(distinct subject) as entities from (
            select subject, object from stable_graph where predicate='PS1' and relationshipId=0
            union all
            select subject, object from event_graph where predicate='PS1' and relationshipId=0)
        group by 1 order by entities desc""")
    return [{"code": r["class_code"], "label": vocab.clabel(r["class_code"]),
             "entities": r["entities"]} for r in rows]


def _counts():
    stable = _count("stable_graph")
    event = _count("event_graph")
    census = _class_census()
    by_class = {c["code"]: c["entities"] for c in census}
    return {
        "stable": stable,
        "event": event,
        "triples": stable + event,
        "expired": sum(_count(t) for t in EXPIRED_LAYERS),
        "entities": sum(c["entities"] for c in census),
        "census": census,
        "persons": by_class.get(PERSON_CLASS, 0),
        "apps": by_class.get("SB144", 0),
        "events": by_class.get("SB472", 0),
        "owner_rows": db.one(
            GRAPH, "select count(*) from stable_graph where predicate=?",
            (vocab.OWNER_PREDICATE,), 0) or 0,
        "below_certain": (db.one(GRAPH, "select count(*) from stable_graph where confidence < 1.0", (), 0) or 0)
                         + (db.one(GRAPH, "select count(*) from event_graph where confidence < 1.0", (), 0) or 0),
        "statements": (db.one(GRAPH, "select count(distinct relationshipId) from stable_graph where relationshipId<>0", (), 0) or 0)
                      + (db.one(GRAPH, "select count(distinct relationshipId) from event_graph where relationshipId<>0", (), 0) or 0),
    }


# ------------------------------------------------------- resolution probes

def _have(rel):
    with db.probe():
        return db.connect(rel) is not None


def _address_book_hits(refs):
    """How many `cnContact:` references exist verbatim in the AddressBook stores.

    The ':ABPerson' suffix is present on both sides and is not stripped.
    """
    stores = db.address_books()
    if not refs or not stores:
        return set(), len(refs), bool(stores)
    values = sorted(refs)
    placeholders = ",".join("?" * len(values))
    seen = set()
    for _, rel in stores:
        try:
            with db.probe():
                rows = db.query(rel, f"select ZUNIQUEID as uid from ZABCDRECORD "
                                     f"where ZUNIQUEID in ({placeholders})", tuple(values))
        except Exception:
            continue
        seen.update(r["uid"] for r in rows)
    return seen, len(values), True


def _photos_person(uuids):
    """Photos face clusters that resolve to a ZPERSON row, and their face counts."""
    if not uuids or not _have("sources/Photos.sqlite"):
        return {}, len(uuids), False
    values = sorted(uuids)
    placeholders = ",".join("?" * len(values))
    try:
        with db.probe():
            rows = db.query("sources/Photos.sqlite",
                            f"select ZPERSONUUID as uuid, ZFACECOUNT as faces, "
                            f"(ZFULLNAME is not null) as named from ZPERSON "
                            f"where ZPERSONUUID in ({placeholders})", tuple(values))
    except Exception:
        return {}, len(values), False
    return {r["uuid"]: r for r in rows}, len(values), True


def _app_token_proof():
    """Re-derive every app token from its own bundle id. 100% here means the
    scheme is an unsalted digest: pseudonymous, not anonymous."""
    rows = db.query(GRAPH, """
        select a.object as token, b.object as bundle_id
        from stable_graph a join stable_graph b on a.subject = b.subject
        where a.predicate='PS102' and a.object like 'lsBundleRecord:%'
          and b.predicate='nm_bundleID'""")
    ok = 0
    for r in rows:
        digest = base64.b64encode(hashlib.sha256(r["bundle_id"].encode("utf-8")).digest())
        if digest.decode("ascii").rstrip("=") == r["token"].split(":", 1)[1].rstrip("="):
            ok += 1
    return ok, len(rows)


def _calendar_values():
    """Every short text value in the local Calendar store, read once."""
    conn = db.connect("sources/Calendar.sqlitedb")
    if conn is None:
        return None
    values = set()
    try:
        tables = [r[0] for r in conn.execute(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    except Exception:
        return None
    for table in tables:
        try:
            for row in conn.execute(f'select * from "{table}"'):
                for cell in row:
                    if isinstance(cell, str) and 4 < len(cell) < 200:
                        values.add(cell)
        except Exception:
            continue
    return values


def _calendar_token_probe(tokens, values):
    """Test calendar tokens verbatim against that pool. A bounded negative,
    reported as one: it says what was searched, not merely that nothing was
    found."""
    if values is None:
        return {"tested": len(tokens), "values": 0, "hits": 0, "ran": False}
    return {"tested": len(tokens), "values": len(values),
            "hits": len(set(tokens) & values), "ran": True}


def _chat_handle_probe(handles):
    """Bare handles against the local chat.db store. The yield is the finding."""
    if not handles or not db.has_table("sources/chat.db", "handle"):
        return {"matched": 0, "tested": len(handles), "pool": 0, "ran": False}
    pool = {(r["id"] or "").lower() for r in db.query("sources/chat.db", "select id from handle")}
    matched = sum(1 for h in handles if h.lower() in pool)
    return {"matched": matched, "tested": len(handles), "pool": len(pool), "ran": True}


# ---------------------------------------------------------- namespace census

def _object_scan():
    """One pass over every live object, bucketed by allowlisted namespace.

    Returns per-namespace occurrence counts, the distinct reference values, and
    the per-person namespace sets that the join panel is picked from.
    """
    persons = {r["subject"] for r in db.query(
        GRAPH, "select subject from stable_graph where predicate='PS1' and object=?", (PERSON_CLASS,))}

    occurrences, refs = {}, {}
    per_person = {}
    decoys = 0          # objects that contain a colon and are not references
    for layer in LIVE_LAYERS:
        for row in db.query(GRAPH, f"select subject, relationshipPredicate, object from {layer}"):
            key = _ns_key(row["relationshipPredicate"], row["object"])
            if key is None:
                if isinstance(row["object"], str) and ":" in row["object"]:
                    decoys += 1
                continue
            occurrences[key] = occurrences.get(key, 0) + 1
            refs.setdefault(key, set()).add(row["object"])
            if layer == "stable_graph" and row["subject"] in persons:
                per_person.setdefault(row["subject"], set()).add(key)
    return persons, occurrences, refs, per_person, decoys


def _islands(persons):
    """How many people resolve into how many external namespaces. The honest
    correction the whole app leads with, bucketed exactly as measured."""
    pretty = {"cnContact": "Contacts", "phPerson": "Photos face cluster",
              "sgContact": "Suggestions", "inPerson": "Intents",
              "faFamilyCircle": "Family Sharing"}
    per = {}
    for r in db.query(GRAPH, "select subject, object from stable_graph where predicate='PS102'"):
        if r["subject"] not in persons:
            continue
        ns = vocab.ns_of(r["object"])
        if ns in pretty:
            per.setdefault(r["subject"], set()).add(ns)

    counted = {}
    for pid in persons:
        got = per.get(pid, set())
        if not got:
            key = "no external namespace"
        elif len(got) > 1:
            key = "two or more namespaces"
        else:
            key = pretty[next(iter(got))] + " only"
        counted[key] = counted.get(key, 0) + 1

    buckets = sorted(({"label": k, "people": v} for k, v in counted.items()),
                     key=lambda b: -b["people"])
    if len(buckets) > 6:                      # a stacked bar holds six segments
        head, tail = buckets[:5], buckets[5:]
        buckets = head + [{"label": "other combinations", "people": sum(b["people"] for b in tail)}]

    return {
        "people": len(persons),
        "buckets": buckets,
        "multi": counted.get("two or more namespaces", 0),
        "none": counted.get("no external namespace", 0),
        "multi_in_circle": sum(1 for v in per.values() if len(v) > 1 and "faFamilyCircle" in v),
        "contacts_and_photos": sum(1 for s in per.values() if {"cnContact", "phPerson"} <= s),
    }


# ------------------------------------------------------------- the join panel

def _tail(ns, value):
    """The part of a reference a source store keys on: the value after the
    namespace head, and for a Photos localIdentifier the UUID before its '/L0/'
    suffix — the suffix is why an earlier pass scored this join 0 of 90."""
    tail = value.split(":", 1)[1] if ":" in value else value
    return tail.split("/")[0] if ns == "phPerson" else tail


def _backlinks(entity_id):
    """Who points AT this entity, by predicate — the calendar half of the join."""
    ref = "md:%d" % entity_id
    out = []
    for layer in LIVE_LAYERS:
        for row in db.query(GRAPH, f"""
                select predicate, relationshipPredicate, count(*) as rows_,
                       count(distinct subject) as subjects
                from {layer} where object = ? group by 1, 2 order by rows_ desc""", (ref,)):
            out.append({
                "layer": layer,
                "predicate": row["predicate"],
                "label": vocab.plabel(row["predicate"]),
                "facet": row["relationshipPredicate"] or None,
                "rows": row["rows_"],
                "subjects": row["subjects"],
            })
    return out


def _entity_card(entity_id, role, resolvers, resolved):
    """One person, expanded into every namespace their rows actually reach.

    Built from `vocab.statements()` so reified facets arrive whole: a contact
    statement carries its handle and its Apple label together, a visual
    identifier carries its plaintext UUID and the reason the link was made.
    """
    statements = vocab.statements("stable_graph", subject=entity_id)
    groups = {}

    def add(key, entry):
        groups.setdefault(key, []).append(entry)

    for st in statements:
        if st["facets"]:
            for facet, value in st["facets"].items():
                if facet == "PS1":
                    continue
                key = _ns_key(facet, value)
                if key is None:
                    continue
                add(key, {
                    "predicate": st["predicate"], "label": st["label"],
                    "facet": facet, "facet_label": vocab.plabel(facet),
                    "value": value, "confidence": st["confidence"],
                    "sources": vocab.source_names(st["sources"]),
                })
        else:
            key = _ns_key("", st["object"])
            if key is None:
                continue
            add(key, {
                "predicate": st["predicate"], "label": st["label"],
                "facet": None, "facet_label": None,
                "value": st["object"], "confidence": st["confidence"],
                "sources": vocab.source_names(st["sources"]),
            })

    def resolution(key, rows):
        """Prefer the result for these exact rows over the store-wide rate."""
        pool = resolved.get(key)
        if pool is None:
            return resolvers.get(key, {}).get("row_note")
        hit = sum(1 for r in rows if _tail(key, r["value"]) in pool)
        where = "the address book" if key == "cnContact" else "the photo library"
        verb = "exists" if hit == 1 else "exist"
        return (f"{hit} of {len(rows)} {verb} verbatim in {where} on this Mac — tested just now"
                if hit else f"none of these {len(rows)} resolve in {where} on this Mac")

    ordered = []
    for key in NS_ORDER:
        if key not in groups:
            continue
        kind, desc = vocab.NAMESPACES.get(key, ("handle", "a bare phone or mail handle, no scheme"))
        ordered.append({
            "ns": key,
            "kind": kind,
            "desc": desc,
            "rows": groups[key],
            "resolution": resolution(key, groups[key]),
        })
    for key in sorted(k for k in groups if k not in NS_ORDER):
        kind, desc = vocab.NAMESPACES.get(key, ("handle", "a bare handle"))
        ordered.append({"ns": key, "kind": kind, "desc": desc,
                        "rows": groups[key], "resolution": None})

    class_code = db.one(GRAPH, "select object from stable_graph where subject=? and "
                               "predicate='PS1' and relationshipId=0", (entity_id,))
    name, name_variants = _display_name(entity_id)
    return {
        "role": role,
        "id": vocab.sid(entity_id),
        "name": name,
        "name_variants": name_variants,
        "class_code": class_code,
        "class_label": vocab.clabel(class_code) if class_code else None,
        "facts": db.one(GRAPH, "select count(*) from stable_graph where subject=?", (entity_id,), 0),
        "statements": sum(1 for s in statements if s["rid"]),
        "namespaces": ordered,
        "backlinks": _backlinks(entity_id),
    }


def _pick_pair(persons, per_person):
    """The owner, and the person whose rows reach the most namespaces.

    Ties break on the number of namespaces, then on how much the store holds
    about them, then on the id — so the pick is stable between requests.
    """
    owner = vocab.owner_id()
    facts = {r["subject"]: r["n"] for r in db.query(
        GRAPH, "select subject, count(*) as n from stable_graph group by 1")}
    candidates = [p for p in persons if p != owner]
    if not candidates:
        return owner, None
    peer = max(candidates, key=lambda p: (len(per_person.get(p, ())), facts.get(p, 0), p))
    return owner, peer


# ------------------------------------------------------------- the page index

def _index(counts, islands):
    """One live headline number per page, so the first screen is the contents."""
    social = db.one(GRAPH, """
        select count(*) from (
          select distinct cast(substr(object,4) as integer) as pid from event_graph
            where predicate in ('PS232','PS578') and relationshipPredicate='PS143'
          union select distinct cast(substr(object,4) as integer) from event_graph where predicate='PS580'
          union select distinct cast(substr(object,4) as integer) from stable_graph
            where predicate='PS753' and relationshipPredicate='PS566'
          union select subject from stable_graph where predicate=?)""",
        (vocab.OWNER_PREDICATE,), 0) or 0
    pairs = db.one(GRAPH, """
        select count(*) from (
          select a.object, b.object from event_graph a join event_graph b
            on a.subject=b.subject and a.object < b.object
          where a.predicate='PS232' and a.relationshipPredicate='PS143'
            and b.predicate='PS232' and b.relationshipPredicate='PS143'
          group by 1,2)""", (), 0) or 0
    scored = db.one(TAGGING, "select count(*) from entity_tagging", (), 0) or 0
    family = db.one(TAGGING, "select count(*) from entity_tagging where family >= 0.5", (), 0) or 0
    interactions = db.one(REMEMBERS, "select count(*) from interactions", (), 0) or 0
    apps_in_comms = db.one(REMEMBERS, "select count(distinct bundleId) from interactions", (), 0) or 0
    faces = db.one(GRAPH, "select count(distinct object) from stable_graph "
                          "where relationshipPredicate='nm_visualIdentifier'", (), 0) or 0
    named_faces = db.one(GRAPH, """
        select count(distinct v.subject) from stable_graph v
        where v.relationshipPredicate='nm_visualIdentifier'
          and exists (select 1 from stable_graph n where n.subject=v.subject and n.predicate='PS33')""", (), 0) or 0
    views = db.one(VIEWS, "select count(*) from viewConfigRecord", (), 0) or 0
    streams = db.one(VIEWS, "select count(*) from viewConfigRecord where writeToStream <> 0", (), 0) or 0
    descriptions = db.one(GRAPH, "select sum(length(object)) from event_graph where predicate='PS51'", (), 0) or 0

    return [
        {"page": "social", "value": social,
         "caption": f"people on calendar events or in the stored group; {pairs:,} pairs invited to the same event (iKnow's count)"},
        {"page": "kinship", "value": scored,
         "caption": f"people with a row in the relationship scorecard — {family} at or above 0.5 on family (iKnow's cut)"},
        {"page": "comms", "value": interactions,
         "caption": f"interactions logged across {apps_in_comms} apps, and not one word of message text"},
        {"page": "identity", "value": islands["multi"],
         "caption": f"of {islands['people']} people carry references into two or more external namespaces"},
        {"page": "calendar", "value": counts["events"],
         "caption": f"calendar events, carrying {descriptions:,} characters of description text"},
        {"page": "faces", "value": faces,
         "caption": f"Photos face clusters the graph references — {named_faces} of them on an entity with a name"},
        {"page": "retractions", "value": counts["expired"],
         "caption": "withdrawn rows the graph still keeps, with their last confidence, until a prune removes them"},
        {"page": "certainty", "value": counts["below_certain"],
         "caption": f"of {counts['triples']:,} live facts carry a confidence below 1.0"},
        {"page": "exposure", "value": views,
         "caption": f"view configurations in the platform's control plane; {streams} of them publish to a stream"},
        {"page": "device", "value": counts["apps"],
         "caption": "installed apps the graph records by bundle id, with a token iKnow re-derives by hashing that id"},
        {"page": "overview", "value": counts["triples"],
         "caption": "facts in the person and calendar layers — the file itself, by entity type and by namespace"},
    ]


# ----------------------------------------------------------------- handler

def handler(params):
    state = _graph_state()
    counts = _counts()
    persons, occurrences, refs, per_person, decoys = _object_scan()
    islands = _islands(persons)

    # --- the four resolution experiments, run now, against the real sources ---
    contact_refs = {o.split(":", 1)[1] for o in refs.get("cnContact", ())}
    contact_hits, contact_total, have_address_book = _address_book_hits(contact_refs)
    resolved = {"cnContact": contact_hits}

    face_uuids = {r["object"].split("/")[0] for r in db.query(
        GRAPH, "select object from stable_graph where relationshipPredicate='nm_visualIdentifier'")}
    photos, face_total, have_photos = _photos_person(face_uuids)

    app_ok, app_total = _app_token_proof()

    # the calendar tokens, tested per namespace so neither number stands in
    # for the other
    calendar = {}
    calendar_pool = _calendar_values()
    for key in ("ekEvent", "sgEvent"):
        tokens = {o.split(":", 1)[1] for o in refs.get(key, ())}
        probe = _calendar_token_probe(tokens, calendar_pool)
        probe["events"] = db.one(GRAPH, "select count(distinct subject) from event_graph "
                                        "where predicate='PS102' and object like ?",
                                 (key + ":%",), 0) or 0
        calendar[key] = probe

    # every reachable handle the store holds: the bare contact facets plus the
    # two URI namespaces, stripped of their scheme
    handle_values = {r["object"] for r in db.query(
        GRAPH, "select object from stable_graph where relationshipPredicate in ('PS406','PS407')")}
    for key in ("tel", "mailto"):
        handle_values |= {o.split(":", 1)[1] for o in refs.get(key, ())}
    chat = _chat_handle_probe(handle_values)

    conference = db.one(GRAPH, "select count(distinct object) from event_graph "
                               "where predicate='nm_virtualConferenceURL'", (), 0) or 0
    url_total = len(refs.get("https", set()) | refs.get("http", set()))

    md_targets = db.query(GRAPH, """
        select count(*) as total, sum(live) as live from (
          select distinct t, (t in (select subject from stable_graph union
                                    select subject from event_graph)) as live from (
            select cast(substr(object,4) as integer) as t from stable_graph where object like 'md:%'
            union select cast(substr(object,4) as integer) from event_graph where object like 'md:%'))""")
    md_targets = md_targets[0] if md_targets else {"total": 0, "live": 0}

    handle_note = (f"{chat['matched']} of {chat['tested']} handles also appear in the local chat.db "
                   f"store, which holds {chat['pool']}; the handles here are plaintext and dialable "
                   f"exactly as stored"
                   if chat["ran"] else "plaintext, dialable and mailable exactly as stored")

    resolvers = {
        "cnContact": {
            "verdict": "resolves" if have_address_book else "not tested",
            "note": (f"{len(contact_hits)} of {contact_total} references exist verbatim in the AddressBook "
                     f"stores on this Mac, ':ABPerson' suffix and all" if have_address_book else
                     f"{contact_total} distinct references, and no AddressBook store in this bundle "
                     f"to test them against"),
            "row_note": "tested against AddressBook now" if have_address_book else "no AddressBook here to test",
        },
        "phPerson": {
            "verdict": "resolves" if have_photos else "not tested",
            "note": (f"{len(photos)} of {face_total} face clusters resolve to a Photos person row — "
                     f"through the plaintext UUID beside the token, not the token itself" if have_photos
                     else f"{face_total} face clusters, and no Photos library in this bundle to test "
                          f"them against"),
            "row_note": "tested against Photos.sqlite now" if have_photos else "no Photos store here to test",
        },
        "lsBundleRecord": {
            "verdict": "derived",
            "note": f"{app_ok} of {app_total} tokens re-derive as base64(sha256(bundle id)) — "
                    f"unsalted, so the scheme defeats browsing, not guessing",
            "row_note": "re-derived from its own bundle id",
        },
        "md": {
            "verdict": "resolves",
            "note": f"{md_targets['live']} of {md_targets['total']} reference targets are a live entity "
                    f"in this store",
            "row_note": "an entity in this same file",
        },
        HANDLE_KEY: {"verdict": "plaintext", "note": handle_note,
                     "row_note": "plaintext, dialable as stored"},
        "tel": {"verdict": "plaintext", "note": handle_note, "row_note": "plaintext, dialable as stored"},
        "mailto": {"verdict": "plaintext", "note": handle_note, "row_note": "plaintext, as stored"},
        "https": {
            "verdict": "plaintext",
            "note": f"{conference} of {url_total} distinct URLs are stored as a calendar event's "
                    f"video-call link, whole",
            "row_note": "a stored link",
        },
        "faFamilyCircle": {"verdict": "opaque", "note": None,
                           "row_note": "opaque token, shared across the circle"},
        "association": {"verdict": "not a reference", "note": None,
                        "row_note": "a stated reason, not a reference"},
        "sgContact": {
            "verdict": "not tested",
            "note": "an opaque Suggestions token; this page runs no probe against it",
            "row_note": "opaque token",
        },
    }
    resolvers["http"] = dict(resolvers["https"])
    resolvers["inPerson"] = dict(resolvers["sgContact"])
    resolvers["inPerson"]["note"] = "an opaque Intents token; this page runs no probe against it"

    for key, label in (("ekEvent", "EventKit"), ("sgEvent", "Suggestions")):
        probe = calendar[key]
        resolvers[key] = {
            "verdict": "in-store only",
            "note": f"names one of the {probe['events']} {label} event entities inside this same file"
                    + (f"; {probe['hits']} of {probe['tested']} tokens appear among the "
                       f"{probe['values']:,} short text values in the local Calendar store"
                       if probe["ran"] else "; no Calendar store in this bundle to test it against"),
            "row_note": "resolves inside this file" + (", not into Calendar" if probe["ran"] else ""),
        }

    circle_tokens = refs.get("faFamilyCircle", set())
    circle_entities = db.one(GRAPH, "select count(distinct subject) from stable_graph "
                                    "where object like 'faFamilyCircle:%'", (), 0) or 0
    resolvers["faFamilyCircle"]["note"] = (
        f"{len(circle_tokens)} distinct token{'' if len(circle_tokens) == 1 else 's'} across "
        f"{circle_entities} entities; iKnow does not resolve it. Entities that share a token are in the "
        f"same Family Sharing circle, by iKnow's reading")
    assoc_rows = occurrences.get("association", 0)
    resolvers["association"]["note"] = (
        f"{len(refs.get('association', ()))} distinct values over {assoc_rows} rows — an enum of "
        f"reasons that happens to contain a colon, not a namespace")

    owner_id, peer_id = _pick_pair(persons, per_person)
    resolved["phPerson"] = set(photos)
    cards = []
    if owner_id is not None:
        cards.append(_entity_card(owner_id, "owner", resolvers, resolved))
    if peer_id is not None:
        cards.append(_entity_card(peer_id, "widest", resolvers, resolved))

    shared = []
    if len(cards) == 2:
        def values(card):
            return {(g["ns"], r["value"]) for g in card["namespaces"] for r in g["rows"]}
        for ns, value in sorted(values(cards[0]) & values(cards[1])):
            shared.append({"ns": ns, "value": value})

    ledger = []
    for key in NS_ORDER + sorted(k for k in occurrences if k not in NS_ORDER):
        if key not in occurrences:
            continue
        kind, desc = vocab.NAMESPACES.get(key, ("handle", "a bare phone or mail handle, no scheme"))
        info = resolvers.get(key, {})
        ledger.append({
            "ns": key,
            "kind": kind,
            "desc": desc,
            "occurrences": occurrences[key],
            "distinct": len(refs.get(key, ())),
            "verdict": info.get("verdict", "untested"),
            "note": info.get("note") or "nothing in this bundle was tested against it here",
            "on_owner": bool(cards) and any(g["ns"] == key for g in cards[0]["namespaces"]),
            "on_peer": len(cards) > 1 and any(g["ns"] == key for g in cards[1]["namespaces"]),
        })

    faces_for_cards = {}
    for card in cards:
        for group in card["namespaces"]:
            if group["ns"] != "phPerson":
                continue
            for row in group["rows"]:
                uuid = row["value"].split(":", 1)[1].split("/")[0]
                hit = photos.get(uuid)
                if hit:
                    faces_for_cards[row["value"]] = {"faces": hit["faces"], "named": bool(hit["named"])}

    return {
        # the two fields app.js reads for the sidebar
        "captured": _captured(state),
        "triples": counts["triples"],

        "store": {
            "stable": counts["stable"],
            "event": counts["event"],
            "expired": counts["expired"],
            "entities": counts["entities"],
            "statements": counts["statements"],
            "owner_rows": counts["owner_rows"],
            "owner_id": vocab.sid(owner_id),
            "built": _day(db.apple_time(state["buildFromScratchTimestamp"]))
                     if "buildFromScratchTimestamp" in state else None,
            "pruned": _day(db.apple_time(state["expiredTriplesPruneTimestamp"]))
                      if "expiredTriplesPruneTimestamp" in state else None,
            "last_write": _day(db.apple_time(db.one(GRAPH, "select max(timestamp) from stable_graph"))),
            "census": counts["census"],
        },
        "join": {
            "cards": cards,
            "shared": shared,
            "photos": faces_for_cards,
            "calendar_probe": calendar,
        },
        "ledger": ledger,
        "decoys": decoys,
        "islands": islands,
        "index": _index(counts, islands),
    }


ROUTES = {"/api/overview": handler}
