"""identity.py — the join table, measured.

Every namespaced object in the graph is a pointer out of the graph: into
Contacts, into a Photos face cluster, into EventKit, into the app catalogue.
This endpoint measures that surface end to end — which namespaces exist, which
predicate carries them, how many of the references actually resolve against the
source stores that ship in this bundle, and, for each person entity, how many
external namespaces it lands in at once.

The last number is the point. The architecture is designed so that one entity
fuses a contact record, a face, a circle and a calendar seat; how often that
fusion has actually happened is counted, not assumed. Everything below is
counted at request time.

Two identifier readings are computed here rather than assumed: the `phPerson:`
values are tested against base64 and against the Photos person table, and the
`ekEvent:` tokens are re-derived from the Calendar store with a store-qualified
SHA-256 construction.
"""

import base64
import hashlib
import re

from . import db, vocab

GRAPH = "graph/graph.db"

# (table, display label, is a live layer)
LAYERS = (
    ("stable_graph", "stable", True),
    ("event_graph", "event", True),
    ("expired_stable_graph", "expired stable", False),
    ("expired_event_graph", "expired event", False),
)

PERSON_CLASS = "SB104"          # ontology class code, not a row value
CONTACT_INFO = "PS520"          # 'has contact information', reified
PHONE_FACET = "PS407"
MAIL_FACET = "PS406"
LABEL_FACET = "PS740"
ALIAS_PRED = "nm_entityAliasRelationship"
ALIAS_FACET = "PS89"
SIGNAL_FACET = "nm_signalLabel"
VISUAL_FACET = "nm_visualIdentifier"
TYPE_PRED = "PS1"

# Namespace kinds (from vocab.NAMESPACES) that name a record in some OTHER
# store. `md` is an internal edge, `tel`/`mailto`/`http(s)` are URIs and
# `association` is an enum — none of them is a join into another database.
INTERNAL_KINDS = ("entity", "uri", "reason")

# Of the external kinds, these are the ones that name a PERSON somewhere else —
# a contact card, a face cluster, an Intents person, a family circle. An
# `event` kind names a meeting, not a human, so a person entity that resolves
# only into an event namespace is a seat at a meeting, not a resolved identity.
IDENTITY_KINDS = ("contact", "face", "person", "family")
EVENT_KINDS = ("event",)

# Apple's CNLabel sentinels look like _$!<Mobile>!$_ . Free-text labels do not.
SENTINEL = re.compile(r"^_\$!<(.+)>!\$_$")
UUID_SHAPE = re.compile(r"^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")


# ----------------------------------------------------------------- helpers

def _layers():
    return [(t, lab, live) for t, lab, live in LAYERS if db.has_table(GRAPH, t)]


def _names():
    """Display names from both live layers. Event titles live in event_graph."""
    out = dict(vocab.names("event_graph"))
    out.update(vocab.names("stable_graph"))
    return out


def _kind(ns):
    return vocab.NAMESPACES.get(ns, ("", ""))[0]


def _external(ns):
    return bool(ns) and _kind(ns) not in INTERNAL_KINDS


def _scan_refs():
    """Every namespaced object in every layer, one row per occurrence.

    Filtering on a colon in SQL is only a cheap prefilter — the namespace is
    decided by vocab.ns_of, never by splitting the string. Most colon-bearing
    objects in the live layers are calendar prose, serialised dates and
    identifier strings, and must not be read as references; the census counts
    them so the page can say how many.
    """
    rows, colon_rows = [], {}
    for table, label, live in _layers():
        got = db.query(
            GRAPH,
            f"select subject, predicate, relationshipPredicate, object "
            f"from {table} where instr(object, ':') > 0",
        )
        colon_rows[label] = len(got)
        for r in got:
            ns = vocab.ns_of(r["object"])
            if ns is None:
                continue
            rows.append({
                "layer": label,
                "live": live,
                "subject": r["subject"],
                "predicate": r["predicate"],
                "facet": r["relationshipPredicate"] or "",
                "ns": ns,
                "value": r["object"][len(ns) + 1:],
            })
    return rows, colon_rows


# ----------------------------------------------------------------- panels

