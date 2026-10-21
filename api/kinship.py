"""The inferred relationship scorecard.

`Artifacts__entityTagging__entityTagging.db` holds one row per person and a set
of DOUBLE score columns naming a relationship each: mother, father, partner,
child and the rest. A pair of CoreML classifiers wrote a number into every
cell, for each person the device chose to score; relationships declared in
Contacts, Medical ID and Family Sharing are among their inputs, by the shipped
feature lists.

This module measures that table rather than describing it:

  * the whole people x columns matrix, names resolved from graph.db;
  * which columns are dead (zero on every row) and which are literally copies of
    each other — discovered by comparing the column vectors, not assumed;
  * which columns are exact sums of others, found by an exhaustive search over
    subsets of the non-empty columns, so whether a head is a rollup is tested
    per column instead of asserted;
  * the quantisation ladder: how few distinct values fill the non-zero cells;
  * the evidence ledger from the feature store, with the NSKeyedArchiver blobs
    decoded, so a fact that was merely *evaluated* is never counted as a fact
    that came back *true*;
  * and the convergence panel: iKnow's own checks across other tables, shown
    beside the column that names the relationship.

Every number is computed at call time. Nothing about this person is in the code.
"""

import itertools
import plistlib
import sqlite3

from . import db, vocab

TAGGING = "graph/Artifacts__entityTagging__entityTagging.db"
FEATURES = "graph/Artifacts__feature__features.db"
IMPORTANCE = "graph/Artifacts__entityRelevance__entityImportanceSignals.db"
REMEMBERS = "graph/Artifacts__siri__remembers__view.db"
VIEWS = "graph/Artifacts__internal__views.db"

EPS = 1e-9

# The band edges the page draws the threshold cuts on. Structural, not data:
# 0.5 is the midpoint of the score range, and the bands are even sub-divisions.
BAND_EDGES = (0.9, 0.7, 0.5, 0.25)

FACTS_VIEW = "personEntityTaggingFacts"
PROFILE_VIEW = "personEntityTagging"

# The one schema identifier this module names rather than discovers: the column
# whose label asserts a partnership. It is a column name out of the table
# definition, not a value out of anybody's row, and the panel that uses it
# degrades to "every named claim" when the column is not present.
PARTNERSHIP_COLUMNS = ("partner",)


# ---------------------------------------------------------------- plumbing



def _attach(conn, alias, relpath):
    """ATTACH once per (thread-local, reused) connection.

    db.connect memoises handles per thread, so a second request on the same
    thread would hit "database <alias> is already in use".

    The state is read back from SQLite rather than cached on our side. An
    earlier version kept a dict keyed by `id(conn)`, which is a trap: CPython
    reuses the memory address of a collected object, so a fresh connection
    could inherit a dead connection's "already attached" entry, skip the ATTACH
    and then fail with `no such table: <alias>.…` on a server thread that had
    recycled a handle. `pragma database_list` is authoritative and costs
    nothing worth measuring.
    """
    if conn is None:
        return
    already = {row[1] for row in conn.execute("pragma database_list")}
    if alias in already:
        return
    # ATTACH does not inherit the main connection's read-only flag: given a
    # plain path it opens the second store read-write even here, where the
    # handle it hangs off cannot write a byte. Against an extracted copy that
    # was merely untidy; against the live store it would be a write handle open
    # on a database a daemon owns. The file: URI form is honoured — the
    # connection was opened with uri=True, which sets SQLITE_OPEN_URI for
    # ATTACH too — and mode=ro is then real.
    path = db.resolve(relpath)
    try:
        conn.execute("attach database ? as " + alias, (f"file:{path}?mode=ro",))
    except sqlite3.OperationalError as exc:
        # Said on the page; the statements that name the alias then read as
        # empty, and say so too.
        db.note(relpath, *(db.why_not(path) or ("open", f"could not be attached — {exc}")))


