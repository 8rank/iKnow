"""The installed-app inventory, and a measurement of the token scheme over it.

Two facts concerning this device live side by side in `graph.db`, on the very
same subject, and the page built on this module exists to put them next to each
other:

  * `nm_bundleID` — the reverse-DNS identifier of an installed application, in
    plain text, one row per app;
  * an object in the `lsBundleRecord:` namespace — the same app, referenced as a
    44-character base64 token, which reads as an anonymised handle.

This module measures the relationship between the two rather than assuming it.
Specifically it runs one controlled experiment
per token namespace: build a word list out of every non-token string the file
already contains — every literal object and every entity id — hash each entry
with unsalted SHA-256, and report how many of that namespace's tokens the
word list inverts. Nothing is assumed about the construction; the count is the
result of actually trying it.

It also reports, per token, the row and subject counts, so the page can check a
reader-supplied identifier against the real token set in the browser instead of
asserting that the construction works.

Everything else it exposes is the inventory itself: the bundle ids, the display
names, the publisher edges, the first time the graph asserted each app, and the
bundle ids that appear in the two interaction logs but not in the inventory.
Capability classification is deliberately NOT done here — it is a string rule
set, it belongs in the page where the reader can read the rules, and it must
never be a list of this machine's apps.

The graph can withdraw its application records (it did after one Mac's
upgrade to macOS 27.0.1, then rebuilt them). When it holds none, the inventory
is read from the Biome set App.InstalledApp instead (api/biome.py): bundle id,
display name and version, with no token, no publisher and no first-seen date. `inventory.source` says which one
the page is showing.

Every value is computed at call time. No row value is written in this file.
"""

import base64
import hashlib
from collections import Counter, defaultdict

from . import biome, db, vocab

GRAPH = "graph/graph.db"
REMEMBERS = "graph/Artifacts__siri__remembers__view.db"
VIEWS = "graph/Artifacts__internal__views.db"

LAYERS = ("stable_graph", "event_graph")

# Schema identifiers out of the shipped ontology — predicate ids, class ids and
# namespace heads. None of these is a row value.
BUNDLE = "nm_bundleID"
APP_ID = "nm_applicationIdentifier"
TEAM_ID = "nm_teamIdentifier"
NAME = "PS33"
IS_A = "PS1"
PUBLISHED_BY = "PS194"

# The namespaces whose tail is presented as an opaque reference. phPerson is in
# the list precisely so the page can show what the measurement says about it.
TOKEN_NS = ("lsBundleRecord", "ekEvent", "sgEvent", "sgContact",
            "inPerson", "faFamilyCircle", "phPerson")

PAD = "="
DIGEST_BYTES = 32


# ---------------------------------------------------------------- the scheme

def _token(text):
    """The construction under test: unsalted base64(sha256(utf-8 bytes))."""
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def _bare(token):
    """Strip base64 padding. The stored form keeps it; the naive construction
    does not, so an equality test that skips this fails on every single row."""
    return token.rstrip(PAD)


def _decoded_bytes(tail):
    """How many bytes this tail decodes to as base64, or None if it is not
    base64 at all. A 32-byte decode is the signature of a SHA-256 digest."""
    for candidate in (tail, tail + "=" * (-len(tail) % 4)):
        try:
            return len(base64.b64decode(candidate, validate=True))
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- loading

def _all_rows():
    rows = []
    for layer in LAYERS:
        if not db.has_table(GRAPH, layer):
            continue
        for r in db.query(
            GRAPH,
            f"select subject, predicate, object, timestamp, confidence, sources "
            f"from {layer}",
        ):
            r["layer"] = layer
            rows.append(r)
    return rows


def _split(rows):
    """-> (per-subject attribute map, per-namespace token occurrences)."""
    attrs = defaultdict(list)          # subject -> [(predicate, object)]
    tokens = defaultdict(list)         # namespace -> [(subject, tail)]
    for r in rows:
        obj = r["object"]
        ns = vocab.ns_of(obj) if isinstance(obj, str) else None
        if ns in TOKEN_NS:
            tokens[ns].append((r["subject"], obj[len(ns) + 1:]))
        else:
            attrs[r["subject"]].append((r["predicate"], obj))
    return attrs, tokens


