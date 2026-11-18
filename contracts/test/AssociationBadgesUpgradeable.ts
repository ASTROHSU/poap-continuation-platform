import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.create({
  network: "hardhatOp",
  chainType: "op",
});
const { ethers, networkHelpers } = connection;
// The upgrades plugin currently types its connection as generic even though it
// works with Hardhat's OP simulator at runtime.
const upgradesApi = await upgrades(hre, connection as any);
const [owner, signer, collector, relayer] = await ethers.getSigners();

const contractMetadataUri = "https://example.test/contract.json";
const eventMetadataUri = "https://example.test/events/1.json";
const claimTypes = {
  Claim: [
    { name: "account", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function deployFixture(): Promise<any> {
  const factory = await ethers.getContractFactory("AssociationBadgesUpgradeable", owner);
  const contract = await upgradesApi.deployProxy(
    factory,
    [owner.address, signer.address, contractMetadataUri],
    { kind: "uups" },
  );
  await contract.waitForDeployment();
  await (await contract.createEvent(1n, 3n, eventMetadataUri)).wait();
  return contract;
}

async function authorization(
  contractAddress: string,
  account: string,
  nonce: string,
  deadline: bigint,
) {
  const network = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "AssociationBadges",
      version: "1",
      chainId: network.chainId,
      verifyingContract: contractAddress,
    },
    claimTypes,
    { account, tokenId: 1n, deadline, nonce },
  );
}

describe("AssociationBadgesUpgradeable", () => {
  it("initializes once and exposes collection and event metadata", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await contract.owner(), owner.address);
    assert.equal(await contract.claimSigner(), signer.address);
    assert.equal(await contract.name(), "兆量富足教育協會數位紀念");
    assert.equal(await contract.symbol(), "STEVE");
    assert.equal(await contract.contractURI(), contractMetadataUri);
    assert.equal(await contract.uri(1n), eventMetadataUri);
    assert.equal(await contract.implementationVersion(), 1n);
    await assert.rejects(
      contract.initialize(owner.address, signer.address, contractMetadataUri),
      /InvalidInitialization/,
    );
  });

  it("keeps sponsored claims and one-per-wallet enforcement behind the proxy", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    const nonce = `0x${"11".repeat(32)}`;
    const contractAddress = await contract.getAddress();
    const signature = await authorization(contractAddress, collector.address, nonce, deadline);

    await (
      await contract.connect(relayer).claimFor(collector.address, 1n, deadline, nonce, signature)
    ).wait();
    assert.equal(await contract.balanceOf(collector.address, 1n), 1n);
    assert.equal(await contract["totalSupply(uint256)"](1n), 1n);
    await assert.rejects(
      contract.connect(relayer).claimFor(collector.address, 1n, deadline, nonce, signature),
      /AlreadyClaimed/,
    );
  });

  it("lets the owner pause claims and transfers, then resume them", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const contractAddress = await contract.getAddress();
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    const firstNonce = `0x${"22".repeat(32)}`;
    const firstSignature = await authorization(
      contractAddress,
      collector.address,
      firstNonce,
      deadline,
    );
    await (
      await contract.connect(collector).claim(1n, deadline, firstNonce, firstSignature)
    ).wait();

    await assert.rejects(contract.connect(relayer).pause(), /OwnableUnauthorizedAccount/);
    await (await contract.pause()).wait();
    assert.equal(await contract.paused(), true);
    await assert.rejects(
      contract
        .connect(collector)
        .safeTransferFrom(collector.address, relayer.address, 1n, 1n, "0x"),
      /EnforcedPause/,
    );

    const secondNonce = `0x${"33".repeat(32)}`;
    const secondSignature = await authorization(
      contractAddress,
      relayer.address,
      secondNonce,
      deadline,
    );
    await assert.rejects(
      contract.connect(relayer).claim(1n, deadline, secondNonce, secondSignature),
      /EnforcedPause/,
    );

    await (await contract.unpause()).wait();
    await (
      await contract.connect(relayer).claim(1n, deadline, secondNonce, secondSignature)
    ).wait();
    assert.equal(await contract.balanceOf(relayer.address, 1n), 1n);
  });

  it("lets only the owner update metadata and blocks ownership renouncement", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const nextContractUri = "https://example.test/contract-v2.json";
    const nextEventUri = "https://example.test/events/1-v2.json";

    await assert.rejects(
      contract.connect(collector).setContractURI(nextContractUri),
      /OwnableUnauthorizedAccount/,
    );
    await (await contract.setContractURI(nextContractUri)).wait();
    await (await contract.setEventMetadataURI(1n, nextEventUri)).wait();
    assert.equal(await contract.contractURI(), nextContractUri);
    assert.equal(await contract.uri(1n), nextEventUri);
    await assert.rejects(contract.renounceOwnership(), /OwnershipRenouncementDisabled/);
  });

  it("allows only the owner to upgrade and preserves proxy state", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const proxyAddress = await contract.getAddress();
    const nonOwnerFactory = await ethers.getContractFactory(
      "AssociationBadgesUpgradeableV2",
      collector,
    );
    await assert.rejects(upgradesApi.upgradeProxy(proxyAddress, nonOwnerFactory, { kind: "uups" }));

    const ownerFactory = await ethers.getContractFactory("AssociationBadgesUpgradeableV2", owner);
    const upgraded = await upgradesApi.upgradeProxy(proxyAddress, ownerFactory, { kind: "uups" });
    await upgraded.waitForDeployment();
    assert.equal(await upgraded.implementationVersion(), 2n);
    assert.equal(await upgraded.owner(), owner.address);
    assert.equal(await upgraded.claimSigner(), signer.address);
    assert.equal(await upgraded.name(), "兆量富足教育協會數位紀念");
    assert.equal(await upgraded.symbol(), "TW");
    assert.equal(await upgraded.uri(1n), eventMetadataUri);

    const v3Factory = await ethers.getContractFactory("AssociationBadgesUpgradeableV3", owner);
    const rebranded = await upgradesApi.upgradeProxy(proxyAddress, v3Factory, { kind: "uups" });
    await rebranded.waitForDeployment();
    assert.equal(await rebranded.implementationVersion(), 3n);
    assert.equal(await rebranded.owner(), owner.address);
    assert.equal(await rebranded.claimSigner(), signer.address);
    assert.equal(await rebranded.name(), "底加（TĪ-TSIA）：有來過，就會記底加");
    assert.equal(await rebranded.symbol(), "HERE");
    assert.equal(await rebranded.uri(1n), eventMetadataUri);
  });

  it("upgrades to V4 and raises max supply in the same transaction, keeping claims and identity", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const proxyAddress = await contract.getAddress();
    await (await contract.createEvent(2n, 3n, "https://example.test/events/2.json")).wait();
    // Exhaust event 1 (max 3) before the upgrade.
    const deadline = BigInt((await networkHelpers.time.latest()) + 3600);
    const wallets = [collector, relayer, signer];
    for (const [i, wallet] of wallets.entries()) {
      const nonce = ethers.zeroPadValue(ethers.toBeHex(100 + i), 32);
      const sig = await authorization(proxyAddress, wallet.address, nonce, deadline);
      await (await contract.claimFor(wallet.address, 1n, deadline, nonce, sig)).wait();
    }
    const extraNonce = ethers.zeroPadValue(ethers.toBeHex(200), 32);
    const extraSig = await authorization(proxyAddress, owner.address, extraNonce, deadline);
    await assert.rejects(
      contract.claimFor(owner.address, 1n, deadline, extraNonce, extraSig),
      /SupplyExhausted/,
    );

    for (const name of ["AssociationBadgesUpgradeableV2", "AssociationBadgesUpgradeableV3"]) {
      const f = await ethers.getContractFactory(name, owner);
      await (await upgradesApi.upgradeProxy(proxyAddress, f, { kind: "uups" })).waitForDeployment();
    }
    const v4Factory = await ethers.getContractFactory("AssociationBadgesUpgradeableV4", owner);
    const v4 = await upgradesApi.upgradeProxy(proxyAddress, v4Factory, {
      kind: "uups",
      call: { fn: "increaseMaxSupply", args: [[1n, 2n], 3000n] },
    });
    await v4.waitForDeployment();
    assert.equal(await v4.implementationVersion(), 4n);
    assert.equal(await v4.name(), "底加（TĪ-TSIA）：有來過，就會記底加");
    assert.equal(await v4.symbol(), "HERE");
    assert.equal(await v4.owner(), owner.address);
    assert.equal(await v4.claimSigner(), signer.address);
    assert.equal((await v4.eventConfig(1n))[0], 3000n);
    assert.equal((await v4.eventConfig(1n))[1], true);
    assert.equal((await v4.eventConfig(1n))[2], eventMetadataUri);
    assert.equal((await v4.eventConfig(2n))[0], 3000n);
    assert.equal(await v4["totalSupply(uint256)"](1n), 3n);
    assert.equal(await v4.hasClaimed(1n, collector.address), true);

    // The fourth claim that failed before now succeeds; the used nonce stays used.
    await (await v4.claimFor(owner.address, 1n, deadline, extraNonce, extraSig)).wait();
    assert.equal(await v4["totalSupply(uint256)"](1n), 4n);
    const reuse = await authorization(proxyAddress, collector.address, extraNonce, deadline);
    await assert.rejects(
      v4.claimFor(collector.address, 1n, deadline, extraNonce, reuse),
      /AlreadyClaimed|NonceAlreadyUsed/,
    );
  });

  it("only lets the owner raise max supply, never lower it or touch missing events", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const proxyAddress = await contract.getAddress();
    const v4Factory = await ethers.getContractFactory("AssociationBadgesUpgradeableV4", owner);
    const v4 = await upgradesApi.upgradeProxy(proxyAddress, v4Factory, { kind: "uups" });
    await v4.waitForDeployment();
    await assert.rejects(
      (v4.connect(collector) as any).increaseMaxSupply([1n], 10n),
      /OwnableUnauthorizedAccount/,
    );
    await assert.rejects(v4.increaseMaxSupply([1n], 3n), /MaxSupplyNotIncreased/);
    await assert.rejects(v4.increaseMaxSupply([1n], 2n), /MaxSupplyNotIncreased/);
    await assert.rejects(v4.increaseMaxSupply([1n, 99n], 10n), /EventDoesNotExist/);
    // The failed batch did not partially apply.
    assert.equal((await v4.eventConfig(1n))[0], 3n);
    await (await v4.increaseMaxSupply([1n], 10n)).wait();
    assert.equal((await v4.eventConfig(1n))[0], 10n);
  });
});