def _score_columns():
    """The relationship columns, read off the schema — never a written list.

    The table carries one INTEGER book-keeping column alongside the scores; the
    DOUBLE declaration is what separates a relationship head from it.
    """
    info = db.query(TAGGING, "pragma table_info(entity_tagging)")
    return [r["name"] for r in info if (r["type"] or "").upper() == "DOUBLE"]


def _rows(cols):
    if not cols:
        return []
    sel = ", ".join('"%s"' % c for c in cols)
    return db.query(TAGGING, "select mdid, %s from entity_tagging" % sel)


def _q(v):
    """Round a score for grouping. The stores hold full doubles; two cells that
    print the same must group the same."""
    return round(float(v), 12)


# ---------------------------------------------------------------- structure

def _identical_classes(cols, rows):
    """Columns whose value vectors are equal on every row, grouped."""
    seen = {}
    for c in cols:
        key = tuple(_q(r[c]) for r in rows)
        seen.setdefault(key, []).append(c)
    return [v for k, v in seen.items() if len(v) > 1 and any(k)]


def _identities(cols, rows, max_terms=3):
    """Every column that is an exact sum of two or more of the others.

    Restricted to non-empty columns — an all-zero column joins any sum without
    changing it, so including them would manufacture identities. One-term
    matches are excluded because those are duplicate columns, reported on their
    own. The row loop early-exits on the first mismatch, which is why an
    exhaustive search over every subset still costs under a millisecond here.
    """
    out = []
    for target in cols:
        others = [c for c in cols if c != target]
        for k in range(2, min(max_terms, len(others)) + 1):
            for sub in itertools.combinations(others, k):
                ok = True
                for r in rows:
                    if abs(r[target] - sum(r[c] for c in sub)) > EPS:
                        ok = False
                        break
                if ok:
                    out.append({"target": target, "terms": list(sub)})
    return out


def _hypothesis(rows, lhs, terms):
    """Test one asserted decomposition and report how badly it fails."""
    violations = 0
    lhs_lower = 0
    for r in rows:
        s = sum(r[c] for c in terms)
        if abs(r[lhs] - s) > EPS:
            violations += 1
        if r[lhs] < s - EPS:
            lhs_lower += 1
    return {
        "lhs": lhs,
        "terms": list(terms),
        "violations": violations,
        "lhs_below_sum": lhs_lower,
        "total": len(rows),
    }


# ---------------------------------------------------------------- names

def _labels(ids):
    """entity id (int) -> display name, with the coverage gap made visible, and
    the set of ids whose name comes from the retraction archive.

    graph.db is the only name source that covers this population; 'PS33' full
    name first, then the given/family-name predicates. Where the live graph has
    none, a name the archive still holds for the same entity is used, and
    flagged. Everyone else stays unnamed on purpose — inventing a label would
    hide how partial the store is.
    """
    names = vocab.names("stable_graph")
    withdrawn = vocab.withdrawn_names(i for i in ids if not names.get(i))
    labels = {str(i): names.get(i) or withdrawn.get(i) for i in ids}
    return labels, {str(i) for i in withdrawn}


def _uniq_label(name, eid, used):
    base = name or ("unnamed #" + eid[-4:])
    label = base
    n = 2
    while label in used:
        label = "%s (%d)" % (base, n)
        n += 1
    used.add(label)
    return label


# ---------------------------------------------------------------- evidence

def _decode_feature(blob):
    """One MLFeatureValue out of an NSKeyedArchiver plist.

    $objects[1] is the feature wrapper; its 'value' and 'type' members are UIDs
    pointing back into the same $objects array. Returns (type, value) or
    (None, None) when the blob is not the shape we expect.
    """
    try:
        plist = plistlib.loads(blob)
        objs = plist["$objects"]
    except Exception:
        return None, None

    def deref(u):
        if isinstance(u, plistlib.UID):
            try:
                return objs[u.data]
            except IndexError:
                return None
        return u

    top = objs[1] if len(objs) > 1 else None
    if not isinstance(top, dict):
        return None, None
    return deref(top.get("type")), deref(top.get("value"))


