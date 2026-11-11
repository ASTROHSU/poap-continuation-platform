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
import { createIssuerEvent, updateIssuerEvent } from "../src/worker/issuer-admin";

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

async function request(
  path: string,
  method = "GET",
  authenticated = false,
  body?: Record<string, unknown>,
) {
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
        : {
            body: JSON.stringify(body ?? { didToken: "t".repeat(64), email: "admin@example.test" }),
          }),
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
    ["events", "POST"],
    ["gas", "GET"],
    ["events/example", "GET"],
    ["events/example", "PUT"],
    ["events/example/status", "POST"],
    ["events/example/issuance", "POST"],
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

const draftInput = () => ({
  requestId: crypto.randomUUID(),
  slug: "test-draft-new-event",
  title: "測試活動草稿",
  issuer: "測試發行單位",
  description: "僅供測試的活動說明",
  eventUrl: "https://example.test/event",
  startsAt: "2026-12-06T20:30:00+08:00",
  claimOpensAt: "2026-12-06T20:00:00+08:00",
  claimClosesAt: "2026-12-07T22:00:00+08:00",
  maxSupply: 100,
  claimMode: "shared",
  artwork: { type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
});

describe("authenticated draft creation", () => {
  it("creates a draft, survives an identical retry, and never assigns chain or claim credentials", async () => {
    const input = draftInput();
    const created = await request("events", "POST", true, input);
    expect(created.status).toBe(201);
    const data = (await created.json()) as {
      event: { eventId: string; slug: string; updatedAt: string };
    };
    expect(data).toMatchObject({
      replayed: false,
      event: {
        slug: input.slug,
        status: "draft",
        tokenId: null,
        contractAddress: null,
        chainId: 8453,
        maxSupply: 100,
      },
    });
    const retry = await request("events", "POST", true, input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      replayed: true,
      event: { eventId: data.event.eventId },
    });
    const claims = await bindings.LIVE_DB.prepare(
      "SELECT COUNT(*) AS count FROM live_claim_codes WHERE event_id = ?",
    )
      .bind(data.event.eventId)
      .first();
    expect(claims).toEqual({ count: 0 });
    const listing = await request("events", "GET", true);
    expect(await listing.json()).toMatchObject({
      items: [expect.objectContaining({ slug: input.slug, status: "draft" })],
    });
    const earlyPublish = await request(`events/${input.slug}/status`, "POST", true, {
      status: "published",
      expectedUpdatedAt: data.event.updatedAt,
    });
    expect(earlyPublish.status).toBe(409);
    expect(await earlyPublish.json()).toMatchObject({ code: "issuer_event_not_ready" });
  });

  it("rejects a competing slug or a changed request without replacing stored artwork", async () => {
    const input = draftInput();
    expect((await request("events", "POST", true, input)).status).toBe(201);
    const altered = await request("events", "POST", true, { ...input, title: "別的內容" });
    expect(altered.status).toBe(409);
    const duplicate = await request("events", "POST", true, {
      ...input,
      requestId: crypto.randomUUID(),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "issuer_event_exists" });
  });

  it.each([
    { maxSupply: 0 },
    { maxSupply: 1.5 },
    { maxSupply: 1000001 },
    { claimMode: "anyone" },
    { slug: "../bad" },
    { title: "" },
    { issuer: "" },
    { description: "" },
    { claimClosesAt: "2026-01-01T00:00:00Z" },
    { eventUrl: "javascript:alert(1)" },
    { artwork: null },
    { status: "published" },
    { tokenId: "10" },
    { requestId: "invalid" },
  ])("rejects invalid creation fields: %j", async (change) => {
    const response = await request("events", "POST", true, { ...draftInput(), ...change });
    expect(response.status).toBe(400);
    const rows = await bindings.LIVE_DB.prepare(
      "SELECT COUNT(*) AS count FROM live_event_draft_requests",
    ).first();
    expect(rows).toEqual({ count: 0 });
  });
});

describe("draft creation recovery", () => {
  const identity = {
    email: "admin@example.test",
    address: "0x1111111111111111111111111111111111111111" as const,
  };
  it("resumes a media failure using the reserved request without issuing credentials", async () => {
    const input = draftInput();
    const failedMedia = {
      ...bindings,
      ARCHIVE_BUCKET: {
        get: (...args: Parameters<R2Bucket["get"]>) => bindings.ARCHIVE_BUCKET.get(...args),
        put: async () => {
          throw new Error("temporary storage failure");
        },
      },
    };
    await expect(createIssuerEvent(failedMedia as never, identity, input)).rejects.toMatchObject({
      code: "issuer_draft_media_pending",
    });
    const retry = await createIssuerEvent(bindings, identity, input);
    expect(retry).toMatchObject({ replayed: true, event: { status: "draft", tokenId: null } });
    expect(
      await bindings.ARCHIVE_BUCKET.head(`live/events/${input.slug}/metadata.json`),
    ).not.toBeNull();
    const codes = await bindings.LIVE_DB.prepare(
      "SELECT COUNT(*) AS count FROM live_claim_codes",
    ).first();
    expect(codes).toEqual({ count: 0 });
  });
  it("handles simultaneous duplicate requests as one draft", async () => {
    const input = draftInput();
    const results = await Promise.all([
      createIssuerEvent(bindings, identity, input),
      createIssuerEvent(bindings, identity, input),
    ]);
    expect(results[0].event.eventId).toBe(results[1].event.eventId);
    expect(
      await bindings.LIVE_DB.prepare(
        "SELECT COUNT(*) AS count FROM live_event_draft_requests",
      ).first(),
    ).toEqual({ count: 1 });
  });
  it("does not overwrite a later edit when the original create request is retried", async () => {
    const input = draftInput();
    const first = await createIssuerEvent(bindings, identity, input);
    await updateIssuerEvent(bindings, identity, {
      ...first.event,
      expectedUpdatedAt: first.event.updatedAt,
      title: "Updated title",
    });
    const replay = await createIssuerEvent(bindings, identity, input);
    expect(replay.event.title).toBe("Updated title");
    const metadata = await bindings.ARCHIVE_BUCKET.get(`live/events/${input.slug}/metadata.json`);
    expect(await metadata.json()).toMatchObject({ name: "Updated title" });
  });
});
