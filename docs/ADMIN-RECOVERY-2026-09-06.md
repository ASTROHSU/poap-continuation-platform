# Admin release recovery — 2026-09-06

Vercel production dpl_CV6q4gkkn1hynzihsCJp9dic7DnM (Aug17 22:10 Asia/Taipei) included issuer/manage.astro and IssuerAdmin.tsx. Production dpl_7X2tetbUidp59XEZPcgqrEdTNaj6 (Aug30 23:58) omitted them. Both CLI releases were attributed to actor=codex. The Aug30 source checkout lacked management files present but untracked in the Developer checkout; GitHub main still pointed to e58ece8.

This recovery reconciles the Aug30 production source with existing management code and Sep6 mint authorization renewal. It retains holdings media release/cache keys and proxy encoding behavior. The gateway maps admin / to /issuer/manage and proxies administrator APIs through ADMIN_BACKEND. Public frontend API routes reject admin paths. Access and Magic checks remain enforced.

The initial gateway_unconfigured and missing Access application are separate configuration failures; their original failure dates were not established. Backend Access configuration was aligned with the current application. Gas exhaustion is independent of admin routing.

## Release from a clean committed checkout

Production Worker/gateway configs, admin frontend, auth modules, migrations and tests belong in Git. Secret values remain only in Cloudflare/Vercel; config declares required secret names. Do not redeploy divergent workspaces or edit compiled bundles.

- Install: `npm ci && npm ci --prefix frontend-astro`
- Worker: `npm run deploy:pilot` (rebuilds and tests before deployment)
- Gateway: `npm run deploy:admin`
- Frontend: `npm run deploy:frontend` (requires Vercel CLI and project link)

Deployment commands reject incomplete or dirty checkouts. Frontend builds verify /issuer/manage in the emitted route manifest; production builds require the gateway secret. Worker integration tests exercise signed Access JWTs, Magic identity handling and D1 event listing in live-only mode, stubbing only the external Magic service.

After each release verify public pages/artwork, public admin denial, Access redirect, authenticated Magic session and read-only event listing. A 200 login page alone is insufficient. Never disable authentication for a smoke test. Gateway secrets must match, and Access issuer/audience and both allowlists must identify the intended application/account.

Rollbacks require compatible frontend and Worker versions. Code rollback does not independently revert Access policies or secrets.