def _wordlist(rows):
    """Every string this file already holds that could be a token preimage:
    every object that is not itself a token reference, plus every entity id in
    its decimal form. This is the whole search space of the experiment, and its
    size is what makes the negatives below bounded rather than hopeful."""
    words = set()
    for r in rows:
        obj = r["object"]
        if isinstance(obj, str) and vocab.ns_of(obj) in TOKEN_NS:
            continue
        if obj is not None:
            words.add(str(obj))
        words.add(str(r["subject"]))
    return words


# ---------------------------------------------------------------- the panels

def _namespace_report(tokens, attrs, wordlist):
    """One controlled experiment per namespace: does the scheme invert, and does
    it invert from material already inside this same file?"""
    rainbow = {}
    for word in wordlist:
        rainbow.setdefault(_bare(_token(word)), word)

    out = []
    for ns, occurrences in tokens.items():
        tails = [t for _, t in occurrences]
        distinct = sorted(set(tails))
        lengths = sorted({len(t) for t in tails})
        padded = sum(1 for t in tails if t.endswith(PAD))
        decodes = [d for d in (_decoded_bytes(t) for t in distinct) if d is not None]
        digest_shaped = sum(1 for d in decodes if d == DIGEST_BYTES)
        alphabet = sorted({ch for t in distinct for ch in t})

        # Which distinct tokens does the file's own vocabulary invert?
        inverted, preimage_pred, same_subject = 0, Counter(), 0
        for tail in distinct:
            if _bare(tail) in rainbow:
                inverted += 1
        for subject, tail in occurrences:
            bare = _bare(tail)
            # Every predicate on this subject whose value hashes to the token,
            # not just the first: a few apps carry the same string under two
            # predicates, and picking one would misreport where the preimage is.
            hits = {predicate for predicate, obj in attrs.get(subject, ())
                    if obj is not None and _bare(_token(str(obj))) == bare}
            if hits:
                same_subject += 1
                for predicate in hits:
                    preimage_pred[predicate] += 1

        out.append({
            "ns": ns,
            "kind": vocab.NAMESPACES.get(ns, (ns, ""))[0],
            "rows": len(occurrences),
            "distinct": len(distinct),
            "subjects": len({s for s, _ in occurrences}),
            "lengths": lengths,
            "padded_rows": padded,
            "alphabet_size": len(alphabet),
            "decodes_to_digest": digest_shaped,
            "inverted": inverted,
            "rows_with_preimage_on_subject": same_subject,
            "preimage_predicates": [
                {"predicate": p, "label": vocab.plabel(p), "rows": n}
                for p, n in preimage_pred.most_common()
            ],
        })
    out.sort(key=lambda d: -d["rows"])
    return out


def _inventory(attrs):
    """Every subject carrying a bundle id, with its name, publisher and token."""
    names = vocab.names()
    apps = []
    for subject, pairs in attrs.items():
        byp = defaultdict(list)
        for predicate, obj in pairs:
            byp[predicate].append(obj)
        if BUNDLE not in byp:
            continue
        publisher = None
        for obj in byp.get(PUBLISHED_BY, ()):
            publisher = vocab.entity_ref(obj)
            if publisher is not None:
                break
        apps.append({
            "id": vocab.sid(subject),
            "bundle": byp[BUNDLE][0],
            "name": (byp.get(NAME) or [None])[0],
            "app_identifier": (byp.get(APP_ID) or [None])[0],
            "classes": sorted({vocab.clabel(o) for o in byp.get(IS_A, ())}),
            "publisher_id": vocab.sid(publisher),
            "publisher": names.get(publisher) if publisher is not None else None,
        })
    apps.sort(key=lambda a: a["bundle"].lower())
    return apps


