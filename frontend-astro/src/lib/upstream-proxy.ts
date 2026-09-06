export function createUpstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("accept-encoding", "identity");
  return headers;
}

const MAX_VERCEL_CDN_TTL_SECONDS = 300;

export function createProxyResponseHeaders(upstream: Headers, method: string): Headers {
  const headers = new Headers(upstream);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("vercel-cdn-cache-control");

  const cacheControl = headers.get("cache-control") ?? "";
  const publicRead =
    (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") &&
    /(?:^|,)\s*public\s*(?:,|$)/i.test(cacheControl) &&
    !/(?:^|,)\s*(?:private|no-store)\b/i.test(cacheControl) &&
    !headers.has("set-cookie");

  if (!publicRead) {
    headers.set("cache-control", "private, no-store");
    headers.delete("cdn-cache-control");
    return headers;
  }

  const sharedTtl = /(?:^|,)\s*s-maxage=(\d+)\b/i.exec(cacheControl)?.[1];
  if (sharedTtl) {
    headers.set(
      "vercel-cdn-cache-control",
      `public, s-maxage=${Math.min(Number(sharedTtl), MAX_VERCEL_CDN_TTL_SECONDS)}`,
    );
  }

  return headers;
}
