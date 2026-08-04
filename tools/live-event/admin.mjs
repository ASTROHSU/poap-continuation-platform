import { spawnSync } from "node:child_process";
import process from "node:process";
import { buildEventAuditSql } from "./audit.mjs";

try {
  const [action, ...values] = process.argv.slice(2);
  if (!["audit", "chain", "load", "status", "stats"].includes(action)) throw new Error(usage());
  const args = parseArgs(values);
  if (!args.slug || !isSlug(args.slug)) throw new Error("--slug must be a valid event slug.");
  if (!["local", "remote"].includes(args.target)) {
    throw new Error("--target must be local or remote.");
  }
  if (args.target === "remote" && args.confirmRemote !== args.slug) {
    throw new Error(
      `Remote ${action} requires --confirm-remote ${args.slug}. No remote data was changed.`,
    );
  }

  if (action === "chain") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.contract ?? "")) {
      throw new Error("--contract must be a 0x contract address.");
    }
    if (!/^[0-9]+$/.test(args.tokenId ?? "")) {
      throw new Error("--token-id must be a non-negative integer.");
    }
    const chainId = args.chainId ?? "84532";
    if (!/^[1-9][0-9]*$/.test(chainId)) {
      throw new Error("--chain-id must be a positive integer.");
    }
    if (!/^[0-9]+$/.test(args.startBlock ?? "")) {
      throw new Error("--start-block must be the contract deployment block.");
    }
    runWrangler(
      [
        "d1",
        "execute",
        "LIVE_DB",
        `--${args.target}`,
        "--command",
        `UPDATE live_events SET chain_id = ${chainId}, contract_address = ${sqlText(
          args.contract.toLowerCase(),
        )}, token_id = ${sqlText(args.tokenId)}, contract_start_block = ${args.startBlock}, updated_at = CURRENT_TIMESTAMP WHERE slug = ${sqlText(
          args.slug,
        )} RETURNING slug, chain_id, contract_address, token_id, contract_start_block, updated_at`,
      ],
      args.config,
    );
  } else if (action === "load") {
    if (!args.bundle) throw new Error("--bundle is required for load.");
    runWrangler(
      [
        "d1",
        "execute",
        "LIVE_DB",
        `--${args.target}`,
        "--file",
        `${args.bundle.replace(/\/+$/, "")}/load-event.sql`,
      ],
      args.config,
    );
  } else if (action === "status") {
    if (!["draft", "published", "closed"].includes(args.set)) {
      throw new Error("--set must be draft, published, or closed.");
    }
    runWrangler(
      [
        "d1",
        "execute",
        "LIVE_DB",
        `--${args.target}`,
        "--command",
        `UPDATE live_events SET status = ${sqlText(args.set)}, updated_at = CURRENT_TIMESTAMP WHERE slug = ${sqlText(args.slug)} RETURNING slug, status, updated_at`,
      ],
      args.config,
    );
  } else if (action === "stats") {
    runWrangler(
      [
        "d1",
        "execute",
        "LIVE_DB",
        `--${args.target}`,
        "--command",
        `SELECT e.slug, e.status, e.claim_mode, e.max_supply, COUNT(c.code_hash) AS slots, SUM(CASE WHEN c.claimed_by IS NOT NULL THEN 1 ELSE 0 END) AS used, SUM(CASE WHEN c.claimed_by IS NULL THEN 1 ELSE 0 END) AS unused, SUM(CASE WHEN c.minted_tx_hash IS NOT NULL THEN 1 ELSE 0 END) AS minted FROM live_events e LEFT JOIN live_claim_codes c ON c.event_id = e.event_id WHERE e.slug = ${sqlText(args.slug)} GROUP BY e.event_id`,
      ],
      args.config,
    );
  } else {
    runWrangler(
      ["d1", "execute", "LIVE_DB", `--${args.target}`, "--command", buildEventAuditSql(args.slug)],
      args.config,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function runWrangler(args, config) {
  const configArgs = config ? ["--config", config] : [];
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--no-install", "wrangler", ...configArgs, ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler failed with exit code ${result.status}.`);
}

function parseArgs(values) {
  const parsed = { target: "local" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (
      [
        "--slug",
        "--target",
        "--confirm-remote",
        "--bundle",
        "--set",
        "--contract",
        "--token-id",
        "--chain-id",
        "--start-block",
        "--config",
      ].includes(value)
    ) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      parsed[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function isSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(value);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function usage() {
  return [
    "Usage:",
    "  Add --config wrangler.pilot.jsonc for every Pilot database operation.",
    "  npm run event:chain -- --slug slug --contract 0x... --token-id 1 --start-block 123 --target local|remote [--config path]",
    "  npm run event:load -- --bundle build/events/slug --slug slug --target local|remote [--config path]",
    "  npm run event:status -- --slug slug --set draft|published|closed --target local|remote [--config path]",
    "  npm run event:stats -- --slug slug --target local|remote [--config path]",
    "  npm run event:audit -- --slug slug --target local|remote [--config path]",
  ].join("\n");
}
