import { useEffect, useState, type SyntheticEvent } from "react";
import {
  claimToWallet,
  confirmWalletMint,
  getAppConfig,
  getLiveEvent,
  readableError,
  relayWalletMintWithRetry,
  resolveEns,
  waitForMintConfirmation,
  type LiveEvent,
  type LiveMintResponse,
  type EmbeddedWalletConfig,
  verifyMagicSession,
} from "../lib/live-api";
import { loginWithMagicEmail } from "../lib/magic-wallet";

type Progress = "idle" | "authenticating" | "resolving" | "minting" | "done";

export default function ClaimDemo({ slug }: { slug: string }) {
  const [event, setEvent] = useState<LiveEvent | null>(null);
  const [embeddedWallet, setEmbeddedWallet] = useState<EmbeddedWalletConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Progress>("idle");
  const [recipient, setRecipient] = useState("");
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [mint, setMint] = useState<LiveMintResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    const suppliedCode = url.searchParams.get("code")?.trim() ?? "";
    const storageKey = `poap-claim-code:${slug}`;
    const savedCode = window.sessionStorage.getItem(storageKey)?.trim() ?? "";
    const resolvedCode = suppliedCode || savedCode;
    setCode(resolvedCode);
    if (suppliedCode) {
      window.sessionStorage.setItem(storageKey, suppliedCode);
    }
    if (!resolvedCode) {
      setError("請使用主辦單位在活動中提供的 QR Code 或完整領取連結。");
      setLoading(false);
      return;
    }
    const eventRequest = getLiveEvent(slug)
      .then(setEvent)
      .catch((problem) => setError(readableError(problem)));
    const configRequest = getAppConfig()
      .then((config) => {
        setEmbeddedWallet(config.embeddedWallet);
      })
      .catch(() => {
        setEmbeddedWallet(null);
      });
    Promise.allSettled([eventRequest, configRequest]).finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    if (!event?.eventId) return;
    const timer = window.setInterval(() => {
      getLiveEvent(slug)
        .then(setEvent)
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [event?.eventId, slug]);

  const claim = async (formEvent: SyntheticEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!code) {
      setError("這個頁面需要主辦單位提供的共用領取連結或 QR Code。");
      return;
    }
    const value = recipient.trim();
    if (!value) {
      setError("請輸入 Email、ENS 或 Ethereum 地址。");
      return;
    }
    setError("");
    try {
      let walletAddress: `0x${string}`;
      if (value.includes("@")) {
        if (!embeddedWallet?.enabled || !embeddedWallet.publishableKey) {
          throw new Error("Email 登入暫時無法使用，請輸入 ENS 或 Ethereum 地址。");
        }
        setProgress("authenticating");
        const magic = await loginWithMagicEmail(
          embeddedWallet.publishableKey,
          value,
          embeddedWallet.emailTemplateName,
        );
        const verified = await verifyMagicSession(magic.didToken, value);
        if (verified.address.toLowerCase() !== magic.address.toLowerCase()) {
          throw new Error("Email 驗證的錢包地址不一致。");
        }
        walletAddress = verified.address;
      } else if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
        walletAddress = value as `0x${string}`;
      } else if (value.toLowerCase().endsWith(".eth")) {
        setProgress("resolving");
        const resolved = await resolveEns(value);
        walletAddress = resolved.address as `0x${string}`;
      } else {
        throw new Error("請輸入有效的 Email、ENS 或 Ethereum 地址。");
      }
      setAddress(walletAddress);
      setProgress("minting");
      const claim = await claimToWallet(slug, code, walletAddress);
      if (claim.mintStatus === "minted" && claim.mintedTxHash) {
        setMint(
          await waitForMintConfirmation(() =>
            confirmWalletMint(slug, code, walletAddress, claim.mintedTxHash!),
          ),
        );
      } else {
        const relayed = await relayWalletMintWithRetry(slug, code, walletAddress);
        setMint(
          await waitForMintConfirmation(() =>
            confirmWalletMint(slug, code, walletAddress, relayed.transactionHash),
          ),
        );
      }
      setProgress("done");
      getLiveEvent(slug)
        .then(setEvent)
        .catch(() => undefined);
    } catch (problem) {
      setError(readableError(problem));
      setProgress("idle");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto min-h-[34rem] max-w-[38rem] animate-pulse rounded-[1.8rem] bg-cream" />
    );
  }

  if (!event) {
    return (
      <div className="soft-card mx-auto max-w-xl rounded-[1.6rem] p-10 text-center">
        <span className="text-5xl text-leaf">×</span>
        <h1 className="display-title mt-5 text-3xl">
          {code ? "找不到這個活動" : "需要活動領取連結"}
        </h1>
        <p className="mt-3 text-ink/55">{error || "請確認領取連結是否正確。"}</p>
        <a className="btn-primary mt-7" href="/">
          回到首頁
        </a>
      </div>
    );
  }

  const eventDate = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Taipei",
  }).format(new Date(event.startsAt));
  const remaining = Math.max(0, event.maxSupply - event.claimedCount);
  const unavailable = !code || event.status !== "published" || remaining === 0;

  return (
    <div className="mx-auto max-w-[38rem]">
      <section className="soft-card overflow-hidden rounded-[1.8rem]">
        <div className="bg-mist px-6 py-8 text-center sm:px-10 sm:py-10">
          <img
            className="mx-auto aspect-square w-[58%] max-w-64 rounded-full object-cover shadow-xl"
            src={event.imageUrl}
            alt={`${event.title} 紀念圖章`}
          />
        </div>

        <div className="px-6 py-8 sm:px-10 sm:py-10">
          <p className="text-center text-xs font-bold uppercase tracking-[.12em] text-leaf">
            {eventDate}
          </p>
          <h1 className="mt-3 text-center text-3xl font-bold sm:text-4xl">{event.title}</h1>
          <p className="mx-auto mt-3 max-w-md text-center text-sm leading-6 text-ink/55">
            {event.description}
          </p>

          <div className="mx-auto mt-6 max-w-sm rounded-[1.2rem] border-2 border-[#dedaff] bg-white px-5 py-4 shadow-[4px_5px_0_#efedff]">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-bold text-ink/48">領取狀態</span>
              <strong className={remaining > 0 ? "text-leaf" : "text-[#ab5e74]"}>
                {remaining > 0 ? `剩餘 ${remaining} 份` : "已領取完畢"}
              </strong>
            </div>
            <div
              className="mt-3 h-2 overflow-hidden rounded-full bg-[#efedff]"
              role="progressbar"
              aria-label="已領取數量"
              aria-valuemin={0}
              aria-valuemax={event.maxSupply}
              aria-valuenow={event.claimedCount}
            >
              <div
                className="h-full rounded-full bg-[#7d70df] transition-[width] duration-500"
                style={{ width: `${Math.min(100, (event.claimedCount / event.maxSupply) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-right text-xs font-semibold text-ink/38">
              已領取 {event.claimedCount}／共 {event.maxSupply} 份
            </p>
          </div>

          {progress === "done" && mint && address ? (
            <div className="mt-8 rounded-[1.2rem] bg-mint p-6 text-center">
              <span className="mx-auto grid size-12 place-items-center rounded-full bg-leaf text-2xl text-white">
                ✓
              </span>
              <h2 className="mt-4 text-xl font-bold">已鑄造</h2>
              <p className="mt-2 text-sm text-ink/58">
                這份數位紀念已送到你的錢包，Gas 由協會支付。
              </p>
              <a className="btn-primary mt-6 w-full" href={`/address/${address}`}>
                查看我的收藏
              </a>
              <a
                className="mt-4 block text-sm font-semibold text-leaf underline underline-offset-4"
                href={mint.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看鏈上紀錄
              </a>
            </div>
          ) : (
            <div className="mt-8 border-t border-cream pt-7">
              <form onSubmit={claim}>
                <label className="block text-center text-lg font-bold" htmlFor="claim-recipient">
                  收藏這份數位紀念
                </label>
                <p className="mt-2 text-center text-sm text-ink/48">
                  輸入 Email、ENS 或 Ethereum 地址，系統會自動判斷並完成領取
                </p>
                <input
                  id="claim-recipient"
                  className="field mt-5 text-center"
                  value={recipient}
                  onChange={(input) => setRecipient(input.target.value)}
                  placeholder="Email、ENS 或 Ethereum 地址"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={progress !== "idle"}
                />
                <button
                  className="btn-primary mt-4 w-full"
                  type="submit"
                  disabled={progress !== "idle" || unavailable}
                >
                  {progress === "authenticating"
                    ? "等待 Email 驗證…"
                    : progress === "resolving"
                      ? "正在解析 ENS…"
                      : progress === "minting"
                        ? "協會代付 Gas 鑄造中…"
                        : remaining === 0
                          ? "已領取完畢"
                          : "領取"}
                </button>
              </form>
              {error && (
                <p className="mt-4 text-center text-sm font-medium text-[#ab5e74]">{error}</p>
              )}
              {!code && (
                <p className="mt-4 text-center text-xs leading-5 text-ink/45">
                  請使用主辦單位提供的共用領取連結或 QR Code。
                </p>
              )}
              <p className="mt-5 text-center text-xs leading-5 text-ink/38">
                Email 會自動建立或開啟錢包；ENS 與地址會直接作為收件地址。Gas 由協會支付，現在使用
                Base Sepolia 測試網。
              </p>
            </div>
          )}
        </div>
      </section>
      <p className="mt-7 text-center text-xs font-semibold text-ink/38">
        兆量富足教育協會 · 數位紀念
      </p>
    </div>
  );
}
