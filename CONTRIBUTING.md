# Contributing to POAP 留存計畫

Thank you for helping keep public memories accessible. Contributions should
make the archive easier to understand, safer to operate, or cheaper to keep
online.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large feature, schema change, or data-policy change so
  the approach can be discussed early.
- Keep archive ZIP files, database dumps, generated D1 files, and imported
  artwork out of Git.
- Do not contribute data or media unless its provenance and redistribution
  basis can be documented.

## Development setup

Use Node.js 22 or newer and npm:

```bash
npm ci
npm run dev
```

Before opening a pull request, run the same gates as CI:

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run build

cd frontend-astro
npm ci
npm run build

cd ../contracts
npm ci
npm run build
npm run test:node
```

Use `npm run check` when changing Worker bindings, routing, or build behavior; it
adds a Wrangler deployment dry-run.

## Branches

The default branch is `main` and should remain deployable. Work in a short-lived
branch named `<type>/<short-description>`, for example:

- `feat/csv-export`
- `fix/drop-pagination`
- `docs/import-provenance`
- `chore/update-wrangler`

Do not mix unrelated changes in one branch. Rebase or merge the latest `main`
before final review when the branch has drifted materially.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(optional-scope): <imperative summary>
```

Common types are:

- `feat`: user-visible capability
- `fix`: defect correction
- `docs`: documentation only
- `test`: test-only change
- `refactor`: behavior-preserving code change
- `perf`: measurable performance or cost improvement
- `chore`: tooling, dependency, or maintenance work
- `ci`: continuous-integration configuration

Use `!` and a `BREAKING CHANGE:` footer for incompatible API, schema, export, or
import-contract changes. Write a body when the reason, data impact, or rollback
path is not obvious from the diff.

## Pull requests

A pull request should:

- explain the problem and the chosen behavior;
- link the relevant issue when one exists;
- be small enough to review confidently;
- include tests for changed behavior and failure cases;
- update user, API, import, or deployment documentation when relevant;
- call out D1 rows-read, Worker CPU, R2-operation, or cache-key implications;
- include forward and rollback steps for migrations; and
- avoid drive-by formatting or dependency churn.

Draft pull requests are welcome for early technical feedback. A maintainer will
squash or retain commits according to their clarity; every commit that reaches
`main` must still follow the Conventional Commits format.

## Testing expectations

- Unit-test pure parsing, validation, cursor, and export logic.
- Exercise Worker routes in the Workers runtime.
- Test pagination boundaries, invalid input, empty snapshots, and missing media.
- Add a regression test before or with a bug fix when practical.
- Keep fixtures small, synthetic, and free of unlicensed artwork or unnecessary
  real wallet histories.

## Database and import changes

Schema changes must be additive where practical and arrive as numbered D1
migrations. Never rewrite an applied migration. Document indexes and the query
they support; an index without a known request path is operational debt.

Importer changes must remain deterministic and idempotent for the same source
checksum and importer version. Add validation totals and document any lossy
normalization. Publishing media should complete before a snapshot becomes
active so database rows never point at knowingly absent objects.

See [Data import](docs/data-import.md) and
[Data and licensing](docs/data-and-licensing.md).

## Licensing contributions

By submitting a contribution, you agree that your original code and
documentation may be distributed under the repository's MIT License. You retain
copyright in your contribution.

Third-party data and media are outside that grant. Identify their source,
license or other redistribution basis, checksum, and any required attribution
in the pull request. A reachable URL is provenance, not proof of permission.
