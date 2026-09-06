import {
  applyD1Migrations,
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";

// Only the external Magic service is stubbed; the app routes, Access signature
// verification, issuer allowlist and D1 event listing execute normally.
vi.mock("../src/worker/magic-auth", async (original) => ({
  ...(await original<typeof import("../src/worker/magic-auth")>()),
  verifyMagicIdentity: vi.fn(async () => ({
    email: "admin@example.test",
    address: "0x1111111111111111111111111111111111111111",
  })),
}));

const bindings = {
  ...env,
  APP_MODE: "live-only",
  ISSUER_ADMIN_EMAILS: "admin@example.test",
} as any;
let accessToken: string;
beforeAll(async () => {
  await applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "release-test", alg: "RS256" };
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(bindings.ACCESS_TEAM_DOMAIN)
    .intercept({ path: "/cdn-cgi/access/certs" })
    .reply(200, { keys: [jwk] });
  accessToken = await new SignJWT({ email: "admin@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "release-test" })
    .setIssuer(bindings.ACCESS_TEAM_DOMAIN)
    .setAudience(bindings.ACCESS_POLICY_AUD)
    .setSubject("release-test-admin")
    .setExpirationTime("5m")
    .sign(privateKey);
});
afterAll(() => fetchMock.deactivate());

async function request(path: string, method = "GET", authenticated = false) {
  const headers: Record<string, string> = {
    origin: "https://worker.example",
    "content-type": "application/json",
  };
  if (authenticated)
    Object.assign(headers, {
      "cf-access-jwt-assertion": accessToken,
      authorization: `Bearer ${"t".repeat(64)}`,
      "x-issuer-email": "admin@example.test",
    });
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://worker.example/api/admin/issuer/${path}`, {
      method,
      headers,
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify({ didToken: "t".repeat(64), email: "admin@example.test" }) }),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("production admin release contract", () => {
  it.each([
    ["session", "POST"],
    ["events", "GET"],
    ["gas", "GET"],
    ["events/example", "GET"],
    ["events/example", "PUT"],
    ["events/example/status", "POST"],
  ])(
    "%s %s exists and rejects unauthenticated requests in live-only mode",
    async (path, method) => {
      const response = await request(path, method);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "access_required" });
    },
  );
  it("authenticates then lists events through the real app and database", async () => {
    const session = await request("session", "POST", true);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      email: "admin@example.test",
    });
    expect(session.status).toBe(200);
    const gas = await request("gas", "GET", true);
    expect(gas.status).toBe(200);
    expect(await gas.json()).toMatchObject({ notificationsConfigured: false, items: [] });
    const listing = await request("events", "GET", true);
    expect(await listing.json()).toEqual({ items: [] });
    expect(listing.status).toBe(200);
    expect(listing.headers.get("cache-control")).toBe("private, no-store");
  });
});
