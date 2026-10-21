"""exposure.py — the control plane: who reads this graph, and where the copies are.

Everything on the `exposure` page is about the machinery *around* the personal
graph rather than the graph itself: the derived views the platform
instantiates over it, the standing subscriptions those views hold, the target
addresses some of them name in other subsystems, the Biome streams that feed
them (some of which arrive from another device on the owner's account), the
files each view writes, and the projection tables that hold further copies of
the same facts, some with their own full-text index over the same text.

It also reports the negatives, measured each time: whether the query cache in
globalKnowledge.db holds anything, which stores hold zero rows, which subscribed
predicates have no rows in the live graph, and which artifact columns are unset
on every row.

Two traps are closed here explicitly, because both produce false positives:

  * ZERO IS NOT NULL. `sourceListenerState.sourceUpdatedTimestamp` is 0.0 for a
    listener that has never fired, which formats as 2001-01-01. Every freshness
    query below filters on `> 0`. And `runByTimestamp` is a future SLA deadline,
    not a run time — it is never plotted as "last run".
  * EMPTY STRING IS NOT NULL. `viewState.errorMessage` is non-NULL on a third of
    the views and empty on every one of them. The count reported is
    `length(coalesce(errorMessage,'')) > 0`.

Every number is measured at request time.
"""

import json
import os
import re

from . import db, vocab

VIEWS = "graph/views.db"
GRAPH = "graph/graph.db"
GK = "graph/globalKnowledge.db"

ARTIFACT_PREFIX = "Artifacts__"
REBUILD_SUFFIX = "-fullRebuild"

# Tables every GRDB-managed store carries that are bookkeeping, not data.
# Anything in SQLite's own `sqlite_` namespace (sequence counters, ANALYZE
# statistics) is bookkeeping too — counting sqlite_stat1 as data makes an empty
# staging file look populated.
HOUSEKEEPING = ("grdb_migrations",)

# Views the platform ships as JSON, relative to the ontology bundle.
SHIPPED_VIEWS = ("Views", "config")


# ------------------------------------------------------------------ helpers

def _graph_files():
    """Every SQLite store in the graph bundle, split live / staging copy."""
    live, rebuild = [], []
    for n in db.graph_stores():
        (rebuild if REBUILD_SUFFIX in n else live).append(n)
    return live, rebuild


def _size(name):
    try:
        return os.path.getsize(db.resolve("graph/" + name))
    except OSError:
        return 0


def _objects(rel):
    """{name: sql} for every table in one store."""
    return {r["name"]: (r["sql"] or "")
            for r in db.query(rel, "select name, sql from sqlite_master where type='table'")}


def _fts_tables(objects):
    """Names of the FTS5 virtual tables in a store, by their declaration."""
    return {n for n, sql in objects.items() if "using fts" in sql.lower()}


def _data_tables(objects):
    """The tables that hold data: no migrations, no FTS index, no FTS shadow."""
    fts = _fts_tables(objects)
    out = []
    for n in objects:
        if n in HOUSEKEEPING or n in fts or n.startswith("sqlite_"):
            continue
        if any(n.startswith(f + "_") for f in fts):
            continue
        out.append(n)
    return sorted(out)


def _count(rel, table):
    try:
        with db.probe():
            return db.one(rel, f'select count(*) from "{table}"', default=0) or 0
    except Exception:
        return 0


def _columns(rel, table):
    return [r["name"] for r in db.query(rel, f'pragma table_info("{table}")')]


def _reified_columns():
    """The five columns that make a table a copy of the graph.

    Derived from the store rather than written down: graph.db's own full-text
    index over the triple layer is declared on exactly those five columns.
    """
    cols = _columns(GRAPH, "stable_graph_fts")
    if cols:
        return set(cols)
    # Degrade to the intersection of the two live layers minus the metadata
    # columns, which is the same set.
    stable = set(_columns(GRAPH, "stable_graph"))
    event = set(_columns(GRAPH, "event_graph"))
    meta = {"confidence", "sources", "timestamp", "sourceDuplicates", "hash"}
    return (stable & event) - meta


def _jload(value):
    """sourceListenerConfig.config is declared BLOB and holds JSON text."""
    if value is None:
        return {}
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return {}


def _artifact_file(path):
    """'internal/views.db' -> 'Artifacts__internal__views.db', if it exists."""
    if not path:
        return None
    name = ARTIFACT_PREFIX + path.strip("/").replace("/", "__")
    if not name.endswith(".db"):
        name += ".db"
    return name if os.path.exists(db.resolve("graph/" + name)) else None


# ------------------------------------------------------------------ catalogue

