"""The calendar layer of the graph: the part of this store that looks forward.

`event_graph` is the calendar. It holds free-text descriptions and facts about
time that had not happened yet when the store was read. This module measures it
rather than describing it, and it is built around five things that are easy to
get wrong:

  * **More than one population.** The layer can be fed by more than one ingest.
    Whether they share subjects, and which one carries attendees or description
    text, is computed here and shown on the page; aggregating across them can
    produce a meeting the store does not hold.

  * **Two incompatible date encodings.** The `timestamp` COLUMN is Apple epoch —
    when the triple was written. The date-valued OBJECTS are serialised
    NSDateComponents JSON with an embedded timezone — when the meeting is. They
    can be far apart. Every calendar date on this page comes from
    json_extract over the object; `timestamp` is used only to derive the moment
    the copy was taken.

  * **The text share needs its denominator.** "Descriptions are N% of all text"
    is meaningless without saying what counted as text. Three denominators are
    computed here and all three are put on screen.

  * **`tel:` in this layer is not a phone number.** Every one is carried by the
    virtual-conference predicate: they are conference dial-in bridges. The
    endpoint cross-checks them against every phone handle in the bundle so the
    page can state the negative instead of implying reachability.

  * **The prose is mostly not the owner's.** Description-bearing events are
    attributed by their sender, so the page can say how much of this text the
    owner wrote and how much arrived from somebody else.

No value from anybody's calendar appears in this file. Every count, date, name,
domain and label on the page is read out of the stores when the request runs,
and no description text is returned at all — only its length.
"""

import base64
import datetime
import hashlib
import json

from . import db, vocab

GRAPH = "graph/graph.db"
CAL = "sources/Calendar.sqlitedb"
CHAT = "sources/chat.db"

LAYERS = ("stable_graph", "event_graph", "expired_stable_graph", "expired_event_graph")

# Schema identifiers out of the shipped ontology. Not values out of any row.
P_TYPE = "PS1"
P_NAME = "PS33"
P_DESC = "PS51"
P_ATTENDEE = "PS232"
P_ORGANIZER = "PS578"
P_SENDER = "PS580"
P_LOCATION = "PS225"
P_IDENTIFIER = "PS72"
P_CONTACT = "PS520"
P_START_LOC = "PS248"
P_END_LOC = "PS249"
F_PERSON = "PS143"
F_START = "PS29"
F_END = "PS30"
F_PLACE = "PS107"
F_LABEL = "PS733"
F_EMAIL = "PS406"
F_PHONE = "PS407"
F_IDVALUE = "PS69"
P_DATE = "nm_hasDate"
P_ALLDAY = "nm_isAllDay"
P_CONFERENCE = "nm_virtualConferenceURL"
P_SGTYPE = "nm_sgEventType"
P_FLIGHT = "nm_flightNumber"
P_IATA = "nm_iataCode"

CLASS_EVENT = "SB472"
CLASS_TRANSPORT = "SB514"
CLASS_PLACE = "SB152"

# How many rows a ranked list is allowed to return. The page states the cap.
TOP = 20


# ---------------------------------------------------------------- helpers

def _capture():
    """The instant this copy stopped changing, derived from the stores.

    The latest write recorded anywhere in the graph is the closest thing the
    bundle has to a capture timestamp, and it is what 'forward-looking' has to
    be measured against. Nothing about it is written down here.
    """
    best = None
    for layer in LAYERS:
        v = db.one(GRAPH, f"select max(timestamp) from {layer}")
        if v is not None and (best is None or v > best):
            best = v
    if best is None:
        return None
    unix = db.apple_time(best)
    when = datetime.datetime.fromtimestamp(unix, datetime.timezone.utc)
    return {
        "apple": best,
        "unix": unix,
        "iso": when.strftime("%Y-%m-%d %H:%M:%S"),
        "day": when.strftime("%Y-%m-%d"),
    }


def _components(blob):
    """A serialised NSDateComponents object -> a naive datetime, or None.

    CAST(... AS REAL) on one of these silently yields 0, which decodes to the
    Apple epoch on every row. Only json parsing reads them correctly, and the
    minute/second keys are absent on all-day entries.
    """
    if not blob:
        return None
    try:
        d = json.loads(blob)
        return datetime.datetime(
            int(d["year"]), int(d["month"]), int(d["day"]),
            int(d.get("hour") or 0), int(d.get("minute") or 0),
        )
    except (ValueError, KeyError, TypeError):
        return None


def _tz(blob):
    try:
        return (json.loads(blob).get("timeZone") or {}).get("identifier")
    except (ValueError, AttributeError, TypeError):
        return None


def _digits(value):
    """Everything that could be a dialable digit, for a handle comparison."""
    return "".join(ch for ch in str(value) if ch.isdigit())


