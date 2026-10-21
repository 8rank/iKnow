"""db.py — read-only access to the stores, live on this Mac or from a bundle.

By default this app reads the **live** stores: the knowledge graph under
`~/Library/IntelligencePlatform`, the ontology inside the shipped
`IntelligencePlatformCore.framework`, and the four source stores where macOS
actually keeps them. Nothing has to be extracted first — grant the terminal
Full Disk Access, start the server, and the pages render this machine as it is
right now. `--bundle` points the same code at an extracted copy instead.

Four rules hold everywhere in this package:

1. Every connection is opened with `mode=ro` on a file: URI. SQLite refuses
   writes on such a handle, so no code path — not a bug, not a stray UPDATE —
   can touch the stores this app reads. That matters more when the stores are
   the live ones and a daemon is the other reader.
2. Connections are thread-local. The server is threaded and SQLite objects
   cannot cross threads; each request thread lazily opens its own handles,
   and close() releases them when the request is done.
3. Text is decoded leniently. Several columns hold bytes that are not valid
   UTF-8 (hashes, protobuf fragments, truncated strings); the default text
   factory would raise on them mid-query.
4. A store that cannot be opened, or a statement its copy of the schema cannot
   run, degrades to empty rather than taking the page down — but it says so, on
   stderr and to the page. Each request keeps a ledger of what it could not
   read (`begin()`, `gaps()`); the server sends it with the payload and the page
   shows it, because an empty panel would otherwise read as a measured zero.
   Apple adds and renames columns between macOS releases, so a store on someone
   else's Mac is routinely not the shape this code was written against.

Nothing here caches row values to disk, and nothing writes anywhere.

One caveat that comes with reading live stores: the daemons hold them open in
WAL mode and are writing while you read. Each connection sees a consistent
snapshot of its own store, but two stores read a second apart can disagree, and
a page reloaded a minute later can differ. The bundle is frozen; this is not.
"""

import contextlib
import errno
import glob
import os
import sqlite3
import sys
import threading

# repo root = two levels up from this file (api/db.py -> repo/). Only a fallback:
# it is where an extracted sources/ dropped into the repo would be looked for.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- where the live stores are -------------------------------------------

LIVE_GRAPH = "~/Library/IntelligencePlatform"

# The repo's ontology/ directory was copied out of this; the layouts are
# identical, so the framework is a drop-in for it.
LIVE_ONTOLOGY = ("/System/Library/PrivateFrameworks/"
                 "IntelligencePlatformCore.framework/Resources")

# The bundle gathers these four into one sources/ directory. On a real Mac they
# live in four unrelated places, which is why --sources cannot point at the live
# ones and each is resolved by name instead.
LIVE_SOURCES = {
    "chat.db": "~/Library/Messages/chat.db",
    "Calendar.sqlitedb": "~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
    "Photos.sqlite": "~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite",
}
LIVE_ADDRESS_BOOKS = "~/Library/Application Support/AddressBook/Sources"

# macOS 27 keeps some of what the graph used to hold in Biome "sets", one SQLite
# store per set at <dir>/<set>/Database/Set.db (api/biome.py reads them).
LIVE_BIOME = "~/Library/Biome/sets/Default"

GRAPH_DIR = os.path.expanduser(os.environ.get("KG_GRAPH") or LIVE_GRAPH)
ONTOLOGY_DIR = os.path.expanduser(os.environ.get("KG_ONTOLOGY") or LIVE_ONTOLOGY)
# None means the live stores, each found where macOS keeps it. A path means one
# extracted sources/ directory holding all of them.
SOURCES_DIR = os.environ.get("KG_SOURCES")
if SOURCES_DIR:
    SOURCES_DIR = os.path.abspath(os.path.expanduser(SOURCES_DIR))
BIOME_DIR = os.path.expanduser(os.environ.get("KG_BIOME") or LIVE_BIOME)

APPLE_EPOCH = 978307200  # 2001-01-01 UTC, in unix seconds