def _catalogue():
    rows = db.query(VIEWS, """
        select c.id, c.name, c.generationType, c.customType, c.artifactType,
               c.artifactPath, c.artifactTable, c.writeToStream, c.updateGroup, c.target,
               json_extract(c.config,'$.featureFlag') as feature_flag,
               (select count(*) from sourceListenerConfig s where s.viewOrderedId=c.id) as listeners,
               (select group_concat(distinct s.schedule) from sourceListenerConfig s where s.viewOrderedId=c.id) as schedules,
               (select count(*) from viewTables t where t.viewOrderedId=c.id) as tables,
               vs.tablesCreated, vs.diffType,
               (vs.bookmark is not null) as has_bookmark,
               (vs.errorMessage is not null) as error_not_null,
               length(coalesce(vs.errorMessage,'')) as error_len
        from viewConfigRecord c left join viewState vs on vs.viewOrderedId = c.id
        order by c.name
    """)
    for r in rows:
        r["id"] = vocab.sid(r["id"])

    def tally(key):
        seen = {}
        for r in rows:
            k = r.get(key)
            seen[k] = seen.get(k, 0) + 1
        return sorted(({"key": k, "views": n} for k, n in seen.items()),
                      key=lambda x: (-x["views"], str(x["key"])))

    flags = {}
    for r in rows:
        k = r["feature_flag"]
        e = flags.setdefault(k, {"key": k, "views": 0, "to_stream": 0})
        e["views"] += 1
        e["to_stream"] += 1 if r["writeToStream"] else 0
    flag_rows = sorted(flags.values(), key=lambda x: (-x["views"], str(x["key"])))

    enabled = []
    raw = db.one(VIEWS, "select value from keyValue where key='featureFlags'")
    if raw:
        try:
            enabled = list(json.loads(raw))
        except (ValueError, TypeError):
            enabled = []

    control_keys = db.query(VIEWS, "select key, length(value) as bytes from keyValue order by key")

    shipped = []
    try:
        cfgdir = os.path.join(db.ONTOLOGY_DIR, *SHIPPED_VIEWS)
        shipped = [n[:-5] for n in os.listdir(cfgdir) if n.endswith(".json")]
    except OSError:
        shipped = []
    live_names = {r["name"] for r in rows}
    shipped_set = set(shipped)

    return {
        "rows": rows,
        "views": len(rows),
        "by_generation": tally("generationType"),
        "by_artifact_type": tally("artifactType"),
        "flags": flag_rows,
        "flags_enabled": sorted(enabled),
        "flags_referenced": sorted({r["key"] for r in flag_rows if r["key"]}),
        "control_keys": control_keys,
        "shipped": len(shipped_set),
        "instantiated_with_config": len(live_names & shipped_set),
        "shipped_unused": len(shipped_set - live_names),
        "compiled_in": sorted(live_names - shipped_set),
        "state": {
            "tables_created": sum(1 for r in rows if r["tablesCreated"]),
            "bookmarks": sum(1 for r in rows if r["has_bookmark"]),
            "error_not_null": sum(1 for r in rows if r["error_not_null"]),
            "error_non_empty": sum(1 for r in rows if (r["error_len"] or 0) > 0),
        },
    }


# ------------------------------------------------------------------ consumers

def _consumers():
    by_type = db.query(VIEWS, """
        select s.sourceType as source_type, count(*) as listeners,
               count(distinct s.viewOrderedId) as views,
               sum(s.schedule='live') as live,
               sum(s.highPriority) as high_priority,
               sum(s.fullRebuildOnChange) as full_rebuild,
               group_concat(distinct s.schedule) as schedules
        from sourceListenerConfig s group by 1 order by listeners desc
    """)
    matrix = db.query(VIEWS, """
        select s.sourceType as source_type, s.schedule, count(*) as listeners,
               count(distinct s.viewOrderedId) as views
        from sourceListenerConfig s group by 1,2 order by listeners desc
    """)
    profile = db.query(VIEWS, """
        select c.name, c.artifactType, c.target,
               sum(s.sourceType='knowledgeGraph')       as kg,
               sum(s.sourceType='globalKnowledgeGraph') as gk,
               sum(s.sourceType='biome')                as biome,
               sum(s.sourceType='view')                 as derived,
               sum(s.sourceType='keyValueDatabase')     as kv,
               sum(s.sourceType='alwaysUpdate')         as always
        from viewConfigRecord c join sourceListenerConfig s on s.viewOrderedId=c.id
        group by c.id order by kg desc, biome desc, c.name
    """)
    primary = [r for r in profile if (r["kg"] or 0) + (r["gk"] or 0) + (r["biome"] or 0) > 0]

    # What the personal-graph subscribers actually watch, decoded.
    watch, predicate_use = _subscriptions()

    sources = db.query(VIEWS, """
        select sourceType as source_type, count(*) as sources,
               sum(available) as available,
               count(distinct updateType) as update_types
        from sourceState group by 1 order by sources desc
    """)

    return {
        "by_type": by_type,
        "matrix": matrix,
        "profile": profile,
        "primary_readers": len(primary),
        "derived_only": len(profile) - len(primary),
        "listeners": db.one(VIEWS, "select count(*) from sourceListenerConfig", default=0),
        "no_listeners": db.one(VIEWS,
            "select count(*) from viewConfigRecord c where not exists"
            " (select 1 from sourceListenerConfig s where s.viewOrderedId=c.id)", default=0),
        "kg_views": db.one(VIEWS,
            "select count(distinct viewOrderedId) from sourceListenerConfig where sourceType='knowledgeGraph'",
            default=0),
        "sources": sources,
        "source_rows": db.one(VIEWS, "select count(*) from sourceState", default=0),
        "watch": watch,
        "predicates": predicate_use,
    }


