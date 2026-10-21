"""faces.py — the Photos face layer: what the graph points at, and what it can name.

The graph binds people to Photos face clusters through a reified statement
(`nm_hasVisualIdentifier`) whose identifier facet carries a *plaintext* Photos
person UUID, plus the same identifier again under `same as` and under
`identifier`. That namespace is easy to take for a 32-byte one-way token. This
endpoint runs the resolution itself, and everything it reports is measured at
request time:

  * the anatomy of the identifier — length, character set, the constant scope
    suffix, and what a lenient base64 decode actually yields — so the page can
    show *why* the opaque-token reading was wrong rather than assert it;
  * the resolution rate of every graph-side carrier against `ZPERSON`;
  * the naming funnel: of the clusters the graph references, how many carry a
    name, a contact card, a dialable handle, a kinship score, so the page can
    show how many clusters are really joined to names, phones and family scores;
  * cluster sizes computed from the real `ZDETECTEDFACE` join, never from the
    stale `ZFACECOUNT` cache, with the size of the disagreement reported;
  * the face co-occurrence graph — who appears in photographs with whom. This is
    a second social network, built with no names in it at all;
  * the soft-biometric attribute columns, as *coverage*, never as a profile;
  * the location columns, which exist and hold one sentinel value on every row;
  * photo/video volume over time, the auto-written Memories, and the scene
    classifier reached through the two-hop path it actually requires.

No row value is written into this file. Every number, name, code and date on the
page comes out of the stores when the request is served.
"""

import base64
import os
import re
from collections import Counter

from . import db, vocab

# ---------------------------------------------------------------- stores

PHOTOS = "sources/Photos.sqlite"
GRAPH = "graph/graph.db"
MESSAGES = "sources/chat.db"

# Graph-side stores that carry the face-cluster identifier, in the order a
# resolver would meet them: the triple store first, then its projections.
TRIPLE_CARRIERS = (
    (GRAPH, "stable_graph", "the personal triple store"),
    ("graph/Artifacts__visualIdentifier__visualIdentifier.db", "people",
     "the visual-identifier projection"),
    ("graph/Artifacts__photosAutonaming__photosAutonaming.db", "subgraph",
     "the photo-autonaming projection"),
)
# ...and the flat map, which is a different shape: one token, one entity id.
ID_MAP = ("graph/Artifacts__internal__views.db", "phperson_id_map",
          "phPersonIdentifier", "id", "the entity-id map")

REJECTIONS = ("graph/Artifacts__photosAutonaming__photosAutonaming.db", "rejections")

# ---------------------------------------------------------------- vocabulary

NS = "phPerson"                       # namespace head, from vocab.NAMESPACES
SAME_AS = "PS102"                     # 'same as' — the whole cross-store join
VISUAL = "nm_hasVisualIdentifier"     # the reified face statement
VISUAL_FACET = "nm_visualIdentifier"  # ...its identifier facet
REASON_FACET = "nm_associationReason"
CLASS_FACET = "PS1"
IDENTIFIER = "PS72"
CONTACT_INFO = "PS520"
PERSON_TYPE = "nm_personType"
DETECTION_TYPE = "nm_photosDetectionType"
LAYERS = ("stable_graph", "event_graph", "expired_stable_graph", "expired_event_graph")

# ---------------------------------------------------------------- Photos schema

# The soft-biometric columns Photos declares on a detected face. 0 is this
# schema's "not computed" sentinel on every one of them, so the page charts
# COVERAGE (computed vs not) and never a distribution over the codes: no
# code->label table ships anywhere in the bundle, so a "demographics" chart
# would be inventing the meaning of integers.
FACE_ATTRS = (
    ("ZAGETYPE", "apparent age"),
    ("ZGENDERTYPE", "apparent gender"),
    ("ZETHNICITYTYPE", "apparent ethnicity"),
    ("ZSKINTONETYPE", "skin tone"),
    ("ZHAIRCOLORTYPE", "hair colour"),
    ("ZHAIRTYPE", "hair type"),
    ("ZFACIALHAIRTYPE", "facial hair"),
    ("ZGLASSESTYPE", "glasses"),
    ("ZHEADGEARTYPE", "headgear"),
    ("ZEYESSTATE", "eyes open or shut"),
    ("ZGAZETYPE", "gaze direction"),
    ("ZFACEEXPRESSIONTYPE", "expression"),
    ("ZSMILETYPE", "smile type"),
    ("ZPOSETYPE", "head pose"),
    ("ZEYEMAKEUPTYPE", "eye make-up"),
    ("ZLIPMAKEUPTYPE", "lip make-up"),
)
# Genuine booleans, not sentinel-coded: 0 means "no", not "not computed".
FACE_FLAGS = (("ZHASSMILE", "is smiling"), ("ZHASFACEMASK", "wearing a face mask"))

# The same inference, rolled up to the cluster — i.e. to the person.
PERSON_ATTRS = (("ZAGETYPE", "apparent age"), ("ZGENDERTYPE", "apparent gender"))

TOP_CLUSTERS = 28        # the leaderboard cap, restated on screen
TOP_CACHE_GAPS = 14      # the cache-disagreement cap, restated on screen
TOP_SCENES = 18          # the scene-code cap, restated on screen
TOP_SENTINELS = 8        # the derived/sentinel-code cap, restated on screen
DEFAULT_SCENE_CONF = 0.5
DEFAULT_MIN_SHARED = 1   # the network is shipped whole and filtered in the page


# ---------------------------------------------------------------- helpers


def _marks(n):
    return ",".join("?" * n)


def _cols(rel, table):
    """The column names of one table, or an empty set when it is absent."""
    conn = db.connect(rel)
    if conn is None:
        return set()
    try:
        return {r[1] for r in conn.execute(f"pragma table_info({table})")}
    except Exception:
        return set()


def _common_suffix(values):
    """The longest suffix shared by every value.

    The face identifier is a UUID followed by a library-scope marker. Rather
    than hard-coding either length, measure the constant tail: it is the part
    every value agrees on, and what precedes it is the part that identifies a
    cluster. Returns '' when the values share no tail.
    """
    if not values:
        return ""
    shortest = min(len(v) for v in values)
    keep = 0
    for i in range(1, shortest):
        tail = values[0][-i:]
        if all(v.endswith(tail) for v in values):
            keep = i
        else:
            break
    # A suffix that swallows the whole value tells us nothing.
    if keep >= shortest:
        return ""
    return values[0][-keep:] if keep else ""


def _strip_ns(value):
    head = NS + ":"
    return value[len(head):] if value.startswith(head) else value


def _head(value, scope):
    """One stored object -> the bare cluster identifier it carries.

    Two forms of the same identifier are in circulation: namespace-prefixed
    under `same as`, and bare inside the reified statement and the projections.
    Both end in the same constant library-scope marker.
    """
    bare = _strip_ns(value)
    return bare[:len(bare) - len(scope)] if scope and bare.endswith(scope) else bare


def _b64_len(value):
    """Bytes a lenient base64 decode yields, or None if it will not decode.

    This is the measurement that falsifies the opaque-token reading: a base64
    encoding of a 32-byte hash decodes to 32 bytes. Characters outside the
    base64 alphabet are silently dropped by the decoder, so a plaintext value
    that merely happens to be the right length decodes to something else.
    """
    pad = value + "=" * ((4 - len(value) % 4) % 4)
    try:
        return len(base64.b64decode(pad, validate=False))
    except Exception:
        return None


# ---------------------------------------------------------------- the reference


