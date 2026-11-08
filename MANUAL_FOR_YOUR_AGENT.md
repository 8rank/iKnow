# Manual for your agent

For an AI agent with a shell on a Mac whose owner asks about the knowledge graph
macOS keeps on them. Do §0 first, then read §1 and §8 before running anything.
The schemas are Apple's and change between releases (this was checked on macOS
26): confirm tables and columns with `.schema`. Every id, name and handle here
is a placeholder.

---

## 0. Stop and ask first

**Mandatory, before anything else.**

What you read from these stores enters your context and goes to whoever runs
your model. The stores hold the owner's relationships, contacts,
correspondents, calendar and photos, plus scored guesses about people who never
agreed to any of it. Whether your provider may see that is the owner's call,
made before you read a row.

First tell the owner: (1) which model and provider you are, as far as you
actually know, and if you don't know, say so; (2) that what you read goes to
that provider and may be logged or kept under terms you cannot inspect or
enforce; (3) what their question will make you read: names, phone numbers, mail
addresses, relationship scores, who they talk to and when, calendar entries,
possibly message text.

**Then ask this, word for word, and wait for the answer:**

> Are you running a trusted LLM provider that you are sure will not abuse the
> knowledge of your local knowledge graph? (yes / no)

- **Ask even if the request already sounds like consent.** The answer must come
  in reply to the question.
- **Until the answer is yes, read nothing**: no `sqlite3`, no Python against the
  stores, no iKnow API call, not even the §2.1 check.
- **Only an explicit yes counts**: "yes", "sure" or "go ahead" in reply. Silence,
  a new question or "I think so" is not one: ask again or stop.
- **On no, stop.** Offer iKnow in the browser (`python3 server.py`, then the
  link it prints), which sends nothing off the machine, or this manual with a
  local model.
- **Ask once per session**, and again if the owner changes model or provider.

---

## 1. Rules

1. **Read-only.** Open every database as `file:…?mode=ro`:
   `sqlite3 "file:$HOME/Library/IntelligencePlatform/graph.db?mode=ro"`. Never
   write (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `VACUUM`,
   `PRAGMA wal_checkpoint`, `PRAGMA journal_mode`); daemons write to these
   files while you read.
2. **`ATTACH` with a `mode=ro` URI**: `ATTACH 'file:/path/x.db?mode=ro' AS x`. A
   plain path opens read-write even from a read-only handle.
3. **No `immutable=1`.** It skips the write-ahead log, which holds the newest
   facts. If a read fails, report it.
4. **Copy nothing to disk**, and put no row values in files, commits, issues or
   web requests. Answers go to the owner, in the conversation.
5. **Read as little as the question needs.** Prefer counts and filtered rows;
   ask before pulling whole tables of names, handles or message text.
6. **Other people are in here.** Answer what the owner asks; don't volunteer
   profiles of anyone else.
7. **Measure, don't repeat.** Where this manual gives a test, run it rather
   than trusting the value written here.

---

## 2. Access

### 2.1 Full Disk Access

TCC protects the stores. Add the app running your shell (Terminal, iTerm,
VS Code, the Claude desktop app, …) under System Settings → Privacy & Security
→ Full Disk Access, then quit and reopen it. Without it, opening fails with
`unable to open database file`: a permission problem, not a missing file. A
sandboxed agent also needs read access to `~/Library/IntelligencePlatform`,
`~/Library/Messages`, `~/Library/Group Containers/group.com.apple.calendar`,
`~/Library/Application Support/AddressBook` and `~/Pictures`.

```sh
sqlite3 "file:$HOME/Library/IntelligencePlatform/graph.db?mode=ro" \
  "select count(*) from stable_graph" && echo readable
```

### 2.2 Where everything is