def _subscriptions():
    """Decode every knowledgeGraph listener filter: which entity classes and
    which predicate paths each consumer subscribes to, and how many triples of
    each subscribed predicate the live graph actually holds."""
    rows = db.query(VIEWS, """
        select c.name as view_name, s.schedule, s.config
        from sourceListenerConfig s join viewConfigRecord c on c.id=s.viewOrderedId
        where s.sourceType='knowledgeGraph' order by c.name
    """)

    known_preds = vocab.predicates()
    known_classes = vocab.classes()

    watch = []
    pred_views = {}
    path_views = {}
    for r in rows:
        cfg = _jload(r["config"])
        filters = cfg.get("filters") or []
        classes, paths, srcs = [], [], []
        for f in filters:
            et = f.get("entityType")
            if et:
                classes.append(et)
            for p in f.get("predicates") or []:
                paths.append(p)
                path_views.setdefault(p, set()).add(r["view_name"])
                for seg in str(p).split("/"):
                    if seg in known_preds:
                        pred_views.setdefault(seg, set()).add(r["view_name"])
            for s in f.get("sources") or []:
                srcs.append(s)
        watch.append({
            "view": r["view_name"],
            "schedule": r["schedule"],
            "stores": cfg.get("stores") or [],
            "classes": [{"id": c, "label": known_classes.get(c, c)} for c in classes],
            "paths": sorted(set(paths)),
            "n_paths": len(set(paths)),
            "sources": sorted(set(srcs)),
            "unfiltered": not filters or all(
                not f.get("entityType") and not f.get("predicates") for f in filters),
        })

    # Every subscribed predicate, against its live population and what the
    # retraction archive still holds of it.
    expired = [t for t in ("expired_stable_graph", "expired_event_graph") if db.has_table(GRAPH, t)]
    preds = []
    for pid, views in pred_views.items():
        n = db.one(GRAPH, """
            select (select count(*) from stable_graph where predicate=? or relationshipPredicate=?)
                 + (select count(*) from event_graph  where predicate=? or relationshipPredicate=?)
        """, (pid, pid, pid, pid), default=0) or 0
        archived = sum(db.one(GRAPH, f"select count(*) from {t} where predicate=? or relationshipPredicate=?",
                              (pid, pid), default=0) or 0 for t in expired)
        preds.append({
            "predicate": pid,
            "label": vocab.plabel(pid),
            "views": sorted(views),
            "n_views": len(views),
            "triples": n,
            "archived": archived,
        })
    preds.sort(key=lambda p: (-p["triples"], -p["n_views"], p["predicate"]))

    paths = [{"path": p,
              "segments": [{"id": s,
                            "label": vocab.plabel(s) if s in known_preds else known_classes.get(s, s),
                            "kind": "predicate" if s in known_preds else
                                    ("class" if s in known_classes else "unknown")}
                           for s in p.split("/")],
              "views": sorted(v), "n_views": len(v)}
             for p, v in path_views.items()]
    paths.sort(key=lambda x: (-x["n_views"], x["path"]))

    return {"listeners": watch, "paths": paths}, preds


# ------------------------------------------------------------------ targets

def _targets():
    rows = db.query(VIEWS, """
        select name, target, artifactType, generationType, writeToStream, artifactPath
        from viewConfigRecord where target is not null and target<>'' order by target
    """)
    groups = {}
    for r in rows:
        head = r["target"].rsplit(".", 1)[0] if "." in r["target"] else r["target"]
        g = groups.setdefault(head, {"database": head, "views": [], "local_file": None})
        g["views"].append(r["name"])
        g["local_file"] = _artifact_file(r["artifactPath"])
    out = sorted(groups.values(), key=lambda g: (-len(g["views"]), g["database"]))
    for g in out:
        g["n_views"] = len(g["views"])
    return {"rows": rows, "databases": out}


def _streams():
    rows = db.query(VIEWS, """
        select name, artifactType, customType, artifactPath, artifactTable, target
        from viewConfigRecord where writeToStream=1 order by name
    """)
    for r in rows:
        f = _artifact_file(r["artifactPath"])
        r["local_file"] = f
        r["rows_now"] = None
        if f:
            rel = "graph/" + f
            objs = _objects(rel)
            if r["artifactTable"] and r["artifactTable"] in objs:
                r["rows_now"] = _count(rel, r["artifactTable"])
            else:
                r["rows_now"] = sum(_count(rel, t) for t in _data_tables(objs))
                r["whole_file"] = True
    return rows


# ------------------------------------------------------------------ biome