def _namespace_census(refs, colon_rows):
    """What the graph is joinable to, per namespace and per layer."""
    totals = {}
    for table, label, live in _layers():
        totals[label] = db.one(GRAPH, f"select count(*) from {table}", default=0)

    agg = {}
    for r in refs:
        a = agg.setdefault(r["ns"], {
            "ns": r["ns"],
            "kind": vocab.NAMESPACES.get(r["ns"], ("", ""))[0],
            "note": vocab.NAMESPACES.get(r["ns"], ("", ""))[1],
            "external": _external(r["ns"]),
            "occurrences": 0,
            "values": set(),
            "subjects": set(),
            "layers": {},
            "live": 0,
            "expired": 0,
        })
        a["occurrences"] += 1
        a["values"].add(r["value"])
        a["subjects"].add(r["subject"])
        a["layers"][r["layer"]] = a["layers"].get(r["layer"], 0) + 1
        a["live" if r["live"] else "expired"] += 1

    out = []
    for a in agg.values():
        a["distinct_refs"] = len(a.pop("values"))
        a["entities"] = len(a.pop("subjects"))
        out.append(a)
    out.sort(key=lambda a: -a["occurrences"])

    namespaced = sum(a["occurrences"] for a in out)
    colon_total = sum(colon_rows.values())
    return {
        "rows": out,
        "layers": [{"layer": lab, "objects": totals.get(lab, 0),
                    "colon_bearing": colon_rows.get(lab, 0)}
                   for _, lab, _ in _layers()],
        "objects": sum(totals.values()),
        "colon_bearing": colon_total,
        "namespaced": namespaced,
        "colon_but_literal": colon_total - namespaced,
    }


def _predicate_funnel(refs):
    """Does every cross-store reference really flow through one predicate?

    Measured over the external namespaces only — the ones that point at a
    record in another database. `md:` edges, URIs and the association enum stay
    inside the graph and are counted separately.
    """
    per_pair, per_ns = {}, {}
    for r in refs:
        if not _external(r["ns"]):
            continue
        key = (r["ns"], r["predicate"], r["facet"])
        per_pair[key] = per_pair.get(key, 0) + 1
        per_ns.setdefault(r["ns"], {})
        per_ns[r["ns"]][r["predicate"]] = per_ns[r["ns"]].get(r["predicate"], 0) + 1

    rows = [{
        "ns": ns, "predicate": pred, "label": vocab.plabel(pred),
        "facet": facet, "facet_label": vocab.plabel(facet) if facet else "",
        "occurrences": n,
    } for (ns, pred, facet), n in sorted(per_pair.items(), key=lambda kv: -kv[1])]

    # The dominant predicate, computed rather than assumed.
    by_pred = {}
    for r in rows:
        by_pred[r["predicate"]] = by_pred.get(r["predicate"], 0) + r["occurrences"]
    main = max(by_pred.items(), key=lambda kv: kv[1])[0] if by_pred else None
    total = sum(by_pred.values())

    exceptions = [r for r in rows if r["predicate"] != main]
    single = sum(1 for ns, preds in per_ns.items() if len(preds) == 1)

    internal = {}
    for r in refs:
        if _external(r["ns"]):
            continue
        k = (r["ns"], r["predicate"])
        internal[k] = internal.get(k, 0) + 1

    return {
        "rows": rows,
        "internal": [{"ns": ns, "predicate": p, "label": vocab.plabel(p), "occurrences": n}
                     for (ns, p), n in sorted(internal.items(), key=lambda kv: -kv[1])],
        "internal_occurrences": sum(internal.values()),
        "internal_predicates": len({p for _, p in internal}),
        "predicates": [{"predicate": p, "label": vocab.plabel(p), "occurrences": n}
                       for p, n in sorted(by_pred.items(), key=lambda kv: -kv[1])],
        "main_predicate": main,
        "main_label": vocab.plabel(main) if main else "",
        "main_occurrences": by_pred.get(main, 0),
        "occurrences": total,
        "namespaces": len(per_ns),
        "single_predicate_namespaces": single,
        "exceptions": exceptions,
    }


def _person_ids():
    return [r["subject"] for r in db.query(
        GRAPH,
        "select subject from stable_graph where predicate = ? and object = ? "
        "and relationshipId = 0",
        (TYPE_PRED, PERSON_CLASS),
    )]


