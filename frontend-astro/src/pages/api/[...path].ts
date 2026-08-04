import type { APIRoute } from "astro";

export const prerender = false;

const workerOrigin =
  import.meta.env.WORKER_ORIGIN || "https://association-poap-pilot.mingnhsu.workers.dev";

export const ALL: APIRoute = async ({ params, request }) => {
  const incomingUrl = new URL(request.url);
  const path = params.path ?? "";
  const targetUrl = new URL(`/api/${path}${incomingUrl.search}`, workerOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("origin", new URL(workerOrigin).origin);

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.set("x-content-type-options", "nosniff");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};
