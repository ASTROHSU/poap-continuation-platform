# Architecture

POAPin Archive is a read-heavy, snapshot-based application. Its architecture is
optimized for bounded work per request, independently replaceable data, and a
service that remains understandable to future maintainers.

## Request path

1. Cloudflare serves the Vite-built React application as static Worker assets.
2. The browser requests a public `/api/*` resource from the Hono Worker.
3. An eligible, snapshot-versioned response may be served from edge cache.
4. On a miss, the Worker validates and bounds input, then queries the one D1
   binding responsible for that dataset or performs the narrowly scoped
   server-side ENS lookup.
5. Artwork is addressed by immutable R2-backed URLs and is not transformed in
   the request.
6. The Worker returns explicit cache, content-type, and security headers.

The UI never needs direct D1 or R2 credentials.

## Components and boundaries

### React and Vite

The client is responsible for navigation, progressive rendering, and exposing
bounded server-side export controls. It must remain usable without wallet
extensions. Static assets should be content-hashed and cached immutably.

Complete personal sites are also a client responsibility. The browser validates
one combined export manifest, follows snapshot-bound pages, paces requests,
builds the relative static files, hashes them, and creates the ZIP. The
ZIP compressor runs in one same-origin module Worker, accepts one file at a
time, and streams transferable output chunks back to the page. Cancellation
terminates that Worker; an idle watchdog and sequential yielding fallback keep
compression failures from becoming permanently pending exports. The CSP does
not permit `blob:` Workers. The
generated site loads a compact local runtime index through a classic script;
each hash-routed tab then loads Base64URL-wrapped JSON payloads on demand and
verifies their byte length and SHA-256 digest before parsing them. This transport
works both from `file://` and an HTTP static origin without duplicating the data.
Remote media elements are created only after an explicit click.

### Hono Worker

The API boundary owns validation, stable response shapes, cursor encoding, and
hard limits. Routes should issue a small, predictable number of indexed
queries. Expensive aggregation, fuzzy indexing, image processing, or whole-file
parsing belongs in the import pipeline.

The Worker does not assemble a complete personal export or ZIP. It exposes
small manifest, page, resolver, and profile responses that can be independently
cached and retried. This prevents one large address from becoming one large
Worker CPU, memory, or response-size event.

### ENS resolution

The primary homepage lookup and direct `/address/<name>` routes accept a
complete `0x` address or an ENS name. Direct addresses are normalized in the
client and require no RPC request. ENS names are normalized according to
ENSIP-15 and sent to
`GET /api/resolve-address?name=...`, where the Worker resolves them through the
Ethereum mainnet Universal Resolver.

`ETHEREUM_RPC_URL` is a server-side binding. The production default is
PublicNode's keyless public Ethereum endpoint, but the resolver can use any
HTTPS mainnet JSON-RPC endpoint. The browser receives only the normalized ENS
name and resolved address; it never receives the provider URL or credentials,
and the flow requires no wallet connection.

Viem's optional CCIP-Read fallback is disabled. This keeps a resolver-controlled
record from making the Worker fetch arbitrary offchain gateways or unbounded
responses. Names that require CCIP-Read therefore fail closed instead of
expanding the request's network and memory budget.

ENS records are mutable and therefore do not use an archive snapshot namespace.
A successful resolution is cached at the edge for seven days, while an expected
unresolved result is cached for five minutes. Validation failures and transient
RPC failures are not cached. The route shares the address lookup rate limiter
and performs no automatic upstream retries, keeping provider load and Worker
CPU bounded.

The keyless default avoids a provider credential but has no project-specific
service-level agreement. Operators can later switch `ETHEREUM_RPC_URL` to a
dedicated provider, including Cloudflare Ethereum Gateway, without changing the
public API or browser code.

### D1 catalog

`CATALOG_DB` contains snapshot metadata and event/drop records. Its query shapes
are browse, exact ID lookup, bounded filtering, full-text search, and
deterministic sorting. Counts and normalized search input should be produced
during import.

