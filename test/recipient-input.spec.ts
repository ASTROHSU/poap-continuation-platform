import { describe, expect, it } from "vitest";
import { looksLikeEnsName } from "../frontend-astro/src/lib/recipient-input";

describe("recipient ENS input detection", () => {
  it("accepts all POAP Nickname suffixes and ordinary ENS names", () => {
    expect(looksLikeEnsName("renie.poap.xyz")).toBe(true);
    expect(looksLikeEnsName("clover.onpoap.eth")).toBe(true);
    expect(looksLikeEnsName("name.withpoap.eth")).toBe(true);
    expect(looksLikeEnsName("vitalik.eth")).toBe(true);
  });

  it("leaves email and malformed values to their own validation paths", () => {
    expect(looksLikeEnsName("person@example.com")).toBe(false);
    expect(looksLikeEnsName("not a name.eth")).toBe(false);
    expect(looksLikeEnsName(".eth")).toBe(false);
    expect(looksLikeEnsName("name.eth.")).toBe(false);
    expect(looksLikeEnsName("0x1234")).toBe(false);
  });
});
