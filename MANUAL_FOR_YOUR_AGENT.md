# Manual for your agent

This file is for an AI agent (Claude Code, Codex, or any agent with a shell)
running on a Mac whose owner wants to ask questions about the knowledge graph
macOS keeps about them. It covers where the stores are, how to open them without
changing anything, what every table and code means, how to join out to
Contacts, Photos, Calendar and Messages, the traps that produce wrong answers,
and how to word an answer so it says no more than the store does.

If you are that agent, do §0 first, then read §1 and §8 before you run
anything. The rest is reference: the routing table below says which section
answers which question.

Everything here was checked against a live store on macOS 26. The
schemas are Apple's and can change between releases. Where this file says a
table or column exists, confirm it with `.schema` before relying on it. Nothing
in this file is a value from anyone's store: every example id, name and handle
is a placeholder.

---

## 0. Stop and ask first

**This step is mandatory. Do it before anything else in this file.**

Everything you read from these stores goes into your context, and your context
goes to whoever runs your model. The stores hold the owner's relationships,
contacts, correspondents, calendar and photos, plus scored guesses about people
who never agreed to any of it. Whether that provider may see it is the owner's
call, not yours, and it has to be made before the first row is read.

**Think it through first, and write down your answers for the owner:**

1. Which model you are and which provider serves you, as far as you actually
   know. If you do not know, say so. Do not guess.
2. That anything you read from the stores will be sent to that provider as part
   of your context, and may be logged or retained under its terms. You cannot
   inspect or enforce those terms from here.
3. What the owner's question will make you read: names, phone numbers and mail
   addresses, relationship scores, who they talk to and when, calendar entries,
   and possibly message text.

**Then ask this question, word for word, and wait for the answer:**

> Are you running a trusted LLM provider that you are sure will not abuse the
> knowledge of your local knowledge graph? (yes / no)

Rules for the answer:

- **Ask even if the request already sounds like consent.** The answer has to
  come after the question, in reply to it.
- **Until the owner answers yes, read nothing.** No `sqlite3`, no Python against
  the stores, no call to iKnow's API, not even the preflight in §2.1. Reading
  this file is the only thing allowed before the answer.
- **Only an explicit yes counts.** "Sure", "go ahead" or "yes" in reply to the
  question is a yes. Silence, a new question, or "I think so" is not. Ask again
  or stop.
- **On no, stop.** Do not read the stores. Say what they can do instead: open
  iKnow in the browser (`python3 server.py`, then the link it prints), which
  shows the same data and sends nothing off the machine, or run this
  manual with a model that runs locally.
- **Ask once per session.** A yes covers the rest of the session. If the owner
  changes model or provider mid-session, ask again.

---

## Where to look, by question

| The owner asks | Where the answer is | Section |
|---|---|---|
| What does my Mac know about me? | the entity flagged `nm_isCurrentUser` and everything on it | §6.1, §6.3 |
| What does it know about *person X*? | every row with X as subject, every row pointing at X, the projections | §6.2, §6.3 |
| Who does it think my family is? | `entity_tagging` scores, group membership, Family Sharing circle, importance flags | §6.6, §6.7 |
| How does it know? What evidence? | the feature store behind the scores, `sources`, `sourceDuplicates`, association reasons | §4.5, §6.13 |
| Who do I talk to most, and when? | the interaction log (`siri/remembers/view.db`) | §6.8 |
| Who do I meet with? What is coming up? | `event_graph`, the calendar layer | §6.9 |
| Where do people live or work? | addresses, coordinates, employer statements | §6.5 |
| Which photos is X in? Who appears with whom? | the visual identifier, then the Photos library | §6.4, §7.2 |
| What did it infer rather than copy? | `confidence`, `sources`, alias signal labels, association reasons | §4.4, §4.5, §11 |
| What has it withdrawn or forgotten? | `expired_*` tables, `graph_state` | §6.12 |
| Who is "most relevant" to me right now? | the entity-relevance rankings | §6.10 |
| Which apps does it know I have? | `nm_bundleID` rows | §6.11 |
| Can I read the messages behind a contact? | `chat.db`, joined by handle (never by pointer) | §7.4 |
| What reads this graph? Does it leave the Mac? | what is established so far | §9 |
| What is it *not* keeping? | message and mail bodies, and the undecoded parts | §10 |

---

## 1. Rules

These are the rules iKnow itself follows. Follow them too.

1. **Open every database read-only**, as a `file:` URI with `mode=ro`:
   `sqlite3 "file:$HOME/Library/IntelligencePlatform/graph.db?mode=ro"`. Never
   open one read-write and never run a statement that writes: no `INSERT`,
   `UPDATE`, `DELETE`, `CREATE`, `VACUUM`, `PRAGMA wal_checkpoint` or
   `PRAGMA journal_mode`. Daemons own these files and are writing to them while
   you read.
2. **`ATTACH` must also be a `mode=ro` URI.** `ATTACH '/path/x.db'` with a plain
   path opens the second database read-write even when the first handle is
   read-only. Always write `ATTACH 'file:/path/x.db?mode=ro' AS x`.
3. **Do not use `immutable=1`** to get past a locking or `-shm` error. It skips
   the write-ahead log, and on a live store the WAL holds the most recent facts,
   so you would under-report without any error to tell you so. If a read fails,
   report the failure.
4. **Do not copy the stores or their rows to disk**, and do not paste row
   values into files, commits, issues or web requests. Answers go to the owner,
   in the conversation, and nowhere else.
5. **Read as little as the question needs.** Whatever you read enters your
   context and goes wherever your model runs. Prefer counts, aggregates and
   filtered rows to dumping whole tables. Ask before you pull a whole table of
   names, handles or message text into view.
6. **The owner is not the only person in here.** The graph holds scored and
   inferred assertions about third parties who never used this Mac. Answer the
   owner's questions; do not volunteer dossiers on people they did not ask about.
7. **Measure, don't repeat.** Several columns do not mean what their names or
   Apple's public enums suggest (§8). Where this manual gives a test, run the
   test on this Mac rather than trusting the value written here.

If the owner will share your output with someone else, iKnow's API has a
redaction switch (§2.5) that replaces names, phone numbers and mail and postal
addresses with numbered stand-ins.

---

## 2. Getting access

### 2.1 Full Disk Access

The stores are protected by TCC. The process that reads them needs **Full Disk
Access**: System Settings → Privacy & Security → Full Disk Access, add the app
that runs your shell (Terminal, iTerm, VS Code, the Claude desktop app, …), then
quit it completely and reopen it. The grant is read at launch.

Without it, opening a store fails, usually as `unable to open database file`.
That is a permission problem, not a missing file: check the grant before
concluding the store is absent.

If your agent runs inside its own sandbox, that sandbox must also allow reads
of `~/Library/IntelligencePlatform`, `~/Library/Messages`,
`~/Library/Group Containers/group.com.apple.calendar`,
`~/Library/Application Support/AddressBook` and `~/Pictures`.

A one-line preflight:

```sh
sqlite3 "file:$HOME/Library/IntelligencePlatform/graph.db?mode=ro" \
  "select count(*) from stable_graph" && echo readable
```

`python3 server.py` in this repository runs the same preflight for every store
and prints `ok`, `DENY` or `MISS` beside each.

### 2.2 Where everything is

| What | Path |
|---|---|
| The graph and its projections | `~/Library/IntelligencePlatform/` |
| The ontology (JSON, shipped) | `Resources/` inside `IntelligencePlatformCore.framework`, under `/System/Library/PrivateFrameworks/` (`predicate.json`, `class.json`, `inheritance.json`, `relationship_type.json`) |
| The ontology (SQLite, loaded) | `~/Library/IntelligencePlatform/ontology.db` |
| Messages | `~/Library/Messages/chat.db` |
| Calendar | `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` |
| Contacts (one per account) | `~/Library/Application Support/AddressBook/Sources/<source>/AddressBook-v22.abcddb` |
| Photos | `~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite` (or whichever `*.photoslibrary` is in `~/Pictures`) |
| Photo previews | `<library>/resources/derivatives/<first hex char of asset UUID>/<ASSET UUID>_1_105_c.jpeg` (other suffixes: `_1_102_o.jpeg`, `.THM`) |

### 2.3 Opening stores

With the `sqlite3` shell:

```sh
cd ~/Library/IntelligencePlatform
sqlite3 -header -column "file:graph.db?mode=ro"
```

```sql
ATTACH 'file:ontology.db?mode=ro' AS o;
.param set :id <entity id>
```

