"""retractions.py — what the graph withdrew, and what withdrawal actually did to it.

`expired_stable_graph` and `expired_event_graph` have the same nine columns as the
live layers and no primary key: a retraction here is an INSERT into another table,
not a DELETE. Every withdrawn row keeps the confidence it carried while it was
believed and the provenance mask that asserted it.

Two readings of the archive that do not hold, which this endpoint measures
instead of assuming:

1. **They are not all deletions.** Some expired rows share a subject and a
   predicate with a row that is live right now, and some also the value. Those
   look like rewrites rather than removals. Every expired row is therefore
   classified against the live layer before anything is counted:
   re-asserted / superseded / withdrawn / gone-with-the-entity.

2. **The archive is not complete.** `graph_state.expiredTriplesPruneTimestamp`
   sits before the earliest surviving expired row; everything older was discarded.
   The window, the gap, and the write bursts inside it are all returned so the
   page can state the limit rather than imply a history.

Nothing here is hardcoded. Every number, label, date and namespace is read at
request time from the store.
"""

import json

from . import db, vocab

GRAPH = "graph/graph.db"

# (expired table, the live table a row from it is checked against, layer key).
# Fixed allowlist — these names are interpolated into SQL and nothing else ever is.
LAYERS = (
    ("expired_stable_graph", "stable_graph", "stable"),
    ("expired_event_graph", "event_graph", "event"),
)

LAYER_LABEL = {
    "stable": "people, places and things",
    "event": "calendar entries",
}

# The four ways an expired row can relate to the live graph. Order is the order
# the page shows them in: churn first, real loss last.
FATE = (
    ("reasserted", "same value still live",
     "a live row has the same subject, field and value"),
    ("superseded", "other value live",
     "the entity still has this field, with a different value"),
    ("withdrawn", "field dropped, entity kept",
     "the entity is still live but no longer has this field"),
    ("vanished", "gone with the entity",
     "the subject has no row left in the live graph"),
)

# The reified facet that carries a calendar event's start time, and the facet that
# carries the person a participation statement points at, are needed by name.
START_FACET = "PS29"
PERSON_FACET = "PS143"
PARTICIPATION = ("PS232", "PS578")
SAME_AS = "PS102"
NAME_PREDICATE = "PS33"
DESCRIPTION = "PS51"

PRUNE_KEY = "expiredTriplesPruneTimestamp"
BUILD_KEY = "buildFromScratchTimestamp"


# --------------------------------------------------------------- classification

def _fate_case(live):
    """SQL that labels one expired row by what the live layer still holds.

    Four mutually exclusive buckets, evaluated most-alive first. `live` is one of
    the two live table names from LAYERS and never anything else.
    """
    return f"""
      case
        when exists(select 1 from {live} l
                    where l.subject = e.subject and l.predicate = e.predicate
                      and l.relationshipPredicate = e.relationshipPredicate
                      and l.object = e.object)                       then 'reasserted'
        when exists(select 1 from {live} l
                    where l.subject = e.subject and l.predicate = e.predicate) then 'superseded'
        when exists(select 1 from {live} l
                    where l.subject = e.subject)                     then 'withdrawn'
        else 'vanished'
      end"""


def _classified(expired, live, layer):
    """One dict per expired row, with its fate against the live layer."""
    return db.query(
        GRAPH,
        f"""select ? as layer, e.subject, e.predicate, e.relationshipId,
                   e.relationshipPredicate, e.object, e.confidence, e.sources,
                   e.sourceDuplicates, e.timestamp, {_fate_case(live)} as fate
            from {expired} e""",
        (layer,),
    )


# --------------------------------------------------------------------- helpers

def _month_of(obj):
    """'YYYY-MM' from a serialised NSDateComponents object, or None.

    The date-valued objects are a ~140-character JSON blob, never a number:
    CAST(object AS REAL) silently returns 0 and dates every row to the epoch.
    """
    try:
        d = json.loads(obj)
        return "%04d-%02d" % (int(d["year"]), int(d["month"]))
    except (TypeError, ValueError, KeyError):
        return None


