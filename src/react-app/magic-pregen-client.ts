import { getAddress, type Address } from "viem";

/**
 * Claims an already provisioned Magic PreGen wallet after the user enters the
 * same verified Email. The SDK import remains inside this user-triggered
 * function so Magic is emitted as a lazy chunk instead of increasing every
 * page's initial bundle.
 */
export async function claimMagicPregenWallet(
  publishableKey: string,
  email: string,
): Promise<Address> {
  if (!publishableKey) throw new Error("Magic publishable API key is unavailable.");
  const { Magic } = await import("magic-sdk");
  const magic = new Magic(publishableKey, { deferPreload: true });
  await magic.auth.loginWithEmailOTP({ email });
  const metadata = await magic.user.getInfo();
  const address = metadata.wallets?.ethereum?.publicAddress;
  if (!address) throw new Error("Magic did not return an Ethereum wallet address.");
  return getAddress(address);
}