def _biome():
    streams = db.query(VIEWS, """
        select case when instr(sourceIdentifier,':remotes:')>0
                    then substr(sourceIdentifier,1,instr(sourceIdentifier,':remotes:')-1)
                    else sourceIdentifier end as stream,
               sum(instr(sourceIdentifier,':remotes:')=0) as local_rows,
               sum(instr(sourceIdentifier,':remotes:')>0) as remote_rows,
               count(distinct case when instr(sourceIdentifier,':remotes:')>0
                    then substr(sourceIdentifier,instr(sourceIdentifier,':remotes:')+9) end) as devices,
               max(modifiedTimestamp) as last_modified,
               count(*) as rows_total
        from sourceState where sourceType='biome'
        group by 1 order by remote_rows desc, stream
    """)
    for s in streams:
        s["last_modified"] = db.apple_time(s["last_modified"])
        s["cross_device"] = bool(s["remote_rows"])

    devices = db.one(VIEWS, """
        select count(distinct substr(sourceIdentifier, instr(sourceIdentifier,':remotes:')+9))
        from sourceState
        where sourceType='biome' and instr(sourceIdentifier,':remotes:')>0
    """, default=0) or 0

    # The listener side: which subscriptions are cross-device only, and which
    # platform families they name.
    listeners = db.query(VIEWS, """
        select json_extract(j.value,'$.stream') as stream,
               json_extract(j.value,'$.schedule') as schedule,
               count(*) as listeners,
               count(distinct c.name) as views,
               group_concat(distinct c.name) as view_names,
               sum(coalesce(json_extract(j.value,'$.excludeLocal'),0)) as cross_device_only,
               max(json_array_length(coalesce(json_extract(j.value,'$.syncedDeviceTypes'),'[]'))) as device_types
        from viewConfigRecord c, json_each(json_extract(c.config,'$.update.biomeListeners')) j
        group by 1,2 order by stream, schedule
    """)
    platforms = []
    for r in db.query(VIEWS, """
        select distinct json_extract(j.value,'$.syncedDeviceTypes') as types
        from viewConfigRecord c, json_each(json_extract(c.config,'$.update.biomeListeners')) j
        where types is not null
    """):
        try:
            platforms = sorted(set(platforms) | set(json.loads(r["types"])))
        except (ValueError, TypeError):
            pass

    remote_key = db.query(VIEWS, "select key, length(value) as bytes from keyValue where key='remoteDevices'")

    return {
        "streams": streams,
        "devices": devices,
        "cross_streams": sum(1 for s in streams if s["cross_device"]),
        "listeners": listeners,
        "platforms": platforms,
        "remote_key_bytes": remote_key[0]["bytes"] if remote_key else None,
    }


# ------------------------------------------------------------------ freshness

def _freshness():
    totals = db.query(VIEWS, """
        select count(*) as states,
               sum(sourceUpdatedTimestamp > 0) as fired,
               sum(sourceUpdatedTimestamp <= 0) as never,
               sum(bookmark is not null) as bookmarks
        from sourceListenerState
    """)[0]

    by_type = db.query(VIEWS, """
        select coalesce(s.sourceType,'(source row missing)') as source_type,
               count(*) as states,
               sum(sl.sourceUpdatedTimestamp > 0) as fired,
               sum(sl.sourceUpdatedTimestamp <= 0) as never,
               max(case when sl.sourceUpdatedTimestamp > 0 then sl.sourceUpdatedTimestamp end) as newest,
               min(case when sl.sourceUpdatedTimestamp > 0 then sl.sourceUpdatedTimestamp end) as oldest
        from sourceListenerState sl left join sourceState s on s.sourceId = sl.sourceId
        group by 1 order by states desc
    """)
    for r in by_type:
        r["newest"] = db.apple_time(r["newest"])
        r["oldest"] = db.apple_time(r["oldest"])

    months = db.query(VIEWS, """
        select strftime('%Y-%m', sourceUpdatedTimestamp + 978307200, 'unixepoch') as month,
               count(*) as listeners
        from sourceListenerState where sourceUpdatedTimestamp > 0
        group by 1 order by 1
    """)

    never = db.query(VIEWS, """
        select c.name as view_name, count(*) as listeners,
               group_concat(distinct coalesce(s.sourceType,'(none)')) as source_types
        from sourceListenerState sl
        join sourceListenerConfig cfg on cfg.sourceListenerConfigId = sl.sourceListenerConfigId
        join viewConfigRecord c on c.id = cfg.viewOrderedId
        left join sourceState s on s.sourceId = sl.sourceId
        where sl.sourceUpdatedTimestamp <= 0
        group by 1 order by listeners desc, view_name
    """)

    recent = db.query(VIEWS, """
        select c.name as view_name, sl.sourceUpdatedTimestamp as ts,
               coalesce(s.sourceType,'(none)') as source_type,
               coalesce(nullif(s.sourceIdentifier,''),'(the whole graph)') as source_ref
        from sourceListenerState sl
        join sourceListenerConfig cfg on cfg.sourceListenerConfigId = sl.sourceListenerConfigId
        join viewConfigRecord c on c.id = cfg.viewOrderedId
        left join sourceState s on s.sourceId = sl.sourceId
        where sl.sourceUpdatedTimestamp > 0
        order by sl.sourceUpdatedTimestamp desc limit 40
    """)
    for r in recent:
        # A biome identifier can carry a paired-device UUID. Count them, never
        # render them: the suffix names the owner's other hardware.
        ref = r["source_ref"] or ""
        cut = ref.find(":remotes:")
        if cut >= 0:
            r["source_ref"] = ref[:cut]
            r["from_paired_device"] = True
        r["ts"] = db.apple_time(r["ts"])

    sla = db.query(VIEWS, """
        select sum(runByTimestamp > 0) as pending, max(runByTimestamp) as furthest
        from sourceListenerState
    """)[0]
    sla["furthest"] = db.apple_time(sla["furthest"])

    source_months = db.query(VIEWS, """
        select strftime('%Y-%m', modifiedTimestamp + 978307200, 'unixepoch') as month,
               sourceType as source_type, count(*) as sources
        from sourceState group by 1,2 order by 1,2
    """)

    return {"totals": totals, "by_type": by_type, "months": months, "never": never,
            "recent": recent, "sla": sla, "source_months": source_months,
            "capture": db.apple_time(db.one(VIEWS,
                "select max(modifiedTimestamp) from sourceState", default=None))}


# ------------------------------------------------------------------ outputs

