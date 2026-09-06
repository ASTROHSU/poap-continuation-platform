interface Env {
  ADMIN_BACKEND: Fetcher;
  ADMIN_GATEWAY_SECRET: string;
  FRONTEND_ORIGIN: string;
}

const ADMIN_API_PREFIX = "/api/admin/issuer";
const CONFIG_PATH = "/api/meta";
const APP_CONFIG_PATH = "/api/app-config";
const BACKEND_ORIGIN = "https://association-poap-pilot.mingnhsu.workers.dev";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const frontend = validatedFrontendOrigin(env.FRONTEND_ORIGIN);
    const secret = String(env.ADMIN_GATEWAY_SECRET || "");
    if (secret.length < 32) return unavailable();

    if (
      incoming.pathname === CONFIG_PATH ||
      incoming.pathname === APP_CONFIG_PATH ||
      incoming.pathname.startsWith(`${ADMIN_API_PREFIX}/`) ||
      incoming.pathname === ADMIN_API_PREFIX
    ) {
      if (
        !SAFE_METHODS.has(request.method.toUpperCase()) &&
        !isSameOriginBrowserRequest(request, incoming.origin)
      ) {
        return json(
          { error: "This request did not come from the management site.", code: "invalid_origin" },
          403,
        );
      }
      return proxyBackend(request, env.ADMIN_BACKEND, incoming);
    }

    if (incoming.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    if (!hasAccessAssertion(request)) {
      return json(
        { error: "Cloudflare Access authentication is required.", code: "access_required" },
        401,
      );
    }
    return proxyFrontend(request, frontend, secret, incoming);
  },
};

function hasAccessAssertion(request: Request): boolean {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim() || "";
  return assertion.length >= 64 && assertion.length <= 16_384 && assertion.split(".").length === 3;
}

async function proxyBackend(request: Request, backend: Fetcher, incoming: URL): Promise<Response> {
  const headers = new Headers();
  for (const name of [
    "accept",
    "authorization",
    "cf-access-jwt-assertion",
    "content-type",
    "user-agent",
    "x-issuer-email",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", BACKEND_ORIGIN);
  const body = SAFE_METHODS.has(request.method.toUpperCase())
    ? undefined
    : await request.arrayBuffer();
  const response = await backend.fetch(
    new Request(`${BACKEND_ORIGIN}${incoming.pathname}${incoming.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    }),
  );
  return securedResponse(response);
}

async function proxyFrontend(
  request: Request,
  frontend: URL,
  secret: string,
  incoming: URL,
): Promise<Response> {
  // The admin hostname is an application boundary, not an alternate hostname
  // for the public collection site. Keep the clean root URL while rendering
  // the private issuer manager after Cloudflare Access has authorized it.
  const frontendPath = incoming.pathname === "/" ? "/issuer/manage" : incoming.pathname;
  const target = new URL(frontend);
  target.pathname = frontendPath;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of [
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cf-access-jwt-assertion",
    "cf-authorization-token",
    "cookie",
    "authorization",
    "host",
    "content-length",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-issuer-email",
  ]) {
    headers.delete(name);
  }
  headers.set("x-titsia-admin-gateway", secret);
  const body = SAFE_METHODS.has(request.method.toUpperCase())
    ? undefined
    : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  const response = securedResponse(upstream);
  const location = response.headers.get("location");
  if (location) {
    const redirect = new URL(location, frontend);
    if (redirect.origin === frontend.origin) {
      response.headers.set(
        "location",
        `${incoming.origin}${redirect.pathname}${redirect.search}${redirect.hash}`,
      );
    }
  }
  return response;
}

function securedResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("cache-control", "private, no-store");
  headers.set(
    "content-security-policy",
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function isSameOriginBrowserRequest(request: Request, origin: string): boolean {
  const browserOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return browserOrigin === origin && (!fetchSite || fetchSite === "same-origin");
}

function validatedFrontendOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("FRONTEND_ORIGIN is invalid.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FRONTEND_ORIGIN must be an HTTPS origin.");
  }
  return url;
}

function unavailable(): Response {
  return json(
    { error: "Management gateway is not configured.", code: "gateway_unconfigured" },
    503,
  );
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
