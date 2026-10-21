"""vocab.py — the decoder ring.

The store speaks in opaque ids: predicate `PS33`, class `SB104`, object
`md:` followed by an 18-digit entity id. Everything human about this app comes
from decoding those against the ontology Apple ships alongside the graph.

Three traps this module exists to close, all of them measured rather than
assumed:

1. **Never detect a namespace by splitting on ':'.** 118 stable and 1,167 event
   objects contain a colon and are not references — calendar descriptions,
   serialised JSON dates, URLs. Namespace detection is an allowlist head test.

2. **Entity ids are 64-bit and routinely exceed 2^53.** They must reach the
   browser as strings or JavaScript silently rounds them and joins break.

3. **Reification.** A row with `relationshipId = 0` and an empty
   `relationshipPredicate` is a plain attribute. A row with a non-zero
   `relationshipId` is one *facet* of a blank-node statement, and the facets of
   one statement must be collapsed before they mean anything.
"""

import json
import os
import threading

from . import db

_lock = threading.Lock()
_vocab = None

# The namespace allowlist. A reference is recognised by its head against this
# table and nothing else — never by the presence of a colon.
NAMESPACES = {
    "md": ("entity", "another entity in this same graph"),
    "cnContact": ("contact", "a Contacts record — resolves to ZABCDRECORD"),
    "phPerson": ("face", "a Photos face cluster — plaintext <UUID>/L0/nnn"),
    "ekEvent": ("event", "an EventKit event — a base64 token"),
    "sgEvent": ("event", "a Suggestions event (opaque)"),
    "sgContact": ("contact", "a Suggestions contact (opaque)"),
    "inPerson": ("person", "an Intents person (opaque)"),
    "lsBundleRecord": ("app", "an installed app — base64(sha256(bundle id))"),
    "faFamilyCircle": ("family", "a Family Sharing circle (opaque)"),
    "association": ("reason", "a stated association reason"),
    "tel": ("uri", "a telephone URI"),
    "mailto": ("uri", "a mail URI"),
    "https": ("uri", "a web URL"),
    "http": ("uri", "a web URL"),
}

# Predicates that carry a display name, in the order we prefer them. kg.py has a
# latent bug here — both branches of its if/else do the same setdefault, so
# whichever row SQLite returns first wins. We order explicitly instead.
NAME_PREDICATES = ("PS33", "PS312", "PS441")

OWNER_PREDICATE = "nm_isCurrentUser"


def _load():
    global _vocab
    with _lock:
        if _vocab is not None:
            return _vocab
        preds, classes = {}, {}
        try:
            with open(os.path.join(db.ONTOLOGY_DIR, "predicate.json")) as fh:
                for p in json.load(fh)["predicates"]:
                    preds[p["predicateId"]] = p
        except (OSError, ValueError, KeyError):
            pass
        try:
            with open(os.path.join(db.ONTOLOGY_DIR, "class.json")) as fh:
                for c in json.load(fh)["classes"]:
                    classes[c["classId"]] = c.get("label", c["classId"])
        except (OSError, ValueError, KeyError):
            pass
        _vocab = {"predicates": preds, "classes": classes}
        return _vocab


def plabel(pid):
    """'PS33' -> 'name'. Falls back to the raw id when the ontology lacks it."""
    p = _load()["predicates"].get(pid)
    return p.get("label", pid) if p else pid


def ptype(pid):
    p = _load()["predicates"].get(pid)
    return p.get("subjectType", "") if p else ""


def clabel(cid):
    return _load()["classes"].get(cid, cid)


def predicates():
    return _load()["predicates"]


def classes():
    return _load()["classes"]


def ns_of(obj):
    """The namespace head of an object, or None if it is a literal.

    Allowlist only. `"Lunch: 12:30"` is a literal, not the `Lunch` namespace.
    """
    if not isinstance(obj, str):
        return None
    head, sep, _ = obj.partition(":")
    if not sep:
        return None
    return head if head in NAMESPACES else None


def entity_ref(obj):
    """`md:123…` -> the integer id it points at, else None.

    References are always the literal text `md:` + digits; a bare integer is
    never an entity reference.
    """
    if not isinstance(obj, str) or not obj.startswith("md:"):
        return None
    tail = obj[3:]
    try:
        return int(tail)
    except ValueError:
        return None


def sid(value):
    """Entity id -> string, for JSON. 64-bit ids lose precision as JS numbers."""
    return None if value is None else str(value)


def decode(obj, predicate=""):
    """-> {kind, text, entity} for one object value.

    `kind` is one of: literal, date, entity, or a namespace key. Pass the
    predicate — 886 of 11,915 rows decode to a different kind without it,
    because date coercion is driven by the predicate's declared subject type.
    """
    if obj is None:
        return {"kind": "literal", "text": "", "entity": None}

    ns = ns_of(obj)
    if ns == "md":
        return {"kind": "entity", "text": obj, "entity": sid(entity_ref(obj))}
    if ns:
        return {"kind": ns, "text": obj, "entity": None}

    if ptype(predicate) == "dateTime":
        return {"kind": "date", "text": str(obj), "entity": None}

    return {"kind": "literal", "text": str(obj), "entity": None}


# ---------------------------------------------------------------- names

_names_cache = {}
_names_lock = threading.Lock()


