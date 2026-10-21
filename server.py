#!/usr/bin/env python3
"""server.py — a loopback-only, read-only viewer for one Apple personal
knowledge graph.

    python3 server.py                      # this Mac, live, on 127.0.0.1:8765
    python3 server.py --port 9000
    python3 server.py --bundle ..          # an extracted copy instead
    python3 server.py --graph /path/to/graph --sources /path/to/sources

By default it reads the live stores on this machine — no extraction step, no
copy. That needs Full Disk Access for the terminal you start it from; the
preflight below says so in as many words if macOS refuses a read.

Standard library only: no Flask, no npm, no network. The page fetches from this
process and nowhere else.

What this process will not do:

  * answer a request that does not carry the token it printed at start. Each
    start mints a new one and prints a link holding it; opening the link swaps
    it for a cookie. Loopback keeps other machines out; the token keeps out
    other programs and other accounts on this one, and web pages in your
    browser. Nothing stores it, so a restart shuts every open tab out;
  * write anything, to the stores or to disk — every SQLite handle is opened
    `mode=ro`, and nothing here opens a file for writing;
  * bind anything but the loopback interface — `--host` is deliberately absent;
  * log request lines to disk, or anywhere but the terminal you started it in;
  * emit a single row value into any file. Values travel from the stores, over
    loopback, into your browser, and are never persisted.

Routes are discovered, not registered: every module in `api/` that defines a
`ROUTES` dict is mounted automatically, so adding a page never means editing
this file. A handler returns a JSON-serialisable payload — or, for the one
route that serves a file, a `(status, content_type, bytes)` triple, which is
sent as it is: the face thumbnails come straight out of the Photos library
over loopback and are never copied anywhere.

A request carrying `redact=1` (the sidebar's switch for sharing the screen) has
its payload rewritten by `api/redact.py` before it is sent: names, phone
numbers, mail and postal addresses become numbered stand-ins, and nothing else
changes. The thumbnails are not rewritten; the page blurs them.
"""

import argparse
import base64
import hashlib
import hmac
import importlib
import json
import os
import pkgutil
import resource
import secrets
import socket
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api import db, redact  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json",
}


