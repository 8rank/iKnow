"""Biome sets: per-domain stores macOS 27 keeps beside the graph.

After one Mac's upgrade to macOS 27.0.1 the graph withdrew its app catalogue,
its Contacts people and its calendar layer for about a day. macOS 27 also keeps
per-domain "sets", one SQLite store each at
~/Library/Biome/sets/Default/<set>/Database/Set.db (`biome/<set>` to db.resolve). Every set has the same shape:

  metacontent_provenance  one row per item: instance_hash -> metacontent,
                          content_hash -> content; deleted_run_length is 0
                          while the item is live
  metacontent             (instance_hash, protobuf) — the item's key
  content                 (content_hash, protobuf) — the item, deduplicated

No .proto ships with macOS. The field numbers below were mapped against this
Mac's own stores and checked against what the app bundles and the withdrawn
graph rows hold for the same items. A record that does not parse is skipped and
counted, never guessed at. Blobs that open with 0x01 'bvx' are LZFSE-compressed;
the App Intents sets use that, none of the sets read here does.

Every value is read at call time. No row value is written in this file.
"""

from . import db

INSTALLED_APPS = "biome/App.InstalledApp"


# ---------------------------------------------------------------- wire format

def _varint(buf, i):
    shift = value = 0
    while True:
        if i >= len(buf):
            raise ValueError("truncated varint")
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def fields(buf):
    """One protobuf message -> {field number: [raw values]}, without recursing.

    A varint comes back as an int; every other wire type as bytes, for the
    caller to read as a string or parse again as a sub-message. Raises
    ValueError on anything that is not well-formed protobuf.
    """
    out, i, n = {}, 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if number == 0:
            raise ValueError("field 0")
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire in (1, 5):
            width = 8 if wire == 1 else 4
            if i + width > n:
                raise ValueError("truncated fixed field")
            value, i = buf[i:i + width], i + width
        elif wire == 2:
            length, i = _varint(buf, i)
            if i + length > n:
                raise ValueError("truncated field")
            value, i = buf[i:i + length], i + length
        else:
            raise ValueError("wire type %d" % wire)
        out.setdefault(number, []).append(value)
    return out


def _text(raw):
    if not isinstance(raw, (bytes, bytearray)):
        return None
    try:
        return bytes(raw).decode("utf-8")
    except UnicodeDecodeError:
        return None


def _first(msg, number):
    values = msg.get(number) or [None]
    return _text(values[0])


# ---------------------------------------------------------------- sets

def records(store):
    """Live items of one set as (metacontent fields, content fields), and how
    many were skipped because a blob did not parse. [] when the store is absent;
    db.query puts that on the page's ledger."""
    out, skipped = [], 0
    for r in db.query(store, """
        select m.metacontent as meta, c.content as content
        from metacontent_provenance p
        join metacontent m on m.instance_hash = p.instance_hash
        left join content c on c.content_hash = p.content_hash
        where p.deleted_run_length = 0
        order by p.sequence_number
    """):
        try:
            meta = fields(r["meta"] or b"")
            content = fields(r["content"] or b"")
        except (ValueError, TypeError):
            skipped += 1
            continue
        out.append((meta, content))
    return out, skipped


def installed_apps():
    """App.InstalledApp -> ([{bundle, name, alt_names, version}], skipped).

    content 1 is the bundle id, 3 the display name, 5 (repeated) alternate
    names; metacontent 1 repeats the bundle id and 2 is the version string. The
    set carries no publisher and no install date.
    """
    apps, skipped = [], 0
    rows, bad = records(INSTALLED_APPS)
    for meta, content in rows:
        bundle = _first(content, 1) or _first(meta, 1)
        if not bundle:
            skipped += 1
            continue
        apps.append({
            "bundle": bundle,
            "name": _first(content, 3),
            "alt_names": [t for t in (_text(v) for v in content.get(5, ())) if t],
            "version": _first(meta, 2),
        })
    return apps, skipped + bad
