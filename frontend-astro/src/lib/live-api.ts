export interface LiveEvent {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  eventUrl: string | null;
  startsAt: string;
  claimOpensAt: string;
  claimClosesAt: string;
  chainId: number;
  contractAddress: string | null;
  tokenId: string | null;
  maxSupply: number;
  claimedCount: number;
  mintedCount: number;
  claimMode: "unique" | "shared";
  status: "draft" | "published" | "closed";
}

export interface LiveHolding extends LiveEvent {
  claimedAt: string;
  mintStatus: "reserved" | "minted";
  mintedTxHash: `0x${string}` | null;
  mintedAt: string | null;
  ownershipSource: "claim-record" | "chain-index";
  chainSyncedAt: string | null;
  chainFinalizedBlock: number | null;
}

export interface ArchiveHolding {
  dropId: number;
  fancyId: string;
  title: string;
  startDate: string;
  city: string | null;
  country: string | null;
  year: number;
  isVirtual: boolean | null;
  imageUrl: string;
  hasArtwork: boolean;
  tokenCount: number;
  sourceUid: string;
  poapId: number;
  mintedOn: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface ArchiveHoldingsResponse {
  address: string;
  total: number;
  uniqueDrops: number;
  items: ArchiveHolding[];
  nextCursor: string | null;
}

export interface ArchiveCollector {
  poapId: number;
  ownerAddress: string;
  mintedOn: number | null;
  network: string;
  transferCount: number;
}

export interface ArchiveCollectorsResponse {
  snapshotId: string;
  dropId: number;
  items: ArchiveCollector[];
  nextCursor: string | null;
}

export interface LiveCollector {
  ownerAddress: string;
  acquiredAt: string;
}

export interface LiveCollectorsResponse {
  eventId: string;
  slug: string;
  chainId: number;
  collectorCount: number;
  items: LiveCollector[];
}

export interface ArchiveDropDetail {
  dropId: number;
  fancyId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  city: string | null;
  country: string | null;
  eventUrl: string | null;
  year: number;
  isVirtual: boolean | null;
  imageUrl: string;
  hasArtwork: boolean;
  tokenCount: number;
}

export interface LegacyPoapHolding {
  chainId: 1 | 100 | 8453 | 42161;
  network: "ethereum" | "gnosis" | "base" | "arbitrum-one";
  contractAddress: `0x${string}`;
  poapId: number;
  dropId: number | null;
  title: string;
  description: string | null;
  imageUrl: string;
  startDate: string;
  city: string | null;
  country: string | null;
  eventUrl: string | null;
  year: number | null;
  mintedAt: string | null;
  transactionHash: string | null;
  explorerUrl: string;
}

export interface LegacyPoapHoldingsResponse {
  address: `0x${string}`;
  total: number;
  complete: boolean;
  items: LegacyPoapHolding[];
  networks: Array<{
    chainId: 1 | 100 | 8453 | 42161;
    network: "ethereum" | "gnosis" | "base" | "arbitrum-one";
    expectedBalance: number;
    discoveredCount: number;
    complete: boolean;
  }>;
}

export interface LiveClaimResponse {
  eventId: string;
  slug: string;
  address: `0x${string}`;
  claimedAt: string;
  mintStatus: "reserved" | "ready" | "minted";
  mintedTxHash: `0x${string}` | null;
}

export interface LiveRelayResponse {
  eventId: string;
  slug: string;
  address: `0x${string}`;
  jobId: string | null;
  mintStatus: "minting" | "minted";
  transactionHash: `0x${string}` | null;
  explorerUrl: string | null;
}

export interface MintJobResponse {
  jobId: string;
  mintStatus: "minting" | "minted";
  transactionHash: `0x${string}` | null;
  explorerUrl: string | null;
}

export interface LiveMintResponse {
  eventId: string;
  slug: string;
  address: `0x${string}`;
  mintStatus: "minted";
  mintedAt: string;
  transactionHash: `0x${string}`;
  explorerUrl: string;
}

export interface EmailReservation {
  reservationId: string;
  reservedAt: string;
  boundAddress: `0x${string}` | null;
  claimedAt: string | null;
  mintStatus: "reserved" | "ready" | "minted";
  mintedTxHash: `0x${string}` | null;
  mintedAt: string | null;
  mintedExplorerUrl: string | null;
  event: LiveEvent;
}

export interface EmailWallet {
  provider: "magic-pregen";
  status: "provisioning" | "ready" | "failed";
  address: `0x${string}` | null;
  updatedAt: string;
}

export interface WalletProvisioningConfig {
  mode: "disabled" | "magic-pregen";
  enabled: boolean;
  publishableKey: string | null;
}

export interface EmbeddedWalletConfig {
  provider: "magic";
  enabled: boolean;
  publishableKey: string | null;
  emailTemplateName: string | null;
}

export interface AppConfig {
  mode: "combined" | "live-only";
  walletProvisioning: WalletProvisioningConfig;
  embeddedWallet: EmbeddedWalletConfig;
}

export interface EmailReservationsResponse {
  items: EmailReservation[];
  walletConfig: WalletProvisioningConfig;
  wallet: EmailWallet | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });

  const body = (await response.json().catch(() => null)) as
    { error?: unknown; code?: unknown } | T | null;
  if (!response.ok) {
    const errorBody = body as { error?: unknown; code?: unknown } | null;
    const message =
      typeof errorBody?.error === "string" ? errorBody.error : `請求失敗（${response.status}）`;
    const code = typeof errorBody?.code === "string" ? errorBody.code : null;
    throw new ApiError(response.status, message, code);
  }
  return body as T;
}

