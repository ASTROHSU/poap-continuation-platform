import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

try {
  const outputDir = resolve(process.argv[2] ?? "build/secrets");
  const signerPrivateKey = generatePrivateKey();
  const relayerPrivateKey = generatePrivateKey();
  const signerAccount = privateKeyToAccount(signerPrivateKey);
  const relayerAccount = privateKeyToAccount(relayerPrivateKey);
  const secrets = {
    MINT_SIGNER_PRIVATE_KEY: signerPrivateKey,
    MINT_RELAYER_PRIVATE_KEY: relayerPrivateKey,
    EMAIL_LOOKUP_SECRET: randomBytes(32).toString("hex"),
    EMAIL_DATA_KEY: randomBytes(32).toString("base64"),
    RESEND_API_KEY: "REPLACE_WITH_RESEND_API_KEY",
  };

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeNew(
      resolve(outputDir, "worker-secrets.production.json"),
      `${JSON.stringify(secrets, null, 2)}\n`,
    ),
    writeNew(resolve(outputDir, "mint-signer-address.txt"), `${signerAccount.address}\n`),
    writeNew(resolve(outputDir, "mint-relayer-address.txt"), `${relayerAccount.address}\n`),
    writeNew(
      resolve(outputDir, "README.txt"),
      [
        "CONFIDENTIAL — do not commit, email, or paste these files into chat.",
        "",
        `Mint signer public address: ${signerAccount.address}`,
        `Mint relayer public address: ${relayerAccount.address}`,
        "Fund only the relayer address with a small amount of Base ETH for sponsored Gas.",
        "Replace RESEND_API_KEY in worker-secrets.production.json.",
        "Then run launch:preflight before uploading secrets to Cloudflare.",
        "",
      ].join("\n"),
    ),
  ]);

  console.log(`Prepared non-overwriting production secret files in ${outputDir}`);
  console.log(`Mint signer public address: ${signerAccount.address}`);
  console.log(`Mint relayer public address: ${relayerAccount.address}`);
  console.log("User action remaining: replace RESEND_API_KEY after creating the Resend key.");
} catch (error) {
  const detail =
    error && typeof error === "object" && "code" in error && error.code === "EEXIST"
      ? "Secret files already exist. Refusing to overwrite them."
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(detail);
  process.exitCode = 1;
}

async function writeNew(path, contents) {
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
