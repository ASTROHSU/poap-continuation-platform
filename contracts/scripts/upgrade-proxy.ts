import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { getAddress } from "ethers";

const proxyAddress = getAddress(required("PROXY_ADDRESS"));
const implementationContract =
  process.env.UPGRADE_CONTRACT_NAME?.trim() || "AssociationBadgesUpgradeableV2";

console.log("現在請輸入 Hardhat keystore 密碼並按 Enter；輸入時不會顯示字元。");
const connection = await hre.network.create();
const { ethers, networkName } = connection;
assertSupportedNetwork(networkName);
confirmMainnet(networkName);

const [upgrader] = await ethers.getSigners();
const upgradesApi = await upgrades(hre, connection);
const previousImplementation = await upgradesApi.erc1967.getImplementationAddress(proxyAddress);
const current = await ethers.getContractAt("AssociationBadgesUpgradeable", proxyAddress, upgrader);
const owner = await current.owner();
if (owner.toLowerCase() !== upgrader.address.toLowerCase()) {
  throw new Error(
    `Connected upgrader ${upgrader.address} is not proxy owner ${owner}. No transaction was sent.`,
  );
}
const factory = await ethers.getContractFactory(implementationContract, upgrader);
const upgraded = await upgradesApi.upgradeProxy(proxyAddress, factory, {
  kind: "uups",
});
await upgraded.waitForDeployment();
const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(proxyAddress);
if (implementationAddress.toLowerCase() === previousImplementation.toLowerCase()) {
  throw new Error("Proxy implementation address did not change.");
}
const contractName = await upgraded.name();
const contractSymbol = await upgraded.symbol();
const implementationVersion = String(await upgraded.implementationVersion());
if (contractSymbol !== "TW" || implementationVersion !== "2") {
  throw new Error("Proxy upgrade completed but its TW collection identity is not active.");
}

const network = await ethers.provider.getNetwork();
const outputDir = resolve("deployment-output");
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const output = {
  network: networkName,
  chainId: Number(network.chainId),
  proxyKind: "uups",
  proxyAddress: await upgraded.getAddress(),
  previousImplementation,
  implementationAddress,
  implementationContract,
  upgrader: upgrader.address,
  owner,
  contractName,
  contractSymbol,
  implementationVersion,
  upgradedAt: new Date().toISOString(),
};
const path = resolve(outputDir, `${networkName}-upgrade-${Date.now()}.json`);
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(output, null, 2));
console.log(`Saved upgrade record: ${path}`);

function assertSupportedNetwork(networkName: string) {
  if (networkName !== "baseSepolia" && networkName !== "baseMainnet") {
    throw new Error("Proxy upgrades are restricted to Base Sepolia or Base mainnet.");
  }
}

function confirmMainnet(networkName: string) {
  if (networkName === "baseMainnet" && process.env.CONFIRM_MAINNET_UPGRADE !== "base-mainnet") {
    throw new Error(
      "Base mainnet proxy upgrade requires CONFIRM_MAINNET_UPGRADE=base-mainnet. No transaction was sent.",
    );
  }
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
