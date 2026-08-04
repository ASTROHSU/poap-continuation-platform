import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { zeroAddress } from "viem";

const { viem, networkHelpers } = await network.create({
  network: "hardhatOp",
  chainType: "op",
});
const publicClient = await viem.getPublicClient();
const [owner, signer, collector, otherCollector] = await viem.getWalletClients();

const claimTypes = {
  Claim: [
    { name: "account", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function deployFixture() {
  const contract = await viem.deployContract("AssociationBadges", [
    owner.account.address,
    signer.account.address,
  ]);
  await contract.write.createEvent([1n, 2n, "https://example.test/metadata/1.json"], {
    account: owner.account,
  });
  return contract;
}

async function authorization(
  contractAddress: `0x${string}`,
  account: `0x${string}`,
  nonce: `0x${string}`,
  deadline: bigint,
) {
  return signer.signTypedData({
    account: signer.account,
    domain: {
      name: "AssociationBadges",
      version: "1",
      chainId: await publicClient.getChainId(),
      verifyingContract: contractAddress,
    },
    types: claimTypes,
    primaryType: "Claim",
    message: { account, tokenId: 1n, deadline, nonce },
  });
}

describe("AssociationBadges", () => {
  it("mints one badge with a valid EIP-712 authorization", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    const nonce = `0x${"11".repeat(32)}` as const;
    const signature = await authorization(
      contract.address,
      collector.account.address,
      nonce,
      deadline,
    );

    await viem.assertions.emitWithArgs(
      contract.write.claim([1n, deadline, nonce, signature], { account: collector.account }),
      contract,
      "TransferSingle",
      [collector.account.address, zeroAddress, collector.account.address, 1n, 1n],
    );
    assert.equal(await contract.read.balanceOf([collector.account.address, 1n]), 1n);
    assert.equal(await contract.read.totalSupply([1n]), 1n);
    assert.equal(await contract.read.hasClaimed([1n, collector.account.address]), true);
  });

  it("lets a relayer pay gas while minting to the signed collector", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    const nonce = `0x${"19".repeat(32)}` as const;
    const signature = await authorization(
      contract.address,
      collector.account.address,
      nonce,
      deadline,
    );

    await viem.assertions.emitWithArgs(
      contract.write.claimFor([collector.account.address, 1n, deadline, nonce, signature], {
        account: otherCollector.account,
      }),
      contract,
      "TransferSingle",
      [otherCollector.account.address, zeroAddress, collector.account.address, 1n, 1n],
    );
    assert.equal(await contract.read.balanceOf([collector.account.address, 1n]), 1n);
    assert.equal(await contract.read.balanceOf([otherCollector.account.address, 1n]), 0n);
  });

  it("rejects replay by the same address or nonce", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    const nonce = `0x${"22".repeat(32)}` as const;
    const firstSignature = await authorization(
      contract.address,
      collector.account.address,
      nonce,
      deadline,
    );
    await contract.write.claim([1n, deadline, nonce, firstSignature], {
      account: collector.account,
    });

    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, deadline, nonce, firstSignature], {
        account: collector.account,
      }),
      contract,
      "AlreadyClaimed",
    );

    const replaySignature = await authorization(
      contract.address,
      otherCollector.account.address,
      nonce,
      deadline,
    );
    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, deadline, nonce, replaySignature], {
        account: otherCollector.account,
      }),
      contract,
      "NonceAlreadyUsed",
    );
  });

  it("enforces supply, expiry, signer, event status, and owner controls", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const now = await networkHelpers.time.latest();
    const validDeadline = BigInt(now + 900);

    const wrongSignature = await collector.signTypedData({
      account: collector.account,
      domain: {
        name: "AssociationBadges",
        version: "1",
        chainId: await publicClient.getChainId(),
        verifyingContract: contract.address,
      },
      types: claimTypes,
      primaryType: "Claim",
      message: {
        account: collector.account.address,
        tokenId: 1n,
        deadline: validDeadline,
        nonce: `0x${"33".repeat(32)}`,
      },
    });
    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, validDeadline, `0x${"33".repeat(32)}`, wrongSignature], {
        account: collector.account,
      }),
      contract,
      "InvalidAuthorization",
    );

    const expiredDeadline = BigInt(now - 1);
    const expiredNonce = `0x${"44".repeat(32)}` as const;
    const expiredSignature = await authorization(
      contract.address,
      collector.account.address,
      expiredNonce,
      expiredDeadline,
    );
    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, expiredDeadline, expiredNonce, expiredSignature], {
        account: collector.account,
      }),
      contract,
      "AuthorizationExpired",
    );

    await viem.assertions.revertWithCustomError(
      contract.write.setEventActive([1n, false], { account: collector.account }),
      contract,
      "OwnableUnauthorizedAccount",
    );
    await contract.write.setEventActive([1n, false], { account: owner.account });
    const inactiveNonce = `0x${"55".repeat(32)}` as const;
    const inactiveSignature = await authorization(
      contract.address,
      collector.account.address,
      inactiveNonce,
      validDeadline,
    );
    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, validDeadline, inactiveNonce, inactiveSignature], {
        account: collector.account,
      }),
      contract,
      "EventInactive",
    );
  });

  it("rejects a third mint after the event supply is exhausted", async () => {
    const contract = await networkHelpers.loadFixture(deployFixture);
    const deadline = BigInt((await networkHelpers.time.latest()) + 900);
    for (const [index, wallet] of [collector, otherCollector].entries()) {
      const nonce = `0x${String(index + 6).repeat(64)}` as `0x${string}`;
      const signature = await authorization(
        contract.address,
        wallet.account.address,
        nonce,
        deadline,
      );
      await contract.write.claim([1n, deadline, nonce, signature], { account: wallet.account });
    }

    const wallets = await viem.getWalletClients();
    const third = wallets[4];
    const nonce = `0x${"88".repeat(32)}` as const;
    const signature = await authorization(contract.address, third.account.address, nonce, deadline);
    await viem.assertions.revertWithCustomError(
      contract.write.claim([1n, deadline, nonce, signature], { account: third.account }),
      contract,
      "SupplyExhausted",
    );
  });
});