def _references():
    """Every face-cluster reference the graph holds, and its shape."""
    prefixed = [r["object"] for r in db.query(
        GRAPH,
        "select distinct object from stable_graph where predicate = ? and object like ?",
        (SAME_AS, NS + ":%"),
    )]
    # The same identifier without the namespace head, as the reified facet and
    # the projections store it.
    bare = [r["object"] for r in db.query(
        GRAPH,
        "select distinct object from stable_graph "
        "where predicate = ? and relationshipPredicate = ?",
        (VISUAL, VISUAL_FACET),
    )]
    return prefixed, bare


def _layer_spread(values):
    """Which of the four graph layers the references live in.

    Contacts and face references sit only in the stable layer; calendar
    references reach the retracted ones. Worth measuring rather than assuming,
    because a reference in an `expired_` layer describes a fact the graph has
    already withdrawn and must never be drawn as current.
    """
    out = []
    ordered = sorted(values)
    for layer in LAYERS:
        if not db.has_table(GRAPH, layer):
            continue
        n = 0
        for chunk in range(0, len(ordered), 400):
            part = ordered[chunk:chunk + 400]
            n += db.one(
                GRAPH,
                f"select count(*) from {layer} where object in ({_marks(len(part))})",
                tuple(part), default=0)
        out.append({"layer": layer, "rows": n,
                    "retracted": layer.startswith("expired_")})
    return out


def _anatomy(values):
    """What the identifier is actually made of — measured, not asserted."""
    if not values:
        return None
    lens = sorted({len(v) for v in values})
    charset = sorted({c for v in values for c in v})
    scope = _common_suffix(values)
    heads = [v[:len(v) - len(scope)] if scope else v for v in values]
    b64 = Counter(_b64_len(v) for v in values)
    masked = Counter()
    for v in values:
        masked["".join("x" if c in "0123456789abcdefABCDEF" else c for c in v)] += 1
    return {
        "values": len(values),
        "lengths": lens,
        "charset": "".join(charset),
        "charset_size": len(charset),
        "base64_alphabet_size": 64,
        "scope": scope,
        "scope_len": len(scope),
        "scopes_distinct": len({v[len(v) - len(scope):] for v in values}) if scope else 0,
        "head_len": sorted({len(h) for h in heads}),
        "heads_distinct": len(set(heads)),
        "b64_decoded_bytes": sorted(k for k in b64 if k is not None),
        "sha256_bytes": 32,
        "masked_shapes": [{"shape": s, "n": n} for s, n in masked.most_common(3)],
    }


def _resolution(heads):
    """Does each graph-side carrier's identifier reach a row in Photos?"""
    known = set()
    if heads and db.has_table(PHOTOS, "ZPERSON"):
        for chunk in range(0, len(heads), 400):
            part = heads[chunk:chunk + 400]
            known |= {r["ZPERSONUUID"] for r in db.query(
                PHOTOS,
                f"select ZPERSONUUID from ZPERSON where ZPERSONUUID in ({_marks(len(part))})",
                tuple(part),
            )}
    return known


def _carriers(all_values, scope, known):
    """Per-store: how many identifiers it carries and how many of them resolve."""
    out = []
    values = sorted(all_values)
    for rel, table, blurb in TRIPLE_CARRIERS:
        if not db.has_table(rel, table):
            out.append({"store": rel, "table": table, "blurb": blurb,
                        "present": False, "rows": 0, "identifiers": 0,
                        "forms": 0, "resolved": 0, "predicates": []})
            continue
        rows = []
        for chunk in range(0, len(values), 400):
            part = values[chunk:chunk + 400]
            rows += db.query(
                rel,
                f"select predicate, relationshipPredicate, object, count(*) n "
                f"from {table} where object in ({_marks(len(part))}) "
                f"group by 1, 2, 3",
                tuple(part),
            )
        per_pred = Counter()
        seen = set()
        for r in rows:
            per_pred[(r["predicate"], r["relationshipPredicate"] or "")] += r["n"]
            seen.add(r["object"])
        heads = {_head(v, scope) for v in seen}
        out.append({
            "store": rel, "table": table, "blurb": blurb, "present": True,
            "rows": sum(per_pred.values()), "identifiers": len(heads),
            "forms": len(seen), "resolved": len(heads & known),
            "predicates": [{
                "predicate": p, "label": vocab.plabel(p),
                "facet": f, "facet_label": vocab.plabel(f) if f else "",
                "n": n,
            } for (p, f), n in per_pred.most_common()],
        })

    rel, table, col, idcol, blurb = ID_MAP
    if db.has_table(rel, table):
        rows = db.query(rel, f"select {col} as token, {idcol} as entity_id from {table}")
        heads = {_head(r["token"], scope) for r in rows}
        out.append({
            "store": rel, "table": table, "blurb": blurb, "present": True,
            "rows": len(rows), "identifiers": len(heads),
            "forms": len({r["token"] for r in rows}),
            "resolved": len(heads & known),
            "entities": len({r["entity_id"] for r in rows}),
            "predicates": [],
        })
    else:
        out.append({"store": rel, "table": table, "blurb": blurb, "present": False,
                    "rows": 0, "identifiers": 0, "forms": 0, "resolved": 0,
                    "predicates": []})
    return out


def _statement_shape(subjects):
    """The reified face statement: its facets, confidence, ingest source, reasons."""
    rows = db.query(
        GRAPH,
        "select relationshipPredicate as facet, count(*) n, "
        "count(distinct object) distinct_objects, count(distinct subject) subjects, "
        "min(confidence) lo, max(confidence) hi, sources "
        "from stable_graph where predicate = ? group by 1",
        (VISUAL,),
    )
    facets = [{
        "facet": r["facet"], "label": vocab.plabel(r["facet"]) if r["facet"] else "",
        "n": r["n"], "distinct_objects": r["distinct_objects"],
        "subjects": r["subjects"], "confidence_lo": r["lo"], "confidence_hi": r["hi"],
        "sources": vocab.source_names(r["sources"]),
    } for r in sorted(rows, key=lambda r: -r["n"])]

    reasons = [{"reason": r["object"], "n": r["n"]} for r in db.query(
        GRAPH,
        "select object, count(*) n from stable_graph "
        "where predicate = ? and relationshipPredicate = ? group by 1 order by n desc",
        (VISUAL, REASON_FACET),
    )]

    extra = {}
    for pred in (PERSON_TYPE, DETECTION_TYPE):
        extra[pred] = {
            "label": vocab.plabel(pred),
            "values": [{"value": r["object"], "n": r["n"]} for r in db.query(
                GRAPH,
                "select object, count(*) n from stable_graph where predicate = ? "
                "and subject in (" + _marks(len(subjects)) + ") group by 1 order by n desc",
                (pred,) + tuple(subjects),
            )],
        }

    rel, table = REJECTIONS
    rejections = db.one(rel, f"select count(*) from {table}", default=None) \
        if db.has_table(rel, table) else None

    return {"facets": facets, "reasons": reasons, "extra": extra,
            "rejections": rejections, "rejections_table": table}


