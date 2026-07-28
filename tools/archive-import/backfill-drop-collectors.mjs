#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { parseWranglerJson } from "./d1-loader.mjs";
import { toErrorMessage } from "./lib/util.mjs";

const HEX = "0123456789abcdef";
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const PREFIX = /^[0-9a-f]{1,4}$/;
const SPLITTABLE_FAILURE = /SQLITE_NOMEM|out of memory|timed? out|time limit|duration limit/i;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(argv);
  const execute =
    dependencies.execute ??
    createWranglerExecutor({
      binding: options.binding,
      remote: options.remote,
      wranglerBin: options.wranglerBin,
    });

  await assertSchemaReady(execute);
  const completed = new Set(
    (await execute("SELECT range_prefix FROM drop_collector_backfill ORDER BY range_prefix;")).map(
      (row) => String(row.range_prefix),
    ),
  );

  const progress = { completed: 0, skipped: 0, split: 0 };
  for (const prefix of HEX) {
    await backfillPrefix(prefix, { execute, completed, progress });
  }

  const [counts] = await execute(`SELECT
    (SELECT COUNT(*) FROM tokens) AS token_count,
    (SELECT COUNT(*) FROM drop_collector_refs) AS collector_ref_count;`);
  const tokenCount = Number(counts?.token_count);
  const collectorRefCount = Number(counts?.collector_ref_count);
  if (
    !Number.isSafeInteger(tokenCount) ||
    !Number.isSafeInteger(collectorRefCount) ||
    tokenCount !== collectorRefCount
  ) {
    throw new Error(
      `Drop collector backfill is incomplete: ${collectorRefCount} refs for ${tokenCount} tokens.`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      binding: options.binding,
      tokenCount,
      collectorRefCount,
      ranges: progress,
    })}\n`,
  );
  return 0;
}

async function backfillPrefix(prefix, context) {
  if (isRangeCovered(prefix, context.completed)) {
    context.progress.skipped += 1;
    return;
  }

  try {
    await context.execute(backfillSql(prefix));
    context.completed.add(prefix);
    context.progress.completed += 1;
    process.stdout.write(`[drop-collectors] completed address prefix ${prefix}\n`);
  } catch (error) {
    const message = toErrorMessage(error);
    if (!shouldSplitFailure(message) || prefix.length >= 4) throw error;
    context.progress.split += 1;
    process.stderr.write(`[drop-collectors] splitting address prefix ${prefix}\n`);
    for (const digit of HEX) {
      await backfillPrefix(`${prefix}${digit}`, context);
    }
  }
}

export function backfillSql(prefix) {
  const { lower, upper } = addressBoundsForPrefix(prefix);
  const range = upper
    ? `owner_address_norm >= '${lower}' AND owner_address_norm < '${upper}'`
    : `owner_address_norm >= '${lower}'`;
  return `INSERT OR IGNORE INTO drop_collector_refs (
  drop_id,
  poap_id,
  source_uid,
  owner_address_norm
)
SELECT
  drop_id,
  poap_id,
  source_uid,
  owner_address_norm
FROM tokens
WHERE ${range};
INSERT OR REPLACE INTO drop_collector_backfill (
  range_prefix,
  inserted_rows,
  completed_at
) VALUES (
  '${prefix}',
  changes(),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);`;
}

export function addressBoundsForPrefix(prefix) {
  if (!PREFIX.test(prefix)) throw new Error("Address prefix must contain 1 to 4 lowercase hex.");
  const lower = `0x${prefix}${"0".repeat(40 - prefix.length)}`;
  const value = Number.parseInt(prefix, 16);
  const maximum = 16 ** prefix.length - 1;
  const upper =
    value === maximum
      ? null
      : `0x${(value + 1).toString(16).padStart(prefix.length, "0")}${"0".repeat(
          40 - prefix.length,
        )}`;
  return { lower, upper };
}

export function shouldSplitFailure(message) {
  return SPLITTABLE_FAILURE.test(message);
}

function isRangeCovered(prefix, completed) {
  for (let length = 1; length <= prefix.length; length += 1) {
    if (completed.has(prefix.slice(0, length))) return true;
  }
  return (
    prefix.length < 4 && [...HEX].every((digit) => isRangeCovered(`${prefix}${digit}`, completed))
  );
}

async function assertSchemaReady(execute) {
  const rows = await execute(`SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'drop_collector_refs',
  'drop_collector_backfill',
  'tokens_drop_collector_ref_after_insert'
)
ORDER BY name;`);
  const names = new Set(rows.map((row) => String(row.name)));
  for (const required of [
    "drop_collector_refs",
    "drop_collector_backfill",
    "tokens_drop_collector_ref_after_insert",
  ]) {
    if (!names.has(required)) {
      throw new Error(`Holdings D1 is missing required migration object: ${required}.`);
    }
  }
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      binding: { type: "string", default: "HOLDINGS_DB" },
      remote: { type: "boolean", default: false },
      wrangler: { type: "string" },
    },
  });
  if (!BINDING.test(values.binding)) {
    throw new Error("Binding must be an uppercase Wrangler binding name.");
  }
  if (!values.remote) {
    throw new Error("Pass --remote explicitly; this tool never guesses the target.");
  }
  return {
    binding: values.binding,
    remote: values.remote,
    wranglerBin: values.wrangler ?? "wrangler",
  };
}

function createWranglerExecutor({ binding, remote, wranglerBin }) {
  return async (sql) => {
    const child = spawn(
      "npx",
      [
        wranglerBin,
        "d1",
        "execute",
        binding,
        ...(remote ? ["--remote"] : []),
        "--json",
        "--command",
        sql,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    if (code !== 0) {
      throw new Error((stderr || stdout || `Wrangler exited ${code}`).trim());
    }
    const response = parseWranglerJson(stdout);
    if (!Array.isArray(response) || response.some((item) => item?.success !== true)) {
      throw new Error("Wrangler reported an unsuccessful D1 operation.");
    }
    return response.flatMap((item) => item.results ?? []);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[drop-collectors] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
