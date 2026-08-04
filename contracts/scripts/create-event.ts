import { network } from "hardhat";
import { getAddress } from "viem";

const contractAddress = getAddress(required("CONTRACT_ADDRESS"));
const tokenId = unsignedInteger("TOKEN_ID");
const maxSupply = unsignedInteger("MAX_SUPPLY");
const metadataUri = required("METADATA_URI");
if (!/^https:\/\//.test(metadataUri)) throw new Error("METADATA_URI must use https.");

console.log("現在請輸入 Hardhat keystore 密碼並按 Enter；輸入時不會顯示字元。");
const { viem, networkName } = await network.create();
if (networkName !== "baseSepolia") {
  throw new Error("Event creation is restricted to --network baseSepolia in Phase 2.");
}
const [owner] = await viem.getWalletClients();
const contract = await viem.getContractAt("AssociationBadges", contractAddress);
const hash = await contract.write.createEvent([tokenId, maxSupply, metadataUri], {
  account: owner.account,
});
const publicClient = await viem.getPublicClient();
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Event creation reverted.");
console.log(
  JSON.stringify(
    {
      network: networkName,
      chainId: await publicClient.getChainId(),
      contractAddress,
      tokenId: tokenId.toString(),
      maxSupply: maxSupply.toString(),
      metadataUri,
      owner: owner.account.address,
      transactionHash: hash,
      blockNumber: receipt.blockNumber.toString(),
    },
    null,
    2,
  ),
);

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function unsignedInteger(name: string) {
  const value = required(name);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an unsigned integer.`);
  return BigInt(value);
}
