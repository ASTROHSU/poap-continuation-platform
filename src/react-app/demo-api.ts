import type {
  EmailBindResponse,
  EmailChallengeResponse,
  EmailReservation,
  EmailReservationsResponse,
  EmailVerificationResponse,
  LiveClaimResponse,
  LiveEvent,
  LiveHolding,
  LiveHoldingsResponse,
  LiveMintResponse,
  LiveRelayResponse,
} from "./types";

export const DEMO_WALLET_ADDRESS = "0x2026202620262026202620262026202620262026" as const;
export const DEMO_TRANSACTION_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const STORAGE_KEY = "association-poap:vercel-demo:v1";

interface DemoState {
  pendingEmail: string;
  emailSignedIn: boolean;
  reservation: EmailReservation | null;
  holdings: Record<string, LiveHolding>;
}

export function isDemoMode() {
  return import.meta.env.VITE_DEMO_MODE === "true";
}

export function demoGetEvent(): LiveEvent {
  const state = readState();
  return {
    eventId: "event-2026-first-pilot",
    slug: "first-pilot",
    title: "兆量富足教育協會數位紀念章 Pilot",
    description: "這是可以自由操作的展示活動，用來體驗 Email 保留、日後綁定錢包、鑄造與收藏查詢。",
    imageUrl: "/brand/logo_poap.svg",
    eventUrl: null,
    startsAt: "2026-08-15T06:00:00.000Z",
    claimOpensAt: "2026-07-01T00:00:00.000Z",
    claimClosesAt: "2027-12-31T15:59:59.999Z",
    chainId: 84532,
    contractAddress: "0x1111111111111111111111111111111111111111",
    tokenId: "1",
    maxSupply: 20,
    claimedCount: Object.keys(state.holdings).length + (state.reservation ? 1 : 0),
    mintedCount: Object.values(state.holdings).filter((item) => item.mintStatus === "minted")
      .length,
    claimMode: "unique",
    status: "published",
  };
}

export function demoClaim(address: string): LiveClaimResponse {
  const normalized = address.toLowerCase();
  const state = readState();
  state.holdings[normalized] = holdingFor(normalized, "ready");
  writeState(state);
  return {
    eventId: "event-2026-first-pilot",
    slug: "first-pilot",
    address: normalized,
    claimedAt: new Date().toISOString(),
    mintStatus: "ready",
    mintedTxHash: null,
    mintAuthorization: null,
  };
}

export function demoConfirmMint(address: string): LiveMintResponse {
  const normalized = address.toLowerCase();
  const state = readState();
  state.holdings[normalized] = holdingFor(normalized, "minted");
  writeState(state);
  return {
    eventId: "event-2026-first-pilot",
    slug: "first-pilot",
    address: normalized,
    mintStatus: "minted",
    mintedAt: new Date().toISOString(),
    transactionHash: DEMO_TRANSACTION_HASH,
    explorerUrl: "/help",
  };
}

export function demoRelayMint(address: string): LiveRelayResponse {
  return {
    eventId: "event-2026-first-pilot",
    slug: "first-pilot",
    address: address.toLowerCase(),
    transactionHash: DEMO_TRANSACTION_HASH,
    explorerUrl: "/help",
  };
}

export function demoGetHoldings(address: string): LiveHoldingsResponse {
  const normalized = address.toLowerCase();
  const item = readState().holdings[normalized];
  return { address: normalized, items: item ? [item] : [] };
}

export function demoReserveByEmail(email: string): EmailChallengeResponse {
  const state = readState();
  state.pendingEmail = email.trim().toLowerCase();
  writeState(state);
  return {
    status: "verification_sent",
    debugMagicLink: "/email/verify?token=demo-reserve",
  };
}

export function demoRequestEmailLogin(email: string): EmailChallengeResponse {
  const state = readState();
  state.pendingEmail = email.trim().toLowerCase();
  writeState(state);
  return {
    status: "verification_sent",
    debugMagicLink: "/email/verify?token=demo-login",
  };
}

export function demoVerifyEmail(token: string): EmailVerificationResponse {
  const state = readState();
  const purpose = token === "demo-reserve" ? "reserve" : "login";
  state.emailSignedIn = true;
  if (purpose === "reserve" && !state.reservation) {
    state.reservation = {
      reservationId: "demo-reservation-1",
      reservedAt: new Date().toISOString(),
      boundAddress: null,
      claimedAt: null,
      mintStatus: "reserved",
      mintedTxHash: null,
      mintedAt: null,
      event: demoGetEvent(),
    };
  }
  writeState(state);
  return {
    purpose,
    reservation: state.reservation,
    wallet: null,
    redirectTo: "/email/collection",
  };
}

export function demoGetEmailReservations(): EmailReservationsResponse | null {
  const state = readState();
  if (!state.emailSignedIn) return null;
  return {
    items: state.reservation ? [{ ...state.reservation, event: demoGetEvent() }] : [],
    walletConfig: { mode: "disabled", enabled: false, publishableKey: null },
    wallet: null,
  };
}

export function demoBindReservation(address: string): EmailBindResponse {
  const state = readState();
  if (!state.reservation) throw new Error("找不到展示用 Email 保留資格。");
  state.reservation.boundAddress = address.toLowerCase() as `0x${string}`;
  state.reservation.claimedAt = new Date().toISOString();
  state.reservation.mintStatus = "ready";
  writeState(state);
  return { ...state.reservation, event: demoGetEvent(), mintAuthorization: null };
}

export function demoConfirmReservationMint(address: string): LiveMintResponse {
  const state = readState();
  if (!state.reservation) throw new Error("找不到展示用 Email 保留資格。");
  const mintedAt = new Date().toISOString();
  state.reservation.boundAddress = address.toLowerCase() as `0x${string}`;
  state.reservation.claimedAt ??= mintedAt;
  state.reservation.mintStatus = "minted";
  state.reservation.mintedTxHash = DEMO_TRANSACTION_HASH;
  state.reservation.mintedAt = mintedAt;
  state.holdings[address.toLowerCase()] = holdingFor(address.toLowerCase(), "minted", mintedAt);
  writeState(state);
  return demoConfirmMint(address);
}

export function demoLogout() {
  const state = readState();
  state.emailSignedIn = false;
  writeState(state);
}

export function resetDemoState() {
  window.localStorage.removeItem(STORAGE_KEY);
}

function holdingFor(
  address: string,
  status: "ready" | "minted",
  now = new Date().toISOString(),
): LiveHolding {
  return {
    ...demoGetEvent(),
    claimedAt: now,
    mintStatus: status === "minted" ? "minted" : "reserved",
    mintedTxHash: status === "minted" ? DEMO_TRANSACTION_HASH : null,
    mintedAt: status === "minted" ? now : null,
    ownershipSource: status === "minted" ? "chain-index" : "claim-record",
    chainSyncedAt: status === "minted" ? now : null,
    chainFinalizedBlock: status === "minted" ? 25_000_000 : null,
  };
}

function readState(): DemoState {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value) return JSON.parse(value) as DemoState;
  } catch {
    // Fall back to a fresh in-browser demonstration state.
  }
  return { pendingEmail: "", emailSignedIn: false, reservation: null, holdings: {} };
}

function writeState(state: DemoState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