def _short(token):
    """A namespaced opaque token, shortened for display. Never the whole hash."""
    head, sep, tail = str(token).partition(":")
    if not sep:
        return str(token)[:12]
    return f"{head}:{tail[:10]}…"


def _live_name(eid):
    """Best available live label for an entity id, across both live layers."""
    return vocab.name_of(eid) or vocab.name_of(eid, "event_graph")


# ----------------------------------------------------------------- the archive

def _archive():
    """Every expired row in both layers, each with its fate."""
    rows = []
    for expired, live, layer in LAYERS:
        rows.extend(_classified(expired, live, layer))
    return rows


def _window(rows):
    """The span the archive covers, the prune before it, and its write bursts."""
    state = {
        r["key"]: r["value"]
        for r in db.query(GRAPH, "select key, value from graph_state")
        if isinstance(r["value"], (int, float))
    }
    prune = db.apple_time(state.get(PRUNE_KEY)) if PRUNE_KEY in state else None
    built = db.apple_time(state.get(BUILD_KEY)) if BUILD_KEY in state else None

    stamps = sorted(db.apple_time(r["timestamp"]) for r in rows)
    first = stamps[0] if stamps else None
    last = stamps[-1] if stamps else None

    bursts = {}
    for r in rows:
        sec = int(db.apple_time(r["timestamp"]))
        b = bursts.setdefault(sec, {"unix": sec, "rows": 0, "subjects": set(), "layers": set()})
        b["rows"] += 1
        b["subjects"].add(r["subject"])
        b["layers"].add(r["layer"])
    burst_rows = sorted(
        ({"unix": b["unix"], "rows": b["rows"], "entities": len(b["subjects"]),
          "layers": sorted(b["layers"])} for b in bursts.values()),
        key=lambda b: b["unix"],
    )

    return {
        "prune": prune,
        "built": built,
        "first": first,
        "last": last,
        "gap_hours": round((first - prune) / 3600.0, 1) if (first and prune) else None,
        "span_hours": round((last - first) / 3600.0, 1) if (first and last) else None,
        "rows": len(rows),
        "distinct_row_timestamps": len({r["timestamp"] for r in rows}),
        "bursts": burst_rows,
        "burst_seconds": len(burst_rows),
        "prune_key": PRUNE_KEY,
    }


def _entities(rows):
    """One summary per (layer, subject) in the archive, most rows first."""
    live_tables = {layer: live for _, live, layer in LAYERS}
    ent_index = {}
    for r in rows:
        k = (r["layer"], r["subject"])
        e = ent_index.setdefault(k, {
            "layer": r["layer"], "subject": r["subject"],
            "rows": 0, "predicates": set(), "fates": set(),
            "name": None, "class_code": None, "months": set(),
            "attendees": set(), "descriptions": 0,
            "urls": 0, "dial_ins": 0, "mail": set(),
        })
        e["rows"] += 1
        e["predicates"].add(r["predicate"])
        e["fates"].add(r["fate"])
        if r["predicate"] == NAME_PREDICATE and not e["name"]:
            e["name"] = r["object"]
        if r["predicate"] == "PS1" and not r["relationshipId"]:
            e["class_code"] = r["object"]
        if r["relationshipPredicate"] == START_FACET:
            m = _month_of(r["object"])
            if m:
                e["months"].add(m)
        if r["predicate"] in PARTICIPATION and r["relationshipPredicate"] == PERSON_FACET:
            ref = vocab.entity_ref(r["object"])
            if ref is not None:
                e["attendees"].add(ref)
        if r["predicate"] == DESCRIPTION:
            e["descriptions"] += 1
        ns = vocab.ns_of(r["object"])
        if ns in ("https", "http"):
            e["urls"] += 1
        elif ns == "tel":
            e["dial_ins"] += 1
        elif ns == "mailto":
            e["mail"].add(r["object"])

    entities = []
    for e in ent_index.values():
        live = live_tables[e["layer"]]
        live_rows = db.one(
            GRAPH, f"select count(*) from {live} where subject = ?", (e["subject"],), 0)
        entities.append({
            "layer": e["layer"],
            "id": vocab.sid(e["subject"]),
            "name": e["name"] or _live_name(e["subject"]),
            "class_code": e["class_code"],
            "class_label": vocab.clabel(e["class_code"]) if e["class_code"] else None,
            "rows": e["rows"],
            "predicates": len(e["predicates"]),
            "live_rows": live_rows,
            "survived": bool(live_rows),
            "attendees": len(e["attendees"]),
            "descriptions": e["descriptions"],
            "urls": e["urls"],
            "dial_ins": e["dial_ins"],
            "mail": len(e["mail"]),
            "month": min(e["months"]) if e["months"] else None,
            "fates": sorted(e["fates"]),
        })
    entities.sort(key=lambda e: (-e["rows"], e["id"]))
    return entities