| What | Path |
|---|---|
| Graph and its projections | `~/Library/IntelligencePlatform/` |
| Ontology (SQLite) | `~/Library/IntelligencePlatform/ontology.db` |
| Ontology (JSON) | `Resources/` in `IntelligencePlatformCore.framework`, under `/System/Library/PrivateFrameworks/` |
| Messages | `~/Library/Messages/chat.db` |
| Calendar | `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` |
| Contacts (one per account) | `~/Library/Application Support/AddressBook/Sources/<source>/AddressBook-v22.abcddb` |
| Photos | `~/Pictures/<library>.photoslibrary/database/Photos.sqlite` |

### 2.3 Opening stores

Start `sqlite3` from `~/Library/IntelligencePlatform`: the recipes use relative
`file:` paths, and SQL doesn't expand `~`. Bind `:id` with
`.param set :id <entity id>`.

```sh
cd ~/Library/IntelligencePlatform
sqlite3 -header -column "file:graph.db?mode=ro"
```

In Python, keep the `text_factory` line; some columns are not valid UTF-8:

```python
import sqlite3, os
def ro(path):
    c = sqlite3.connect(f"file:{os.path.expanduser(path)}?mode=ro", uri=True)
    c.text_factory = lambda b: b.decode("utf-8", "replace")
    c.row_factory = sqlite3.Row
    return c
```

### 2.4 iKnow shortcuts

With this repository on `sys.path`, `from api import db, vocab` (standard
library, no server) gives `db.query("graph/graph.db", sql)`, `vocab.owner_id()`,
`vocab.name_of(eid)`, `vocab.statements("stable_graph", subject=eid)` (facets
collapsed into statements), `vocab.plabel` / `vocab.clabel` (decode codes),
`vocab.source_names(mask)` and `db.apple_time(v)`. Nested stores are named with
`__` for `/` (`graph/Artifacts__siri__remembers__view.db`); `sources/chat.db`,
`sources/Calendar.sqlitedb` and `sources/Photos.sqlite` find the source stores.

If the owner runs `python3 server.py`, each page's JSON is at
`http://127.0.0.1:8765/api/<page>` (`overview`, `identity`, `person?id=`,
`kinship`, `comms`, `calendar`, `social`, `faces`, `certainty`, `retractions`,
`device`, `exposure`). Send the token from the link the server printed
(`-H "Authorization: Bearer $TOKEN"`); ask the owner for it, since it changes
each start. A `401` means a restart. Add `redact=1` to replace names, phone
numbers and addresses with numbered stand-ins when the owner will share your
output.

---

## 3. The stores

Under `~/Library/IntelligencePlatform`. Ignore `-fullRebuild.db` staging copies.

| File | Tables | What |
|---|---|---|
| `graph.db` | `stable_graph`, `event_graph`, `expired_*`, `graph_state` | **The graph**: people, organisations, places, apps, groups; calendar events; withdrawn rows |
| `ontology.db` | `class`, `predicate` | decodes every code |
| `Artifacts/entityTagging/entityTagging.db` | `entity_tagging` | **the relationship scorecard** (§6.6) |
| `Artifacts/siri/remembers/view.db` | `interactions`, `entities`, `interactionEntities` | **the interaction log**: messages and calls as metadata, no text (§6.8) |
| `Artifacts/internal/views.db` | `handle_id`, `phperson_id_map`, `entity_alias`, `people_relationship`, … | identity maps, aliases, behavioural event streams |
| `entityRelevanceInferences.db` in `Artifacts/entityRelevance/` | `person_entity_relevance`, … | relevance rankings (§6.10) |
| `entityImportanceSignals.db`, same directory | `entityImportanceSignalsIDMap` | favourite, emergency-contact and iCloud-family flags (§6.7) |
| `Artifacts/feature/features.db` | `kv` | inputs to the scorecard and rankings (§6.13) |
| `views.db` | `viewConfigRecord`, `viewState` | which views exist, what they read, when they ran |
| `globalKnowledge.db` | `static_graph`, `live_graph` | **not personal**: Apple reference knowledge, and a cache of off-device lookups |
| `behaviors.db` | `histogram`, … | behavioural histograms (apps, locations, Wi-Fi, focus); relation to the graph not established |

