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
  verifyIssuanceReceipt,
  type IssuanceEvent,
  type IssuanceJournal,
  type WalletChoice,
} from "../lib/issuer-wallet";

export default function IssuerWalletPanel({
  event,
  status,
}: {
  event: IssuanceEvent;
  status: string;
}) {
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [account, setAccount] = useState("");
  const [review, setReview] = useState<Awaited<ReturnType<typeof reviewIssuance>> | null>(null);
  const [journal, setJournal] = useState<IssuanceJournal | null>(null);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  let plan: ReturnType<typeof issuancePlan> = null;
  let planError = "";
  try {
    plan = issuancePlan(event);
  } catch (error) {
    planError = readable(error);
  }
  const choice = wallets.find((wallet) => wallet.id === selected);

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
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setReview(null);
    setConfirmed(false);
    if (plan) {
      try {
        setJournal(loadJournal(localStorage, plan));
      } catch {
        setMessage("瀏覽器無法保存待確認交易，請允許此網站的本機儲存後再操作。");
      }
    }
  }, [
    event.slug,
    event.title,
    event.imageUrl,
    event.maxSupply,
    event.tokenId,
    event.contractAddress,
  ]);
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
    choice.provider.on?.("accountsChanged", changed);
    choice.provider.on?.("chainChanged", changed);
    choice.provider.on?.("disconnect", changed);
    return () => {
      choice.provider.removeListener?.("accountsChanged", changed);
      choice.provider.removeListener?.("chainChanged", changed);
      choice.provider.removeListener?.("disconnect", changed);
    };
  }, [choice]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (mounted.current) {
        setMessage(readable(error));
        if (plan) {
          try {
            setJournal(loadJournal(localStorage, plan));
          } catch {
            /* Keep issuance disabled. */
          }
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
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
      const result = await reviewIssuance(issuerPublicClient(), event);
      if (generation.current !== epoch) throw new Error("活動或錢包已變更，請重新核對。");
      setReview(result);
      setMessage(
        result.issued
          ? status === "published" && event.tokenId
            ? "此活動已發行並已上線，禁止重複發行。"
            : "此活動已在鏈上發行，平台領取設定待同步；不必再簽名。"
          : "網路、owner、正式 metadata 與未使用的 Token 已核對。按發行後仍需本人在錢包確認並支付 Gas。",
      );
    });
  }

  async function issue() {
    await run(async () => {
      if (!choice || !plan || !account || !review || review.issued)
        throw new Error("請先連接 owner 錢包並完成資料核對。");
      if (!navigator.locks)
        throw new Error(
          "此瀏覽器不支援防止重複發行的安全鎖。請使用裝有 Rabby 的最新版桌面瀏覽器。",
        );
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
            isCurrent: () => mounted.current && generation.current === epoch,
          });
        },
      );
      if (!mounted.current) return;
      setJournal(result);
      setMessage("已取得交易 hash。請按「查核交易」確認鏈上結果；不會自動重送。");
    });
  }

  async function verify() {
    await run(async () => {
      if (!plan || !journal?.hash)
        throw new Error("沒有可查核的交易 hash。請先在錢包交易紀錄確認結果，勿重送。");
      await verifyIssuanceReceipt(issuerPublicClient(), plan, journal.hash);
      const current = await reviewIssuance(issuerPublicClient(), event);
      if (!current.issued || !current.active) throw new Error("鏈上活動狀態未就緒，請勿重送。");
      setReview(current);
      setConfirmed(true);
      setMessage(
        "本人發行交易已確認，活動參數完全相符。平台的資格、QR 與發布設定待同步；目前不能據此宣稱已可領取。",
      );
    });
  }

  if (!plan && !planError) return null;
  return (
    <section className="soft-card rounded-[2rem] p-6 sm:p-9" aria-label="本人錢包發行">
      <h2 className="font-display text-2xl font-black">本人錢包發行</h2>
      <p className="mt-2 text-sm text-ink/65">
        使用你自己的 Rabby 或 Trust Wallet 瀏覽器。Email 管理登入與 owner
        錢包分開；不需要提供私鑰或助記詞。
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
            <label className="mt-6 block font-bold">
              選擇本人錢包
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
                此瀏覽器沒有提供錢包。請在自己已安裝 Rabby 的瀏覽器開啟此後台，或使用 Trust Wallet
                的 DApp 瀏覽器；不要使用 ChatGPT 預填分頁。
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
                disabled={busy || !account || !review || review.issued || !!journal}
                onClick={() => void issue()}
              >
                {busy ? "處理中，請勿重送…" : "本人確認發行"}
              </button>
            </div>
            {journal && (
              <div className="mt-5 rounded-2xl border border-ink/15 p-4">
                <p>
                  {confirmed
                    ? "鏈上已確認，平台待同步"
                    : "已有待確認的請求／交易，已停止重複發行。"}
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
              簽名後仍須完成平台領取資格與發布同步。本頁不會呼叫伺服器 signer、代付、代領或自動
              mint。
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
