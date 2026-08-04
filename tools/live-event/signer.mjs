import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

try {
  const outputDir = resolve(process.argv[2] ?? "build/secrets");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(outputDir, "mint-signer.key"), `${privateKey}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(resolve(outputDir, "mint-signer-address.txt"), `${account.address}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        claimSignerAddress: account.address,
        secretFile: resolve(outputDir, "mint-signer.key"),
        addressFile: resolve(outputDir, "mint-signer-address.txt"),
        next: "Store the key as the Worker MINT_SIGNER_PRIVATE_KEY secret; never commit or share it.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const detail =
    error && typeof error === "object" && "code" in error && error.code === "EEXIST"
      ? "Signer files already exist. Refusing to overwrite them."
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(detail);
  process.exitCode = 1;
}
