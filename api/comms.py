"""comms.py — the interaction log's communication metadata, and not one message body.

Everything here comes out of `Artifacts__siri__remembers__view.db`: one row per
donated interaction (a message sent or received, a call placed or answered),
joined to the counterparty entities the interaction named. The store keeps who,
when, through which app, in which direction and for how long. It keeps no text.

Three columns whose meaning this module measures instead of reading it off a
public Apple enum, since nothing shows the store uses those enums' numbering:

* **direction**. Which enum the column follows is not documented. The test is
  empirical: the `sender` parameter in
  `interactionEntities` can only exist on an *incoming* interaction, so
  whichever direction value carries `sender` is the incoming one. We run that
  test on every request (`direction_values`, shared with the social endpoint)
  and label the charts from the result.
* **handlingStatus**. The connected-call status is simply the one whose rows
  carry a duration, so we rank the statuses by how much talk time they hold.
* **contentHash** is a *thread* key, not a message hash — thousands of
  interactions share a few hundred values. It is used here for a conversation
  census and never as a message count.

Timestamps are Apple epoch stored as REAL; every conversion adds 978307200 and
goes through `unixepoch`. Hour-of-day is resolved in the host's local zone via
SQLite's `localtime` modifier, which follows DST per timestamp; the zone label
is reported alongside so the reader knows what the clock means.
"""

import calendar
import time

from . import db, vocab

STORE = "graph/Artifacts__siri__remembers__view.db"

# Apple absolute time -> unix seconds, inline in SQL.
TS = "(%s + 978307200)"

# Display caps. Every one of these is echoed to the page so a capped list never
# reads as a complete one.
TOP_CONTACTS = 24
TOP_GROUPS = 18
TOP_DORMANT = 20
TOP_OFFHOURS = 20
TOP_RECIPROCITY = 24
TOP_THREADS = 12

# A quiet hour is one carrying less than this share of an even hourly spread.
QUIET_FRACTION = 0.25

# Communication domains. Anything else in the store is a non-communication
# intent (a timer, a weather lookup) and is excluded from rhythm charts.
COMMS_DOMAINS = ("Messages", "Calls")

APPLE_PREFIX = "com.apple."


# ---------------------------------------------------------------- helpers


# Per direction value: how many rows carry a `sender`, and how many name
# recipients. The sender test below reads the column's meaning off these.
DIRECTION_SQL = """
    SELECT i.direction AS value, COUNT(*) AS n,
           SUM(EXISTS(SELECT 1 FROM interactionEntities ie
                      WHERE ie.interactionRowid = i.rowid
                        AND ie.parameter = 'sender')) AS with_sender,
           SUM(EXISTS(SELECT 1 FROM interactionEntities ie
                      WHERE ie.interactionRowid = i.rowid
                        AND ie.parameter IN ('recipients','contacts','recipientHandles','contactHandles'))) AS with_recipient
    FROM interactions i
    GROUP BY 1 ORDER BY 1
"""


def _direction_mapping(rows):
    """(incoming value, outgoing value) by the sender test: incoming is whichever
    direction carries `sender`, outgoing the other one that names recipients.
    None where the store cannot tell."""
    carriers = [r for r in rows if (r["with_sender"] or 0) > 0]
    incoming = max(carriers, key=lambda r: r["with_sender"])["value"] if carriers else None
    others = [r for r in rows
              if r["value"] != incoming and (r["with_recipient"] or 0) > 0]
    outgoing = max(others, key=lambda r: r["with_recipient"])["value"] if others else None
    return incoming, outgoing


def direction_values():
    """The measured (incoming, outgoing) direction values, for every endpoint that
    splits interactions by direction, so no page assumes a numbering."""
    if not db.has_table(STORE, "interactions"):
        return None, None
    return _direction_mapping(db.query(STORE, DIRECTION_SQL))


def _hour_expr(col="i.startDate", local=True):
    mod = ", 'localtime'" if local else ""
    return "CAST(strftime('%%H', %s, 'unixepoch'%s) AS INT)" % (TS % col, mod)


def _dow_expr(col="i.startDate"):
    return "CAST(strftime('%%w', %s, 'unixepoch', 'localtime') AS INT)" % (TS % col)