def _naming_funnel(subjects, binding, known):
    """Of the referenced clusters, what else the graph can attach to each one.

    The page is built on this count: how many of the clusters are actually
    joined to a name, a phone and a family score.
    """
    keys = (("cluster", "a Photos face cluster"),
            ("score", "a kinship / closeness score"),
            ("name", "a name of any kind"),
            ("card", "a Contacts card reference"),
            ("handle", "a phone or mail handle"),
            ("complete", "face + name + card + handle together"))
    if not subjects:
        # A device with no face references is a real state, not an error. Return
        # the same shape with zeros so the page renders an honest empty funnel
        # instead of losing its footing on a missing key.
        return {"total": 0, "named_in_graph": 0, "named_in_photos": 0,
                "named_anywhere": 0, "resolved_in_photos": 0,
                "steps": [{"key": k, "label": l, "n": 0} for k, l in keys],
                "per_name_predicate": [{"predicate": p, "label": vocab.plabel(p),
                                        "subjects": 0} for p in vocab.NAME_PREDICATES],
                "scored_table": "entity_tagging"}
    marks = _marks(len(subjects))
    subj = tuple(subjects)

    def had(sql, params):
        return db.one(GRAPH, sql, params, default=0)

    name_preds = vocab.NAME_PREDICATES
    n_name = had(
        f"select count(distinct subject) from stable_graph where subject in ({marks}) "
        f"and predicate in ({_marks(len(name_preds))}) and object <> ''",
        subj + tuple(name_preds))
    n_card = had(
        f"select count(distinct subject) from stable_graph where subject in ({marks}) "
        f"and predicate = ? and object like ?", subj + (SAME_AS, "cnContact:%"))
    n_handle = had(
        f"select count(distinct subject) from stable_graph where subject in ({marks}) "
        f"and predicate = ?", subj + (CONTACT_INFO,))

    et_rel = "graph/Artifacts__entityTagging__entityTagging.db"
    n_score = 0
    if db.has_table(et_rel, "entity_tagging"):
        n_score = db.one(
            et_rel,
            f"select count(*) from entity_tagging where cast(mdid as integer) in ({marks})",
            subj, default=0)

    per_name_pred = [{
        "predicate": p, "label": vocab.plabel(p),
        "subjects": had(
            f"select count(distinct subject) from stable_graph where subject in ({marks}) "
            f"and predicate = ? and object <> ''", subj + (p,)),
    } for p in name_preds]

    # The fully joined case: a cluster that has a face AND a card AND a name AND
    # a dialable handle on the same node.
    complete = had(
        f"select count(distinct s.subject) from stable_graph s where s.subject in ({marks}) "
        f"and exists (select 1 from stable_graph a where a.subject = s.subject "
        f"            and a.predicate = ? and a.object like ?) "
        f"and exists (select 1 from stable_graph b where b.subject = s.subject "
        f"            and b.predicate in ({_marks(len(name_preds))}) and b.object <> '') "
        f"and exists (select 1 from stable_graph c where c.subject = s.subject "
        f"            and c.predicate = ?)",
        subj + (SAME_AS, "cnContact:%") + tuple(name_preds) + (CONTACT_INFO,))

    # Named on either side of the join, counted once per cluster: the graph's
    # own name predicates, or a name typed into Photos against that cluster.
    named_graph = {r["subject"] for r in db.query(
        GRAPH,
        f"select distinct subject from stable_graph where subject in ({marks}) "
        f"and predicate in ({_marks(len(name_preds))}) and object <> ''",
        subj + tuple(name_preds))}
    photos_named_uuids = set()
    heads = sorted({binding[s] for s in subjects if s in binding})
    if heads and db.has_table(PHOTOS, "ZPERSON"):
        for chunk in range(0, len(heads), 400):
            part = heads[chunk:chunk + 400]
            photos_named_uuids |= {r["ZPERSONUUID"] for r in db.query(
                PHOTOS,
                f"select ZPERSONUUID from ZPERSON where ZPERSONUUID in ({_marks(len(part))}) "
                f"and ZFULLNAME is not null and ZFULLNAME <> ''", tuple(part))}
    named_photos = {s for s in subjects if binding.get(s) in photos_named_uuids}
    named_anywhere = named_graph | named_photos

    return {
        "total": len(subjects),
        "named_in_graph": len(named_graph),
        "named_in_photos": len(named_photos),
        "named_anywhere": len(named_anywhere),
        "resolved_in_photos": len(known),
        "steps": [{"key": k, "label": l, "n": n} for (k, l), n in zip(
            keys, (len(subjects), n_score, n_name, n_card, n_handle, complete))],
        "per_name_predicate": per_name_pred,
        "scored_table": "entity_tagging",
    }


# ---------------------------------------------------------------- Photos side


def _clusters(known_heads):
    """Every face cluster in Photos, sized by the REAL join, not the cache.

    ZFACECOUNT is a stale cache. Both numbers come back so the page can show how
    far apart they are; nothing is ever charted from the cached one.
    """
    if not db.has_table(PHOTOS, "ZPERSON"):
        return None
    rows = db.query(PHOTOS, """
        select p.Z_PK as pk, p.ZPERSONUUID as uuid,
               p.ZFACECOUNT as cached,
               count(df.Z_PK) as faces,
               count(distinct df.ZASSETFORFACE) as assets,
               p.ZDETECTIONTYPE as detection, p.ZVERIFIEDTYPE as verified,
               case when p.ZFULLNAME is not null and p.ZFULLNAME <> '' then 1 else 0 end as named,
               case when p.ZCONTACTMATCHINGDICTIONARY is not null then 1 else 0 end as card,
               min(a.ZDATECREATED) as first_s, max(a.ZDATECREATED) as last_s
        from ZPERSON p
        left join ZDETECTEDFACE df on df.ZPERSONFORFACE = p.Z_PK
        left join ZASSET a on a.Z_PK = df.ZASSETFORFACE
        group by p.Z_PK
    """)
    for r in rows:
        r["referenced"] = 1 if r["uuid"] in known_heads else 0
        r["first"] = db.apple_time(r["first_s"])
        r["last"] = db.apple_time(r["last_s"])
        r.pop("first_s", None)
        r.pop("last_s", None)

    live = [r for r in rows if r["faces"] > 0]
    live.sort(key=lambda r: (-r["faces"], r["pk"]))
    refd = [r for r in live if r["referenced"]]

    disagree = [r for r in rows if (r["cached"] or 0) != r["faces"]]
    disagree.sort(key=lambda r: -abs((r["cached"] or 0) - r["faces"]))

    def trim(r):
        return {
            "id": r["pk"], "prefix": (r["uuid"] or "")[:6],
            "faces": r["faces"], "cached": r["cached"] or 0, "assets": r["assets"],
            "referenced": r["referenced"], "named": r["named"], "card": r["card"],
            "verified": r["verified"], "detection": r["detection"],
            "first": r["first"], "last": r["last"],
        }

    face_rows = db.one(PHOTOS, "select count(*) from ZDETECTEDFACE", default=0)
    linked = db.one(PHOTOS,
                    "select count(*) from ZDETECTEDFACE where ZPERSONFORFACE is not null",
                    default=0)
    with_asset = db.one(PHOTOS,
                        "select count(*) from ZDETECTEDFACE where ZASSETFORFACE is not null",
                        default=0)
    prints = db.query(PHOTOS, "select count(*) n, sum(length(ZDATA)) bytes "
                              "from ZDETECTEDFACEPRINT") \
        if db.has_table(PHOTOS, "ZDETECTEDFACEPRINT") else [{"n": 0, "bytes": 0}]

    verified = [{"code": r["ZVERIFIEDTYPE"], "n": r["n"]} for r in db.query(
        PHOTOS, "select ZVERIFIEDTYPE, count(*) n from ZPERSON group by 1 order by n desc")]
    verified_refd = Counter(r["verified"] for r in refd)

    return {
        "person_rows": len(rows),
        "with_faces": len(live),
        "empty": len(rows) - len(live),
        "named_in_photos": sum(r["named"] for r in rows),
        "with_contact_dict": sum(r["card"] for r in rows),
        "referenced": len(refd),
        "referenced_faces": sum(r["faces"] for r in refd),
        "referenced_assets": sum(r["assets"] for r in refd),
        "referenced_named": sum(r["named"] for r in refd),
        "face_rows": face_rows,
        "faces_clustered": linked,
        "faces_with_asset": with_asset,
        "faceprints": {"n": prints[0]["n"] or 0, "bytes": prints[0]["bytes"] or 0},
        "cache": {
            "disagree": len(disagree),
            "disagree_under": sum(1 for r in disagree if (r["cached"] or 0) < r["faces"]),
            "disagree_over": sum(1 for r in disagree if (r["cached"] or 0) > r["faces"]),
            "cached_total": sum((r["cached"] or 0) for r in rows),
            "real_total": sum(r["faces"] for r in rows),
            "disagree_referenced": sum(1 for r in refd if r["cached"] != r["faces"]),
            "worst": [trim(r) for r in disagree[:TOP_CACHE_GAPS]],
            "cap": TOP_CACHE_GAPS,
        },
        "verified_codes": verified,
        "verified_referenced": [{"code": c, "n": n}
                                for c, n in sorted(verified_refd.items(), key=lambda kv: -kv[1])],
        "top": [trim(r) for r in live[:TOP_CLUSTERS]],
        "top_referenced": [trim(r) for r in refd[:TOP_CLUSTERS]],
        "cap": TOP_CLUSTERS,
    }


