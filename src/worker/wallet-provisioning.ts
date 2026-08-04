import { getAddress, type Address } from "viem";
import type { Bindings } from "./types";
import {
  beginEmailWalletProvisioning,
  fetchEmailWallet,
  recordEmailWalletFailure,
  recordEmailWalletReady,
  type EmailWalletRecord,
} from "./email-wallets";

const MAGIC_PREGEN_ENDPOINT = "https://api.magic.link/v1/admin/pregen/wallet";
const PROVISIONING_LEASE_MS = 2 * 60 * 1000;

export type WalletProvisioningMode = "disabled" | "magic-pregen";

export function walletProvisioningMode(
  env: Pick<Bindings, "WALLET_PROVISIONING_MODE">,
): WalletProvisioningMode {
  return env.WALLET_PROVISIONING_MODE === "magic-pregen" ? "magic-pregen" : "disabled";
}

export function publicWalletProvisioningConfig(
  env: Pick<Bindings, "WALLET_PROVISIONING_MODE" | "MAGIC_PUBLISHABLE_API_KEY">,
) {
  const mode = walletProvisioningMode(env);
  return {
    mode,
    enabled: mode === "magic-pregen",
    publishableKey: mode === "magic-pregen" ? env.MAGIC_PUBLISHABLE_API_KEY || null : null,
  };
}

export async function ensureVerifiedEmailWallet(
  env: Bindings,
  input: { email: string; emailHmac: string },
): Promise<EmailWalletRecord | null> {
  if (walletProvisioningMode(env) === "disabled") return null;

  const existing = await fetchEmailWallet(
    env.LIVE_DB.withSession("first-primary"),
    input.emailHmac,
  );
  if (existing?.status === "ready") return existing;

  const startedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - PROVISIONING_LEASE_MS).toISOString();
  const acquired = await beginEmailWalletProvisioning(env.LIVE_DB, {
    emailHmac: input.emailHmac,
    provider: "magic-pregen",
    startedAt,
    staleBefore,
  });
  if (!acquired) {
    return fetchEmailWallet(env.LIVE_DB.withSession("first-primary"), input.emailHmac);
  }

  try {
    const address = await createMagicPregenWallet(input.email, env.MAGIC_SECRET_KEY);
    const recorded = await recordEmailWalletReady(env.LIVE_DB, {
      emailHmac: input.emailHmac,
      provider: "magic-pregen",
      startedAt,
      address,
    });
    if (!recorded) throw new WalletProvisioningError("wallet_record_conflict");
  } catch (error) {
    const code = walletProvisioningErrorCode(error);
    await recordEmailWalletFailure(env.LIVE_DB, {
      emailHmac: input.emailHmac,
      provider: "magic-pregen",
      startedAt,
      errorCode: code,
    });
    console.error("Email wallet provisioning failed", {
      provider: "magic-pregen",
      emailHmac: input.emailHmac,
      code,
    });
  }
  return fetchEmailWallet(env.LIVE_DB.withSession("first-primary"), input.emailHmac);
}

export async function createMagicPregenWallet(
  email: string,
  secretKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Address> {
  if (!secretKey || !/^sk_(live|test)_/.test(secretKey)) {
    throw new WalletProvisioningError("magic_secret_unavailable");
  }
  const response = await fetchImpl(MAGIC_PREGEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Magic-Secret-Key": secretKey,
    },
    body: JSON.stringify({ email }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WalletProvisioningError("magic_invalid_response");
  }
  if (!response.ok) {
    const providerCode = readProviderErrorCode(body);
    throw new WalletProvisioningError(
      response.status === 429
        ? "magic_rate_limited"
        : response.status >= 500
          ? "magic_unavailable"
          : providerCode || "magic_request_rejected",
    );
  }
  const address = readPublicAddress(body);
  if (!address) throw new WalletProvisioningError("magic_invalid_response");
  try {
    return getAddress(address);
  } catch {
    throw new WalletProvisioningError("magic_invalid_address");
  }
}

class WalletProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WalletProvisioningError";
  }
}

function walletProvisioningErrorCode(error: unknown): string {
  if (error instanceof WalletProvisioningError) return error.code;
  return "wallet_provider_error";
}

function readPublicAddress(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const address = (value as Record<string, unknown>).public_address;
  return typeof address === "string" ? address : null;
}

function readProviderErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error)
    ? `magic_${error.toLowerCase()}`
    : null;
}
