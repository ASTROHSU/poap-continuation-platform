# Deployment

The public target is `poap.in` on Cloudflare Workers, with original artwork at
`media.poap.in`. This checklist
keeps resource provisioning, data publication, and code deployment explicit.

## Prerequisites

- Node.js 22.13 or newer and npm
- a Cloudflare account with the `poap.in` zone
- a narrowly scoped Cloudflare API token or an authenticated Wrangler session
- permission to create Workers, four D1 databases, an R2 bucket, and the custom
  domain

Review current Cloudflare limits and pricing before importing production data.
The repository deliberately does not promise that a particular plan will fit an
unknown archive size.

## Install and authenticate

```bash
npm ci
npx wrangler login
```

For CI deployment, use a scoped token in the CI secret store. Never commit
tokens, account IDs that are intended to remain private, `.dev.vars`, or
downloaded data.

## Provision once

Create the named resources in the intended Cloudflare account:

```bash
npx wrangler d1 create poapin-archive-catalog
npx wrangler d1 create poapin-archive-holdings
npx wrangler r2 bucket create poapin-archive
```

Copy the returned catalog and holdings database IDs into the matching entries
in `wrangler.jsonc`. The checked-in IDs identify Glory Lab's production
resources; forks must replace them with databases in their own Cloudflare
account.

Collections D1 is not a long-lived restore target. Every Collections release
must create a uniquely named snapshot-scoped database through the isolated
configuration workflow in [Collections backup](../tools/collections-backup/README.md).
Do not create or migrate a replacement Collections database through the active
Worker configuration, and do not change its `COLLECTIONS_DB` binding until the
new database has passed staging verification and activation requirements.
The same deployment must set a new, non-empty `COLLECTIONS_RELEASE_ID` for that
exact activated database and projection, even if `COLLECTIONS_SNAPSHOT_ID` is
unchanged. Never reuse a release ID after replacing the binding or published
contents.

Moments follows the same snapshot-scoped replacement model through the stricter
four-phase loader in [Moments backup](../tools/moments-backup/README.md). Keep a
new Moments D1 unbound while it is loaded and verified. Bind it only after
activation, and deploy the matching `MOMENTS_RELEASE_ID`,
`MOMENTS_SOURCE_DATABASE_SHA256`, and `MOMENTS_BUILD_MANIFEST_SHA256` together.
The Worker compares all three database identity fields before serving a row,
and the two digests are also part of every Moments cache namespace.

Confirm that `poap.in` belongs to a zone in the same account. Wrangler is
configured to attach it as a Worker custom domain. Glory Lab's production R2
bucket is already bound to `media.poap.in`; forks must bind their own reviewed
media domain before publishing `MEDIA_BASE_URL`. Keep the bucket's public
`r2.dev` development URL disabled so artwork is exposed only through the
reviewed custom domain.

## Configure browser media access

The optional image-archive download runs in the visitor's browser and reads
immutable originals directly from `media.poap.in`. It does not proxy image
bytes through the Worker. Production therefore needs the checked-in CSP and the
R2 bucket CORS policy to agree on the two exact origins.

Apply and then inspect the production policy:

```bash
npx wrangler r2 bucket cors set poapin-archive --file config/r2-cors.json
npx wrangler r2 bucket cors list poapin-archive
```

`config/r2-cors.json` allows only the exact `https://poap.in` origin and only
`GET`/`HEAD`. It exposes response metadata used for progress and integrity
checks. Do not broaden it to `*`, add write methods, or add localhost origins to
the production bucket. Local browser development should stub the immutable
media responses or use a separately configured non-production bucket.

An R2 custom domain automatically emits CORS response headers for valid
cross-origin requests after the bucket policy is active. Existing cached
objects do not acquire newly configured CORS headers automatically, so purge
the cache for the `media.poap.in` hostname after every CORS-policy change. Use
Cloudflare's [purge by hostname](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-hostname/)
operation rather than purging unrelated `poap.in` content.

Allow the policy to propagate, then send an origin-bearing request to a known
immutable object:

```bash
curl --head --header "Origin: https://poap.in" \
  https://media.poap.in/snapshots/2026-07-02-v1/artwork/1.webp
```

Require `Access-Control-Allow-Origin: https://poap.in` in the response. A plain
request without an `Origin` header is not a CORS test and is not expected to
return that header. Also test one real browser-side image ZIP before declaring
the deployment healthy.

## Configure ENS resolution

The homepage and direct paths such as `/address/name.eth` accept complete `0x`
addresses and ENS names. ENS names are sent to `/api/resolve-address`; the
Worker resolves them on Ethereum mainnet through the Universal Resolver using
`ETHEREUM_RPC_URL`. A successful route is replaced with its canonical lowercase
`0x` address. The browser never receives the RPC URL or calls the provider
directly, and no provider API key is required by the checked-in production
configuration.

CCIP-Read is disabled so a resolver-controlled record cannot send the Worker to
arbitrary offchain gateways. Names that require that fallback fail closed; the
ordinary onchain `.eth` path remains available.

Glory Lab currently configures PublicNode's keyless public Ethereum endpoint:

```json
{
  "vars": {
    "ETHEREUM_RPC_URL": "https://ethereum-rpc.publicnode.com"
  }
}
```

Forks may replace it with any HTTPS Ethereum mainnet JSON-RPC endpoint. Keep the
setting server-side; never add an RPC URL or provider credential to browser
code. If a replacement endpoint requires a credential, remove the checked-in
value and provide `ETHEREUM_RPC_URL` through the deployment environment or
Cloudflare secret store rather than committing it.

Resolved names are cached at the edge for seven days. An expected unresolved
name is cached at the edge for five minutes, while validation failures and
transient provider errors are not cached. These bounded, snapshot-independent
TTLs reduce repeated RPC calls without treating mutable ENS records as archive
data.

