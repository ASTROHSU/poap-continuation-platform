import { useEffect, useRef, useState } from "react";
import { getDropCollectors } from "../api";
import { Link } from "../router";
import type { DropCollector } from "../types";
import { isAbortError } from "../utils";

export function DropCollectors({ dropId, tokenCount }: { dropId: number; tokenCount?: number }) {
  const [collectors, setCollectors] = useState<DropCollector[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setCollectors([]);
    setCursor(null);
    setError("");
    setLoading(true);
    setLoadingMore(false);
    getDropCollectors(dropId, null, controller.signal)
      .then((response) => {
        setCollectors(response.items);
        setCursor(response.nextCursor);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Could not load archived collectors");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [dropId, retry]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getDropCollectors(dropId, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setCollectors((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more archived collectors");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  const countMismatch =
    !loading &&
    !error &&
    !cursor &&
    typeof tokenCount === "number" &&
    tokenCount !== collectors.length;

  return (
    <section className="drop-collectors glass-panel" aria-labelledby="collectors-heading">
      <div className="section-heading drop-collectors__heading">
        <div>
          <span className="eyebrow">Holdings snapshot</span>
          <h2 id="collectors-heading">Collectors</h2>
        </div>
        {!loading ? (
          <span className="result-count" aria-live="polite">
            {typeof tokenCount === "number"
              ? `${formatCount(collectors.length)} of ${formatCount(tokenCount)} records loaded`
              : `${formatCount(collectors.length)} records loaded`}
          </span>
        ) : null}
      </div>
      <p className="drop-collectors__intro">
        Public holder addresses preserved with each POAP in the archive snapshot. Open an address to
        browse its complete preserved collection.
      </p>

      {loading ? <CollectorRowsSkeleton /> : null}
      {!loading && error && collectors.length === 0 ? (
        <div className="drop-collectors__error" role="alert">
          <p>{error}</p>
          <button
            className="button button--outline"
            type="button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {!loading && !error && collectors.length === 0 ? (
        <div className="drop-collectors__empty">
          No collector records were preserved for this Drop in the Holdings snapshot.
        </div>
      ) : null}
      {collectors.length > 0 ? (
        <ol className="drop-collectors__list">
          {collectors.map((collector) => (
            <li key={`${collector.poapId}:${collector.ownerAddress}`}>
              <Link className="drop-collector__address" href={`/address/${collector.ownerAddress}`}>
                <strong>{shortAddress(collector.ownerAddress)}</strong>
                <code>{collector.ownerAddress}</code>
              </Link>
              <div className="drop-collector__facts">
                <span>POAP #{collector.poapId}</span>
                <span>{formatMintedOn(collector.mintedOn)}</span>
                <span>{collector.network || "Network unavailable"}</span>
                <span>
                  {formatCount(collector.transferCount)}{" "}
                  {collector.transferCount === 1 ? "transfer" : "transfers"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {countMismatch ? (
        <p className="drop-collectors__notice" role="status">
          Drop metadata reports {formatCount(tokenCount)} POAPs, while the Holdings snapshot
          preserved {formatCount(collectors.length)} collector records. The source snapshots may
          have been captured at different times.
        </p>
      ) : null}
      {error && collectors.length > 0 ? (
        <p className="drop-collectors__notice drop-collectors__notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {cursor ? (
        <div className="load-more">
          <button
            className="button button--outline"
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? "Loading…" : "Load more collectors"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CollectorRowsSkeleton() {
  return (
    <div className="drop-collectors__skeleton" role="status" aria-label="Loading collectors">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <span className="skeleton skeleton--heading" />
          <span className="skeleton skeleton--line" />
        </div>
      ))}
    </div>
  );
}

function formatMintedOn(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Mint date unavailable";
  const date = new Date(value * 1_000);
  if (Number.isNaN(date.getTime())) return "Mint date unavailable";
  return `Minted ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)}`;
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatCount(value?: number) {
  return typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—";
}
