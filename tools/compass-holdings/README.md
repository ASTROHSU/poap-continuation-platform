# Compass Holdings snapshot

This operator tool captures the anonymously reachable POAP Holdings projection
from the public Compass GraphQL endpoint into a resumable SQLite database. It is
an additive preservation source, not a rewrite of the immutable POAP Archive
ZIP.

The capture is needed because the ZIP's `tokens` table has a latest
`minted_on` value of `2026-04-14T12:40:55Z`, even though its package metadata
was generated on 2026-07-02. The ZIP also omits tokens whose Drops are private
or hidden. Compass exposes those held token rows to exact owner queries.

## Capture contract

- freezes the maximum anonymous `poaps.id` before reading pages;
- splits that fixed ID space into persistent non-overlapping ranges;
- follows composite `(id, chain)` keyset pages of exactly 100 rows inside each
  frozen ID range;
- writes each page and its checkpoint in one local SQLite transaction;
- treats the initial aggregate count as evidence rather than a stop condition,
  and finishes a shard only after its exact cursor returns an empty page;
- records terminal empty-page hashes and repeats every shard aggregate after
  capture, rejecting any final count that differs from captured rows;
- transactionally resets and re-reads only mismatched ID ranges, preserving a
  reconciliation journal and refusing to finalize after repeated instability;
- resumes only when endpoint, snapshot ID, GraphQL schema, query, and shard
  count still match;
- stores the complete introspection response and exact GraphQL queries;
- validates every ID, owner address, page order, per-shard count, global count,
  and SQLite `quick_check`; and
- records the capture window because the public API does not expose a
  transactionally consistent database snapshot.

Compass does not expose POAP Archive's opaque `source_uid`, and `poaps.id` is
not globally unique across chains. The compatible `tokens` table therefore
uses the verified `(id, chain)` identity and documented deterministic
`compass-poap:<poap_id>:<chain>` source UID. Capture initialization requires
the global distinct `(id, chain)` count to equal the complete row count and
requires zero null chains.

## Run

Keep output under ignored local `data/`:

```sh
node tools/compass-holdings/cli.mjs snapshot \
  --snapshot-id compass-holdings-2026-07-28-v1 \
  --output data/compass-holdings/compass-holdings-2026-07-28-v1 \
  --concurrency 4 \
  --shards 16
```

Resume the exact initialized capture:

```sh
node tools/compass-holdings/cli.mjs snapshot \
  --snapshot-id compass-holdings-2026-07-28-v1 \
  --output data/compass-holdings/compass-holdings-2026-07-28-v1 \
  --concurrency 4 \
  --shards 16 \
  --resume
```

The endpoint currently caps a page at 100 rows even when a larger limit is
requested. A complete 7.7-million-row pass therefore needs roughly 77,000
requests. Keep concurrency conservative; retryable HTTP 429/5xx and network
timeouts use bounded exponential backoff.

After the Holdings pass completes, capture the complete metadata for every
distinct Drop ID actually referenced by those holdings:

```sh
node tools/compass-holdings/cli.mjs referenced-drops \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1
```

This bounded second pass preserves public, private, and hidden upstream
objects. It does not add private or hidden records to public Drop browsing:
their metadata is available only when an address proves it holds the Drop or
when somebody asks for that exact Drop ID. Personal exports retain the explicit
visibility state.
The companion capture is resumable with `--resume`.

## SQLite layout

`compass-holdings.sqlite` includes:

- `tokens`: POAP Archive-compatible holdings columns;
- `compass_token_metadata`: Compass-only `collected_at` plus page capture time;
- `capture_shards` and `capture_pages`: durable resume and response digests;
- `capture_terminal_pages` and `capture_final_counts`: explicit end-of-keyset
  evidence and post-capture aggregate reconciliation;
- `capture_meta`: endpoint, query/schema digests, fixed upper ID, and expected
  count; and
- `snapshot_metadata`: finalized portable identity and row counts.

