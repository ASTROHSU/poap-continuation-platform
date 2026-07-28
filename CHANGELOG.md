# Changelog

All notable changes to POAPin Archive will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases will follow [Semantic Versioning](https://semver.org/) once a
stable public contract exists.

## [Unreleased]

### Added

- Exact Drop collector lists with public address links, preserved token facts,
  index-enforced D1 keyset pagination, and snapshot-versioned edge caching.
- Exact-ID detail for private, non-hidden Drops, with private records still
  excluded from browse, search, batch export, collector payloads, and Collection
  projections.
- Address-bound private Drop enrichment for exact holder lookups, personal-site
  ZIPs, and CSV/JSON exports.
- Public archive browser at [poap.in](https://poap.in) for the fixed
  `2026-07-02-v1` snapshot.
- Indexed D1 catalog and holdings queries, exact-address CSV/JSON exports, and
  snapshot-versioned Workers Cache responses.
- Immutable original artwork delivery from R2 at
  [media.poap.in](https://media.poap.in), with a verified 73,795-object initial
  synchronization and UI fallbacks for source-missing artwork.
- Authenticated, resumable R2 import tooling for large archive uploads.
- Deterministic, two-pass POAP Compass Collections capture with schema evidence,
  media quarantine, checksums, a portable SQLite backup, and a restorable
  application-level archive of anonymously reachable data.
- Referenced-drop enrichment for 26,004 Collection-linked drops, including
  per-chain and anonymous activity aggregates plus a deterministic 26,550-object
  media proof covering 18,533 fixed-Archive reuses, 7,331 new drop originals,
  and 686 Collection-branding objects. A second remote pass integrity-verified
  every object with zero failures before the snapshot-scoped D1 was activated.
- A separately gated Collections D1 model with fail-closed remote loading,
  bounded collection browsing, detail, item, and segmented export APIs.
- A responsive Collection Hub with search and filters, Collection profile and
  relationship views, public owner and approved-suggestion attribution, and
  portable segmented export controls.
- A separately gated Moments archive with 24,459 public authored records,
  Drop and Collection albums, address timelines, bounded exports, click-gated
  original media, download-only DNG/HEIC files, and a media-bound D1 release.
  The release preserves 30,548 unique R2 objects and verified every object in
  two independent remote passes with zero failures.
- A separate, explicit personal image archive that deduplicates every related
  public POAP, Collection, Moment, link-preview, and Capsule image, validates
  immutable R2 paths, response metadata, and content-addressed SHA-256 values,
  and writes a bounded STORE-only ZIP in the visitor's browser without proxying
  media through the Worker.
- Open-source contribution, conduct, security, licensing, architecture,
  deployment, and data-import documentation.