# ------------------------------------------------------------------- the route

def handler(params):
    rows = _archive()
    live_tables = {layer: live for _, live, layer in LAYERS}
    window = _window(rows)

    # ---------------------------------------------------------------- layers

    layers = []
    for expired, live, layer in LAYERS:
        mine = [r for r in rows if r["layer"] == layer]
        layers.append({
            "layer": layer,
            "table": expired,
            "live_table": live,
            "label": LAYER_LABEL.get(layer, layer),
            "rows": len(mine),
            "entities": len({r["subject"] for r in mine}),
            "predicates": len({r["predicate"] for r in mine}),
            "statements": len({r["relationshipId"] for r in mine if r["relationshipId"]}),
            "attributes": sum(1 for r in mine if not r["relationshipId"]),
            "live_rows": db.one(GRAPH, f"select count(*) from {live}", (), 0),
            "has_primary_key": bool(db.query(
                GRAPH,
                "select 1 from pragma_index_list(?) where origin = 'pk'",
                (expired,),
            )),
        })

    # ------------------------------------------------------------------ fate

    fate_index = {}
    for r in rows:
        k = (r["layer"], r["fate"])
        f = fate_index.setdefault(k, {"layer": r["layer"], "fate": r["fate"],
                                      "rows": 0, "subjects": set()})
        f["rows"] += 1
        f["subjects"].add(r["subject"])

    fate_rows = []
    for layer in live_tables:
        for key, label, note in FATE:
            f = fate_index.get((layer, key))
            fate_rows.append({
                "layer": layer, "fate": key, "label": label, "note": note,
                "rows": f["rows"] if f else 0,
                "entities": len(f["subjects"]) if f else 0,
            })

    totals = {key: sum(f["rows"] for f in fate_rows if f["fate"] == key)
              for key, _, _ in FATE}
    churn = totals.get("reasserted", 0) + totals.get("superseded", 0)

    fate = {
        "classes": [{"key": k, "label": l, "note": n} for k, l, n in FATE],
        "rows": fate_rows,
        "totals": totals,
        "churn": churn,
        "genuine": len(rows) - churn,
    }

    # ------------------------------------------------------------ predicates

    pred_index = {}
    for r in rows:
        k = (r["layer"], r["predicate"])
        p = pred_index.setdefault(k, {
            "layer": r["layer"], "predicate": r["predicate"],
            "label": vocab.plabel(r["predicate"]),
            "rows": 0, "subjects": set(), "statements": set(), "facets": set(),
            "conf_min": r["confidence"], "conf_max": r["confidence"],
            **{key: 0 for key, _, _ in FATE},
        })
        p["rows"] += 1
        p["subjects"].add(r["subject"])
        if r["relationshipId"]:
            p["statements"].add(r["relationshipId"])
        if r["relationshipPredicate"]:
            p["facets"].add(r["relationshipPredicate"])
        p[r["fate"]] += 1
        p["conf_min"] = min(p["conf_min"], r["confidence"])
        p["conf_max"] = max(p["conf_max"], r["confidence"])

    predicates = []
    for p in pred_index.values():
        predicates.append({
            "layer": p["layer"], "predicate": p["predicate"], "label": p["label"],
            "rows": p["rows"], "entities": len(p["subjects"]),
            "statements": len(p["statements"]),
            "facets": sorted(p["facets"]),
            "facet_labels": [vocab.plabel(f) for f in sorted(p["facets"])],
            "conf_min": p["conf_min"], "conf_max": p["conf_max"],
            **{key: p[key] for key, _, _ in FATE},
        })
    predicates.sort(key=lambda p: (-p["rows"], p["predicate"]))

    # -------------------------------------------------------------- entities

    entities = _entities(rows)

    fate_by_layer = []
    for layer in live_tables:
        mine = [e for e in entities if e["layer"] == layer]
        fate_by_layer.append({
            "layer": layer,
            "label": LAYER_LABEL.get(layer, layer),
            "survived": sum(1 for e in mine if e["survived"]),
            "vanished": sum(1 for e in mine if not e["survived"]),
            "survived_rows": sum(e["rows"] for e in mine if e["survived"]),
            "vanished_rows": sum(e["rows"] for e in mine if not e["survived"]),
            "entities": len(mine),
        })

    # ---------------------------------------------------- the calendar months

    months = {}
    for e in entities:
        if not e["month"]:
            continue
        m = months.setdefault(e["month"], {"month": e["month"], "gone": 0, "edited": 0})
        m["gone" if not e["survived"] else "edited"] += 1
    calendar = sorted(months.values(), key=lambda m: m["month"])

    dated = sum(1 for e in entities if e["month"])

    # ------------------------------------------------- what each row carries

    conf_index, src_index, cells = {}, {}, {}
    source_records = set()
    for r in rows:
        c = round(float(r["confidence"]), 6)
        k = (r["layer"], c)
        conf_index[k] = conf_index.get(k, 0) + 1
        names = vocab.source_names(r["sources"]) or ["unattributed"]
        label = " + ".join(names)
        s = src_index.setdefault(label, {"label": label, "mask": r["sources"],
                                         "rows": 0, "subjects": set(), "conf": set()})
        s["rows"] += 1
        s["subjects"].add(r["subject"])
        s["conf"].add(c)
        ck = (label, c)
        cells[ck] = cells.get(ck, 0) + 1
        # sourceDuplicates holds one or more source-record references joined by
        # ASCII 0x1E. Never rendered — counted only, as distinct source records.
        for part in str(r["sourceDuplicates"]).split("\x1e"):
            if part:
                source_records.add(part)

    live_conf = db.query(
        GRAPH,
        "select confidence, count(*) as rows from ("
        "  select confidence from stable_graph union all select confidence from event_graph"
        ") group by 1 order by 1",
    )

    # Does the retained score say anything the provenance mask does not already?
    # Measured, not assumed: count the sources that carry more than one value.
    mixed_sources = sum(1 for s in src_index.values() if len(s["conf"]) > 1)

    # A row classified re-asserted has a live row with the same subject, predicate,
    # facet and value. Does the archived copy carry the same confidence?
    conf_drift = 0
    for expired, live, _ in LAYERS:
        conf_drift += db.one(
            GRAPH,
            f"""select count(*) from {expired} e join {live} l
                on l.subject = e.subject and l.predicate = e.predicate
               and l.relationshipPredicate = e.relationshipPredicate and l.object = e.object
                where e.confidence <> l.confidence""", (), 0)

    carried = {
        "mixed_confidence_sources": mixed_sources,
        "confidence_drift_rows": conf_drift,
        "confidence": sorted(
            ({"layer": l, "confidence": c, "rows": n} for (l, c), n in conf_index.items()),
            key=lambda x: (x["layer"], x["confidence"]),
        ),
        "confidence_values": sorted({c for _, c in conf_index}),
        "live_confidence_values": len({r["confidence"] for r in live_conf}),
        "live_confidence_max": max((r["confidence"] for r in live_conf), default=None),
        "sources": sorted(
            ({"label": s["label"], "mask": s["mask"], "rows": s["rows"],
              "entities": len(s["subjects"])} for s in src_index.values()),
            key=lambda s: -s["rows"],
        ),
        "cells": [{"row": label, "col": str(c), "value": n} for (label, c), n in cells.items()],
        "source_records": len(source_records),
        "zero_confidence_rows": sum(1 for r in rows if not r["confidence"]),
        "empty_provenance_rows": sum(1 for r in rows if not str(r["sourceDuplicates"])),
    }

    # ------------------------------------------------------- the same-as rows

    same = [r for r in rows if r["predicate"] == SAME_AS]
    same_ns = {}
    for r in same:
        ns = vocab.ns_of(r["object"]) or "literal"
        s = same_ns.setdefault(ns, {"ns": ns, "rows": 0, "objects": set(), "subjects": set()})
        s["rows"] += 1
        s["objects"].add(r["object"])
        s["subjects"].add(r["subject"])

    live_same_ns = {}
    for live in live_tables.values():
        for r in db.query(
                GRAPH,
                f"select object, count(*) as rows from {live} where predicate = ? group by 1",
                (SAME_AS,)):
            ns = vocab.ns_of(r["object"]) or "literal"
            s = live_same_ns.setdefault(ns, {"ns": ns, "rows": 0, "objects": set()})
            s["rows"] += r["rows"]
            s["objects"].add(r["object"])

    # One retracted binding per distinct token. A token is a record in another
    # store; every entity the graph minted from that record carries the same
    # token, so unbinding it is a cascade — the record entity and each entity
    # derived from it lose the binding in the same write.
    by_token = {}
    for r in same:
        t = by_token.setdefault(r["object"], {
            "object": r["object"], "ns": vocab.ns_of(r["object"]) or "literal",
            "layers": set(), "subjects": set(),
        })
        t["layers"].add(r["layer"])
        t["subjects"].add(r["subject"])

    by_subject = {}
    for e in entities:
        by_subject.setdefault(e["id"], []).append(e)

    bindings = []
    for t in by_token.values():
        unbound = [e for s in t["subjects"] for e in by_subject.get(vocab.sid(s), [])]
        unbound.sort(key=lambda e: (e["layer"], -e["rows"]))
        live_bindings = sum(
            db.one(GRAPH, f"select count(distinct subject) from {live} where object = ?",
                   (t["object"],), 0)
            for live in live_tables.values())
        record = next((e for e in unbound if e["layer"] == "event"), None)
        derived = [e for e in unbound if e is not record]
        bindings.append({
            "token": _short(t["object"]),
            "ns": t["ns"],
            "ns_note": (vocab.NAMESPACES.get(t["ns"]) or ("", ""))[1],
            "unbound": len(unbound),
            "vanished": sum(1 for e in unbound if not e["survived"]),
            "record": record["name"] if record else None,
            "record_rows": sum(e["rows"] for e in unbound),
            "derived": len(derived),
            "derived_gone": sum(1 for e in derived if not e["survived"]),
            "classes": sorted({e["class_label"] for e in unbound if e["class_label"]}),
            "members": [{"name": e["name"], "class": e["class_label"], "layer": e["layer"],
                         "survived": e["survived"], "rows": e["rows"]} for e in unbound],
            "live_bindings": live_bindings,
            "layers": sorted(t["layers"]),
        })
    bindings.sort(key=lambda b: (-b["unbound"], -b["record_rows"]))

    sameas = {
        "predicate": SAME_AS,
        "label": vocab.plabel(SAME_AS),
        "rows": len(same),
        "tokens": len(by_token),
        "entities": len({(r["layer"], r["subject"]) for r in same}),
        "namespaces": sorted(
            ({"ns": s["ns"], "rows": s["rows"], "tokens": len(s["objects"]),
              "entities": len(s["subjects"]),
              "note": (vocab.NAMESPACES.get(s["ns"]) or ("", ""))[1]}
             for s in same_ns.values()),
            key=lambda s: -s["rows"]),
        "live_namespaces": sorted(
            ({"ns": s["ns"], "rows": s["rows"], "tokens": len(s["objects"]),
              "note": (vocab.NAMESPACES.get(s["ns"]) or ("", ""))[1]}
             for s in live_same_ns.values()),
            key=lambda s: -s["rows"]),
        "bindings": bindings,
        "to_entity": sum(1 for r in same if vocab.entity_ref(r["object"]) is not None),
    }

    # --------------------------------------------------------- the hard core

    gone_entities = [e for e in entities if not e["survived"]]
    gone_people = set()
    for r in rows:
        if r["fate"] != "vanished":
            continue
        if r["predicate"] in PARTICIPATION and r["relationshipPredicate"] == PERSON_FACET:
            ref = vocab.entity_ref(r["object"])
            if ref is not None:
                gone_people.add(ref)
    named_people = sum(1 for p in gone_people if _live_name(p))

    gone_classes = {}
    for e in gone_entities:
        k = e["class_label"] or "untyped"
        c = gone_classes.setdefault(k, {"label": k, "entities": 0, "rows": 0})
        c["entities"] += 1
        c["rows"] += e["rows"]

    core = {
        "entities": len(gone_entities),
        "row_count": sum(e["rows"] for e in gone_entities),
        "named": sum(1 for e in gone_entities if e["name"]),
        "classes": sorted(gone_classes.values(), key=lambda c: -c["entities"]),
        "attendee_links": sum(
            1 for r in rows
            if r["fate"] == "vanished" and r["predicate"] in PARTICIPATION
            and r["relationshipPredicate"] == PERSON_FACET),
        "people": len(gone_people),
        "named_people": named_people,
        "descriptions": sum(e["descriptions"] for e in gone_entities),
        "urls": sum(e["urls"] for e in gone_entities),
        "dial_ins": sum(e["dial_ins"] for e in gone_entities),
        "mail": sum(e["mail"] for e in gone_entities),
        "rows": [e for e in gone_entities],
    }

    return {
        "window": window,
        "layers": layers,
        "fate": fate,
        "predicates": predicates,
        "entities": entities,
        "entity_fate": fate_by_layer,
        "calendar": calendar,
        "dated_entities": dated,
        "carried": carried,
        "sameas": sameas,
        "core": core,
    }