### D1 holdings

`HOLDINGS_DB` maps normalized addresses to token and drop identifiers. Separating
it from the catalog isolates a much larger relation, makes address export
traffic visible, and leaves room to shard or replace holdings storage without
rewriting catalog routes.

API responses may join the two datasets in application code only with bounded
ID lists. Never implement an unbounded request fan-out.

The single-record `GET /api/drops/:id` route is intentionally different from
browse and batch APIs. It first performs one primary-key Catalog lookup. A
public Catalog result returns immediately; a private or missing result performs
one primary-key lookup in the newer `collection_drop_cards` projection. Exact
lookup may return a private, non-hidden card with `isPrivate: true`, but hidden
records remain unavailable. Cache identity includes the Collections release.
No private Drop metadata is added to browse, search, batch export, collector
responses, or Collection projections.

`GET /api/drops/:id/collectors` is a bounded exact-ID view over the historical
Holdings snapshot. It first applies the same exact Drop availability gate, then
reads at most 49 rows from `drop_collector_refs`, a `WITHOUT ROWID` relation
clustered by `(drop_id, poap_id DESC, source_uid DESC,
owner_address_norm DESC)`. Each page performs bounded primary-key joins back to
`tokens` for preserved mint, network, and transfer facts. This avoids both an
unbounded request-time scan and the memory peak of building a wide secondary
index over the 6.2-million-row `tokens` table.

Fresh snapshot imports populate the relation incrementally through a token
insert trigger. Existing snapshots use a resumable owner-address range backfill;
the Worker is not activated until reference and token counts match and both
query-plan steps use clustered primary keys. Its keyset cursor is bound to the
Drop ID, page size, and snapshot. The response exposes the public holder address
and preserved token facts, but does not resolve ENS names or copy Drop metadata
into the collector payload. Snapshot-versioned pages are edge-cached for seven
days.

This endpoint is not cross-Drop address discovery and does not represent live
ownership. A known private, non-hidden Drop may use the same collector view,
while hidden or missing exact IDs remain unavailable.

The personal Holdings endpoint reads up to 480 tokens with an indexed keyset
query, then looks up complete public Drop details in `CATALOG_DB` in fixed
96-ID statements. Catalog misses are checked against the private,
non-hidden `collection_drop_cards` projection only for IDs already returned by
that exact address's Holdings page. Cursors are bound to the normalized
address, page size, snapshot, and personal-export scope; cache identity also
includes the Collections release. Each page strictly partitions its unique
token Drop references between complete available `drops` and ID-only
`unavailableDropIds`. A holder-proven private row carries `isPrivate: true`;
missing and hidden records retain the same opaque unavailable form.

After Moments and owned-Collection segments are collected, the browser resolves
their additional Drop references through `/api/drops/export/batch` in batches
of at most 96 submitted IDs. That endpoint applies the same public-detail versus
opaque-unavailable partition under the fixed Holdings/Catalog snapshot. It does
not gain private enrichment because those additional references are not proof
that the queried address held the Drop.

### D1 Collections

`COLLECTIONS_DB` preserves the independently captured POAP Compass Collections
view: collection profiles, URLs and UI settings, memberships, ordered sections,
artist and organization records, suggestions, referenced drop cards, and
Collection branding metadata. It deliberately has its own
`COLLECTIONS_SNAPSHOT_ID`; a new Collections capture must not force the much
larger fixed catalog and holdings snapshot to be rewritten.

Collection slugs are not unique. Public identity, cache keys, pagination, and
foreign relations use numeric `collection_id`. Lists and relation exports use
indexed keyset cursors with hard page limits. A collection export is a manifest
of bounded metadata, items, artist-drop, approved-suggestion, and drop-statistics
segments rather than a single unbounded Worker response. Drop-statistics pages
deduplicate all three public relation sources, expose only aggregate email-claim
counts, and fetch per-chain rows only after private and hidden drops are redacted.

