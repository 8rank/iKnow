"""certainty.py — the line the store does not draw.

An inferred fact and a copied one live in the same table, in the same nine
columns, with the same predicate vocabulary. This endpoint measures the
confidence float at full resolution (never bucketed), splits the store at 1.0,
ranks what sits below it by predicate, and decodes the one
column that comes closest to answering "where did this come from": the
`sources` bitmask and the `sourceDuplicates` provenance census.

Everything below is computed from the live stores on each request.
"""

from . import db, vocab

GRAPH = "graph/graph.db"

# The four live and archived layers, in the order the page reads them.
LAYERS = [
    ("stable_graph", "stable", "the person graph"),
    ("event_graph", "event", "the calendar graph"),
    ("expired_stable_graph", "expired stable", "retracted person facts"),
    ("expired_event_graph", "expired event", "retracted calendar facts"),
]
LIVE = ("stable_graph", "event_graph")

# Bands used only where a two-dimensional grid needs a finite number of columns.
# The true-resolution histogram never touches them, and the page says so.
BANDS = [
    ("certain", "stated as certain", "1.0"),
    ("high", "0.9 up to 1.0", "0.9–1.0"),
    ("mid", "0.8 up to 0.9", "0.8–0.9"),
    ("low", "below 0.8", "<0.8"),
]

RS = chr(30)  # ASCII RECORD SEPARATOR — the sourceDuplicates delimiter


def _band(conf):
    if conf is None:
        return "low"
    if conf >= 1.0:
        return "certain"
    if conf >= 0.9:
        return "high"
    if conf >= 0.8:
        return "mid"
    return "low"


def _band_spec():
    return [{"key": k, "label": l, "short": sh} for k, l, sh in BANDS]


def _known_bits():
    """Every `sources` bit the decoder ring can name, discovered through the
    public API rather than by reaching into its table."""
    out = []
    for bit in range(63):
        names = vocab.source_names(1 << bit)
        if names:
            out.append({"bit": bit, "mask": 1 << bit, "name": names[0]})
    return out


def _layer_rows(layer):
    return db.query(GRAPH, f"select count(*) as n from {layer}")


# ---------------------------------------------------------------- panels


def _distribution():
    """Per-layer certainty split, and the histogram at its true resolution."""
    layers, hist = [], {}
    for table, label, note in LAYERS:
        rows = db.query(
            GRAPH,
            f"select confidence, count(*) as rows, count(distinct predicate) as predicates, "
            f"count(distinct subject) as entities, "
            f"sum(case when relationshipId = 0 then 1 else 0 end) as attributes, "
            f"count(distinct case when relationshipId <> 0 then relationshipId end) as statements "
            f"from {table} group by confidence order by confidence desc",
        )
        total = sum(r["rows"] for r in rows)
        certain = sum(r["rows"] for r in rows if r["confidence"] is not None and r["confidence"] >= 1.0)
        hist[table] = rows
        layers.append({
            "table": table,
            "label": label,
            "note": note,
            "rows": total,
            "certain": certain,
            "uncertain": total - certain,
            "distinct_values": len(rows),
            "min": min((r["confidence"] for r in rows), default=None),
            "max": max((r["confidence"] for r in rows), default=None),
            "live": table in LIVE,
        })
    return layers, hist


def _bands_by_layer(hist):
    out = []
    for key, label, _short in BANDS:
        row = {"key": key, "label": label, "live": 0}
        for table, lab, _note in LAYERS:
            n = sum(r["rows"] for r in hist[table] if _band(r["confidence"]) == key)
            row[table] = n
            if table in LIVE:
                row["live"] += n
        out.append(row)
    return {"bands": out, "spec": _band_spec()}


