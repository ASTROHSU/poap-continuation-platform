import { describe, expect, it } from "vitest";
import {
  isIssuerAdminEmail,
  issuerAdminEmails,
  requireIssuerAdmin,
} from "../src/worker/issuer-admin";

describe("issuer admin allowlist", () => {
  it("normalizes comma-separated emails and ignores blank entries", () => {
    expect([...issuerAdminEmails(" Admin@Example.com, ,owner@example.com ")]).toEqual([
      "admin@example.com",
      "owner@example.com",
    ]);
  });

  it("fails closed when no administrator is configured", () => {
    expect(isIssuerAdminEmail("admin@example.com", undefined)).toBe(false);
    expect(isIssuerAdminEmail("admin@example.com", "")).toBe(false);
  });

  it("matches only exact normalized email addresses", () => {
    expect(isIssuerAdminEmail("ADMIN@example.com", "admin@example.com")).toBe(true);
    expect(isIssuerAdminEmail("not-admin@example.com", "admin@example.com")).toBe(false);
  });

  it("rejects malformed credentials before contacting Magic", async () => {
    await expect(
      requireIssuerAdmin(
        { ISSUER_ADMIN_EMAILS: "admin@example.com" } as never,
        new Request("https://worker.example/api/admin/issuer/events"),
        { didToken: "too-short", email: "admin@example.com" },
      ),
    ).rejects.toMatchObject({ status: 401, code: "issuer_admin_auth_required" });
  });
});