The other `Artifacts/` stores are mostly per-consumer copies of graph rows.

---

## 4. The triple store

### 4.1 Schema

`stable_graph`, `event_graph` and their `expired_` twins share these columns:

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
```

### 4.2 Layers

`stable_graph`: people, organisations, places, groups, apps, the owner.
`event_graph`: calendar events and reservations. `expired_*`: withdrawn rows,
kept with their confidence, sources and timestamp until
`graph_state.expiredTriplesPruneTimestamp` (§6.12).

### 4.3 Reification

A row with `relationshipId = 0` and `relationshipPredicate = ''` is a plain
attribute. Otherwise it is **one facet of a statement**: facets share
`subject`, `predicate` and `relationshipId`, and each carries one
`relationshipPredicate` and its value. A phone number is a `PS520` statement
with facets `PS1` = `CS97` (its type), `PS407` = the number and `PS740` = the
label. Group by `relationshipId` and pivot on `relationshipPredicate` into
lists, since facets repeat (one `PS566` per group member). Counting rows counts
facets, not facts.

### 4.4 Ids and object values

- Entity ids are signed 64-bit and exceed 2^53. Keep them as strings wherever
  JavaScript or floats touch them.
- A reference is the text `md:<id>`; follow it with
  `CAST(substr(object, 4) AS INTEGER)`. A bare integer is never a reference.
- Namespaces are recognised by an allowlist of heads, never by splitting on `:`.

| Head | Points at | Resolvable? |
|---|---|---|
| `md:` | another entity in this graph | yes |
| `cnContact:` | a Contacts record: `<UUID>:ABPerson` | yes, verbatim (§7.1) |
| `phPerson:` | a Photos person cluster: `<ZPERSONUUID>/L0/<nnn>` | yes (§7.2) |
| `ekEvent:` | an EventKit event: base64 SHA-256 of `<store persistent_id>:<item unique_identifier>` | yes, by hashing (§7.3) |
| `lsBundleRecord:` | an installed app: base64 SHA-256 of the bundle id | yes, by hashing |
| `sgEvent:`, `sgContact:` | Siri Suggestions events and contacts found in mail and messages | no |
| `inPerson:` | an Intents person | no |
| `faFamilyCircle:` | a Family Sharing circle | no, but equal tokens mean the same circle |
| `tel:`, `mailto:`, `http:`, `https:` | URIs | n/a |

`PS407` and `PS406` facets also hold phone numbers and mail addresses as
literals. The hashed namespaces are unsalted, so pseudonymous, not anonymous.
Dates in objects are JSON (`NSDateComponents`: `year`, `month`, `day`, `hour`,
`minute`, `timeZone.identifier`, …); read them with `json_extract`. All-day
entries have no `hour`. `nm_imputed*` facets are Apple time as text.

### 4.5 Provenance

- **`confidence`** mostly tracks which ingest wrote the row (Contacts 1.0,
  Photos 0.9, most others 0.7–0.8 on the store checked), not certainty. A 0.8
  may mean "written by a 0.8 source".
- **`sources`** is a bitmask: test `sources & (1<<n)`, never `GROUP BY sources`.
  This mapping was derived empirically:

  | bit | ingest |
  |---|---|
  | 0 | Contacts |
  | 1 | Intents (INPerson) |
  | 5 | Photos face clusters |
  | 8 | Calendar (EventKit) |
  | 10 | Suggestions contacts |
  | 11 | Suggestions events |
  | 13 | Family Sharing |
  | 15 | App catalogue |

- **`sourceDuplicates`** lists the source records behind a row, separated by
  `char(30)`: the most direct answer to "where did this come from".
- `nm_associationReason` (on face bindings) holds owner-asserted and
  model-derived reasons in one enum. On aliases, `nm_signalLabel`
  `*_provided_alias` came from a record and `derived_alias` was generated.

### 4.6 Time

Most timestamps are Apple seconds since 2001:
`datetime(x + 978307200, 'unixepoch', 'localtime')`. `chat.db` `message.date`
is in nanoseconds (divide by 1e9 first); event dates are JSON (§4.4).
`timestamp` is when the graph wrote the row, not when the thing happened.

---

## 5. Vocabulary

`SB`, `CS` and `PS` codes are the ontology's classes, statement types and
predicates; `nm_` codes are Apple's local extension. Decode them with
`ontology.db`:

```sql
ATTACH 'file:ontology.db?mode=ro' AS o;
SELECT g.predicate, p.label, count(*) n
FROM stable_graph g LEFT JOIN o.predicate p ON p.id = g.predicate
GROUP BY 1 ORDER BY n DESC;
```

Classes: `SB104` person · `SB10` organization · `SB152` place · `SB2` group of
humans · `SB144` software · `SB472` calendar event.

| Code | Meaning and facets |
|---|---|
| `PS1` | is a (class code) |
| `PS33` · `PS312` · `PS546` · `PS441` | name · first · middle · family name |
| `nm_isCurrentUser` | the owner (exactly one entity) |
| `PS102` | same as: a namespaced reference elsewhere |
| `PS520` | contact info: `PS407` phone, `PS406` email, `PS740` label |
| `nm_entityAliasRelationship` | alias: `PS89` text, `nm_signalLabel`, `nm_confirmationConfidence` |
| `nm_hasVisualIdentifier` | face: `nm_visualIdentifier` (Photos cluster), `nm_associationReason` |
| `PS500` | employer: `PS45` → `md:` organisation, `PS548` department |
| `PS753` | group: `PS566` → `md:` member (repeats) |
| `PS317` | address: `PS316` street, `PS453` city, `PS315` postcode, `PS450` country |
| `PS225` | location: `PS107` → `md:` place |
| `nm_bundleID` · `PS194` | app bundle id · published by |
| `PS33` · `PS51` (events) | title · **the full description, verbatim**, often written by someone else |
| `nm_hasDate` (events) | `PS29` start, `PS30` end |
| `PS232` · `PS578` (events) | attendee · organizer: `PS143` → `md:` person |
| `nm_virtualConferenceURL` (events) | join links and dial-ins (`tel:` here is not a person) |

Events come from EventKit (`sources` bit 8: attendees, no descriptions) and
Suggestions (bit 11: descriptions and reservations from mail, no attendees).
They share no subject; don't join them.

---

## 6. Recipes

Against `graph.db` unless stated otherwise.

### 6.1 The owner

```sql
SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser';
```

Exclude this id from every "top people" ranking.

### 6.2 Find a person

```sql
SELECT DISTINCT subject, predicate, relationshipPredicate, object
FROM stable_graph
WHERE (predicate IN ('PS33','PS312','PS441','PS546')
       OR (predicate = 'nm_entityAliasRelationship' AND relationshipPredicate = 'PS89'))
  AND object LIKE '%' || :name || '%';