def _evidence():
    """The discrete facts the tagger observed, evaluated-vs-true.

    A row in the feature store means the tagger *asked* the question about that
    person. Whether the answer was yes lives inside the blob, so a ledger that
    counts rows counts questions, not findings.
    """
    if not db.has_table(FEATURES, "kv"):
        return []
    rows = db.query(
        FEATURES,
        "select featureName, subidentifierName, value from kv where viewName = ?",
        (FACTS_VIEW,),
    )
    agg = {}
    for r in rows:
        slot = agg.setdefault(r["featureName"], {"evaluated": 0, "true": 0, "false": 0,
                                                 "values": {}, "kind": None})
        slot["evaluated"] += 1
        vtype, value = _decode_feature(r["value"])
        if value is None:
            slot["kind"] = slot["kind"] or "undecoded"
            continue
        if isinstance(value, str):
            slot["kind"] = "category"
            slot["values"][value] = slot["values"].get(value, 0) + 1
            slot["true"] += 1
        else:
            slot["kind"] = "boolean"
            if value:
                slot["true"] += 1
            else:
                slot["false"] += 1
            key = "true" if value else "false"
            slot["values"][key] = slot["values"].get(key, 0) + 1
    out = []
    for fact, slot in agg.items():
        out.append({
            "fact": fact,
            "evaluated": slot["evaluated"],
            "true": slot["true"],
            "false": slot["false"],
            "kind": slot["kind"] or "empty",
            "values": sorted(({"value": k, "n": v} for k, v in slot["values"].items()),
                             key=lambda d: -d["n"]),
        })
    out.sort(key=lambda d: (-d["evaluated"], d["fact"]))
    return out


def _profile_coverage():
    """How many people carry the deep behavioural profile, against how many
    carry a score at all."""
    if not db.has_table(FEATURES, "kv"):
        return {"people": 0, "features": 0}
    row = db.query(
        FEATURES,
        "select count(distinct subidentifierName) as people, "
        "count(distinct featureName) as features from kv "
        "where viewName = ? and subidentifierName like 'md:%'",
        (PROFILE_VIEW,),
    )
    return row[0] if row else {"people": 0, "features": 0}


# ---------------------------------------------------------------- convergence

def _owner():
    oid = vocab.owner_id()
    return oid, (str(oid) if oid is not None else None)


def _household(owner, table="stable_graph"):
    """Members of any group-of-humans entity the owner is also in.

    The membership predicate is reified, so the member ids live on the facet
    rows; the owner is dropped from the result because the interesting output is
    who *else* is in the group.
    """
    if owner is None:
        return set(), 0
    ref = "md:%d" % owner
    groups = db.query(
        "graph/graph.db",
        f"select distinct subject from {table} "
        "where predicate = 'PS753' and object = ?",
        (ref,),
    )
    members, size = set(), 0
    for g in groups:
        rows = db.query(
            "graph/graph.db",
            f"select object from {table} where subject = ? and predicate = 'PS753'",
            (g["subject"],),
        )
        ids = [vocab.entity_ref(r["object"]) for r in rows]
        ids = [i for i in ids if i is not None]
        size = max(size, len(set(ids)))
        members |= {str(i) for i in ids if i != owner}
    return members, size


def _family_circle(owner, table="stable_graph"):
    """Subjects carrying a Family-Sharing circle token the owner also carries.
    The owner's own tokens are read from the live layer and from `table`."""
    if owner is None:
        return set(), 0
    toks = sorted({r["object"] for t in {"stable_graph", table} for r in db.query(
        "graph/graph.db",
        f"select distinct object from {t} where subject = ?", (owner,))
        if vocab.ns_of(r["object"]) == "faFamilyCircle"})
    if not toks:
        return set(), 0
    marks = ",".join("?" * len(toks))
    rows = db.query(
        "graph/graph.db",
        f"select distinct subject from {table} where object in (%s)" % marks,
        tuple(toks),
    )
    return {str(r["subject"]) for r in rows if r["subject"] != owner}, len(toks)


