import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { getAddress } from "ethers";

const claimSigner = requiredAddress("CLAIM_SIGNER_ADDRESS");
const contractMetadataUri = requiredHttpsUrl("CONTRACT_METADATA_URI");

console.log("現在請輸入 Hardhat keystore 密碼並按 Enter；輸入時不會顯示字元。");
const connection = await hre.network.create();
const { ethers, networkName } = connection;
assertSupportedNetwork(networkName);
confirmMainnet(networkName);

const [deployer] = await ethers.getSigners();
const owner = process.env.CONTRACT_OWNER_ADDRESS
  ? getAddress(process.env.CONTRACT_OWNER_ADDRESS)
  : deployer.address;
const upgradesApi = await upgrades(hre, connection);
const factory = await ethers.getContractFactory("AssociationBadgesUpgradeable", deployer);
const contract = await upgradesApi.deployProxy(factory, [owner, claimSigner, contractMetadataUri], {
  kind: "uups",
});
await contract.waitForDeployment();
const proxyAddress = await contract.getAddress();
const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(proxyAddress);

if ((await contract.owner()).toLowerCase() !== owner.toLowerCase()) {
  throw new Error("Proxy owner initialization did not persist.");
}
if ((await contract.claimSigner()).toLowerCase() !== claimSigner.toLowerCase()) {
  throw new Error("Proxy claim signer initialization did not persist.");
}
if ((await contract.contractURI()) !== contractMetadataUri) {
  throw new Error("Proxy contract metadata initialization did not persist.");
}
const contractName = await contract.name();
const contractSymbol = await contract.symbol();
if (!contractName.trim() || !contractSymbol.trim()) {
  throw new Error("Proxy collection identity is empty.");
}

const outputDir = resolve("deployment-output");
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const network = await ethers.provider.getNetwork();
const output = {
  network: networkName,
  chainId: Number(network.chainId),
  proxyKind: "uups",
  proxyAddress,
  implementationAddress,
  deployer: deployer.address,
  owner,
  claimSigner,
  contractName,
  contractSymbol,
  contractMetadataUri,
  implementationVersion: String(await contract.implementationVersion()),
  deployedAt: new Date().toISOString(),
};
const path = resolve(outputDir, `${networkName}-uups-${proxyAddress}.json`);
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(output, null, 2));
console.log(`Saved deployment record: ${path}`);

function assertSupportedNetwork(networkName: string) {
  if (networkName !== "baseSepolia" && networkName !== "baseMainnet") {
    throw new Error("Proxy deployment is restricted to Base Sepolia or Base mainnet.");
  }
}

function confirmMainnet(networkName: string) {
  if (networkName === "baseMainnet" && process.env.CONFIRM_MAINNET_DEPLOY !== "base-mainnet") {
    throw new Error(
      "Base mainnet proxy deployment requires CONFIRM_MAINNET_DEPLOY=base-mainnet. No transaction was sent.",
    );
  }
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredAddress(name: string) {
  return getAddress(required(name));
}

function requiredHttpsUrl(name: string) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use https.`);
  return url.toString();
}