```

By handle: the `PS407` / `PS406` facets of `PS520` (compare phone numbers by
their last 9 digits), or `SELECT id FROM handle_id WHERE handle = :handle` in
`internal/views.db`. Many entities have no name; label them by their handle and
never invent one.

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

The same id keys `entity_tagging`, `entityImportanceSignalsIDMap`,
`person_entity_relevance`, `handle_id` and `phperson_id_map`.

### 6.4 Contact info and employer

```sql
SELECT relationshipId,
  max(CASE WHEN relationshipPredicate = 'PS407' THEN object END) AS phone,
  max(CASE WHEN relationshipPredicate = 'PS406' THEN object END) AS email,
  max(CASE WHEN relationshipPredicate = 'PS740' THEN object END) AS label,
  max(sources) AS sources
FROM stable_graph WHERE predicate = 'PS520' AND subject = :id
GROUP BY relationshipId;

SELECT e.subject AS person, org.object AS organisation, dep.object AS department, e.confidence
FROM stable_graph e
JOIN stable_graph org ON org.subject = CAST(substr(e.object, 4) AS INTEGER) AND org.predicate = 'PS33'
LEFT JOIN stable_graph dep ON dep.subject = e.subject AND dep.relationshipId = e.relationshipId
                          AND dep.relationshipPredicate = 'PS548'