def _contact_statements():
    """PS520 statements collapsed into one row per handle-bearing statement."""
    rows = db.query(
        GRAPH,
        "select subject, relationshipId, relationshipPredicate, object, sources "
        "from stable_graph where predicate = ?",
        (CONTACT_INFO,),
    )
    stmts = {}
    for r in rows:
        st = stmts.setdefault(r["relationshipId"], {
            "subject": r["subject"], "facets": {}, "sources": r["sources"]})
        st["facets"][r["relationshipPredicate"]] = r["object"]
    return list(stmts.values())


def _fanout(refs, people, stmts, names, owner):
    """Per person entity: which external namespaces it resolves into."""
    ns_by_person, handles, attends = {}, {}, {}

    people_set = set(people)
    for r in refs:
        if r["subject"] in people_set and _external(r["ns"]):
            ns_by_person.setdefault(r["subject"], {}).setdefault(r["ns"], r["value"])

    for st in stmts:
        n = sum(1 for f in (PHONE_FACET, MAIL_FACET) if f in st["facets"])
        if n:
            handles[st["subject"]] = handles.get(st["subject"], 0) + n

    for r in db.query(
        GRAPH,
        "select object, count(distinct subject) as n from event_graph "
        "where predicate = 'PS232' and relationshipPredicate = 'PS143' group by object",
    ):
        eid = vocab.entity_ref(r["object"])
        if eid is not None:
            attends[eid] = r["n"]

    rows, combos = [], {}
    for pid in people:
        carried = ns_by_person.get(pid, {})
        idn = sorted(n for n in carried if _kind(n) in IDENTITY_KINDS)
        evn = sorted(n for n in carried if _kind(n) in EVENT_KINDS)
        other = sorted(n for n in carried
                       if _kind(n) not in IDENTITY_KINDS + EVENT_KINDS)
        if idn:
            key = " + ".join(idn)
        elif evn:
            key = "event-scoped reference only"
        else:
            key = "no external reference at all"
        c = combos.setdefault(key, {"key": key, "namespaces": idn, "people": 0,
                                    "degree": len(idn),
                                    "event_only": not idn and bool(evn)})
        c["people"] += 1
        rows.append({
            "id": vocab.sid(pid),
            "name": names.get(pid),
            "namespaces": idn,
            "event_namespaces": evn,
            "other_namespaces": other,
            "degree": len(idn),
            "handles": handles.get(pid, 0),
            "events": attends.get(pid, 0),
            "is_owner": pid == owner,
        })

    rows.sort(key=lambda r: (-r["degree"], -r["handles"], -r["events"]))
    combo_rows = sorted(combos.values(), key=lambda c: (-c["people"], c["key"]))

    ns_totals = {}
    for r in rows:
        for ns in r["namespaces"] + r["event_namespaces"] + r["other_namespaces"]:
            ns_totals[ns] = ns_totals.get(ns, 0) + 1

    # Pairwise overlap between the person-record namespaces — the measurement
    # behind "the islands barely touch".
    pairs = {}
    for r in rows:
        for i, a in enumerate(r["namespaces"]):
            for b in r["namespaces"][i + 1:]:
                pairs[(a, b)] = pairs.get((a, b), 0) + 1

    attendees = [r for r in rows if r["events"]]
    return {
        "people": len(people),
        "named": sum(1 for r in rows if r["name"]),
        "with_handle": sum(1 for r in rows if r["handles"]),
        "attending": len(attendees),
        "multi": sum(1 for r in rows if r["degree"] >= 2),
        "single": sum(1 for r in rows if r["degree"] == 1),
        "none": sum(1 for r in rows if r["degree"] == 0),
        "event_only": sum(1 for r in rows if not r["degree"] and r["event_namespaces"]),
        "no_reference": sum(1 for r in rows
                            if not r["degree"] and not r["event_namespaces"]),
        "combos": combo_rows,
        "namespace_totals": [{"ns": k, "kind": _kind(k), "people": v}
                             for k, v in sorted(ns_totals.items(), key=lambda kv: -kv[1])],
        "overlap": [{"a": a, "b": b, "people": n} for (a, b), n in
                    sorted(pairs.items(), key=lambda kv: -kv[1])],
        "namespaces": sorted({n for r in rows for n in r["namespaces"]}),
        "attendee_resolution": [
            {"ns": ns, "people": sum(1 for r in attendees if ns in r["namespaces"])}
            for ns in sorted({n for r in rows for n in r["namespaces"]})],
        "attendees_with_identity_ns": sum(1 for r in attendees if r["degree"]),
        "rows": rows,
    }


