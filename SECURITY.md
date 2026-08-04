# Security Policy

## Supported versions

POAP 留存計畫 is currently pre-release. Security fixes are applied to the
latest code on `main` and deployed to the public site. Historical commits,
forks, local imports, and unofficial deployments are not supported by this
policy.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability. Email
[poap@stevechoice.org](mailto:poap@stevechoice.org) with the subject
`[POAP Continuation Security]` and include:

- the affected route, component, or commit;
- a clear description of the impact;
- minimal reproduction steps or a proof of concept;
- whether any data or credentials may already be exposed; and
- a safe way to contact you for follow-up.

Never include real secrets, unnecessary wallet histories, or third-party
personal data in a report. Test only against accounts, objects, and addresses
you control or have permission to use. Do not degrade the public service.

We aim to acknowledge a report within 7 days and provide an initial assessment
or status update within 30 days. Complex reports may take longer; we will keep
the reporter informed when that happens. Please allow time for a fix and
deployment before public disclosure.

## In scope

Examples include:

- injection, cache poisoning, or authorization bypass;
- unintended access to Cloudflare bindings, objects, logs, or deployment
  credentials;
- export behavior that exposes data other than the requested public snapshot;
- denial-of-service paths with disproportionate Worker CPU, D1, or R2 cost; and
- dependency vulnerabilities that are reachable in this application.

Incorrect public archive data, missing artwork, attribution questions, and
ordinary availability problems should use the issue tracker instead.

## Operator responsibilities

Self-hosted operators are responsible for rotating Cloudflare credentials,
restricting deployment tokens, reviewing observability retention, applying
security updates, validating imported data, and configuring rate limits or
other abuse controls appropriate to their traffic.