`compass-referenced-drops.sqlite` includes:

- a POAP Archive-compatible `drops` table;
- `compass_drop_metadata`, retaining source media URLs, visibility fields,
  nested image/gateway data, and the complete raw Graph object;
- `requested_drops`, including explicit unresolved IDs; and
- `capture_batches`, with requested/captured counts, missing IDs, timestamps,
  and exact response hashes.

`referenced-drops-manifest.json` binds that companion database to the exact
Holdings database SHA-256. The build stages both databases as deterministic SQL
into a new snapshot-scoped Holdings D1; it never mutates the active historical
D1 in place.

The optional `holding_drop_artwork` D1 relation is an additive activation
ledger for verified originals discovered after the metadata snapshot. Each row
records the immutable R2 key, observed SHA-256, exact byte length, MIME type,
preserved source URL, and archive time. R2 objects must be uploaded and read
back with the same digest before the row is activated. Checked-in release
manifests under `artwork-releases/` make these incremental batches auditable;
they do not change the identity or contents of either source SQLite database.

## Archive every referenced original

The artwork workflow covers every Drop referenced by the Holdings snapshot
without duplicating media that has already been preserved:

1. freeze the active fixed-Archive artwork IDs from Catalog D1;
2. bind verified Collections publication proofs and checked-in Holdings seed
   releases;
3. download only the remaining canonical `assets.poap.xyz` originals into
   bounded temporary files, trying `drop_image.gateways[type=ORIGINAL]` from
   the bound raw metadata and the exact legacy
   `storage.googleapis.com/poapmedia/` object before the current `image_url`;
4. sniff the bytes independently of the filename, hash them, and conditionally
   upload a content-addressed R2 object through a temporary HMAC Worker, using
   authenticated 16 MiB multipart requests when an original exceeds the
   single-request ceiling;
5. require an authenticated exact R2 `HEAD` after every upload before recording
   success; and
6. generate an immutable coverage release plus bounded, idempotent D1 shards.

Capture is append-only and resumable. A completed temporary file is removed
after its remote proof is durable, so local disk usage is bounded by
concurrency rather than total archive size. An empty response, unsupported
bytes, policy response, or missing source remains an explicit failed record;
each attempted canonical source and failure reason remains in the checkpoint,
and finalization refuses to activate a partial release.

After retrying all failures, `review-unavailable` can bind only deterministic
empty, unsupported, access-denied, missing, or gone responses to the exact
checkpoint. Transient source, local-integrity, bridge, and R2 failures are
rejected and remain resumable work. The final coverage release counts these
source objects separately; it never describes an unavailable original as
archived.

Create the fixed Archive index and the immutable plan:

```sh
npm run holdings:artwork -- catalog-index \
  --output data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive/archive-artwork-index.json \
  --snapshot-id 2026-07-02-v1

npm run holdings:artwork -- plan \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1 \
  --archive-index data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive/archive-artwork-index.json \
  --collections data/collections/2026-07-22-v1
```

Deploy `artwork-bridge/wrangler.example.jsonc` under a temporary Worker name
and set `COLLECTIONS_R2_BRIDGE_SECRET` to an unpadded base64url-encoded 32-byte
secret both on that Worker and in the local capture process. The bridge has no
read-body, list, overwrite, or delete route and accepts only the active
Holdings content-addressed artwork prefix.

The same bridge accepts bounded multipart create, part, complete, and abort
operations for originals up to 5 GB. Every part body is covered by its own
HMAC-bound SHA-256, the client re-hashes the full sequence before completion,
and the bridge exposes no object-body read, list, overwrite, or delete route.

```sh
COLLECTIONS_R2_BRIDGE_SECRET=<operator-secret> \
  npm run holdings:artwork -- capture \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive \
  --bridge-url https://<temporary-worker>.workers.dev \
  --bucket poapin-archive \
  --archive-snapshot-id 2026-07-02-v1 \
  --concurrency 4
```