def _address_book_files():
    """[(name, store)] for the Contacts sources, wherever this Mac keeps them."""
    return db.address_books()


def _contacts_join(refs, people, names):
    """cnContact references against the real address book, both value forms."""
    vals = {}
    for r in refs:
        if r["ns"] == "cnContact":
            v = vals.setdefault(r["value"], {"value": r["value"], "subjects": set(),
                                             "occurrences": 0})
            v["subjects"].add(r["subject"])
            v["occurrences"] += 1
    values = sorted(vals)
    card_files = []
    matched = {}

    for fn, rel in _address_book_files():
        if not db.has_table(rel, "ZABCDRECORD"):
            continue
        cards = 0
        if db.has_table(rel, "Z_PRIMARYKEY"):
            cards = db.one(
                rel,
                "select count(*) from ZABCDRECORD where Z_ENT = "
                "(select Z_ENT from Z_PRIMARYKEY where Z_NAME = 'ABCDContact')",
                default=0) or 0
        hits = 0
        if values:
            marks = ",".join("?" * len(values))
            rows = db.query(
                rel,
                f"select ZUNIQUEID, ZLINKID from ZABCDRECORD "
                f"where ZUNIQUEID in ({marks}) or ZLINKID in ({marks})",
                tuple(values) * 2,
            )
            for row in rows:
                for col in ("ZUNIQUEID", "ZLINKID"):
                    v = row[col]
                    if v in vals:
                        matched.setdefault(v, set()).add((col, fn))
                        hits += 1
        card_files.append({"file": fn,
                           "records": db.one(rel, "select count(*) from ZABCDRECORD", default=0),
                           "person_cards": cards, "matches": hits})

    # The value's own shape decides which column it can match. Read the shape
    # off the value; never assume the suffix text.
    forms = {}
    rows = []
    for v in values:
        head, sep, tail = v.partition(":")
        form = ("suffixed " + sep + tail) if sep else "bare identifier"
        paths = sorted({c for c, _ in matched.get(v, ())})
        f = forms.setdefault(form, {"form": form, "values": 0, "matched": 0, "paths": {}})
        f["values"] += 1
        if paths:
            f["matched"] += 1
            for p in paths:
                f["paths"][p] = f["paths"].get(p, 0) + 1
        rows.append({
            "form": form,
            "paths": paths,
            "files": sorted({b for _, b in matched.get(v, ())}),
            "entities": [vocab.sid(s) for s in sorted(vals[v]["subjects"])],
            "resolved": bool(paths),
            "uuid_shaped": bool(UUID_SHAPE.match(head)),
        })

    ents = set()
    for v in values:
        ents |= vals[v]["subjects"]
    ents_matched = {s for v in values if v in matched for s in vals[v]["subjects"]}

    return {
        "values": len(values),
        "matched": len(matched),
        "occurrences": sum(v["occurrences"] for v in vals.values()),
        "entities": len(ents),
        "entities_matched": len(ents_matched),
        "person_entities": len(ents & set(people)),
        "named_entities": sum(1 for s in ents if names.get(s)),
        "forms": [{**f, "paths": [{"path": p, "values": n}
                                  for p, n in sorted(f["paths"].items())]}
                  for f in sorted(forms.values(), key=lambda f: -f["values"])],
        "card_files": card_files,
        "rows": rows,
    }