def _nice_step(span, buckets):
    """A round bucket width, derived from the data rather than chosen."""
    if span <= 0:
        return 1
    raw = span / float(buckets)
    step = 1
    while step < raw:
        for mult in (2, 2.5, 2):      # 1 -> 2 -> 5 -> 10
            nxt = step * mult
            if nxt >= raw:
                return int(nxt) or 1
            step = nxt
        step = int(step) or 1
    return int(step) or 1


# ---------------------------------------------------------------- populations

def _populations():
    """The ingest sources that actually wrote into the calendar layer.

    The bits are tested one at a time; `sources` is a mask and grouping by its
    value would split multi-source rows into invented categories. Labels come
    from the decoded bit table, never from a string in this file.
    """
    out = []
    for bit, label in sorted(vocab.SOURCE_BITS.items()):
        mask = 1 << bit
        row = db.query(GRAPH, """
            select count(*) as triples,
                   count(distinct subject) as events,
                   count(distinct case when predicate=? then subject end) as with_attendees,
                   count(distinct case when predicate=? then subject end) as with_sender,
                   count(distinct case when predicate=? then subject end) as with_description,
                   count(distinct case when predicate=? then subject end) as with_conference,
                   sum(case when predicate=? then length(object) else 0 end) as description_chars,
                   count(distinct case when predicate=? and relationshipPredicate=?
                         then relationshipId end) as attendance_statements
            from event_graph where (sources & ?) <> 0
        """, (P_ATTENDEE, P_SENDER, P_DESC, P_CONFERENCE, P_DESC,
              P_ATTENDEE, F_PERSON, mask))
        r = dict(row[0]) if row else {}
        if not r.get("triples"):
            continue
        r["bit"] = bit
        r["mask"] = mask
        r["label"] = label
        out.append(r)
    out.sort(key=lambda r: -r["events"])

    # Do the populations overlap at all? Measured, not assumed.
    overlap = []
    for i, a in enumerate(out):
        for b in out[i + 1:]:
            n = db.one(GRAPH, """
                select count(*) from (
                  select subject from event_graph where (sources & ?) <> 0
                  intersect
                  select subject from event_graph where (sources & ?) <> 0)
            """, (a["mask"], b["mask"]), 0)
            overlap.append({"a": a["label"], "b": b["label"], "shared_events": n})
    return out, overlap


# ---------------------------------------------------------------- the calendar

