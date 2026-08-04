import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const secretsPath = resolve(process.argv[2] ?? "build/secrets/worker-secrets.production.json");
const outputDir = resolve(secretsPath, "..");
const relayerAddressPath = resolve(outputDir, "mint-relayer-address.txt");

try {
  const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
  const relayerPrivateKey = secrets.MINT_RELAYER_PRIVATE_KEY ?? generatePrivateKey();

  if (!/^0x[0-9a-f]{64}$/i.test(relayerPrivateKey)) {
    throw new Error("MINT_RELAYER_PRIVATE_KEY has an invalid format.");
  }

  if (relayerPrivateKey === secrets.MINT_SIGNER_PRIVATE_KEY) {
    throw new Error("Mint signer and relayer must use different keys.");
  }

  const relayerAddress = privateKeyToAccount(relayerPrivateKey).address;

  if (!secrets.MINT_RELAYER_PRIVATE_KEY) {
    const upgraded = { ...secrets, MINT_RELAYER_PRIVATE_KEY: relayerPrivateKey };
    const temporaryPath = `${secretsPath}.upgrade-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(upgraded, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, secretsPath);
    await chmod(secretsPath, 0o600);
  }

  await writeFile(relayerAddressPath, `${relayerAddress}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });

  console.log(
    secrets.MINT_RELAYER_PRIVATE_KEY
      ? "Relayer secret already existed; no secret was replaced."
      : "Added a separate relayer secret without replacing existing secrets.",
  );
  console.log(`Mint relayer public address: ${relayerAddress}`);
  console.log("Fund only this public address with a small amount of Base Sepolia ETH.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
