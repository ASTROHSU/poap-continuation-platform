import { useEffect, useMemo, useRef, useState } from "react";
import { getOwner, getPersonalExportManifest } from "../api";
import { DropCard } from "../components/DropCard";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";
import { DownloadIcon } from "../icons";
import { Link } from "../router";
import type { ArchiveMeta, Holding, PersonalExportManifest } from "../types";
import { isAbortError } from "../utils";

const MAX_SYNC_EXPORT_RECORDS = 5_000;

interface OwnerPageProps {
  address: string;
  meta: ArchiveMeta | null;
}

export function OwnerPage({ address, meta }: OwnerPageProps) {
  const [items, setItems] = useState<Holding[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [uniqueDrops, setUniqueDrops] = useState<number | null>(null);
  const [manifest, setManifest] = useState<PersonalExportManifest | null>(null);
  const [manifestUnavailable, setManifestUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const valid = /^0x[a-f0-9]{40}$/.test(address);
  const groupedHoldings = useMemo(() => groupHoldingsByMonth(items), [items]);

  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement("meta");
    const previousContent = existing?.content;
    if (!existing) {
      robots.name = "robots";
      document.head.appendChild(robots);
    }
    robots.content = "noindex,nofollow";
    document.title = `${shortAddress(address)} · POAP Archive`;
    return () => {
      if (existing) robots.content = previousContent ?? "";
      else robots.remove();
    };
  }, [address]);

  useEffect(() => {
    if (!valid) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setItems([]);
    setCursor(null);
    setTotal(null);
    setUniqueDrops(null);
    getOwner(address, null, controller.signal)
      .then((response) => {
        setItems(response.items);
        setCursor(response.nextCursor);
        setTotal(response.total);
        setUniqueDrops(response.uniqueDrops ?? null);
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [address, retry, valid]);

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    setManifest(null);
    setManifestUnavailable(false);
    getPersonalExportManifest(address, controller.signal)
      .then(setManifest)
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setManifestUnavailable(true);
      });
    return () => controller.abort();
  }, [address, valid]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getOwner(address, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
      setTotal(response.total);
      setUniqueDrops(response.uniqueDrops ?? uniqueDrops);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Could not load more holdings");
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  if (!valid) {
    return (
      <main className="owner-page shell" id="main-content" tabIndex={-1}>
        <Link className="back-link" href="/">
          ← Back to the archive
        </Link>
        <EmptyState title="That address is not valid">
          Use a complete 0x address with 40 hexadecimal characters.
        </EmptyState>
      </main>
    );
  }

  const encoded = encodeURIComponent(address);
  const exportTooLarge = total !== null && total > MAX_SYNC_EXPORT_RECORDS;
  const relationCounts = manifest?.counts;

  return (
    <main className="owner-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/#address">
        ← Try another address
      </Link>
      <section className="owner-intro glass-panel">
        <div className="owner-intro__copy">
          <span className="eyebrow">Address-bound collection snapshot</span>
          <h1>POAP collection</h1>
          <div className="owner-identity">
            <strong>{shortAddress(address)}</strong>
            <code>{address}</code>
          </div>
          <p>
            Holdings recorded at {meta ? formatSnapshot(meta.snapshotAt) : "the archive snapshot"}.
            This is not a live wallet view.
          </p>
        </div>
      </section>

      <dl className="owner-summary" aria-label="Address archive summary">
        <OwnerMetric value={relationCounts?.holdings ?? total} label="POAPs held" />
        <OwnerMetric value={uniqueDrops} label="unique Drops" />
        <OwnerMetric value={relationCounts?.ownedCollections} label="owned Collections" />
        <OwnerMetric value={relationCounts?.authoredMoments} label="created Moments" />
        <OwnerMetric value={relationCounts?.taggedMoments} label="tagged Moments" />
        <OwnerMetric value={relationCounts?.ownedCapsules} label="public Capsules" />
      </dl>
      <div className="owner-summary__note">
        <span>
          Counts come from independent preserved snapshots and may represent different capture
          times.
        </span>
        <div className="owner-summary__links">
          <Link href={`/address/${address}/site`}>Build personal site →</Link>
          <Link href={`/owners/${address}/moments`}>Browse created Moments →</Link>
        </div>
      </div>
      {manifestUnavailable ? (
        <p className="owner-related-warning" role="status">
          Collection and Moment counts are temporarily unavailable. The POAP collection is still
          available below.
        </p>
      ) : null}

      <section className="archive-section owner-holdings" aria-labelledby="holdings-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Preserved collection</span>
            <h2 id="holdings-heading">Held POAPs</h2>
          </div>
          {!loading ? (
            <span className="result-count" aria-live="polite">
              {total === null
                ? `${items.length} loaded`
                : `${items.length} of ${new Intl.NumberFormat("en").format(total)} loaded`}
            </span>
          ) : null}
        </div>

        {loading ? <GridSkeleton /> : null}
        {!loading && error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState title="No POAPs in this snapshot">
            The address may have received POAPs after the archive date, or held none at that time.
          </EmptyState>
        ) : null}
        {items.length ? (
          <div className="owner-timeline">
            {groupedHoldings.map((group) => (
              <section
                className="owner-month"
                aria-labelledby={`month-${group.key}`}
                key={group.key}
              >
                <div className="owner-month__heading">
                  <h3 id={`month-${group.key}`}>{group.label}</h3>
                  <span>{group.items.length} loaded</span>
                </div>
                <div className="drop-grid">
                  {group.items.map(({ holding, index }) => (
                    <DropCard
                      drop={holding}
                      priority={index < 2}
                      tokenLabel={`${holding.network || "unknown network"} · token ${holding.poapId}`}
                      key={holding.sourceUid}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}
        {error && items.length > 0 ? <ErrorState message={error} /> : null}
        {cursor ? (
          <div className="load-more">
            <button
              className="button button--outline"
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more POAPs"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="export-panel">
        <div>
          <span className="eyebrow">Portable by design</span>
          <h2>Take the whole history with you</h2>
          <p>
            Build a deployable personal site containing every preserved held Drop—including private
            Drop metadata tied to this address—plus Collections, authored and tagged Moments, and
            public Capsules.
          </p>
        </div>
        <div className="export-panel__actions">
          <Link className="button button--gold" href={`/address/${address}/site`}>
            <DownloadIcon />
            Build personal site
          </Link>
          {!exportTooLarge ? (
            <>
              <a
                className="button button--outline"
                href={`/api/owners/${encoded}/export.csv`}
                download
              >
                Download CSV
              </a>
              <a
                className="button button--outline"
                href={`/api/owners/${encoded}/export.json`}
                download
              >
                Download JSON
              </a>
            </>
          ) : null}
        </div>
        {exportTooLarge ? (
          <p className="export-panel__limit" role="status">
            The legacy one-file CSV/JSON download stops at 5,000 records. The personal-site exporter
            above is paginated and supports this complete address.
          </p>
        ) : null}
      </section>

      <div className="privacy-note">
        <strong>Public holdings, address-bound detail.</strong>
        <span>
          Preserved private Drop metadata appears only when this exact address held a matching
          token. Private Drops can also be opened by an exact known Drop ID; address discovery,
          holder lists, browsing, and search remain intentionally unavailable.
        </span>
      </div>
    </main>
  );
}

function OwnerMetric({ value, label }: { value: number | null | undefined; label: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—"}</dd>
    </div>
  );
}

function groupHoldingsByMonth(items: Holding[]) {
  const groups = new Map<
    string,
    { key: string; label: string; items: Array<{ holding: Holding; index: number }> }
  >();

  items.forEach((holding, index) => {
    const date =
      typeof holding.mintedOn === "number" && Number.isFinite(holding.mintedOn)
        ? new Date(holding.mintedOn * 1_000)
        : null;
    const validDate = date && !Number.isNaN(date.getTime());
    const key = validDate
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
      : "unknown";
    const label = validDate
      ? `Minted in ${new Intl.DateTimeFormat("en", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(date)}`
      : "Mint date unavailable";
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push({ holding, index });
    groups.set(key, group);
  });

  return [...groups.values()].sort((left, right) => {
    if (left.key === "unknown") return 1;
    if (right.key === "unknown") return -1;
    return right.key.localeCompare(left.key);
  });
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatSnapshot(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