def _biometrics():
    """Coverage of the soft-biometric columns. Never a distribution over codes."""
    if not db.has_table(PHOTOS, "ZDETECTEDFACE"):
        return None
    have = _cols(PHOTOS, "ZDETECTEDFACE")
    total = db.one(PHOTOS, "select count(*) from ZDETECTEDFACE", default=0)

    per_face = []
    for col, label in FACE_ATTRS:
        if col not in have:
            per_face.append({"column": col, "label": label, "present": False,
                             "computed": 0, "total": total, "distinct": 0})
            continue
        r = db.query(PHOTOS, f"select sum(case when {col} <> 0 then 1 else 0 end) computed, "
                             f"count(distinct {col}) distinct_codes from ZDETECTEDFACE")[0]
        per_face.append({
            "column": col, "label": label, "present": True,
            "computed": r["computed"] or 0, "total": total,
            "distinct": r["distinct_codes"] or 0,
        })

    flags = []
    for col, label in FACE_FLAGS:
        if col not in have:
            continue
        r = db.query(PHOTOS, f"select sum(case when {col} <> 0 then 1 else 0 end) yes, "
                             f"count(distinct {col}) d from ZDETECTEDFACE")[0]
        flags.append({"column": col, "label": label, "yes": r["yes"] or 0,
                      "total": total, "distinct": r["d"] or 0})

    # Do the attribute columns move together? If the "computed" set is identical
    # across all of them, the analysis is one per-face pass, not per attribute.
    live = [c for c, _ in FACE_ATTRS if c in have]
    block = None
    if live:
        any_expr = " or ".join(f"{c} <> 0" for c in live)
        all_expr = " and ".join(f"{c} = 0" for c in live)
        r = db.query(PHOTOS, f"select sum(case when {any_expr} then 1 else 0 end) any_computed, "
                             f"sum(case when {all_expr} then 1 else 0 end) none_computed "
                             f"from ZDETECTEDFACE")[0]
        block = {"any": r["any_computed"] or 0, "none": r["none_computed"] or 0,
                 "columns": len(live)}

    person_total = db.one(PHOTOS, "select count(*) from ZPERSON", default=0)
    pcols = _cols(PHOTOS, "ZPERSON")
    per_person = []
    for col, label in PERSON_ATTRS:
        if col not in pcols:
            continue
        n = db.one(PHOTOS, f"select count(*) from ZPERSON where {col} <> 0", default=0)
        per_person.append({"column": col, "label": label, "computed": n,
                           "total": person_total})

    # The bounded negative behind "the codes stay numeric": the only label table
    # in this store, and how many of its rows carry a human-readable alias.
    vocab_probe = None
    if db.has_table(PHOTOS, "ZGRAPHLABEL") and "ZALIAS" in _cols(PHOTOS, "ZGRAPHLABEL"):
        r = db.query(PHOTOS, "select count(*) rows, "
                             "sum(case when ZALIAS is not null and ZALIAS <> '' then 1 else 0 end) aliased "
                             "from ZGRAPHLABEL")[0]
        vocab_probe = {"table": "ZGRAPHLABEL", "rows": r["rows"] or 0,
                       "aliased": r["aliased"] or 0}

    return {"face_rows": total, "per_face": per_face, "flags": flags, "block": block,
            "per_person": per_person, "person_rows": person_total,
            "label_table": vocab_probe}


def _geography():
    """The location columns, and how many assets carry a usable latitude."""
    if not db.has_table(PHOTOS, "ZASSET"):
        return None
    acols = _cols(PHOTOS, "ZASSET")
    out = {"assets": db.one(PHOTOS, "select count(*) from ZASSET", default=0), "columns": [],
           # A range check only: a latitude outside [-90, 90] cannot be a place.
           "with_latitude": db.one(PHOTOS, "select count(*) from ZASSET "
                                           "where ZLATITUDE between -90 and 90", default=0)
                            if "ZLATITUDE" in acols else None}
    for col in ("ZLATITUDE", "ZLONGITUDE"):
        if col not in acols:
            continue
        r = db.query(PHOTOS, f"select count(distinct {col}) d, min({col}) lo, max({col}) hi, "
                             f"sum(case when {col} is null then 1 else 0 end) nulls from ZASSET")[0]
        out["columns"].append({"column": col, "distinct": r["d"] or 0,
                               "lo": r["lo"], "hi": r["hi"], "nulls": r["nulls"] or 0})
    if "ZLOCATIONDATA" in acols:
        out["columns"].append({
            "column": "ZLOCATIONDATA",
            "distinct": db.one(PHOTOS, "select count(distinct ZLOCATIONDATA) from ZASSET", default=0),
            "lo": None, "hi": None,
            "nulls": db.one(PHOTOS, "select count(*) from ZASSET where ZLOCATIONDATA is null",
                            default=0),
        })

    zones = []
    if db.has_table(PHOTOS, "ZADDITIONALASSETATTRIBUTES") and \
            "ZTIMEZONENAME" in _cols(PHOTOS, "ZADDITIONALASSETATTRIBUTES"):
        zones = [{"zone": r["ZTIMEZONENAME"], "n": r["n"]} for r in db.query(
            PHOTOS,
            "select ZTIMEZONENAME, count(*) n from ZADDITIONALASSETATTRIBUTES "
            "where ZTIMEZONENAME is not null and ZTIMEZONENAME <> '' "
            "group by 1 order by n desc")]
    out["timezones"] = zones
    out["timezone_rows"] = sum(z["n"] for z in zones)
    return out


def _timeline():
    """Photo and video volume per month, with the distinct clusters seen."""
    if not db.has_table(PHOTOS, "ZASSET"):
        return []
    return [{
        "month": r["month"], "assets": r["assets"], "videos": r["videos"],
        "people": r["people"], "assets_with_face": r["with_face"],
    } for r in db.query(PHOTOS, """
        select strftime('%Y-%m', a.ZDATECREATED + 978307200, 'unixepoch') as month,
               count(distinct a.Z_PK) as assets,
               count(distinct case when a.ZKIND = 1 then a.Z_PK end) as videos,
               count(distinct df.ZPERSONFORFACE) as people,
               count(distinct case when df.ZPERSONFORFACE is not null then a.Z_PK end) as with_face
        from ZASSET a
        left join ZDETECTEDFACE df on df.ZASSETFORFACE = a.Z_PK
        where a.ZDATECREATED is not null and a.ZTRASHEDSTATE = 0
        group by 1 order by 1
    """)]


