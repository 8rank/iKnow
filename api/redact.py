"""redact.py — the screen-sharing mode: who and where come out, the rest stays.

The sidebar switch adds `redact=1` to every API request, and the server passes
the payload through `scrub` before it is serialised. People's names, phone
numbers, mail addresses and postal addresses are swapped for numbered
stand-ins (Person 17, Phone 4, Email 9, Address 2) and nothing else is touched:
numbers, ids, dates, predicates and ontology labels go through as they are, so
every graph keeps its topology and every count its value. The real strings
never leave this process, so the browser on the shared screen never holds them.

A value is recognised in one of two ways:

  * by harvest. Names and addresses are read out of the stores the pages read
    (the graph, Contacts, Messages, Photos, the Siri view) and each one is
    replaced wherever it occurs: as a whole value, or inside a longer one such
    as an event title, a chat name or a file path.
  * by shape. Every mail address and every number written in international
    form is replaced, whichever store it came from.

Four rules keep the rest of the page true:

  1. One stand-in per distinct string, never shared. Two labels that differed
     before redaction still differ after it, so a table or a graph keyed by
     label cannot merge two rows. The cost: "Mario Rossi" and "Mario" become
     two stand-ins even when they are one person.
  2. Only strings change. Numbers are never rewritten. Dict keys go through the
     same function as values, so the one map keyed by handle (the overview's)
     still meets the rows that look it up.
  3. The ontology's own words are never names. A nickname that equals a
     predicate, a class or a relationship label ("mother") is dropped from the
     list, so the labels the pages are about stay put. So is one that equals a
     month or a weekday ("May"), so no date is ever broken up.
  4. A one-word name that is also an ordinary English word ("Rose") is matched
     inside longer text only where it is capitalised, so the prose around it
     survives. A value that is exactly the name as stored ("rose", alone) is
     always replaced.

Stand-ins are numbered in a shuffled order, so a number carries no rank. They
are held in memory for the life of the process, so the same person is the same
stand-in on every page; nothing here is written anywhere. The stores are live,
so the harvest is repeated every few minutes, and the numbers already handed
out are kept.

If the list cannot be built, `scrub` raises rather than letting the payload
through: this mode fails closed.
"""

import calendar
import getpass
import os
import pwd
import random
import re
import sqlite3
import sys
import threading
import time

from . import db, kinship, vocab

GRAPH = "graph/graph.db"
SIRI = "graph/Artifacts__siri__remembers__view.db"
CHAT = "sources/chat.db"
PHOTOS = "sources/Photos.sqlite"

# The live layers and the expired ones. The retractions page names what the
# graph has dropped, so a name that is no longer live is still on screen.
LAYERS = ("stable_graph", "event_graph", "expired_stable_graph", "expired_event_graph")

TYPE_PRED = "PS1"
PERSON_CLASS = "SB104"
SOFTWARE_CLASS = "SB144"

# What a person is called: name, first, family and middle name, username, and
# the alias facet ("also known as").
NAME_PREDS = ("PS33", "PS312", "PS441", "PS546", "PS313", "PS89")
FIRST, MIDDLE, FAMILY = "PS312", "PS546", "PS441"
# How to reach them. Mail addresses need no harvest; their shape finds them.
PHONE_PREDS = ("PS407", "nm_handleIdentifier")
# Where they live: the full street address and the address string match inside
# longer text. City and postal code only as whole values: a city in an event
# title is a place, not an address.
ADDRESS_PREDS = ("PS316", "nm_addressString")
CITY_PREDS = ("PS453",)
POSTCODE_PREDS = ("PS315",)
# The free-text location field of a calendar event.
EVENT_LOCATION = "PS733"

LABELS = {
    "owner": "Owner", "person": "Person", "address": "Address",
    "city": "City", "postcode": "Postcode", "phone": "Phone", "email": "Email",
}
# First claim wins when one string could be two things.
PRIORITY = ("owner", "person", "address", "city", "postcode")

REFRESH = 300          # seconds between harvests
MIN_EMBED = 3          # shorter one-word names are replaced only as the exact value
MAX_GAP = 3            # separator chars allowed between the words of one name
DICT_PATHS = ("/usr/share/dict/words", "/usr/dict/words")

_TOKEN = re.compile(r"\w+")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# A run that could be a phone number. Only replaced when it is written in
# international form or its digits are a number the stores hold, so dates,
# versions and counts that fit the pattern stay as they are.
_PHONE = re.compile(r"(?<![\w+])\+?\(?\d[\d \u00a0().\-/]{5,}\d(?!\w)")
_PHONE_SHAPE = re.compile(r"^(?:tel:)?\+?[\d \u00a0().\-/]+$", re.IGNORECASE)