def _photos_join(refs):
    """phPerson: is it an opaque token, or a plaintext identifier?"""
    vals = {}
    for r in refs:
        if r["ns"] == "phPerson":
            vals.setdefault(r["value"], set()).add(r["subject"])
    values = sorted(vals)

    uuids, suffixes, lengths = {}, {}, {}
    b64_ok = 0
    for v in values:
        head, sep, tail = v.partition("/")
        uuids[v] = head
        suffixes[sep + tail if sep else ""] = suffixes.get(sep + tail if sep else "", 0) + 1
        lengths[len(v)] = lengths.get(len(v), 0) + 1
        pad = v + "=" * (-len(v) % 4)
        try:
            if len(base64.b64decode(pad, validate=True)) == 32:
                b64_ok += 1
        except Exception:
            pass

    resolved = set()
    photo_rows = 0
    if values and db.has_table("sources/Photos.sqlite", "ZPERSON"):
        want = sorted({uuids[v] for v in values})
        marks = ",".join("?" * len(want))
        got = db.query("sources/Photos.sqlite",
                       f"select ZPERSONUUID from ZPERSON where ZPERSONUUID in ({marks})",
                       tuple(want))
        photo_rows = db.one("sources/Photos.sqlite", "select count(*) from ZPERSON", default=0)
        have = {g["ZPERSONUUID"] for g in got}
        resolved = {v for v in values if uuids[v] in have}

    sibling = db.one(
        GRAPH,
        "select count(distinct subject) from stable_graph where relationshipPredicate = ?",
        (VISUAL_FACET,), default=0)

    return {
        "values": len(values),
        "entities": len({s for ss in vals.values() for s in ss}),
        "uuid_shaped": sum(1 for v in values if UUID_SHAPE.match(uuids[v])),
        "resolved": len(resolved),
        "photos_person_rows": photo_rows,
        "decodes_as_32_byte_hash": b64_ok,
        "lengths": [{"length": k, "values": n} for k, n in sorted(lengths.items())],
        "suffixes": [{"suffix": k, "values": n}
                     for k, n in sorted(suffixes.items(), key=lambda kv: -kv[1])],
        "sibling_plaintext_facet": sibling,
    }


def _calendar_join(refs):
    """ekEvent: re-derive the token from the Calendar store. SQLite has no
    sha256, so the construction is computed here rather than in SQL."""
    tokens = {}
    for r in refs:
        if r["ns"] in ("ekEvent", "sgEvent"):
            t = tokens.setdefault((r["ns"], r["value"]), {"live": 0, "expired": 0})
            t["live" if r["live"] else "expired"] += 1

    preimages = []
    cal = "sources/Calendar.sqlitedb"
    if db.has_table(cal, "CalendarItem") and db.has_table(cal, "Store"):
        preimages = db.query(
            cal,
            "select s.persistent_id || ':' || ci.unique_identifier as preimage "
            "from CalendarItem ci join Calendar ca on ca.ROWID = ci.calendar_id "
            "join Store s on s.ROWID = ca.store_id "
            "where ci.unique_identifier is not null and s.persistent_id is not null",
        )

    table = {}
    for p in preimages:
        digest = hashlib.sha256(p["preimage"].encode("utf-8")).digest()
        table[base64.b64encode(digest).decode("ascii")] = True

    out = {}
    for (ns, value), counts in tokens.items():
        o = out.setdefault(ns, {"ns": ns, "tokens": 0, "resolved": 0,
                                "live_tokens": 0, "expired_tokens": 0,
                                "occurrences": 0, "resolved_live": 0,
                                "resolved_expired": 0})
        o["tokens"] += 1
        o["occurrences"] += counts["live"] + counts["expired"]
        if counts["live"]:
            o["live_tokens"] += 1
        if counts["expired"]:
            o["expired_tokens"] += 1
        if value in table:
            o["resolved"] += 1
            if counts["live"]:
                o["resolved_live"] += 1
            if counts["expired"]:
                o["resolved_expired"] += 1

    return {
        "preimages": len(preimages),
        "distinct_preimage_hashes": len(table),
        "namespaces": sorted(out.values(), key=lambda o: -o["tokens"]),
    }


def _apps_join(refs):
    """The controlled experiment: is the opaque app token really a plain hash?

    336 software entities carry both the token and the plaintext bundle id, so
    the construction can be tested without leaving the store. This is what makes
    the scheme pseudonymous rather than anonymous, and it is the same shape as
    the calendar-token construction above.
    """
    tokens = {}
    for r in refs:
        if r["ns"] == "lsBundleRecord":
            tokens.setdefault(r["subject"], set()).add(r["value"])

    plain = {}
    for r in db.query(GRAPH,
                      "select subject, object from stable_graph where predicate = 'nm_bundleID'"):
        plain[r["subject"]] = r["object"]

    both = padded = stripped = 0
    for subject, values in tokens.items():
        bundle = plain.get(subject)
        if bundle is None:
            continue
        both += 1
        digest = base64.b64encode(hashlib.sha256(bundle.encode("utf-8")).digest()).decode("ascii")
        if digest in values:
            padded += 1
        elif digest.rstrip("=") in values:
            stripped += 1

    return {
        "entities": len(tokens),
        "with_plaintext": both,
        "distinct_tokens": len({v for vs in tokens.values() for v in vs}),
        "distinct_bundles": len(set(plain.values())),
        "reproduced": padded + stripped,
        "padding_kept": padded,
        "padding_stripped": stripped,
    }