def names(layer="stable_graph"):
    """{entity id (int) -> display name}. Built once per process, per layer.

    117 of 866 entities carry no name at all (101 persons, 15 places, the one
    group). Callers must handle a missing name rather than inventing one.
    """
    with _names_lock:
        if layer in _names_cache:
            return _names_cache[layer]

    out = {}
    # Walk the preferred predicates in reverse so the most-preferred wins.
    for pid in reversed(NAME_PREDICATES):
        for row in db.query(
            "graph/graph.db",
            f"select subject, object from {layer} where predicate = ? and object <> ''",
            (pid,),
        ):
            out[row["subject"]] = row["object"]

    with _names_lock:
        _names_cache[layer] = out
    return out


def name_of(eid, layer="stable_graph"):
    return names(layer).get(eid)


def withdrawn_names(ids):
    """{entity id (int) -> name} for these entities, read from the retraction
    archive: the full name, else the given and family names joined.

    For people the live graph no longer names. The graph can withdraw person
    entities built from Contacts while the kinship scorecard still scores some
    of them; then the archive is where the graph still names them. The most
    recent withdrawal wins. Not cached: a prune empties the archive.
    """
    want = set(ids)
    if not want or not db.has_table("graph/graph.db", "expired_stable_graph"):
        return {}
    full, parts = {}, {}
    for row in db.query(
        "graph/graph.db",
        "select subject, predicate, object from expired_stable_graph "
        "where predicate in ('PS33', 'PS312', 'PS441') and object <> '' "
        "order by timestamp",
    ):
        if row["subject"] not in want:
            continue
        if row["predicate"] == "PS33":
            full[row["subject"]] = row["object"]
        else:
            parts.setdefault(row["subject"], {})[row["predicate"]] = row["object"]
    out = {eid: " ".join(p[k] for k in ("PS312", "PS441") if p.get(k))
           for eid, p in parts.items()}
    out.update(full)
    return {eid: name for eid, name in out.items() if name}


def owner_id():
    """The single entity flagged nm_isCurrentUser, as an int. None if absent.

    Appears exactly once in all live triples. Every ranking in this app must
    exclude it — the owner is not a contact.
    """
    row = db.query(
        "graph/graph.db",
        "select subject from stable_graph where predicate = ? limit 1",
        (OWNER_PREDICATE,),
    )
    return row[0]["subject"] if row else None


# ---------------------------------------------------------------- reification

def statements(layer, subject=None, predicate=None):
    """Collapse facet rows into whole statements.

    Returns [{subject, predicate, rid, facets: {relationshipPredicate: object},
    confidence, sources, timestamp}]. `relationshipId` is globally unique and is
    used as the statement key; plain attributes (rid 0) come back one per row
    with an empty facet map and their value in `object`.
    """
    where, params = [], []
    if subject is not None:
        where.append("subject = ?")
        params.append(subject)
    if predicate is not None:
        where.append("predicate = ?")
        params.append(predicate)
    clause = (" where " + " and ".join(where)) if where else ""

    rows = db.query(
        "graph/graph.db",
        f"select subject, predicate, relationshipId, relationshipPredicate, object, "
        f"confidence, sources, timestamp from {layer}{clause}",
        tuple(params),
    )

    plain, reified = [], {}
    for r in rows:
        if r["relationshipId"] == 0 and not r["relationshipPredicate"]:
            plain.append({
                "subject": sid(r["subject"]),
                "predicate": r["predicate"],
                "label": plabel(r["predicate"]),
                "rid": None,
                "object": r["object"],
                "decoded": decode(r["object"], r["predicate"]),
                "facets": {},
                "confidence": r["confidence"],
                "sources": r["sources"],
                "timestamp": db.apple_time(r["timestamp"]),
            })
        else:
            key = r["relationshipId"]
            st = reified.get(key)
            if st is None:
                st = reified[key] = {
                    "subject": sid(r["subject"]),
                    "predicate": r["predicate"],
                    "label": plabel(r["predicate"]),
                    "rid": sid(key),
                    "object": None,
                    "decoded": None,
                    "facets": {},
                    "confidence": r["confidence"],
                    "sources": r["sources"],
                    "timestamp": db.apple_time(r["timestamp"]),
                }
            st["facets"][r["relationshipPredicate"]] = r["object"]

    # The statement's headline value is its PS1 facet where present — many
    # reified predicates have no base row at all, so there is nothing else.
    for st in reified.values():
        head = st["facets"].get("PS1") or next(iter(st["facets"].values()), None)
        st["object"] = head
        st["decoded"] = decode(head, st["predicate"])

    return plain + list(reified.values())


# ---------------------------------------------------------------- provenance

# `sources` is a bitmask, not an id. Bit N corresponds to phase_status.source
# N+1, and each bit maps to one ingest namespace. 9 of the 17 distinct values in
# stable_graph are multi-bit combinations, so GROUP BY sources undercounts —
# always test bits.
SOURCE_BITS = {
    0: "Contacts",
    1: "Intents (INPerson)",
    5: "Photos (face clusters)",
    8: "Calendar (EventKit)",
    10: "Suggestions contacts",
    11: "Suggestions events",
    13: "Family Sharing",
    15: "App catalogue",
}


def source_names(mask):
    """Bitmask -> the list of ingest sources that asserted the fact."""
    if not mask:
        return []
    return [label for bit, label in SOURCE_BITS.items() if mask & (1 << bit)]