def _outputs():
    """Which table each view writes, into which file on disk."""
    rows = db.query(VIEWS, """
        select c.name as view_name, t.tableName as table_name, c.artifactPath as path,
               c.writeToStream, c.target
        from viewTables t join viewConfigRecord c on c.id = t.viewOrderedId
        order by c.artifactPath, c.name, t.tableName
    """)

    # Every declared output path, including the ten views that declare no table.
    files = {}
    for r in db.query(VIEWS, """
        select artifactPath as path, count(*) as n_views,
               group_concat(name, ', ') as views,
               sum(writeToStream) as to_stream
        from viewConfigRecord where artifactPath is not null and artifactPath <> ''
        group by 1 order by n_views desc, path
    """):
        f = _artifact_file(r["path"])
        files[r["path"]] = {
            "path": r["path"], "file": f, "external": f is None,
            "bytes": _size(f) if f else 0, "n_views": r["n_views"],
            "to_stream": r["to_stream"] or 0, "tables": set(), "rows": 0, "rows_file": 0,
        }

    for r in rows:
        r["file"] = _artifact_file(r["path"])
        r["external"] = r["file"] is None
        e = files.get(r["path"])
        if e:
            e["tables"].add(r["table_name"])

    for e in files.values():
        if not e["file"]:
            continue
        rel = "graph/" + e["file"]
        objs = _objects(rel)
        e["rows"] = sum(_count(rel, t) for t in e["tables"] if t in objs)
        e["rows_file"] = sum(_count(rel, t) for t in _data_tables(objs))

    out = []
    for e in files.values():
        out.append({k: (len(v) if isinstance(v, set) else v)
                    for k, v in e.items() if k != "tables"})
        out[-1]["n_tables"] = len(e["tables"])
    out.sort(key=lambda x: (-x["n_views"], x["path"]))

    shared = {}
    for r in rows:
        shared.setdefault(r["table_name"], set()).add(r["view_name"])
    collisions = sorted(({"table_name": t, "views": len(v)} for t, v in shared.items() if len(v) > 1),
                        key=lambda x: -x["views"])

    return {
        "rows": rows,
        "files": out,
        "pairs": len(rows),
        "distinct_tables": len(shared),
        "distinct_paths": len(out),
        "local": sum(1 for e in out if not e["external"]),
        "external": sum(1 for e in out if e["external"]),
        "local_bytes": sum(e["bytes"] for e in out if not e["external"]),
        "views_with_tables": len({r["view_name"] for r in rows}),
        "views_without_tables": db.one(VIEWS,
            "select count(*) from viewConfigRecord c where not exists"
            " (select 1 from viewTables t where t.viewOrderedId=c.id)", default=0),
        "collisions": collisions,
    }


# ------------------------------------------------------------------ projections

def _projections():
    five = _reified_columns()
    live, rebuild = _graph_files()

    stable = _count(GRAPH, "stable_graph")
    event = _count(GRAPH, "event_graph")
    live_total = stable + event

    # The graph indexes its own object text twice before any projection exists.
    graph_fts = []
    gobjs = _objects(GRAPH)
    for t in sorted(_fts_tables(gobjs)):
        graph_fts.append({"table": t, "rows": _count(GRAPH, t)})

    rows, empty = [], []
    for name in live:
        if not name.startswith(ARTIFACT_PREFIX):
            continue
        rel = "graph/" + name
        objs = _objects(rel)
        fts = _fts_tables(objs)
        for t in _data_tables(objs):
            cols = set(_columns(rel, t))
            if not five <= cols:
                continue
            n = _count(rel, t)
            idx = sorted(f for f in fts if f.startswith(t + "_"))
            entry = {
                "file": name,
                "table": t,
                "rows": n,
                "subjects": db.one(rel, f'select count(distinct subject) from "{t}"', default=0) or 0,
                "fts": idx,
                "fts_rows": sum(_count(rel, f) for f in idx),
                "bytes": _size(name),
            }
            (rows if n else empty).append(entry)

    rows.sort(key=lambda r: -r["rows"])
    total = sum(r["rows"] for r in rows)
    fts_rows = sum(r["fts_rows"] for r in rows)

    return {
        "rows": rows,
        "empty": sorted(empty, key=lambda r: r["table"]),
        "count": len(rows),
        "total": total,
        "live_total": live_total,
        "stable": stable,
        "event": event,
        "ratio": (total / live_total) if live_total else None,
        "with_fts": sum(1 for r in rows if r["fts"]),
        "fts_rows": fts_rows,
        "graph_fts": graph_fts,
        "graph_fts_rows": sum(g["rows"] for g in graph_fts),
        "rebuild_files": len(rebuild),
    }


# ------------------------------------------------------------------ off-device cache

