import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  associationBadgeClaimTypes,
  associationBadgeDomain,
} from "../src/shared/association-badges";
import {
  beginEmailReservationRelay,
  createEmailSession,
  fetchEmailReservations,
  fetchSessionEmailHmac,
  pruneExpiredEmailAuthArtifacts,
  recordEmailReservationRelayTransaction,
} from "../src/worker/email-reservations";
import { sha256Hex } from "../src/worker/email-auth";
import {
  beginEmailWalletProvisioning,
  fetchEmailWallet,
  reconcileEmailReservationsForWallet,
  recordMagicEmailIdentity,
  recordEmailWalletFailure,
  recordEmailWalletReady,
} from "../src/worker/email-wallets";
import { buildMagicLinkEmail } from "../src/worker/email";
import {
  beginLiveClaimRelay,
  fetchLiveClaim,
  recordLiveClaimRelayTransaction,
} from "../src/worker/live";
import type { Bindings } from "../src/worker/types";

interface LiveTestBindings extends Bindings {
  TEST_LIVE_FIXTURE: string;
  TEST_LIVE_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as LiveTestBindings;
const address = "0x1111111111111111111111111111111111111111";

beforeAll(async () => {
  await applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS);
  await executeSql(bindings.LIVE_DB, bindings.TEST_LIVE_FIXTURE);
});