function post<T>(path: string, input: unknown) {
  return apiRequest<T>(path, { method: "POST", body: JSON.stringify(input) });
}

export function getLiveEvent(slug: string) {
  return apiRequest<LiveEvent>(`/api/live/events/${encodeURIComponent(slug)}`);
}

export function getAppConfig() {
  return apiRequest<AppConfig>("/api/app-config");
}

export function verifyMagicSession(didToken: string, email: string) {
  return post<{ provider: "magic"; address: `0x${string}` }>("/api/live/magic/session", {
    didToken,
    email,
  });
}

export function reserveByEmail(slug: string, code: string, email: string) {
  return post<{ status: "verification_sent" }>(
    `/api/live/events/${encodeURIComponent(slug)}/email-reservations`,
    { code, email },
  );
}

export function claimToWallet(slug: string, code: string, address: string) {
  return post<LiveClaimResponse>(`/api/live/events/${encodeURIComponent(slug)}/claims`, {
    code,
    address,
  });
}

export function relayWalletMint(slug: string, code: string, address: string) {
  return post<LiveRelayResponse>(`/api/live/events/${encodeURIComponent(slug)}/relay`, {
    code,
    address,
  });
}

export async function relayWalletMintWithRetry(slug: string, code: string, address: string) {
  return relayWalletMint(slug, code, address);
}

export function getMintJob(jobId: string) {
  return apiRequest<MintJobResponse>(`/api/live/mint-jobs/${encodeURIComponent(jobId)}`);
}

export async function waitForMintJob(jobId: string): Promise<MintJobResponse> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const job = await getMintJob(jobId);
    if (job.mintStatus === "minted") return job;
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  return getMintJob(jobId);
}

export function confirmWalletMint(
  slug: string,
  code: string,
  address: string,
  transactionHash: `0x${string}`,
) {
  return post<LiveMintResponse>(`/api/live/events/${encodeURIComponent(slug)}/mints`, {
    code,
    address,
    transactionHash,
  });
}

export function requestEmailLogin(email: string) {
  return post<{ status: "verification_sent" }>("/api/live/email/login", { email });
}

export function verifyEmail(token: string) {
  return post<{ redirectTo: string }>("/api/live/email/verify", { token });
}

export function getEmailReservations() {
  return apiRequest<EmailReservationsResponse>("/api/live/email/reservations");
}

export function provisionEmailWallet(email: string) {
  return post<{ config: WalletProvisioningConfig; wallet: EmailWallet | null }>(
    "/api/live/email/wallet",
    { email },
  );
}

export function bindEmailReservation(reservationId: string, address: string) {
  return post<EmailReservation & { mintAuthorization: unknown }>(
    `/api/live/email/reservations/${encodeURIComponent(reservationId)}/bind`,
    { address },
  );
}