def _tokens(text):
    return tuple(t.casefold() for t in _TOKEN.findall(text))


def _digits(text):
    return re.sub(r"\D", "", text)


# ---------------------------------------------------------------- stand-ins

_lock = threading.Lock()
_numbers = {}          # kind -> {exact string -> number}


def _number(kind, text):
    table = _numbers.setdefault(kind, {})
    n = table.get(text)
    if n is None:
        n = table[text] = len(table) + 1
    return n


def _stand_in(kind, text):
    with _lock:
        n = _number(kind, text)
    if kind == "owner" and n == 1:
        return LABELS["owner"]
    return f"{LABELS[kind]} {n}"


# ---------------------------------------------------------------- harvest

def _read(where, fn, unread=None):
    """Run one source's queries. A source that cannot be read is said out loud:
    whatever it held is not on the list, and that is worth knowing — on stderr,
    and, through `unread`, on every page redacted while the list stands."""
    try:
        with db.probe():
            return fn()
    except (sqlite3.Error, OSError) as exc:
        sys.stderr.write(f"  ! redact: {where} could not be read ({exc}); "
                         f"its values are not on the list\n")
        if unread is not None:
            unread.append(where)
        return None


def _layers():
    return [layer for layer in LAYERS if db.has_table(GRAPH, layer)]


def _graph_values(preds):
    """(subject, predicate, object) for these predicates, plain or as a facet,
    in every layer."""
    marks = ",".join("?" * len(preds))
    rows = []
    for layer in _layers():
        rows += db.query(GRAPH, f"""
            select subject, coalesce(nullif(relationshipPredicate, ''), predicate) as pred, object
            from {layer}
            where (predicate in ({marks}) and relationshipId = 0)
               or relationshipPredicate in ({marks})
        """, tuple(preds) * 2)
    return rows


def _classes():
    """{entity -> class}, the live layers first."""
    out = {}
    for layer in _layers():
        for r in db.query(GRAPH, f"select subject, object from {layer} "
                                 f"where predicate = ? and relationshipId = 0", (TYPE_PRED,)):
            out.setdefault(r["subject"], r["object"])
    return out


def _full_names(first, middle, family):
    out = []
    if first and family:
        out.append(f"{first} {family}")
        if middle:
            out.append(f"{first} {middle} {family}")
    return out