def _cache():
    objs = _objects(GK)
    data = _data_tables(objs)

    # The off-device cache is not identified by name: it is the set of tables
    # whose rows carry a time-to-live, i.e. rows that were fetched from
    # somewhere else and are meant to expire. Shipped world knowledge has an
    # assetId instead and never expires.
    cache_tables, shipped_tables = [], []
    for t in data:
        cols = set(_columns(GK, t))
        if "ttlTimestamp" in cols:
            cache_tables.append(t)
        elif "assetId" in cols:
            shipped_tables.append(t)

    occupancy = []
    for t in cache_tables:
        cols = set(_columns(GK, t))
        row = {"table": t, "rows": _count(GK, t), "columns": sorted(cols)}
        row["distinct_predicates"] = (db.one(GK, f'select count(distinct predicate) from "{t}"', default=0)
                                      if "predicate" in cols else None)
        row["distinct_clients"] = (db.one(GK, f'select count(distinct clients) from "{t}"', default=0)
                                   if "clients" in cols else None)
        row["first_cached"] = db.apple_time(db.one(GK, f'select min(timestamp) from "{t}"')) if "timestamp" in cols else None
        row["last_ttl"] = db.apple_time(db.one(GK, f'select max(ttlTimestamp) from "{t}"'))
        occupancy.append(row)

    shipped = []
    for t in shipped_tables:
        shipped.append({"table": t, "rows": _count(GK, t)})
    assets = db.query(GK, """
        select a.name, a.version, a.type, count(s.subject) as triples,
               count(distinct s.subject) as entities
        from static_assets a left join static_graph s on s.assetId = a.id
        group by a.id order by triples desc
    """)

    # Storage forensics. dbstat reads every page, so it runs once, here, and
    # never inside a loop. Every b-tree is attributed to the table it belongs
    # to through sqlite_master, so an auto-index lands in its owner's zone
    # rather than in a catch-all.
    owner = {}
    for r in db.query(GK, "select name, type, tbl_name from sqlite_master"):
        owner[r["name"]] = r["tbl_name"] or r["name"]

    def _zone(name):
        base = owner.get(name)
        if base is None:                       # an auto-index or FTS shadow
            for t in sorted(owner, key=len, reverse=True):
                if name.startswith(t):
                    base = owner[t]
                    break
        if base is None and name.startswith("sqlite_autoindex_"):
            base = name[len("sqlite_autoindex_"):].rsplit("_", 1)[0]
        if base in cache_tables:
            return "off-device cache"
        if base in shipped_tables:
            return "shipped world knowledge"
        for t in cache_tables:
            if name.startswith(t):
                return "off-device cache"
        for t in shipped_tables:
            if name.startswith(t) or (base or "").startswith(t):
                return "shipped world knowledge"
        return "store metadata"

    forensics, zones, forensics_error = [], [], None
    try:
        with db.probe():
            found = db.query(GK, """
                select name, sum(pgsize) as bytes, sum(ncell) as cells, count(*) as page_count
                from dbstat group by name order by bytes desc
            """)
        for r in found:
            r["zone"] = _zone(r["name"])
            forensics.append(r)
    except Exception as exc:           # dbstat is optional in some builds
        forensics_error = str(exc)
        page = db.one(GK, "pragma page_count", default=0)
        size = db.one(GK, "pragma page_size", default=0)
        forensics_error += f" — file holds {page} pages of {size} bytes"

    agg = {}
    for r in forensics:
        z = agg.setdefault(r["zone"], {"zone": r["zone"], "bytes": 0, "cells": 0, "page_count": 0, "objects": 0})
        z["bytes"] += r["bytes"] or 0
        z["cells"] += r["cells"] or 0
        z["page_count"] += r["page_count"] or 0
        z["objects"] += 1
    zones = sorted(agg.values(), key=lambda z: -z["bytes"])

    flags = []
    raw = db.one(VIEWS, "select value from keyValue where key='featureFlags'")
    if raw:
        try:
            flags = list(json.loads(raw))
        except (ValueError, TypeError):
            flags = []
    # Which enabled flag governs the world-knowledge service? The one whose name
    # is a case-insensitive match for a globalKnowledge consumer source type.
    gk_types = {r["sourceType"] for r in db.query(VIEWS, "select distinct sourceType from sourceListenerConfig")}
    gk_flag = None
    for f in flags:
        key = f.lower().replace("service", "")
        if any(key and key in t.lower() for t in gk_types):
            gk_flag = f
    gk_listeners = db.query(VIEWS, """
        select c.name as view_name, s.schedule,
               coalesce(json_extract(s.config,'$.assetName'), json_extract(s.config,'$.name')) as asset
        from sourceListenerConfig s join viewConfigRecord c on c.id=s.viewOrderedId
        where s.sourceType='globalKnowledgeGraph' order by c.name
    """)

    return {
        "occupancy": occupancy,
        "shipped": shipped,
        "assets": assets,
        "forensics": forensics,
        "forensics_error": forensics_error,
        "zones": zones,
        "cache_bytes": sum(z["bytes"] for z in zones if z["zone"] == "off-device cache"),
        "total_bytes": sum(z["bytes"] for z in zones),
        "file_bytes": _size(os.path.basename(GK)),
        "service_flag": gk_flag,
        "flags_enabled": sorted(flags),
        "gk_listeners": gk_listeners,
    }


# ------------------------------------------------------------------ side store

KEYVALUE = "graph/keyvalue.db"

# Key shapes, recognised by pattern so the page can say what a key *is* without
# ever printing one. Order matters: the first match wins.
KEY_SHAPES = [
    (re.compile(r"^[0-9A-Fa-f-]{36}/L0/\d+$"), "a Photos local identifier — joins into the photo library"),
    (re.compile(r"^[A-Za-z]{2,4}:\d{10,}$"),   "an entity id in one of the graph's id spaces"),
    (re.compile(r"^[0-9A-Fa-f-]{36}$"),         "a bare UUID"),
    (re.compile(r"^Q\d+$"),                     "a Wikidata concept id"),
    (re.compile(r"^P\d+$"),                     "a Wikidata property id"),
    (re.compile(r"^\d{10,}$"),                  "a bare numeric id"),
    (re.compile(r"^[A-Za-z]\w*\s*:\s*\w+\."),   "a pipeline phase timing key"),
]


