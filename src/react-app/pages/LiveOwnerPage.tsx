import { useEffect, useState } from "react";
import { getLiveHoldings } from "../api";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";
import { Link } from "../router";
import type { LiveHolding } from "../types";
import { isAbortError } from "../utils";

export function LiveOwnerPage({ address }: { address: string }) {
  const [items, setItems] = useState<LiveHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    getLiveHoldings(address, controller.signal)
      .then((response) => setItems(response.items))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setError("目前無法載入收藏，請稍後再試。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [address, retry]);

  useEffect(() => {
    document.title = `${shortAddress(address)} · 協會數位紀念章`;
  }, [address]);

  return (
    <main className="owner-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/#address">
        ← 查詢另一個地址
      </Link>
      <section className="owner-intro glass-panel">
        <div className="owner-intro__copy">
          <span className="eyebrow">Base 鏈上收藏</span>
          <h1>協會數位紀念章</h1>
          <div className="owner-identity">
            <strong>{shortAddress(address)}</strong>
            <code>{address}</code>
          </div>
          <p>這裡顯示系統已確認由此地址持有的協會數位紀念章。</p>
        </div>
      </section>

      <section className="archive-section live-holdings" aria-labelledby="live-owner-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">目前收藏</span>
            <h2 id="live-owner-heading">共 {items.length} 枚</h2>
          </div>
        </div>
        {loading ? <GridSkeleton count={3} /> : null}
        {error ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState title="這個地址目前沒有協會數位紀念章">
            若剛完成鑄造，鏈上索引可能需要一點時間更新。
          </EmptyState>
        ) : null}
        {items.length > 0 ? (
          <div className="drop-grid">
            {items.map((item) => (
              <article className="drop-card live-holding-card" key={item.eventId}>
                <div className="drop-card__artwork">
                  <img src={item.imageUrl} alt="" loading="lazy" />
                </div>
                <div className="drop-card__body">
                  <span className="eyebrow">
                    {item.mintStatus === "minted"
                      ? item.ownershipSource === "chain-index"
                        ? "Base · 鏈上目前持有"
                        : "Base · 已鑄造，等待索引"
                      : "Base · 已保留"}
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <span className="search-hint">
                    {formatTime(item.chainSyncedAt ?? item.claimedAt)}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
