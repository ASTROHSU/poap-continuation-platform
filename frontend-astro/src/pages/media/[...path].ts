import type { APIRoute } from "astro";

export const prerender = false;

const workerOrigin =
  import.meta.env.WORKER_ORIGIN || "https://association-poap-pilot.mingnhsu.workers.dev";

export const GET: APIRoute = async ({ params, request }) => {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/media/${params.path ?? ""}${incomingUrl.search}`, workerOrigin);
  const upstream = await fetch(targetUrl, {
    headers: { Accept: request.headers.get("accept") ?? "*/*" },
  });
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
};