def _memories():
    """The narratives the device wrote by itself, and what happened to them."""
    if not db.has_table(PHOTOS, "ZMEMORY"):
        return None
    have = _cols(PHOTOS, "ZMEMORY")

    def col(name, expr):
        return expr if name in have else "0"

    totals = db.query(PHOTOS, f"""
        select count(*) n,
               sum(case when ZTITLE is not null and ZTITLE <> '' then 1 else 0 end) titled,
               sum({col('ZVIEWCOUNT', 'ZVIEWCOUNT')}) views,
               sum(case when {col('ZVIEWCOUNT', 'ZVIEWCOUNT')} > 0 then 1 else 0 end) viewed_rows,
               sum(case when {col('ZREJECTED', 'ZREJECTED')} <> 0 then 1 else 0 end) rejected_rows,
               sum({col('ZPLAYCOUNT', 'ZPLAYCOUNT')}) plays,
               sum(case when {col('ZPLAYCOUNT', 'ZPLAYCOUNT')} > 0 then 1 else 0 end) played_rows,
               sum(case when {col('ZSHARECOUNT', 'ZSHARECOUNT')} > 0 then 1 else 0 end) shared_rows,
               sum(case when {col('ZLASTVIEWEDDATE', 'ZLASTVIEWEDDATE')} is not null then 1 else 0 end) with_view_date
        from ZMEMORY
    """)[0]

    by_cat = [{
        "category": r["cat"], "subcategory": r["sub"], "n": r["n"],
        "views": r["views"] or 0, "rejected": r["rejected"] or 0,
        "plays": r["plays"] or 0, "titled": r["titled"] or 0,
        "first": db.apple_time(r["first_s"]), "last": db.apple_time(r["last_s"]),
    } for r in db.query(PHOTOS, f"""
        select ZCATEGORY cat, ZSUBCATEGORY sub, count(*) n,
               sum({col('ZVIEWCOUNT', 'ZVIEWCOUNT')}) views,
               sum(case when {col('ZREJECTED', 'ZREJECTED')} <> 0 then 1 else 0 end) rejected,
               sum({col('ZPLAYCOUNT', 'ZPLAYCOUNT')}) plays,
               sum(case when ZTITLE is not null and ZTITLE <> '' then 1 else 0 end) titled,
               min(ZCREATIONDATE) first_s, max(ZCREATIONDATE) last_s
        from ZMEMORY group by 1, 2 order by n desc
    """)]

    curated = None
    link_table = "Z_3MEMORIESBEINGCURATEDASSETS"
    if db.has_table(PHOTOS, link_table):
        lcols = sorted(_cols(PHOTOS, link_table))
        if len(lcols) == 2:
            asset_col = next((c for c in lcols if "CURATEDASSETS" in c and "MEMORIES" not in c), lcols[0])
            mem_col = next((c for c in lcols if "MEMORIES" in c), lcols[1])
            r = db.query(PHOTOS, f"select count(*) links, count(distinct {mem_col}) memories, "
                                 f"count(distinct {asset_col}) assets from {link_table}")[0]
            curated = {"links": r["links"], "memories": r["memories"], "assets": r["assets"]}

    return {
        "total": totals["n"], "titled": totals["titled"] or 0,
        "view_sum": totals["views"] or 0, "viewed_rows": totals["viewed_rows"] or 0,
        "rejected_rows": totals["rejected_rows"] or 0,
        "play_sum": totals["plays"] or 0, "played_rows": totals["played_rows"] or 0,
        "shared_rows": totals["shared_rows"] or 0,
        "with_view_date": totals["with_view_date"] or 0,
        "by_category": by_cat,
        "curated": curated,
    }


def _scenes(threshold):
    """The scene classifier, reached the only way that is correct."""
    if not db.has_table(PHOTOS, "ZSCENECLASSIFICATION"):
        return None
    total = db.one(PHOTOS, "select count(*) from ZSCENECLASSIFICATION", default=0)
    avg = db.one(PHOTOS, "select avg(ZCONFIDENCE) from ZSCENECLASSIFICATION", default=0)

    hop = db.query(PHOTOS, """
        select count(*) rows, count(distinct aa.ZASSET) assets,
               count(distinct sc.ZSCENEIDENTIFIER) scenes
        from ZSCENECLASSIFICATION sc
        join ZMEDIAANALYSISASSETATTRIBUTES aa on aa.Z_PK = sc.ZASSETATTRIBUTES
        where sc.ZCONFIDENCE >= ?
    """, (threshold,))[0]

    # The join a reader reaches for first. It is not empty — it is wrong, which
    # is worse, so the page shows both numbers side by side.
    naive = db.query(PHOTOS, """
        select count(*) rows, count(distinct a.Z_PK) assets
        from ZSCENECLASSIFICATION sc
        join ZASSET a on a.Z_PK = sc.ZASSETATTRIBUTES
        where sc.ZCONFIDENCE >= ?
    """, (threshold,))[0]

    pairs = db.query(PHOTOS, """
        select sc.ZSCENEIDENTIFIER scene, sc.ZCLASSIFICATIONTYPE kind,
               count(*) n, count(distinct aa.ZASSET) assets, avg(sc.ZCONFIDENCE) conf
        from ZSCENECLASSIFICATION sc
        join ZMEDIAANALYSISASSETATTRIBUTES aa on aa.Z_PK = sc.ZASSETATTRIBUTES
        where sc.ZCONFIDENCE >= ?
        group by 1, 2 order by assets desc
    """, (threshold,))

    # Codes crowding the top of the signed 32-bit range are derived/sentinel
    # classes, not scenes. Split them rather than letting them own the ranking.
    limit = 2 ** 31 - 1
    cutoff = limit - 100000
    marked = [{"scene": p["scene"], "kind": p["kind"], "n": p["n"], "assets": p["assets"],
               "conf": p["conf"], "sentinel": 1 if (p["scene"] or 0) >= cutoff else 0}
              for p in pairs]
    real = [m for m in marked if not m["sentinel"]]
    sentinels = [m for m in marked if m["sentinel"]]

    return {
        "threshold": threshold,
        "classifications": total,
        "mean_confidence": avg,
        "pairs": len(pairs),
        "linked": {"rows": hop["rows"], "assets": hop["assets"], "scenes": hop["scenes"]},
        "naive": {"rows": naive["rows"], "assets": naive["assets"]},
        "attr_rows": db.one(PHOTOS, "select count(*) from ZMEDIAANALYSISASSETATTRIBUTES",
                            default=0),
        "attr_assets": db.one(PHOTOS,
                              "select count(distinct ZASSET) from ZMEDIAANALYSISASSETATTRIBUTES",
                              default=0),
        "sentinel_cutoff": cutoff,
        "int32_max": limit,
        "top": real[:TOP_SCENES],
        "sentinels": sentinels[:TOP_SENTINELS],
        "cap": TOP_SCENES,
        "sentinel_cap": TOP_SENTINELS,
        "sentinel_pairs": len(sentinels),
        "real_pairs": len(real),
        "sentinel_assets": max((m["assets"] for m in sentinels), default=0),
    }


def _cooccurrence(min_shared):
    """Who appears in a photograph with whom. The second social network."""
    if not db.has_table(PHOTOS, "ZDETECTEDFACE"):
        return []          # a list of edges, always — callers iterate it
    return db.query(PHOTOS, """
        select fa.ZPERSONFORFACE as a, fb.ZPERSONFORFACE as b,
               count(distinct fa.ZASSETFORFACE) as shared
        from ZDETECTEDFACE fa
        join ZDETECTEDFACE fb
          on fb.ZASSETFORFACE = fa.ZASSETFORFACE
         and fb.ZPERSONFORFACE > fa.ZPERSONFORFACE
        where fa.ZASSETFORFACE is not null and fa.ZPERSONFORFACE is not null
        group by 1, 2 having shared >= ? order by shared desc
    """, (min_shared,))