_local = threading.local()


def configure(graph=None, ontology=None, sources=None, bundle=None):
    """Point the app at a bundle, or at individual directories. Call before serving."""
    global GRAPH_DIR, ONTOLOGY_DIR, SOURCES_DIR, BIOME_DIR
    if bundle:
        base = os.path.abspath(os.path.expanduser(bundle))
        GRAPH_DIR = os.path.join(base, "graph")
        ONTOLOGY_DIR = os.path.join(base, "ontology")
        SOURCES_DIR = os.path.join(base, "sources")
        BIOME_DIR = os.path.join(base, "biome")
    if graph:
        GRAPH_DIR = os.path.abspath(os.path.expanduser(graph))
    if ontology:
        ONTOLOGY_DIR = os.path.abspath(os.path.expanduser(ontology))
    if sources:
        SOURCES_DIR = os.path.abspath(os.path.expanduser(sources))


def live():
    """True when reading the stores in place rather than an extracted copy."""
    return SOURCES_DIR is None


# --- resolving a bundle-relative name to a real path ----------------------

_nested_cache = {}


def _nested(base):
    """Does this graph directory nest the artifact stores, or flatten them?

    The device keeps `Artifacts/siri/remembers/view.db`; the bundle flattens the
    same store to `Artifacts__siri__remembers__view.db`. Rather than make the
    caller declare which layout it is looking at, ask the directory: only one of
    the two has an `Artifacts` subdirectory.
    """
    if base not in _nested_cache:
        _nested_cache[base] = os.path.isdir(os.path.join(base, "Artifacts"))
    return _nested_cache[base]


def _graph_path(name):
    if name.startswith("Artifacts__") and _nested(GRAPH_DIR):
        name = name.replace("__", "/")
    return os.path.join(GRAPH_DIR, name)


def _photos_library():
    """The Photos index, in the default library or whichever one is in ~/Pictures."""
    default = os.path.expanduser(LIVE_SOURCES["Photos.sqlite"])
    if os.path.exists(default):
        return default
    found = sorted(glob.glob(
        os.path.expanduser("~/Pictures/*.photoslibrary/database/Photos.sqlite")))
    return found[0] if found else default


def _source_path(name):
    if SOURCES_DIR:
        return os.path.join(SOURCES_DIR, name)
    if name.startswith("AddressBook/"):
        # sources/AddressBook/<uuid>.abcddb -> Sources/<uuid>/AddressBook-v22.abcddb
        uuid = os.path.basename(name)[:-len(".abcddb")]
        return os.path.join(os.path.expanduser(LIVE_ADDRESS_BOOKS), uuid,
                            "AddressBook-v22.abcddb")
    if name == "Photos.sqlite":
        return _photos_library()
    known = LIVE_SOURCES.get(name)
    return os.path.expanduser(known) if known else os.path.join(ROOT, "sources", name)


def resolve(relpath):
    """`graph/graph.db` -> the real path of that store on this machine."""
    head, _, tail = relpath.partition("/")
    if head == "graph":
        return _graph_path(tail)
    if head == "ontology":
        return os.path.join(ONTOLOGY_DIR, tail)
    if head == "sources":
        return _source_path(tail)
    if head == "biome":
        return os.path.join(BIOME_DIR, tail, "Database", "Set.db")
    return os.path.join(ROOT, relpath)


def graph_stores():
    """Every SQLite store in the graph, under its flattened bundle name.

    Returned names are always the flat form — `Artifacts__internal__views.db` —
    whichever layout the directory on disk uses, because that is the name the
    rest of the app addresses a store by and the one the pages display.
    """
    base = GRAPH_DIR
    try:
        names = [n for n in os.listdir(base) if n.endswith(".db")]
    except OSError:
        return []
    if _nested(base):
        for path in glob.glob(os.path.join(base, "Artifacts", "**", "*.db"),
                              recursive=True):
            rel = os.path.relpath(path, base)
            names.append(rel.replace(os.sep, "__"))
    return sorted(names)


