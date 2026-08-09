import { type FormEvent, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type EIP1193Provider,
} from "viem";
import {
  ApiError,
  bindEmailReservation,
  confirmEmailReservationMint,
  getEmailReservations,
  logoutEmailSession,
  provisionEmailWallet,
  relayEmailReservationMint,
  requestEmailLogin,
  waitForLiveMintJob,
} from "../api";
import type { EmailReservation, EmailWallet, WalletProvisioningConfig } from "../types";
import { isAbortError } from "../utils";
import { supportedLiveChain, transactionExplorerUrl } from "../../shared/live-chains";
import { Link } from "../router";
import { DEMO_TRANSACTION_HASH, DEMO_WALLET_ADDRESS, isDemoMode } from "../demo-api";
import { claimMagicPregenWallet } from "../magic-pregen-client";

const DISABLED_WALLET_CONFIG: WalletProvisioningConfig = {
  mode: "disabled",
  enabled: false,
  publishableKey: null,
};

export function EmailCollectionPage() {
  const [items, setItems] = useState<EmailReservation[]>([]);
  const [wallet, setWallet] = useState<EmailWallet | null>(null);
  const [walletConfig, setWalletConfig] =
    useState<WalletProvisioningConfig>(DISABLED_WALLET_CONFIG);
  const [email, setEmail] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [debugMagicLink, setDebugMagicLink] = useState("");

  const load = (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    return getEmailReservations(signal)
      .then((result) => {
        setItems(result.items);
        setWallet(result.wallet);
        setWalletConfig(result.walletConfig);
        setSignedOut(false);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        if (cause instanceof ApiError && cause.status === 401) setSignedOut(true);
        else setError(cause instanceof Error ? cause.message : "無法載入 Email 收藏。");
      })
      .finally(() => setLoading(false));
  };

  const retryEmailWallet = async () => {
    if (!email.trim()) {
      setError("請輸入完成驗證時使用的 Email。");
      return;
    }
    setBusyId("wallet-retry");
    setError("");
    setMessage("正在準備 Email 錢包…");
    try {
      const result = await provisionEmailWallet(email);
      setWallet(result.wallet);
      setWalletConfig(result.config);
      setMessage(
        result.wallet?.status === "ready"
          ? "Email 錢包已準備完成。"
          : "Email 錢包仍在準備中，請稍後再試。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法準備 Email 錢包。");
    } finally {
      setBusyId("");
    }
  };

  const openEmailWallet = async () => {
    if (!email.trim()) {
      setError("請輸入完成驗證時使用的 Email。");
      return;
    }
    if (!walletConfig.publishableKey || wallet?.status !== "ready" || !wallet.address) {
      setError("Email 錢包尚未準備完成。");
      return;
    }
    setBusyId("wallet-claim");
    setError("");
    setMessage("請依畫面指示驗證 Email…");
    try {
      const claimedAddress = await claimMagicPregenWallet(walletConfig.publishableKey, email);
      if (claimedAddress !== getAddress(wallet.address)) {
        throw new Error("Email 驗證取得的錢包與保留收藏不一致，請聯絡發行人。");
      }
      setMessage(`Email 錢包已開啟：${shortAddress(claimedAddress)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法開啟 Email 錢包。");
    } finally {
      setBusyId("");
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusyId("login");
    try {
      const result = await requestEmailLogin(email);
      setMessage("登入連結已寄出，請在 15 分鐘內開啟。");
      setDebugMagicLink(result.debugMagicLink ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法寄出登入信。");
    } finally {
      setBusyId("");
    }
  };

  const mint = async (reservation: EmailReservation) => {
    if (isDemoMode()) {
      setBusyId(reservation.reservationId);
      setError("");
      setMessage("正在模擬綁定既有錢包…");
      try {
        await bindEmailReservation(reservation.reservationId, DEMO_WALLET_ADDRESS);
        setMessage("協會正在模擬支付 Gas 並送出鑄造…");
        await relayEmailReservationMint(reservation.reservationId, DEMO_WALLET_ADDRESS);
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        await confirmEmailReservationMint(reservation.reservationId, {
          address: DEMO_WALLET_ADDRESS,
          transactionHash: DEMO_TRANSACTION_HASH,
        });
        await load();
        setMessage("展示鑄造完成，已寫回收藏頁。");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "展示流程失敗，請重設後再試。");
      } finally {
        setBusyId("");
      }
      return;
    }
    if (!reservation.event.contractAddress || reservation.event.tokenId === null) {
      setError("這場活動尚未設定 Base 鑄造合約。");
      return;
    }
    const chain = supportedLiveChain(reservation.event.chainId);
    if (!chain) {
      setError("這場活動使用目前不支援的網路。");
      return;
    }
    setBusyId(reservation.reservationId);
    setError("");
    try {
      let account: `0x${string}`;
      if (wallet?.status === "ready" && wallet.address) {
        account = getAddress(wallet.address);
        setMessage("正在使用你的 Email 錢包…");
      } else {
        const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
        if (!provider) {
          throw new Error("找不到瀏覽器錢包。請安裝支援 Base 的錢包後再試。");
        }
        setMessage("正在連接既有錢包…");
        const walletClient = createWalletClient({ transport: custom(provider) });
        const [rawAddress] = await walletClient.requestAddresses();
        if (!rawAddress) throw new Error("錢包沒有提供可用地址。");
        account = getAddress(rawAddress);
      }
      const publicClient = createPublicClient({ chain, transport: http() });
      const pendingKey = `association-poap:email-mint:${reservation.reservationId}:${account.toLowerCase()}`;
      const pending = readPendingMint(pendingKey);
      if (pending) {
        setMessage("正在接續上次尚未寫回的交易…");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: pending });
        if (receipt.status === "success") {
          await confirmEmailReservationMint(reservation.reservationId, {
            address: account,
            transactionHash: pending,
          });
          localStorage.removeItem(pendingKey);
          await load();
          setMessage("鑄造完成。");
          return;
        }
        localStorage.removeItem(pendingKey);
      }

      setMessage("正在綁定收件地址…");
      const binding = await bindEmailReservation(reservation.reservationId, account);
      if (binding.mintStatus === "minted") {
        await load();
        setMessage("這份紀念章已經鑄造完成。");
        return;
      }
      setMessage("正在鑄造");
      const relayed = await relayEmailReservationMint(reservation.reservationId, account);
      if (relayed.jobId) {
        const completed = await waitForLiveMintJob(relayed.jobId);
        if (completed.mintStatus !== "minted") {
          setMessage("正在鑄造");
          return;
        }
      } else if (relayed.transactionHash) {
        const hash = relayed.transactionHash;
        localStorage.setItem(pendingKey, hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("正在鑄造");
        await confirmEmailReservationMint(reservation.reservationId, {
          address: account,
          transactionHash: hash,
        });
        localStorage.removeItem(pendingKey);
      }
      await load();
      setMessage("鑄造完成");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鑄造失敗，請稍後再試。");
    } finally {
      setBusyId("");
    }
  };

  if (loading) {
    return (
      <main className="claim-page shell" id="main-content" tabIndex={-1}>
        正在載入…
      </main>
    );
  }

  return (
    <main className="claim-page shell" id="main-content" tabIndex={-1}>
      <section className="email-collection glass-panel">
        <span className="eyebrow">Email reservation</span>
        <h1>我的保留收藏</h1>
        {signedOut ? (
          <form className="claim-form" onSubmit={login}>
            <label htmlFor="email-login">Email</label>
            <input
              id="email-login"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className="button button--gold" disabled={busyId === "login"}>
              {busyId === "login" ? "寄送中…" : "寄送登入連結"}
            </button>
            {debugMagicLink ? (
              <a href={debugMagicLink}>
                {isDemoMode() ? "展示模式：開啟模擬登入信" : "本機測試：開啟驗證連結"}
              </a>
            ) : null}
          </form>
        ) : (
          <>
            {walletConfig.enabled ? (
              <section className="claim-form" aria-label="Email 錢包">
                <h2>Email 錢包</h2>
                <p>
                  {wallet?.status === "ready" && wallet.address
                    ? `已準備完成 ${shortAddress(wallet.address)}`
                    : wallet?.status === "provisioning"
                      ? "正在準備中，完成後即可直接領取。"
                      : "尚未完成建立，輸入相同 Email 即可重試。"}
                </p>
                <label htmlFor="wallet-email">Email</label>
                <input
                  id="wallet-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {wallet?.status === "ready" ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={Boolean(busyId)}
                    onClick={() => void openEmailWallet()}
                  >
                    {busyId === "wallet-claim" ? "驗證中…" : "開啟 Email 錢包"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={Boolean(busyId) || wallet?.status === "provisioning"}
                    onClick={() => void retryEmailWallet()}
                  >
                    {busyId === "wallet-retry" ? "準備中…" : "重試建立 Email 錢包"}
                  </button>
                )}
              </section>
            ) : null}
            <div className="email-reservation-grid">
              {items.map((item) => (
                <article className="email-reservation-card" key={item.reservationId}>
                  <img src={item.event.imageUrl} alt="" />
                  <div>
                    <h2>{item.event.title}</h2>
                    <p>
                      {item.mintStatus === "minted"
                        ? "已鑄造"
                        : item.boundAddress
                          ? `已綁定 ${shortAddress(item.boundAddress)}`
                          : "已保留，尚未綁定錢包"}
                    </p>
                    {item.mintStatus !== "minted" ? (
                      <button
                        className="button button--gold"
                        disabled={Boolean(busyId)}
                        onClick={() => void mint(item)}
                      >
                        {busyId === item.reservationId
                          ? "處理中…"
                          : wallet?.status === "ready"
                            ? "領取並鑄造"
                            : item.boundAddress
                              ? "繼續鑄造"
                              : "綁定既有錢包並鑄造"}
                      </button>
                    ) : item.mintedTxHash ? (
                      <a
                        href={transactionExplorerUrl(item.event.chainId, item.mintedTxHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看鏈上交易
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            {!items.length ? <p>這個 Email 目前沒有保留中的紀念章。</p> : null}
            <button
              className="button button--quiet"
              onClick={() =>
                void logoutEmailSession().then(() => {
                  setItems([]);
                  setSignedOut(true);
                })
              }
            >
              登出 Email 收藏
            </button>
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
        {error ? (
          <p className="lookup-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="search-hint">
          <Link href="/help">領取遇到問題？查看安全重試與回報方式</Link>
        </p>
      </section>
    </main>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function readPendingMint(key: string): `0x${string}` | null {
  try {
    const value = localStorage.getItem(key);
    return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : null;
  } catch {
    return null;
  }
}