WHERE e.predicate = 'PS500' AND e.relationshipPredicate = 'PS45' AND e.subject = :id;
```

Strip the `_$!<…>!$_` markers from `PS740` labels for display. The face cluster
is the `nm_visualIdentifier` facet of `nm_hasVisualIdentifier` (§7.2).

### 6.5 Addresses

```sql
SELECT subject, relationshipId,
  max(CASE WHEN relationshipPredicate = 'PS316' THEN object END) AS street,
  max(CASE WHEN relationshipPredicate = 'PS453' THEN object END) AS city,
  max(CASE WHEN relationshipPredicate = 'PS315' THEN object END) AS postcode,
  max(CASE WHEN relationshipPredicate = 'PS450' THEN object END) AS country
FROM stable_graph WHERE predicate = 'PS317'
GROUP BY subject, relationshipId;
```

An address on a person was usually copied from their contact card. Check the
subject's class (`PS1`) before saying "X lives at".

### 6.6 The relationship scorecard

`Artifacts/entityTagging/entityTagging.db`. `mdid` is the entity id as TEXT.

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

- The scores are inferred. Most columns are sparse, with a few quantised values
  (0.125, 0.25, 0.5); `family` and `familyAndFriends` are not. How they are
  computed is not documented.
- Scores cluster high, and organisations can score as family. Compare a score
  with the rest of the table, not with 0.5, and check the evidence (§6.13).
- The table has no timestamp and can keep scoring entities the live graph has
  dropped. Check that `mdid` still has rows in `stable_graph`.
- Nothing documented reads these scores. Don't say the scorecard "decides"
  anything.

### 6.7 Family signals

```sql
-- in Artifacts/entityRelevance: entityImportanceSignals.db
SELECT entityIdentifier, isFavorite, isEmergencyContact, isICloudFamily, relationshipLabel
FROM entityImportanceSignalsIDMap
WHERE isFavorite OR isEmergencyContact OR isICloudFamily OR coalesce(relationshipLabel, '') <> '';
```

Entities sharing the owner's `faFamilyCircle:` token are in their Family
Sharing circle; a `PS753` group with `sources` bit 13 is the Family Sharing
group. These, and the relations the owner typed in Contacts (§7.1), are
declared; the scorecard is inferred. They can disagree: report them side by
side and say which is which.

### 6.8 Communication

`Artifacts/siri/remembers/view.db`. `interactions` has a row per message or
call (`domain`, `bundleId`, `direction`, `handlingStatus`, `startDate`,
`durationSeconds`, `contentHash`, `isLocal`, `remoteDeviceId`). `entities`
holds the counterparts (`type` `Person`, `PersonHandle` or `MessageGroup`; `id`
is the handle; `fields` JSON has `name`). `interactionEntities (interactionRowid,
entityRowid, parameter)` links them, with roles such as `sender` and
`recipients`.

Establish what `direction` means on this Mac first; don't assume Apple's
public enum. Only incoming interactions have a `sender`:

```sql
SELECT i.direction, count(*) n,
  sum(EXISTS(SELECT 1 FROM interactionEntities ie WHERE ie.interactionRowid = i.rowid AND ie.parameter = 'sender')) AS with_sender
FROM interactions i GROUP BY 1;
```

The same way, the `handlingStatus` of `Calls` rows with `durationSeconds > 0`
is the connected-call status. Top counterparts:

```sql
ATTACH 'file:Artifacts/internal/views.db?mode=ro' AS iv;