def _harvest(klass):
    """{kind -> [strings]}, the digits of every phone number held, and the
    sources that could not be read."""
    found = {k: [] for k in PRIORITY}
    phones = []
    unread = []

    def add(kind, value):
        if isinstance(value, str) and value.strip():
            found[kind].append(value.strip())

    def phone(value):
        if not isinstance(value, str):
            return
        v = value.strip()
        if "@" not in v and _PHONE_SHAPE.match(v) and len(_digits(v)) >= 7:
            phones.append(_digits(v))

    owner = vocab.owner_id()

    # The graph: every name-bearing value on a person, and the full names the
    # label chains compose out of the parts.
    parts = {}
    for r in _graph_values(NAME_PREDS):
        if klass.get(r["subject"]) != PERSON_CLASS:
            continue
        add("owner" if r["subject"] == owner else "person", r["object"])
        parts.setdefault(r["subject"], {})[r["pred"]] = r["object"]
    for eid, p in parts.items():
        for full in _full_names(p.get(FIRST), p.get(MIDDLE), p.get(FAMILY)):
            add("owner" if eid == owner else "person", full)
    for r in _graph_values(PHONE_PREDS):
        phone(r["object"])
    for r in _graph_values(ADDRESS_PREDS):
        add("address", r["object"])
    for r in _graph_values(CITY_PREDS):
        add("city", r["object"])
    for r in _graph_values(POSTCODE_PREDS):
        add("postcode", r["object"])
    # The location field of calendar events: a street, a venue, a link. Links
    # are not addresses, and a one-word location is a place, not an address.
    for r in _graph_values((EVENT_LOCATION,)):
        label = r["object"]
        if isinstance(label, str) and "://" not in label and len(_tokens(label)) >= 2:
            add("address", label)

    # The account this server runs as: its login shows up in file paths.
    try:
        account = pwd.getpwuid(os.getuid())
        add("owner", account.pw_name)
        add("owner", account.pw_gecos.split(",")[0])
    except (KeyError, OSError):
        pass
    add("owner", getpass.getuser())
    add("owner", os.path.basename(os.path.expanduser("~")))

    # Contacts: the names, numbers and postal addresses behind the graph's.
    for _, rel in db.address_books():
        def contacts(rel=rel):
            if db.has_table(rel, "ZABCDRECORD"):
                for r in db.query(rel, "select ZFIRSTNAME f, ZMIDDLENAME m, ZLASTNAME l, "
                                       "ZNICKNAME n, ZMAIDENNAME d from ZABCDRECORD"):
                    for v in (r["f"], r["m"], r["l"], r["n"], r["d"]):
                        add("person", v)
                    for full in _full_names(r["f"], r["m"], r["l"]):
                        add("person", full)
            if db.has_table(rel, "ZABCDPHONENUMBER"):
                for r in db.query(rel, "select ZFULLNUMBER v from ZABCDPHONENUMBER"):
                    phone(r["v"])
            if db.has_table(rel, "ZABCDPOSTALADDRESS"):
                for r in db.query(rel, "select ZSTREET s, ZCITY c, ZZIPCODE z "
                                       "from ZABCDPOSTALADDRESS"):
                    street = r["s"] if isinstance(r["s"], str) else ""
                    add("address", street)
                    for line in street.splitlines():
                        if len(_tokens(line)) >= 2:
                            add("address", line)
                    add("city", r["c"])
                    add("postcode", r["z"])
        _read("Contacts", contacts, unread)

    def messages():
        if db.has_table(CHAT, "handle"):
            for r in db.query(CHAT, "select id from handle"):
                phone(r["id"])
    _read("Messages", messages, unread)

    def photos():
        if db.has_table(PHOTOS, "ZPERSON"):
            for r in db.query(PHOTOS, "select ZFULLNAME f, ZDISPLAYNAME d from ZPERSON"):
                add("person", r["f"])
                add("person", r["d"])
    _read("Photos", photos, unread)

    def siri():
        if db.has_table(SIRI, "entities"):
            for r in db.query(SIRI, "select type, json_extract(fields, '$.name') as name "
                                    "from entities where type in ('Person', 'PersonHandle')"):
                if r["type"] == "Person":
                    add("person", r["name"])
                else:
                    phone(r["name"])
    _read("the Siri view", siri, unread)

    return found, phones, unread


def _protected(klass):
    """The vocabulary the pages speak in: (whole phrases, single words)."""
    labels = [p.get("label") for p in vocab.predicates().values()]
    labels += list(vocab.classes().values())
    labels += list(vocab.SOURCE_BITS.values())
    labels += list(LABELS.values())
    labels += [w for names in (calendar.month_name, calendar.month_abbr,
                               calendar.day_name, calendar.day_abbr) for w in names if w]
    labels += _read("the kinship labels", kinship._score_columns) or []
    labels += [n for eid, n in vocab.names().items() if klass.get(eid) == SOFTWARE_CLASS]
    phrases = {_tokens(l) for l in labels if isinstance(l, str)}
    phrases.discard(())
    return phrases, {w for p in phrases for w in p}


def _dictionary_words(candidates):
    """Which of these lower-cased words are ordinary English words."""
    for path in DICT_PATHS:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                return {w for w in (line.strip().lower() for line in fh) if w in candidates}
        except OSError:
            continue
    return set()