Personal exports give Collections three non-interchangeable meanings:

- a **held-Drop Collection** contains at least one held Drop through a formal
  `collection_items` row;
- an **owned Collection** has an archived normalized `owner_address` equal to
  the requested address; and
- an **authored-Moment Collection** is linked by the public
  Moment-to-Collection projection.

These relationship scopes are independent of the Collection record's
`artist`, `organization`, or `user` type.

The browser fetches one profile for the union of these IDs plus Collection IDs
needed to explain separately tagged Moments, but preserves the three personal
relationships separately. A tag association is content context, not another
claim of authorship, membership, or ownership. Only owned Collections receive
every declared public export segment. Held-Drop resolution deliberately
excludes artist-Drop and approved-suggestion relations.

Owned-Collection pagination requires
`idx_collections_owner_recent(owner_address_norm, updated_on DESC,
collection_id DESC)`, introduced by Collections migration
`0004_owner_lookup.sql`. The query uses `INDEXED BY` so a database without the
index fails instead of silently scanning the complete Collections table. The
index must exist on the production binding before code exposing the owner route
is deployed.

#### Public drop-statistics contract

Visible drop cards returned by `items`, `artist-drops`, and approved
`suggestions` include `tokenCount`, `transferCount`,
`emailClaims { minted, reserved, total } | null`, `featuredOn`, and
`momentsUploaded`. Email claims are aggregate counts only; raw claims and claimant
identities are never part of the public projection. Pending, rejected, or any
other non-approved suggestion status is excluded from both the suggestion export
and statistics coverage.

`GET /api/collections/:id/export/drop-stats` returns the deduplicated union of
the collection's items, artist drops, and approved suggestions. A visible entry
contains the same aggregates plus
`byChain { chain, createdOn, poapCount, transferCount }[]`; `createdOn` is the
source Unix-seconds integer, or `null` when the source omitted it. Privacy is
resolved before the per-chain lookup:

- hidden drops return only `{ dropId, isHidden: true }`;
- private or fail-closed drops return only `{ dropId, isPrivate: true }`; and
- a referenced card missing from the projection returns only `{ dropId }`.

No title, aggregate, media field, or per-chain row accompanies those ID-only
forms. The export manifest lists `drop-stats` only when the collection has at
least one eligible item, artist-drop, or approved-suggestion relation.

The endpoint accepts `limit=1..48` and defaults to 24, so a page contains at
most 48 unique drop IDs. Per-chain output is limited to 16 rows per visible drop
and 768 rows across a page; an imported shape beyond either boundary fails with
`503 collections_shape_unsupported` instead of truncating data. The secondary
query receives only the page's visible IDs and uses at most 49 bindings: 48 IDs
plus its row limit.

Pagination is keyset-based. `nextCursor` is bound to the Collections snapshot,
numeric collection ID, `drop-stats` segment, normalized filter, and page limit;
reusing it across a different snapshot, collection, segment, or limit returns 400. Clients should follow the returned `nextPath` unchanged until it becomes
`null`.

Every Collections read checks both the configured snapshot ID and the D1
readiness marker. A fully loaded staging database remains unavailable until its
eligible media has been published and a separately reviewed finalizer marks the
same snapshot ready.

### D1 Moments

`MOMENTS_DB` preserves Moments and Capsules independently from the fixed Drop
archive and Collections. It stores normalized Moment content, authors,
many-to-many Drop relations, links, user tags, explicit Capsules, historical
Capsule owners, public visibility decisions, suppression state, verified media
descriptors, and the derived Moment-to-Collection projection. Raw gateway URLs
and unrestricted media metadata remain outside the serving database.

The public view requires an affirmative visibility row, at least one Drop, no
relationship to a Moments-hidden Drop, and no active suppression. A media row
becomes public only after its content-addressed R2 object has been verified.
Metadata-only releases preserve source media counts while exposing no object
keys, allowing the browser to distinguish pending preservation from a genuinely
text-only Moment.