def _month_expr(col="startDate"):
    return "strftime('%%Y-%%m', %s, 'unixepoch', 'localtime')" % (TS % col)


def _tz_label():
    """The zone the `localtime` modifier is resolving in, as a short name."""
    now = time.localtime()
    name = time.tzname[1] if now.tm_isdst and len(time.tzname) > 1 else time.tzname[0]
    offset = -(time.altzone if now.tm_isdst else time.timezone)
    sign = "+" if offset >= 0 else "-"
    offset = abs(offset)
    return {
        "name": name,
        "offset": "UTC%s%02d:%02d" % (sign, offset // 3600, (offset % 3600) // 60),
    }


def _month_ts(month):
    """'YYYY-MM' -> unix seconds at the start of that month, for an x axis."""
    y, m = month.split("-")
    return calendar.timegm((int(y), int(m), 1, 0, 0, 0, 0, 1, 0))


def _quiet_window(hourly):
    """The longest circular run of hours carrying less than QUIET_FRACTION of an
    even spread. Entirely derived — no clock hours are written down anywhere."""
    counts = {int(r["hour"]): r["n"] for r in hourly}
    total = sum(counts.values())
    if not total:
        return None
    threshold = (total / 24.0) * QUIET_FRACTION
    quiet = [h for h in range(24) if counts.get(h, 0) < threshold]
    if not quiet or len(quiet) == 24:
        return None
    best = (0, None)
    for start in quiet:
        if (start - 1) % 24 in quiet:
            continue                       # not the head of a run
        length, h = 0, start
        while h in quiet and length < 24:
            length += 1
            h = (h + 1) % 24
        if length > best[0]:
            best = (length, start)
    length, start = best
    if not length:
        return None
    hours = [(start + k) % 24 for k in range(length)]
    inside = sum(counts.get(h, 0) for h in hours)
    return {
        "start": start,
        "end": (start + length) % 24,
        "hours": hours,
        "length": length,
        "interactions": inside,
        "share": inside / float(total),
        "threshold": threshold,
    }


def _hour_predicate(window, col="i.startDate"):
    """SQL fragment true for timestamps inside the derived quiet window."""
    if not window:
        return "0", ()
    expr = _hour_expr(col)
    if window["start"] < window["end"]:
        return "(%s >= ? AND %s < ?)" % (expr, expr), (window["start"], window["end"])
    return "(%s >= ? OR %s < ?)" % (expr, expr), (window["start"], window["end"])


def _label(name, rowid):
    return name if name else "unnamed identity #%s" % rowid


# ---------------------------------------------------------------- the handler


def handler(params):
    if not db.has_table(STORE, "interactions"):
        return {"present": False, "store": STORE}

    q = lambda sql, p=(): db.query(STORE, sql, p)
    one = lambda sql, p=(), d=None: db.one(STORE, sql, p, d)

    domains_in = "(" + ",".join("?" * len(COMMS_DOMAINS)) + ")"

    # ---- corpus shape -------------------------------------------------
    span = q("SELECT MIN(startDate) a, MAX(startDate) b FROM interactions")[0]
    first_ts = db.apple_time(span["a"])
    last_ts = db.apple_time(span["b"])

    # The store's own migrations add columns over macOS releases (remoteDeviceId
    # arrives in its 14th), so a column past the initial schema is read only
    # where this copy has it, and reported as None where it does not.
    cols = q("PRAGMA table_info(interactions)")
    have = {c["name"] for c in cols}

    totals = {
        "interactions": one("SELECT COUNT(*) FROM interactions", (), 0),
        "links": one("SELECT COUNT(*) FROM interactionEntities", (), 0),
        "entities": one("SELECT COUNT(*) FROM entities", (), 0),
        "apps": one("SELECT COUNT(DISTINCT bundleId) FROM interactions", (), 0),
        "devices": one("SELECT COUNT(DISTINCT remoteDeviceId) FROM interactions "
                       "WHERE remoteDeviceId IS NOT NULL AND remoteDeviceId <> ''", (), 0)
                   if "remoteDeviceId" in have else None,
        "device_rows": one("SELECT COUNT(*) FROM interactions "
                           "WHERE remoteDeviceId IS NOT NULL AND remoteDeviceId <> ''", (), 0)
                       if "remoteDeviceId" in have else None,
        "threads": one("SELECT COUNT(DISTINCT contentHash) FROM interactions", (), 0),
        "comms": one("SELECT COUNT(*) FROM interactions WHERE domain IN %s" % domains_in,
                     COMMS_DOMAINS, 0),
        "first_ts": first_ts,
        "last_ts": last_ts,
        "days": int((last_ts - first_ts) / 86400.0) if first_ts and last_ts else 0,
    }

    # The store holds no message text at all: there is no body column, and the
    # Message entities it does hold carry no name. Measure that rather than
    # asserting it.
    totals["interaction_columns"] = [c["name"] for c in cols]
    totals["message_entities"] = one(
        "SELECT COUNT(*) FROM entities WHERE type='Message'", (), 0)
    totals["message_entities_named"] = one(
        "SELECT COUNT(*) FROM entities WHERE type='Message' "
        "AND json_extract(fields,'$.name') IS NOT NULL", (), 0)

    entity_types = q(
        "SELECT type, COUNT(*) n, "
        "SUM(json_extract(fields,'$.name') IS NOT NULL) named "
        "FROM entities GROUP BY 1 ORDER BY n DESC")

    # What the per-interaction `fields` payload actually carries, enumerated
    # rather than asserted: every key present, on how many rows, and the longest
    # value behind it. This is the evidence for "no words are stored".
    totals["field_keys"] = q("""
        SELECT j.key AS key, COUNT(*) n, MAX(LENGTH(j.value)) max_len,
               COUNT(DISTINCT j.value) distinct_values
        FROM interactions i, json_each(i.fields) j
        GROUP BY 1 ORDER BY n DESC
    """)
    totals["fields_empty"] = one(
        "SELECT COUNT(*) FROM interactions i "
        "WHERE (SELECT COUNT(*) FROM json_each(i.fields)) = 0", (), 0)

    # ---- correction 1: what direction actually means -------------------
    direction = q(DIRECTION_SQL)
    parameters = q("SELECT parameter, COUNT(*) n, COUNT(DISTINCT entityRowid) entities "
                   "FROM interactionEntities GROUP BY 1 ORDER BY n DESC")
    distinct_senders = one(
        "SELECT COUNT(DISTINCT e.rowid) FROM interactionEntities ie "
        "JOIN entities e ON e.rowid = ie.entityRowid "
        "WHERE ie.parameter='sender' AND e.type='Person'", (), 0)

    incoming_value, outgoing_value = _direction_mapping(direction)
    neither = [r["value"] for r in direction
               if r["value"] not in (incoming_value, outgoing_value)]
    neither_types = q(
        "SELECT type, COUNT(*) n FROM interactions WHERE direction IN (%s) "
        "GROUP BY 1 ORDER BY n DESC" % ",".join("?" * len(neither)), tuple(neither)
    ) if neither else []

    for r in direction:
        r["measured"] = ("incoming" if r["value"] == incoming_value
                         else "outgoing" if r["value"] == outgoing_value
                         else "neither")
        # The public enum's own numbering, for the side-by-side that shows the
        # discrepancy. Position in the enum, not a value read from the store.
        r["enum_says"] = {0: "unspecified", 1: "outgoing", 2: "incoming"}.get(r["value"], "—")

    IN, OUT = incoming_value, outgoing_value

    # ---- correction 2: what handlingStatus actually means ---------------
    handling = q("""
        SELECT domain, handlingStatus AS status, COUNT(*) n,
               SUM(durationSeconds > 0) with_duration,
               ROUND(SUM(durationSeconds) / 60.0, 1) minutes,
               SUM(EXISTS(SELECT 1 FROM interactionEntities ie
                          JOIN entities e ON e.rowid = ie.entityRowid
                          WHERE ie.interactionRowid = interactions.rowid
                            AND e.type = 'Message')) with_message_entity
        FROM interactions
        WHERE domain <> ''
        GROUP BY 1, 2 ORDER BY 1, n DESC
    """)
    call_status = [r for r in handling if r["domain"] == "Calls"]
    connected_status = (max(call_status, key=lambda r: r["with_duration"] or 0)["status"]
                        if call_status else None)
    for r in handling:
        if r["domain"] == "Calls":
            r["measured"] = ("connected" if r["status"] == connected_status
                             else "never connected")
        else:
            r["measured"] = "—"
        # INIntentHandlingStatus as Apple documents it, purely so the page can
        # show the discrepancy. Nothing here is read from the store.
        r["enum_says"] = {0: "unspecified", 1: "ready", 2: "in progress",
                          3: "success", 4: "failure",
                          5: "deferred to application",
                          6: "user confirmation required"}.get(r["status"], "—")

    # ---- correction 3: contentHash is a thread key ----------------------
    thread_sizes = q("SELECT contentHash ch, COUNT(*) n FROM interactions GROUP BY 1")
    sizes = sorted((r["n"] for r in thread_sizes), reverse=True)
    multi_combo = one("""
        WITH k AS (
          SELECT i.contentHash AS ch,
                 i.bundleId || '|' || i.domain || '|' || i.direction || '|' ||
                 COALESCE((SELECT group_concat(ie.entityRowid)
                           FROM interactionEntities ie
                           WHERE ie.interactionRowid = i.rowid), '') AS combo
          FROM interactions i)
        SELECT COUNT(*) FROM (SELECT ch FROM k GROUP BY ch HAVING COUNT(DISTINCT combo) > 1)
    """, (), 0)
    buckets = q("""
        SELECT CASE WHEN n = 1 THEN 'one interaction'
                    WHEN n <= 5 THEN '2 to 5'
                    WHEN n <= 20 THEN '6 to 20'
                    WHEN n <= 100 THEN '21 to 100'
                    ELSE 'over 100' END AS bucket,
               COUNT(*) threads, SUM(n) interactions, MIN(n) lo
        FROM (SELECT contentHash, COUNT(*) n FROM interactions GROUP BY 1)
        GROUP BY 1 ORDER BY lo
    """)
    top_threads = q("""
        SELECT contentHash AS thread, bundleId AS bundle, domain,
               COUNT(*) n, %s incoming, %s outgoing,
               COUNT(DISTINCT bundleId) apps,
               MIN(startDate) first_ts, MAX(startDate) last_ts
        FROM interactions i
        GROUP BY contentHash ORDER BY n DESC LIMIT ?
    """ % ("SUM(i.direction = ?)", "SUM(i.direction = ?)"), (IN, OUT, TOP_THREADS))
    for r in top_threads:
        r["thread"] = str(r["thread"])     # signed 64-bit: JS would round it
        r["first_ts"] = db.apple_time(r["first_ts"])
        r["last_ts"] = db.apple_time(r["last_ts"])

    threads = {
        "distinct": totals["threads"],
        "interactions": totals["interactions"],
        "recurring": sum(1 for n in sizes if n > 1),
        "singleton": sum(1 for n in sizes if n == 1),
        "busiest": sizes[0] if sizes else 0,
        "multi_combo": multi_combo,
        "buckets": buckets,
        "top": top_threads,
    }

    # ---- how much of this came from Siri at all -------------------------
    siri = q("SELECT isDonatedBySiri AS flag, COUNT(*) n FROM interactions GROUP BY 1")
    siri_n = sum(r["n"] for r in siri if r["flag"])
    siri_types = q("SELECT type, domain, COUNT(*) n FROM interactions "
                   "WHERE isDonatedBySiri = 1 GROUP BY 1, 2 ORDER BY n DESC")
    streams = (q("SELECT COUNT(DISTINCT sourceStreams) n FROM interactions")
               if "sourceStreams" in have else None)
    donation = {
        "siri": siri_n,
        "total": totals["interactions"],
        "types": siri_types,
        "streams": None if streams is None else (streams[0]["n"] if streams else 0),
        "by_flag": siri,
    }

    # ---- the monthly timeline and its step ------------------------------
    monthly = q("""
        SELECT %s AS month, COUNT(*) n, %s incoming, %s outgoing,
               COUNT(DISTINCT bundleId) apps
        FROM interactions i GROUP BY 1 ORDER BY 1
    """ % (_month_expr(), "SUM(i.direction = ?)", "SUM(i.direction = ?)"), (IN, OUT))
    for r in monthly:
        r["ts"] = _month_ts(r["month"])

    step = None
    if len(monthly) > 1:
        jumps = [(monthly[i]["n"] - monthly[i - 1]["n"], i) for i in range(1, len(monthly))]
        delta, idx = max(jumps)
        prev, cur = monthly[idx - 1], monthly[idx]
        onset = q("""
            SELECT bundleId AS bundle, COUNT(*) n,
                   MIN(startDate) first_ts
            FROM interactions GROUP BY 1
            HAVING %s = ?
            ORDER BY n DESC
        """ % _month_expr("MIN(startDate)"), (cur["month"],))
        onset_in_month = one("""
            SELECT COUNT(*) FROM interactions i
            WHERE %s = ?
              AND i.bundleId IN (SELECT bundleId FROM interactions
                                 GROUP BY bundleId HAVING %s = ?)
        """ % (_month_expr("i.startDate"), _month_expr("MIN(startDate)")),
            (cur["month"], cur["month"]), 0)
        for r in onset:
            r["first_ts"] = db.apple_time(r["first_ts"])
        step = {
            "month": cur["month"], "ts": cur["ts"],
            "prev_month": prev["month"], "prev": prev["n"], "value": cur["n"],
            "delta": delta,
            "ratio": (cur["n"] / float(prev["n"])) if prev["n"] else None,
            "onset_apps": onset,
            "onset_in_month": onset_in_month,
            "onset_share": onset_in_month / float(cur["n"]) if cur["n"] else 0,
        }

        # Split every month into traffic from apps that were already donating
        # before the step, and traffic from apps whose record starts at it.
        split = q("""
            SELECT %s AS month,
                   SUM(CASE WHEN f.first_month >= ? THEN 1 ELSE 0 END) onset,
                   SUM(CASE WHEN f.first_month <  ? THEN 1 ELSE 0 END) established
            FROM interactions i
            JOIN (SELECT bundleId, %s AS first_month FROM interactions
                  GROUP BY bundleId) f ON f.bundleId = i.bundleId
            GROUP BY 1 ORDER BY 1
        """ % (_month_expr("i.startDate"), _month_expr("MIN(startDate)")),
            (cur["month"], cur["month"]))
        for r in split:
            r["ts"] = _month_ts(r["month"])
        step["split"] = split

    # ---- the app mix ----------------------------------------------------
    apps = q("""
        SELECT bundleId AS bundle, COUNT(*) n, %s incoming, %s outgoing,
               COUNT(DISTINCT domain) domains,
               MIN(startDate) first_ts, MAX(startDate) last_ts
        FROM interactions i GROUP BY 1 ORDER BY n DESC
    """ % ("SUM(i.direction = ?)", "SUM(i.direction = ?)"), (IN, OUT))
    for r in apps:
        r["first_ts"] = db.apple_time(r["first_ts"])
        r["last_ts"] = db.apple_time(r["last_ts"])
        r["apple"] = r["bundle"].startswith(APPLE_PREFIX)
    vendor = {
        "apple": sum(r["n"] for r in apps if r["apple"]),
        "third_party": sum(r["n"] for r in apps if not r["apple"]),
        "apple_apps": sum(1 for r in apps if r["apple"]),
        "third_party_apps": sum(1 for r in apps if not r["apple"]),
    }

    # ---- the daily rhythm ------------------------------------------------
    hourly = q("""
        SELECT %s AS hour, COUNT(*) n FROM interactions i
        WHERE i.domain IN %s GROUP BY 1 ORDER BY 1
    """ % (_hour_expr(), domains_in), COMMS_DOMAINS)
    window = _quiet_window(hourly)

    heat = q("""
        SELECT %s AS dow, %s AS hour, COUNT(*) n, %s incoming, %s outgoing
        FROM interactions i WHERE i.domain IN %s
        GROUP BY 1, 2 ORDER BY 1, 2
    """ % (_dow_expr(), _hour_expr(), "SUM(i.direction = ?)", "SUM(i.direction = ?)",
           domains_in), (IN, OUT) + COMMS_DOMAINS)
    rhythm = {
        "cells": heat,
        "hourly": hourly,
        "populated": len(heat),
        "possible": 7 * 24,
        "total": sum(r["n"] for r in heat),
        "quiet": window,
        "tz": _tz_label(),
    }

    # ---- the people ------------------------------------------------------
    quiet_sql, quiet_params = _hour_predicate(window)
    owner_name = vocab.name_of(vocab.owner_id())

    people = q("""
        WITH pi AS (
          SELECT DISTINCT COALESCE(json_extract(e.fields,'$.name'), '#' || e.rowid) AS gkey,
                 json_extract(e.fields,'$.name') AS name, i.rowid AS irow
          FROM entities e
          JOIN interactionEntities ie ON ie.entityRowid = e.rowid
          JOIN interactions i ON i.rowid = ie.interactionRowid
          WHERE e.type = 'Person')
        SELECT pi.gkey, MAX(pi.name) AS name, COUNT(*) n,
               %s incoming, %s outgoing,
               SUM(i.domain = 'Calls') calls,
               SUM(i.domain = 'Calls' AND i.direction = ?) calls_in,
               SUM(i.domain = 'Calls' AND i.direction = ?) calls_out,
               SUM(CASE WHEN i.domain = 'Calls' THEN i.durationSeconds ELSE 0 END) seconds,
               SUM(CASE WHEN %s THEN 1 ELSE 0 END) quiet_n,
               COUNT(DISTINCT i.bundleId) apps,
               MIN(i.startDate) first_ts, MAX(i.startDate) last_ts
        FROM pi JOIN interactions i ON i.rowid = pi.irow
        GROUP BY pi.gkey ORDER BY n DESC
    """ % ("SUM(i.direction = ?)", "SUM(i.direction = ?)", quiet_sql),
        (IN, OUT, IN, OUT) + quiet_params)

    identities = {r["gkey"]: r["c"] for r in q("""
        SELECT COALESCE(json_extract(fields,'$.name'), '#' || rowid) AS gkey, COUNT(*) c
        FROM entities WHERE type = 'Person' GROUP BY 1
    """)}

    owner_rows = 0
    clean = []
    for r in people:
        if owner_name and r["name"] and r["name"].strip().lower() == owner_name.strip().lower():
            owner_rows += 1
            continue
        r["label"] = _label(r["name"], r["gkey"].lstrip("#"))
        r["identities"] = identities.get(r["gkey"], 1)
        r["first_ts"] = db.apple_time(r["first_ts"])
        r["last_ts"] = db.apple_time(r["last_ts"])
        r["minutes"] = round((r["seconds"] or 0) / 60.0, 1)
        r["days_silent"] = int((last_ts - r["last_ts"]) / 86400.0)
        r["quiet_share"] = (r["quiet_n"] / float(r["n"])) if r["n"] else 0
        r["out_share"] = (r["outgoing"] / float(r["n"])) if r["n"] else 0
        r.pop("seconds", None)
        clean.append(r)
    people = clean

    named_people = sum(1 for r in people if r["name"])

    # Thresholds are derived from the distribution, never written down: the
    # median volume separates "a real correspondent" from "a stray ping".
    vols = sorted(r["n"] for r in people)
    median = vols[len(vols) // 2] if vols else 0
    real = [r for r in people if r["n"] >= max(2, median)]

    contacts = people[:TOP_CONTACTS]
    reciprocity = sorted(real, key=lambda r: r["out_share"], reverse=True)[:TOP_RECIPROCITY]
    dormant = sorted(real, key=lambda r: r["days_silent"], reverse=True)[:TOP_DORMANT]
    offhours = sorted([r for r in real if r["quiet_n"]],
                      key=lambda r: (r["quiet_share"], r["quiet_n"]), reverse=True)[:TOP_OFFHOURS]
    voice = sorted([r for r in people if r["calls"]],
                   key=lambda r: r["minutes"], reverse=True)

    # ---- calls ------------------------------------------------------------
    call_months = q("""
        SELECT %s AS month, COUNT(*) calls, %s placed, %s received,
               SUM(durationSeconds > 0) connected,
               ROUND(SUM(durationSeconds) / 60.0, 1) minutes
        FROM interactions i WHERE domain = 'Calls' GROUP BY 1 ORDER BY 1
    """ % (_month_expr(), "SUM(i.direction = ?)", "SUM(i.direction = ?)"), (OUT, IN))
    for r in call_months:
        r["ts"] = _month_ts(r["month"])
    call_totals = q("""
        SELECT COUNT(*) calls, %s placed, %s received,
               SUM(durationSeconds > 0) connected,
               ROUND(SUM(durationSeconds) / 60.0, 1) minutes,
               ROUND(AVG(NULLIF(durationSeconds, 0)) / 60.0, 1) avg_connected,
               ROUND(MAX(durationSeconds) / 60.0, 1) longest
        FROM interactions i WHERE domain = 'Calls'
    """ % ("SUM(i.direction = ?)", "SUM(i.direction = ?)"), (OUT, IN))[0]
    # A call that names more than one person is linked to each of them, so the
    # per-person totals below sum to slightly more than the call count. Measure
    # the overlap rather than hiding it.
    multiparty = one("""
        SELECT COUNT(*) FROM (
          SELECT i.rowid FROM interactions i
          JOIN interactionEntities ie ON ie.interactionRowid = i.rowid
          JOIN entities e ON e.rowid = ie.entityRowid
          WHERE i.domain = 'Calls' AND e.type = 'Person'
          GROUP BY i.rowid HAVING COUNT(DISTINCT e.rowid) > 1)
    """, (), 0)
    calls = {
        "monthly": call_months,
        "totals": call_totals,
        "partners": voice,
        "connected_status": connected_status,
        "multiparty": multiparty,
        "attributed": one("SELECT COUNT(DISTINCT i.rowid) FROM interactions i "
                          "JOIN interactionEntities ie ON ie.interactionRowid = i.rowid "
                          "JOIN entities e ON e.rowid = ie.entityRowid "
                          "WHERE i.domain='Calls' AND e.type='Person'", (), 0),
    }

    # ---- group channels ---------------------------------------------------
    groups = q("""
        SELECT json_extract(e.fields,'$.name') AS name,
               COUNT(DISTINCT i.rowid) n, %s incoming, %s outgoing,
               COUNT(DISTINCT i.bundleId) apps,
               MIN(i.startDate) first_ts, MAX(i.startDate) last_ts
        FROM entities e
        JOIN interactionEntities ie ON ie.entityRowid = e.rowid
        JOIN interactions i ON i.rowid = ie.interactionRowid
        WHERE e.type = 'MessageGroup'
        GROUP BY e.rowid ORDER BY n DESC
    """ % ("SUM(i.direction = ?)", "SUM(i.direction = ?)"), (IN, OUT))
    group_total = len(groups)
    group_traffic = one(
        "SELECT COUNT(DISTINCT ie.interactionRowid) FROM interactionEntities ie "
        "JOIN entities e ON e.rowid = ie.entityRowid WHERE e.type='MessageGroup'", (), 0)
    for r in groups:
        r["first_ts"] = db.apple_time(r["first_ts"])
        r["last_ts"] = db.apple_time(r["last_ts"])

    return {
        "present": True,
        "totals": totals,
        "entity_types": entity_types,
        "direction": {
            "rows": direction,
            "incoming_value": IN,
            "outgoing_value": OUT,
            "parameters": parameters,
            "distinct_senders": distinct_senders,
            "neither": neither,
            "neither_types": neither_types,
        },
        "handling": {"rows": handling, "connected_status": connected_status},
        "threads": threads,
        "donation": donation,
        "monthly": monthly,
        "step": step,
        "apps": apps,
        "vendor": vendor,
        "rhythm": rhythm,
        "people": {
            "all": len(people),
            "named": named_people,
            "owner_rows_removed": owner_rows,
            "median_volume": median,
            "real_threshold": max(2, median),
            "real": len(real),
            "top": contacts,
            "reciprocity": reciprocity,
            "dormant": dormant,
            "offhours": offhours,
        },
        "calls": calls,
        "groups": {"total": group_total, "traffic": group_traffic,
                   "top": groups[:TOP_GROUPS]},
        "caps": {
            "contacts": TOP_CONTACTS, "groups": TOP_GROUPS, "dormant": TOP_DORMANT,
            "offhours": TOP_OFFHOURS, "reciprocity": TOP_RECIPROCITY,
            "threads": TOP_THREADS, "quiet_fraction": QUIET_FRACTION,
        },
    }


ROUTES = {"/api/comms": handler}
