import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Bindings } from "./types";
import { normalizeEmail } from "./email-auth";
import { ApiError } from "./validation";

const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

interface AccessJwtPayload extends JWTPayload {
  email?: unknown;
}

export interface AccessAdminIdentity {
  email: string;
  subject: string;
}

export function accessAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function accessIssuer(value: string | undefined): string {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw accessUnavailable();
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw accessUnavailable();
  }
  return url.origin;
}

export async function requireAccessAdmin(
  env: Pick<Bindings, "ACCESS_TEAM_DOMAIN" | "ACCESS_POLICY_AUD" | "ACCESS_ADMIN_EMAILS">,
  request: Request,
  getKey?: JWTVerifyGetKey,
): Promise<AccessAdminIdentity> {
  const audience = String(env.ACCESS_POLICY_AUD || "").trim();
  const allowedEmails = accessAdminEmails(env.ACCESS_ADMIN_EMAILS);
  if (!audience || allowedEmails.size === 0) throw accessUnavailable();

  const token = request.headers.get("cf-access-jwt-assertion")?.trim() || "";
  if (
    token.length < 64 ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    token.split(".").length !== 3
  ) {
    throw new ApiError(401, "Cloudflare Access authentication is required.", "access_required");
  }

  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  const resolver = getKey || remoteJwkSet(issuer);
  let payload: AccessJwtPayload;
  try {
    ({ payload } = await jwtVerify<AccessJwtPayload>(token, resolver, {
      issuer,
      audience,
      algorithms: ["RS256"],
    }));
  } catch {
    throw new ApiError(401, "Cloudflare Access session is invalid or expired.", "access_invalid");
  }

  if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
    throw new ApiError(403, "Cloudflare Access identity is not allowed.", "access_forbidden");
  }
  let email: string;
  try {
    email = normalizeEmail(payload.email);
  } catch {
    throw new ApiError(403, "Cloudflare Access identity is not allowed.", "access_forbidden");
  }
  if (!allowedEmails.has(email)) {
    throw new ApiError(403, "Cloudflare Access identity is not allowed.", "access_forbidden");
  }
  return { email, subject: payload.sub };
}

function remoteJwkSet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = remoteKeySets.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${issuer}/`), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  remoteKeySets.set(issuer, created);
  return created;
}

function accessUnavailable(): ApiError {
  return new ApiError(503, "Cloudflare Access is not configured.", "access_unconfigured");
}
