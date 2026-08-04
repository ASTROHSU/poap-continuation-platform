import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = requiredPrivateKey();
const account = privateKeyToAccount(privateKey);
const contractAddress = getAddress(required("CONTRACT_ADDRESS"));
const tokenId = unsignedInteger("TOKEN_ID");
const maxSupply = unsignedInteger("MAX_SUPPLY");
const metadataUri = required("METADATA_URI");
if (!metadataUri.startsWith("https://")) throw new Error("METADATA_URI must use https.");
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

const transactionHash = await walletClient.writeContract({
  account,
  address: contractAddress,
  abi: artifact.abi,
  functionName: "createEvent",
  args: [tokenId, maxSupply, metadataUri],
});
console.log(`Event transaction: ${transactionHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
if (receipt.status !== "success") throw new Error("Event creation reverted.");
console.log(
  JSON.stringify(
    {
      network: "baseSepolia",
      chainId: baseSepolia.id,
      contractAddress,
      tokenId: tokenId.toString(),
      maxSupply: maxSupply.toString(),
      metadataUri,
      owner: account.address,
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      deploymentMethod: "viem-existing-artifact",
    },
    null,
    2,
  ),
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function unsignedInteger(name) {
  const value = required(name);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an unsigned integer.`);
  return BigInt(value);
}

function requiredPrivateKey() {
  const value = process.env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!/^0x[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error("BASE_SEPOLIA_PRIVATE_KEY must be a 0x-prefixed 32-byte private key.");
  }
  return value;
}
