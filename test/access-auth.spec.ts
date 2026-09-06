import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { accessAdminEmails, accessIssuer, requireAccessAdmin } from "../src/worker/access-auth";

const issuer = "https://titsia-admin.cloudflareaccess.com";
const audience = "admin-app-audience";

describe("Cloudflare Access administrator authentication", () => {
  it("normalizes the administrator allowlist", () => {
    expect([...accessAdminEmails(" Admin@Example.com,owner@example.com ")]).toEqual([
      "admin@example.com",
      "owner@example.com",
    ]);
  });

  it("accepts only an HTTPS cloudflareaccess.com issuer", () => {
    expect(accessIssuer(`${issuer}/`)).toBe(issuer);
    expect(() => accessIssuer("https://example.com")).toThrowError(
      expect.objectContaining({ code: "access_unconfigured" }),
    );
  });

  it("verifies signature, issuer, audience, subject, and allowed email", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "Admin@Example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("access-user-id")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const identity = await requireAccessAdmin(
      {
        ACCESS_TEAM_DOMAIN: issuer,
        ACCESS_POLICY_AUD: audience,
        ACCESS_ADMIN_EMAILS: "admin@example.com",
      },
      new Request("https://worker.example/api/admin/issuer/events", {
        headers: { "cf-access-jwt-assertion": token },
      }),
      async () => publicKey,
    );
    expect(identity).toEqual({ email: "admin@example.com", subject: "access-user-id" });
  });

  it("rejects a valid token for another Access application", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("another-application")
      .setSubject("access-user-id")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      requireAccessAdmin(
        {
          ACCESS_TEAM_DOMAIN: issuer,
          ACCESS_POLICY_AUD: audience,
          ACCESS_ADMIN_EMAILS: "admin@example.com",
        },
        new Request("https://worker.example/api/admin/issuer/events", {
          headers: { "cf-access-jwt-assertion": token },
        }),
        async () => publicKey,
      ),
    ).rejects.toMatchObject({ status: 401, code: "access_invalid" });
  });
});