def _by_predicate(table, certain):
    """Predicate inventory on one side of the line, with the share of each that
    sits on a person rather than on an app, a place or an organisation."""
    op = ">=" if certain else "<"
    rows = db.query(
        GRAPH,
        f"select predicate, count(*) as rows, count(distinct subject) as entities, "
        f"min(confidence) as min_conf, max(confidence) as max_conf, "
        f"count(distinct confidence) as distinct_values "
        f"from {table} where confidence {op} 1.0 group by predicate order by rows desc",
    )
    people = {
        r["predicate"]: r
        for r in db.query(
            GRAPH,
            f"select predicate, count(*) as rows, count(distinct subject) as entities "
            f"from {table} where confidence {op} 1.0 and subject in "
            f"(select subject from {table} where predicate = 'PS1' and object = 'SB104') "
            f"group by predicate",
        )
    }
    for r in rows:
        r["label"] = vocab.plabel(r["predicate"])
        p = people.get(r["predicate"])
        r["person_rows"] = p["rows"] if p else 0
        r["person_entities"] = p["entities"] if p else 0
    return rows


def _subject_classes(table):
    """Which kind of entity carries the uncertain rows. The 0.8 block reads as
    alarming until you see how much of it is app metadata."""
    rows = db.query(
        GRAPH,
        f"select p.object as class_code, count(*) as rows, count(distinct s.subject) as entities "
        f"from {table} s join {table} p on p.subject = s.subject "
        f"and p.predicate = 'PS1' and p.relationshipId = 0 "
        f"where s.confidence < 1.0 group by 1 order by rows desc",
    )
    for r in rows:
        r["label"] = vocab.clabel(r["class_code"])
    return rows


def _split_predicates(table):
    """Predicates that have rows BOTH at 1.0 and below it. Different rows: the
    table's key keeps any one claim to a single row."""
    rows = db.query(
        GRAPH,
        f"select predicate, "
        f"sum(case when confidence >= 1.0 then 1 else 0 end) as certain, "
        f"sum(case when confidence < 1.0 then 1 else 0 end) as uncertain, "
        f"count(*) as rows, count(distinct subject) as entities, "
        f"count(distinct confidence) as distinct_values "
        f"from {table} group by predicate "
        f"having certain > 0 and uncertain > 0 order by rows desc",
    )
    keys = [r["predicate"] for r in rows]
    grid = {}
    if keys:
        marks = ",".join("?" * len(keys))
        for r in db.query(
            GRAPH,
            f"select predicate, confidence, count(*) as rows from {table} "
            f"where predicate in ({marks}) group by 1, 2",
            tuple(keys),
        ):
            key = (r["predicate"], _band(r["confidence"]))
            grid[key] = grid.get(key, 0) + r["rows"]
    totals = {r["predicate"]: r["rows"] for r in rows}
    cells = [
        {"predicate": p, "band": b, "rows": n,
         "share": round(n * 100.0 / totals[p], 1) if totals.get(p) else 0}
        for (p, b), n in grid.items()
    ]
    for r in rows:
        r["label"] = vocab.plabel(r["predicate"])
    only_one_side = db.one(
        GRAPH,
        f"select count(*) from (select predicate from {table} group by predicate "
        f"having sum(case when confidence >= 1.0 then 1 else 0 end) = 0 "
        f"or sum(case when confidence < 1.0 then 1 else 0 end) = 0)",
        default=0,
    )
    return {
        "rows": rows,
        "cells": cells,
        "predicates": db.one(GRAPH, f"select count(distinct predicate) from {table}", default=0),
        "one_side_only": only_one_side,
    }