A relative `file:` path resolves against the shell's working directory, so the
recipes in this file assume you start `sqlite3` from
`~/Library/IntelligencePlatform`. `~` and shell variables are not expanded
inside SQL. The recipes use `:id` for an entity id; bind it with `.param set` or
substitute the number.

With Python, the standard library is enough:

```python
import sqlite3, os
def ro(path):
    c = sqlite3.connect(f"file:{os.path.expanduser(path)}?mode=ro", uri=True)
    c.text_factory = lambda b: b.decode("utf-8", "replace")  # some columns are not valid UTF-8
    c.row_factory = sqlite3.Row
    return c
g = ro("~/Library/IntelligencePlatform/graph.db")
```

The `text_factory` line matters: several columns hold bytes that are not valid
UTF-8, and the default decoder raises halfway through a query.

### 2.4 Shortcut: import iKnow's own modules

If this repository is on disk you do not have to write the plumbing. The `api/`
package is standard library only and does not need the server running:

```python
import sys; sys.path.insert(0, "/path/to/iKnow")
from api import db, vocab

db.query("graph/graph.db", "select count(*) n from stable_graph")        # list of dicts
db.query("graph/Artifacts__entityTagging__entityTagging.db", "select * from entity_tagging limit 5")
vocab.owner_id()                       # the owner's entity id
vocab.name_of(eid)                     # best display name
vocab.statements("stable_graph", subject=eid)   # reified facets collapsed into whole statements
vocab.plabel("PS520"), vocab.clabel("SB104")   # decode codes
vocab.source_names(mask)               # decode the sources bitmask
db.apple_time(v)                       # Apple time (s, ms or ns) -> unix seconds
```

`db` resolves logical names to real paths: `graph/<file>` is under
`~/Library/IntelligencePlatform`, and a nested store is addressed with `__` in
place of `/` (`Artifacts/siri/remembers/view.db` becomes
`graph/Artifacts__siri__remembers__view.db`). `sources/chat.db`,
`sources/Calendar.sqlitedb` and `sources/Photos.sqlite` find the live source
stores. Every handle is `mode=ro`.

Each page module also exposes the handler behind its endpoint, and calling it
returns the same JSON the page renders: `from api import kinship;
kinship.handler({})`. These are built for pages and are large; print only the
keys you need.

### 2.5 Shortcut: iKnow's HTTP API

If the owner has `python3 server.py` running, everything is also available as
JSON on loopback, to a caller holding the server's token. The server prints it
at start, inside the link it tells the owner to open
(`http://127.0.0.1:8765/?token=…`). It is new each start and stored nowhere, so
ask the owner for the link; there is no file to read it from. Without it every
endpoint answers `401`. The token opens nothing but this port on this Mac, and
only until the server stops, so it is safe in the conversation.

| Endpoint | Returns |
|---|---|
| `/api/overview` | counts, owner, namespace census, join resolution rates |
| `/api/identity` | the join table: which namespaces each person reaches, resolution against the source stores |
| `/api/person?id=<entity id>` | one entity: decoded facts, inbound references, aliases |
| `/api/kinship` | the scorecard, column analysis, evidence ledger, household |
| `/api/comms` | the interaction log: volume, direction, rhythm, top counterparts, groups |
| `/api/calendar` | the calendar layer: dates, attendees, domains, venues, travel |
| `/api/social` | the social graph (params `jaccard`, `closeness`, `channel_share`) |
| `/api/social/node?id=` · `/api/social/component?key=` | one node, one cluster |
| `/api/faces` · `/api/faces/top?n=` · `/api/faces/person?id=<ZPERSON Z_PK>` · `/api/faces/network?min=` | face clusters, co-occurrence |
| `/api/certainty` | confidence distribution, sources decode, provenance |
| `/api/retractions` | expired rows, classified against the live layer |
| `/api/retractions/graph` | the expired rows that were links (event → person, entity → calendar record), keyed to `/api/social`'s node ids |
| `/api/device` | installed apps and the token experiment |
| `/api/exposure` | views, subscriptions, projections, consumers |

`curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8765/api/person?id=<id>'`,
or `&token=<token>` in the query. A `401` after that means the server was
restarted and minted a new token: ask for the new link. Add `&redact=1` (or
`?redact=1`) to any call to get the payload with names, phone numbers and mail
and postal addresses replaced by numbered stand-ins, and every number, id and
predicate unchanged.

For anything these do not cover, go to SQL.

---

## 3. Map of the stores

Paths are relative to `~/Library/IntelligencePlatform`. Files ending
`-fullRebuild.db` are staging copies of the file with the same name without the
suffix; read the one without it.

| Directory | File | Tables that matter | What it is |
|---|---|---|---|
| (top) | `graph.db` | `stable_graph`, `event_graph`, `expired_stable_graph`, `expired_event_graph`, `graph_state`, `*_fts` | **The graph.** People, organisations, places, apps, groups (`stable_graph`); calendar events (`event_graph`); withdrawn rows (`expired_*`). Also construction tables (`construction_*`, `entity`, `translated`, `pairs`, `matches`, `blocks`) that are empty or intermediate between pipeline runs. |
| (top) | `ontology.db` | `class`, `predicate`, `predicate_domain`, `predicate_range`, `inheritance`, `relationship_type` | The vocabulary that decodes every code in the graph. |
| `Artifacts/entityTagging/` | `entityTagging.db` | `entity_tagging` | **The relationship scorecard**: one row per person, seventeen scores (mother, father, parent, sister, brother, sibling, family, friend, familyAndFriends, partner, coworker, alumni, child, son, daughter, myself, unknown). |
| `Artifacts/siri/remembers/` | `view.db` | `interactions`, `entities`, `interactionEntities` | **The interaction log**: every message sent or received and every call, as metadata, over a limited window (measure it with `MIN`/`MAX(startDate)`). No message text. |
| `Artifacts/internal/` | `views.db` | `handle_id`, `phperson_id_map`, `entity_alias`, `people_relationship`, `people_subgraph`, `entity_subgraph`, `event_subgraph`, `app_subgraph`, `personInteractionMechanisms`, `photosObservedAges`, `*ContextEvents`, `*Histograms` | Identity maps (handle → entity, face cluster → entity), aliases, filtered copies of the graph, and the behavioural event streams. |
| `Artifacts/entityRelevance/` | `entityRelevanceInferences.db` | `person_entity_relevance`, `person_entity_longterm`, `loi_entity_relevance` | Relevance rankings with a JSON explanation per entity. |
| `Artifacts/entityRelevance/` | `entityImportanceSignals.db` | `entityImportanceSignalsIDMap` | Per-person flags: `isFavorite`, `isEmergencyContact`, `isICloudFamily`, `relationshipLabel`. |
| `Artifacts/feature/` | `features.db` | `kv` | Feature store. Holds the inputs to the scorecard (`personEntityTagging`, `personEntityTaggingFacts`, `photosPersonEntityTagging`) and to the relevance rankings, as binary plists. |
| `Artifacts/ecr/` | `views.db` | `entity_alias_ecr`, `asr_entity_alias`, `entity_summary` | Aliases for entity resolution and speech recognition; a one-row summary per person. |
| `Artifacts/visualIdentifier/` | `visualIdentifier.db` | `people` | Copy of person rows plus the face-cluster binding. |
| `Artifacts/photosAutonaming/` | `photosAutonaming.db` | `subgraph`, `rejections` | Copy of person rows for Photos naming; face clusters the owner rejected. |
| `Artifacts/people/`, `lifeEvent/`, `futureLifeEvent/` | `people.db`, `lifeEventView.db`, `futureLifeEventView.db` | `people`, `lifeEvent_subgraph`, `lifeEvent_map`, `futureLifeEvent_*` | More per-consumer copies of the graph. `lifeEventView` is a filtered copy of the graph for the lifeEvent consumer, not a list of life events. |
| `Artifacts/siri/` `defaultResolverInteractions/` | `view.db` | `candidates`, `events`, `candidateInteractions`, `tuples` | Which contact Siri resolved a request to. |
| (top) | `views.db` | `viewConfigRecord`, `viewState`, `sourceListenerConfig`, `sourceListenerState` | The control plane: every view, what it subscribes to, where it writes, when it last ran. |
| (top) | `globalKnowledge.db` | `static_graph`, `live_graph` | **Not personal.** Apple-authored reference knowledge, and a cache of off-device entity lookups. |
| (top) | `behaviors.db` | `behaviorEventsExtended`, `histogram`, `histogramKey_*`, `personInteractionMechanisms` | Behavioural histograms (app launches, locations, Wi-Fi, focus modes, …). Whether this belongs to the graph or is shared machinery in the same directory is not established. |
| (top) | `aliases.db` | `aliases` | Apple's kinship-word lexicon (Wikidata ids × localizations). Not personal. |
| (top) | `keyvalue.db`, `state.db`, `eventLog.db`, `feedbackLog.db` | | Housekeeping. |

