import { createPublicClient, http, isAddress, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { ApiError } from "./validation";

export const DEFAULT_ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com";

const ENS_CACHE_SCHEMA = "ens-v2";
const ENS_NAME_MAX_BYTES = 255;
const ENS_LABEL_MAX_BYTES = 63;
const ENS_POSITIVE_EDGE_TTL_SECONDS = 604_800;
const ENS_NEGATIVE_EDGE_TTL_SECONDS = 300;
const ENS_BROWSER_TTL_SECONDS = 300;
const UTF8 = new TextEncoder();

export type EnsLookup = (name: string, rpcUrl: string) => Promise<string | null>;

interface EnsCacheOptions {
  requestUrl: string;
  name: string;
  apiVersion: string;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

export function parseEnsNameQuery(url: URL): string {
  const names = url.searchParams.getAll("name");
  let parameterCount = 0;
  url.searchParams.forEach(() => {
    parameterCount += 1;
  });
  if (parameterCount !== 1 || names.length !== 1) {
    throw new ApiError(400, "Provide exactly one ENS name using the name parameter.");
  }
  return normalizeEnsName(names[0] ?? "");
}

export function normalizeEnsName(raw: string): string {
  const candidate = raw.trim();
  if (
    candidate.length === 0 ||
    UTF8.encode(candidate).byteLength > ENS_NAME_MAX_BYTES ||
    /\p{Cc}/u.test(candidate)
  ) {
    throw invalidEnsName();
  }

  let name: string;
  try {
    name = normalize(candidate);
  } catch {
    throw invalidEnsName();
  }

  const labels = name.split(".");
  if (
    labels.length < 2 ||
    UTF8.encode(name).byteLength > ENS_NAME_MAX_BYTES ||
    labels.some(
      (label) =>
        label.length === 0 ||
        UTF8.encode(label).byteLength > ENS_LABEL_MAX_BYTES ||
        /\p{Cc}/u.test(label),
    )
  ) {
    throw invalidEnsName();
  }
  return name;
}

export function ethereumRpcUrl(configured: string | undefined): string {
  const value = configured?.trim() || DEFAULT_ETHEREUM_RPC_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw ensUnavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw ensUnavailable();
  }
  return url.toString();
}

export async function resolveEnsAddress(
  name: string,
  rpcUrl: string,
  lookup: EnsLookup = lookupEnsAddress,
): Promise<string | null> {
  let address: string | null;
  try {
    address = await lookup(name, rpcUrl);
  } catch {
    throw ensUnavailable();
  }
  if (address === null || address.toLowerCase() === zeroAddress) return null;
  if (!isAddress(address, { strict: false })) throw ensUnavailable();
  return address.toLowerCase();
}

/**
 * ENS records are mutable, so they use a bounded cache independent of archive
 * snapshots. Unresolved names are cached at the edge for five minutes to keep
 * repeated misses from reaching the RPC provider.
 */
export async function withEnsCache(
  options: EnsCacheOptions,
  load: () => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const apiVersion = `${options.apiVersion}.${ENS_CACHE_SCHEMA}`;
  const cacheKey = makeEnsCacheKey(options.requestUrl, options.name, apiVersion);

  try {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeader(hit, "X-Archive-Cache", "HIT");
  } catch {
    // A transient Cache API error must not make ENS lookup unavailable.
  }

  const generated = await load();
  if (
    (generated.status !== 200 && generated.status !== 404) ||
    generated.headers.has("Set-Cookie")
  ) {
    return generated;
  }

  const edgeTtl =
    generated.status === 200 ? ENS_POSITIVE_EDGE_TTL_SECONDS : ENS_NEGATIVE_EDGE_TTL_SECONDS;
  const browserTtl = generated.status === 200 ? ENS_BROWSER_TTL_SECONDS : 0;
  const headers = new Headers(generated.headers);
  headers.set("Cache-Control", `public, max-age=${browserTtl}, s-maxage=${edgeTtl}`);
  headers.set("X-Archive-API-Version", apiVersion);
  const response = new Response(generated.body, {
    status: generated.status,
    statusText: generated.statusText,
    headers,
  });

  const cacheCopy = response.clone();
  options.executionCtx.waitUntil(cache.put(cacheKey, cacheCopy).catch(() => undefined));
  return withHeader(response, "X-Archive-Cache", "MISS");
}

async function lookupEnsAddress(name: string, rpcUrl: string): Promise<string | null> {
  const client = createPublicClient({
    chain: mainnet,
    // POAP Nicknames such as name.onpoap.eth, name.withpoap.eth, and
    // name.poap.xyz use ENS wildcard/offchain resolution. Keeping CCIP Read
    // enabled is required for those names to resolve to their wallet address.
    ccipRead: {},
    transport: http(rpcUrl, {
      retryCount: 0,
      timeout: 3_500,
    }),
  });
  return client.getEnsAddress({ name });
}

function makeEnsCacheKey(requestUrl: string, name: string, apiVersion: string): Request {
  const url = new URL(requestUrl);
  url.pathname = "/api/resolve-address";
  url.search = "";
  url.searchParams.set("name", name);
  url.searchParams.set("__archive_api", apiVersion);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function invalidEnsName(): ApiError {
  return new ApiError(400, "Enter a valid ENS name such as name.eth.", "invalid_ens_name");
}

function ensUnavailable(): ApiError {
  return new ApiError(503, "ENS lookup is temporarily unavailable.", "ens_unavailable");
}