def _messaging_scale():
    """The other social network, for scale. Counts only — no handles leave here."""
    if not db.has_table(MESSAGES, "message"):
        return None
    return {
        "handles": db.one(MESSAGES,
                          "select count(distinct h.ROWID) from handle h "
                          "join message m on m.handle_id = h.ROWID", default=0),
        "messages": db.one(MESSAGES, "select count(*) from message", default=0),
    }


# ---------------------------------------------------------------- handlers


def handler(params):
    try:
        conf = float(params.get("conf", DEFAULT_SCENE_CONF))
    except (TypeError, ValueError):
        conf = DEFAULT_SCENE_CONF
    conf = min(max(conf, 0.0), 1.0)

    prefixed, bare = _references()
    all_values = sorted(set(prefixed) | set(bare))
    identifiers = sorted({_strip_ns(v) for v in all_values})
    scope = _common_suffix(identifiers)
    heads = sorted({_head(v, scope) for v in identifiers})
    known = _resolution(heads)

    # subject -> the cluster it points at, so "named anywhere" can be counted
    # across both sides of the join rather than reported as two loose numbers.
    binding = {}
    for r in db.query(
            GRAPH,
            "select distinct subject, object from stable_graph "
            "where predicate = ? and object like ?", (SAME_AS, NS + ":%")):
        binding[r["subject"]] = _head(r["object"], scope)
    subjects = sorted(binding)

    ns_kind, ns_blurb = vocab.NAMESPACES.get(NS, ("face", ""))

    clusters = _clusters(known)
    edges = _cooccurrence(1)
    tiers = []
    for t in (1, 2, 3, 5):
        keep = [e for e in edges if e["shared"] >= t]
        nodes = {e["a"] for e in keep} | {e["b"] for e in keep}
        tiers.append({"min_shared": t, "edges": len(keep), "nodes": len(nodes)})

    return {
        "namespace": {"key": NS, "kind": ns_kind, "blurb": ns_blurb,
                      "predicate": SAME_AS, "predicate_label": vocab.plabel(SAME_AS),
                      "statement": VISUAL, "statement_label": vocab.plabel(VISUAL),
                      "identifier_predicate": IDENTIFIER,
                      "identifier_label": vocab.plabel(IDENTIFIER)},
        "anatomy": _anatomy(identifiers),
        "layers": _layer_spread(all_values),
        "carriers": _carriers(all_values, scope, known),
        "resolution": {"identifiers": len(heads), "resolved": len(set(heads) & known),
                       "photos_clusters": clusters["person_rows"] if clusters else 0},
        "statement": _statement_shape(subjects),
        "funnel": _naming_funnel(subjects, binding, known),
        "clusters": clusters,
        "biometrics": _biometrics(),
        "geography": _geography(),
        "timeline": _timeline(),
        "memories": _memories(),
        "scenes": _scenes(conf),
        "network_tiers": tiers,
        "messaging": _messaging_scale(),
        "owner": vocab.sid(vocab.owner_id()),
    }


def network(params):
    """The face co-occurrence graph, shipped whole and filtered in the page."""
    try:
        floor = int(params.get("min", DEFAULT_MIN_SHARED))
    except (TypeError, ValueError):
        floor = DEFAULT_MIN_SHARED
    floor = max(1, floor)

    edges = _cooccurrence(floor)
    ids = {e["a"] for e in edges} | {e["b"] for e in edges}
    if not ids:
        return {"min_shared": floor, "nodes": [], "links": [], "assets_with_two": 0}

    prefixed, bare = _references()
    identifiers = sorted({_strip_ns(v) for v in set(prefixed) | set(bare)})
    scope = _common_suffix(identifiers)
    known = {_head(v, scope) for v in identifiers}

    ordered = sorted(ids)
    nodes = []
    for chunk in range(0, len(ordered), 400):
        part = ordered[chunk:chunk + 400]
        nodes += db.query(PHOTOS, f"""
            select p.Z_PK as pk, p.ZPERSONUUID as uuid, p.ZKEYFACE as key_face,
                   count(df.Z_PK) as faces,
                   count(distinct df.ZASSETFORFACE) as assets,
                   case when p.ZFULLNAME is not null and p.ZFULLNAME <> '' then 1 else 0 end as named
            from ZPERSON p
            left join ZDETECTEDFACE df on df.ZPERSONFORFACE = p.Z_PK
            where p.Z_PK in ({_marks(len(part))})
            group by p.Z_PK
        """, tuple(part))

    # Every node here IS a face, so each one carries the face Photos chose to
    # stand for it. A cluster with no readable preview keeps its plain circle.
    state = _thumb_state()
    folder = state["folder"] if state["available"] else None

    shared_assets = db.one(PHOTOS, """
        select count(*) from (
          select ZASSETFORFACE from ZDETECTEDFACE
          where ZASSETFORFACE is not null and ZPERSONFORFACE is not null
          group by ZASSETFORFACE having count(distinct ZPERSONFORFACE) > 1)
    """, default=0)

    return {
        "min_shared": floor,
        "assets_with_two": shared_assets,
        "nodes": [{
            "id": n["pk"], "label": (n["uuid"] or "")[:6],
            "faces": n["faces"], "assets": n["assets"],
            "referenced": 1 if n["uuid"] in known else 0,
            "named": n["named"],
            "key_face": _key_face(n["pk"], n["key_face"], folder),
        } for n in nodes],
        "links": [{"source": e["a"], "target": e["b"], "weight": e["shared"]}
                  for e in edges],
    }


# ---------------------------------------------------------------- one cluster
#
# The drawer behind a cluster: what Photos calls the person, what the graph
# binds the cluster to, the photographs the face appears in, and who it appears
# with. Thumbnails are the rendered previews Photos already keeps beside its
# database — read on request, sent over loopback, never copied. Every way that
# can fail is reported with the fix beside it, because "no image" and "not
# allowed to read the image" call for different actions.

ASSET_UUID = re.compile(r"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")
PHOTO_CAP = 24
PARTNER_CAP = 12
# the derivative files Photos renders, most useful first: a preview, a smaller
# preview, and the 32px poster frame it keeps for videos
THUMB_SUFFIXES = ("_1_105_c.jpeg", "_1_102_o.jpeg", ".THM")

FDA_FIX = ("grant Full Disk Access to the terminal (or the python3 binary) this server "
           "runs from — System Settings → Privacy & Security → Full Disk Access — quit it "
           "fully, reopen it and start the server again")


def _thumb_state():
    """Can rendered previews be served, and if not, what would make it possible?"""
    path = os.path.abspath(db.resolve(PHOTOS))
    parent = os.path.dirname(path)
    if os.path.basename(parent) != "database":
        return {
            "available": False,
            "why": "this is an extracted copy of the Photos database; the rendered previews "
                   "live beside the original library, under resources/derivatives, and the "
                   "copy does not carry them",
            "fix": "run python3 server.py on the Mac that owns the library, without --bundle, "
                   "or lay the copy out as <library>/database/Photos.sqlite next to the "
                   "library's own resources/derivatives folder",
        }
    folder = os.path.join(os.path.dirname(parent), "resources", "derivatives")
    try:
        entries = os.listdir(folder)
    except PermissionError:
        return {"available": False,
                "why": "macOS refused to read the library's rendered previews",
                "fix": FDA_FIX}
    except FileNotFoundError:
        return {"available": False,
                "why": "the library holds no resources/derivatives folder, so Photos has "
                       "rendered no previews on this Mac",
                "fix": "open Photos once on this Mac so it renders its previews, or turn off "
                       "Optimise Mac Storage in Photos → Settings → iCloud so previews and "
                       "originals are kept locally"}
    except OSError as exc:
        return {"available": False, "why": f"the previews folder could not be read: {exc}",
                "fix": "check that the Photos library is on a mounted, readable volume"}
    return {"available": True, "folder": folder, "buckets": len(entries), "why": None, "fix": None}