def _predicate_subjects(predicate, table="stable_graph"):
    return {str(r["subject"]) for r in db.query(
        "graph/graph.db",
        f"select distinct subject from {table} where predicate = ?", (predicate,))}


def _namespace_subjects(ns, table="stable_graph"):
    """Subjects carrying at least one object in a namespace, decided by the
    allowlist head rather than by looking for a colon."""
    rows = db.query("graph/graph.db", f"select distinct subject, object from {table}")
    return {str(r["subject"]) for r in rows if vocab.ns_of(r["object"]) == ns}


def _archive_checks(ids, owner):
    """{check key -> ids} the retraction archive still passes, for the scored
    entities that have no live row left.

    The graph can withdraw entities built from Contacts, Calendar and Family
    Sharing (it did after one Mac's 27.0.1 upgrade) while the scorecard still
    scores some of them, and the checks below read the live layer only. An entity with no live row cannot have a live
    fact superseding its withdrawn one, so for those, and only those, the
    withdrawn rows under the same id answer, and the page flags every answer
    that came from here.
    """
    archive = "expired_stable_graph"
    if not ids or not db.has_table("graph/graph.db", archive):
        return {}
    live = {str(r["subject"]) for r in db.query(
        "graph/graph.db", "select distinct subject from stable_graph")}
    only = {i for i in ids if i not in live}
    if not only:
        return {}
    return {
        "reach": _predicate_subjects("PS520", archive) & only,
        "face": _predicate_subjects("nm_hasVisualIdentifier", archive) & only,
        "card": _namespace_subjects("cnContact", archive) & only,
        "group": _household(owner, archive)[0] & only,
        "circle": _family_circle(owner, archive)[0] & only,
    }


def _icloud_family(owner):
    if not db.has_table(IMPORTANCE, "entityImportanceSignalsIDMap"):
        return set()
    rows = db.query(
        IMPORTANCE,
        "select entityIdentifier from entityImportanceSignalsIDMap where isICloudFamily = 1",
    )
    return {str(r["entityIdentifier"]) for r in rows if r["entityIdentifier"] != owner}


def _volume(owner):
    """Interaction-log count per graph entity, via the handle index.

    The handle index is many-to-many, so this counts identities that resolve to
    one graph entity, not humans; the page says so where it uses the number.
    """
    conn = db.connect(REMEMBERS)
    if conn is None or not db.has_table(VIEWS, "handle_id"):
        return {}
    _attach(conn, "iv", VIEWS)
    found = db.rows(
        conn,
        "select h.id as id, count(distinct i.rowid) as n "
        "from entities e "
        "join iv.handle_id h on h.handle = e.id "
        "join interactionEntities ie on ie.entityRowid = e.rowid "
        "join interactions i on i.rowid = ie.interactionRowid "
        "where e.type = 'PersonHandle' group by h.id"
    )
    out = {}
    for eid, n in ((r["id"], r["n"]) for r in found):
        if owner is not None and eid == owner:
            continue
        out[str(eid)] = n
    return out


# ---------------------------------------------------------------- handler