def _handle_reach(stmts):
    """Do the graph's handles reach chat.db, the conversation store, at all?"""
    phones, mails = set(), set()
    for st in stmts:
        f = st["facets"]
        if f.get(PHONE_FACET):
            phones.add(f[PHONE_FACET])
        if f.get(MAIL_FACET):
            mails.add(f[MAIL_FACET].lower())

    chat = "sources/chat.db"
    if not db.has_table(chat, "handle"):
        return {"available": False, "phone_values": len(phones), "mail_values": len(mails)}

    ids = [r["id"] for r in db.query(chat, "select id from handle") if r["id"]]
    lower = {i.lower() for i in ids}

    def tail(v):
        digits = "".join(c for c in v if c.isdigit())
        return digits[-9:] if len(digits) >= 9 else None

    chat_tails = {t for t in (tail(i) for i in ids) if t}
    graph_tails = {t for t in (tail(p) for p in phones) if t}

    return {
        "available": True,
        "chat_handles": len(ids),
        "phone_values": len(phones),
        "mail_values": len(mails),
        "mail_exact": len(mails & lower),
        "phone_exact": len({p for p in phones if p.lower() in lower}),
        "phone_by_tail": len(graph_tails & chat_tails),
        "chat_reached": len(chat_tails & graph_tails) + len(mails & lower),
    }


def _handle_index(stmts, names, fanout_rows, owner):
    """Reverse index: a handle -> the person it belongs to."""
    by_person = {r["id"]: r for r in fanout_rows}
    rows, per_value, labels = [], {}, {}

    for st in stmts:
        f = st["facets"]
        raw_label = f.get(LABEL_FACET)
        if raw_label is not None:
            m = SENTINEL.match(raw_label)
            key = (m.group(1) if m else raw_label, bool(m))
            labels[key] = labels.get(key, 0) + 1
        for facet, kind in ((PHONE_FACET, "phone"), (MAIL_FACET, "mail")):
            value = f.get(facet)
            if not value:
                continue
            sid = vocab.sid(st["subject"])
            person = by_person.get(sid)
            m = SENTINEL.match(raw_label) if raw_label else None
            rows.append({
                "value": value,
                "kind": kind,
                "label": (m.group(1) if m else raw_label) or "",
                "label_is_sentinel": bool(m),
                "id": sid,
                "name": names.get(st["subject"]),
                "namespaces": person["namespaces"] if person else [],
                "is_owner": st["subject"] == owner,
                "sources": vocab.source_names(st["sources"]),
            })
            per_value.setdefault(value, set()).add(sid)

    rows.sort(key=lambda r: (r["kind"], (r["name"] or "￿").lower()))
    return {
        "rows": rows,
        "handles": len(per_value),
        "phone": sum(1 for r in rows if r["kind"] == "phone"),
        "mail": sum(1 for r in rows if r["kind"] == "mail"),
        "people": len({r["id"] for r in rows}),
        "named_people": len({r["id"] for r in rows if r["name"]}),
        "shared_handles": sum(1 for v in per_value.values() if len(v) > 1),
        "labels": [{"label": lab, "sentinel": sent, "facets": n}
                   for (lab, sent), n in sorted(labels.items(), key=lambda kv: -kv[1])],
    }