def address_books():
    """[(name, bundle-relative path)] for every Contacts store, either layout.

    The bundle holds these as `<source uuid>.abcddb` side by side; the device
    gives each source its own directory and names all four `AddressBook-v22.abcddb`.
    The uuid is the part that identifies the account, so both layouts are
    presented under it and the pages read the same either way.
    """
    if SOURCES_DIR:
        names = sorted(os.path.basename(p) for p in
                       glob.glob(os.path.join(SOURCES_DIR, "AddressBook", "*.abcddb")))
    else:
        base = os.path.expanduser(LIVE_ADDRESS_BOOKS)
        names = sorted(os.path.basename(d) + ".abcddb"
                       for d in glob.glob(os.path.join(base, "*"))
                       if os.path.isfile(os.path.join(d, "AddressBook-v22.abcddb")))
    return [(n, "sources/AddressBook/" + n) for n in names]


# --- opening ---------------------------------------------------------------

_warned = set()
_warn_lock = threading.Lock()


def _warn(path, message):
    """Say a store could not be read — once per store, on stderr, never in a page."""
    with _warn_lock:
        if path in _warned:
            return
        _warned.add(path)
    print(f"  ! {message}", file=sys.stderr)


# --- what a request could not read ----------------------------------------

def begin():
    """Start this request's ledger of what could not be read."""
    _local.gaps = {}
    _local.probing = 0


def gaps():
    """What this request could not read, in the order it was met:
    [{store, kind, detail}], kind being 'absent', 'denied' or 'query'."""
    return list(getattr(_local, "gaps", {}).values())


def note(store, kind, detail):
    """Add one thing to this request's ledger. Inside probe() it is the caller's
    to handle, and nothing is recorded."""
    if getattr(_local, "probing", 0):
        return
    ledger = getattr(_local, "gaps", None)
    if ledger is not None:
        ledger.setdefault((store, kind, detail),
                          {"store": store, "kind": kind, "detail": detail})


@contextlib.contextmanager
def probe():
    """Reads whose failure the caller expects and answers itself — an optional
    table, a store that may not exist. Inside this block a statement that fails
    raises as it always did, and nothing goes on the ledger."""
    _local.probing = getattr(_local, "probing", 0) + 1
    try:
        yield
    finally:
        _local.probing -= 1


def _store_of(conn):
    """The bundle-relative name a cached connection was opened under."""
    for rel, c in getattr(_local, "conns", {}).items():
        if c is conn:
            return rel
    return "?"


def _failed(relpath, exc):
    """A statement this store's schema could not run: say so, then degrade."""
    if getattr(_local, "probing", 0):
        raise exc
    detail = str(exc)
    _warn(f"{relpath}\0{detail}", f"{relpath}: {detail} — reading it as empty")
    note(relpath, "query", detail)