def _key_shape(key):
    for pattern, label in KEY_SHAPES:
        if pattern.match(key or ""):
            return label
    return "a word or label"


def _side_store():
    """The platform's opaque key-value bag. Its values are binary plists and are
    never read here; its KEYS are plain text and several domains are keyed by
    identifiers that join straight into the photo library and into the graph.
    Counted and classified by shape — never printed."""
    rows = db.query(KEYVALUE, """
        select domain, count(*) as keys, sum(length(value)) as value_bytes,
               min(length(key)) as min_key, max(length(key)) as max_key
        from keyvalue group by domain order by keys desc
    """)
    if not rows:
        return {"domains": [], "keys": 0, "value_bytes": 0, "shapes": [], "joinable": 0}

    shapes = {}
    for r in rows:
        counts = {}
        for k in db.query(KEYVALUE, "select key from keyvalue where domain=?", (r["domain"],)):
            shape = _key_shape(k["key"])
            counts[shape] = counts.get(shape, 0) + 1
            shapes[shape] = shapes.get(shape, 0) + 1
        r["shape"] = max(counts, key=counts.get)
        r["shape_mix"] = sorted(({"shape": k, "keys": v} for k, v in counts.items()),
                                key=lambda x: -x["keys"])
        # Values are bplist blobs: report that they are opaque, not their bytes.
        head = db.one(KEYVALUE, "select substr(hex(value),1,12) from keyvalue where domain=? limit 1",
                      (r["domain"],))
        r["opaque_values"] = bool(head and bytes.fromhex(head).startswith(b"bplist"))

    joinable = sum(r["keys"] for r in rows
                   if "Photos" in r["shape"] or "id space" in r["shape"] or "numeric id" in r["shape"])

    return {
        "domains": rows,
        "keys": sum(r["keys"] for r in rows),
        "value_bytes": sum(r["value_bytes"] or 0 for r in rows),
        "shapes": sorted(({"shape": k, "keys": v} for k, v in shapes.items()), key=lambda x: -x["keys"]),
        "joinable": joinable,
        "opaque_domains": sum(1 for r in rows if r["opaque_values"]),
    }


# ------------------------------------------------------------------ negatives

def _empty_stores():
    live, rebuild = _graph_files()
    stores, tables_with_rows = [], 0
    for name in live:
        rel = "graph/" + name
        objs = _objects(rel)
        data = _data_tables(objs)
        counts = {t: _count(rel, t) for t in data}
        total = sum(counts.values())
        tables_with_rows += sum(1 for v in counts.values() if v)
        stores.append({
            "store": name,
            "artifact": name.startswith(ARTIFACT_PREFIX),
            "tables": len(data),
            "rows": total,
            "bytes": _size(name),
            "empty_tables": sorted(t for t, v in counts.items() if not v),
        })
    stores.sort(key=lambda s: (s["rows"], -s["bytes"]))

    rebuild_rows = []
    for name in rebuild:
        rel = "graph/" + name
        objs = _objects(rel)
        data = _data_tables(objs)
        rebuild_rows.append({
            "store": name,
            "rows": sum(_count(rel, t) for t in data),
            "bytes": _size(name),
        })

    empty = [s for s in stores if not s["rows"]]
    artifacts = [s for s in stores if s["artifact"]]
    return {
        "stores": stores,
        "empty": empty,
        "empty_bytes": sum(s["bytes"] for s in empty),
        "artifacts": len(artifacts),
        "artifacts_empty": sum(1 for s in artifacts if not s["rows"]),
        "rebuild": sorted(rebuild_rows, key=lambda r: -r["bytes"]),
        "rebuild_rows": sum(r["rows"] for r in rebuild_rows),
        "rebuild_bytes": sum(r["bytes"] for r in rebuild_rows),
        "hollow_tables": [
            {"store": s["store"], "table": t}
            for s in stores if s["rows"] for t in s["empty_tables"]
        ],
    }


# Columns worth testing for "exists but unset": a flag or a label, not a score.
_SMALL_TABLE = 4000


def _unset_fields(hollow):
    """Every column in a populated artifact table that carries exactly one
    value on every row, and that value is off — 0, or the empty string.

    Computed by sweeping the columns, not by quoting the brief: a column that
    started varying tomorrow would drop off this list on its own.
    """
    live, _ = _graph_files()
    out = []
    for name in live:
        if not name.startswith(ARTIFACT_PREFIX):
            continue
        rel = "graph/" + name
        objs = _objects(rel)
        for t in _data_tables(objs):
            n = _count(rel, t)
            if not n or n > _SMALL_TABLE:
                continue
            info = db.query(rel, f'pragma table_info("{t}")')
            if len(info) > 40:
                continue
            for col in info:
                c, declared = col["name"], (col["type"] or "").upper()
                try:
                    with db.probe():
                        row = db.query(rel, f'''
                            select count(distinct "{c}") as distinct_values,
                                   sum("{c}" is null) as nulls,
                                   max(typeof("{c}")) as kind,
                                   min("{c}") as only_value
                            from "{t}"''')[0]
                except Exception:
                    continue
                if (row["distinct_values"] or 0) > 1:
                    continue
                v = row["only_value"]
                blank = (v is None) or (v == 0) or (isinstance(v, str) and v == "")
                if not blank:
                    continue
                if declared.startswith("BOOL"):
                    shape = "flag, never set"
                elif row["kind"] == "null" or v is None:
                    shape = "null on every row"
                elif isinstance(v, str):
                    shape = "text, empty on every row"
                else:
                    shape = "number, zero on every row"
                out.append({
                    "store": name, "table": t, "column": c, "rows": n,
                    "declared": declared or "(untyped)",
                    "kind": row["kind"], "shape": shape,
                    "value": "" if isinstance(v, str) else v,
                })
    out.sort(key=lambda r: (-r["rows"], r["store"], r["table"], r["column"]))
    return out


