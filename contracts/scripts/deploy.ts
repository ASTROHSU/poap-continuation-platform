import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { getAddress } from "viem";

const claimSigner = requiredAddress("CLAIM_SIGNER_ADDRESS");
console.log("現在請輸入 Hardhat keystore 密碼並按 Enter；輸入時不會顯示字元。");
const { viem, networkName } = await network.create();
if (networkName !== "baseSepolia") {
  throw new Error("Deployment is restricted to --network baseSepolia in Phase 2.");
}

const [deployer] = await viem.getWalletClients();
const owner = process.env.CONTRACT_OWNER_ADDRESS
  ? getAddress(process.env.CONTRACT_OWNER_ADDRESS)
  : deployer.account.address;
const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction(
  "AssociationBadges",
  [owner, claimSigner],
);
const publicClient = await viem.getPublicClient();
const receipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentTransaction.hash,
});
if (receipt.status !== "success") throw new Error("Contract deployment reverted.");

const outputDir = resolve("deployment-output");
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const output = {
  network: networkName,
  chainId: await publicClient.getChainId(),
  contractAddress: contract.address,
  deployer: deployer.account.address,
  owner,
  claimSigner,
  transactionHash: deploymentTransaction.hash,
  blockNumber: receipt.blockNumber.toString(),
  deployedAt: new Date().toISOString(),
};
const path = resolve(outputDir, `base-sepolia-${contract.address}.json`);
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(output, null, 2));
console.log(`Saved deployment record: ${path}`);

function requiredAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return getAddress(value);
}