def _event_dates():
    """One row per start-time facet: the real meeting clock, with its event.

    A recurring series carries more than one start facet against one subject, so
    this is deliberately event-DATES, not events.
    """
    rows = db.query(GRAPH, """
        select st.subject as subject,
               st.relationshipId as rid,
               st.object as start_blob,
               en.object as end_blob,
               (select object from event_graph x
                  where x.subject=st.subject and x.predicate=? limit 1) as all_day,
               (select object from event_graph x
                  where x.subject=st.subject and x.predicate=? limit 1) as title,
               (select length(object) from event_graph x
                  where x.subject=st.subject and x.predicate=? limit 1) as description_chars,
               (select count(*) from event_graph x
                  where x.subject=st.subject and x.predicate=? and x.relationshipPredicate=?)
                 as attendees,
               (select count(*) from event_graph x
                  where x.subject=st.subject and x.predicate=?) as conference_links,
               (select object from event_graph x
                  where x.subject=st.subject and x.predicate=? limit 1) as reservation_type,
               (select max(sources) from event_graph x where x.subject=st.subject) as sources
        from event_graph st
        left join event_graph en
               on en.relationshipId=st.relationshipId and en.relationshipPredicate=?
        where st.relationshipPredicate=?
    """, (P_ALLDAY, P_NAME, P_DESC, P_ATTENDEE, F_PERSON, P_CONFERENCE, P_SGTYPE,
          F_END, F_START))

    out = []
    for r in rows:
        start = _components(r["start_blob"])
        if start is None:
            continue
        end = _components(r["end_blob"])
        minutes = int((end - start).total_seconds() // 60) if end else None
        out.append({
            "subject": r["subject"],
            "start": start,
            "minutes": minutes,
            "tz": _tz(r["start_blob"]),
            "all_day": str(r["all_day"]) == "1",
            "title": r["title"],
            "description_chars": r["description_chars"] or 0,
            "attendees": r["attendees"] or 0,
            "conference_links": r["conference_links"] or 0,
            "reservation_type": r["reservation_type"],
            "sources": r["sources"] or 0,
        })
    out.sort(key=lambda r: r["start"])
    return out


def _person_labels(ids):
    """id -> the best label the graph can give for a calendar person.

    The fallback is the mail handle, because most calendar attendees carry no
    name at all: they entered the graph as an address on an invitation.
    """
    if not ids:
        return {}
    names = vocab.names("stable_graph")
    out = {}
    holes = []
    for pid in ids:
        n = names.get(pid)
        if n:
            out[pid] = n
        else:
            holes.append(pid)
    for pid in holes:
        handle = db.one(GRAPH, """
            select object from stable_graph
            where subject=? and relationshipPredicate=? limit 1
        """, (pid, F_EMAIL))
        out[pid] = handle
    return out


def _attendee_ids(subject):
    rows = db.query(GRAPH, """
        select object from event_graph
        where subject=? and predicate=? and relationshipPredicate=?
    """, (subject, P_ATTENDEE, F_PERSON))
    return [vocab.entity_ref(r["object"]) for r in rows]


# ---------------------------------------------------------------- text

def _text_volume():
    """Where the readable characters in this graph actually are.

    Three denominators, because the share of the total is the whole claim and
    it moves by a factor of two depending on what counts as text.
    """
    per_predicate = db.query(GRAPH, """
        select predicate, count(*) as rows_, sum(length(object)) as chars,
               max(length(object)) as longest
        from (select predicate, object from stable_graph
              union all select predicate, object from event_graph)
        group by 1 order by chars desc
    """)

    everything = db.one(GRAPH, """
        select sum(length(object)) from
        (select object from stable_graph union all select object from event_graph)
    """, (), 0) or 0

    minus_refs = db.one(GRAPH, """
        select sum(length(object)) from
        (select object from stable_graph union all select object from event_graph)
        where object not like 'md:%' and object not like '{"day"%'
    """, (), 0) or 0

    # Everything that is not a reference, a token, an ontology code or a
    # serialised date: the narrowest defensible reading of "text".
    literals = db.one(GRAPH, """
        select sum(length(object)) from
        (select object from stable_graph union all select object from event_graph)
        where object not like 'md:%' and object not like '{"day"%'
          and object not like 'SB%' and object not like 'CS%' and object not like 'PS%'
          and object not like 'nm\\_%' escape '\\'
          and object not like 'cnContact:%' and object not like 'phPerson:%'
          and object not like 'ekEvent:%'  and object not like 'sgEvent:%'
          and object not like 'sgContact:%' and object not like 'inPerson:%'
          and object not like 'lsBundleRecord:%' and object not like 'faFamilyCircle:%'
          and object not like 'association:%'
    """, (), 0) or 0

    desc = db.query(GRAPH, """
        select count(*) as rows_, count(distinct subject) as events,
               sum(length(object)) as chars, min(length(object)) as shortest,
               max(length(object)) as longest, avg(length(object)) as mean
        from event_graph where predicate=?
    """, (P_DESC,))
    desc = dict(desc[0]) if desc else {}

    lengths = [r["n"] for r in db.query(
        GRAPH,
        "select length(object) as n from event_graph where predicate=? order by 1",
        (P_DESC,))]
    median = lengths[len(lengths) // 2] if lengths else 0

    step = _nice_step(max(lengths) if lengths else 1, 8)
    hist = {}
    for n in lengths:
        hist[(n // step) * step] = hist.get((n // step) * step, 0) + 1
    buckets = [{"floor": k, "step": step, "events": v} for k, v in sorted(hist.items())]

    top = []
    for r in per_predicate[:12]:
        row = dict(r)
        row["label"] = vocab.plabel(r["predicate"])
        top.append(row)

    return {
        "per_predicate": top,
        "predicate_count": len(per_predicate),
        "denominators": [
            {"key": "all", "chars": everything},
            {"key": "minus_refs", "chars": minus_refs},
            {"key": "literals", "chars": literals},
        ],
        "description": desc,
        "median": median,
        "buckets": buckets,
    }


def _authorship():
    """Who put the prose there: the owner, or somebody else.

    The sender edge is the only authorship signal the layer carries, so the
    answer is stated as what it is — attribution by sender, not by keystroke.
    """
    owner = vocab.owner_id()
    ref = "md:%d" % owner if owner is not None else None
    rows = db.query(GRAPH, """
        select d.subject as subject, length(d.object) as chars,
               (select object from event_graph s
                  where s.subject=d.subject and s.predicate=? limit 1) as sender
        from event_graph d where d.predicate=?
    """, (P_SENDER, P_DESC))
    out = {
        "owner": {"events": 0, "chars": 0},
        "other": {"events": 0, "chars": 0},
        "unattributed": {"events": 0, "chars": 0},
    }
    for r in rows:
        if r["sender"] is None:
            key = "unattributed"
        elif ref is not None and r["sender"] == ref:
            key = "owner"
        else:
            key = "other"
        out[key]["events"] += 1
        out[key]["chars"] += r["chars"] or 0
    senders = db.one(GRAPH, """
        select count(distinct object) from event_graph where predicate=?
    """, (P_SENDER,), 0)
    return {"split": out, "distinct_senders": senders}


# ---------------------------------------------------------------- people

def _attendance():
    owner = vocab.owner_id()
    per_event = db.query(GRAPH, """
        select subject, count(*) as n from event_graph
        where predicate=? and relationshipPredicate=? group by 1
    """, (P_ATTENDEE, F_PERSON))
    sizes = {}
    for r in per_event:
        sizes[r["n"]] = sizes.get(r["n"], 0) + 1

    events_total = db.one(
        GRAPH, "select count(distinct subject) from event_graph where predicate=? and relationshipId=0",
        (P_TYPE,), 0)
    solo = events_total - len(per_event)

    people = db.query(GRAPH, """
        select a.object as ref,
               count(distinct a.subject) as attended,
               (select count(distinct o.subject) from event_graph o
                 where o.predicate=? and o.relationshipPredicate=? and o.object=a.object)
                 as organised,
               (select count(distinct s.subject) from event_graph s
                 where s.predicate=? and s.object=a.object) as sent,
               count(distinct b.object) as co_attendees
        from event_graph a
        left join event_graph b on b.subject=a.subject and b.predicate=?
                               and b.relationshipPredicate=? and b.object<>a.object
        where a.predicate=? and a.relationshipPredicate=?
        group by 1 order by attended desc
    """, (P_ORGANIZER, F_PERSON, P_SENDER, P_ATTENDEE, F_PERSON, P_ATTENDEE, F_PERSON))

    ids = [vocab.entity_ref(r["ref"]) for r in people]
    labels = _person_labels([i for i in ids if i is not None])

    ranked, owner_row = [], None
    for r in people:
        pid = vocab.entity_ref(r["ref"])
        row = {
            "id": vocab.sid(pid),
            "label": labels.get(pid),
            "attended": r["attended"],
            "organised": r["organised"],
            "sent": r["sent"],
            "co_attendees": r["co_attendees"],
        }
        if pid == owner:
            owner_row = row
        else:
            ranked.append(row)

    organisers = db.query(GRAPH, """
        select object as ref, count(distinct subject) as events
        from event_graph where predicate=? and relationshipPredicate=?
        group by 1 order by events desc
    """, (P_ORGANIZER, F_PERSON))
    org_ids = [vocab.entity_ref(r["ref"]) for r in organisers]
    org_labels = _person_labels([i for i in org_ids if i is not None])
    org_rows = []
    for r in organisers:
        pid = vocab.entity_ref(r["ref"])
        org_rows.append({
            "id": vocab.sid(pid),
            "label": org_labels.get(pid),
            "events": r["events"],
            "is_owner": pid == owner,
        })

    return {
        "events_with_attendees": len(per_event),
        "events_total": events_total,
        "solo_events": solo,
        "statements": db.one(GRAPH, """
            select count(distinct relationshipId) from event_graph
            where predicate=? and relationshipPredicate=?
        """, (P_ATTENDEE, F_PERSON), 0),
        "sizes": [{"attendees": k, "events": v} for k, v in sorted(sizes.items())],
        "people": ranked,
        "owner": owner_row,
        "organisers": org_rows,
        "organiser_events": db.one(GRAPH, """
            select count(distinct subject) from event_graph
            where predicate=? and relationshipPredicate=?
        """, (P_ORGANIZER, F_PERSON), 0),
    }


def _domains():
    """Affiliation, from the mail handles of the people on these invitations.

    A domain names an employer without naming a person, which is why it is the
    chart that travels. The owner is excluded, as from every ranking here.
    """
    owner = vocab.owner_id()
    rows = db.query(GRAPH, """
        select h.subject as pid, h.object as handle
        from stable_graph h
        where h.relationshipPredicate=? and h.object like '%@%'
          and h.subject in (
            select distinct cast(substr(object,4) as integer) from event_graph
              where predicate in (?,?) and relationshipPredicate=?
            union
            select distinct cast(substr(object,4) as integer) from event_graph
              where predicate=?)
    """, (F_EMAIL, P_ATTENDEE, P_ORGANIZER, F_PERSON, P_SENDER))

    agg = {}
    for r in rows:
        if r["pid"] == owner:
            continue
        dom = r["handle"].rsplit("@", 1)[-1].lower()
        d = agg.setdefault(dom, {
            "domain": dom, "people": set(), "events": set(),
            "attendee": set(), "organiser": set(), "sender": set(),
        })
        d["people"].add(r["pid"])
        ref = "md:%d" % r["pid"]
        for e in db.query(GRAPH, """
            select subject, predicate from event_graph
            where (predicate in (?,?) and relationshipPredicate=? and object=?)
               or (predicate=? and object=?)
        """, (P_ATTENDEE, P_ORGANIZER, F_PERSON, ref, P_SENDER, ref)):
            d["events"].add(e["subject"])
            role = {P_ATTENDEE: "attendee", P_ORGANIZER: "organiser"}.get(
                e["predicate"], "sender")
            d[role].add(r["pid"])

    out = []
    for d in agg.values():
        out.append({
            "domain": d["domain"], "people": len(d["people"]), "events": len(d["events"]),
            "attendees": len(d["attendee"]), "organisers": len(d["organiser"]),
            "senders": len(d["sender"]),
            # A domain whose people only ever SEND is a system mailing the owner,
            # not somebody sitting in a room with them.
            "never_in_the_room": not (d["attendee"] or d["organiser"]),
        })
    out.sort(key=lambda r: (-r["events"], -r["people"], r["domain"]))
    return out


# ---------------------------------------------------------------- places, links

def _venues():
    """What the location field actually holds.

    Most of it is not a place. Each distinct label is classified by whether it
    is a bare URL, prose with a URL buried in it, or a label with no URL at all
    — the third group is the only one that names somewhere you could stand.
    """
    rows = db.query(GRAPH, """
        select object as label, count(distinct subject) as events, count(*) as statements
        from event_graph where relationshipPredicate=? group by 1 order by events desc
    """, (F_LABEL,))

    def kind(label):
        low = label.lower()
        if low.startswith("http://") or low.startswith("https://"):
            return "url"
        return "url_inside" if ("http://" in low or "https://" in low) else "place"

    tally = {"url": 0, "url_inside": 0, "place": 0}
    ranked = []
    for r in rows:
        k = kind(r["label"])
        tally[k] += 1
        ranked.append({
            "label": r["label"], "events": r["events"],
            "statements": r["statements"], "kind": k, "chars": len(r["label"]),
        })

    place_refs = db.query(GRAPH, """
        select object as ref, count(distinct subject) as events
        from event_graph where relationshipPredicate=? group by 1 order by events desc
    """, (F_PLACE,))
    names = vocab.names("stable_graph")
    resolved = []
    for r in place_refs:
        pid = vocab.entity_ref(r["ref"])
        resolved.append({"id": vocab.sid(pid), "name": names.get(pid), "events": r["events"]})

    return {
        "place_entities": db.one(GRAPH, """
            select count(distinct subject) from stable_graph
            where predicate=? and relationshipId=0 and object=?
        """, (P_TYPE, CLASS_PLACE), 0),
        "named_place_entities": db.one(GRAPH, """
            select count(distinct s.subject) from stable_graph s
            where s.predicate=? and s.relationshipId=0 and s.object=?
              and exists(select 1 from stable_graph n
                          where n.subject=s.subject and n.predicate=? and n.object<>'')
        """, (P_TYPE, CLASS_PLACE, P_NAME), 0),
        "statements": db.one(GRAPH, """
            select count(distinct relationshipId) from event_graph
            where predicate=? and relationshipPredicate=?
        """, (P_LOCATION, F_LABEL), 0),
        "events": db.one(GRAPH, """
            select count(distinct subject) from event_graph where relationshipPredicate=?
        """, (F_LABEL,), 0),
        "distinct_labels": len(rows),
        "kinds": tally,
        "ranked": ranked,
        "places": resolved,
    }


def _links():
    """Join links and dial-in bridges, and the handle cross-check.

    Every `tel:` in this layer hangs off the virtual-conference predicate. The
    page must not present them as ways to reach anybody, so the endpoint proves
    the negative against every phone handle in the bundle.
    """
    rows = db.query(GRAPH, """
        select object, count(*) as n from event_graph where predicate=? group by 1
    """, (P_CONFERENCE,))
    schemes, tel_values = {}, set()
    for r in rows:
        ns = vocab.ns_of(r["object"]) or "other"
        s = schemes.setdefault(ns, {"scheme": ns, "rows": 0, "distinct": 0})
        s["rows"] += r["n"]
        s["distinct"] += 1
        if ns == "tel":
            tel_values.add(r["object"][4:])

    prefixes = {}
    for v in tel_values:
        head = v.split("%20")[0].split(" ")[0].split("-")[0]
        if head.startswith("+"):
            prefixes[head] = prefixes.get(head, 0) + 1

    # Which predicates carry a tel: object anywhere in this layer?
    carriers = db.query(GRAPH, """
        select predicate, count(*) as n from event_graph
        where object like 'tel:%' group by 1 order by n desc
    """)

    digits = {_digits(v) for v in tel_values if _digits(v)}
    pools = []

    chat_handles = {_digits(r["id"]) for r in db.query(CHAT, "select id from handle")}
    chat_handles.discard("")
    pools.append({"pool": "messages_handles", "size": len(chat_handles),
                  "matches": len(digits & chat_handles)})

    graph_phones = {_digits(r["object"]) for r in db.query(
        GRAPH, "select distinct object from stable_graph where relationshipPredicate=?",
        (F_PHONE,))}
    graph_phones.discard("")
    pools.append({"pool": "graph_phone_handles", "size": len(graph_phones),
                  "matches": len(digits & graph_phones)})

    book = set()
    for _, rel in db.address_books():
        if not db.has_table(rel, "ZABCDPHONENUMBER"):
            continue
        for r in db.query(rel, "select ZFULLNUMBER as n from ZABCDPHONENUMBER where ZFULLNUMBER is not null"):
            book.add(_digits(r["n"]))
    book.discard("")
    pools.append({"pool": "address_book_numbers", "size": len(book),
                  "matches": len(digits & book)})

    return {
        "rows": sum(s["rows"] for s in schemes.values()),
        "events": db.one(GRAPH, """
            select count(distinct subject) from event_graph where predicate=?
        """, (P_CONFERENCE,), 0),
        "schemes": sorted(schemes.values(), key=lambda s: -s["rows"]),
        "dial_in_distinct": len(tel_values),
        "prefixes": sorted(
            ({"prefix": k, "numbers": v} for k, v in prefixes.items()),
            key=lambda r: -r["numbers"]),
        "carriers": [dict(r) for r in carriers],
        "cross_check": pools,
    }


# ---------------------------------------------------------------- travel

def _travel():
    types = db.query(GRAPH, """
        select object as type, count(distinct subject) as events
        from event_graph where predicate=? group by 1 order by events desc
    """, (P_SGTYPE,))

    transport = db.query(GRAPH, """
        select subject from event_graph
        where predicate=? and relationshipId=0 and object=?
    """, (P_TYPE, CLASS_TRANSPORT))

    names = vocab.names("stable_graph")
    legs = []
    for t in transport:
        s = t["subject"]
        facts = {r["predicate"]: r["object"] for r in db.query(
            GRAPH, "select predicate, object from event_graph where subject=? and relationshipId=0", (s,))}
        start = db.one(GRAPH, """
            select object from event_graph where subject=? and relationshipPredicate=? limit 1
        """, (s, F_START))
        when = _components(start)
        origin = vocab.entity_ref(facts.get(P_START_LOC) or "")
        dest = vocab.entity_ref(facts.get(P_END_LOC) or "")
        iata = lambda pid: db.one(
            GRAPH, "select object from stable_graph where subject=? and predicate=? limit 1",
            (pid, P_IATA)) if pid is not None else None
        legs.append({
            "id": vocab.sid(s),
            "title": facts.get(P_NAME),
            "carrier": facts.get(P_IATA),
            "number": facts.get(P_FLIGHT),
            "from": names.get(origin),
            "from_code": iata(origin),
            "to": names.get(dest),
            "to_code": iata(dest),
            "when": when.strftime("%Y-%m-%d %H:%M") if when else None,
            "description_chars": len(facts.get(P_DESC) or "") or None,
        })
    legs.sort(key=lambda r: r["when"] or "")

    reserved = db.query(GRAPH, """
        select r.subject as subject,
               (select length(object) from event_graph d
                  where d.subject=r.subject and d.predicate=? limit 1) as chars
        from (select distinct subject from event_graph where predicate=?) r
    """, (P_DESC, P_SGTYPE))
    lens = sorted(r["chars"] for r in reserved if r["chars"])
    meeting = sorted(r["n"] for r in db.query(GRAPH, """
        select length(object) as n from event_graph
        where predicate=? and subject not in (select subject from event_graph where predicate=?)
    """, (P_DESC, P_SGTYPE)))

    return {
        "types": [dict(r) for r in types],
        "legs": legs,
        "reservation_events": len(reserved),
        "reservation_with_description": len(lens),
        "reservation_median_chars": lens[len(lens) // 2] if lens else None,
        "meeting_median_chars": meeting[len(meeting) // 2] if meeting else None,
    }


# ---------------------------------------------------------------- source store

def _source_store(capture):
    """The calendar database the graph read from, for the denominator.

    The graph's calendar layer is a selection, not a copy. Without this panel
    every number above reads as the whole calendar, which it is not.
    """
    if not db.has_table(CAL, "CalendarItem"):
        return {"present": False}

    cut = capture["apple"] if capture else 0
    head = db.query(CAL, """
        select count(*) as events,
               sum(coalesce(length(description),0)) as description_chars,
               sum(case when description is not null and description<>'' then 1 else 0 end)
                 as with_description,
               sum(case when conference_url_detected is not null
                         and conference_url_detected<>'' then 1 else 0 end) as with_conference,
               sum(case when conference_url is not null and conference_url<>'' then 1 else 0 end)
                 as with_conference_column,
               date(min(start_date)+978307200,'unixepoch') as first_event,
               date(max(start_date)+978307200,'unixepoch') as last_event,
               sum(case when start_date > ? then 1 else 0 end) as forward_events
        from CalendarItem where start_date is not null
    """, (cut,))
    out = dict(head[0]) if head else {}
    out["present"] = True

    if db.has_table(CAL, "Participant") and db.has_table(CAL, "Identity"):
        out["participants"] = db.one(CAL, "select count(*) from Participant", (), 0)
        out["identities"] = db.one(CAL, "select count(*) from Identity", (), 0)
        out["domains"] = db.one(CAL, """
            select count(distinct lower(substr(address, instr(address,'@')+1)))
            from Identity where address like '%@%'
        """, (), 0)
    if db.has_table(CAL, "OccurrenceCache"):
        occ = db.query(CAL, """
            select count(*) as occurrences,
                   sum(case when occurrence_date > ? then 1 else 0 end) as forward_occurrences,
                   date(max(occurrence_date)+978307200,'unixepoch') as last_occurrence
            from OccurrenceCache where occurrence_date is not null
        """, (cut,))
        out.update(dict(occ[0]) if occ else {})

    if db.has_table(CAL, "Participant"):
        sizes = db.query(CAL, """
            select n_attendees, count(*) as events from (
              select ci.ROWID as id, count(p.ROWID) as n_attendees
              from CalendarItem ci left join Participant p on p.owner_id = ci.ROWID
              group by ci.ROWID) group by 1 order by 1
        """)
        out["sizes"] = [dict(r) for r in sizes]

    if db.has_table(CAL, "Location"):
        loc = db.query(CAL, """
            select count(*) as rows_, count(distinct title) as distinct_titles,
                   sum(case when address is not null and address<>'' then 1 else 0 end) as with_address,
                   sum(case when latitude is not null and latitude<>0 then 1 else 0 end) as with_coords
            from Location where title is not null and title <> ''
        """)
        out["locations"] = dict(loc[0]) if loc else {}

    out["ek_join"] = _resolve_ek_tokens()
    return out


def _resolve_ek_tokens():
    """Do the graph's EventKit references point into the calendar store on disk?

    The token is base64(sha256(store persistent id + ':' + calendar item uid)),
    padding retained. SQLite cannot compute sha256, so the preimages come out of
    the source store and are hashed here. The result is reported as a rate with
    its denominator, never as a claim that the join "works".
    """
    tokens = set()
    for layer in LAYERS:
        for r in db.query(GRAPH, f"select distinct object from {layer} where object like 'ekEvent:%'"):
            tokens.add(r["object"][len("ekEvent:"):])
    if not tokens or not db.has_table(CAL, "Store"):
        return {"tokens": len(tokens), "resolved": 0, "preimages": 0}

    built = {}
    for r in db.query(CAL, """
        select ci.ROWID as rowid, s.persistent_id || ':' || ci.unique_identifier as preimage
        from CalendarItem ci
        join Calendar ca on ca.ROWID = ci.calendar_id
        join Store s on s.ROWID = ca.store_id
        where ci.unique_identifier is not null and s.persistent_id is not null
    """):
        digest = base64.b64encode(hashlib.sha256(r["preimage"].encode("utf-8")).digest()).decode()
        built.setdefault(digest, []).append(r["rowid"])

    hit = tokens & set(built)
    return {
        "tokens": len(tokens),
        "preimages": len(built),
        "resolved": len(hit),
        "ambiguous": sum(1 for t in hit if len(built[t]) > 1),
    }


# ---------------------------------------------------------------- handler

def handler(params):
    capture = _capture()
    cutoff = capture["unix"] if capture else 0
    dates = _event_dates()
    populations, overlap = _populations()

    pop_of = {p["mask"]: p["label"] for p in populations}

    def population_label(mask):
        for m, label in pop_of.items():
            if mask & m:
                return label
        return None

    # The boundary is the store's own last-write instant. Event objects carry a
    # local wall clock, so the comparison is naive on both sides; the margin to
    # the nearest event is reported so the page can say whether an hours-scale
    # timezone correction could move anything across the line.
    forward, backward, margin = [], 0, None
    for d in dates:
        stamp = d["start"].replace(tzinfo=datetime.timezone.utc).timestamp()
        gap = abs(stamp - cutoff) / 3600.0
        margin = gap if margin is None else min(margin, gap)
        if stamp <= cutoff:
            backward += 1
            continue
        who, owner_invited = [], False
        if d["attendees"]:
            ids = [i for i in _attendee_ids(d["subject"]) if i is not None]
            labels = _person_labels(ids)
            owner = vocab.owner_id()
            owner_invited = owner is not None and owner in ids
            who = [labels.get(i) for i in ids if i != owner and labels.get(i)]
        forward.append({
            "id": vocab.sid(d["subject"]),
            "date": d["start"].strftime("%Y-%m-%d"),
            "weekday": d["start"].strftime("%a"),
            "time": None if d["all_day"] else d["start"].strftime("%H:%M"),
            "minutes": d["minutes"],
            "all_day": d["all_day"],
            "title": d["title"],
            "attendees": d["attendees"],
            "who": who,
            "owner_invited": owner_invited,
            "conference_links": d["conference_links"],
            "description_chars": d["description_chars"],
            "reservation_type": d["reservation_type"],
            "timezone": d["tz"],
            "population": population_label(d["sources"]),
        })

    hours, weekdays, durations, months, zones = {}, {}, {}, {}, {}
    for d in dates:
        if not d["all_day"]:
            hours[d["start"].hour] = hours.get(d["start"].hour, 0) + 1
        key = (d["start"].weekday(), d["start"].strftime("%a"))
        weekdays[key] = weekdays.get(key, 0) + 1
        if d["minutes"] is not None and not d["all_day"]:
            durations[d["minutes"]] = durations.get(d["minutes"], 0) + 1
        m = d["start"].strftime("%Y-%m")
        bucket = months.setdefault(m, {"month": m, "event_dates": 0, "by_population": {}})
        bucket["event_dates"] += 1
        for mask, label in pop_of.items():
            if d["sources"] & mask:
                bucket["by_population"][label] = bucket["by_population"].get(label, 0) + 1
        if d["tz"]:
            zones[d["tz"]] = zones.get(d["tz"], 0) + 1

    dur_rows = sorted(durations.items(), key=lambda kv: -kv[1])
    dur_values = sorted(k for k, v in durations.items() for _ in range(v))

    return {
        "capture": capture,
        "events": {
            "entities": db.one(GRAPH, """
                select count(distinct subject) from event_graph
                where predicate=? and relationshipId=0
            """, (P_TYPE,), 0),
            "classes": [{"class_code": r["class_code"], "label": vocab.clabel(r["class_code"]),
                         "entities": r["entities"]}
                        for r in db.query(GRAPH, """
                select object as class_code, count(distinct subject) as entities
                from event_graph where predicate=? and relationshipId=0
                group by 1 order by entities desc
            """, (P_TYPE,))],
            "event_class": CLASS_EVENT,
            "date_facets": len(dates),
            "titles": db.one(GRAPH, "select count(*) from event_graph where predicate=?", (P_NAME,), 0),
            "distinct_titles": db.one(
                GRAPH, "select count(distinct object) from event_graph where predicate=?", (P_NAME,), 0),
            "all_day": sum(1 for d in dates if d["all_day"]),
            "timezones": sorted(({"tz": k, "event_dates": v} for k, v in zones.items()),
                                key=lambda r: -r["event_dates"]),
            "span": {"first": dates[0]["start"].strftime("%Y-%m-%d") if dates else None,
                     "last": dates[-1]["start"].strftime("%Y-%m-%d") if dates else None},
        },
        "populations": populations,
        "population_overlap": overlap,
        "forward": {
            "rows": forward,
            "event_dates": len(forward),
            "events": len({r["id"] for r in forward}),
            "days": len({r["date"] for r in forward}),
            "with_attendees": sum(1 for r in forward if r["attendees"]),
            "with_links": sum(1 for r in forward if r["conference_links"]),
            "people": len({n for r in forward for n in r["who"]}),
            "owner_invited": sum(1 for r in forward if r["owner_invited"]),
            "last": forward[-1]["date"] if forward else None,
            "past_event_dates": backward,
            "nearest_margin_hours": round(margin, 1) if margin is not None else None,
        },
        "clock": {
            "hours": [{"hour": hh, "event_dates": hours.get(hh, 0)} for hh in range(24)],
            "weekdays": [{"index": k[0], "label": k[1], "event_dates": v}
                         for k, v in sorted(weekdays.items())],
            "durations": [{"minutes": k, "event_dates": v} for k, v in dur_rows],
            "duration_median": dur_values[len(dur_values) // 2] if dur_values else None,
            "duration_max": max(dur_values) if dur_values else None,
            "duration_min": min(dur_values) if dur_values else None,
        },
        "months": [months[k] for k in sorted(months)],
        "text": _text_volume(),
        "authorship": _authorship(),
        "attendance": _attendance(),
        "domains": _domains(),
        "venues": _venues(),
        "links": _links(),
        "travel": _travel(),
        "source_store": _source_store(capture),
        "cap": TOP,
    }


ROUTES = {"/api/calendar": handler}