def _context_machinery(hollow):
    """The relevance model names context features; several of the tables that
    would hold that context are empty. Link the two, through views.db."""
    # The features the shipped ranker actually cites, from its own explanations.
    feats = set()
    inference_files = [n for n in _graph_files()[0]
                       if n.startswith(ARTIFACT_PREFIX)]
    for name in inference_files:
        rel = "graph/" + name
        objs = _objects(rel)
        for t in _data_tables(objs):
            if "explanation" not in set(_columns(rel, t)):
                continue
            for r in db.query(rel, f'select explanation from "{t}"'):
                try:
                    j = json.loads(r["explanation"])
                except (ValueError, TypeError):
                    continue
                for key in ("positiveContributions", "negativeContributions"):
                    for item in j.get(key) or []:
                        if isinstance(item, dict) and item.get("name"):
                            feats.add(item["name"])

    # Which view writes each empty table, and whether its listeners ever fired.
    owners = {}
    for r in db.query(VIEWS, """
        select t.tableName as table_name, c.name as view_name, c.artifactPath as path,
               (select count(*) from sourceListenerConfig s where s.viewOrderedId=c.id) as listeners,
               (select count(*) from sourceListenerState sl
                  join sourceListenerConfig cfg on cfg.sourceListenerConfigId = sl.sourceListenerConfigId
                 where cfg.viewOrderedId = c.id and sl.sourceUpdatedTimestamp > 0) as fired,
               (select count(*) from sourceListenerState sl
                  join sourceListenerConfig cfg on cfg.sourceListenerConfigId = sl.sourceListenerConfigId
                 where cfg.viewOrderedId = c.id and sl.sourceUpdatedTimestamp <= 0) as never
        from viewTables t join viewConfigRecord c on c.id = t.viewOrderedId
    """):
        owners[r["table_name"]] = r

    rows, orphans = [], []
    for e in hollow:
        o = owners.get(e["table"])
        base = re.sub(r"(ContextEvents|Events|Keys|Histograms)$", "", e["table"])
        cited = sorted(f for f in feats if base and base.lower() in f.lower())
        entry = {
            "table": e["table"], "store": e["store"],
            "view": o["view_name"] if o else None,
            "listeners": o["listeners"] if o else None,
            "listeners_fired": o["fired"] if o else None,
            "listeners_never": o["never"] if o else None,
            "model_features": cited,
        }
        (rows if o else orphans).append(entry)
    rows.sort(key=lambda r: (-len(r["model_features"]), r["table"]))
    orphans.sort(key=lambda r: (r["store"], r["table"]))

    # Every context the ranker is written to condition on, and whether the
    # table that would supply it holds anything on this device.
    tokens = set()
    for f in feats:
        _, _, tail = f.partition(":")
        for part in tail.split("+"):
            part = part.strip()
            if part:
                tokens.add(part)
    feeds = _context_tables()
    supply = []
    for tok in sorted(tokens):
        best = None
        for store, table, n in feeds:
            if table.lower().startswith(tok.lower()):
                if best is None or n > best[2]:
                    best = (store, table, n)
        supply.append({
            "context": tok,
            "table": best[1] if best else None,
            "store": best[0] if best else None,
            "rows": best[2] if best else None,
            "features": sorted(f for f in feats if tok.lower() in f.lower()),
        })
    supply.sort(key=lambda x: (x["rows"] is None, x["rows"] or 0, x["context"]))

    by_store = {}
    for o in orphans:
        by_store[o["store"]] = by_store.get(o["store"], 0) + 1
    orphan_stores = sorted(({"store": k, "tables": v} for k, v in by_store.items()),
                           key=lambda x: (-x["tables"], x["store"]))

    return {"rows": rows, "orphans": orphans, "orphan_stores": orphan_stores,
            "features": sorted(feats), "supply": supply}


def _context_tables():
    """(store, table, rows) for every artifact table — built once per request
    and reused across the context tokens rather than rescanned per token."""
    out = []
    for name in _graph_files()[0]:
        if not name.startswith(ARTIFACT_PREFIX):
            continue
        rel = "graph/" + name
        for t in _data_tables(_objects(rel)):
            out.append((name, t, _count(rel, t)))
    return out


# ------------------------------------------------------------------ handler

def handler(params):
    catalogue = _catalogue()
    consumers = _consumers()
    empty = _empty_stores()
    hollow = empty["hollow_tables"]
    return {
        "catalogue": catalogue,
        "consumers": consumers,
        "targets": _targets(),
        "streams": _streams(),
        "biome": _biome(),
        "freshness": _freshness(),
        "outputs": _outputs(),
        "projections": _projections(),
        "cache": _cache(),
        "stores": empty,
        "side_store": _side_store(),
        "unset": _unset_fields(hollow),
        "context": _context_machinery(hollow),
    }


ROUTES = {"/api/exposure": handler}