def _sources():
    """The provenance decode. `sources` is a bitmask: nine of its seventeen
    observed values are multi-bit combinations, so GROUP BY on the raw column
    silently undercounts every ingest. We test bits and measure the gap."""
    bits = _known_bits()
    known_mask = 0
    for b in bits:
        known_mask |= b["mask"]

    phase = {}
    if db.has_table(GRAPH, "phase_status"):
        for r in db.query(GRAPH, "select source, status from phase_status order by source"):
            phase[r["source"]] = r["status"]

    for b in bits:
        mask = b["mask"]
        for table, label, _note in LAYERS:
            b[table] = db.one(GRAPH, f"select count(*) from {table} where (sources & ?) <> 0", (mask,), default=0)
        b["live_rows"] = b["stable_graph"] + b["event_graph"]
        b["entities"] = db.one(
            GRAPH,
            "select count(*) from (select subject from stable_graph where (sources & ?) <> 0 "
            "union select subject from event_graph where (sources & ?) <> 0)",
            (mask, mask), default=0,
        )
        b["naive_rows"] = db.one(
            GRAPH,
            "select (select count(*) from stable_graph where sources = ?) "
            "+ (select count(*) from event_graph where sources = ?)",
            (mask, mask), default=0,
        )
        b["undercount"] = b["live_rows"] - b["naive_rows"]
        b["phase_source"] = b["bit"] + 1
        b["phase_status"] = phase.get(b["bit"] + 1)
        conf = db.query(
            GRAPH,
            "select confidence, count(*) as rows from "
            "(select confidence, sources from stable_graph union all "
            " select confidence, sources from event_graph) "
            "where (sources & ?) <> 0 group by confidence order by rows desc",
            (mask,),
        )
        b["distinct_confidences"] = len(conf)
        b["modal_confidence"] = conf[0]["confidence"] if conf else None
        b["modal_rows"] = conf[0]["rows"] if conf else 0
        b["bands"] = {
            key: sum(c["rows"] for c in conf if _band(c["confidence"]) == key)
            for key, _l, _sh in BANDS
        }

    # Bits nothing in vocab can name, and rows that set none at all.
    unnamed = []
    stray = db.query(
        GRAPH,
        "select distinct sources from (select sources from stable_graph "
        "union all select sources from event_graph) where (sources & ~?) <> 0",
        (known_mask,),
    )
    seen = set()
    for r in stray:
        extra = r["sources"] & ~known_mask
        for bit in range(63):
            if extra & (1 << bit) and bit not in seen:
                seen.add(bit)
                unnamed.append({"bit": bit, "mask": 1 << bit})

    values = db.query(
        GRAPH,
        "select sources, count(*) as rows from (select sources from stable_graph "
        "union all select sources from event_graph) group by sources order by rows desc",
    )
    for v in values:
        v["names"] = vocab.source_names(v["sources"])
        v["bits"] = len(v["names"])

    named_sources = {b["phase_source"] for b in bits}
    idle = [
        {"source": src, "status": phase[src], "mask": 1 << (src - 1),
         "stable_rows": db.one(GRAPH, "select count(*) from stable_graph where (sources & ?) <> 0",
                               (1 << (src - 1),), default=0),
         "event_rows": db.one(GRAPH, "select count(*) from event_graph where (sources & ?) <> 0",
                              (1 << (src - 1),), default=0)}
        for src in sorted(phase) if src not in named_sources
    ]
    return {
        "bits": sorted(bits, key=lambda b: -b["live_rows"]),
        "unnamed_bits": unnamed,
        "zero_mask_rows": db.one(
            GRAPH,
            "select (select count(*) from stable_graph where sources = 0) "
            "+ (select count(*) from event_graph where sources = 0)", default=0),
        "values": values,
        "multi_bit_values": sum(1 for v in values if v["bits"] > 1),
        "phase_total": len(phase),
        "phase_idle": idle,
        "phase_statuses": sorted({s for s in phase.values()}),
    }


def _confidence_by_source(bits):
    """The crosstab that reframes the whole column: how much of each ingest's
    output sits in each certainty band, and how often the confidence value
    alone identifies which ingest wrote the row."""
    rows = db.query(
        GRAPH,
        "select confidence, sources, count(*) as rows from "
        "(select confidence, sources from stable_graph union all "
        " select confidence, sources from event_graph) group by 1, 2",
    )
    per_conf = {}
    live_total = 0
    for r in rows:
        live_total += r["rows"]
        slot = per_conf.setdefault(r["confidence"], {})
        for b in bits:
            if r["sources"] & b["mask"]:
                slot[b["name"]] = slot.get(b["name"], 0) + r["rows"]

    # How many live rows a "confidence -> its dominant ingest" rule would place
    # correctly. Measured, not assumed.
    dominant, hit = [], 0
    for conf, per in sorted(per_conf.items(), reverse=True):
        total = sum(r["rows"] for r in rows if r["confidence"] == conf)
        top = max(per.items(), key=lambda kv: kv[1]) if per else (None, 0)
        share = min(top[1], total)
        hit += share
        dominant.append({
            "confidence": conf, "rows": total,
            "source": top[0], "source_rows": top[1],
            "share": (share / total) if total else 0,
        })

    cells = []
    for b in bits:
        total = b["live_rows"] or 1
        for key, _label, _short in BANDS:
            n = b["bands"].get(key, 0)
            cells.append({"source": b["name"], "band": key, "rows": n,
                          "share": round(n * 100.0 / total, 1)})

    # Layers where the confidence value determines the ingest with no exception.
    exact = []
    for table, label, _note in LAYERS:
        pairs = db.query(
            GRAPH,
            f"select confidence, count(distinct sources) as masks, count(*) as rows "
            f"from {table} group by confidence",
        )
        if pairs and all(p["masks"] == 1 for p in pairs):
            exact.append({"table": table, "label": label, "note": _note,
                          "values": len(pairs), "rows": sum(p["rows"] for p in pairs)})
    return {
        "cells": cells,
        "bands": _band_spec(),
        "sources": [b["name"] for b in bits],
        "dominant": dominant,
        "rule_hits": hit,
        "rule_rows": live_total,
        "deterministic_layers": exact,
    }


