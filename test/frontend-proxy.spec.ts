import { describe, expect, it } from "vitest";
import {
  createProxyResponseHeaders,
  createUpstreamHeaders,
} from "../frontend-astro/src/lib/upstream-proxy";

describe("Astro upstream proxy headers", () => {
  it("prevents compressed upstream bodies from crossing the runtime boundary", () => {
    const headers = createUpstreamHeaders(
      new Headers({
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        Authorization: "Bearer session-token",
        "Content-Length": "123",
        Host: "poap.blocktrend.today",
      }),
    );

    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("content-length")).toBe(false);
    expect(headers.has("host")).toBe(false);
  });

  it("preserves public browser caching and caps Vercel edge caching", () => {
    const headers = createProxyResponseHeaders(
      new Headers({
        "Cache-Control": "public, max-age=300, s-maxage=86400",
        "Content-Encoding": "gzip",
        "Content-Length": "123",
      }),
      "GET",
    );

    expect(headers.get("cache-control")).toBe("public, max-age=300, s-maxage=86400");
    expect(headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=300");
    expect(headers.has("content-encoding")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
  });

  it("keeps shorter upstream edge TTLs intact", () => {
    const headers = createProxyResponseHeaders(
      new Headers({ "Cache-Control": "public, max-age=15, s-maxage=30" }),
      "GET",
    );

    expect(headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=30");
  });

  it.each([
    ["private response", "GET", { "Cache-Control": "private, no-store" }],
    ["mutation", "POST", { "Cache-Control": "public, max-age=300, s-maxage=300" }],
    [
      "cookie-setting response",
      "GET",
      { "Cache-Control": "public, max-age=300, s-maxage=300", "Set-Cookie": "session=secret" },
    ],
  ])("never shares a %s", (_label, method, input) => {
    const headers = createProxyResponseHeaders(new Headers(input), method);

    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.has("vercel-cdn-cache-control")).toBe(false);
    expect(headers.has("cdn-cache-control")).toBe(false);
  });
});