def _open(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    conn.text_factory = lambda b: b.decode("utf-8", "replace")
    conn.row_factory = sqlite3.Row
    # Opening is lazy; the first read is what actually maps the WAL index, and so
    # it is the first thing that can fail. Do it here, where the failure can be
    # reported against a path, rather than inside somebody's page handler.
    conn.execute("select 1 from sqlite_master limit 1").fetchone()
    return conn


def connect(relpath):
    """Open (and memoise per thread) one store, addressed relative to the bundle.

    `connect("graph/graph.db")`, `connect("sources/chat.db")`. Returns None when
    the file is absent or unreadable, so a panel over an optional store degrades
    to empty rather than taking the page down.
    """
    cache = getattr(_local, "conns", None)
    if cache is None:
        cache = _local.conns = {}
        _local.why = {}
    if relpath in cache:
        conn = cache[relpath]
        if conn is None:
            note(relpath, *_local.why[relpath])
        return conn

    path = resolve(relpath)
    conn = None
    why = None
    if os.path.exists(path):
        try:
            conn = _open(path)
        except (sqlite3.Error, PermissionError) as exc:
            # SQLite reports every one of these as "unable to open database
            # file", and the fixes differ, so why_not() asks the OS which:
            #
            #  * macOS denied the read. The daemon's stores need Full Disk
            #    Access.
            #  * this process is out of file handles (macOS's default is 256).
            #  * the database is in WAL mode and its -shm could not be opened.
            #    A read-only connection still needs that shared-memory index,
            #    and SQLite creates it when it is missing — which it cannot do
            #    on a read-only handle in a directory it may not write.
            #
            # The tempting way out is to reopen with immutable=1, which
            # ignores the WAL and always succeeds. It is not offered: on a live
            # store the WAL is where the most recent facts are, so that would
            # quietly under-report rather than fail.
            why = why_not(path) or ("open", f"could not be opened — {exc}")
            _warn(path, f"cannot read {path}\n    {type(exc).__name__}: {exc} — {why[1]}")
    else:
        # os.path.exists says False for a path it may not stat, too.
        why = why_not(path) or ("absent", "not found on this Mac")

    cache[relpath] = conn
    if conn is None:
        _local.why[relpath] = why
        note(relpath, *why)
    return conn


def why_not(path):
    """Why the OS will not open `path`, as a ledger (kind, detail), or None when
    it will and the failure was SQLite's own."""
    try:
        os.close(os.open(path, os.O_RDONLY))
    except FileNotFoundError:
        return ("absent", "not found on this Mac")
    except PermissionError:
        return ("denied", "macOS refused the read — grant Full Disk Access")
    except OSError as exc:
        if exc.errno in (errno.EMFILE, errno.ENFILE):
            return ("open", "could not be opened — the server has run out of open files")
        return ("open", f"could not be opened — {exc.strerror}")
    return None


def close():
    """Close this thread's connections. The server calls it as each request
    ends: a dropped Connection does not close itself, because its
    statement cache refers back to it, so it waits for the cycle collector —
    and until then holds the store, its -wal and its -shm open. One exposure
    page touches every store, and macOS gives a process 256 files by default."""
    cache = getattr(_local, "conns", None)
    _local.conns = None
    for conn in (cache or {}).values():
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass


def rows(conn, sql, params=()):
    """query() for a connection already in hand (one with stores attached to it,
    say): a list of dicts, or [] — on the ledger — when the statement fails."""
    try:
        cur = conn.execute(sql, params)
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    except sqlite3.OperationalError as exc:
        _failed(_store_of(conn), exc)
        return []


def query(relpath, sql, params=()):
    """Run one read-only statement, return a list of dicts. [] if the store is
    absent or this copy of it cannot run the statement; both go on the ledger."""
    conn = connect(relpath)
    if conn is None:
        return []
    try:
        cur = conn.execute(sql, params)
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    except sqlite3.OperationalError as exc:
        _failed(relpath, exc)
        return []


def one(relpath, sql, params=(), default=None):
    """First column of the first row, or `default` — also when the statement fails."""
    conn = connect(relpath)
    if conn is None:
        return default
    try:
        row = conn.execute(sql, params).fetchone()
    except sqlite3.OperationalError as exc:
        _failed(relpath, exc)
        return default
    return default if row is None else row[0]


def has_table(relpath, table):
    conn = connect(relpath)
    if conn is None:
        return False
    return conn.execute(
        "select 1 from sqlite_master where type in ('table','view') and name=?", (table,)
    ).fetchone() is not None


def apple_time(value):
    """Apple absolute time -> unix seconds. Handles the nanosecond variants the
    artifact stores use, which are ~1e9 times larger than the second form."""
    if value is None:
        return None
    v = float(value)
    if abs(v) > 1e15:   # nanoseconds since 2001
        v /= 1e9
    elif abs(v) > 1e12: # milliseconds since 2001
        v /= 1e3
    return v + APPLE_EPOCH
