import { useEffect, useState, type SyntheticEvent } from "react";
import {
  ApiError,
  bindEmailReservation,
  completePendingEmailReservations,
  confirmEmailReservation,
  connectExistingWallet,
  getAppConfig,
  getEmailReservations,
  logoutEmail,
  provisionEmailWallet,
  readableError,
  relayEmailReservation,
  requestEmailLogin,
  waitForMintConfirmation,
  waitForMintJob,
  verifyMagicSession,
  type EmbeddedWalletConfig,
  type EmailReservation,
  type EmailReservationsResponse,
} from "../lib/live-api";
import { claimMagicPregenWallet } from "../lib/magic-pregen";
import {
  loginWithMagicEmail,
  logoutMagicEmailSession,
  resumeMagicEmailSession,
} from "../lib/magic-wallet";

export default function EmailCollectionDemo() {
  const [data, setData] = useState<EmailReservationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [email, setEmail] = useState("");
  const [loginSent, setLoginSent] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [embeddedWallet, setEmbeddedWallet] = useState<EmbeddedWalletConfig | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getEmailReservations();
      setData(result);
      setSignedOut(false);
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 401) setSignedOut(true);
      else setError(readableError(problem));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const boot = async () => {
      const presetEmail = new URLSearchParams(window.location.search).get("email");
      if (presetEmail) setEmail(presetEmail);
      try {
        const config = await getAppConfig();
        setEmbeddedWallet(config.embeddedWallet);
        if (config.embeddedWallet.enabled && config.embeddedWallet.publishableKey) {
          try {
            const existing = await resumeMagicEmailSession(config.embeddedWallet.publishableKey);
            if (existing) {
              setEmail((current) => current || existing.email);
              const verified = await verifyMagicSession(existing.didToken, existing.email);
              await completePendingEmailReservations(verified.address);
              window.location.replace(`/address/${verified.address}`);
              return;
            }
          } catch {
            // A stale Magic session must not block the verified Email collection.
          }
        }
      } catch {
        setEmbeddedWallet(null);
      }
      await load();
    };
    void boot();
  }, []);

  const sendLogin = async (formEvent: SyntheticEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!email.trim().includes("@")) {
      setError("請輸入有效的 Email。");
      return;
    }
    setError("");
    try {
      if (embeddedWallet?.enabled && embeddedWallet.publishableKey) {
        setWorkingId("magic-login");
        const magic = await loginWithMagicEmail(
          embeddedWallet.publishableKey,
          email.trim(),
          embeddedWallet.emailTemplateName,
        );
        const verified = await verifyMagicSession(magic.didToken, email.trim());
        await completePendingEmailReservations(verified.address);
        window.location.replace(`/address/${verified.address}`);
        return;
      }
      await requestEmailLogin(email.trim());
      setLoginSent(true);
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      setWorkingId(null);
    }
  };

  const bindAndMint = async (reservation: EmailReservation) => {
    setWorkingId(reservation.reservationId);
    setError("");
    setMessage("");
    try {
      const magicAddress =
        data?.walletConfig.enabled && data.wallet?.status === "ready" ? data.wallet.address : null;
      let address = reservation.boundAddress ?? magicAddress;
      if (!address && embeddedWallet?.enabled && embeddedWallet.publishableKey) {
        if (!email.trim().includes("@")) {
          throw new Error("請輸入保留時使用的 Email。");
        }
        setMessage("請完成 Email 驗證…");
        const magic = await loginWithMagicEmail(
          embeddedWallet.publishableKey,
          email.trim(),
          embeddedWallet.emailTemplateName,
        );
        const verified = await verifyMagicSession(magic.didToken, email.trim());
        if (verified.address.toLowerCase() !== magic.address.toLowerCase()) {
          throw new Error("Magic 驗證的錢包地址不一致。");
        }
        address = verified.address;
      }
      address ??= await connectExistingWallet();
      const bound = await bindEmailReservation(reservation.reservationId, address);
      if (bound.mintStatus === "minted") {
        await load();
        setMessage("這份數位紀念已經鑄造完成，不需要再次領取。");
        return;
      }
      const relayed = await relayEmailReservation(reservation.reservationId, address);
      if (relayed.jobId) {
        const completed = await waitForMintJob(relayed.jobId);
        if (completed.mintStatus !== "minted") {
          setMessage("正在鑄造，完成後會自動出現在收藏頁。");
          return;
        }
      } else if (relayed.transactionHash) {
        await waitForMintConfirmation(() =>
          confirmEmailReservation(reservation.reservationId, address, relayed.transactionHash!),
        );
      }
      await load();
      setMessage("鑄造完成，這份數位紀念已送到你的錢包。");
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      setWorkingId(null);
    }
  };

  const retryMagicWallet = async () => {
    if (!email.trim().includes("@")) {
      setError("請輸入完成驗證時使用的 Email。");
      return;
    }
    setWorkingId("magic-retry");
    setError("");
    setMessage("正在準備收藏…");
    try {
      const result = await provisionEmailWallet(email.trim());
      setData((current) =>
        current ? { ...current, walletConfig: result.config, wallet: result.wallet } : current,
      );
      setMessage(
        result.wallet?.status === "ready" ? "收藏已準備完成。" : "收藏仍在準備中，請稍後再試。",
      );
    } catch (problem) {
      setError(readableError(problem));
      setMessage("");
    } finally {
      setWorkingId(null);
    }
  };

  const openMagicWallet = async () => {
    if (!email.trim().includes("@")) {
      setError("請輸入完成驗證時使用的 Email。");
      return;
    }
    const publishableKey = data?.walletConfig.publishableKey;
    const expectedAddress = data?.wallet?.address;
    if (!publishableKey || !expectedAddress) {
      setError("收藏尚未準備完成。");
      return;
    }
    setWorkingId("magic-open");
    setError("");
    setMessage("請輸入 Email 驗證碼…");
    try {
      const address = await claimMagicPregenWallet(publishableKey, email.trim());
      if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new Error("Magic 回傳的錢包與這個 Email 的收藏地址不一致。");
      }
      setMessage(`收藏已連結：${shortAddress(address)}`);
    } catch (problem) {
      setError(readableError(problem));
      setMessage("");
    } finally {
      setWorkingId(null);
    }
  };

  const signOut = async () => {
    try {
      await Promise.all([
        logoutEmail(),
        embeddedWallet?.publishableKey
          ? logoutMagicEmailSession(embeddedWallet.publishableKey)
          : Promise.resolve(),
      ]);
    } finally {
      setData(null);
      setSignedOut(true);
    }
  };

  if (loading) return <div className="min-h-64 animate-pulse rounded-[2rem] bg-cream" />;

  if (signedOut) {
    return (
      <div className="soft-card mx-auto max-w-xl rounded-[2.2rem] p-8 text-center sm:p-12">
        <span className="text-5xl">@</span>
        <h1 className="display-title mt-6 text-4xl">查看我的收藏</h1>
        {loginSent ? (
          <div className="mt-7 rounded-[1.2rem] bg-mint p-6">
            <h2 className="text-xl font-bold">驗證信已寄出</h2>
            <p className="mt-2 text-sm leading-6 text-ink/58">
              請到 <strong>{email}</strong> 點擊登入連結。
            </p>
          </div>
        ) : (
          <form className="mt-7" onSubmit={sendLogin}>
            <p className="text-sm leading-6 text-ink/55">
              使用 Email 驗證後，就能開啟同一個錢包與收藏。
            </p>
            <input
              className="field mt-5 text-center"
              value={email}
              onChange={(input) => setEmail(input.target.value)}
              placeholder="Email"
              autoComplete="email"
              inputMode="email"
              disabled={workingId !== null}
            />
            <button className="btn-primary mt-4 w-full" type="submit" disabled={workingId !== null}>
              {workingId === "magic-login" ? "等待 Email 驗證…" : "使用 Email 登入"}
            </button>
          </form>
        )}
        {error && <p className="mt-4 text-sm font-medium text-[#ab5e74]">{error}</p>}
      </div>
    );
  }

  const items = data?.items ?? [];
  const mintedCount = items.filter((item) => item.mintStatus === "minted").length;
  const pendingCount = items.length - mintedCount;

  return (
    <div className={pendingCount > 0 ? "grid gap-7 lg:grid-cols-[.7fr_1.3fr]" : ""}>
      {pendingCount > 0 && (
        <aside className="rounded-[2rem] bg-ink p-7 text-white sm:p-9">
          <p className="text-xs font-extrabold tracking-[.15em] text-white/42">待處理</p>
          <h2 className="mt-4 text-xl font-extrabold">還有收藏尚未完成</h2>
          <div className="mt-8 border-t border-white/10 pt-6 text-sm">
            <p className="flex items-center justify-between">
              <span className="text-white/48">待領取</span>
              <strong>{pendingCount}</strong>
            </p>
          </div>
        </aside>
      )}
      <section>
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <span className="eyebrow">COLLECTORS</span>
            <h1 className="mt-4 text-4xl font-bold sm:text-5xl">我的收藏</h1>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="text-sm font-bold text-ink/42">{items.length} 份收藏</span>
            <button
              className="text-xs font-bold text-ink/38 underline underline-offset-4 hover:text-ink"
              onClick={signOut}
            >
              登出
            </button>
          </div>
        </div>
        {data?.walletConfig.enabled && pendingCount > 0 && (
          <div className="soft-card mb-5 rounded-[2rem] p-6 sm:p-7">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span className="rounded-full bg-mist px-3 py-1 text-xs font-extrabold text-leaf">
                  完成領取
                </span>
                <h2 className="mt-4 text-2xl font-bold">
                  {data.wallet?.status === "ready"
                    ? "錢包已準備完成"
                    : data.wallet?.status === "provisioning"
                      ? "正在建立錢包"
                      : "需要重新建立錢包"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-ink/50">
                  {data.wallet?.status === "ready" && data.wallet.address
                    ? `${shortAddress(data.wallet.address)} · 不需要安裝錢包或準備 ETH`
                    : "輸入相同 Email，即可安全重試。原本的保留資格不會消失。"}
                </p>
              </div>
              <div className="w-full sm:max-w-xs">
                <input
                  className="field text-center"
                  value={email}
                  onChange={(input) => setEmail(input.target.value)}
                  placeholder="完成驗證時使用的 Email"
                  autoComplete="email"
                  inputMode="email"
                />
                {data.wallet?.status === "ready" ? (
                  <button
                    className="btn-secondary mt-3 w-full"
                    type="button"
                    disabled={workingId !== null}
                    onClick={() => void openMagicWallet()}
                  >
                    {workingId === "magic-open" ? "驗證中…" : "繼續完成領取"}
                  </button>
                ) : (
                  <button
                    className="btn-secondary mt-3 w-full"
                    type="button"
                    disabled={workingId !== null || data.wallet?.status === "provisioning"}
                    onClick={() => void retryMagicWallet()}
                  >
                    {workingId === "magic-retry" ? "建立中…" : "重試建立錢包"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {embeddedWallet?.enabled && pendingCount > 0 && (
          <div className="soft-card mb-5 rounded-[2rem] p-6 sm:p-7">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span className="rounded-full bg-mist px-3 py-1 text-xs font-extrabold text-leaf">
                  完成領取
                </span>
                <h2 className="mt-4 text-2xl font-bold">繼續完成收藏</h2>
                <p className="mt-2 text-sm leading-6 text-ink/50">
                  使用 Email 驗證後即可完成領取，不需要安裝錢包。
                </p>
              </div>
              <input
                className="field w-full text-center sm:max-w-xs"
                value={email}
                onChange={(input) => setEmail(input.target.value)}
                placeholder="Email"
                autoComplete="email"
                inputMode="email"
              />
            </div>
          </div>
        )}
        {error && (
          <p className="mb-5 rounded-xl bg-blush p-4 text-sm font-medium text-[#ab5e74]">{error}</p>
        )}
        {message && (
          <p className="mb-5 rounded-xl bg-mint p-4 text-sm font-medium text-leaf">{message}</p>
        )}
        {items.length === 0 ? (
          <div className="soft-card rounded-[2rem] p-10 text-center">
            <h2 className="text-2xl font-bold">尚未有收藏</h2>
            <p className="mt-3 text-sm text-ink/55">請從主辦單位提供的領取連結開始。</p>
          </div>
        ) : (
          <div className="space-y-5">
            {items.map((item) => {
              const working = workingId === item.reservationId;
              const date = new Intl.DateTimeFormat("zh-TW", {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "Asia/Taipei",
              }).format(new Date(item.event.startsAt));
              return (
                <article
                  key={item.reservationId}
                  className="soft-card grid gap-6 rounded-[2rem] p-6 sm:grid-cols-[9rem_1fr] sm:p-7"
                >
                  <img
                    className="mx-auto aspect-square w-36 rounded-full object-cover shadow-lg sm:w-full"
                    src={item.event.imageUrl}
                    alt={`${item.event.title} 紀念圖章`}
                  />
                  <div className="flex min-w-0 flex-col justify-center">
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-gold/12 px-3 py-1 text-xs font-extrabold text-[#8d5b18]">
                        {item.mintStatus === "minted" ? "已鑄造" : "待領取"}
                      </span>
                    </div>
                    <h2 className="mt-4 font-display text-3xl font-bold">{item.event.title}</h2>
                    <p className="mt-2 text-sm text-ink/48">{date} · 兆量富足教育協會</p>
                    {item.mintStatus !== "minted" ? (
                      <>
                        <button
                          className="btn-primary mt-6 self-start"
                          disabled={workingId !== null}
                          onClick={() => void bindAndMint(item)}
                        >
                          {working
                            ? "正在鑄造…"
                            : embeddedWallet?.enabled ||
                                (data?.walletConfig.enabled && data.wallet?.status === "ready")
                              ? "完成領取"
                              : "綁定既有錢包並鑄造"}
                        </button>
                        <p className="mt-3 text-xs leading-5 text-ink/38">
                          {embeddedWallet?.enabled ||
                          (data?.walletConfig.enabled && data.wallet?.status === "ready")
                            ? "不需要安裝錢包，Gas 由協會支付。"
                            : "錢包只用來確認收件地址，Gas 由協會支付。"}
                        </p>
                      </>
                    ) : item.boundAddress ? (
                      <div className="mt-6 flex flex-wrap gap-3">
                        <a className="btn-primary" href={`/address/${item.boundAddress}`}>
                          查看收藏
                        </a>
                        {item.mintedTxHash && (
                          <a
                            className="btn-secondary"
                            href={
                              item.mintedExplorerUrl ??
                              `https://sepolia.basescan.org/tx/${item.mintedTxHash}`
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            鏈上紀錄
                          </a>
                        )}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