Most questions are answered from `graph.db`, `entityTagging.db`,
`siri/remembers/view.db` and `internal/views.db`, plus the four source stores.

---

## 4. The triple store

### 4.1 Schema

`stable_graph`, `event_graph` and their `expired_` twins share nine columns:

```sql
subject                INTEGER  -- entity id, 64-bit
predicate              TEXT     -- ontology code: 'PS33', 'nm_bundleID', …
relationshipId         INTEGER  -- 0 for a plain attribute; otherwise the id of a reified statement
relationshipPredicate  TEXT     -- '' for a plain attribute; otherwise the facet this row carries
object                 TEXT     -- the value (always TEXT, whatever it encodes)
sources                INTEGER  -- bitmask of the ingests that asserted it (§4.5)
confidence             DOUBLE   -- 0..1
sourceDuplicates       TEXT     -- the source records it came from, 0x1E-separated (§4.5)
timestamp              DOUBLE   -- Apple absolute time: when the row was written
PRIMARY KEY (subject, predicate, relationshipId, relationshipPredicate, object)  -- live layers only
```

### 4.2 Layers

- **`stable_graph`**: people, organisations, places, groups, installed apps, and
  the owner.
- **`event_graph`**: calendar events and reservations. The only part of the
  store about the future.
- **`expired_stable_graph`, `expired_event_graph`**: rows the graph withdrew.
  Withdrawal is an `INSERT` here, keeping the row's confidence, sources and
  original timestamp. They are pruned after a window (§6.12).
- `construction_*`: empty between runs. The daily pipeline builds into them
  and swaps them in by renaming tables.

`graph_state` has two keys, both Apple absolute time:
`buildFromScratchTimestamp` (when the graph was first built; it may never have
been rebuilt since) and `expiredTriplesPruneTimestamp` (rows in `expired_*` older
than this have been deleted).

### 4.3 Reification: rows vs statements

A row with `relationshipId = 0` and `relationshipPredicate = ''` is a plain
attribute: `(person, PS33 name, "…")`.

A row with a non-zero `relationshipId` is **one facet of a statement**. All
facets of the statement share `subject`, `predicate` and `relationshipId`, and
each row carries one `relationshipPredicate` and its value. Example: one phone
number on a person is a `PS520` statement with three or four rows:

| subject | predicate | relationshipId | relationshipPredicate | object |
|---|---|---|---|---|
| `<person>` | `PS520` | `<rid>` | `PS1` | `CS97` (the statement's type) |
| `<person>` | `PS520` | `<rid>` | `PS407` | the phone number |
| `<person>` | `PS520` | `<rid>` | `PS740` | the Contacts label, e.g. `_$!<Mobile>!$_` |

Collapse facets before interpreting them: group by `relationshipId` (and
`subject`), and pivot on `relationshipPredicate`. Counting rows counts facets,
not facts. A statement can repeat a facet (a group statement can carry several
`PS566` member rows), so pivot into lists, not a single value per facet.

### 4.4 Entity ids and object values

- **Entity ids are signed 64-bit integers** and routinely exceed 2^53. Keep them
  as strings in JSON or anything JavaScript touches, or joins break silently.
- **An object pointing at another entity is the text `md:<id>`.** A bare
  integer object is never a reference. To follow one:
  `CAST(substr(object, 4) AS INTEGER)`.
- **Objects are typed by a namespace head**, recognised against an allowlist.
  Never decide a namespace by splitting on `:`, because calendar prose, URLs and
  serialised dates contain colons too.

| Head | What it points at | Resolvable? |
|---|---|---|
| `md:` | another entity in this graph | yes, always |
| `cnContact:` | a Contacts record: `<UUID>:ABPerson` | yes, verbatim (§7.1) |
| `phPerson:` | a Photos person cluster: `<ZPERSONUUID>/L0/<nnn>` | yes (§7.2) |
| `ekEvent:` | an EventKit event: base64 SHA-256 of `<store persistent_id>:<item unique_identifier>` | yes, by hashing (§7.3) |
| `lsBundleRecord:` | an installed app: base64 SHA-256 of the bundle id | yes, by hashing (§6.11) |
| `sgEvent:`, `sgContact:` | Siri Suggestions records: events and contacts the system found in mail and messages | no local construction known |
| `inPerson:` | an Intents person | no |
| `faFamilyCircle:` | a Family Sharing circle | no, but equal tokens mean the same circle |
| `association:` | an association reason (enum) | n/a |
| `tel:`, `mailto:`, `http:`, `https:` | URIs | n/a |

Phone numbers and mail addresses also appear as bare literals in `PS407` and
`PS406` facets. The hashed namespaces are unsalted: anyone with a candidate
identifier can confirm a match with one hash, so treat them as pseudonymous,
not anonymous.

- **Classes and predicates also appear as objects.** The `PS1` ("is a") value
  of an entity is a class code (`SB104` person); the `PS1` facet of a statement
  is a statement-type code (`CS97`). Decode both against the ontology.
- **Dates inside objects are JSON**, not numbers:
  `{"year":…,"month":…,"day":…,"hour":…,"minute":…,"second":…,"nanosecond":…,"timeZone":{"identifier":"…"},"isLeapMonth":…}`
  (serialised `NSDateComponents`). Read them with `json_extract`. `hour` and
  `minute` are missing on all-day entries. `nm_imputed*` facets are Apple
  absolute time as text.

### 4.5 Provenance: confidence, sources, sourceDuplicates

**Copied facts and inferred facts share one table and one shape.** Three
columns are all that separate them:

- **`confidence`** mostly tracks **which ingest wrote the row**, not how sure
  anything is about the fact. On the store this was checked against, values
  clustered by source (Contacts at 1.0, Photos at 0.9, most other sources
  between 0.7 and 0.8); how several sources combine is not established. So a 0.8
  may mean "written by a 0.8 source", not "inferred with 80% certainty". Check with
  `SELECT sources, round(confidence, 3), count(*) FROM stable_graph GROUP BY 1, 2`.
  A second confidence, `nm_confirmationConfidence`, is a facet on alias
  statements; which of the two is authoritative is not established. The graph's
  own judgements are clearer elsewhere: the scorecard (§6.6), `derived_alias`,
  the association reasons, and `nm_imputed*` values.
- **`sources`** is a **bitmask**, not an id. Test bits with `sources & (1<<n)`,
  never `GROUP BY sources`, because many rows combine several bits. The mapping
  below was derived empirically (no shipped file names the bits); iKnow's
  `/api/certainty` re-derives it on each Mac from `sourceDuplicates`:

  | bit | value | ingest |
  |---|---|---|
  | 0 | 1 | Contacts |
  | 1 | 2 | Intents (INPerson) |
  | 5 | 32 | Photos face clusters |
  | 8 | 256 | Calendar (EventKit) |
  | 10 | 1024 | Suggestions contacts |
  | 11 | 2048 | Suggestions events |
  | 13 | 8192 | Family Sharing |
  | 15 | 32768 | App catalogue |

- **`sourceDuplicates`** names the exact source records a row was built from,
  separated by ASCII 0x1E (`char(30)`), not commas. Each part is a namespaced
  reference (`cnContact:…`, `phPerson:…`, …). A literal row such as a name or a
  birthday still names the record it was copied out of, which makes this the
  most direct answer to "where did this come from".

Two more provenance carriers, as facets:

- `nm_associationReason` on a face binding: an `association:` value from a
  seven-value enum covering an identifier match or no match, extraction from
  messages, contacts inferred or confirmed, and the owner tagging someone in
  HomeKit or Photos. Owner-asserted and model-derived reasons share this one
  field. List the values present with
  `SELECT object, count(*) FROM stable_graph WHERE relationshipPredicate = 'nm_associationReason' GROUP BY 1`.
- `nm_signalLabel` on an alias: `first_provided_alias`, `family_provided_alias`,
  `full_provided_alias`, `middle_provided_alias`, `me_alias`, `derived_alias`.
  `*_provided_*` came from a record; `derived_alias` was generated.

### 4.6 Time

| Where | Unit |
|---|---|
| `timestamp` columns in `graph.db`, `graph_state` values | Apple absolute seconds (since 2001-01-01 UTC) |
| `interactions.startDate` (remembers) | Apple absolute seconds, REAL |
| `interactionDate`, `timestamp` in `internal/views.db` | Apple absolute seconds |
| date objects in `event_graph` | JSON components with a time-zone identifier (§4.4) |
| Photos `ZDATECREATED`, Calendar `start_date` | Apple absolute seconds |
| `chat.db` `message.date` | nanoseconds since 2001 on current macOS |

Convert Apple seconds in SQL with
`datetime(x + 978307200, 'unixepoch', 'localtime')`. Divide nanoseconds by 1e9
first. `db.apple_time()` handles all three magnitudes. The `timestamp` column
records **when the graph wrote the row**, not when the thing happened: a meeting's
time is in its date facets, and the two can be a year apart.

---

## 5. Decoding the vocabulary

The ontology has 181 classes and 278 predicates. `SB`, `CS` and `PS` codes form
one numbered space; `nm_` codes are Apple's local extension. Decode everything:

```sql
ATTACH 'file:ontology.db?mode=ro' AS o;

-- what predicates are in use, and how often
SELECT g.predicate, p.label, count(*) n, count(DISTINCT g.subject) subjects
FROM stable_graph g LEFT JOIN o.predicate p ON p.id = g.predicate
GROUP BY 1 ORDER BY n DESC;

-- what kinds of entity exist
SELECT g.object AS class, c.label, count(DISTINCT g.subject) n
FROM stable_graph g LEFT JOIN o.class c ON c.id = g.object
WHERE g.predicate = 'PS1' AND g.relationshipId = 0
GROUP BY 1 ORDER BY n DESC;
```

Run both on `event_graph` as well. `predicate.json` adds `domain`, `range` and
`subjectType` (`string`, `number`, `dateTime`, `class`) per predicate; a
`dateTime` predicate's object is a date even when it looks like text.

### 5.1 Classes you will meet

| Code | Label |
|---|---|
| `SB104` | person |
| `SB10` | organization |
| `SB152` | place |
| `SB2` | group of humans |
| `SB144` | software |
| `SB472` | calendar event |
| `SB514` | transportation activity |
| `SB470` | device primary user |

### 5.2 Predicates, stable layer

| Code | Label | Shape |
|---|---|---|
| `PS1` | is a | class code |
| `PS33` | name | text. The owner can carry two (a display name and a login-shaped one) |
| `PS312` · `PS546` · `PS441` | first · middle · family name | text |
| `nm_isCurrentUser` | is current user | on exactly one entity: the owner |
| `PS102` | same as | a namespaced reference to the same entity elsewhere (`cnContact:`, `phPerson:`, `lsBundleRecord:`, …) |
| `PS72` | identifier | reified: `PS396` identifier type (`CNContact`, `PHPerson`, `EKEvent`, `SGEvent`, `FAFamilyCircle`, …), `PS69` identifier value |
| `PS520` | has contact information | reified: `PS407` phone, `PS406` email, `PS740` label |
| `nm_entityAliasRelationship` | entity alias relationship | reified: `PS89` alias text, `nm_signalLabel`, `nm_confirmationConfidence` |
| `nm_hasVisualIdentifier` | has visual identifier | reified: `nm_visualIdentifier` (Photos cluster), `nm_associationReason` |
| `nm_personType` · `nm_photosDetectionType` | Photos person type · detection type | text on face-derived people |
| `PS500` | employer | reified: `PS45` → `md:` organisation, `PS548` department |
| `PS753` | group includes individual | reified: `PS566` → `md:` member (repeats) |
| `PS317` | has address | reified: `PS316` street, `PS453` city, `PS315` postal code, `PS455` district, `PS450` country |
| `nm_addressString` | address string | text |
| `PS573` | has latitude/longitude | reified: `PS571` latitude, `PS572` longitude |
| `PS225` | has location relationship | reified: `PS107` → `md:` place |
| `nm_age` · `nm_familyMemberType` | age · family member type | from Family Sharing |
| `PS598` | has association | reified: `CS168` relationship edge with a label and `nm_confidence`. Declared and read by shipped views; may be absent on a given Mac |
| `nm_imputedBirthday` | imputed date of birth | declared; may be absent |
| `nm_bundleID` · `nm_applicationIdentifier` · `nm_teamIdentifier` | app identity | text |
| `PS194` | published by | → `md:` publisher entity |
| `PS296` | URL | text |
| `nm_hasSoftware` | has software | reified, → `md:` app |
| `nm_handleIdentifier` | handle identifier | usually one constant value, not a handle store; check before using |

### 5.3 Predicates, event layer

| Code | Label | Shape |
|---|---|---|
| `PS33` | name | the event title |
| `PS51` | description | **the full event description, verbatim**, often written by someone other than the owner |
| `nm_hasDate` | has date | reified: `PS29` start, `PS30` end, `nm_occurrenceDate` (one per occurrence of a series), `nm_imputed*` as Apple seconds |
| `nm_isAllDay` | is all day | `0` / `1` |
| `PS232` | has attendee | reified: `PS143` → `md:` person, `PS734` participant obligation |
| `PS578` | has organizer | reified, same facets |
| `PS580` | calendar event sender | `md:` person who sent the invitation or mail |
| `PS225` | has location relationship | reified: `PS107` → `md:` place, `PS733` location label |
| `nm_virtualConferenceURL` | virtual conference URL | join links and **dial-in bridges** (`tel:` here is a conference number, not a person) |
| `nm_sourceType` | source type | where a Suggestions event was found, e.g. `Mail` |
| `nm_sgEventType` | reservation type | a schema.org reservation type, e.g. `FlightReservation` |
| `PS248` · `PS249` · `nm_flightNumber` · `nm_iataCode` | start / end location, flight, airport | travel |
| `PS72` · `PS102` | identifier · same as | `ekEvent:` / `sgEvent:` references |
| `PS392` · `nm_creationDate` · `nm_imputed*` | last updated, created | |

The event layer comes from two ingests that share no subject: **EventKit**
events (`sources` bit 8: attendees and organisers, no descriptions) and
**Suggestions** events (bit 11: descriptions, senders and reservations
extracted from mail, no attendees). Do not join an attendee list from one to a
description from the other.

---

## 6. Recipes

All SQL below runs against `graph.db` unless it says otherwise, with
`sqlite3` started from `~/Library/IntelligencePlatform` so relative paths
resolve (§2.3). Bind `:id` to an entity id.

### 6.1 The owner

```sql
SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser';
```

Exactly one row. Exclude this id from every "top people" ranking: the owner is
not one of their own contacts.

### 6.2 Find a person

By name, across name predicates and aliases:

```sql
SELECT DISTINCT subject, predicate, relationshipPredicate, object
FROM stable_graph
WHERE (predicate IN ('PS33','PS312','PS441','PS546')
       OR (predicate = 'nm_entityAliasRelationship' AND relationshipPredicate = 'PS89'))
  AND object LIKE '%' || :name || '%';
```

By phone or mail address. Phone formats differ between stores, so compare
digits (the last 9 are a reasonable key):

```sql
SELECT subject, relationshipPredicate, object FROM stable_graph
WHERE predicate = 'PS520' AND relationshipPredicate IN ('PS407','PS406')
  AND (lower(object) = lower(:handle)
       OR replace(replace(replace(replace(object,' ',''),'-',''),'(',''),')','') LIKE '%' || :last9digits);
```

or through the handle index, which is what the interaction log joins on:

```sql
-- in Artifacts/internal: views.db
SELECT id FROM handle_id WHERE handle = :handle;
```

Many entities have no name at all. They entered the graph as a handle on an
invitation or a face in a photo. Label them by their handle and say so; do not
invent a name.

### 6.3 Everything about one entity

```sql
ATTACH 'file:ontology.db?mode=ro' AS o;

-- outbound: every row with this subject, decoded
SELECT g.predicate, p.label, g.relationshipId AS rid,
       g.relationshipPredicate AS facet, f.label AS facet_label,
       g.object, g.confidence, g.sources,
       datetime(g.timestamp + 978307200, 'unixepoch') AS written
FROM stable_graph g
LEFT JOIN o.predicate p ON p.id = g.predicate
LEFT JOIN o.predicate f ON f.id = g.relationshipPredicate
WHERE g.subject = :id
ORDER BY g.predicate, g.relationshipId, g.relationshipPredicate;

-- inbound: who points at it (groups, employees, events it attends)
SELECT 'stable' AS layer, subject, predicate, relationshipPredicate FROM stable_graph WHERE object = 'md:' || :id
UNION ALL
SELECT 'event', subject, predicate, relationshipPredicate FROM event_graph WHERE object = 'md:' || :id;
```

Then, keyed on the same id: `entity_tagging` (§6.6), `entityImportanceSignalsIDMap`
(§6.7), `person_entity_relevance` (§6.10), `handle_id` and the interaction log
(§6.8), `phperson_id_map` (§6.4), `entity_alias`, `people_relationship` and
`entity_summary`. In Python, `vocab.statements("stable_graph", subject=id)`
returns the outbound rows already collapsed into statements.

### 6.4 Handles, employer, aliases, face

```sql
-- contact information, one row per statement
SELECT relationshipId,
  max(CASE WHEN relationshipPredicate = 'PS407' THEN object END) AS phone,
  max(CASE WHEN relationshipPredicate = 'PS406' THEN object END) AS email,
  max(CASE WHEN relationshipPredicate = 'PS740' THEN object END) AS label,
  max(sources) AS sources
FROM stable_graph WHERE predicate = 'PS520' AND subject = :id
GROUP BY relationshipId;

-- employer, resolved to the organisation's name
SELECT e.subject AS person, org.object AS organisation, dep.object AS department, e.confidence
FROM stable_graph e
JOIN stable_graph org ON org.subject = CAST(substr(e.object, 4) AS INTEGER) AND org.predicate = 'PS33'
LEFT JOIN stable_graph dep ON dep.subject = e.subject AND dep.relationshipId = e.relationshipId
                          AND dep.relationshipPredicate = 'PS548'
WHERE e.predicate = 'PS500' AND e.relationshipPredicate = 'PS45' AND e.subject = :id;

-- aliases and where each came from
SELECT a.object AS alias, s.object AS signal, c.object AS confirmation
FROM stable_graph a
JOIN stable_graph s ON s.subject = a.subject AND s.relationshipId = a.relationshipId
                   AND s.relationshipPredicate = 'nm_signalLabel'
LEFT JOIN stable_graph c ON c.subject = a.subject AND c.relationshipId = a.relationshipId
                        AND c.relationshipPredicate = 'nm_confirmationConfidence'
WHERE a.predicate = 'nm_entityAliasRelationship' AND a.relationshipPredicate = 'PS89'
  AND a.subject = :id;

-- the Photos cluster bound to this entity, and why
SELECT v.object AS cluster, substr(v.object, 1, instr(v.object, '/') - 1) AS zpersonuuid,
       r.object AS reason, v.confidence
FROM stable_graph v
LEFT JOIN stable_graph r ON r.subject = v.subject AND r.relationshipId = v.relationshipId
                        AND r.relationshipPredicate = 'nm_associationReason'
WHERE v.predicate = 'nm_hasVisualIdentifier' AND v.relationshipPredicate = 'nm_visualIdentifier'
  AND v.subject = :id;
```

`PS740` labels in the form `_$!<Mobile>!$_` are Apple's markup for a standard
label; strip the markers to display them. `internal/views.db` has the same
aliases pre-flattened in `entity_alias (MD_ID, alias, entity_type, signal_type,
confirmation_confidence)`, and the face map as `phperson_id_map
(phPersonIdentifier, id)`.

### 6.5 Places and addresses

```sql
-- postal addresses, one per statement
SELECT subject, relationshipId,
  max(CASE WHEN relationshipPredicate = 'PS316' THEN object END) AS street,
  max(CASE WHEN relationshipPredicate = 'PS453' THEN object END) AS city,
  max(CASE WHEN relationshipPredicate = 'PS315' THEN object END) AS postcode,
  max(CASE WHEN relationshipPredicate = 'PS450' THEN object END) AS country
FROM stable_graph WHERE predicate = 'PS317'
GROUP BY subject, relationshipId;

-- coordinates
SELECT subject,
  max(CASE WHEN relationshipPredicate = 'PS571' THEN object END) AS lat,
  max(CASE WHEN relationshipPredicate = 'PS572' THEN object END) AS lon
FROM stable_graph WHERE predicate = 'PS573'
GROUP BY subject, relationshipId;
```

Addresses attach to people and to place entities; follow `PS225`/`PS107` from a
person or an event to a place. Check the subject's class (`PS1`) before saying
"X lives at": an address on a person was usually copied from their contact card,
and the card's own label (home, work) is in Contacts, not here (§7.1).

### 6.6 The relationship scorecard

`Artifacts/entityTagging/entityTagging.db`, table `entity_tagging`. `mdid` is
the entity id as **TEXT**; cast it to join.

```sql
-- open entityTagging.db, then:
ATTACH 'file:graph.db?mode=ro' AS g;

SELECT t.mdid,
       (SELECT object FROM g.stable_graph n WHERE n.subject = CAST(t.mdid AS INTEGER)
          AND n.predicate = 'PS33' ORDER BY n.confidence DESC LIMIT 1) AS name,
       (SELECT object FROM g.stable_graph k WHERE k.subject = CAST(t.mdid AS INTEGER)
          AND k.predicate = 'PS1' AND k.relationshipId = 0 LIMIT 1) AS class,
       round(t.familyAndFriends, 3) ff, round(t.family, 3) fam, round(t.friend, 3) friend,
       t.partner, t.mother, t.father, t.sibling, t.child, t.myself
FROM entity_tagging t
ORDER BY t.familyAndFriends DESC LIMIT 40;
```

How to read it:

- **Only `family` and `familyAndFriends` come from trained models**: two
  binary XGBoost classifiers ("is this person family?", "family or friend?")
  over the same 144 features. No shipped model produces the other fifteen
  columns; the likely source is a separate heuristics service. They are sparse
  and take a few quantised values (such as 0.125, 0.25, 0.5). `coworker`,
  `alumni` and `unknown` are often zero everywhere.
- **A high `family` score is weak evidence on its own.** Decoded offline, the
  Family model gives a saved contact with every feature at zero about **0.84**,
  on the assumption that missing features reach the model as zeros. Scores
  cluster high, and organisations can score as family. Compare people to each
  other and to that baseline, look at the leaf columns, and look at the
  evidence (§6.13) before calling anyone family.
- **Scores are recomputed, not stored as facts.** The table has no timestamp,
  and `eventid` was 0 on every row measured. It can keep scoring an entity the live graph
  no longer contains, so check that `mdid` still has rows in `stable_graph`
  before presenting a score as current.
- **Check the class.** Rank people (`SB104`) and say when a high scorer is an
  organisation.
- The only consumer of these scores established so far is the Family Sharing
  invitation suggestion. Saying the scorecard "decides" anything else overclaims.

### 6.7 Household, groups, Family Sharing, flags

Four signals from different places. Report them side by side, because they can disagree.

```sql
-- groups the owner is in, and their other members (graph.db)
SELECT g.subject AS grp, CAST(substr(m.object, 4) AS INTEGER) AS member
FROM stable_graph g
JOIN stable_graph m ON m.subject = g.subject AND m.predicate = 'PS753'
                   AND m.relationshipPredicate = 'PS566'
WHERE g.predicate = 'PS753' AND g.object = 'md:' || (SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser');

-- entities sharing a Family Sharing circle token with the owner (graph.db)
SELECT DISTINCT s.subject FROM stable_graph s
WHERE s.object IN (SELECT object FROM stable_graph
                   WHERE subject = (SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser')
                     AND object LIKE 'faFamilyCircle:%');
```

```sql
-- in Artifacts/entityRelevance: entityImportanceSignals.db
SELECT entityIdentifier, isFavorite, isEmergencyContact, isICloudFamily, relationshipLabel
FROM entityImportanceSignalsIDMap
WHERE isFavorite OR isEmergencyContact OR isICloudFamily OR coalesce(relationshipLabel, '') <> '';

-- in Artifacts/internal: views.db. Relationship labels resolved for alias use; may be empty
SELECT subject, relation, relationAlias FROM people_relationship;
```

`isICloudFamily` and a shared `faFamilyCircle:` token are declared by Family
Sharing. A `PS753` group says where it came from in its `sources` bits, and
can itself be the Family Sharing group (bit 13). The scorecard is inferred. Say which is which. Flags that are 0 on every row mean the column
exists and has nothing in it, which is a result, not an error.

### 6.8 Communication: who, when, how much

`Artifacts/siri/remembers/view.db`, opened from the store directory with
`sqlite3 "file:Artifacts/siri/remembers/view.db?mode=ro"`. Three tables:

- `interactions`: one row per message or call. `domain` (`Messages`, `Calls`,
  or other intents), `type` (`INSendMessageIntent`, `INStartCallIntent`, …),
  `bundleId` (the app), `direction`, `handlingStatus`, `startDate` (Apple
  seconds), `durationSeconds`, `fields` (JSON, holds `isGroup` and nothing
  textual), `contentHash`, `isDonatedBySiri`, `remoteDeviceId`.
- `entities`: counterparts. `type` is `Person`, `PersonHandle`, `Message`,
  `MessageGroup` or `SuggestionAction`; `id` is the handle or identifier;
  `fields` is JSON with `name` (on Person, PersonHandle and MessageGroup) and
  `label`, `type`, `countryCode` on handles.
- `interactionEntities (interactionRowid, entityRowid, parameter)`: which
  entity filled which role. `parameter` is `sender`, `senderHandle`,
  `recipients`, `recipientHandles`, `contacts`, `contactHandles`,
  `speakableGroupName`, `sentMessages`.

**First, establish what `direction` means on this Mac.** Do not assume
Apple's `INInteractionDirection` numbering. A `sender` can only exist on an
incoming interaction:

```sql
SELECT i.direction, count(*) n,
  sum(EXISTS(SELECT 1 FROM interactionEntities ie WHERE ie.interactionRowid = i.rowid AND ie.parameter = 'sender')) AS with_sender,
  sum(EXISTS(SELECT 1 FROM interactionEntities ie WHERE ie.interactionRowid = i.rowid
             AND ie.parameter IN ('recipients','recipientHandles','contacts','contactHandles'))) AS with_recipient
FROM interactions i GROUP BY 1;
```

The value whose rows carry `sender` is incoming; the other populated value is
outgoing. (So far this test has found 1 incoming and 2 outgoing.)
Likewise, the `handlingStatus` whose `Calls` rows carry `durationSeconds > 0` is
the connected-call status.

Top counterparts, resolved to graph entities through the handle index:

```sql
ATTACH 'file:Artifacts/internal/views.db?mode=ro' AS iv;

SELECT h.id AS entity, count(DISTINCT i.rowid) AS interactions,
       sum(i.domain = 'Calls') AS calls, sum(i.domain = 'Messages') AS messages,
       group_concat(DISTINCT i.bundleId) AS apps,
       datetime(min(i.startDate) + 978307200, 'unixepoch', 'localtime') AS first,
       datetime(max(i.startDate) + 978307200, 'unixepoch', 'localtime') AS last
FROM entities e
JOIN iv.handle_id h ON h.handle = e.id
JOIN interactionEntities ie ON ie.entityRowid = e.rowid
JOIN interactions i ON i.rowid = ie.interactionRowid
WHERE e.type = 'PersonHandle'
GROUP BY h.id ORDER BY interactions DESC LIMIT 25;
```

Counterparts the graph never resolved still carry a name in the log:

```sql
SELECT coalesce(json_extract(e.fields, '$.name'), e.id) AS who, e.type,
       count(DISTINCT i.rowid) AS n, sum(i.domain = 'Calls') AS calls
FROM entities e
JOIN interactionEntities ie ON ie.entityRowid = e.rowid
JOIN interactions i ON i.rowid = ie.interactionRowid
WHERE e.type IN ('Person', 'PersonHandle')
GROUP BY who, e.type ORDER BY n DESC LIMIT 25;
```

Rhythm, in the Mac's local time zone:

```sql
SELECT strftime('%w', startDate + 978307200, 'unixepoch', 'localtime') AS weekday,
       strftime('%H', startDate + 978307200, 'unixepoch', 'localtime') AS hour,
       count(*) n
FROM interactions WHERE domain IN ('Messages', 'Calls')
GROUP BY 1, 2 ORDER BY 1, 2;
```

Group chats are `entities.type = 'MessageGroup'`; their members are the
`PersonHandle` entities on the same interactions.

Things to state when you answer:

- The log covers **a limited window** (measure its span; do not assume a year)
  and is metadata only. It knows who, when, which app, which direction and how
  long, and holds **no message text**.
- `contentHash` is a signed 64-bit **thread key**, shared by many
  interactions. Use it to count conversations, never messages, and never as a
  fingerprint of content.
- `handle_id` is many-to-many. A count per entity is a count of identities
  resolving to that entity, not necessarily one human.
- Rows with `isLocal = 0` and a `remoteDeviceId` arrived from another of the
  owner's devices. The log can be mostly or entirely another device's
  activity, so count them before saying "on this Mac".

### 6.9 Calendar: events, attendees, who the owner meets

```sql
-- every event date, with title and time zone (a recurring series has several)
SELECT st.subject AS event,
       (SELECT object FROM event_graph t WHERE t.subject = st.subject AND t.predicate = 'PS33' LIMIT 1) AS title,
       printf('%04d-%02d-%02d %02d:%02d',
              json_extract(st.object, '$.year'), json_extract(st.object, '$.month'),
              json_extract(st.object, '$.day'), coalesce(json_extract(st.object, '$.hour'), 0),
              coalesce(json_extract(st.object, '$.minute'), 0)) AS starts,
       json_extract(st.object, '$.timeZone.identifier') AS tz
FROM event_graph st
WHERE st.relationshipPredicate = 'PS29'
ORDER BY starts;
```

Filter to `starts >= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')` for "what
is coming up", noting that each date is wall-clock time in its own `tz`.

```sql
-- attendees of one event, named where the graph can
SELECT CAST(substr(a.object, 4) AS INTEGER) AS person,
       (SELECT object FROM stable_graph n WHERE n.subject = CAST(substr(a.object, 4) AS INTEGER)
          AND n.predicate = 'PS33' LIMIT 1) AS name,
       (SELECT object FROM stable_graph m WHERE m.subject = CAST(substr(a.object, 4) AS INTEGER)
          AND m.relationshipPredicate = 'PS406' LIMIT 1) AS email
FROM event_graph a
WHERE a.subject = :event AND a.predicate IN ('PS232', 'PS578') AND a.relationshipPredicate = 'PS143';

-- the people the owner shares the most events with
SELECT CAST(substr(object, 4) AS INTEGER) AS person, count(DISTINCT subject) AS events
FROM event_graph
WHERE predicate = 'PS232' AND relationshipPredicate = 'PS143'
  AND object <> 'md:' || (SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser')
GROUP BY 1 ORDER BY events DESC LIMIT 25;
```

Most attendees have no name, only the address they were invited at. Their mail
domains are often the most informative column (employer, school). Descriptions
(`PS51`) can run to a thousand characters of someone else's writing; quote only
what the question needs. The graph holds a selection of the calendar, not all
of it; for the complete calendar, read `Calendar.sqlitedb` (§7.3).

### 6.10 Relevance: who matters "right now"

In `Artifacts/entityRelevance/`, `entityRelevanceInferences.db`:

```sql
SELECT mdid, round(relevanceScore, 4) AS score,
       json_extract(explanation, '$.positiveContributions') AS pushed_up,
       json_extract(explanation, '$.negativeContributions') AS pushed_down
FROM person_entity_relevance ORDER BY relevanceScore DESC LIMIT 20;
```

`person_entity_longterm` is the long-horizon version; `loi_entity_relevance`
ranks places. The feature store behind them (`features.db`, views named
`personEntityRelevance*`) conditions on time of day, day of week, coarse and
specific geohash, location of interest and current Wi-Fi network. This ranking
is what the system uses to decide which "Anna" you mean. Its explanation JSON is
Apple's own per-entity attribution; quote it rather than inventing reasons.

### 6.11 Installed apps

```sql
SELECT b.subject, b.object AS bundle_id,
       (SELECT object FROM stable_graph n WHERE n.subject = b.subject AND n.predicate = 'PS33' LIMIT 1) AS name,
       (SELECT p.object FROM stable_graph x JOIN stable_graph p
          ON p.subject = CAST(substr(x.object, 4) AS INTEGER) AND p.predicate = 'PS33'
        WHERE x.subject = b.subject AND x.predicate = 'PS194' LIMIT 1) AS publisher,
       datetime(b.timestamp + 978307200, 'unixepoch') AS first_asserted
FROM stable_graph b WHERE b.predicate = 'nm_bundleID' ORDER BY name;
```

`first_asserted` is when the graph wrote the fact, not an install date. The
`lsBundleRecord:` token on the same subject is `base64(sha256(bundle id))`
with padding kept:

```python
import base64, hashlib
token = "lsBundleRecord:" + base64.b64encode(hashlib.sha256(b"com.example.app").digest()).decode()
```

### 6.12 Withdrawn facts

```sql
SELECT key, datetime(value + 978307200, 'unixepoch') FROM graph_state;

-- classify every withdrawn row against what is live now
SELECT fate, count(*) FROM (
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject AND l.predicate = e.predicate
                 AND l.relationshipPredicate = e.relationshipPredicate AND l.object = e.object) THEN 'reasserted'
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject AND l.predicate = e.predicate) THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject) THEN 'withdrawn'
    ELSE 'entity gone' END AS fate
  FROM expired_stable_graph e) GROUP BY fate;
```

Repeat with `event_graph` / `expired_event_graph`. Some expired rows match a live
row and look like rewrites rather than deletions; how many varies, so classify
them before calling anything deleted. The archive only
reaches back to `expiredTriplesPruneTimestamp`; where it has been measured, that
window was 48 hours. So the expired tables show what changed recently, not a history.

Deletion reaches the live graph on a later pipeline run, because most ingests
re-scan their source in full. The materialised copies of the graph were found
consistent with it. The scorecard was not (§6.6).

### 6.13 The evidence behind a score

`Artifacts/feature/features.db`, table `kv (viewName, featureName,
subidentifierName, value)`. For per-person rows `subidentifierName` is
`md:<entity id>`; `value` is an `NSKeyedArchiver` binary plist wrapping one
`MLFeatureValue`.

| viewName | What it holds |
|---|---|
| `personEntityTaggingFacts` | discrete facts the tagger evaluated per person: `sameLastName`, `hasSameEmailDomains`, `hasSamePublicEmailDomain`, `iCloudFamilyMember`, `iCloudFamilyMemberType`, `isCurrentUser`, `nameCategoryMatch`, `partialNameCategoryMatch`, `photosPersonAge`, `photosAgeDifferenceCategory` |
| `personEntityTagging` | the behavioural profile: `<time or context>PopularityGiven<Person>` and its inverse (morning, weekday, focus mode, home, work, …) |
| `photosPersonEntityTagging` | the same, from photo co-appearance |
| `personEntityRelevance*` | inputs to the relevance ranking |

Decode a value:

```python
import plistlib
def feature(blob):
    objs = plistlib.loads(blob)["$objects"]
    top = objs[1]
    deref = lambda u: objs[u.data] if isinstance(u, plistlib.UID) else u
    return deref(top.get("type")), deref(top.get("value"))
```

**A row means the question was asked, not that the answer was yes.** Count
true values, not rows. The full model input has 144 features; this table holds
the ones that were materialised on this Mac.

---

## 7. Leaving the graph: the source stores

The graph is mostly a **join table**: its value is that one entity carries a
Contacts id, handles, a Photos cluster, calendar seats and apps side by side.
These are the joins. Open every source store `mode=ro` as well.

### 7.1 Contacts

A `cnContact:` object reads `cnContact:<UUID>:ABPerson`. Drop the `cnContact:`
head and the rest, `<UUID>:ABPerson`, matches `ZABCDRECORD.ZUNIQUEID`
**verbatim, suffix included**. Stripping `:ABPerson` as well gives zero matches. A few match `ZLINKID` instead (linked cards). There is one
`AddressBook-v22.abcddb` per account under `Sources/`; search all of them.

```sql
-- each AddressBook-v22.abcddb
SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION, r.ZJOBTITLE, r.ZBIRTHDAY
FROM ZABCDRECORD r WHERE r.ZUNIQUEID = :cn OR r.ZLINKID = :cn;

SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER   WHERE ZOWNER = :pk;
SELECT ZADDRESS,    ZLABEL FROM ZABCDEMAILADDRESS  WHERE ZOWNER = :pk;
SELECT *                   FROM ZABCDPOSTALADDRESS WHERE ZOWNER = :pk;
SELECT ZNAME,       ZLABEL FROM ZABCDRELATEDNAME   WHERE ZOWNER = :pk;  -- relations the owner typed
```

`ZABCDRELATEDNAME` is what the owner declared ("mother", "partner"). Put it
next to the scorecard when answering kinship questions: the difference between
the two is the inference.

### 7.2 Photos

The bound cluster is `nm_visualIdentifier` (or `phPerson:` under `PS102`),
shaped `<ZPERSONUUID>/L0/<nnn>`. The part before the first `/` is
`ZPERSON.ZPERSONUUID`. It is plaintext, not a hash.

```sql
-- Photos.sqlite
SELECT Z_PK, ZFULLNAME, ZDISPLAYNAME, ZVERIFIEDTYPE, ZKEYFACE FROM ZPERSON WHERE ZPERSONUUID = :uuid;

-- that person's photographs, newest first
SELECT a.ZUUID, datetime(a.ZDATECREATED + 978307200, 'unixepoch', 'localtime') AS taken,
       a.ZLATITUDE, a.ZLONGITUDE
FROM ZDETECTEDFACE f JOIN ZASSET a ON a.Z_PK = f.ZASSETFORFACE
WHERE f.ZPERSONFORFACE = :person_pk AND a.ZTRASHEDSTATE = 0
ORDER BY a.ZDATECREATED DESC;

-- who appears in photographs with whom
SELECT fa.ZPERSONFORFACE a, fb.ZPERSONFORFACE b, count(DISTINCT fa.ZASSETFORFACE) shared
FROM ZDETECTEDFACE fa JOIN ZDETECTEDFACE fb
  ON fb.ZASSETFORFACE = fa.ZASSETFORFACE AND fb.ZPERSONFORFACE > fa.ZPERSONFORFACE
WHERE fa.ZPERSONFORFACE IS NOT NULL
GROUP BY 1, 2 ORDER BY shared DESC LIMIT 30;
```

- Size a cluster by counting `ZDETECTEDFACE` rows. `ZPERSON.ZFACECOUNT` is a
  stale cache.
- Scene labels hang off `ZMEDIAANALYSISASSETATTRIBUTES`, not `ZASSET`:
  `ZSCENECLASSIFICATION.ZASSETATTRIBUTES → ZMEDIAANALYSISASSETATTRIBUTES.Z_PK →
  .ZASSET`. Joining it straight to `ZASSET.Z_PK` returns plausible, wrong rows.
- The soft-biometric columns on faces (`ZAGETYPE`, `ZGENDERTYPE`, …) are
  integer codes with 0 meaning "not computed", and no code-to-label table ships.
  Report coverage, not a demographic reading.
- Most clusters are unnamed in Photos, and few are bound to a graph entity.
  Report the rate.
- `ZASSET.ZLATITUDE` / `ZLONGITUDE` use `-180.0` as a sentinel for no
  location in that column, not a place in the Pacific.

### 7.3 Calendar

`ekEvent:<token>` = `base64(sha256(Store.persistent_id + ':' +
CalendarItem.unique_identifier))`, padding kept. SQLite has no SHA-256, so
build the lookup in Python:

```python
import base64, hashlib
rows = cal.execute("""
  SELECT ci.ROWID, s.persistent_id || ':' || ci.unique_identifier
  FROM CalendarItem ci JOIN Calendar c ON c.ROWID = ci.calendar_id JOIN Store s ON s.ROWID = c.store_id
  WHERE ci.unique_identifier IS NOT NULL AND s.persistent_id IS NOT NULL""")
by_token = {"ekEvent:" + base64.b64encode(hashlib.sha256(p.encode()).digest()).decode(): rid
            for rid, p in rows}
```

Then `CalendarItem` has `summary`, `description`, `start_date`, `end_date`
(Apple seconds), `all_day`, `start_tz`, `location_id → Location(title, address,
latitude, longitude)`, and `Participant(owner_id, email, phone_number, role,
status, is_self)`. `sgEvent:` tokens (events found in mail) have no known local
preimage.

### 7.4 Messages

Nothing in the graph points at a message: the ontology has no message
predicate. What joins is the **handle**, and it reaches a whole thread, never
one message.

```sql
-- chat.db
SELECT h.ROWID, h.id, h.service FROM handle h WHERE lower(h.id) = lower(:handle);

SELECT datetime(m.date / 1e9 + 978307200, 'unixepoch', 'localtime') AS at,
       m.is_from_me, m.text, length(m.attributedBody) AS rich_bytes
FROM message m WHERE m.handle_id = :handle_rowid
ORDER BY m.date DESC LIMIT 50;
```

- Match mail addresses case-insensitively and phone numbers by their last
  digits: the two stores format numbers differently.
- On current macOS `message.text` is often NULL and the body is only in
  `attributedBody`, an archived `NSAttributedString`. Its readable text is a
  UTF-8 run after the `NSString` marker; decode it rather than reporting "no
  text".
- `chat.db` only holds Messages (iMessage, SMS, RCS). Traffic in third-party
  messengers appears in the interaction log (§6.8) as metadata and has no text
  anywhere on this Mac that this manual covers.
- This is the most sensitive join in the manual. Read message text only when the
  owner asks for it.

---

## 8. Traps

Each of these gives a wrong answer without raising an error. Most are closed in iKnow's code, which says so where it does.

1. **Plain `ATTACH` is read-write.** Use a `file:…?mode=ro` URI (§1).
2. **`immutable=1` hides the newest facts.** Don't (§1).
3. **Splitting on `:` to find a namespace.** Use the allowlist in §4.4.
   Calendar prose, URLs and JSON dates all contain colons.
4. **Counting rows instead of statements.** Reified facts are several rows each
   (§4.3).
5. **`GROUP BY sources`.** It is a bitmask; test bits (§4.5).
6. **`sourceDuplicates` split on commas.** The separator is `char(30)`.
7. **`CAST(date_object AS REAL)`.** Event dates are JSON; the cast returns 0
   and every event lands on 2001-01-01. Use `json_extract`.
8. **`timestamp` as the event time.** It is when the row was written (§4.6).
9. **Zero read as a date.** Several timestamp columns hold `0.0` for "never";
   that formats as 2001-01-01. Filter `> 0`. `computeIfPastSLA.runByTimestamp`
   is a deadline in the future, not a last-run time.
10. **Empty string read as a value.** `viewState.errorMessage` is non-NULL and
    empty on many rows; test `length(coalesce(x, '')) > 0`.
11. **Entity ids through JavaScript or a float.** They exceed 2^53 (§4.4).
12. **`mdid` is TEXT.** `entity_tagging.mdid` and the relevance tables' `mdid`
    need `CAST(… AS INTEGER)` to join `stable_graph.subject`.
13. **Stripping `:ABPerson`** from Contacts ids gives zero matches (§7.1).
14. **Stripping base64 padding.** The stored tokens keep their `=`; a hash
    without it never matches.
15. **Trusting `direction` or `handlingStatus` to Apple's public enums.**
    Measure them (§6.8).
16. **`contentHash` as a message id.** It is a thread key (§6.8).
17. **`tel:` in the event layer as a person's number.** Those are conference
    dial-ins.
18. **Joining the two calendar populations.** EventKit and Suggestions events
    share no subject (§5.3).
19. **`ZFACECOUNT`, and scene labels joined to `ZASSET`.** See §7.2.
20. **Treating the owner as a contact.** Exclude the `nm_isCurrentUser` id from
    rankings.
21. **Reading the `-fullRebuild` copy.** It is staging.
22. **`name_of` picking the wrong `PS33`.** Some entities carry two. Order by
    confidence, then length.
23. **Assuming a fixed column list.** Read score columns off
    `pragma table_info(entity_tagging)` (the `DOUBLE` ones); read predicates off
    the store. Releases add and drop them.
24. **`observedAge` as years.** In `photosObservedAges` it is a small category
    code.
25. **Reading two live stores as one snapshot.** Each connection is consistent
    within its own file; two files read a second apart can disagree, and a
    re-run a minute later can differ.

---

## 9. The system around the graph

For questions about the machinery rather than the contents. Each answer states
what has been established and where it stops.

**Who builds it.** `knowledgeconstructiond`, working with `intelligenceplatformd`
(both have man pages: `man knowledgeconstructiond`, `man intelligenceplatformd`).
The pipeline runs about once a day on mains power, in per-source phases (Contacts,
Photos, Calendar, Suggestions, Intents, Family Sharing, apps, …). Some of its
inputs (per-source prior confidences, a relationship-word vocabulary, and whole
CoreML models) are declared as Trial factors that Apple can replace over the
network.

**What it is for.** Mostly entity resolution and relevance: deciding which
person, place or app an utterance means, and which is most relevant now. Apple
describes this design in its SIGMOD 2023 paper *Growing and Serving Large
Open-domain Knowledge Graphs* (arXiv 2305.09464): contacts, message senders and
calendar invitees linked into one Person.

**Who reads it.** Only Apple binaries holding private
`com.apple.private.intelligenceplatform.*` entitlements. Each one's signature
lists the views it may read. Siri inference (`siriinferenced`) has the widest
list, including the interaction log. The Apple Intelligence runtime
(`generativeexperiencesd`) has index-level read access to the graph layers
themselves. Spotlight's graph helper reads only the visual-identifier view,
Reminders only a language view. No third-party binary was found holding any of
these entitlements. That is a statement about the executables searched, which
did not include apps in `/Applications`. List them on this Mac with
`views.db`:

```sql
SELECT name, artifactType, artifactPath, artifactTable, writeToStream, target FROM viewConfigRecord ORDER BY name;
```

and for a binary: `codesign -d --entitlements - <path>`.

**Does it leave the Mac.** No evidence was found that personal graph content
syncs or uploads. `globalKnowledge.db`'s `live_graph` is a cache of entity
lookups answered off-device; where it has been found empty, that shows no
residue survived, not that nothing was ever sent. Two on-device outputs that would
carry facts about named people (a weekly accuracy statistic and a sampled
tagging record) were found written with no consumer identified. That is an
open negative, not a clean one. Whether Time Machine or other backups include
`~/Library/IntelligencePlatform` was not settled.

**Encryption.** No application-level encryption was found on these stores, and
no file-protection class is set on them. They are ordinary SQLite files, covered
by TCC and by whatever volume encryption the Mac has (FileVault, if it is on).

**Deletion.** Deleting a contact, event or photo removes the derived facts from
the live graph on a later run. The withdrawn rows sit in `expired_*` until the
prune window passes. Of the projections, the copies were found consistent; the
scorecard was not (§6.6). There is no user-facing control for any of this.

---

## 10. What is not here, and what is not understood yet

**Not in the graph:**

- **Message bodies.** The graph builder reads message text (into an on-device
  model prompt) but the ontology has no predicate to store it. It is not in the
  interaction log either. It is in `chat.db` for Messages only (§7.4).
- **Mail bodies.** Never enter the graph; the only mail-authored string the
  ontology can hold is a subject. Events and reservations that Siri Suggestions
  finds do enter, as `sgEvent` entities with their descriptions.
- **A history.** The graph is the current state plus a short withdrawal window.
  The interaction log covers a limited window.

**Present but not decoded:**

- The `data` BLOB in `histogram` (`behaviors.db`) and the `*Histograms` tables
  in `internal/views.db`: binary, encoding unknown. These are the per-person
  interaction histograms most of the scorecard's features come from. Read the
  event-log tables beside them instead (`*InteractionEvents`,
  `personInteractionMechanisms`, `photosObservedAges`), which are plain rows.
- `communicationMechanism` in `personInteractionMechanisms`: an integer code,
  mapping unestablished. `bundleID` beside it names the app.
- `wifiContextEvents`, `coarseGeoHashContextEvents`,
  `specificGeoHashContextEvents`, `loiContextEvents`: context streams
  (network, location at two resolutions, places of interest). What the
  `behaviorIdentifier` strings denote, and whether they are hashed, is not
  established.
- The `sources` bits beyond those in §4.5.
- The thresholds the tagger applies internally. The store applies none: the
  scores are raw.

If the owner asks about any of these, say what is present, what is not decoded,
and do not guess the rest.

---

## 11. Answering well

- **Say which layer an answer comes from.** "Your contact card for X says …"
  (copied, `sources` bit 0, confidence 1.0) is a different claim from "the
  scorecard gives X 0.62 on `familyAndFriends`" (inferred), and from "you
  exchanged N messages with X in the last year" (the interaction log).
- **Give the number and its scale.** A score without the baseline it should be
  read against (§6.6), a count without its denominator, and a top-10 without
  saying it is capped all mislead.
- **Say "the store says", not "Apple thinks".** The store holds scores and
  copies. Which of them any feature acts on is established for very few (§9).
- **Report absences as results.** "No face cluster is bound to X", "this column
  is 0 on every row" and "the log has no text" are answers.
- **Name unresolved entities by what they have.** An address, a handle, a face
  cluster, or "an unnamed person who attended 4 of your events".
- **Keep the tone plain.** Numbers over adjectives. The contents are specific
  enough without emphasis.
- **Point to the page.** If iKnow is running, the matching page in the tab
  opened from its link shows the same data with its denominators.

The modules in `api/` are the reference implementations for everything in this
file. Each one's docstring lists the traps it closes: `vocab.py` (decoding,
reification, sources), `identity.py` (every join in §7), `kinship.py`
(scorecard and evidence), `comms.py` (the interaction log), `calendar.py`,
`faces.py`, `certainty.py`, `retractions.py`, `device.py` and `exposure.py`.
