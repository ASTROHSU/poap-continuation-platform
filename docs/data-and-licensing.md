# Data and Licensing

POAPin Archive separates the license for this repository from the rights in the
materials the software can preserve or display.

This document is an operational policy, not legal advice.

## Repository code

Original project code and documentation are licensed under the
[MIT License](../LICENSE). Contributions are accepted on the same basis unless
their file clearly states otherwise.

## Archived data and artwork

The MIT License does not automatically cover:

- downloaded database or ZIP contents;
- POAP event metadata and token/ownership records;
- issuer- or artist-created event artwork;
- photographs, descriptions, links, and other third-party content; or
- POAP, POAPin, event, sponsor, and issuer names, logos, and trademarks.

Some facts may not be copyrightable in some jurisdictions, and some material
may have a separate license or lawful preservation basis. Those questions are
specific to the source and jurisdiction. This project does not turn access into
a blanket permission grant.

## Snapshot provenance

Every published snapshot should identify:

- the source and retrieval time;
- file and media checksums;
- the importer version and transformations performed;
- any source license, terms, notice, or attribution discovered;
- excluded or quarantined material and why; and
- a contact path for corrections, attribution, and removal requests.

Provenance answers "where did this come from?" It does not by itself answer
"may anyone redistribute it?" Record both questions independently.

## Artwork handling

Event artwork should retain its source association and available creator or
issuer attribution. Do not remove embedded attribution or provenance metadata
without documenting the necessity. Do not use archived artwork to imply that an
issuer endorses POAPin Archive.

Original images are stored first. Any later thumbnail or format conversion must
remain traceable to the original content digest and should preserve visual
integrity.

## Address and ownership data

The archive is a dated record, not a live claim about a person. Addresses can be
pseudonymous identifiers and may become personal data when combined with other
information. Avoid unnecessary enrichment, profiling, analytics, and retention
of search behavior.

Exports must include snapshot identity and capture time. They should not label
the requesting user as the owner of an address and should not require a wallet
signature merely to access already-public snapshot data.

## Corrections and removal

Use the public data-report issue form for ordinary factual corrections,
attribution, missing media, or provenance questions that do not require private
information. For a request containing personal, confidential, or sensitive
context, email [poap@stevechoice.org](mailto:poap@stevechoice.org).

A report should identify the snapshot and record, explain the requested change,
and provide enough evidence to evaluate it. Maintainers may hide material while
a request is reviewed. Corrections to immutable snapshots should be represented
as an explicit overlay or a new snapshot rather than silently rewriting history.

## Responsibilities of mirrors

Forking the MIT-licensed code does not authorize mirroring an operator's D1
data or R2 objects. Anyone deploying their own archive must independently assess
the source terms, applicable law, attribution, privacy, and takedown obligations
for the data and media they choose to publish.

POAPin Archive is independent and is not endorsed by or affiliated with POAP,
the operators of POAP Archive, or event issuers represented in a snapshot.