Every Moments request checks the configured snapshot, source-database digest,
build-manifest digest, and activation marker. A new D1 release is staged under a
new database UUID and stays unavailable until the resumable import journal,
table counts, projection, indexes, foreign keys, and integrity checks pass.

The personal export follows the existing public author-export cursor, with at
most 48 complete `MomentDetail` records per page. A separate public tag export
pages Moments in which the address appears in an archived user tag, and a
separate Capsule-owner export pages public Capsules whose normalized archived
owner exactly matches the address. All three use the same Moments release gate
and keyset-page bound. They neither bypass the public visibility projection nor
export suppressed or private source records.

Authorship, tagging, and Capsule ownership are distinct historical relations.
The same public Moment may occur in both the authored and tagged datasets, and
the standalone Capsule dataset includes owner-matched Capsules even when they
have no relation to a public Moment. Drop and Collection associations, media
descriptors, links, tags, and related Capsules remain attached to each exported
Moment.

### R2 media

`ARCHIVE_BUCKET` stores source artwork and eligible Collection logos and banners
under immutable snapshot-scoped keys. The first version serves originals;
thumbnail or format variants, if introduced, should be generated asynchronously
or during import and stored as separate immutable objects. A request must never
wait for a transform.

The database stores object identity and integrity metadata, not time-limited
signed URLs. Missing media should degrade to an accessible placeholder.

### Workers Cache

Cache is safe only for deterministic public GET/HEAD responses. Cache keys must
include the active snapshot ID plus every normalized input that changes the
response. Do not cache errors by default, responses with `Set-Cookie`, operator
endpoints, or future personalized/authenticated routes.

ENS resolution is the deliberate snapshot-independent exception. Its cache key
contains the normalized ENS name and API cache version. Successful resolutions
use a seven-day edge TTL; an expected `404 ens_not_found` uses a five-minute edge
TTL to prevent repeated misses from reaching the RPC provider. Other error
responses are not cached.

Collections additionally requires `COLLECTIONS_RELEASE_ID`, which identifies a
specific activated D1 binding and public projection release. The Worker composes
it into both the Collections API version header and every Collections cache key.
It must change whenever that binding or its published contents change, even when
`COLLECTIONS_SNAPSHOT_ID` remains the same. Cache hits therefore need no D1
readiness query merely to detect a replacement release.

Moments cache keys additionally include `MOMENTS_RELEASE_ID`, the expected
source-database SHA-256, and the exact build-manifest SHA-256. The same digests
must exist in the activated D1 metadata, binding a cache namespace to one
verified database build rather than only a logical snapshot name.

The Cache API is data-center-local and does not replace persistent storage.
Where Workers caching can serve a response before Worker execution, prefer it
for truly public, versioned resources. Use explicit `Cache-Control` and
snapshot-versioned cache keys. A new snapshot ID creates a new namespace, which
makes activation cheap and rollback explicit.

## Personal-site export flow

The personal-site control is an orchestration layer over existing bounded
reads:

1. The combined manifest verifies the Holdings, Collections, and Moments
   release identities and returns exact primary counts.
2. Holdings, owned Collections, public authored Moments, public tagged
   Moments, and historically owner-matched public Capsules are collected by
   keyset cursor.
3. Each Holdings page is verified as an exact partition of preserved and
   unavailable Drop references. Holder-proven private cards may be enriched,
   while missing and hidden cards remain opaque. All held Drop IDs are resolved
   to formal Collection membership in 96-ID batches; relevant Collection
   profiles are loaded in 16-ID batches.
4. Each owned Collection's export manifest is followed segment by segment until
   every `nextPath` is `null`.
5. Additional Drop IDs referenced by authored/tagged Moments and
   owned-Collection segments are resolved through the 96-ID public Drop-detail
   batch endpoint.
