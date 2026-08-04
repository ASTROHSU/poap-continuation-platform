import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inspectEventImage, validateEvent } from "../live-event/lib.mjs";

const PLACEHOLDER_ID = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/i;
const PLACEHOLDER = /(example\.(org|com|invalid)|replace[_ -]?with|changeme|todo)/i;
const REQUIRED_SECRETS = [
  "MINT_SIGNER_PRIVATE_KEY",
  "MINT_RELAYER_PRIVATE_KEY",
  "EMAIL_LOOKUP_SECRET",
  "EMAIL_DATA_KEY",
  "RESEND_API_KEY",
];

export async function inspectLaunchReadiness({ configPath, eventPath, secretsPath }) {
  const checks = [];
  const config = await readJson(configPath, "Wrangler config");
  const secrets = await readJson(secretsPath, "Worker secrets");
  const rawEvent = await readJson(eventPath, "Pilot event");
  let event = null;

  check(checks, config.vars?.APP_MODE === "live-only", "Pilot mode is live-only");
  check(checks, config.d1_databases?.length === 1, "Pilot uses only one live D1 database");
  const liveDb = config.d1_databases?.find((entry) => entry.binding === "LIVE_DB");
  check(checks, Boolean(liveDb), "LIVE_DB binding exists");
  check(
    checks,
    Boolean(liveDb?.database_id) && !PLACEHOLDER_ID.test(liveDb.database_id),
    "LIVE_DB has a real Cloudflare database ID",
  );
  check(
    checks,
    Boolean(config.r2_buckets?.find((entry) => entry.binding === "ARCHIVE_BUCKET")),
    "Live media R2 binding exists",
  );
  check(
    checks,
    isProductionUrl(config.vars?.PUBLIC_APP_URL),
    "PUBLIC_APP_URL is a real HTTPS origin",
  );
  check(checks, config.vars?.EMAIL_PROVIDER === "resend", "Production email provider is Resend");
  check(
    checks,
    typeof config.vars?.EMAIL_FROM === "string" && !PLACEHOLDER.test(config.vars.EMAIL_FROM),
    "EMAIL_FROM uses a verified sender domain",
  );
  check(
    checks,
    Array.isArray(config.secrets?.required) &&
      REQUIRED_SECRETS.every((key) => config.secrets.required.includes(key)),
    "All required Worker secrets are declared",
  );

  const walletProvisioningMode = config.vars?.WALLET_PROVISIONING_MODE ?? "disabled";
  check(
    checks,
    ["disabled", "magic-pregen"].includes(walletProvisioningMode),
    "Wallet provisioning mode is recognized",
  );
  if (walletProvisioningMode === "magic-pregen") {
    check(
      checks,
      typeof config.vars?.MAGIC_PUBLISHABLE_API_KEY === "string" &&
        /^pk_(live|test)_/.test(config.vars.MAGIC_PUBLISHABLE_API_KEY),
      "Magic publishable API key is configured",
    );
    check(
      checks,
      config.secrets?.required?.includes("MAGIC_SECRET_KEY"),
      "Magic secret is declared as required",
    );
    check(
      checks,
      typeof secrets.MAGIC_SECRET_KEY === "string" &&
        /^sk_(live|test)_/.test(secrets.MAGIC_SECRET_KEY),
      "Magic secret key is configured",
    );
  }

  for (const key of REQUIRED_SECRETS) {
    check(
      checks,
      typeof secrets[key] === "string" &&
        secrets[key].length > 0 &&
        !PLACEHOLDER.test(secrets[key]),
      `${key} has a non-placeholder value`,
    );
  }
  check(
    checks,
    /^0x[0-9a-f]{64}$/i.test(secrets.MINT_SIGNER_PRIVATE_KEY ?? ""),
    "Mint signer private key format is valid",
  );
  check(
    checks,
    /^0x[0-9a-f]{64}$/i.test(secrets.MINT_RELAYER_PRIVATE_KEY ?? ""),
    "Mint relayer private key format is valid",
  );
  check(
    checks,
    secrets.MINT_SIGNER_PRIVATE_KEY !== secrets.MINT_RELAYER_PRIVATE_KEY,
    "Mint signer and relayer use separate private keys",
  );
  check(
    checks,
    /^[A-Za-z0-9+/]{43}=$/.test(secrets.EMAIL_DATA_KEY ?? ""),
    "Email encryption key is 32-byte base64",
  );
  check(
    checks,
    (secrets.EMAIL_LOOKUP_SECRET?.length ?? 0) >= 32,
    "Email lookup secret has at least 32 characters",
  );

  try {
    event = validateEvent(rawEvent);
    check(checks, true, "Pilot event schema is valid");
    check(checks, event.chainId === 84532, "First Pilot runs on Base Sepolia");
    check(checks, event.claimCount >= 10 && event.claimCount <= 30, "Pilot has 10–30 claim slots");
    check(
      checks,
      isProductionUrl(event.publicBaseUrl),
      "Event publicBaseUrl is a real HTTPS origin",
    );
    check(
      checks,
      event.publicBaseUrl === config.vars?.PUBLIC_APP_URL,
      "Event and Worker use the same public origin",
    );
    const image = await inspectEventImage(event, dirname(resolve(eventPath)));
    check(checks, image.status === "checked", "Pilot artwork bytes and dimensions were verified");
  } catch (error) {
    check(
      checks,
      false,
      `Pilot event is valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ready: checks.every((item) => item.ok), checks, event };
}

function check(checks, ok, label) {
  checks.push({ ok: Boolean(ok), label });
}

function isProductionUrl(value) {
  if (typeof value !== "string" || PLACEHOLDER.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(resolve(path), "utf8")));
  } catch (error) {
    throw new Error(
      `${label} could not be read as JSON (${path}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stripJsonCommentsAndTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}