class _Lexicon:
    def __init__(self):
        klass = _classes()
        found, phones, self.unread = _harvest(klass)
        phrases, words = _protected(klass)

        self.embed = {}        # token tuple -> kind, matched inside any string
        self.whole = {}        # normalised string -> kind, matched as the whole value
        self.exact = {}        # a name exactly as stored -> kind, as the whole value
        claimed = set()
        for kind in PRIORITY:
            for value in found[kind]:
                toks = _tokens(value)
                if not toks or toks in phrases or (len(toks) == 1 and toks[0] in words):
                    continue
                # A name or a street has letters in it. One that does not would
                # turn every date and count that shares its digits into a person.
                if kind not in ("postcode",) and not any(c.isalpha() for c in value):
                    continue
                if kind in ("city", "postcode"):
                    key = " ".join(value.split()).casefold()
                    if key not in claimed:
                        self.whole.setdefault(key, kind)
                    continue
                claimed.add(" ".join(value.split()).casefold())
                self.exact.setdefault(value, kind)
                # A name of a letter or two is too short to find inside text
                # without hitting words; it is replaced only where it is the value.
                if len(toks) > 1 or len(toks[0]) >= MIN_EMBED:
                    self.embed.setdefault(toks, kind)
        # For each first word, the lengths of the names that start with it,
        # longest first, so the longest name wins where two overlap.
        self.lengths = {}
        for t in self.embed:
            self.lengths.setdefault(t[0], set()).add(len(t))
        self.lengths = {k: sorted(v, reverse=True) for k, v in self.lengths.items()}
        singles = {t[0] for t in self.embed if len(t) == 1}
        self.common = _dictionary_words(singles)

        # A number held in the stores is found in any of its spellings: with the
        # country code, or without it as a national number.
        self.phones = set()
        for d in phones:
            self.phones.add(d)
            for n in (9, 10):
                if len(d) > n:
                    self.phones.add(d[-n:])

        # Number what was harvested now, in shuffled order, so the numbers
        # carry no rank. The owner's own display name is the one "Owner".
        owner_name = vocab.name_of(vocab.owner_id())
        with _lock:
            if owner_name:
                _number("owner", owner_name.strip())
            for kind in PRIORITY:
                fresh = [v for v in dict.fromkeys(found[kind])
                         if v not in _numbers.get(kind, {})]
                random.SystemRandom().shuffle(fresh)
                for v in fresh:
                    _number(kind, v)

        self.built = time.monotonic()


_lex = None
_lex_lock = threading.Lock()


def _lexicon():
    global _lex
    with _lex_lock:
        if _lex is None or time.monotonic() - _lex.built > REFRESH:
            _lex = _Lexicon()
        return _lex


# ---------------------------------------------------------------- matching

def _fits(s, toks, i, n, lex):
    """Is this run of tokens one name as written, and not an ordinary word in
    running text?"""
    for k in range(i, i + n - 1):
        if toks[k + 1].start() - toks[k].end() > MAX_GAP:
            return False
    # A name inside a domain or a bundle id is still a name, and goes. The one
    # thing that costs: the device page cannot look up an app whose bundle id
    # carried one, for as long as the switch is on.
    if n == 1:
        word = toks[i].group(0)
        if word.casefold() in lex.common and not word[0].isupper():
            return False
    return True


def _names(s, lex):
    toks = list(_TOKEN.finditer(s))
    words = [t.group(0).casefold() for t in toks]
    out, last, i = [], 0, 0
    while i < len(toks):
        hit = None
        for n in lex.lengths.get(words[i], ()):
            if i + n > len(toks):
                continue
            kind = lex.embed.get(tuple(words[i:i + n]))
            if kind and _fits(s, toks, i, n, lex):
                hit = (n, kind)
                break
        if not hit:
            i += 1
            continue
        n, kind = hit
        a, b = toks[i].start(), toks[i + n - 1].end()
        out.append(s[last:a])
        out.append(_stand_in(kind, s[a:b]))
        last = b
        i += n
    if not out:
        return s
    out.append(s[last:])
    return "".join(out)


def _phone(lex):
    def repl(m):
        text = m.group(0)
        d = _digits(text)
        if (text.startswith("+") and 7 <= len(d) <= 15) or d in lex.phones:
            return _stand_in("phone", text)
        return text
    return repl


def _text(s, lex):
    kind = lex.exact.get(s.strip()) or lex.whole.get(" ".join(s.split()).casefold())
    if kind:
        return _stand_in(kind, s.strip())
    if "@" in s:
        s = _EMAIL.sub(lambda m: _stand_in("email", m.group(0)), s)
    if any(c.isdigit() for c in s):
        s = _PHONE.sub(_phone(lex), s)
    return _names(s, lex)


# ---------------------------------------------------------------- the walk

def scrub(payload):
    """A redacted copy of one JSON-ready payload. The original is not touched:
    several handlers keep theirs cached for the next request."""
    lex = _lexicon()
    for where in dict.fromkeys(lex.unread):
        db.note("redaction", "redact",
                f"{where} could not be read, so the names and numbers it holds are not replaced")
    memo = {}

    def text(s):
        out = memo.get(s)
        if out is None:
            out = memo[s] = _text(s, lex)
        return out

    def walk(o):
        if isinstance(o, str):
            return text(o)
        if isinstance(o, bytes):
            return text(o.decode("utf-8", "replace"))
        if isinstance(o, dict):
            return {(text(k) if isinstance(k, str) else k): walk(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [walk(v) for v in o]
        return o

    return walk(payload)
