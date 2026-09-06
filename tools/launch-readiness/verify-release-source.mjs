import { execFileSync } from "node:child_process";

// A release must come from a committed, complete checkout. The 2026-08-30
// release omitted admin files that existed only in a different dirty checkout.
execFileSync(
  "git",
  [
    "ls-files",
    "--error-unmatch",
    "src/worker/access-auth.ts",
    "src/worker/issuer-admin.ts",
    "workers/admin-gateway/index.ts",
    "wrangler.admin.jsonc",
    "wrangler.pilot.jsonc",
    "frontend-astro/src/pages/issuer/manage.astro",
    "frontend-astro/src/components/IssuerAdmin.tsx",
    "frontend-astro/src/layouts/AdminLayout.astro",
    "migrations/live/0010_live_event_issuer.sql",
    "migrations/live/0011_live_event_revisions.sql",
  ],
  { stdio: "pipe" },
);
const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  encoding: "utf8",
});
if (changes.trim())
  throw new Error(
    "Release requires a clean committed checkout. Commit the complete source before deploying.\n" +
      changes,
  );
console.log(
  "Release source verified:",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
