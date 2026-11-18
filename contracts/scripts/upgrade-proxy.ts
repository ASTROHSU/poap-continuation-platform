import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { getAddress, type TransactionResponse } from "ethers";

const proxyAddress = getAddress(required("PROXY_ADDRESS"));
const currentImplementationContract =
  process.env.CURRENT_IMPLEMENTATION_CONTRACT_NAME?.trim() || "AssociationBadgesUpgradeableV3";
const expectedCurrentVersion = process.env.EXPECTED_CURRENT_IMPLEMENTATION_VERSION?.trim() || "3";
const implementationContract =
  process.env.UPGRADE_CONTRACT_NAME?.trim() || "AssociationBadgesUpgradeableV4";
const expectedName =
  process.env.EXPECTED_CONTRACT_NAME?.trim() || "底加（TĪ-TSIA）：有來過，就會記底加";
const expectedSymbol = process.env.EXPECTED_CONTRACT_SYMBOL?.trim() || "HERE";
const expectedVersion = process.env.EXPECTED_IMPLEMENTATION_VERSION?.trim() || "4";
// Optional: raise these events' max supply inside the upgrade transaction (V4+ only).
const raiseTokenIds = (process.env.RAISE_MAX_SUPPLY_TOKEN_IDS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map((v) => BigInt(v));
const raiseTo = process.env.RAISE_MAX_SUPPLY_TO?.trim()
  ? BigInt(process.env.RAISE_MAX_SUPPLY_TO.trim())
  : 0n;
if (raiseTokenIds.length > 0 && raiseTo <= 0n) {
  throw new Error(
    "RAISE_MAX_SUPPLY_TO is required with RAISE_MAX_SUPPLY_TOKEN_IDS. No transaction was sent.",
  );
}

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
const currentVersion = String(await current.implementationVersion());
const currentName = await current.name();
const currentSymbol = await current.symbol();
if (currentVersion === expectedVersion) {
  if (currentName !== expectedName || currentSymbol !== expectedSymbol) {
    throw new Error(
      `Proxy is already version ${expectedVersion}, but its collection identity is unexpected. No transaction was sent.`,
    );
  }
  console.log(
    JSON.stringify(
      {
        network: networkName,
        proxyKind: "uups",
        proxyAddress,
        implementationAddress: previousImplementation,
        owner,
        contractName: currentName,
        contractSymbol: currentSymbol,
        implementationVersion: currentVersion,
        alreadyUpgraded: true,
      },
      null,
      2,
    ),
  );
} else if (currentVersion !== expectedCurrentVersion) {
  throw new Error(
    `Proxy implementation version is ${currentVersion}, expected ${expectedCurrentVersion}. No transaction was sent.`,
  );
} else {
  // The proxy may have been upgraded from another checkout or machine. Importing the
  // exact currently active implementation repairs only the local OZ manifest and sends
  // no transaction; upgradeProxy below still performs the normal storage-layout check.
  const currentFactory = await ethers.getContractFactory(currentImplementationContract, upgrader);
  await upgradesApi.forceImport(proxyAddress, currentFactory, { kind: "uups" });
  for (const tokenId of raiseTokenIds) {
    const [maxSupply] = await current.eventConfig(tokenId);
    if (BigInt(maxSupply) >= raiseTo) {
      throw new Error(
        `Token ${tokenId} max supply is already ${maxSupply}, not below ${raiseTo}. No transaction was sent.`,
      );
    }
  }
  const factory = await ethers.getContractFactory(implementationContract, upgrader);
  const upgraded = await upgradesApi.upgradeProxy(proxyAddress, factory, {
    kind: "uups",
    ...(raiseTokenIds.length > 0
      ? { call: { fn: "increaseMaxSupply", args: [raiseTokenIds, raiseTo] } }
      : {}),
  });
  const upgradeTransaction = (
    upgraded as typeof upgraded & { deployTransaction?: TransactionResponse }
  ).deployTransaction;
  if (!upgradeTransaction) {
    throw new Error("Upgrade transaction was not returned by the deployment plugin.");
  }
  const receipt = await upgradeTransaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Proxy upgrade transaction did not succeed.");
  }
  const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(proxyAddress);
  if (implementationAddress.toLowerCase() === previousImplementation.toLowerCase()) {
    throw new Error("Proxy implementation address did not change after transaction confirmation.");
  }
  const contractName = await upgraded.name();
  const contractSymbol = await upgraded.symbol();
  const implementationVersion = String(await upgraded.implementationVersion());
  if (
    contractName !== expectedName ||
    contractSymbol !== expectedSymbol ||
    implementationVersion !== expectedVersion
  ) {
    throw new Error("Proxy upgrade completed but the expected collection identity is not active.");
  }
  const maxSupplies: Record<string, string> = {};
  for (const tokenId of raiseTokenIds) {
    const [maxSupply] = await upgraded.eventConfig(tokenId);
    maxSupplies[String(tokenId)] = String(maxSupply);
    if (BigInt(maxSupply) !== raiseTo) {
      throw new Error(
        `Upgrade confirmed but token ${tokenId} max supply is ${maxSupply}, not ${raiseTo}.`,
      );
    }
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
    upgradeTransactionHash: receipt.hash,
    upgrader: upgrader.address,
    owner,
    contractName,
    contractSymbol,
    implementationVersion,
    maxSupplies,
    upgradedAt: new Date().toISOString(),
  };
  const path = resolve(outputDir, `${networkName}-upgrade-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(output, null, 2));
  console.log(`Saved upgrade record: ${path}`);
}

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