def _thumb_path(uuid, folder):
    """The smallest useful rendered derivative for one asset, or None."""
    if not folder or not ASSET_UUID.match(uuid or ""):
        return None
    uuid = uuid.upper()
    bucket = os.path.join(folder, uuid[0])
    for suffix in THUMB_SUFFIXES:
        candidate = os.path.join(bucket, uuid + suffix)
        if os.path.isfile(candidate):
            return candidate
    return None


def thumb(params):
    """GET /api/faces/thumb?asset=<uuid> — one rendered preview, sent as it is.

    Returns (status, content type, bytes); server.py sends the triple raw. Every
    failure carries its reason in the body so the page can show it in place.
    """
    uuid = str(params.get("asset", "")).strip()
    if not ASSET_UUID.match(uuid):
        return (400, "text/plain; charset=utf-8", b"asset must be a Photos asset UUID")
    state = _thumb_state()
    if not state["available"]:
        return (503, "text/plain; charset=utf-8",
                f"{state['why']} — to make it work: {state['fix']}".encode("utf-8"))
    path = _thumb_path(uuid, state["folder"])
    if path is None:
        return (404, "text/plain; charset=utf-8",
                b"no rendered preview for this asset on this Mac; Photos > Settings > iCloud > "
                b"Download Originals to this Mac renders one")
    try:
        with open(path, "rb") as fh:
            return (200, "image/jpeg", fh.read())
    except PermissionError:
        return (403, "text/plain; charset=utf-8",
                f"macOS refused to read the preview — {FDA_FIX}".encode("utf-8"))


def _display_point(x, y, orientation):
    """Photos stores a face centre as fractions of the unrotated image with the
    origin at the bottom left. Return top-left-origin fractions of the image as
    it is displayed, so the page can crop the face out of the rendered preview."""
    u, v = float(x or 0.0), 1.0 - float(y or 0.0)
    if orientation in (3, 4):
        return 1.0 - u, 1.0 - v
    if orientation in (5, 6):
        return 1.0 - v, u
    if orientation in (7, 8):
        return v, 1.0 - u
    return u, v


def _face_box(row, folder):
    """The face's place in its photograph, plus whether a preview exists to show it in."""
    x, y = _display_point(row["cx"], row["cy"], row["orientation"])
    return {
        "asset": row["asset"],
        "x": round(x, 4), "y": round(y, 4),
        "size": round(float(row["size"] or 0.0), 4),
        "thumb": _thumb_path(row["asset"], folder) is not None,
    }


def _person_faces(pk):
    """Every face row of one cluster, joined to its photograph, newest first."""
    return db.query(PHOTOS, """
        select df.Z_PK as face, df.ZCENTERX as cx, df.ZCENTERY as cy, df.ZSIZE as size,
               df.ZQUALITY as quality,
               a.Z_PK as apk, a.ZUUID as asset, a.ZDATECREATED as created, a.ZKIND as kind,
               a.ZORIENTATION as orientation, a.ZWIDTH as width, a.ZHEIGHT as height,
               a.ZTRASHEDSTATE as trashed, a.ZHIDDEN as hidden,
               (select count(distinct o.ZPERSONFORFACE) from ZDETECTEDFACE o
                 where o.ZASSETFORFACE = a.Z_PK and o.ZPERSONFORFACE is not null) as people
        from ZDETECTEDFACE df
        join ZASSET a on a.Z_PK = df.ZASSETFORFACE
        where df.ZPERSONFORFACE = ?
        order by a.ZDATECREATED desc, df.Z_PK
    """, (pk,))


def _key_face(pk, key_face_pk, folder):
    """The face Photos chose to represent the cluster, else its best-quality face
    that has a preview to be cropped from, else None."""
    rows = _person_faces(pk)
    if not rows:
        return None
    if key_face_pk is not None:
        for r in rows:
            if r["face"] == key_face_pk and not r["trashed"] and not r["hidden"]:
                return _face_box(r, folder)
    live = [r for r in rows if not r["trashed"] and not r["hidden"]]
    live.sort(key=lambda r: -(r["quality"] or 0.0))
    for r in live:
        if _thumb_path(r["asset"], folder) is not None:
            return _face_box(r, folder)
    return _face_box(live[0], folder) if live else None


def _person_row(pk):
    rows = db.query(PHOTOS, """
        select Z_PK as pk, ZPERSONUUID as uuid, ZFULLNAME as full_name,
               ZDISPLAYNAME as display_name, ZVERIFIEDTYPE as verified,
               ZDETECTIONTYPE as detection, ZTYPE as type, ZKEYFACE as key_face,
               ZFACECOUNT as cached
        from ZPERSON where Z_PK = ?
    """, (pk,))
    return rows[0] if rows else None


def _graph_binding(uuid):
    """The graph entity the cluster is bound to, if any: id, name, namespaces."""
    if not uuid:
        return None
    heads = db.query(GRAPH, "select distinct subject from stable_graph "
                            "where relationshipPredicate = ? and object like ?",
                     (VISUAL_FACET, uuid + "%"))
    entities = sorted(r["subject"] for r in heads)
    if not entities:
        return None
    eid = entities[0]
    objects = [r["object"] for r in db.query(
        GRAPH, "select object from stable_graph where subject = ?", (eid,))]
    spaces = sorted({o.split(":", 1)[0] for o in objects
                     if ":" in o and o.split(":", 1)[0] in vocab.NAMESPACES
                     and o.split(":", 1)[0] != "md"})
    return {
        "entity": vocab.sid(eid),
        "entities": len(entities),
        "name": vocab.name_of(eid),
        "is_owner": eid == vocab.owner_id(),
        "namespaces": spaces,
        "facts": len(objects),
    }


def by_entity():
    """{graph entity id -> the key face of the Photos cluster bound to it}.

    The same join `_graph_binding` makes for one cluster, run once over the
    whole graph: the social page draws a person's own face on their node, and a
    lookup per node would be a pair of queries per node.

    Two absences are deliberate and are simply left out of the map rather than
    reported: an entity the graph binds to no cluster, and a cluster whose
    preview this Mac cannot read. Both mean the caller draws the plain node it
    would have drawn anyway — a face is decoration over the identity the graph
    already asserts, never the thing that asserts it.
    """
    if not db.has_table(PHOTOS, "ZPERSON"):
        return {}
    rows = db.query(
        GRAPH,
        "select subject, object from stable_graph "
        "where predicate = ? and relationshipPredicate = ?",
        (VISUAL, VISUAL_FACET),
    )
    if not rows:
        return {}

    # The stored identifier is a cluster UUID followed by a constant
    # library-scope marker. Measure the marker off the whole corpus, as the
    # rest of this module does, rather than assuming a UUID is 36 characters.
    prefixed, bare = _references()
    scope = _common_suffix(sorted({_strip_ns(v) for v in set(prefixed) | set(bare)}))
    wanted = {}
    for r in rows:
        wanted.setdefault(_head(r["object"], scope), []).append(r["subject"])

    state = _thumb_state()
    folder = state["folder"] if state["available"] else None
    out = {}
    for pr in db.query(PHOTOS, "select Z_PK as pk, ZPERSONUUID as uuid, "
                               "ZKEYFACE as key_face from ZPERSON "
                               "where ZPERSONUUID is not null"):
        eids = wanted.get(pr["uuid"])
        if not eids:
            continue
        face = _key_face(pr["pk"], pr["key_face"], folder)
        if not face or not face["thumb"]:
            continue
        for eid in eids:
            out[eid] = face
    return out