SELECT h.id AS entity, count(DISTINCT i.rowid) AS interactions,
       sum(i.domain = 'Calls') AS calls, sum(i.domain = 'Messages') AS messages,
       datetime(min(i.startDate) + 978307200, 'unixepoch', 'localtime') AS first,
       datetime(max(i.startDate) + 978307200, 'unixepoch', 'localtime') AS last
FROM entities e
JOIN iv.handle_id h ON h.handle = e.id
JOIN interactionEntities ie ON ie.entityRowid = e.rowid
JOIN interactions i ON i.rowid = ie.interactionRowid
WHERE e.type = 'PersonHandle'
GROUP BY h.id ORDER BY interactions DESC LIMIT 25;
```

When you answer, say that the log covers a limited window (measure it) and
holds metadata only, no message text. `contentHash` is a thread key: it counts
conversations, not messages. `handle_id` is many-to-many. Rows with
`isLocal = 0` came from another of the owner's devices; count them before
saying "on this Mac".

### 6.9 Calendar

```sql
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

-- the people the owner shares the most events with
SELECT CAST(substr(object, 4) AS INTEGER) AS person, count(DISTINCT subject) AS events
FROM event_graph
WHERE predicate = 'PS232' AND relationshipPredicate = 'PS143'
  AND object <> 'md:' || (SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser')
GROUP BY 1 ORDER BY events DESC LIMIT 25;
```

Each date is wall-clock time in its own `tz`. Most attendees are only the
address they were invited at. Quote descriptions only as far as the question
needs. The graph holds part of the calendar; `Calendar.sqlitedb` has all of it
(§7.3).

### 6.10 Relevance

```sql
-- in Artifacts/entityRelevance: entityRelevanceInferences.db
SELECT mdid, round(relevanceScore, 4) AS score,
       json_extract(explanation, '$.positiveContributions') AS pushed_up,
       json_extract(explanation, '$.negativeContributions') AS pushed_down
FROM person_entity_relevance ORDER BY relevanceScore DESC LIMIT 20;
```

`person_entity_longterm` is the long-horizon version; `loi_entity_relevance`
ranks places. Its inputs include time, place and Wi-Fi context. The
explanation JSON is Apple's own attribution: quote it, don't invent reasons.

### 6.11 Installed apps

```sql
SELECT subject, object AS bundle_id,
       datetime(timestamp + 978307200, 'unixepoch') AS first_asserted
FROM stable_graph WHERE predicate = 'nm_bundleID';
```

`first_asserted` is when the graph wrote the row, not an install date.

### 6.12 Withdrawn facts

```sql
SELECT fate, count(*) FROM (
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject AND l.predicate = e.predicate
                 AND l.relationshipPredicate = e.relationshipPredicate AND l.object = e.object) THEN 'reasserted'
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject AND l.predicate = e.predicate) THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM stable_graph l WHERE l.subject = e.subject) THEN 'withdrawn'
    ELSE 'entity gone' END AS fate
  FROM expired_stable_graph e) GROUP BY fate;
```

Repeat for the event layer. Many expired rows are rewrites, not deletions. The
archive reaches back only to `expiredTriplesPruneTimestamp` in `graph_state`
(48 hours where measured), so it shows recent change, not a history.

### 6.13 The evidence behind a score

`Artifacts/feature/features.db`, table `kv (viewName, featureName,
subidentifierName, value)`; per-person rows have
`subidentifierName = 'md:<id>'`. View `personEntityTaggingFacts` holds facts
the tagger evaluated (`sameLastName`, `iCloudFamilyMember`, `photosPersonAge`,
…); `personEntityTagging` and `photosPersonEntityTagging` hold the behavioural
profile. `value` is an `NSKeyedArchiver` plist:

```python
import plistlib
def feature(blob):
    objs = plistlib.loads(blob)["$objects"]
    top = objs[1]
    deref = lambda u: objs[u.data] if isinstance(u, plistlib.UID) else u
    return deref(top.get("type")), deref(top.get("value"))