class BigIntEncoder(json.JSONEncoder):
    """Entity ids are 64-bit and routinely exceed 2^53.

    JavaScript would silently round them, and every join keyed on an id would
    then break in ways that look like missing data. Any int outside the safe
    range is serialised as a string instead.
    """

    SAFE = 2 ** 53 - 1

    def encode(self, o):
        return super().encode(self._walk(o))

    def iterencode(self, o, _one_shot=False):
        return super().iterencode(self._walk(o), _one_shot)

    def _walk(self, o):
        if isinstance(o, bool):
            return o
        if isinstance(o, int) and abs(o) > self.SAFE:
            return str(o)
        if isinstance(o, dict):
            return {k: self._walk(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [self._walk(v) for v in o]
        if isinstance(o, bytes):
            return o.decode("utf-8", "replace")
        return o


def discover_routes():
    """Mount every api/*.py module that exposes a ROUTES dict."""
    routes = {}
    import api

    for mod in pkgutil.iter_modules(api.__path__):
        if mod.name in ("db", "vocab"):
            continue
        try:
            m = importlib.import_module(f"api.{mod.name}")
        except Exception:
            print(f"  ! api/{mod.name}.py failed to import:", file=sys.stderr)
            traceback.print_exc()
            continue
        for path, handler in getattr(m, "ROUTES", {}).items():
            routes[path] = handler
    return routes


ROUTES = {}


def _is_file(payload):
    """A handler's `(status, content_type, bytes)` triple, sent as it is."""
    return (isinstance(payload, tuple) and len(payload) == 3
            and isinstance(payload[2], (bytes, bytearray)))


def _redacted_error(error):
    """An error while the switch is on. Its text can quote a value or a path,
    so it is scrubbed too; if the scrub is what failed, the detail is withheld."""
    try:
        return redact.scrub(error)
    except Exception:
        return {"error": error["error"], "detail": "withheld while redaction is on"}


# ---------- the token ----------

# Set by mint() at start: the token, the cookie that carries it once the printed
# link has been opened, the Host values this server answers to, and the page
# shown to a request that has no token.
TOKEN = None
COOKIE = None
HOSTS = frozenset()
LOCKED = b""

LOCKED_CSS = """
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
       background: #0d0d0d; color: #ffffff;
       font: 400 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
       -webkit-font-smoothing: antialiased; }
main { max-width: 34rem; padding: 32px 24px; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px;
         font-size: 15px; font-weight: 600; }
.brand svg { width: 28px; height: 28px; }
h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.3; font-weight: 600; }
p { margin: 0 0 14px; color: #c3c2b7; }
pre, code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
pre { margin: 18px 0 20px; padding: 14px 16px; overflow-x: auto;
      background: #1a1a19; border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 6px; color: #c3c2b7; font-size: 12.5px; line-height: 1.6; }
pre b { color: #ffffff; font-weight: 600; }
code { color: #ffffff; font-size: 12.5px; }
.note { color: #898781; font-size: 12.5px; }
"""

LOCKED_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>iKnow · open the link from the terminal</title>
<link rel="icon" href="data:image/svg+xml;base64,{icon}">
<style>{css}</style>
</head>
<body>
<main>
  <div class="brand">{logo}<span>iKnow</span></div>
  <h1>Open the link from the terminal</h1>
  <p>iKnow opens only for the link it printed when it started. The link carries
  an access token, so other programs on this Mac, other accounts on it, and web
  pages in your browser cannot read what this page shows.</p>
  <p>Look in the terminal where you ran <code>python3 server.py</code>:</p>
  <pre>  open this link to read the store:

  <b>http://127.0.0.1:{port}/?token=…</b></pre>
  <p class="note">Each start prints a new token. If the server has been
  restarted, the old link and every tab opened from it stop working; open the
  new link.</p>
</main>
</body>
</html>
"""

# The page above carries its own inline style and nothing else, so it gets a
# policy of its own: no script at all, and only that one style block.
LOCKED_CSP = ("default-src 'none'; style-src 'sha256-%s'; img-src data:; "
              "base-uri 'none'; form-action 'none'"
              % base64.b64encode(hashlib.sha256(LOCKED_CSS.encode()).digest()).decode())


def mint(port):
    """A fresh token for this start, and the link that carries it."""
    global TOKEN, COOKIE, HOSTS, LOCKED
    TOKEN = secrets.token_urlsafe(32)
    # Cookies are scoped by host, not by port: two servers on different ports
    # would overwrite each other's under one name.
    COOKIE = f"iknow-{port}"
    # Anything else in Host is a page that pointed its own domain at
    # 127.0.0.1 (DNS rebinding). The token already stops it; this stops it
    # before the token is looked at.
    HOSTS = frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})
    with open(os.path.join(PUBLIC, "logo.svg"), "rb") as fh:
        logo = fh.read()
    LOCKED = LOCKED_HTML.format(
        icon=base64.b64encode(logo).decode(), css=LOCKED_CSS,
        logo=logo.decode("utf-8").strip(), port=port).encode("utf-8")
    return f"http://127.0.0.1:{port}/?token={TOKEN}"


def _is_token(value):
    """Whether `value` is this start's token, compared in constant time."""
    return bool(value) and hmac.compare_digest(value.encode(), TOKEN.encode())


class Handler(BaseHTTPRequestHandler):
    server_version = "kg-local"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Terminal only. Nothing about this session is written to disk.
        sys.stderr.write("  %s\n" % (fmt % args))

    # This page never loads anything off the network. The policy says so, so a
    # mistake in a page module fails loudly instead of silently fetching from a
    # CDN.
    CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; "
           "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")

    def _send(self, code, body, ctype, extra=None, csp=CSP):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", csp)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _cookie(self):
        # Parsed by hand: SimpleCookie stops at the first cookie it cannot parse
        # and drops the rest, and every app on 127.0.0.1 shares this jar.
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE:
                return value
        return None

    def _has_token(self, offered):
        """The token, from the cookie the printed link leaves behind, from
        `?token=`, or from `Authorization: Bearer` (curl, an agent)."""
        scheme, _, bearer = self.headers.get("Authorization", "").partition(" ")
        return (_is_token(self._cookie()) or _is_token(offered)
                or (scheme.lower() == "bearer" and _is_token(bearer.strip())))

    def _locked(self, path):
        """No token: a page that says where the link is, or the same in JSON."""
        extra = {"WWW-Authenticate": "Bearer"}
        if path.startswith("/api/"):
            return self._send(401, json.dumps({
                "error": "no token",
                "detail": "open the link server.py printed when it started, "
                          "or send its token as 'Authorization: Bearer <token>'",
            }), "application/json; charset=utf-8", extra)
        return self._send(401, LOCKED, "text/html; charset=utf-8", extra, csp=LOCKED_CSP)

    def _enter(self, path, query):
        """The printed link. Its token moves into a cookie and out of the
        address bar, where a shared screen or a bookmark would keep it. The
        browser carries the #fragment across the redirect by itself."""
        rest = urlencode(query, doseq=True)
        return self._send(303, b"", "text/plain; charset=utf-8", {
            # One leading slash, so `//host` cannot turn this into a redirect
            # off the machine.
            "Location": "/" + path.lstrip("/") + ("?" + rest if rest else ""),
            # HttpOnly: no script can read it. Lax rather than Strict, because
            # Strict also withholds it when the tab is reached from a link on
            # another site, which would show the locked page to someone holding
            # the token. Every route is a GET that changes nothing, and Lax
            # still keeps the cookie off other sites' fetches and images.
            "Set-Cookie": f"{COOKIE}={TOKEN}; Path=/; HttpOnly; SameSite=Lax",
        })

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        # The token comes before everything, the page and its static files
        # included: without it a request learns nothing, not even which
        # endpoints exist.
        if self.headers.get("Host", "").lower() not in HOSTS:
            port = self.server.server_address[1]
            return self._send(403, f"iKnow answers only at http://127.0.0.1:{port}/\n",
                              "text/plain; charset=utf-8")
        offered = query.pop("token", [None])[0]
        if not self._has_token(offered):
            return self._locked(path)
        if offered is not None and not path.startswith("/api/"):
            return self._enter(path, query)

        if path.startswith("/api/"):
            handler = ROUTES.get(path)
            if handler is None:
                return self._send(404, json.dumps({"error": "no such endpoint", "path": path}),
                                  "application/json; charset=utf-8")
            params = {k: v[0] for k, v in query.items()}
            # The sidebar's redaction switch. It comes off before the handler
            # sees the request, so no handler or handler cache knows it exists.
            redacting = params.pop("redact", None) == "1"
            # What this request could not read goes back with it, under
            # `_gaps`, and the page shows it: an empty panel must not pass for
            # a measured zero.
            db.begin()
            try:
                payload = handler(params)
                if redacting and not _is_file(payload):
                    payload = redact.scrub(payload)
            except Exception as exc:
                traceback.print_exc()
                error = {"error": type(exc).__name__, "detail": str(exc)[:400]}
                if redacting:
                    error = _redacted_error(error)
                missing = db.gaps()
                if missing:
                    error["gaps"] = missing
                return self._send(
                    500,
                    json.dumps(error),
                    "application/json; charset=utf-8",
                )
            finally:
                # The payload is plain data by now. A thread can serve many
                # requests over one kept-alive connection, so the stores are
                # released per request, not when the thread ends.
                db.close()
            if _is_file(payload):
                status, ctype, body = payload
                return self._send(int(status), bytes(body), ctype)
            missing = db.gaps()
            if missing and isinstance(payload, dict):
                payload = dict(payload, _gaps=missing)
            return self._send(200, json.dumps(payload, cls=BigIntEncoder),
                              "application/json; charset=utf-8")

        return self._static(path)

    def _static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = os.path.normpath(os.path.join(PUBLIC, rel))
        if not target.startswith(PUBLIC + os.sep) and target != PUBLIC:
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        if not os.path.isfile(target):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        with open(target, "rb") as fh:
            body = fh.read()
        ctype = TYPES.get(os.path.splitext(target)[1], "application/octet-stream")
        return self._send(200, body, ctype)


def _probe(path):
    """('ok'|'absent'|'denied'|'error', detail) for one file or directory.

    Absent and denied are the two failures worth telling apart, because the fix
    is completely different: one means point the flag somewhere else, the other
    means grant Full Disk Access. From `os.path.exists` alone they look the
    same — it returns False for a path it was not allowed to stat — so the
    stat is done explicitly and the errno is read.
    """
    try:
        os.stat(path)
    except PermissionError as exc:
        return "denied", str(exc)
    except OSError:
        return "absent", ""
    if os.path.isdir(path):
        try:
            os.listdir(path)
        except PermissionError as exc:
            return "denied", str(exc)
        except OSError as exc:
            return "error", str(exc)
        return "ok", ""
    try:
        with open(path, "rb") as fh:
            fh.read(16)
    except PermissionError as exc:
        return "denied", str(exc)
    except OSError as exc:
        return "error", str(exc)
    return "ok", ""


FDA = """
  macOS denied one or more of those reads. These stores are TCC-protected, so
  the program doing the reading needs Full Disk Access:

      System Settings → Privacy & Security → Full Disk Access

  Add the terminal you started this from (Terminal, iTerm, your editor), or the
  python3 binary itself, then quit that app fully and start it again — the
  permission is picked up at launch, not while running.
"""


def preflight():
    """Fail fast and legibly if the stores are not readable."""
    where = "live on this Mac" if db.live() else "from an extracted bundle"
    print(f"  reading {where}\n")

    ok, denied = True, False

    checks = [("graph", db.GRAPH_DIR, True),
              ("ontology", db.ONTOLOGY_DIR, True),
              ("graph.db", db.resolve("graph/graph.db"), True)]
    if db.live():
        checks += [(name, db.resolve("sources/" + name), False)
                   for name in ("chat.db", "Photos.sqlite", "Calendar.sqlitedb")]
        # The rendered previews Photos keeps beside its database; the face
        # drawer serves them. Optional: the page says what is missing if not.
        library = os.path.dirname(os.path.dirname(db.resolve("sources/Photos.sqlite")))
        checks += [("Photos previews", os.path.join(library, "resources", "derivatives"), False)]
        books = db.address_books()
        checks += [("Contacts", db.resolve(books[0][1]) if books else
                    os.path.expanduser(db.LIVE_ADDRESS_BOOKS), False)]
    else:
        checks += [("sources", db.SOURCES_DIR, False)]

    for label, path, required in checks:
        state, detail = _probe(path)
        mark = {"ok": "ok  ", "absent": "MISS", "denied": "DENY", "error": "ERR "}[state]
        print(f"  {mark} {label:14s} {path}")
        if state == "denied":
            denied = True
        if state != "ok":
            if required:
                ok = False
            elif state == "error":
                print(f"       {detail}")

    # The table above went to stdout, which is block-buffered when this is not a
    # terminal; the advice below goes to stderr, which is not. Without the flush
    # the fix prints before the problem it refers to.
    sys.stdout.flush()
    if denied:
        print(FDA, file=sys.stderr)
    if not ok and not denied:
        print("  Point --graph at a directory holding graph.db, or --bundle at an",
              file=sys.stderr)
        print("  extracted copy with graph/ ontology/ sources/ inside it.\n", file=sys.stderr)
    return ok


def _more_files(want=4096):
    """macOS starts a Terminal process with 256 open files. One exposure request
    holds every store with its -wal and -shm, and the landing page sends its
    requests side by side, so take what headroom the hard limit allows."""
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard != resource.RLIM_INFINITY:
            want = min(want, hard)
        if soft != resource.RLIM_INFINITY and soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except (ValueError, OSError):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bundle", nargs="?", const=os.path.dirname(HERE), metavar="DIR",
                    help="read an extracted copy (DIR/graph, DIR/ontology, DIR/sources) "
                         "instead of the live stores; defaults to the repo this lives in")
    ap.add_argument("--graph", help="directory holding graph.db and the artifact stores")
    ap.add_argument("--ontology", help="directory holding predicate.json / class.json")
    ap.add_argument("--sources", help="directory holding chat.db, Photos.sqlite, Calendar.sqlitedb")
    args = ap.parse_args()

    db.configure(bundle=args.bundle, graph=args.graph, ontology=args.ontology,
                 sources=args.sources)
    _more_files()

    print("\n  Apple personal knowledge graph — local viewer")
    print("  " + "-" * 52)
    if not preflight():
        sys.exit(1)

    global ROUTES
    ROUTES = discover_routes()
    print(f"  {len(ROUTES)} endpoints mounted")

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"\n  cannot bind 127.0.0.1:{args.port} — {exc}", file=sys.stderr)
        sys.exit(1)
    httpd.daemon_threads = True
    link = mint(httpd.server_address[1])

    print("\n  open this link to read the store:\n")
    print(f"  {link}\n")
    print("  the token in it is new each start; without it the page stays shut")
    print("  loopback only · read-only · nothing leaves this machine")
    print("  ctrl-c to stop\n")
    # stdout is block-buffered when it is not a terminal, and the line above is
    # the one the reader actually needs. Flush it rather than let it sit in a
    # buffer until the process exits.
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")


if __name__ == "__main__":
    main()