def person(params):
    """GET /api/faces/person?id=<Photos person key> — one cluster, opened."""
    try:
        pk = int(str(params.get("id", "")).strip())
    except (TypeError, ValueError):
        return {"found": False, "reason": "id must be the integer key of a Photos person row"}
    if not db.has_table(PHOTOS, "ZPERSON"):
        return {"found": False,
                "reason": "the photo library database is not readable on this device",
                "fix": FDA_FIX}
    p = _person_row(pk)
    if p is None:
        return {"found": False, "reason": "no person row with that key in the photo library"}

    state = _thumb_state()
    folder = state["folder"] if state["available"] else None
    uuid = p["uuid"] or ""

    rows = _person_faces(pk)
    seen, photos, hidden = set(), [], 0
    for r in rows:
        if r["trashed"] or r["hidden"]:
            hidden += 1
            continue
        if r["asset"] in seen:
            continue
        seen.add(r["asset"])
        photos.append({
            "asset": r["asset"],
            "date": db.apple_time(r["created"]),
            "kind": "video" if r["kind"] == 1 else "photo",
            "people": r["people"],
            "face": _face_box(r, folder),
            "thumb": _thumb_path(r["asset"], folder) is not None,
        })
    dates = [ph["date"] for ph in photos if ph["date"]]
    # Newest first, but a photograph with a rendered preview before one without:
    # the grid is capped, and a page of placeholders shows nothing.
    photos.sort(key=lambda ph: (not ph["thumb"], -(ph["date"] or 0)))

    partners = db.query(PHOTOS, """
        select o.ZPERSONFORFACE as pk, count(distinct o.ZASSETFORFACE) as shared
        from ZDETECTEDFACE me
        join ZDETECTEDFACE o on o.ZASSETFORFACE = me.ZASSETFORFACE
                            and o.ZPERSONFORFACE <> me.ZPERSONFORFACE
        where me.ZPERSONFORFACE = ? and me.ZASSETFORFACE is not null
          and o.ZPERSONFORFACE is not null
        group by 1 order by shared desc, pk
    """, (pk,))

    prefixed, bare = _references()
    identifiers = sorted({_strip_ns(v) for v in set(prefixed) | set(bare)})
    scope = _common_suffix(identifiers)
    known = {_head(v, scope) for v in identifiers}

    partner_rows = []
    for pr in partners[:PARTNER_CAP]:
        q = _person_row(pr["pk"])
        if q is None:
            continue
        partner_rows.append({
            "id": q["pk"],
            "prefix": (q["uuid"] or "")[:6],
            "name": q["full_name"] or q["display_name"] or None,
            "shared": pr["shared"],
            "referenced": 1 if q["uuid"] in known else 0,
            "key_face": _key_face(q["pk"], q["key_face"], folder),
        })

    return {
        "found": True,
        "id": p["pk"],
        "uuid": uuid,
        "prefix": uuid[:6],
        "name": p["full_name"] or p["display_name"] or None,
        "verified": p["verified"],
        "detection": p["detection"],
        "cached": p["cached"] or 0,
        "faces": len(rows),
        "assets": len(seen),
        "hidden_or_trashed": hidden,
        "first": min(dates) if dates else None,
        "last": max(dates) if dates else None,
        "referenced": 1 if uuid in known else 0,
        "graph": _graph_binding(uuid),
        "key_face": _key_face(pk, p["key_face"], folder),
        "photos": photos[:PHOTO_CAP],
        "photos_total": len(photos),
        "photos_with_thumb": sum(1 for ph in photos if ph["thumb"]),
        "cap": PHOTO_CAP,
        "partners": partner_rows,
        "partners_total": len(partners),
        "partner_cap": PARTNER_CAP,
        "thumbs": state,
    }


TOP_DEFAULT = 14
TOP_MAX = 40


def top(params):
    """GET /api/faces/top?n= — the largest clusters, each with its face and any name.

    The landing page's strip. Light on purpose: one row per cluster, the face
    to crop, the name Photos holds or the graph entity the cluster is bound to,
    and the library-wide counts the strip is captioned with.
    """
    try:
        n = int(str(params.get("n", TOP_DEFAULT)).strip())
    except (TypeError, ValueError):
        n = TOP_DEFAULT
    n = max(1, min(TOP_MAX, n))
    state = _thumb_state()
    if not db.has_table(PHOTOS, "ZPERSON"):
        return {"available": False,
                "reason": "the photo library database is not readable on this device",
                "fix": FDA_FIX, "clusters": [], "thumbs": state}
    folder = state["folder"] if state["available"] else None

    rows = db.query(PHOTOS, """
        select p.Z_PK as pk, p.ZPERSONUUID as uuid, p.ZFULLNAME as full_name,
               p.ZDISPLAYNAME as display_name, p.ZKEYFACE as key_face,
               count(df.Z_PK) as faces, count(distinct df.ZASSETFORFACE) as assets
        from ZPERSON p
        join ZDETECTEDFACE df on df.ZPERSONFORFACE = p.Z_PK
        group by p.Z_PK
        order by faces desc, p.Z_PK
        limit ?
    """, (n,))

    prefixed, bare = _references()
    identifiers = sorted({_strip_ns(v) for v in set(prefixed) | set(bare)})
    scope = _common_suffix(identifiers)
    known = {_head(v, scope) for v in identifiers}

    with_faces = db.query(PHOTOS, """
        select p.ZPERSONUUID as uuid,
               case when p.ZFULLNAME is not null and p.ZFULLNAME <> '' then 1 else 0 end as named
        from ZPERSON p
        where exists (select 1 from ZDETECTEDFACE df where df.ZPERSONFORFACE = p.Z_PK)
    """)
    assets_with_face = db.one(PHOTOS, "select count(distinct ZASSETFORFACE) from ZDETECTEDFACE "
                                      "where ZPERSONFORFACE is not null and ZASSETFORFACE is not null",
                              default=0)

    clusters = []
    for r in rows:
        binding = _graph_binding(r["uuid"] or "")
        clusters.append({
            "id": r["pk"],
            "prefix": (r["uuid"] or "")[:6],
            "name": r["full_name"] or r["display_name"] or None,
            "graph_name": binding["name"] if binding else None,
            "graph_bound": binding is not None,
            "is_owner": bool(binding and binding["is_owner"]),
            "referenced": 1 if r["uuid"] in known else 0,
            "faces": r["faces"],
            "assets": r["assets"],
            "key_face": _key_face(r["pk"], r["key_face"], folder),
        })

    return {
        "available": True,
        "clusters": clusters,
        "shown": len(clusters),
        "with_faces": len(with_faces),
        "named": sum(1 for w in with_faces if w["named"]),
        "referenced": sum(1 for w in with_faces if w["uuid"] in known),
        "assets_with_face": assets_with_face,
        "faces_clustered": db.one(PHOTOS, "select count(*) from ZDETECTEDFACE "
                                          "where ZPERSONFORFACE is not null", default=0),
        "thumbs": state,
    }


ROUTES = {
    "/api/faces": handler,
    "/api/faces/network": network,
    "/api/faces/person": person,
    "/api/faces/thumb": thumb,
    "/api/faces/top": top,
}
