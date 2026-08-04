import { Magic } from "@magic-sdk/admin";
import type { Bindings } from "./types";
import { normalizeEmail } from "./email-auth";
import { ApiError, normalizeAddress } from "./validation";

export interface PublicMagicEmbeddedWalletConfig {
  provider: "magic";
  enabled: boolean;
  publishableKey: string | null;
  emailTemplateName: string | null;
}

export function publicMagicEmbeddedWalletConfig(
  env: Pick<
    Bindings,
    "MAGIC_PUBLISHABLE_API_KEY" | "MAGIC_SECRET_KEY" | "MAGIC_EMAIL_TEMPLATE_NAME"
  >,
): PublicMagicEmbeddedWalletConfig {
  const publishableKey = env.MAGIC_PUBLISHABLE_API_KEY?.trim() || null;
  const enabled = Boolean(publishableKey && env.MAGIC_SECRET_KEY?.trim());
  const emailTemplateName = env.MAGIC_EMAIL_TEMPLATE_NAME?.trim() || null;
  return {
    provider: "magic",
    enabled,
    publishableKey: enabled ? publishableKey : null,
    emailTemplateName: enabled ? emailTemplateName : null,
  };
}

export async function verifyMagicIdentity(
  env: Pick<
    Bindings,
    "MAGIC_PUBLISHABLE_API_KEY" | "MAGIC_SECRET_KEY" | "MAGIC_EMAIL_TEMPLATE_NAME"
  >,
  input: { didToken: string; expectedEmail: string },
): Promise<{ address: `0x${string}`; email: string }> {
  const config = publicMagicEmbeddedWalletConfig(env);
  if (!config.enabled || !env.MAGIC_SECRET_KEY) {
    throw new ApiError(503, "Magic Email wallet is not configured.", "magic_unavailable");
  }

  try {
    const magic = await Magic.init(env.MAGIC_SECRET_KEY);
    magic.token.validate(input.didToken);
    const metadata = await magic.users.getMetadataByToken(input.didToken);
    const email = normalizeEmail(metadata.email);
    if (email !== normalizeEmail(input.expectedEmail)) {
      throw new ApiError(403, "Magic Email does not match this request.", "magic_email_mismatch");
    }
    const rawAddress =
      metadata.publicAddress ??
      metadata.wallets?.find((wallet) => wallet.walletType === "ETH")?.publicAddress ??
      metadata.wallets?.find((wallet) => wallet.publicAddress)?.publicAddress;
    if (!rawAddress) {
      throw new ApiError(409, "Magic did not return an Ethereum wallet.", "magic_wallet_missing");
    }
    return { address: normalizeAddress(rawAddress) as `0x${string}`, email };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("Magic identity verification failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    throw new ApiError(
      401,
      "Magic Email verification expired or could not be confirmed.",
      "magic_auth_invalid",
    );
  }
}
