## What changed

<!-- Describe the problem and the result. Link an issue when one exists. -->

## Why this approach

<!-- Note meaningful alternatives or trade-offs. -->

## Verification

<!-- List commands and any manual checks. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:browser` when browser behavior changes
- [ ] `npm run build`
- [ ] `cd frontend-astro && npm run build` when the public frontend changes
- [ ] `cd contracts && npm test` when the contract or mint authorization changes

## Operational and data impact

<!-- Describe cache keys, CPU, D1 rows read, R2 operations, migrations, imports,
or privacy impact. Write "None" when not applicable. -->

## Checklist

- [ ] The change is focused and follows Conventional Commits.
- [ ] Tests cover new behavior and important failure paths.
- [ ] Documentation and the changelog are updated when appropriate.
- [ ] No archive ZIP, database dump, secret, or unlicensed media is included.
- [ ] No production `wrangler.pilot.jsonc`, `.dev.vars`, access code, or deployment output is included.
- [ ] Schema changes include forward and rollback guidance.
- [ ] New data or media includes provenance and a redistribution basis.