6. The browser verifies that every packaged Drop reference belongs to exactly
   one of the available `drops` or opaque `unavailable-drop-references` datasets,
   checks snapshot and count invariants, generates bounded data files, hashes
   every non-manifest file, and creates the ZIP.

The static package stores media descriptors and remote URLs, not R2 objects.
The static viewer does not attach those URLs to media elements until a visitor
clicks. Consequently, generating or opening the Overview has no R2 media-read
fan-out. It runs either directly from an extracted `file://` folder or from a
static HTTP origin and does not need the POAPin API after generation.

The old CSV/JSON endpoints remain single-response exports capped at 5,000
holdings. Their v2 rows apply the same holder-bound private enrichment and add
`is_private`. Exact private Drop lookup remains a separate single-record route;
it does not make these exports enumerable. The personal-site flow is the
complete path for larger addresses: there is no unbounded replacement endpoint,
only a manifest plus bounded pages.
See [Portable personal-site export](personal-site-export.md) for response and
package details.

## Data lifecycle

A snapshot moves through these states:

1. **Acquired** — the original ZIP is checksummed and recorded without changes.
2. **Inventoried** — file types, schemas, counts, encodings, and media references
   are documented.
3. **Staged** — normalized rows and R2 objects are loaded under a new snapshot
   ID, invisible to public routes.
4. **Validated** — counts, references, samples, indexes, and exports pass checks.
5. **Active** — configuration points public routes at the complete snapshot.
6. **Retired** — the snapshot is no longer the default but remains identifiable
   for rollback or audit according to retention policy.

Activation happens after data and media publication, never halfway through an
import. See [Data import](data-import.md).

The fixed archive ZIP, Compass Collections, and Compass Moments are separate
sources. Compass does not expose a transaction spanning GraphQL requests, so
Collections and Moments releases each require two independent full captures
with identical canonical row counts and SHA-256 digests. These are auditable
API-level captures, not physical copies of the source PostgreSQL database.

## Query and CPU rules

- Require indexed predicates for every public list route.
- Prefer keyset cursors over offset pagination.
- Cap every requested page size; complete exports must follow keyset pages
  rather than request an unbounded response.
- Select only fields needed by the response.
- Avoid regular expressions, decompression, image decoding, and large JSON
  parsing in Worker requests.
- Put deterministic work in the importer and reuse its output.
- Treat D1 rows read and R2 operations as first-class performance metrics, not
  just Worker wall time.
- Fail closed on malformed cursors and unreasonable input.

These are review rules, not aspirations: a change that introduces an unbounded
path should not merge without an explicit design decision.

## Privacy and abuse boundaries

Public blockchain data is not permission to build behavioral profiles. The
service should collect no account identity, avoid third-party trackers, and
keep operational logs free of response bodies and exported histories. Address
lookups should be rate-limited if traffic shows enumeration or cost abuse.

Export contracts must identify the relevant snapshot; manifests spanning
multiple datasets must identify each snapshot independently. Where a response
exposes capture time, it must come from stored snapshot metadata rather than the
request clock. Exports make no claim about current ownership.

## Failure model

- A cache failure falls back to a bounded origin read.
- Missing artwork falls back visually without failing the record response.
- One malformed record is quarantined during import, not discovered repeatedly
  on user requests.
- D1 overload returns a short retryable error; the Worker does not amplify it
  with retries.
- Snapshot activation is reversible because old, immutable snapshot data is not
  overwritten in place.

## Deferred decisions

The following require evidence from the source ZIP and load testing:

- final source-to-target field mapping;
- whether the initial D1 FTS index remains the best search strategy at full
  snapshot scale;
- holdings sharding thresholds;
- whether exceptionally large browser-side ZIPs need an optional resumable
  local packaging strategy beyond the current bounded-file generator; and
- thumbnail dimensions, formats, and generation schedule.
