# Source Archive Inventory

This inventory records the structure observed in the POAP Archive download
published at <https://poaparchive.com/>. It describes the source snapshot; it
does not establish permission to redistribute the data or artwork.

## Acquisition record

| Field                           | Observed value                                                     |
| ------------------------------- | ------------------------------------------------------------------ |
| Download URL                    | `https://downloads.poaparchive.com/archive.zip`                    |
| ZIP byte length                 | 15,839,405,768 bytes                                               |
| Published ZIP SHA-256           | `046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633` |
| SQLite SHA-256 after extraction | `18a052ec76a0b38f492ade7ff62869ead4556cd66cd8020a8550da9aa0e6a506` |
| Source snapshot time            | `2026-07-02T14:28:17.259Z`                                         |
| Source generation time          | `2026-07-02T14:49:32.049Z`                                         |
| Source schema version           | `1`                                                                |

The 15.8 GB file is ZIP64. Its central directory contains 73,797 entries:
`poap.sqlite`, the `artwork/` directory entry, and 73,795 WebP files named
`artwork/<drop_id>.webp`.

`poap.sqlite` is 609,546,189 bytes in the ZIP and 1,528,373,248 bytes after
extraction.

## SQLite tables

### `drops` — 73,876 rows

Primary key: `drop_id`.

```text
drop_id, fancy_id, title, description, start_date, end_date,
city, country, event_url, year, is_virtual, is_private,
channel, platform, location_type, timezone, created_at
```

The source includes an index on `fancy_id`. The public browser adds browse and
FTS5 indexes offline because title, city, and country searches otherwise scan
the table.

Observed properties:

- years range from 2014 through 2026;
- 40,003 rows are virtual, 32,677 are in person, and 1,196 have unknown
  `is_virtual` state;
- drop `30` has an empty `fancy_id`; it is preserved because `drop_id` is the
  stable public identifier and the empty value remains unique; and
- every row has `is_private = 0` in this snapshot.

### `tokens` — 6,218,154 rows

Primary key: `source_uid`.

```text
source_uid, poap_id, drop_id, minted_on,
owner_address, network, transfer_count
```

Source indexes cover `poap_id`, `drop_id`, `owner_address`, and `network`.
There are 1,236,466 distinct owner addresses and 72,140 drops referenced by at
least one token. All observed owner addresses are lower-case, 0x-prefixed,
40-hex-character addresses. Fifty-one `poap_id` values occur more than once, so
pagination uses `(poap_id, source_uid)` rather than assuming `poap_id` is unique.

Network counts:

| Network          |    Tokens |
| ---------------- | --------: |
| xdai             | 6,096,425 |
| base             |    39,194 |
| mainnet          |    36,520 |
| arbitrum-one     |    12,166 |
| unichain         |     9,606 |
| celo             |     7,336 |
| mantle           |     6,598 |
| apechain-mainnet |     5,153 |
| matic            |     3,366 |
| linea            |     1,225 |
| chiliz           |       565 |

### `email_reservation_stats` — 41,006 rows

Primary key: `drop_id`. The table provides total, minted, and unminted email
reservation counts used to precompute catalog aggregates.

### `snapshot_metadata`

The source records `drops_count`, `tokens_count`,
`email_reservation_stats_count`, `snapshot_at`, `generated_at`, and
`schema_version`. Import validation compares these claims to measured counts.

## Artwork

The archive contains 73,795 unique `<drop_id>.webp` files totaling
15,239,643,484 bytes by ZIP central-directory uncompressed size. There are no
artwork files without a matching drop. Eighty-one drops have no artwork entry.

The initial production R2 publication uploaded all 73,795 eligible files. Its
final report was complete and publishable with zero failures; the uploaded byte
total matched the measured 15,239,643,484 bytes.

Observed size distribution:

| Percentile | File size |
| ---------- | --------: |
| p50        |  40.8 KiB |
| p90        | 586.8 KiB |
| p95        | 1.307 MiB |
| p99        | 2.692 MiB |
| maximum    |  8.04 MiB |

Serving these originals directly from the R2 custom domain avoids per-request
Worker CPU and transformation charges. The browser must still lazy-load images
and handle the 81 known missing objects. Future thumbnails should be generated
offline and stored as ordinary R2 objects.

## Target mapping

The source database is deliberately split:

- `CATALOG_DB` receives drops, FTS text, snapshot metadata, token counts,
  reservation aggregates, and artwork availability;
- `HOLDINGS_DB` receives tokens, normalized addresses, and precomputed owner
  totals; and
- R2 receives the original bytes at
  `snapshots/<snapshot-id>/artwork/<drop_id>.webp` plus a generated integrity
  manifest.

The split prevents ordinary catalog traffic from competing with a
multi-million-row address index. It also keeps all decompression, hashing,
aggregation, and media work outside the Worker request path.

## Known limitations

- The snapshot is historical and must not be presented as current ownership.
- Unknown event type is distinct from in-person or virtual.
- Missing artwork is expected for 81 drops and requires a UI fallback.
- One early drop has an empty source `fancy_id`; clients must not treat that
  optional display slug as an identifier.
- Source URLs and descriptions are untrusted input and must be validated or
  rendered as plain text.
- Public blockchain data still creates privacy and enumeration concerns; the
  service exposes exact-address lookup and bounded holder records only for a
  known exact Drop ID. It does not provide cross-Drop address discovery, and
  every holder view is labeled as a historical snapshot.
- The complete production import measured 84.08 MB for the catalog D1 and
  778.83 MB for the holdings D1; exact-address lookups use the `tokens` primary
  key and exact-Drop collector pages require `idx_tokens_drop_collectors`.
  Repeat size, query-plan, and rows-read measurements for every future snapshot.