def _source_duplicates(bits):
    """`sourceDuplicates` — the record-level provenance column. Never empty,
    typed and namespaced, and separated by ASCII 0x1E, not a comma.

    The same pass re-derives the bitmask decode from scratch on this device:
    on every row that sets exactly one source bit, which provenance namespaces
    appear? If a bit is really one ingest, the answer is one namespace and no
    exception — and that is testable rather than asserted."""
    per_ns = {}
    single = {b["bit"]: {} for b in bits}
    by_mask = {b["mask"]: b["bit"] for b in bits}
    totals = {"rows": 0, "empty": 0, "multi": 0, "max_refs": 0, "max_chars": 0, "refs": 0}
    hist = {}
    literal_attributed = {"stable_graph": 0, "event_graph": 0}
    dup_refs, obj_refs = {}, {}

    for table, label, _note in LAYERS:
        for r in db.query(GRAPH, f"select subject, object, sources, sourceDuplicates from {table}"):
            cell = r["sourceDuplicates"]
            lone = by_mask.get(r["sources"])
            totals["rows"] += 1
            if not cell:
                totals["empty"] += 1
                continue
            parts = cell.split(RS)
            hist[len(parts)] = hist.get(len(parts), 0) + 1
            totals["refs"] += len(parts)
            totals["max_refs"] = max(totals["max_refs"], len(parts))
            totals["max_chars"] = max(totals["max_chars"], len(cell))
            if len(parts) > 1:
                totals["multi"] += 1
            seen = set()
            for part in parts:
                ns = vocab.ns_of(part) or "(unrecognised)"
                dup_refs.setdefault(ns, set()).add(part)
                slot = per_ns.setdefault(ns, {
                    "ns": ns, "rows": 0, "entities": set(), "records": set(),
                    "multi_rows": 0, "layers": {},
                })
                if ns not in seen:
                    slot["rows"] += 1
                    slot["layers"][table] = slot["layers"].get(table, 0) + 1
                    if len(parts) > 1:
                        slot["multi_rows"] += 1
                    seen.add(ns)
                    if lone is not None:
                        single[lone][ns] = single[lone].get(ns, 0) + 1
                slot["entities"].add(r["subject"])
                slot["records"].add(part)
            # A row whose object is a plain literal — a name, a date, a number —
            # still names the exact source record it was copied out of.
            obj_ns = vocab.ns_of(r["object"])
            if obj_ns:
                obj_refs.setdefault(obj_ns, set()).add(r["object"])
            elif table in literal_attributed:
                literal_attributed[table] += 1

    totals_by_ns = {ns: slot["rows"] for ns, slot in per_ns.items()}
    proof = []
    for b in bits:
        seen = sorted(single[b["bit"]].items(), key=lambda kv: -kv[1])
        ns = seen[0][0] if seen else None
        layer_total = sum(b[t] for t, _l, _n in LAYERS)
        proof.append({
            "bit": b["bit"], "mask": b["mask"], "name": b["name"],
            "namespace": ns,
            "namespaces": len(seen),
            "single_bit_rows": sum(n for _ns, n in seen),
            "exclusive": len(seen) == 1,
            "namespace_rows": totals_by_ns.get(ns, 0),
            "bit_rows": layer_total,
            "agrees": totals_by_ns.get(ns, 0) == layer_total,
        })

    rows = []
    for ns, slot in per_ns.items():
        info = vocab.NAMESPACES.get(ns)
        rows.append({
            "ns": ns,
            "kind": info[0] if info else "unknown",
            "note": info[1] if info else "not in the namespace allowlist",
            "rows": slot["rows"],
            "entities": len(slot["entities"]),
            "records": len(slot["records"]),
            "multi_rows": slot["multi_rows"],
            "layers": slot["layers"],
            "only_in_provenance": len(dup_refs.get(ns, set()) - obj_refs.get(ns, set())),
        })
    rows.sort(key=lambda r: -r["rows"])

    # Does the provenance column reach records the object column never names?
    # Measured across every namespace, in both directions.
    only_dup = sum(len(v - obj_refs.get(k, set())) for k, v in dup_refs.items())
    only_obj = sum(len(v - dup_refs.get(k, set())) for k, v in obj_refs.items()
                   if k in dup_refs)
    return {
        "rows": rows,
        "proof": proof,
        "totals": totals,
        "refs_per_cell": sorted(({"refs": k, "rows": v} for k, v in hist.items()),
                                key=lambda d: -d["rows"]),
        "literal_attributed": literal_attributed,
        "only_in_provenance": only_dup,
        "only_in_object": only_obj,
        "provenance_namespaces": len(dup_refs),
    }


