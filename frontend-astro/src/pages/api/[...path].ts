import type { APIRoute } from "astro";
import { createProxyResponseHeaders, createUpstreamHeaders } from "../../lib/upstream-proxy";

export const prerender = false;

const workerOrigin =
  import.meta.env.WORKER_ORIGIN || "https://association-poap-pilot.mingnhsu.workers.dev";

export const ALL: APIRoute = async ({ params, request }) => {
  const incomingUrl = new URL(request.url);
  const path = params.path ?? "";
  // Admin APIs are served only by the Access-protected gateway service binding.
  if (path === "admin/issuer" || path.startsWith("admin/issuer/")) {
    return Response.json(
      { error: "Not found.", code: "not_found" },
      {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  const targetUrl = new URL(`/api/${path}${incomingUrl.search}`, workerOrigin);
  const headers = createUpstreamHeaders(request.headers);
  headers.set("origin", new URL(workerOrigin).origin);

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = createProxyResponseHeaders(upstream.headers, method);
  responseHeaders.set("x-content-type-options", "nosniff");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};