def _rollup(stmts, names, fanout_rows):
    """Contact-information rollup, one row per person who carries any."""
    by_person = {r["id"]: r for r in fanout_rows}
    agg = {}
    for st in stmts:
        sid = vocab.sid(st["subject"])
        a = agg.setdefault(sid, {"id": sid, "name": names.get(st["subject"]),
                                 "phone": 0, "mail": 0, "other": 0,
                                 "statements": 0, "labels": []})
        a["statements"] += 1
        f = st["facets"]
        if PHONE_FACET in f:
            a["phone"] += 1
        if MAIL_FACET in f:
            a["mail"] += 1
        if PHONE_FACET not in f and MAIL_FACET not in f:
            a["other"] += 1
        lab = f.get(LABEL_FACET)
        if lab:
            m = SENTINEL.match(lab)
            v = m.group(1) if m else lab
            if v not in a["labels"]:
                a["labels"].append(v)

    rows = []
    for a in agg.values():
        person = by_person.get(a["id"])
        a["namespaces"] = person["namespaces"] if person else []
        a["degree"] = len(a["namespaces"])
        a["handles"] = a["phone"] + a["mail"]
        rows.append(a)
    rows.sort(key=lambda r: (-r["handles"], -r["degree"]))

    hist = {}
    for r in rows:
        hist[r["handles"]] = hist.get(r["handles"], 0) + 1
    return {
        "rows": rows,
        "people": len(rows),
        "phone_facets": sum(r["phone"] for r in rows),
        "mail_facets": sum(r["mail"] for r in rows),
        "non_handle_statements": sum(r["other"] for r in rows),
        "histogram": [{"handles": k, "people": v} for k, v in sorted(hist.items())],
    }


def _dead_handle_predicate():
    """nm_handleIdentifier is named like a handle store. Check whether it is."""
    rows = db.query(
        GRAPH,
        "select object, count(*) as n, count(distinct subject) as entities "
        "from stable_graph where predicate = 'nm_handleIdentifier' group by object",
    )
    return {
        "rows_": sum(r["n"] for r in rows),
        "distinct_values": len(rows),
        "entities": max((r["entities"] for r in rows), default=0),
        "values": [{"value": r["object"], "rows_": r["n"]} for r in rows],
    }


# ----------------------------------------------------------------- routes

def handler(params):
    refs, colon_rows = _scan_refs()
    names = _names()
    owner = vocab.owner_id()
    people = _person_ids()
    stmts = _contact_statements()

    fan = _fanout(refs, people, stmts, names, owner)
    return {
        "owner": vocab.sid(owner),
        "census": _namespace_census(refs, colon_rows),
        "funnel": _predicate_funnel(refs),
        "fanout": fan,
        "contacts": _contacts_join(refs, people, names),
        "photos": _photos_join(refs),
        "calendar": _calendar_join(refs),
        "handles": _handle_index(stmts, names, fan["rows"], owner),
        "apps": _apps_join(refs),
        "reach": _handle_reach(stmts),
        "rollup": _rollup(stmts, names, fan["rows"]),
        "handle_predicate": _dead_handle_predicate(),
    }


def _code_label(value):
    """An object that IS an ontology code decodes to its label, not its text."""
    if not isinstance(value, str):
        return None
    if value in vocab.classes():
        return vocab.clabel(value)
    if value in vocab.predicates():
        return vocab.plabel(value)
    return None


def _resolve_value(ns, value):
    """One reference -> where it lands, if it lands anywhere."""
    if ns == "cnContact":
        for fn, rel in _address_book_files():
            if not db.has_table(rel, "ZABCDRECORD"):
                continue
            row = db.query(rel,
                           "select ZUNIQUEID, ZLINKID from ZABCDRECORD "
                           "where ZUNIQUEID = ? or ZLINKID = ? limit 1",
                           (value, value))
            if row:
                col = "ZUNIQUEID" if row[0]["ZUNIQUEID"] == value else "ZLINKID"
                return {"store": "AddressBook", "how": col, "where": fn}
        return None
    if ns == "phPerson":
        uuid = value.partition("/")[0]
        if db.has_table("sources/Photos.sqlite", "ZPERSON"):
            hit = db.one("sources/Photos.sqlite",
                         "select count(*) from ZPERSON where ZPERSONUUID = ?", (uuid,),
                         default=0)
            if hit:
                return {"store": "Photos", "how": "ZPERSONUUID", "where": "plaintext"}
        return None
    return None


