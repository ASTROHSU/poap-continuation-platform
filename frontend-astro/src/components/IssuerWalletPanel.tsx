import { useEffect, useRef, useState } from "react";
import {
  discoverWallets,
  issuancePlan,
  issuerPublicClient,
  ISSUER_CHAIN,
  ISSUER_CONTRACT,
  ISSUER_OWNER,
  issueWithOwnerWallet,
  journalKey,
  loadJournal,
  requireOwnerWallet,
  reviewIssuance,
  type IssuanceEvent,
  type IssuanceJournal,
  type WalletChoice,
} from "../lib/issuer-wallet";
import type { MobilePairing } from "../lib/issuer-mobile-wallet";
import { waitForConnection } from "../lib/issuer-connection-wait";

const mobileProjectId = import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID || "";

export default function IssuerWalletPanel({
  event,
  status,
  onSynchronize,
}: {
  event: IssuanceEvent | null;
  status: string;
  onSynchronize?: (
    slug: string,
    hash?: string,
  ) => Promise<{ claimUrl: string; transactionHash: string; status: string }>;
}) {
  const [claimUrl, setClaimUrl] = useState("");
  const [claimQr, setClaimQr] = useState("");
  const [syncingSlug, setSyncingSlug] = useState("");
  const synchronizeRef = useRef(onSynchronize);
  synchronizeRef.current = onSynchronize;
  const scope = event
    ? JSON.stringify([
        event.slug,
        event.title,
        event.imageUrl,
        event.maxSupply,
        event.tokenId,
        event.contractAddress,
      ])
    : "";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const slugRef = useRef(event?.slug);
  slugRef.current = event?.slug;
  const syncing = useRef(new Set<string>());
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [account, setAccount] = useState("");
  const [review, setReview] = useState<Awaited<ReturnType<typeof reviewIssuance>> | null>(null);
  const [journal, setJournal] = useState<IssuanceJournal | null>(null);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairingQr, setPairingQr] = useState("");
  const [mobileConnected, setMobileConnected] = useState(false);
  const mobileRef = useRef<MobilePairing | null>(null);
  const connectionAbort = useRef<AbortController | null>(null);
  const pairingEpoch = useRef(0);
  const busyRef = useRef(false);
  const operationRef = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  let plan: ReturnType<typeof issuancePlan> = null;
  let planError = "";
  try {
    plan = event ? issuancePlan(event) : null;
  } catch (error) {
    planError = readable(error);
  }
  const choice = wallets.find((wallet) => wallet.id === selected);

  useEffect(() => {
    let active = true;
    setClaimQr("");
    if (claimUrl)
      void import("qrcode")
        .then((qr) => qr.toDataURL(claimUrl, { width: 768, margin: 4 }))
        .then((data) => {
          if (active) setClaimQr(data);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [claimUrl]);

  useEffect(() => {
    mounted.current = true;
    const cleanup = discoverWallets(window, (wallet) =>
      setWallets((current) =>
        current.some((item) => item.provider === wallet.provider) ? current : [...current, wallet],
      ),
    );
    return () => {
      cleanup();
      mounted.current = false;
      generation.current++;
      pairingEpoch.current++;
      connectionAbort.current?.abort();
      void mobileRef.current?.cancel().catch(() => {});
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setReview(null);
    setJournal(null);
    if (plan) {
      try {
        setJournal(loadJournal(localStorage, plan));
      } catch {
        setMessage("瀏覽器無法保存待確認交易，請允許此網站的本機儲存後再操作。");
      }
    }
  }, [scope]);
  useEffect(() => {
    setConfirmed(false);
    setClaimUrl("");
    setMessage("");
  }, [event?.slug]);
  useEffect(() => {
    if (event && plan && plan.tokenId !== 10 && synchronizeRef.current) {
      try {
        void synchronize(event, loadJournal(localStorage, plan)?.hash).catch(() => {});
      } catch {
        setMessage("無法讀取本機交易紀錄，請允許網站儲存後重新同步。");
      }
    }
  }, [event?.slug]);
  useEffect(() => {
    setAccount("");
    setReview(null);
    generation.current++;
    if (!choice) return;
    const changed = () => {
      generation.current++;
      setAccount("");
      setReview(null);
      setMessage("錢包帳戶、網路或連線已變更；請重新連接並核對。已有交易請先查核，勿重送。");
    };
    const disconnected = () => {
      changed();
      if (choice.id === "rabby-mobile-walletconnect") setMobileConnected(false);
    };
    choice.provider.on?.("accountsChanged", changed);
    choice.provider.on?.("chainChanged", changed);
    choice.provider.on?.("disconnect", disconnected);
    return () => {
      choice.provider.removeListener?.("accountsChanged", changed);
      choice.provider.removeListener?.("chainChanged", changed);
      choice.provider.removeListener?.("disconnect", disconnected);
    };
  }, [choice]);

  async function connectMobile() {
    await run(async () => {
      const epoch = ++pairingEpoch.current;
      const controller = new AbortController();
      connectionAbort.current = controller;
      let activeConnection: MobilePairing | undefined;
      const deadline = setTimeout(
        () =>
          controller.abort(
            new Error(
              "無法取得錢包連線 QR Code。請確認後台網址已加入 Reown 允許來源，或稍後重試。",
            ),
          ),
        15_000,
      );
      setPairing(true);
      setPairingQr("");
      setMessage("正在取得連線 QR Code…");
      try {
        const [{ createMobilePairing }, qr] = await waitForConnection(
          Promise.all([import("../lib/issuer-mobile-wallet"), import("qrcode")]),
          controller.signal,
        );
        const creating = createMobilePairing({
          projectId: mobileProjectId,
          origin: window.location.origin,
          onUri(uri) {
            // Pairing URIs contain connection keys: render locally; never log, upload or persist them.
            void qr
              .toDataURL(uri, { width: 320, margin: 2 })
              .then((data) => {
                if (
                  mounted.current &&
                  epoch === pairingEpoch.current &&
                  !controller.signal.aborted
                ) {
                  clearTimeout(deadline);
                  setPairingQr(data);
                  setMessage("請用手機 Rabby 的 WalletConnect 掃描 QR Code，並允許連線。");
                }
              })
              .catch(() => {
                controller.abort(new Error("無法顯示連線 QR Code，請稍後重試。"));
              });
          },
        });
        // An SDK initialization may finish after timeout/cancel. Never connect that old attempt.
        void creating
          .then((connection) => {
            if (controller.signal.aborted) return connection.cancel();
          })
          .catch(() => {});
        const connection = await waitForConnection(creating, controller.signal);
        activeConnection = connection;
        if (!mounted.current || epoch !== pairingEpoch.current) {
          await connection.cancel();
          return;
        }
        mobileRef.current = connection;
        const next = await waitForConnection(connection.connect(), controller.signal);
        clearTimeout(deadline);
        if (!mounted.current || epoch !== pairingEpoch.current) {
          await connection.disconnect();
          return;
        }
        setWallets((current) => [...current.filter((wallet) => wallet.id !== next.id), next]);
        setSelected(next.id);
        setMobileConnected(true);
        setMessage("手機 Rabby 已連接。請按「連接並核對 owner」，核對原發行錢包。");
      } finally {
        clearTimeout(deadline);
        if (controller.signal.aborted) void activeConnection?.cancel().catch(() => {});
        if (connectionAbort.current === controller) connectionAbort.current = null;
        if (mounted.current && epoch === pairingEpoch.current) {
          setPairing(false);
          setPairingQr("");
        }
      }
    });
  }

  async function cancelMobile() {
    connectionAbort.current?.abort(new Error("已取消手機錢包連線。"));
    if (pairing) {
      operationRef.current++;
      busyRef.current = false;
      setBusy(false);
    }
    pairingEpoch.current++;
    setPairing(false);
    setPairingQr("");
    setMobileConnected(false);
    setAccount("");
    setReview(null);
    generation.current++;
    setWallets((current) => current.filter((wallet) => wallet.id !== "rabby-mobile-walletconnect"));
    if (selected === "rabby-mobile-walletconnect") setSelected("");
    try {
      await mobileRef.current?.cancel();
      setMessage("手機錢包已斷開；已有的交易紀錄仍保留，可繼續查核。");
    } catch {
      setMessage("已停止使用此連線。請也在手機 Rabby 中斷開連線；已有交易請先查核。");
    }
  }

  async function run(action: () => Promise<void>, eventScoped = false) {
    if (busyRef.current) return;
    const operation = ++operationRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (
        mounted.current &&
        operationRef.current === operation &&
        (!eventScoped || scopeRef.current === scope)
      ) {
        setMessage(readable(error));
        if (plan && scopeRef.current === scope) {
          try {
            setJournal(loadJournal(localStorage, plan));
          } catch {
            /* Keep issuance disabled. */
          }
        }
      }
    } finally {
      if (operationRef.current === operation) {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  async function connect() {
    await run(async () => {
      if (!choice) throw new Error("請先明確選擇你要使用的錢包。");
      const epoch = generation.current;
      const address = await requireOwnerWallet(choice.provider, true);
      if (generation.current !== epoch) throw new Error("連接期間錢包或網路變更，請重新核對。");
      setAccount(address);
      setMessage("owner 錢包已核對。請再核對發行資料。");
    });
  }

  async function check() {
    await run(async () => {
      const epoch = generation.current;
      if (!event) return;
      const result = await reviewIssuance(issuerPublicClient(), event);
      if (generation.current !== epoch) throw new Error("活動或錢包已變更，請重新核對。");
      setReview(result);
      if (result.issued && plan?.tokenId !== 10) {
        await synchronize(event, journal?.hash);
        return;
      }
      setMessage(
        result.issued
          ? status === "published" && event.tokenId
            ? "此活動已發行並已上線，禁止重複發行。"
            : "此活動已在鏈上發行，平台領取設定待同步；不必再簽名。"
          : "網路、owner、正式 metadata 與未使用的 Token 已核對。按發行後仍需本人在錢包確認並支付 Gas。",
      );
    }, true);
  }

  async function issue() {
    await run(async () => {
      if (!event || !choice || !plan || !account || !review || review.issued)
        throw new Error("請先連接 owner 錢包並完成資料核對。");
      if (!navigator.locks)
        throw new Error("此瀏覽器不支援防止重複發行的安全鎖，請更新 Safari 或 Chrome 後再試。");
      const epoch = generation.current;
      setMessage("請在本人錢包核對並確認。本頁不會替你確認；若視窗未回應，請勿重送。");
      const result = await navigator.locks.request(
        journalKey(plan),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("另一個分頁正在處理此活動，請先完成或查核該分頁。");
          return issueWithOwnerWallet({
            provider: choice.provider,
            client: issuerPublicClient(),
            event: { ...event },
            storage: localStorage,
            isCurrent: () =>
              mounted.current && generation.current === epoch && scopeRef.current === scope,
          });
        },
      );
      if (mounted.current && scopeRef.current === scope) {
        setJournal(result);
        setMessage("交易已送出，正在等待鏈上確認，接著會自動更新後台。切換活動仍會繼續同步。");
      }
      if (result.hash) {
        await issuerPublicClient().waitForTransactionReceipt({
          hash: result.hash,
          confirmations: 2,
          timeout: 60_000,
        });
        await synchronize(event, result.hash);
      }
    }, true);
  }

  async function verify() {
    if (!event) return;
    await run(async () => {
      await synchronize(event, journal?.hash);
    }, true);
  }

  async function synchronize(target: IssuanceEvent, hash?: string) {
    const sync = synchronizeRef.current;
    if (!sync || syncing.current.has(target.slug)) return;
    const currentScope = scopeRef.current;
    const isCurrent = () =>
      mounted.current && scopeRef.current === currentScope && target.slug === slugRef.current;
    syncing.current.add(target.slug);
    if (isCurrent()) {
      setSyncingSlug(target.slug);
      setMessage("正在核對鏈上交易並同步活動狀態與領取資格…");
    }
    try {
      const result = await sync(target.slug, hash);
      if (mounted.current && slugRef.current === target.slug) {
        setConfirmed(true);
        setClaimUrl(result.claimUrl);
        setMessage(
          result.status === "closed"
            ? "已發行，此活動目前已關閉。"
            : "已發行。交易、200 份領取資格與活動狀態已同步；依原訂日期開放領取。",
        );
        setReview((current) => (current ? { ...current, issued: true, active: true } : current));
      }
    } catch (error) {
      if (isCurrent())
        setMessage(`同步尚未完成：${readable(error)} 可按「重新同步發行狀態」查核，不必再次簽名。`);
      throw error;
    } finally {
      syncing.current.delete(target.slug);
      if (mounted.current) setSyncingSlug((slug) => (slug === target.slug ? "" : slug));
    }
  }

  if (!event || (!plan && !planError)) return null;
  return (
    <section className="soft-card rounded-[2rem] p-6 sm:p-9" aria-label="本人錢包發行">
      <h2 className="font-display text-2xl font-black">本人錢包發行</h2>
      <p className="mt-2 text-sm text-ink/65">
        留在 Safari 或 Chrome 完成管理登入，再連接手機 Rabby 核對與簽署交易。
      </p>
      {planError ? (
        <p role="alert" className="mt-4 text-red-800">
          {planError}
        </p>
      ) : (
        plan && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-5">
              <img
                src={event.imageUrl}
                alt={`${event.title} 發行圖案`}
                className="h-24 w-24 rounded-2xl object-cover"
              />
              <div>
                <h3 className="text-xl font-black">{event.title}</h3>
                <p>
                  Token #{plan.tokenId} · 最多 {plan.maxSupply} 份
                </p>
              </div>
            </div>
            <dl className="mt-5 space-y-2 break-all text-sm">
              <div>
                <dt className="font-bold">網路</dt>
                <dd>Base 主網 · {ISSUER_CHAIN}</dd>
              </div>
              <div>
                <dt className="font-bold">合約</dt>
                <dd>{ISSUER_CONTRACT}</dd>
              </div>
              <div>
                <dt className="font-bold">必須由此 owner 簽名</dt>
                <dd>{ISSUER_OWNER}</dd>
              </div>
              <div>
                <dt className="font-bold">正式 metadata</dt>
                <dd>
                  <a
                    className="underline"
                    href={plan.metadataUri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {plan.metadataUri}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-bold">費用</dt>
                <dd>附帶 ETH 金額為 0；本人錢包需要支付 Base Gas，金額以錢包確認畫面為準。</dd>
              </div>
            </dl>
            <div className="mt-6 rounded-2xl border border-purple/25 p-5">
              <h3 className="font-bold">連接手機 Rabby</h3>
              <p className="mt-2 text-sm text-ink/65">
                在這裡顯示 QR Code，再用手機 Rabby 的 WalletConnect 掃描並允許連線。
                連線後，發行交易會送到手機讓你核對。
              </p>
              <button
                type="button"
                className="btn-secondary mt-4"
                disabled={busy || mobileConnected || !mobileProjectId}
                onClick={() => void connectMobile()}
              >
                {pairing
                  ? pairingQr
                    ? "等待手機掃描…"
                    : "正在取得連線 QR Code…"
                  : mobileConnected
                    ? "手機 Rabby 已連接"
                    : "連接手機 Rabby"}
              </button>
              {!mobileProjectId && <p className="mt-3 text-sm">手機錢包連線正在設定中。</p>}
              {(pairing || mobileConnected) && (
                <button
                  type="button"
                  className="btn-secondary ml-3 mt-4"
                  disabled={busy && !pairing}
                  onClick={() => void cancelMobile()}
                >
                  {pairing ? "取消連線" : "斷開手機錢包"}
                </button>
              )}
              {pairingQr && (
                <div
                  className="mt-5 flex flex-col items-center gap-3"
                  role="region"
                  aria-label="手機錢包連線 QR Code"
                >
                  <img
                    src={pairingQr}
                    width="320"
                    height="320"
                    alt="請用手機 Rabby 掃描的 WalletConnect 連線 QR Code"
                    className="max-w-full rounded-2xl"
                  />
                  <p className="text-center text-sm">
                    掃描後只會連接錢包；發行時仍需要你另行確認交易。
                  </p>
                </div>
              )}
            </div>
            <label className="mt-6 block font-bold">
              已連接或瀏覽器內的錢包
              <select
                className="mt-2 w-full rounded-xl border p-3"
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">請選擇，不會自動連接</option>
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.name}
                  </option>
                ))}
              </select>
            </label>
            {!wallets.length && (
              <p className="mt-3 text-sm">
                尚未連接錢包。Safari 可使用上方「連接手機 Rabby」；Chrome 也可選擇已安裝的 Rabby
                擴充套件。
              </p>
            )}
            {account && <p className="mt-3 break-all text-sm">已核對 owner：{account}</p>}
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !choice}
                onClick={() => void connect()}
              >
                連接並核對 owner
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void check()}
              >
                核對發行資料
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  busy ||
                  syncingSlug === event.slug ||
                  confirmed ||
                  !account ||
                  !review ||
                  review.issued ||
                  !!journal
                }
                onClick={() => void issue()}
              >
                {busy && !pairing ? "處理中，請勿重送…" : "本人確認發行"}
              </button>
            </div>
            {claimQr && (
              <div className="mt-5 flex flex-col items-start gap-3">
                <img
                  src={claimQr}
                  width="240"
                  height="240"
                  alt="活動共用領取 QR Code"
                  className="rounded-2xl"
                />
                <a className="btn-secondary" href={claimQr} download={`${event.slug}-claim-qr.png`}>
                  下載領取 QR Code
                </a>
              </div>
            )}
            {claimUrl && (
              <p className="mt-5 rounded-2xl bg-mint p-4 text-sm">
                <strong>已發行</strong> ·{" "}
                <a href={claimUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  開啟活動共用領取連結
                </a>
                <span className="mt-1 block">此連結包含領取資格，請只分享給活動參加者。</span>
              </p>
            )}
            {plan.tokenId !== 10 && (
              <button
                type="button"
                className="btn-secondary mt-4"
                disabled={busy || syncingSlug === event.slug}
                onClick={() => void verify()}
              >
                {syncingSlug === event.slug ? "正在同步發行狀態…" : "重新同步發行狀態"}
              </button>
            )}
            {journal && (
              <div className="mt-5 rounded-2xl border border-ink/15 p-4">
                <p>
                  {confirmed ? "已發行，後台已同步" : "已有待確認的請求／交易，已停止重複發行。"}
                </p>
                {journal.hash ? (
                  <>
                    <a
                      className="mt-2 block break-all underline"
                      href={`https://basescan.org/tx/${journal.hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {journal.hash}
                    </a>
                    <button
                      type="button"
                      className="btn-secondary mt-3"
                      disabled={busy}
                      onClick={() => void verify()}
                    >
                      查核交易
                    </button>
                  </>
                ) : (
                  <p className="mt-2 text-sm">
                    未取得 hash
                    不代表失敗。請先查看本人錢包的待確認請求與交易紀錄，再請管理者同步；不要重新發行。
                  </p>
                )}
              </div>
            )}
            {message && (
              <p
                role="status"
                aria-live="polite"
                className="mt-5 break-words rounded-2xl bg-paper p-4 text-sm"
              >
                {message}
              </p>
            )}
            <p className="mt-4 text-xs text-ink/55">
              簽署後會自動核對交易並同步後台。切換活動會保留錢包連線，每場發行仍須本人在 Rabby
              確認。
            </p>
          </>
        )
      )}
    </section>
  );
}

function readable(error: unknown) {
  if ((error as { code?: number })?.code === 4001)
    return "你已取消錢包請求；沒有自動重送。可以重新核對後再決定。";
  if ((error as { name?: string })?.name === "TransactionReceiptNotFoundError")
    return "交易尚未取得回執，不代表失敗。請稍後查核，勿重送。";
  return error instanceof Error
    ? error.message
    : "操作未完成；若已要求簽名，請先查核錢包交易紀錄，勿重送。";
}