PublicNode is convenient for a keyless default but does not provide this
deployment with a project-specific SLA. An operator that needs dedicated
quotas, observability, or support can point the same variable at another
provider. [Cloudflare Ethereum Gateway](https://developers.cloudflare.com/web3/ethereum-gateway/)
is one compatible option that can be configured later; review its current
pricing and limits before switching.

## Generate binding types

After any binding change:

```bash
npm run cf-typegen
npm run typecheck
```

Commit generated type changes together with the binding change.

## Apply migrations

The numbered schema backs the published fixed snapshot. Validate every new
migration locally before remote application:

```bash
npx wrangler d1 migrations apply CATALOG_DB --local
npx wrangler d1 migrations apply HOLDINGS_DB --local
npx wrangler d1 migrations apply COLLECTIONS_DB --local
npx wrangler d1 migrations apply MOMENTS_DB --local
npx wrangler d1 migrations apply CATALOG_DB --remote
npx wrangler d1 migrations apply HOLDINGS_DB --remote
```

The remote `COLLECTIONS_DB` binding may point at the currently active or
rollback database. Never run `wrangler d1 migrations apply COLLECTIONS_DB
--remote` as part of a restore. Create a fresh snapshot-scoped Collections D1,
bind only its exact name and UUID in a permission-restricted temporary Wrangler
configuration, apply all four Collections migrations there, and use the
fail-closed staging loader. The complete reusable command sequence is in
[Collections backup](../tools/collections-backup/README.md).

Likewise, never run remote Moments migrations through the active Worker
binding. Use the exact database name and UUID with the isolated Moments loader;
keep `moments_meta.ready=0` through verification and activate only the
target-bound verified build.

Never edit an already-applied migration. Every schema pull request must include
forward validation and rollback guidance; a rollback may require a new forward
migration.

Synthetic development rows live under `fixtures/`, outside the migration
chain. `npm run db:setup:local` applies them only to the local databases. Never
run a fixture file with `--remote`.

## Collections owner index gate

Personal-site export adds exact archived-owner pagination for Collections.
Migration `migrations/collections/0004_owner_lookup.sql` creates the required
partial owner-order index:

```sql
CREATE INDEX idx_collections_owner_recent
  ON collections(owner_address_norm, updated_on DESC, collection_id DESC)
  WHERE owner_address_norm IS NOT NULL;
```

The production query names this index with `INDEXED BY`. That is intentional:
if the index is absent, the route fails instead of silently scanning the full
Collections snapshot. It also means deployment order is mandatory.

Before deploying a Worker version that exposes
`/api/collections/owners/:address/export`:

1. Target the exact candidate Collections database name and UUID through the
   permission-restricted temporary Wrangler configuration.
2. List pending migrations through the isolated `STAGING_COLLECTIONS_DB`
   binding. A fresh target must show exactly `0001` through `0004`; an
   intentionally retained verified database that already has `0001` through
   `0003` must show only `0004_owner_lookup.sql`. Any other state requires
   investigation.
3. Apply the listed migration set through that same isolated binding, then list
   again and require no pending migration:

   ```bash
   npx wrangler d1 migrations list STAGING_COLLECTIONS_DB \
     --remote --config "$STAGING_CONFIG"
   npx wrangler d1 migrations apply STAGING_COLLECTIONS_DB \
     --remote --config "$STAGING_CONFIG"
   npx wrangler d1 migrations list STAGING_COLLECTIONS_DB \
     --remote --config "$STAGING_CONFIG"
   ```

   Do not use the active `COLLECTIONS_DB` binding as an ambiguous restore
   target.

4. Confirm `collections_meta` still identifies the intended ready snapshot and
   that `PRAGMA integrity_check` passes.
5. Confirm `PRAGMA index_list('collections')` contains
   `idx_collections_owner_recent`.
6. Run `EXPLAIN QUERY PLAN` for an exact `owner_address_norm` lookup ordered by
   `updated_on DESC, collection_id DESC`; require the owner index and no
   temporary sort.
7. Exercise the owner endpoint against that database before changing or
   deploying the public Worker binding.

Do not deploy the code first. A database loaded under the previous
three-migration schema is otherwise healthy for older routes but cannot serve
the new owned-Collection export. Record the fourth migration and index check for
both the activation candidate and any database intended for immediate rollback.

Migration `0004` adds only the lookup index. Applying it to an otherwise
verified database does not require another source capture, D1 data import, or R2
publication. It also does not by itself require a new
`COLLECTIONS_RELEASE_ID`; replacing the binding or changing published rows still
does, under the existing release rules. The Collections backup package's three
`d1/prepare` artifacts remain data-import artifacts, not a count of repository
schema migrations.

## Import a staged snapshot

Follow [Data import](data-import.md). A deployable code build is not evidence
that the archive data is complete. Before activation, verify:

- the source checksum and importer commit;
- catalog, holdings, rejected-row, and media totals;
- representative indexed queries and exports;
- that every required R2 object is readable from the intended media route; and
- that the snapshot's rights, attribution, and known-limitations notices exist.

Use the checked-in [offline importer](../tools/archive-import/README.md) and
[R2 media uploader](../tools/r2-media-upload/README.md); retain their reports as
release artifacts.

POAP Compass Collections use a separate source-level backup and activation
gate. Follow [Collections backup](../tools/collections-backup/README.md), retain
both capture passes and the packaged backup, load the generated bounded D1
shards into a new snapshot-scoped D1 identified by its exact name and UUID, and
keep `collections_meta.ready=0` until every publishable Collection branding
object has been remotely verified. Do not update the active `COLLECTIONS_DB`
binding during staging. The public Worker fails closed while the configured
snapshot ID and ready marker disagree.

POAP Moments use a separate source-level backup and activation gate. Retain both
byte-identical structured captures, their stability report, the generated
Moment-to-Collection map, and both private R2 backup packages. Load bounded D1
shards through `moments:load-d1`, and keep media rows pending until their exact
R2 objects have passed the independent media verification workflow.

## Validate the build

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run build
npm run check
```

`npm run check` includes a Wrangler dry-run. Inspect its bundle and binding
output; verify that it references the intended account resources and snapshot.

## Deploy the public site

```bash
npm run deploy
```

After deployment, verify at least:

- the home page previews, the complete `/drops` browser, and static assets;
- direct `0x` lookup plus a resolving and an unresolved ENS name, including the
  seven-day positive and five-minute negative edge-cache behavior of
  `/api/resolve-address`;
- `/api/meta`, one page each of browse and address results, and a 96-ID
  `/api/drops/export/batch` boundary request whose public and unavailable
  arrays are disjoint and jointly cover the canonical requested IDs;
- `/api/collections`, one collection detail/items page, and each segmented
  collection export endpoint;
- one formal held-Drop membership resolution, one batched Collection-profile
  response, and one paginated exact-owner Collection response;
- `/api/moments/meta`, the Moments hub, one Moment detail, one Drop album, one
  Collection album, and one page each of the author, tag, and Capsule-owner
  exports;
- one personal export manifest and at least two cursor pages of normalized
  Holdings, verifying on each page that the unique token Drop references are
  partitioned exactly between public `drops` and `unavailableDropIds`, and that
  all three snapshot IDs, both release IDs, the Moments source/build digests,
  and authored/tagged/Capsule counts remain unchanged;
- a browser-built personal-site ZIP: verify its manifest hashes and counts,
  serve the extracted folder, open every Holdings, Collection, authored,
  tagged, and Capsule view, confirm `drops` and
  `unavailable-drop-references` jointly cover all packaged Drop references,
  confirm `counts.unavailableDropReferences`, and confirm no remote image,
  video, or audio request occurs before a media click;
- the separate browser-built image ZIP: confirm duplicate image URLs become one
  binary, image bytes are intact, video/audio are absent, cancellation is
  clean, and the Worker does not proxy R2 media;
- an origin-bearing `GET` or `HEAD` to one cached
  `https://media.poap.in` object, requiring
  `Access-Control-Allow-Origin: https://poap.in` after the hostname purge;
- an empty result and an invalid request;
- image success and fallback behavior;
- address-bound enrichment for a deliberately held private Drop, while the
  same ID remains redacted in global Drop and Collection routes and hidden or
  missing fixtures stay ID-only;
- JSON and CSV export metadata, including the legacy 5,000-record rejection;
- cache headers and repeated-request behavior; and
- observability without secrets, response bodies, or unnecessary address data.

Record the Worker version, Git commit, snapshot ID, Collections and Moments
release IDs, Moments source/build digests, Collections migration
`0004_owner_lookup.sql` and index evidence, migration state, and smoke test result
in the release notes.

## Deploying generated personal sites

The ZIP created by an address page is a separate, pure-static artifact; it is
not another deployment of this Worker. Its extracted root can be published
through Cloudflare Drop, Vercel Drop, a Filebase IPFS Site, or an ICP asset
canister. The package contains provider-specific agent prompts, but operators
remain responsible for destination accounts, domains, retention, and current
provider limits. Before upload, the extracted `index.html` can be opened
directly to check the package without running a local server.

Follow [Portable personal-site export](personal-site-export.md#deploying-the-generated-package)
for the exact package boundary and deployment guidance. Do not add a Worker API,
database, or server build step merely to host the generated site.

## Cache and rollback

Public caches must be namespaced by snapshot ID. Collections cache keys must also
include the required `COLLECTIONS_RELEASE_ID`, so replacing a Collections D1
binding while retaining its logical snapshot cannot reuse a prior successful
response. This namespace is computed before cache lookup and does not add a D1
query to cache hits. Cache content is disposable and must never be the only copy
of a record or image.

Keep the previous code version and immutable snapshot available during the
rollback window. To roll back, redeploy the last known-good code and snapshot
configuration, then repeat the smoke tests. Do not delete the failed snapshot's
D1 rows or R2 objects during an incident; investigate and clean up separately.

## Public launch readiness gate

A public launch requires documented answers for:

- measured Worker CPU, D1 rows read, R2 operations, and cache effectiveness;
- rate limits and abuse behavior for search and address export;
- data provenance, artwork rights, attribution, correction, and takedown flow;
- log fields, sampling, access, and retention;
- backup, restore, rollback, and snapshot retention drills; and
- an operator runbook for D1 overload, R2/media failure, and bad imports.