describe("continuation claim API", () => {
  it("exposes live-only app mode without touching archive databases", async () => {
    const response = await SELF.fetch("https://example.test/api/app-config");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "live-only",
      walletProvisioning: {
        mode: "disabled",
        enabled: false,
        publishableKey: null,
      },
      embeddedWallet: {
        provider: "magic",
        enabled: false,
        publishableKey: null,
        emailTemplateName: null,
      },
    });
  });

  it("renders branded and escaped Resend email content", () => {
    const reservation = buildMagicLinkEmail({
      challengeId: "challenge-1",
      email: "collector@example.com",
      magicLink: "https://example.test/email/verify?token=a&next=1",
      purpose: "reserve",
      eventTitle: "8 月線上讀書會 <script>alert(1)</script>",
    });

    expect(reservation.subject).toContain("確認保留");
    expect(reservation.html).toContain("POAP 留存計畫");
    expect(reservation.html).toContain("#7c72e2");
    expect(reservation.html).toContain("確認保留名額");
    expect(reservation.html).not.toContain("<script>alert(1)</script>");
    expect(reservation.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(reservation.html).toContain("token=a&amp;next=1");
    expect(reservation.text).toContain("15 分鐘");

    const login = buildMagicLinkEmail({
      challengeId: "challenge-2",
      email: "collector@example.com",
      magicLink: "https://example.test/email/login?token=abc",
      purpose: "login",
    });
    expect(login.subject).toBe("登入你的 POAP 收藏");
    expect(login.html).toContain("登入 Email 收藏");
  });

  it("creates a verified Email session directly after Magic OTP authentication", async () => {
    const sessionHash = "7".repeat(64);
    const emailHmac = "8".repeat(64);
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    await createEmailSession(bindings.LIVE_DB, { sessionHash, emailHmac, expiresAt });
    await expect(
      fetchSessionEmailHmac(
        bindings.LIVE_DB.withSession("first-primary"),
        sessionHash,
        expiresAt - 1,
      ),
    ).resolves.toBe(emailHmac);
  });

  it("serves immutable event media from the association-owned R2 bucket", async () => {
    await bindings.ARCHIVE_BUCKET.put(
      "live/events/mvp-demo/metadata.json",
      JSON.stringify({ name: "MVP Launch Badge" }),
      {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "public, max-age=300",
        },
      },
    );
    const response = await SELF.fetch(
      "https://example.test/media/live/events/mvp-demo/metadata.json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(response.json()).resolves.toEqual({ name: "MVP Launch Badge" });

    const traversal = await SELF.fetch(
      "https://example.test/media/live/events/mvp-demo/not-allowed.txt",
    );
    expect(traversal.status).toBe(404);
  });

  it("claims a one-time link without exposing the internal reservation as a collection", async () => {
    const eventResponse = await SELF.fetch("https://example.test/api/live/events/mvp-demo");
    expect(eventResponse.status).toBe(200);
    await expect(eventResponse.json()).resolves.toMatchObject({
      slug: "mvp-demo",
      chainId: 8453,
      claimedCount: 0,
    });

    const claimResponse = await SELF.fetch("https://example.test/api/live/events/mvp-demo/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "demo-claim-2026", address }),
    });
    expect(claimResponse.status).toBe(201);
    await expect(claimResponse.json()).resolves.toMatchObject({
      address,
      mintStatus: "reserved",
    });

    const ownerResponse = await SELF.fetch(`https://example.test/api/live/owners/${address}`);
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toMatchObject({
      address,
      items: [],
    });

    const duplicateResponse = await SELF.fetch(
      "https://example.test/api/live/events/mvp-demo/claims",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "demo-claim-2026",
          address: "0x2222222222222222222222222222222222222222",
        }),
      },
    );
    expect(duplicateResponse.status).toBe(409);
  });

  it("allocates a shared QR pool once per address until capacity is exhausted", async () => {
    const firstAddress = "0x3333333333333333333333333333333333333333";
    const secondAddress = "0x4444444444444444444444444444444444444444";
    const thirdAddress = "0x5555555555555555555555555555555555555555";
    const claim = (claimAddress: string) =>
      SELF.fetch("https://example.test/api/live/events/shared-demo/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "shared-demo-2026", address: claimAddress }),
      });

    expect((await claim(firstAddress)).status).toBe(201);
    expect((await claim(firstAddress)).status).toBe(200);
    expect((await claim(secondAddress)).status).toBe(201);
    expect((await claim(thirdAddress)).status).toBe(409);

    const eventResponse = await SELF.fetch("https://example.test/api/live/events/shared-demo");
    await expect(eventResponse.json()).resolves.toMatchObject({
      claimMode: "shared",
      claimedCount: 2,
      maxSupply: 2,
    });

    const wrongEventResponse = await SELF.fetch(
      "https://example.test/api/live/events/mvp-demo/claims",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "shared-demo-2026",
          address: "0x7777777777777777777777777777777777777777",
        }),
      },
    );
    expect(wrongEventResponse.status).toBe(409);
  });

  it("blocks unused claim slots after an event is closed", async () => {
    await bindings.LIVE_DB.prepare(
      "UPDATE live_events SET status = 'closed' WHERE slug = 'mvp-demo'",
    ).run();
    const response = await SELF.fetch("https://example.test/api/live/events/mvp-demo/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "unused-demo-code",
        address: "0x6666666666666666666666666666666666666666",
      }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "live_event_closed" });
  });

  it("returns a retryable EIP-712 authorization for a configured Base Sepolia event", async () => {
    const mintAddress = "0x8888888888888888888888888888888888888888";
    const request = () =>
      SELF.fetch("https://example.test/api/live/events/mint-demo/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "mint-demo-2026", address: mintAddress }),
      });

    const first = await request();
    expect(first.status).toBe(201);
    const body = await first.json<{
      eventId: string;
      mintStatus: string;
      mintAuthorization: {
        chainId: number;
        contractAddress: `0x${string}`;
        tokenId: string;
        account: `0x${string}`;
        deadline: number;
        nonce: `0x${string}`;
        signature: `0x${string}`;
      };
    }>();
    expect(body).toMatchObject({
      mintStatus: "ready",
      mintAuthorization: {
        chainId: 84532,
        contractAddress: "0x1111111111111111111111111111111111111111",
        tokenId: "1",
        account: mintAddress,
      },
    });
    const signer = privateKeyToAccount(bindings.MINT_SIGNER_PRIVATE_KEY as `0x${string}`);
    await expect(
      verifyTypedData({
        address: signer.address,
        domain: {
          ...associationBadgeDomain,
          chainId: body.mintAuthorization.chainId,
          verifyingContract: body.mintAuthorization.contractAddress,
        },
        types: associationBadgeClaimTypes,
        primaryType: "Claim",
        message: {
          account: body.mintAuthorization.account,
          tokenId: BigInt(body.mintAuthorization.tokenId),
          deadline: BigInt(body.mintAuthorization.deadline),
          nonce: body.mintAuthorization.nonce,
        },
        signature: body.mintAuthorization.signature,
      }),
    ).resolves.toBe(true);

    const retry = await request();
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      mintStatus: "ready",
      mintAuthorization: { nonce: body.mintAuthorization.nonce },
    });

    const codeHash = await sha256Hex("mint-demo-2026");
    const startedAt = "2026-08-02T00:00:00.000Z";
    const staleBefore = "2026-08-01T23:58:00.000Z";
    await expect(
      beginLiveClaimRelay(
        bindings.LIVE_DB,
        body.eventId,
        codeHash,
        mintAddress,
        startedAt,
        staleBefore,
      ),
    ).resolves.toBe(true);
    await expect(
      beginLiveClaimRelay(
        bindings.LIVE_DB,
        body.eventId,
        codeHash,
        mintAddress,
        "2026-08-02T00:00:01.000Z",
        staleBefore,
      ),
    ).resolves.toBe(false);
    const relayHash = `0x${"cd".repeat(32)}` as const;
    await expect(
      recordLiveClaimRelayTransaction(
        bindings.LIVE_DB,
        body.eventId,
        codeHash,
        mintAddress,
        startedAt,
        relayHash,
      ),
    ).resolves.toBe(true);
    await expect(
      fetchLiveClaim(
        bindings.LIVE_DB.withSession("first-primary"),
        body.eventId,
        codeHash,
        mintAddress,
      ),
    ).resolves.toMatchObject({ relayTxHash: relayHash });

    await bindings.LIVE_DB.prepare(
      `INSERT INTO live_chain_cursors (
         chain_id, contract_address, start_block, next_block,
         last_finalized_block, last_synced_at
       ) VALUES (84532, ?, 1, 101, 100, '2026-08-02T00:00:00.000Z')`,
    )
      .bind(body.mintAuthorization.contractAddress)
      .run();
    await bindings.LIVE_DB.prepare(
      `UPDATE live_claim_codes
       SET minted_tx_hash = ?, minted_at = '2026-08-02T00:04:00.000Z'
       WHERE event_id = ? AND claimed_by = ?`,
    )
      .bind(relayHash, body.eventId, mintAddress)
      .run();

    const beforeIndex = await SELF.fetch(`https://example.test/api/live/owners/${mintAddress}`);
    await expect(beforeIndex.json()).resolves.toMatchObject({
      items: [
        {
          slug: "mint-demo",
          mintStatus: "minted",
          ownershipSource: "claim-record",
          mintedTxHash: relayHash,
        },
      ],
    });

    await bindings.LIVE_DB.prepare(
      `INSERT INTO live_chain_events (
         chain_id, contract_address, transaction_hash, log_index, sub_index,
         block_number, token_id, from_address, to_address, value
       ) VALUES (84532, ?, ?, 0, 0, 102, '1', ?, ?, 1)`,
    )
      .bind(
        body.mintAuthorization.contractAddress,
        relayHash,
        "0x0000000000000000000000000000000000000000",
        mintAddress,
      )
      .run();

    const afterIndex = await SELF.fetch(`https://example.test/api/live/owners/${mintAddress}`);
    const afterIndexBody = await afterIndex.json<{ items: Array<Record<string, unknown>> }>();
    expect(afterIndexBody.items).toHaveLength(1);
    expect(afterIndexBody.items[0]).toMatchObject({
      slug: "mint-demo",
      ownershipSource: "chain-index",
      mintedTxHash: relayHash,
    });
  });

  it("reserves by verified Email and later binds an existing wallet", async () => {
    const rawEmail = "Collector+Email@example.com";
    const reserve = await SELF.fetch(
      "https://example.test/api/live/events/email-demo/email-reservations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "email-demo-2026", email: rawEmail }),
      },
    );
    expect(reserve.status).toBe(202);
    const reserveBody = await reserve.json<{ debugMagicLink: string }>();
    expect(reserveBody.debugMagicLink).toContain("/email/verify?token=");
    const token = new URL(reserveBody.debugMagicLink).searchParams.get("token");
    expect(token).toBeTruthy();

    const stored = await bindings.LIVE_DB.prepare(
      `SELECT email_hmac, email_ciphertext, token_hash
       FROM live_email_challenges
       WHERE purpose = 'reserve'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).first<Record<string, string>>();
    expect(JSON.stringify(stored)).not.toContain(rawEmail.toLowerCase());
    expect(stored?.email_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toBe(token);

    const verify = await SELF.fetch("https://example.test/api/live/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie");
    expect(cookie).toContain("association_email_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    await expect(verify.json()).resolves.toMatchObject({
      purpose: "reserve",
      reservation: {
        mintStatus: "reserved",
        boundAddress: null,
        event: { slug: "email-demo" },
      },
    });

    const replay = await SELF.fetch("https://example.test/api/live/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(409);

    const collection = await SELF.fetch("https://example.test/api/live/email/reservations", {
      headers: { Cookie: cookie ?? "" },
    });
    expect(collection.status).toBe(200);
    const collectionBody = await collection.json<{
      items: Array<{ reservationId: string; mintStatus: string }>;
      walletConfig: { mode: string; enabled: boolean; publishableKey: string | null };
    }>();
    expect(collectionBody.items).toHaveLength(1);
    expect(collectionBody.items[0]?.mintStatus).toBe("reserved");
    expect(collectionBody.walletConfig).toEqual({
      mode: "disabled",
      enabled: false,
      publishableKey: null,
    });
    const reservationId = collectionBody.items[0]?.reservationId;
    expect(reservationId).toBeTruthy();

    const eventAfterReservation = await SELF.fetch(
      "https://example.test/api/live/events/email-demo",
    );
    await expect(eventAfterReservation.json()).resolves.toMatchObject({ claimedCount: 1 });

    const wallet = "0x9999999999999999999999999999999999999999";
    const bind = await SELF.fetch(
      `https://example.test/api/live/email/reservations/${reservationId}/bind`,
      {
        method: "POST",
        headers: {
          Cookie: cookie ?? "",
          Origin: "https://example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address: wallet }),
      },
    );
    expect(bind.status).toBe(200);
    const bindBody = await bind.json<{
      boundAddress: string;
      mintStatus: string;
      mintAuthorization: {
        chainId: number;
        account: `0x${string}`;
        contractAddress: `0x${string}`;
        tokenId: string;
        deadline: number;
        nonce: `0x${string}`;
        signature: `0x${string}`;
      };
    }>();
    expect(bindBody).toMatchObject({
      boundAddress: wallet,
      mintStatus: "ready",
      mintAuthorization: { chainId: 84532, account: wallet, tokenId: "2" },
    });
    const signer = privateKeyToAccount(bindings.MINT_SIGNER_PRIVATE_KEY as `0x${string}`);
    await expect(
      verifyTypedData({
        address: signer.address,
        domain: {
          ...associationBadgeDomain,
          chainId: bindBody.mintAuthorization.chainId,
          verifyingContract: bindBody.mintAuthorization.contractAddress,
        },
        types: associationBadgeClaimTypes,
        primaryType: "Claim",
        message: {
          account: bindBody.mintAuthorization.account,
          tokenId: BigInt(bindBody.mintAuthorization.tokenId),
          deadline: BigInt(bindBody.mintAuthorization.deadline),
          nonce: bindBody.mintAuthorization.nonce,
        },
        signature: bindBody.mintAuthorization.signature,
      }),
    ).resolves.toBe(true);

    const relayStartedAt = "2026-08-02T00:05:00.000Z";
    await expect(
      beginEmailReservationRelay(
        bindings.LIVE_DB,
        reservationId!,
        stored!.email_hmac,
        wallet,
        relayStartedAt,
        "2026-08-02T00:03:00.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      recordEmailReservationRelayTransaction(
        bindings.LIVE_DB,
        reservationId!,
        stored!.email_hmac,
        wallet,
        relayStartedAt,
        `0x${"ef".repeat(32)}`,
      ),
    ).resolves.toBe(true);

    const submittedCollection = await SELF.fetch(
      "https://example.test/api/live/email/reservations",
      { headers: { Cookie: cookie ?? "" } },
    );
    await expect(submittedCollection.json()).resolves.toMatchObject({
      items: [
        {
          reservationId,
          mintStatus: "minted",
          mintedTxHash: `0x${"ef".repeat(32)}`,
          mintedExplorerUrl: `https://sepolia.basescan.org/tx/0x${"ef".repeat(32)}`,
        },
      ],
    });
  });

  it("shows an Email reservation as minted when the verified Magic wallet already claimed", async () => {
    const emailHmac = "9".repeat(64);
    const magicAddress = "0xabababababababababababababababababababab";
    const mintHash = `0x${"12".repeat(32)}`;
    await bindings.LIVE_DB.prepare(
      `INSERT INTO live_events (
         event_id, slug, title, description, image_url, event_url,
         starts_at, claim_opens_at, claim_closes_at, chain_id,
         contract_address, token_id, max_supply, status, claim_mode
       ) VALUES (
         'event-email-reconcile', 'email-reconcile', 'Email 狀態合併測試', '',
         '/brand/logo_poap.svg', NULL, '2026-08-01T00:00:00.000Z',
         '2026-07-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z', 84532,
         '0x1111111111111111111111111111111111111111', '99', 2, 'published', 'shared'
       )`,
    ).run();
    await bindings.LIVE_DB.batch([
      bindings.LIVE_DB.prepare(
        `INSERT INTO live_claim_codes (
           code_hash, event_id, access_code_hash,
           reservation_id, reserved_email_hmac, reserved_at
         ) VALUES (?, 'event-email-reconcile', ?, 'reservation-reconcile', ?, ?)`,
      ).bind("a".repeat(64), "c".repeat(64), emailHmac, "2026-08-03T00:00:00.000Z"),
      bindings.LIVE_DB.prepare(
        `INSERT INTO live_claim_codes (
           code_hash, event_id, access_code_hash, claimed_by, claimed_at,
           mint_nonce, mint_authorization_deadline, minted_tx_hash, minted_at
         ) VALUES (?, 'event-email-reconcile', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "b".repeat(64),
        "c".repeat(64),
        magicAddress,
        "2026-08-03T00:01:00.000Z",
        `0x${"34".repeat(32)}`,
        2_000_000_000,
        mintHash,
        "2026-08-03T00:02:00.000Z",
      ),
    ]);

    await expect(
      recordMagicEmailIdentity(bindings.LIVE_DB, {
        emailHmac,
        address: magicAddress,
      }),
    ).resolves.toMatchObject({ emailHmac, address: magicAddress });
    await expect(
      reconcileEmailReservationsForWallet(bindings.LIVE_DB, {
        emailHmac,
        address: magicAddress,
      }),
    ).resolves.toBe(1);

    await expect(
      fetchEmailReservations(bindings.LIVE_DB.withSession("first-primary"), emailHmac),
    ).resolves.toMatchObject([
      {
        reservationId: "reservation-reconcile",
        boundAddress: magicAddress,
        mintedTxHash: mintHash,
      },
    ]);
    await expect(
      bindings.LIVE_DB.prepare(
        `SELECT
           SUM(reservation_id IS NOT NULL) AS reservations,
           SUM(claimed_by IS NOT NULL) AS claims,
           SUM(minted_tx_hash IS NOT NULL) AS mints
         FROM live_claim_codes
         WHERE event_id = 'event-email-reconcile'`,
      ).first(),
    ).resolves.toEqual({ reservations: 1, claims: 1, mints: 1 });
  });

  it("leases Email wallet provisioning and records only one provider address", async () => {
    const emailHmac = "f".repeat(64);
    const startedAt = "2026-08-02T01:00:00.000Z";
    const providerAddress = "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB";
    await expect(
      beginEmailWalletProvisioning(bindings.LIVE_DB, {
        emailHmac,
        provider: "magic-pregen",
        startedAt,
        staleBefore: "2026-08-02T00:58:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      beginEmailWalletProvisioning(bindings.LIVE_DB, {
        emailHmac,
        provider: "magic-pregen",
        startedAt: "2026-08-02T01:00:01.000Z",
        staleBefore: "2026-08-02T00:58:01.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      recordEmailWalletReady(bindings.LIVE_DB, {
        emailHmac,
        provider: "magic-pregen",
        startedAt,
        address: providerAddress,
      }),
    ).resolves.toBe(true);
    await expect(
      fetchEmailWallet(bindings.LIVE_DB.withSession("first-primary"), emailHmac),
    ).resolves.toMatchObject({
      provider: "magic-pregen",
      status: "ready",
      address: providerAddress,
      attemptCount: 1,
    });

    const failedEmailHmac = "e".repeat(64);
    const failedAt = "2026-08-02T01:05:00.000Z";
    await beginEmailWalletProvisioning(bindings.LIVE_DB, {
      emailHmac: failedEmailHmac,
      provider: "magic-pregen",
      startedAt: failedAt,
      staleBefore: "2026-08-02T01:03:00.000Z",
    });
    await recordEmailWalletFailure(bindings.LIVE_DB, {
      emailHmac: failedEmailHmac,
      provider: "magic-pregen",
      startedAt: failedAt,
      errorCode: "magic_unavailable",
    });
    await expect(
      fetchEmailWallet(bindings.LIVE_DB.withSession("first-primary"), failedEmailHmac),
    ).resolves.toMatchObject({
      status: "failed",
      address: null,
      lastErrorCode: "magic_unavailable",
    });
  });

  it("keeps Email login non-enumerating and enforces same-origin wallet binding", async () => {
    const login = await SELF.fetch("https://example.test/api/live/email/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(login.status).toBe(202);
    await expect(login.json()).resolves.toMatchObject({ status: "verification_sent" });

    const unauthorized = await SELF.fetch(
      "https://example.test/api/live/email/reservations/00000000-0000-0000-0000-000000000000/bind",
      {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address }),
      },
    );
    expect(unauthorized.status).toBe(403);
    await expect(unauthorized.json()).resolves.toMatchObject({ code: "invalid_origin" });
  });

  it("prunes expired Email authentication artifacts after a 24-hour recovery window", async () => {
    await bindings.LIVE_DB.prepare(
      `INSERT INTO live_email_challenges (
         challenge_id, purpose, event_id, access_code_hash, email_hmac,
         email_ciphertext, email_iv, token_hash, expires_at
       ) VALUES (?, 'login', NULL, NULL, ?, 'ciphertext', 'iv', ?, ?)`,
    )
      .bind("expired-challenge", "a".repeat(64), "b".repeat(64), 100)
      .run();
    await bindings.LIVE_DB.prepare(
      `INSERT INTO live_email_sessions (session_hash, email_hmac, expires_at)
       VALUES (?, ?, ?)`,
    )
      .bind("c".repeat(64), "a".repeat(64), 100)
      .run();

    await expect(pruneExpiredEmailAuthArtifacts(bindings.LIVE_DB, 100 + 86_401)).resolves.toEqual({
      challenges: 1,
      sessions: 1,
    });
    await expect(
      bindings.LIVE_DB.prepare("SELECT COUNT(*) AS count FROM live_email_challenges").first<{
        count: number;
      }>(),
    ).resolves.toEqual({ count: 0 });
  });
});

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}
