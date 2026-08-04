import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = requiredPrivateKey();
const account = privateKeyToAccount(privateKey);
const claimSigner = requiredAddress("CLAIM_SIGNER_ADDRESS");
const owner = process.env.CONTRACT_OWNER_ADDRESS
  ? getAddress(process.env.CONTRACT_OWNER_ADDRESS)
  : account.address;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: {
    default: { name: "BaseScan", url: "https://sepolia.basescan.org" },
  },
  testnet: true,
});
const artifact = JSON.parse(
  await readFile(
    resolve("contracts/artifacts/contracts/AssociationBadges.sol/AssociationBadges.json"),
    "utf8",
  ),
);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) throw new Error("The deployer has no Base Sepolia ETH.");

console.log(`Deployer: ${account.address}`);
console.log(`Deployer balance: ${formatEther(balance)} Base Sepolia ETH`);
console.log(`Contract owner: ${owner}`);
console.log(`Claim signer: ${claimSigner}`);

const transactionHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [owner, claimSigner],
});
console.log(`Deployment transaction: ${transactionHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error("Contract deployment reverted or returned no contract address.");
}

const output = {
  network: "baseSepolia",
  chainId: baseSepolia.id,
  contractAddress: receipt.contractAddress,
  deployer: account.address,
  owner,
  claimSigner,
  transactionHash,
  blockNumber: receipt.blockNumber.toString(),
  deployedAt: new Date().toISOString(),
  deploymentMethod: "viem-existing-artifact",
};
const outputDir = resolve("contracts/deployment-output");
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const path = resolve(outputDir, `base-sepolia-${receipt.contractAddress}.json`);
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(output, null, 2));
console.log(`Saved deployment record: ${path}`);

function requiredAddress(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return getAddress(value);
}

function requiredPrivateKey() {
  const value = process.env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!/^0x[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error("BASE_SEPOLIA_PRIVATE_KEY must be a 0x-prefixed 32-byte private key.");
  }
  return value;
}
