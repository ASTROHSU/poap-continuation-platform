import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { associationBadgesAbi } from "../src/shared/association-badges";
import { receiptContainsMint } from "../src/worker/minting";

const contract = "0x1111111111111111111111111111111111111111";
const collector = "0x2222222222222222222222222222222222222222";

describe("mint receipt verification", () => {
  it("accepts only the expected ERC-1155 mint log", () => {
    const topics = encodeEventTopics({
      abi: associationBadgesAbi,
      eventName: "TransferSingle",
      args: {
        operator: collector,
        from: zeroAddress,
        to: collector,
      },
    });
    const receipt = {
      logs: [
        {
          address: contract,
          topics,
          data: encodeAbiParameters(
            [
              { name: "id", type: "uint256" },
              { name: "value", type: "uint256" },
            ],
            [7n, 1n],
          ),
        },
      ],
    };

    expect(receiptContainsMint(receipt as never, contract, collector, 7n)).toBe(true);
    expect(receiptContainsMint(receipt as never, contract, collector, 8n)).toBe(false);
    expect(
      receiptContainsMint(
        receipt as never,
        contract,
        "0x3333333333333333333333333333333333333333",
        7n,
      ),
    ).toBe(false);
  });
});