If and only if the final retry contains source objects that no approved origin
can return, preserve the exact terminal evidence:

```sh
npm run holdings:artwork -- review-unavailable \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive
```

After `capture-report.json` is complete, build the release and D1 shards, load
them, and delete the temporary bridge:

```sh
npm run holdings:artwork -- finalize \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive \
  --release-id compass-holdings-2026-07-28-v1-artwork-full

npm run holdings:artwork -- load-d1 \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/artwork-archive/d1-artwork
```

The loader re-reads every remote `holding_drop_artwork` row in bounded keyset
pages and compares every field to the immutable coverage release. A conflicting
pre-existing row is never overwritten and makes the final comparison fail.
Once that readback writes `d1-artwork/remote-report.json`, rerunning the
snapshot's private `upload-backup` command also stores the artwork coverage
release, D1 report, remote proof, and every SQL shard under the existing
content-addressed package prefix.

The private R2 backup stores both SQLite databases inside bounded, hashed
package parts so it remains compatible with Wrangler's 300 MiB per-object
upload limit. Every D1 SQL artifact is also stored as an individual object for
direct inspection and recovery without unpacking the SQLite sources.

## Build and load D1

Build deterministic Holdings SQL after the snapshot finishes:

```sh
node tools/compass-holdings/cli.mjs build-d1 \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1
```

The generated `d1/` directory contains the canonical Holdings migrations,
bounded SQL shards, a final metadata marker, and `report.json` with SHA-256
digests for every artifact. Token inserts also populate
`drop_collector_refs` through the canonical D1 trigger.

Rebuild every SQL shard into a disposable local D1-shaped SQLite before remote
import:

```sh
node tools/compass-holdings/cli.mjs verify-local \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/d1 \
  --output data/compass-holdings/compass-holdings-2026-07-28-v1-local-d1.sqlite
```

This checks exact token, owner, Drop collector reference, referenced Drop, and
import-journal counts plus SQLite integrity, and records the reconstructed
database size and digest in a sidecar report.

Load only into a new snapshot-scoped D1 database:

```sh
node tools/compass-holdings/d1-loader.mjs preflight \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/d1 \
  --database-name <name> \
  --database-id <uuid>

node tools/compass-holdings/d1-loader.mjs load \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/d1 \
  --database-name <name> \
  --database-id <uuid>

node tools/compass-holdings/d1-loader.mjs verify \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/d1 \
  --database-name <name> \
  --database-id <uuid>

node tools/compass-holdings/d1-loader.mjs activate \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1/d1 \
  --database-name <name> \
  --database-id <uuid>
```

The loader uses a temporary Wrangler binding, verifies the exact D1
name/UUID, resumes only from transaction-bound `import_shards` markers, and
writes `archive_meta` last. It never points the deployed Worker at the staging
database.

## Preserve the SQLite and SQL

Package the complete source snapshot and generated D1 SQL together:

```sh
node tools/compass-holdings/cli.mjs package \
  --input data/compass-holdings/compass-holdings-2026-07-28-v1
```

The package command rechecks both source SQLite databases and every D1
artifact, writes a per-file `package-manifest.json`, creates a compressed
archive, and splits it into upload-safe parts. Its sidecar report records the
archive digest, every part digest, and a content-addressed private R2 prefix.
Restore by concatenating parts in path order, verifying the archive SHA-256,
extracting it, and then verifying the package file inventory.

Upload both the package parts and directly reusable D1 SQL to a private R2
bucket:

```sh
node tools/compass-holdings/cli.mjs upload-backup \
  --report data/compass-holdings/compass-holdings-2026-07-28-v1.tar.gz.report.json \
  --bucket poapin-holdings-backups \
  --verify-downloads
```

Keys are nested under the snapshot ID and archive SHA-256. The uploader keeps a
local resumable checkpoint, uploads each SQL artifact alongside the bounded
compressed parts, and can download and hash every object before publishing its
final upload report. The SQLite databases are recovered from the package parts.