# ------------------------------------------------------ the archive, as links

def _live_row(live, subject, predicate, obj):
    """Whether the live layer still holds this subject -> object under this predicate."""
    return bool(db.one(
        GRAPH, f"select 1 from {live} where subject = ? and predicate = ? and object = ? limit 1",
        (subject, predicate, obj)))


def _live_layer(eid):
    """The live layer an entity is a subject in, or None when it has no row left."""
    for _, live, layer in LAYERS:
        if db.one(GRAPH, f"select 1 from {live} where subject = ? limit 1", (eid,)):
            return layer
    return None


def _class_of(eid, archived):
    """The entity's class code: live first, then what the withdrawn rows said."""
    for _, live, _ in LAYERS:
        code = db.one(GRAPH, f"select object from {live} where subject = ? and predicate = 'PS1' "
                             "and (relationshipId is null or relationshipId = 0) limit 1", (eid,))
        if code:
            return code
    return next((r["object"] for r in archived
                 if r["predicate"] == "PS1" and not r["relationshipId"]), None)


def _name_from(eid, archived):
    """(label, where it came from). The live name first, then the archive's own."""
    live = _live_name(eid)
    if live:
        return live, "live"
    for r in archived:
        if r["predicate"] == NAME_PREDICATE and r["object"]:
            return r["object"], "archive"
    parts = [r["object"] for pid in vocab.NAME_PREDICATES[1:]      # first, then family
             for r in archived if r["predicate"] == pid and r["object"]]
    if parts:
        return " ".join(parts), "archive"
    return None, None


