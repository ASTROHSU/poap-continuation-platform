/**
 * Magic stays outside the initial bundle. It is loaded only when a verified
 * collector explicitly opens the Email wallet that was pre-generated for them.
 */
export async function claimMagicPregenWallet(
  publishableKey: string,
  email: string,
): Promise<`0x${string}`> {
  if (!publishableKey) throw new Error("Magic 錢包尚未啟用。");
  const { Magic } = await import("magic-sdk");
  const magic = new Magic(publishableKey, { deferPreload: true });
  await magic.auth.loginWithEmailOTP({ email });
  const metadata = await magic.user.getInfo();
  const address = metadata.wallets?.ethereum?.publicAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Magic 沒有回傳可用的 Ethereum 地址。");
  }
  return address as `0x${string}`;
}
