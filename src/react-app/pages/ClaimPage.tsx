import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type EIP1193Provider,
} from "viem";
import {
  claimLiveEvent,
  confirmLiveMint,
  getLiveEvent,
  relayLiveEventMint,
  reserveLiveEventByEmail,
  waitForLiveMintJob,
} from "../api";
import { EmptyState, ErrorState } from "../components/States";
import { Link } from "../router";
import type { LiveClaimResponse, LiveEvent, LiveMintResponse } from "../types";
import { isAbortError } from "../utils";
import { supportedLiveChain, transactionExplorerUrl } from "../../shared/live-chains";
import { DEMO_TRANSACTION_HASH, DEMO_WALLET_ADDRESS, isDemoMode } from "../demo-api";

export function ClaimPage({ slug, search }: { slug: string; search: string }) {
  const code = useMemo(() => new URLSearchParams(search).get("code")?.trim() ?? "", [search]);
  const [event, setEvent] = useState<LiveEvent | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [transactionHash, setTransactionHash] = useState<`0x${string}` | null>(null);
  const [result, setResult] = useState<LiveClaimResponse | LiveMintResponse | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [debugMagicLink, setDebugMagicLink] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    getLiveEvent(slug, controller.signal)
      .then(setEvent)
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) {
          setError(cause instanceof Error ? cause.message : "無法載入活動");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [slug]);

  const connectAndMint = async () => {
    if (!code) {
      setError("這個網址沒有領取碼，請使用 Email 或 QR Code 裡的完整連結。");
      return;
    }
    if (!event?.contractAddress || event.tokenId === null) {
      setError("這場活動尚未設定 Base 鑄造合約。");
      return;
    }
    if (isDemoMode()) {
      setSubmitting(true);
      setError("");
      setProgress("正在模擬連接錢包…");
      try {
        await pause(450);
        setProgress("協會正在模擬支付 Gas 並送出鑄造…");
        await claimLiveEvent(slug, { code, address: DEMO_WALLET_ADDRESS });
        await relayLiveEventMint(slug, { code, address: DEMO_WALLET_ADDRESS });
        await pause(650);
        setResult(
          await confirmLiveMint(slug, {
            code,
            address: DEMO_WALLET_ADDRESS,
            transactionHash: DEMO_TRANSACTION_HASH,
          }),
        );
        setProgress("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "展示流程失敗，請重設後再試。");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const chain = supportedLiveChain(event.chainId);
    if (!chain) {
      setError("這場活動使用目前不支援的網路。");
      return;
    }
    const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!provider) {
      setError("找不到瀏覽器錢包。請安裝支援 Base 的錢包後再試。");
      return;
    }

    setSubmitting(true);
    setError("");
    setProgress("正在連接錢包…");
    try {
      const walletClient = createWalletClient({
        transport: custom(provider),
      });
      const [rawAddress] = await walletClient.requestAddresses();
      if (!rawAddress) throw new Error("錢包沒有提供可用地址。");
      const account = getAddress(rawAddress);

      const publicClient = createPublicClient({
        chain,
        transport: http(),
      });
      const pendingKey = pendingMintKey(slug, account);
      const pendingHash = readPendingMint(pendingKey);
      if (pendingHash) {
        setTransactionHash(pendingHash);
        setProgress("正在接續上次尚未寫回的交易…");
        const pendingReceipt = await publicClient.waitForTransactionReceipt({
          hash: pendingHash,
          confirmations: 1,
        });
        if (pendingReceipt.status === "success") {
          const recovered = await confirmLiveMint(slug, {
            code,
            address: account,
            transactionHash: pendingHash,
          });
          removePendingMint(pendingKey);
          setResult(recovered);
          setProgress("");
          return;
        }
        removePendingMint(pendingKey);
        setTransactionHash(null);
      }

      setProgress("正在確認領取資格…");
      const claim = await claimLiveEvent(slug, { code, address: account });
      if (claim.mintStatus === "minted" && claim.mintedTxHash) {
        setResult(claim);
        return;
      }
      setProgress("協會正在支付 Gas 並送出鑄造…");
      const relayed = await relayLiveEventMint(slug, { code, address: account });
      if (relayed.jobId) {
        setProgress("正在鑄造");
        const completed = await waitForLiveMintJob(relayed.jobId);
        if (
          completed.mintStatus !== "minted" ||
          !completed.transactionHash ||
          !completed.explorerUrl
        ) {
          setProgress("正在鑄造");
          return;
        }
        setTransactionHash(completed.transactionHash);
        setResult({
          eventId: event.eventId,
          slug,
          address: account,
          mintStatus: "minted",
          mintedAt: new Date().toISOString(),
          transactionHash: completed.transactionHash,
          explorerUrl: completed.explorerUrl,
        });
      } else if (relayed.transactionHash) {
        const hash = relayed.transactionHash;
        setTransactionHash(hash);
        writePendingMint(pendingKey, hash);
        setProgress("正在鑄造");
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status !== "success") {
          removePendingMint(pendingKey);
          throw new Error("正在鑄造");
        }
        setResult(await confirmLiveMint(slug, { code, address: account, transactionHash: hash }));
        removePendingMint(pendingKey);
      }
      setProgress("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鑄造失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  const reserveByEmail = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (!code) {
      setError("這個網址沒有領取碼，請使用 Email 或 QR Code 裡的完整連結。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await reserveLiveEventByEmail(slug, { code, email });
      setEmailSent(true);
      setDebugMagicLink(response.debugMagicLink ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法寄出驗證信，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="claim-page shell" id="main-content" tabIndex={-1}>
        <p role="status">正在載入領取頁…</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="claim-page shell" id="main-content" tabIndex={-1}>
        <ErrorState message={error || "找不到這個活動。"} />
      </main>
    );
  }

  if (result) {
    return (
      <main className="claim-page shell" id="main-content" tabIndex={-1}>
        <section className="claim-panel glass-panel" aria-labelledby="claim-success-title">
          <img src={event.imageUrl} alt="" />
          <div>
            <span className="eyebrow">
              {result.mintStatus === "minted" ? "Base Sepolia 鑄造完成" : "領取登記完成"}
            </span>
            <h1 id="claim-success-title">{event.title}</h1>
            {result.mintStatus === "minted" ? (
              <p>紀念章已寫入 Base Sepolia，收藏頁會顯示鏈上交易狀態。</p>
            ) : (
              <p>這個地址已加入待鑄造清單，完成後可在同一個收藏頁看到鏈上狀態。</p>
            )}
            {"explorerUrl" in result && !isDemoMode() ? (
              <p>
                <a href={result.explorerUrl} target="_blank" rel="noreferrer">
                  在 Base Sepolia Explorer 查看交易
                </a>
              </p>
            ) : null}
            <Link className="button button--gold" href={`/address/${result.address}`}>
              查看我的收藏
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const now = Date.now();
  const unavailableMessage =
    event.status === "closed"
      ? "這場活動已關閉，無法再領取。"
      : Date.parse(event.claimOpensAt) > now
        ? `領取將於 ${formatDateTime(event.claimOpensAt)} 開放。`
        : Date.parse(event.claimClosesAt) < now
          ? "這個活動的領取期限已經結束。"
          : "";

  return (
    <main className="claim-page shell" id="main-content" tabIndex={-1}>
      <section className="claim-panel glass-panel" aria-labelledby="claim-title">
        <img src={event.imageUrl} alt="" />
        <div>
          <span className="eyebrow">兆量富足教育協會 · Base</span>
          <h1 id="claim-title">{event.title}</h1>
          <p>{event.description}</p>
          <dl className="claim-facts">
            <div>
              <dt>活動日期</dt>
              <dd>{formatDate(event.startsAt)}</dd>
            </div>
            <div>
              <dt>已登記</dt>
              <dd>
                {event.claimedCount} / {event.maxSupply}
              </dd>
            </div>
          </dl>

          {unavailableMessage ? (
            <EmptyState title="目前無法領取">{unavailableMessage}</EmptyState>
          ) : !code ? (
            <EmptyState title="缺少唯一領取碼">
              請從協會寄出的 Email 或現場 QR Code 重新開啟完整網址。
            </EmptyState>
          ) : event.contractAddress && event.tokenId !== null ? (
            <div className="claim-options">
              <div className="claim-form">
                <h2>現在用錢包領取</h2>
                <button
                  className="button button--gold"
                  type="button"
                  disabled={submitting}
                  onClick={connectAndMint}
                >
                  {submitting
                    ? progress || "處理中…"
                    : isDemoMode()
                      ? "模擬連接錢包並鑄造"
                      : "連接錢包並鑄造"}
                </button>
                {transactionHash && !result ? (
                  <p className="search-hint">
                    交易已送出：
                    <a
                      href={transactionExplorerUrl(event.chainId, transactionHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看進度
                    </a>
                  </p>
                ) : null}
                <p className="search-hint">
                  你的錢包只用來確認收件地址；Gas 由協會支付，網站不會取得私鑰。
                </p>
              </div>
              <form className="claim-form" onSubmit={reserveByEmail}>
                <h2>先用 Email 保留</h2>
                {emailSent ? (
                  <>
                    <p role="status">驗證信已寄出。完成驗證後，日後可再綁定既有錢包。</p>
                    {debugMagicLink ? (
                      <a href={debugMagicLink}>
                        {isDemoMode() ? "展示模式：開啟模擬驗證信" : "本機測試：開啟驗證連結"}
                      </a>
                    ) : null}
                  </>
                ) : (
                  <>
                    <label htmlFor="claim-email">Email</label>
                    <input
                      id="claim-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                    />
                    <button className="button button--quiet" type="submit" disabled={submitting}>
                      {submitting ? "寄送中…" : "寄送保留確認信"}
                    </button>
                    <p className="search-hint">驗證 Email 後才會占用名額；Email 不會以明文保存。</p>
                  </>
                )}
              </form>
              {error ? (
                <p className="lookup-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState title="尚未開放鑄造">
              發行人尚未完成這場活動的鏈上設定，請稍後再使用同一個 mint link。
            </EmptyState>
          )}
          <p className="search-hint">
            <Link href="/help">領取遇到問題？查看安全重試與回報方式</Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Taipei",
  }).format(date);
}

function pendingMintKey(slug: string, address: string) {
  return `association-poap:pending-mint:${slug}:${address.toLowerCase()}`;
}

function readPendingMint(key: string): `0x${string}` | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : null;
  } catch {
    return null;
  }
}

function writePendingMint(key: string, hash: `0x${string}`) {
  try {
    window.localStorage.setItem(key, hash);
  } catch {
    // A private browsing policy may disable local storage; the live request can still finish.
  }
}

function removePendingMint(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // No recovery state exists when storage is unavailable.
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(date);
}

function pause(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