```

A row means the question was asked, not that the answer was yes. Count true
values.

---

## 7. The source stores

Open these `mode=ro` too.

### 7.1 Contacts

Drop the head from `cnContact:<UUID>:ABPerson` and the rest matches
`ZABCDRECORD.ZUNIQUEID` verbatim, suffix included; a few match `ZLINKID`.
Search every account's `AddressBook-v22.abcddb`.

```sql
SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDRECORD WHERE ZUNIQUEID = :cn OR ZLINKID = :cn;
SELECT ZNAME, ZLABEL FROM ZABCDRELATEDNAME WHERE ZOWNER = :pk;  -- relations the owner typed
```

`ZABCDRELATEDNAME` is what the owner declared ("mother", "partner"); put it
beside the scorecard. Phones, mail and postal addresses are in
`ZABCDPHONENUMBER`, `ZABCDEMAILADDRESS` and `ZABCDPOSTALADDRESS`, by `ZOWNER`.

### 7.2 Photos

The part of `nm_visualIdentifier` (`<ZPERSONUUID>/L0/<nnn>`) before the first
`/` is `ZPERSON.ZPERSONUUID`, in plaintext.

```sql
SELECT Z_PK, ZFULLNAME, ZDISPLAYNAME FROM ZPERSON WHERE ZPERSONUUID = :uuid;

SELECT a.ZUUID, datetime(a.ZDATECREATED + 978307200, 'unixepoch', 'localtime') AS taken
FROM ZDETECTEDFACE f JOIN ZASSET a ON a.Z_PK = f.ZASSETFORFACE
WHERE f.ZPERSONFORFACE = :person_pk AND a.ZTRASHEDSTATE = 0
ORDER BY a.ZDATECREATED DESC;
```

Size a cluster by counting `ZDETECTEDFACE` rows; `ZFACECOUNT` is a stale cache.
Scene labels join through `ZMEDIAANALYSISASSETATTRIBUTES`, not `ZASSET`. The
soft-biometric face codes have no label table: report coverage only. A latitude
or longitude of `-180.0` means no location.

### 7.3 Calendar

SQLite has no SHA-256, so build the `ekEvent:` lookup in Python (padding kept):

```python
import base64, hashlib
rows = cal.execute("""
  SELECT ci.ROWID, s.persistent_id || ':' || ci.unique_identifier
  FROM CalendarItem ci JOIN Calendar c ON c.ROWID = ci.calendar_id JOIN Store s ON s.ROWID = c.store_id
  WHERE ci.unique_identifier IS NOT NULL AND s.persistent_id IS NOT NULL""")
by_token = {"ekEvent:" + base64.b64encode(hashlib.sha256(p.encode()).digest()).decode(): rid
            for rid, p in rows}
```

`CalendarItem` has `summary`, `description`, `start_date`, `end_date` and
`location_id`; `Participant` has `email`, `role` and `status`. `sgEvent:` tokens
have no known local preimage.

### 7.4 Messages

No graph row points at a message. Join by **handle**, which reaches a whole
thread.

```sql
-- chat.db
SELECT h.ROWID, h.id, h.service FROM handle h WHERE lower(h.id) = lower(:handle);

SELECT datetime(m.date / 1e9 + 978307200, 'unixepoch', 'localtime') AS at,
       m.is_from_me, m.text, length(m.attributedBody) AS rich_bytes