def person(params):
    """The drawer: one entity's decoded facts, its inbound references, aliases."""
    raw = (params.get("id") or "").strip()
    try:
        eid = int(raw)
    except (TypeError, ValueError):
        return {"found": False, "reason": "an entity id is required"}

    names = _names()
    owner = vocab.owner_id()
    facts = []
    for table, label, live in _layers():
        if table.startswith("expired"):
            continue
        for st in vocab.statements(table, subject=eid):
            facets = [{"facet": k, "label": vocab.plabel(k), "object": v,
                       "decoded": vocab.decode(v, st["predicate"]),
                       "object_label": _code_label(v),
                       "name": names.get(vocab.entity_ref(v) or 0)}
                      for k, v in st["facets"].items()]
            klass = st["facets"].get(TYPE_PRED)
            facts.append({
                "layer": label,
                "predicate": st["predicate"],
                "label": st["label"],
                "object": st["object"],
                "object_label": _code_label(st["object"]),
                "decoded": st["decoded"],
                "entity_name": names.get(vocab.entity_ref(st["object"]) or 0),
                "statement_class": klass,
                "statement_class_label": vocab.clabel(klass) if klass else None,
                "facets": facets,
                "confidence": st["confidence"],
                "sources": vocab.source_names(st["sources"]),
                "timestamp": st["timestamp"],
            })
    if not facts:
        return {"found": False, "reason": "no facts carry this entity as their subject"}

    # what it is
    klass = None
    for f in facts:
        if f["predicate"] == TYPE_PRED and not f["facets"]:
            klass = f["object"]

    # aliases
    aliases = []
    for st in vocab.statements("stable_graph", subject=eid, predicate=ALIAS_PRED):
        aliases.append({
            "alias": st["facets"].get(ALIAS_FACET),
            "provenance": st["facets"].get(SIGNAL_FACET),
            "confidence": st["confidence"],
        })
    aliases.sort(key=lambda a: (a["provenance"] or "", a["alias"] or ""))

    # the namespaces it resolves into
    namespaces = []
    for f in facts:
        for value in [f["object"]] + [x["object"] for x in f["facets"]]:
            ns = vocab.ns_of(value)
            if ns and ns != "md" and _external(ns):
                namespaces.append({
                    "ns": ns,
                    "kind": vocab.NAMESPACES[ns][0],
                    "note": vocab.NAMESPACES[ns][1],
                    "value": value[len(ns) + 1:],
                    "predicate": f["predicate"],
                    "label": f["label"],
                    "resolves": _resolve_value(ns, value[len(ns) + 1:]),
                })
    seen, uniq = set(), []
    for n in namespaces:
        key = (n["ns"], n["value"])
        if key not in seen:
            seen.add(key)
            uniq.append(n)

    # who points at it
    ref = "md:" + str(eid)
    referrers, expired_refs = [], 0
    for table, label, live in _layers():
        for r in db.query(
            GRAPH,
            f"select subject, predicate, relationshipPredicate, confidence, timestamp "
            f"from {table} where object = ?", (ref,)
        ):
            if not live:
                expired_refs += 1
                continue
            referrers.append({
                "layer": label,
                "id": vocab.sid(r["subject"]),
                "name": names.get(r["subject"]),
                "predicate": r["predicate"],
                "label": vocab.plabel(r["predicate"]),
                "facet": r["relationshipPredicate"] or "",
                "confidence": r["confidence"],
                "timestamp": db.apple_time(r["timestamp"]),
            })
    referrers.sort(key=lambda r: (r["label"], -(r["timestamp"] or 0)))

    by_predicate = {}
    for r in referrers:
        k = (r["predicate"], r["label"], r["layer"])
        by_predicate[k] = by_predicate.get(k, 0) + 1

    expired_facts = 0
    for table, label, live in _layers():
        if live:
            continue
        expired_facts += db.one(GRAPH, f"select count(*) from {table} where subject = ?",
                                (eid,), default=0) or 0

    facts.sort(key=lambda f: (f["statement_class_label"] or "", f["label"]))
    return {
        "found": True,
        "id": vocab.sid(eid),
        "name": names.get(eid),
        "class": klass,
        "class_label": vocab.clabel(klass) if klass else None,
        "is_owner": eid == owner,
        "facts": facts,
        "fact_count": len(facts),
        "aliases": aliases,
        "namespaces": uniq,
        "referrers": referrers,
        "referrer_summary": [{"predicate": p, "label": lab, "layer": lay, "edges": n}
                             for (p, lab, lay), n in
                             sorted(by_predicate.items(), key=lambda kv: -kv[1])],
        "expired_facts": expired_facts,
        "expired_references": expired_refs,
    }


ROUTES = {"/api/identity": handler, "/api/person": person}