def _set_inventory():
    """The App.InstalledApp set, in the inventory's shape. The id is the bundle
    id in a namespace of its own: these records are not graph entities."""
    apps, skipped = biome.installed_apps()
    out = [{
        "id": "set:" + a["bundle"],
        "bundle": a["bundle"],
        "name": a["name"],
        "version": a["version"],
        "app_identifier": None,
        "classes": [],
        "publisher_id": None,
        "publisher": None,
    } for a in apps]
    out.sort(key=lambda a: a["bundle"].lower())
    return out, skipped


def _withdrawn_apps():
    """How many application entities the retraction archive holds."""
    if not db.has_table(GRAPH, "expired_stable_graph"):
        return 0
    return db.one(GRAPH, "select count(distinct subject) from expired_stable_graph "
                         "where predicate = ?", (BUNDLE,), 0)


def _first_seen(rows):
    """When each bundle-id fact was asserted — the graph's own notion of when it
    learned the app existed. Not an install date, and the page says so."""
    seen = {}
    for r in rows:
        if r["predicate"] != BUNDLE:
            continue
        ts = db.apple_time(r["timestamp"])
        key = vocab.sid(r["subject"])
        if ts is not None and (key not in seen or ts < seen[key]):
            seen[key] = ts
    return seen


def _publishers(apps, attrs):
    """The publisher rollup, plus the duplicate-entity check: the same publisher
    name can be carried by more than one entity, which quietly splits a rollup."""
    names = vocab.names()
    counts = Counter(a["publisher_id"] for a in apps if a["publisher_id"])
    out = []
    for pid, n in counts.most_common():
        subject = int(pid)
        pairs = attrs.get(subject, ())
        out.append({
            "id": pid,
            "name": names.get(subject),
            "apps": n,
            "has_team_identifier": any(p == TEAM_ID for p, _ in pairs),
            "classes": sorted({vocab.clabel(o) for p, o in pairs if p == IS_A}),
        })
    by_name = Counter(p["name"] for p in out if p["name"])
    return out, sum(n for n in by_name.values() if n > 1), sum(1 for n in by_name.values() if n > 1)


def _alias_tokens(tokens, attrs, apps):
    """Token rows that sit on a subject carrying no bundle id of its own. The
    interesting case is a publisher addressed by the hash of one of its apps."""
    by_token = {_bare(_token(a["bundle"])): a for a in apps}
    names = vocab.names()
    out = []
    for subject, tail in tokens.get("lsBundleRecord", ()):
        pairs = attrs.get(subject, ())
        if any(p == BUNDLE for p, _ in pairs):
            continue
        target = by_token.get(_bare(tail))
        out.append({
            "id": vocab.sid(subject),
            "name": names.get(subject),
            "classes": sorted({vocab.clabel(o) for p, o in pairs if p == IS_A}),
            "has_team_identifier": any(p == TEAM_ID for p, _ in pairs),
            "resolves_to_app": target["id"] if target else None,
            "resolves_to_name": target["name"] if target else None,
        })
    return out


def _token_payload(tokens, apps, namespaces):
    """Distinct tokens in their stored form, for the browser to test against.

    Only the namespaces whose values were MEASURED to decode to a 32-byte digest
    travel: hashing a guess cannot match something that is not a digest, so
    shipping the rest would invite a comparison that is meaningless by
    construction. No preimage travels with them either — the page names what a
    token stands for only once the reader's own input has produced it, which is
    the whole demonstration.
    """
    digest_shaped = {n["ns"] for n in namespaces if n["decodes_to_digest"]}
    by_token = {_bare(_token(a["bundle"])): a["id"] for a in apps}
    out = []
    for ns, occurrences in tokens.items():
        if ns not in digest_shaped:
            continue
        counts = Counter(t for _, t in occurrences)
        subjects = defaultdict(set)
        for s, t in occurrences:
            subjects[t].add(s)
        for tail, n in counts.items():
            out.append({
                "ns": ns,
                "t": tail,
                "rows": n,
                "subjects": len(subjects[tail]),
                "app": by_token.get(_bare(tail)),
            })
    return out