export function relayEmailReservation(reservationId: string, address: string) {
  return post<LiveRelayResponse>(
    `/api/live/email/reservations/${encodeURIComponent(reservationId)}/relay`,
    { address },
  );
}

export function confirmEmailReservation(
  reservationId: string,
  address: string,
  transactionHash: `0x${string}`,
) {
  return post<LiveMintResponse>(
    `/api/live/email/reservations/${encodeURIComponent(reservationId)}/mints`,
    { address, transactionHash },
  );
}

export async function completePendingEmailReservations(address: `0x${string}`) {
  const collection = await getEmailReservations();
  const pending = collection.items.filter((item) => item.mintStatus !== "minted");
  let completed = 0;
  for (const reservation of pending) {
    const bound = await bindEmailReservation(reservation.reservationId, address);
    if (bound.mintStatus === "minted") {
      completed += 1;
      continue;
    }
    const relayed = await relayEmailReservation(reservation.reservationId, address);
    if (relayed.jobId) {
      const result = await waitForMintJob(relayed.jobId);
      if (result.mintStatus !== "minted") break;
    } else if (relayed.transactionHash) {
      await waitForMintConfirmation(() =>
        confirmEmailReservation(reservation.reservationId, address, relayed.transactionHash!),
      );
    }
    completed += 1;
  }
  return { completed, pending: pending.length - completed };
}

export function logoutEmail() {
  return post<{ status: "signed_out" }>("/api/live/email/logout", {});
}

export function getLiveHoldings(address: string) {
  return apiRequest<{ address: string; items: LiveHolding[] }>(
    `/api/live/owners/${encodeURIComponent(address)}`,
  );
}

export function getArchiveHoldings(address: string, cursor: string | null = null) {
  const query = new URLSearchParams({ limit: "48" });
  if (cursor) query.set("cursor", cursor);
  return apiRequest<ArchiveHoldingsResponse>(
    `/api/archive/owners/${encodeURIComponent(address)}?${query}`,
  );
}

export function getLegacyPoapHoldings(address: string) {
  return apiRequest<LegacyPoapHoldingsResponse>(
    `/api/legacy/owners/${encodeURIComponent(address)}`,
  );
}

export function getArchiveDrop(dropId: number) {
  return apiRequest<ArchiveDropDetail>(`/api/archive/drops/${dropId}`);
}

export function getArchiveCollectors(dropId: number, cursor: string | null = null) {
  const query = new URLSearchParams({ limit: "48" });
  if (cursor) query.set("cursor", cursor);
  return apiRequest<ArchiveCollectorsResponse>(`/api/drops/${dropId}/collectors?${query}`);
}

export function getLiveCollectors(slug: string) {
  return apiRequest<LiveCollectorsResponse>(
    `/api/live/events/${encodeURIComponent(slug)}/collectors`,
  );
}

export function resolveEns(name: string) {
  const query = new URLSearchParams({ name });
  return apiRequest<{ name: string; address: string }>(`/api/resolve-address?${query}`);
}

export async function waitForMintConfirmation(
  confirm: () => Promise<LiveMintResponse>,
): Promise<LiveMintResponse> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      return await confirm();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "live_mint_pending") throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
  }
  throw new ApiError(408, "鏈上交易仍在確認中，請稍後到收藏頁查看。", "live_mint_timeout");
}

export async function connectExistingWallet(): Promise<`0x${string}`> {
  const provider = (
    window as Window & {
      ethereum?: { request: (input: { method: string }) => Promise<unknown> };
    }
  ).ethereum;
  if (!provider) {
    throw new ApiError(
      400,
      "找不到錢包。請在已安裝錢包的瀏覽器開啟，或改用 Email 登入。",
      "wallet_missing",
    );
  }
  const result = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(result) ? result[0] : null;
  if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new ApiError(400, "無法取得錢包地址。", "wallet_address_missing");
  }
  return address as `0x${string}`;
}

export function readableError(error: unknown) {
  if (error instanceof ApiError && error.code?.startsWith("live_relay")) return "正在鑄造。";
  return error instanceof Error ? error.message : "發生未預期的問題，請稍後再試。";
}
