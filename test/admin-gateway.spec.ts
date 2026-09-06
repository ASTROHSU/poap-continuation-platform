import { describe, expect, it, vi } from "vitest";
import gateway from "../workers/admin-gateway/index";

function env(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ADMIN_BACKEND: { fetch: vi.fn(async () => Response.json({ ok: true })) },
    ADMIN_GATEWAY_SECRET: "g".repeat(48),
    FRONTEND_ORIGIN: "https://frontend.example.test",
    ...overrides,
  } as any;
}

describe("issuer admin gateway", () => {
  it("rejects unsafe cross-origin admin requests", async () => {
    const response = await gateway.fetch(
      new Request("https://admin.example.test/api/admin/issuer/events/demo", {
        method: "PUT",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
      env(),
    );
    expect(response.status).toBe(403);
  });

  it("forwards Access and Magic identity headers to the backend", async () => {
    const bindings = env();
    const response = await gateway.fetch(
      new Request("https://admin.example.test/api/admin/issuer/events", {
        headers: {
          authorization: "Bearer magic-token",
          "cf-access-jwt-assertion": "access-token",
          "x-issuer-email": "admin@example.com",
        },
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    const forwarded = bindings.ADMIN_BACKEND.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("cf-access-jwt-assertion")).toBe("access-token");
    expect(forwarded.headers.get("authorization")).toBe("Bearer magic-token");
    expect(forwarded.headers.get("x-issuer-email")).toBe("admin@example.com");
    expect(new URL(forwarded.url).origin).toBe(
      "https://association-poap-pilot.mingnhsu.workers.dev",
    );
  });

  it("serves the embedded-wallet configuration required by the admin login", async () => {
    const bindings = env();
    const response = await gateway.fetch(
      new Request("https://admin.example.test/api/app-config"),
      bindings,
    );
    expect(response.status).toBe(200);
    const forwarded = bindings.ADMIN_BACKEND.fetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/api/app-config");
  });

  it("adds the private gateway header before loading the frontend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("admin"));
    const response = await gateway.fetch(
      new Request("https://admin.example.test/issuer/manage", {
        headers: {
          authorization: "Bearer should-not-leak",
          cookie: "CF_Authorization=should-not-leak",
          "cf-access-jwt-assertion": `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}`,
        },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const forwarded = fetchMock.mock.calls[0][0] as URL;
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(String(forwarded)).toBe("https://frontend.example.test/issuer/manage");
    expect(new Headers(init.headers).get("x-titsia-admin-gateway")).toBe("g".repeat(48));
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(new Headers(init.headers).get("cookie")).toBeNull();
    expect(new Headers(init.headers).get("cf-access-jwt-assertion")).toBeNull();
    fetchMock.mockRestore();
  });

  it("renders the private manager at the admin hostname root", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("admin"));
    const response = await gateway.fetch(
      new Request("https://admin.example.test/", {
        headers: {
          "cf-access-jwt-assertion": `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}`,
        },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const forwarded = fetchMock.mock.calls[0][0] as URL;
    expect(String(forwarded)).toBe("https://frontend.example.test/issuer/manage");
    fetchMock.mockRestore();
  });

  it("fails closed before serving the manager without an Access assertion", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await gateway.fetch(new Request("https://admin.example.test/"), env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "access_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("does not expose unrelated public API routes through the private gateway", async () => {
    const response = await gateway.fetch(
      new Request("https://admin.example.test/api/live/events"),
      env(),
    );
    expect(response.status).toBe(404);
  });
});
