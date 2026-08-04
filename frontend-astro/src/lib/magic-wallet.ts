export interface MagicEmbeddedSession {
  didToken: string;
  address: `0x${string}`;
  email: string;
}

/** Magic is loaded only when a collector chooses Email wallet login. */
export async function loginWithMagicEmail(
  publishableKey: string,
  email: string,
  emailTemplateName?: string | null,
): Promise<MagicEmbeddedSession> {
  if (!publishableKey) throw new Error("Magic Email 錢包尚未啟用。");
  const { Magic } = await import("magic-sdk");
  const magic = new Magic(publishableKey, { deferPreload: true, locale: "zh_TW" });

  if (await magic.user.isLoggedIn()) {
    const current = await magic.user.getInfo();
    if (current.email?.trim().toLowerCase() !== email.trim().toLowerCase()) {
      await magic.user.logout();
    }
  }

  let didToken: string | null = null;
  if (await magic.user.isLoggedIn()) {
    didToken = await magic.user.getIdToken();
  } else {
    didToken = await magic.auth.loginWithEmailOTP({
      email: email.trim(),
      showUI: true,
      ...(emailTemplateName ? { overrides: { variation: emailTemplateName } } : {}),
    });
  }
  if (!didToken) throw new Error("Magic Email 驗證未完成。");

  const metadata = await magic.user.getInfo();
  const address = metadata.wallets?.ethereum?.publicAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Magic 沒有回傳可用的 Ethereum 地址。");
  }
  return {
    didToken,
    address: address.toLowerCase() as `0x${string}`,
    email: metadata.email?.trim().toLowerCase() || email.trim().toLowerCase(),
  };
}

/** Restore an existing Magic session without opening an OTP prompt. */
export async function resumeMagicEmailSession(
  publishableKey: string,
): Promise<MagicEmbeddedSession | null> {
  if (!publishableKey) return null;
  const { Magic } = await import("magic-sdk");
  const magic = new Magic(publishableKey, { deferPreload: true, locale: "zh_TW" });
  if (!(await magic.user.isLoggedIn())) return null;
  const [didToken, metadata] = await Promise.all([magic.user.getIdToken(), magic.user.getInfo()]);
  const address = metadata.wallets?.ethereum?.publicAddress;
  const email = metadata.email?.trim().toLowerCase();
  if (!didToken || !email || !address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return { didToken, address: address.toLowerCase() as `0x${string}`, email };
}

export async function logoutMagicEmailSession(publishableKey: string): Promise<void> {
  if (!publishableKey) return;
  const { Magic } = await import("magic-sdk");
  const magic = new Magic(publishableKey, { deferPreload: true, locale: "zh_TW" });
  if (await magic.user.isLoggedIn()) await magic.user.logout();
}