def graph(params):
    """The withdrawn rows that were links, for drawing over the live social graph.

    A withdrawn row is a link in one of two shapes. Its object is another
    entity: an event's attendee, organiser or sender. Or it bound an entity to
    a calendar record that an event entity also carries: the record minted both,
    and withdrawing it unbinds them together (the same-as section of the handler
    above). The facet rows of a withdrawn link statement (what kind of
    participant, whether attendance was required) go with the link. Every other
    withdrawn row is an attribute of the node it sat on and is counted there. A
    link is drawn only when no live row still holds it, so a re-asserted row is
    never drawn.

    Node ids are the social graph's own, so a page can lay these links over
    /api/social and have them land on the live nodes they touch.
    """
    rows = _archive()
    live_tables = {layer: live for _, live, layer in LAYERS}
    summary = {}
    for e in _entities(rows):
        summary.setdefault(e["id"], e)

    # The event-layer entities carrying each record token, withdrawn or live.
    carriers = {}
    for r in rows:
        if r["layer"] == "event" and r["predicate"] == SAME_AS:
            carriers.setdefault(r["object"], set()).add(r["subject"])

    def records(token):
        live = db.query(GRAPH, "select distinct subject from event_graph "
                               "where predicate = ? and object = ?", (SAME_AS, token))
        return carriers.get(token, set()) | {x["subject"] for x in live}

    links = {}

    def add(a, b, r, role):
        key = (b, a) if (b, a) in links else (a, b)
        l = links.setdefault(key, {"roles": set(), "rows": 0, "facets": 0,
                                   "fates": set(), "stamps": []})
        l["roles"].add(role)
        l["rows"] += 1
        l["fates"].add(r["fate"])
        l["stamps"].append(r["timestamp"])
        return key

    # Each row is put in exactly one bucket, so the counts add up to the archive.
    # The links first, so the facets of their statements can follow them.
    statement_of = {}          # (subject, relationshipId) of a drawn link -> its key
    for r in rows:
        ref = vocab.entity_ref(r["object"])
        if ref is None or r["fate"] == "reasserted":
            continue
        if _live_row(live_tables[r["layer"]], r["subject"], r["predicate"], r["object"]):
            r["as"] = "still_linked"
            continue
        r["as"] = "link"
        key = add(r["subject"], ref, r, vocab.plabel(r["predicate"]))
        if r["relationshipId"]:
            statement_of[(r["subject"], r["relationshipId"])] = key

    for r in rows:
        if "as" in r:
            continue
        live = live_tables[r["layer"]]
        # Matched on the statement, before the fate: the fate ignores relationshipId,
        # so a facet row that every attendee of a live event shares reads re-asserted.
        key = statement_of.get((r["subject"], r["relationshipId"])) if r["relationshipId"] else None
        if key is not None:
            r["as"] = "facet"
            links[key]["facets"] += 1
        elif r["fate"] == "reasserted":
            r["as"] = "reasserted"
        elif r["predicate"] == SAME_AS and r["layer"] == "stable":
            found = records(r["object"]) - {r["subject"]}
            if _live_row(live, r["subject"], SAME_AS, r["object"]):
                r["as"] = "still_linked"
            elif not found:
                r["as"] = "unresolved"
            else:
                r["as"] = "binding"
                ns = vocab.ns_of(r["object"]) or "record"
                for record in sorted(found):
                    add(record, r["subject"], r, f"{vocab.plabel(SAME_AS)} · {ns} record")
        else:
            r["as"] = "attribute"

    by_subject = {}
    for r in rows:
        by_subject.setdefault(r["subject"], []).append(r)

    nodes, gone = [], set()
    for eid in sorted({x for pair in links for x in pair}):
        mine = by_subject.get(eid, [])
        layer = _live_layer(eid)
        if layer is None:
            gone.add(eid)
        code = _class_of(eid, mine)
        name, name_source = _name_from(eid, mine)
        live_rows = sum(db.one(GRAPH, f"select count(*) from {t} where subject = ?", (eid,), 0)
                        for t in live_tables.values())
        attrs = {}
        for r in mine:
            if r["as"] == "attribute":
                label = vocab.plabel(r["predicate"])
                attrs[label] = attrs.get(label, 0) + 1
        s = summary.get(vocab.sid(eid)) or {}
        home = layer or (mine[0]["layer"] if mine else "stable")
        nodes.append({
            "id": vocab.sid(eid),
            "label": name or (vocab.clabel(code) if code else vocab.sid(eid)),
            "kind": "event" if home == "event" else "entity",
            "state": "gone" if layer is None else "live",
            "weight": live_rows + len(mine),
            "meta": {
                "class": vocab.clabel(code) if code else None,
                "layer": home,
                "named": name_source,
                "live_rows": live_rows,
                "archived_rows": len(mine),
                "attribute_rows": sum(attrs.values()),
                "attributes": [{"label": k, "rows": n}
                               for k, n in sorted(attrs.items(), key=lambda kv: (-kv[1], kv[0]))],
                "month": s.get("month"),
                "participants": s.get("attendees", 0),
                "descriptions": s.get("descriptions", 0),
                "urls": s.get("urls", 0),
                "dial_ins": s.get("dial_ins", 0),
                "retracted_at": max((db.apple_time(r["timestamp"]) for r in mine), default=None),
            },
        })

    out = []
    for (a, b), l in links.items():
        out.append({
            "source": vocab.sid(a), "target": vocab.sid(b), "kind": "withdrawn",
            # gone: withdrawn together with an entity that no longer exists;
            # cut: both ends are still live and only the link between them went.
            "state": "gone" if (a in gone or b in gone) else "cut",
            "weight": l["rows"],
            "meta": {
                "roles": sorted(l["roles"]),
                "rows": l["rows"],
                "facet_rows": l["facets"],
                "fates": sorted(l["fates"]),
                "retracted_at": max(db.apple_time(t) for t in l["stamps"]),
            },
        })
    out.sort(key=lambda l: (l["state"] != "gone", -l["weight"], l["source"], l["target"]))

    bucket = {}
    for r in rows:
        bucket[r["as"]] = bucket.get(r["as"], 0) + 1
    attr_subjects = {r["subject"] for r in rows if r["as"] == "attribute"}
    window = _window(rows)
    window.pop("bursts", None)

    return {
        "available": db.connect(GRAPH) is not None,
        "nodes": nodes,
        "links": out,
        "window": window,
        "counts": {
            "rows": len(rows),
            "link_rows": bucket.get("link", 0),
            "facet_rows": bucket.get("facet", 0),
            "binding_rows": bucket.get("binding", 0),
            "attribute_rows": bucket.get("attribute", 0),
            "reasserted_rows": bucket.get("reasserted", 0),
            "still_linked_rows": bucket.get("still_linked", 0),
            "unresolved_rows": bucket.get("unresolved", 0),
            "attribute_entities": len(attr_subjects),
            "attribute_entities_drawn": len({vocab.sid(e) for e in attr_subjects}
                                            & {n["id"] for n in nodes}),
            "links": len(out),
            "gone_links": sum(1 for l in out if l["state"] == "gone"),
            "cut_links": sum(1 for l in out if l["state"] == "cut"),
            "nodes": len(nodes),
            "gone_nodes": len(gone),
            "event_nodes": sum(1 for n in nodes if n["kind"] == "event"),
        },
    }


ROUTES = {"/api/retractions": handler, "/api/retractions/graph": graph}
