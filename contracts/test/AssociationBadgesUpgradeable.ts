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
  });
});