def handler(params):
    cols = _score_columns()
    rows = _rows(cols)
    total = len(rows)
    owner, owner_s = _owner()

    ids = [int(r["mdid"]) for r in rows]
    labels, withdrawn = _labels(ids)

    # ---- per-column measurement
    col_stats = []
    for c in cols:
        vals = [_q(r[c]) for r in rows]
        nz = [v for v in vals if v > 0]
        hist = {}
        for v in vals:
            hist[v] = hist.get(v, 0) + 1
        nz_hist = sorted(((v, n) for v, n in hist.items() if v > 0), key=lambda t: -t[1])
        col_stats.append({
            "name": c,
            "nonzero": len(nz),
            "max": max(vals) if vals else 0.0,
            "ge_half": sum(1 for v in vals if v >= 0.5),
            "distinct_nonzero": len(nz_hist),
            "empty": not nz,
            "top_value": ({"value": nz_hist[0][0], "n": nz_hist[0][1]} if nz_hist else None),
            "values": [{"value": v, "n": n} for v, n in sorted(nz_hist, key=lambda t: -t[0])][:6],
        })
    by_name = {c["name"]: c for c in col_stats}
    empty_cols = [c["name"] for c in col_stats if c["empty"]]
    live_cols = [c["name"] for c in col_stats if not c["empty"]]

    # ---- structure: copies, exact sums, and the heads that are neither
    identical = _identical_classes(cols, rows)
    dup_of = {}
    for klass in identical:
        for c in klass[1:]:
            dup_of[c] = klass[0]
    identities = _identities(live_cols, rows)
    derived = {i["target"] for i in identities}
    feeds = {t for i in identities for t in i["terms"]}
    independent = [c for c in live_cols if c not in derived and c not in feeds]

    # The composite head is the independent column that sits at or above the
    # other independent columns on the most cells — measured, not nominated.
    def _dominance(c):
        return sum(1 for r in rows for d in independent if d != c and r[c] >= r[d] - EPS)

    head = max(independent, key=_dominance) if independent else None
    heads_by_pop = ([head] + sorted((c for c in independent if c != head),
                                    key=lambda c: -by_name[c]["nonzero"])) if head else []

    # Two candidate decompositions, tested rather than assumed: the composite
    # against the two widest heads under it, and that second head against every
    # column that IS an exact rollup.
    hypotheses = []
    if head and len(heads_by_pop) >= 3:
        hypotheses.append(_hypothesis(rows, head, heads_by_pop[1:3]))
    if len(heads_by_pop) >= 2 and derived:
        hypotheses.append(_hypothesis(
            rows, heads_by_pop[1],
            sorted(derived, key=lambda c: -by_name[c]["nonzero"])))

    # ---- the matrix, sorted by the composite head, owner excluded
    ordered = [r for r in rows if r["mdid"] != owner_s]
    if heads_by_pop:
        ordered.sort(key=lambda r: tuple(-r[c] for c in heads_by_pop))
    used = set()
    matrix = []
    for r in ordered:
        name = labels.get(r["mdid"])
        matrix.append({
            "id": r["mdid"],
            "label": _uniq_label(name, r["mdid"], used),
            "named": bool(name),
            "name_withdrawn": r["mdid"] in withdrawn,
            "scores": [_q(r[c]) for c in cols],
        })

    # ---- bands and cuts on every head that is not empty
    bands = []
    if head:
        edges = list(BAND_EDGES)
        spec = [("%.2f–1.00" % edges[0], edges[0], 1.01)]
        for i in range(1, len(edges)):
            spec.append(("%.2f–%.2f" % (edges[i], edges[i - 1]), edges[i], edges[i - 1]))
        spec.append(("0.00–%.2f" % edges[-1], 1e-12, edges[-1]))
        spec.append(("exactly zero", -1.0, 1e-12))
        for label, lo, hi in spec:
            members = [r for r in ordered if lo <= r[head] < hi]
            bands.append({
                "band": label,
                "lo": lo if lo > 0 else 0.0,
                "n": len(members),
                "above_cut": lo >= 0.5,
            })
    cuts = [{"column": c,
             "ge_half": sum(1 for r in ordered if r[c] >= 0.5),
             "nonzero": sum(1 for r in ordered if r[c] > 0),
             "max": max((_q(r[c]) for r in ordered), default=0.0)}
            for c in live_cols]

    # ---- the named claims
    # Every column that names a specific relationship, which is every live
    # column that is not one of the broad independent heads. Rollups are kept
    # and FLAGGED rather than dropped: hiding them would hide that the same
    # evidence is being restated under several labels at once.
    claim_cols = [c for c in live_cols if c not in independent]
    reachable = _predicate_subjects("PS520")
    faces = _predicate_subjects("nm_hasVisualIdentifier")
    archived = _archive_checks({r["mdid"] for r in ordered}, owner)

    def check(key, pid, live):
        """(passes, came from the archive): the live layer first."""
        if pid in live:
            return True, False
        return (True, True) if pid in archived.get(key, ()) else (False, False)

    def evidence(pid):
        reach, reach_a = check("reach", pid, reachable)
        face, face_a = check("face", pid, faces)
        return {"reachable": reach, "face": face,
                "archived": [k for k, a in (("reachable", reach_a), ("face", face_a)) if a]}

    twins = {c: sorted(set(k) - {c}) for k in identical for c in k}
    claims, people = [], {}
    for c in claim_cols:
        for r in ordered:
            if r[c] <= 0:
                continue
            claims.append({
                "label": c,
                "id": r["mdid"],
                "name": labels.get(r["mdid"]),
                "name_withdrawn": r["mdid"] in withdrawn,
                "score": _q(r[c]),
                "rollup": c in derived,
                "twins": twins.get(c, []),
                **evidence(r["mdid"]),
            })
            slot = people.setdefault(r["mdid"], {
                "id": r["mdid"],
                "name": labels.get(r["mdid"]),
                "name_withdrawn": r["mdid"] in withdrawn,
                "labels": [], "head": _q(r[head]) if head else None,
                **evidence(r["mdid"]),
            })
            slot["labels"].append({"label": c, "score": _q(r[c]), "rollup": c in derived})
    claims.sort(key=lambda d: (-d["score"], d["label"]))
    claim_people = sorted(people.values(),
                          key=lambda d: (-len(d["labels"]), -(d["head"] or 0)))
    for d in claim_people:
        d["labels"].sort(key=lambda x: -x["score"])
        d["n_labels"] = len(d["labels"])
        d["max_score"] = max(x["score"] for x in d["labels"])
    rollup_labels = sorted(c for c in claim_cols if c in derived)

    # ---- quantisation
    cells = total * len(cols)
    ladder = {}
    for r in rows:
        for c in cols:
            v = _q(r[c])
            if v > 0:
                ladder[v] = ladder.get(v, 0) + 1
    ladder_rows = sorted(({"value": v, "n": n} for v, n in ladder.items()), key=lambda d: -d["n"])
    nonzero_cells = sum(ladder.values())

    # ---- coverage against the graph
    live_subjects = {str(r["subject"]) for r in db.query(
        "graph/graph.db", "select distinct subject from stable_graph")}
    expired_subjects = {str(r["subject"]) for r in db.query(
        "graph/graph.db", "select distinct subject from expired_stable_graph")}
    in_graph = sum(1 for r in rows if r["mdid"] in live_subjects)
    expired_only = sum(1 for r in rows
                       if r["mdid"] not in live_subjects and r["mdid"] in expired_subjects)

    # ---- the convergence
    household, group_size = _household(owner)
    circle, circle_tokens = _family_circle(owner)
    icloud = _icloud_family(owner)
    volume = _volume(owner)
    cards = _namespace_subjects("cnContact")
    top_volume_id = max(volume, key=volume.get) if volume else None

    # The column the convergence panel argues about. If the schema no longer
    # carries it, the panel falls back to every column that names a specific
    # relationship, and the page says which pool it used.
    focus = next((c for c in PARTNERSHIP_COLUMNS if c in live_cols), None)
    pool_cols = [focus] if focus else [c for c in live_cols if c not in independent]

    pool = {r["mdid"] for r in ordered if any(r[c] > 0 for c in pool_cols)}
    pool |= household | circle | icloud
    pool |= archived.get("group", set()) | archived.get("circle", set())
    if top_volume_id:
        pool.add(top_volume_id)
    pool &= {r["mdid"] for r in ordered}

    checks = [
        {"key": "column", "label": "scored by the column itself"},
        {"key": "head", "label": "clears iKnow's 0.5 cut on the composite head"},
        {"key": "group", "label": "in the group the store holds as an entity"},
        {"key": "circle", "label": "shares the Family-Sharing token"},
        {"key": "icloud", "label": "flagged iCloud Family"},
        {"key": "volume", "label": "top contact in the interaction log"},
        {"key": "face", "label": "bound to a Photos face cluster"},
        {"key": "card", "label": "resolves to a Contacts record"},
        {"key": "reach", "label": "carries a reachable handle"},
    ]
    by_id = {r["mdid"]: r for r in ordered}
    conv = []
    for pid in pool:
        r = by_id[pid]
        from_graph = {key: check(key, pid, live) for key, live in (
            ("group", household), ("circle", circle), ("face", faces),
            ("card", cards), ("reach", reachable))}
        flags = {
            "column": any(r[c] > 0 for c in pool_cols),
            "head": bool(head and r[head] >= 0.5),
            "group": from_graph["group"][0],
            "circle": from_graph["circle"][0],
            "icloud": pid in icloud,
            "volume": pid == top_volume_id,
            "face": from_graph["face"][0],
            "card": from_graph["card"][0],
            "reach": from_graph["reach"][0],
        }
        from_archive = [k for k, (_, a) in from_graph.items() if a]
        conv.append({
            "id": pid,
            "name": labels.get(pid),
            "name_withdrawn": pid in withdrawn,
            "label": next(m["label"] for m in matrix if m["id"] == pid),
            "score": _q(r[focus]) if focus else max(_q(r[c]) for c in pool_cols),
            "head": _q(r[head]) if head else None,
            "interactions": volume.get(pid, 0),
            "checks": flags,
            "archived": from_archive,
            "n": sum(1 for v in flags.values() if v),
            "n_archived": len(from_archive),
        })
    conv.sort(key=lambda d: (-d["n"], -(d["head"] or 0)))

    return {
        "total": total,
        "ranked": len(ordered),
        "owner_excluded": owner_s is not None,
        "columns": col_stats,
        "column_order": cols,
        "empty_columns": empty_cols,
        "live_columns": live_cols,
        "head": head,
        "heads": heads_by_pop,
        "structure": {
            "identical": identical,
            "identities": identities,
            "hypotheses": hypotheses,
            "independent": independent,
            "derived": sorted(derived),
        },
        "matrix": matrix,
        "bands": bands,
        "cuts": cuts,
        "claims": claims,
        "claim_people": claim_people,
        "claim_columns": claim_cols,
        "rollup_labels": rollup_labels,
        "quantisation": {
            "cells": cells,
            "nonzero_cells": nonzero_cells,
            "distinct": len(ladder_rows),
            "ladder": ladder_rows,
        },
        "coverage": {
            "scored": total,
            "in_graph": in_graph,
            "expired_only": expired_only,
            "named": sum(1 for r in rows if labels.get(r["mdid"]) and r["mdid"] not in withdrawn),
            "named_withdrawn": sum(1 for r in rows if r["mdid"] in withdrawn),
            "evaluated": len({r["subidentifierName"] for r in db.query(
                FEATURES, "select distinct subidentifierName from kv where viewName = ?",
                (FACTS_VIEW,))}) if db.has_table(FEATURES, "kv") else 0,
            "profiled": _profile_coverage(),
        },
        "evidence": _evidence(),
        "convergence": {
            "focus": focus,
            "pool_columns": pool_cols,
            "copy_of": dup_of.get(focus) if focus else None,
            "twin": ([c for c in (next((k for k in identical if focus in k), []) or [])
                      if c != focus] if focus else []),
            "focus_max": by_name[focus]["max"] if focus else None,
            "focus_nonzero": by_name[focus]["nonzero"] if focus else None,
            "checks": checks,
            "rows": conv,
            "group_size": group_size,
            "circle_tokens": circle_tokens,
            "volume_people": len(volume),
        },
    }


ROUTES = {"/api/kinship": handler}