def _dossier():
    """Sort the store by confidence and read the top. This measures what that
    list is made of — not who is on it."""
    top = db.one(GRAPH, "select max(confidence) from stable_graph")
    rows = db.one(GRAPH, "select count(*) from stable_graph where confidence >= ?", (top,), default=0)
    entities = db.one(GRAPH, "select count(distinct subject) from stable_graph where confidence >= ?", (top,), default=0)
    people = db.one(
        GRAPH,
        "select count(distinct subject) from stable_graph where confidence >= ? and subject in "
        "(select subject from stable_graph where predicate = 'PS1' and object = 'SB104')",
        (top,), default=0)
    named = db.one(
        GRAPH,
        "select count(distinct subject) from stable_graph where confidence >= ? and predicate = 'PS33'",
        (top,), default=0)
    reachable = db.one(
        GRAPH,
        "select count(distinct subject) from stable_graph where confidence >= ? and predicate = 'PS520'",
        (top,), default=0)
    return {
        "threshold": top, "rows": rows, "entities": entities,
        "people": people, "named": named, "reachable": reachable,
        "owner_marked": db.one(
            GRAPH,
            "select count(*) from stable_graph where predicate = ? and confidence >= ?",
            (vocab.OWNER_PREDICATE, top), default=0),
        "derivation_columns": [
            c["name"] for c in db.query(GRAPH, "pragma table_info(stable_graph)")
        ],
    }


def handler(params):
    layers, hist = _distribution()
    bits = _sources()
    live_rows = sum(l["rows"] for l in layers if l["live"])
    live_certain = sum(l["certain"] for l in layers if l["live"])
    return {
        "layers": layers,
        "live": {
            "rows": live_rows,
            "certain": live_certain,
            "uncertain": live_rows - live_certain,
            "values": db.one(
                GRAPH,
                "select count(distinct confidence) from (select confidence from stable_graph "
                "union all select confidence from event_graph)", default=0),
        },
        "hist": hist,
        "bands": _bands_by_layer(hist),
        "certain_by_pred": _by_predicate("stable_graph", True),
        "uncertain_by_pred": _by_predicate("stable_graph", False),
        "subject_classes": _subject_classes("stable_graph"),
        "split": _split_predicates("stable_graph"),
        "sources": bits,
        "conf_source": _confidence_by_source(bits["bits"]),
        "duplicates": _source_duplicates(bits["bits"]),
        "dossier": _dossier(),
    }


ROUTES = {"/api/certainty": handler}