def _bundle_columns(relpath):
    """Every (table, column) in one store that carries a bundle identifier.

    Found by introspection rather than spelled out, so the panel picks up any
    log that names an application and never silently misses one.
    """
    found = []
    for row in db.query(
        relpath, "select name from sqlite_master where type in ('table','view')"
    ):
        table = row["name"]
        if not table.replace("_", "").isalnum():
            continue
        for col in db.query(relpath, f"pragma table_info({table})"):
            if col["name"].lower() in ("bundleid", "bundle_id"):
                found.append((table, col["name"]))
                break
    return found


def _interaction_bundles(inventory):
    """Bundle ids that appear in the activity logs, marked against the
    inventory. Which device a row came from is not decided here."""
    installed = {a["bundle"] for a in inventory}
    out = []
    for relpath in (REMEMBERS, VIEWS):
        for table, col in _bundle_columns(relpath):
            for r in db.query(
                relpath,
                f"select {col} as bundle, count(*) as n from {table} "
                f"where {col} is not null and {col} <> '' group by 1 order by 2 desc",
            ):
                out.append({"bundle": r["bundle"], "n": r["n"], "log": table,
                            "installed": r["bundle"] in installed})
    return out


# ---------------------------------------------------------------- handler

def handler(params):
    rows = _all_rows()
    attrs, tokens = _split(rows)
    wordlist = _wordlist(rows)

    apps = _inventory(attrs)
    inventory = {"source": "graph", "store": GRAPH, "skipped": 0,
                 "withdrawn_apps": _withdrawn_apps()}
    if not apps:
        apps, skipped = _set_inventory()
        if apps:
            inventory.update(source="biome", store=biome.INSTALLED_APPS, skipped=skipped)
    seen = _first_seen(rows)
    for a in apps:
        a["first_seen"] = seen.get(a["id"])
        a["token"] = None

    # Attach each app's stored token, matched by subject rather than assumed.
    holders = defaultdict(list)
    for subject, tail in tokens.get("lsBundleRecord", ()):
        holders[vocab.sid(subject)].append(tail)
    for a in apps:
        got = holders.get(a["id"])
        if got:
            a["token"] = got[0]

    publishers, dup_entities, dup_names = _publishers(apps, attrs)
    namespaces = _namespace_report(tokens, attrs, wordlist)

    app_ns = next((n for n in namespaces if n["ns"] == "lsBundleRecord"), None)

    return {
        "inventory": inventory,
        "apps": apps,
        "publishers": publishers,
        "publisher_duplicate_entities": dup_entities,
        "publisher_duplicate_names": dup_names,
        "alias_tokens": _alias_tokens(tokens, attrs, apps),
        "namespaces": namespaces,
        "tokens": _token_payload(tokens, apps, namespaces),
        "interaction_bundles": _interaction_bundles(apps),
        "counts": {
            "triples": len(rows),
            "apps": len(apps),
            "apps_with_token": sum(1 for a in apps if a["token"]),
            "apps_with_publisher": sum(1 for a in apps if a["publisher_id"]),
            "apps_with_name": sum(1 for a in apps if a["name"]),
            "apps_with_app_identifier": sum(1 for a in apps if a["app_identifier"]),
            "app_token_rows": app_ns["rows"] if app_ns else 0,
            "app_tokens": app_ns["distinct"] if app_ns else 0,
            "wordlist": len(wordlist),
            "token_namespaces": len(namespaces),
            "token_rows": sum(n["rows"] for n in namespaces),
            "token_distinct": sum(n["distinct"] for n in namespaces),
        },
        "scheme": {
            "digest": "SHA-256",
            "digest_bytes": DIGEST_BYTES,
            "encoding": "base64",
            "salt": None,
        },
    }


ROUTES = {"/api/device": handler}