FROM message m WHERE m.handle_id = :handle_rowid
ORDER BY m.date DESC LIMIT 50;
```

On current macOS the body is often only in `attributedBody`, as a UTF-8 run
after the `NSString` marker. `chat.db` holds only Messages; other messengers
appear only as metadata in the interaction log. This is the most sensitive
join here: read message text only when the owner asks for it.

---

## 8. Traps

Each gives a wrong answer without an error.

1. Plain `ATTACH` is read-write, and `immutable=1` hides the newest facts (§1).
2. Splitting on `:` to find a namespace (§4.4).
3. Counting rows instead of statements (§4.3).
4. `GROUP BY sources` (a bitmask), and splitting `sourceDuplicates` on commas
   (§4.5).
5. Casting a date object to a number: it is JSON, and every event lands on
   2001-01-01.
6. Reading `timestamp` as the event time (§4.6), or `0.0` as a date (it means
   "never"; filter `> 0`).
7. Entity ids through JavaScript or a float (§4.4).
8. Joining `mdid` (TEXT) without `CAST(mdid AS INTEGER)`.
9. Stripping `:ABPerson` from Contacts ids (§7.1) or `=` padding from tokens.
10. Trusting `direction` or `handlingStatus` to Apple's public enums, or
    `contentHash` as a message id (§6.8).
11. An event-layer `tel:` as a person's number; joining EventKit and
    Suggestions events (§5).
12. `ZFACECOUNT`, and scene labels joined to `ZASSET` (§7.2).
13. The owner in a ranking of contacts.
14. Reading a `-fullRebuild` staging copy.
15. Picking any `PS33`: some entities have two; order by confidence, then
    length.
16. A fixed column list: read score columns from
    `pragma table_info(entity_tagging)`. Releases change them.
17. Two live stores read a second apart are not one snapshot.

---

## 9. The system around the graph

Say what is established and where it stops.

- **Builder**: `knowledgeconstructiond` with `intelligenceplatformd` (both have
  man pages), about once a day on mains power, in per-source phases.
- **Purpose**: mostly entity resolution and relevance, deciding which person,
  place or app an utterance means. Apple describes the design in *Growing and
  Serving Large Open-domain Knowledge Graphs* (SIGMOD 2023, arXiv 2305.09464).
- **Readers**: programs with private `com.apple.private.intelligenceplatform.*`
  entitlements, each listing the views it may read
  (`codesign -d --entitlements - <path>`). Siri inference (`siriinferenced`)
  has the widest list; the Apple Intelligence runtime
  (`generativeexperiencesd`) can read the graph layers. No third-party program
  was found with them, but apps in `/Applications` were not checked.
  `viewConfigRecord` in `views.db` lists the views.
- **Leaving the Mac**: no evidence was found that graph content syncs or
  uploads, which is an open negative, not a clean one. `globalKnowledge.db`'s
  `live_graph` caches lookups answered off-device. Whether backups include the
  graph was not settled.
- **Encryption**: none found beyond TCC and volume encryption (FileVault).
- **Deletion**: removing a contact, event or photo removes the derived facts on
  a later run; the scorecard can lag (§6.6). There is no user-facing control.

---

## 10. Not here, not understood

- Message and mail bodies are not in the graph; message text is only in
  `chat.db`. Events found in mail do enter, as `sgEvent` entities. There is no
  history beyond a short withdrawal window.
- Not decoded: the histogram BLOBs in `behaviors.db` and `internal/views.db`,
  `communicationMechanism` codes, what `*ContextEvents` identifiers denote,
  `sources` bits beyond §4.5, and the tagger's internal thresholds. Say so;
  don't guess.

---

## 11. Answering well

- Say which layer an answer comes from: a contact card (copied, bit 0), the
  scorecard (inferred) or the interaction log.
- Give the scale: denominators, the rest of the table for a score, and whether
  a list is capped.
- Say "the store says", not "Apple thinks".
- Report absences as results: "no face cluster is bound to X".
- Name unresolved entities by what they have: a handle, an address, "an unnamed
  person at 4 of your events".
- Keep the tone plain: numbers over adjectives.
- If iKnow is running, point to the matching page. The `api/` modules are the
  reference implementations; their docstrings list the traps they close.
