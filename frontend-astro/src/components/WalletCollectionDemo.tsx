import { useEffect, useMemo, useState } from "react";
import {
  getArchiveDrop,
  getArchiveHoldings,
  getLegacyPoapHoldings,
  getLiveHoldings,
  readableError,
  type ArchiveDropDetail,
  type ArchiveHolding,
  type LegacyPoapHolding,
  type LiveHolding,
} from "../lib/live-api";

export default function WalletCollectionDemo({ address }: { address: string }) {
  const [items, setItems] = useState<LiveHolding[] | null>(null);
  const [archiveItems, setArchiveItems] = useState<ArchiveHolding[] | null>(null);
  const [legacyItems, setLegacyItems] = useState<LegacyPoapHolding[] | null>(null);
  const [legacyComplete, setLegacyComplete] = useState(false);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resolvedAddress, setResolvedAddress] = useState(address);
  const [error, setError] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const [legacyError, setLegacyError] = useState("");
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [archiveDetail, setArchiveDetail] = useState<ArchiveDropDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    let active = true;
    setItems(null);
    setArchiveItems(null);
    setLegacyItems(null);
    setError("");
    setArchiveError("");
    setLegacyError("");
    setLegacyComplete(false);
    Promise.allSettled([
      getLiveHoldings(address),
      getArchiveHoldings(address),
      getLegacyPoapHoldings(address),
    ]).then(([liveResult, archiveResult, legacyResult]) => {
      if (!active) return;
      if (liveResult.status === "fulfilled") {
        setResolvedAddress(liveResult.value.address);
        setItems(liveResult.value.items);
      } else {
        setError(readableError(liveResult.reason));
        setItems([]);
      }
      if (archiveResult.status === "fulfilled") {
        setResolvedAddress(archiveResult.value.address);
        setArchiveItems(archiveResult.value.items);
        setArchiveTotal(archiveResult.value.total);
        setArchiveCursor(archiveResult.value.nextCursor);
      } else {
        setArchiveError(readableError(archiveResult.reason));
        setArchiveItems([]);
        setArchiveTotal(0);
        setArchiveCursor(null);
      }
      if (legacyResult.status === "fulfilled") {
        setResolvedAddress(legacyResult.value.address);
        setLegacyItems(legacyResult.value.items);
        setLegacyComplete(legacyResult.value.complete);
      } else {
        setLegacyError(readableError(legacyResult.reason));
        setLegacyItems([]);
        setLegacyComplete(false);
      }
    });
    return () => {
      active = false;
    };
  }, [address]);

  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selected]);

  useEffect(() => {
    let active = true;
    setArchiveDetail(null);
    setDetailError("");
    if (!selected || selected.source !== "archive" || selected.dropId === null) {
      setDetailLoading(false);
      return () => {
        active = false;
      };
    }
    setDetailLoading(true);
    getArchiveDrop(selected.dropId)
      .then((detail) => {
        if (active) setArchiveDetail(detail);
      })
      .catch((problem) => {
        if (active) setDetailError(readableError(problem));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const loadMoreArchive = async () => {
    if (!archiveCursor || loadingMore) return;
    setLoadingMore(true);
    setArchiveError("");
    try {
      const result = await getArchiveHoldings(address, archiveCursor);
      setArchiveItems((current) => [...(current ?? []), ...result.items]);
      setArchiveCursor(result.nextCursor);
      setArchiveTotal(result.total);
    } catch (problem) {
      setArchiveError(readableError(problem));
    } finally {
      setLoadingMore(false);
    }
  };

  const loading = items === null || archiveItems === null || legacyItems === null;
  const legacyDisplayCount = legacyComplete ? (legacyItems?.length ?? 0) : archiveTotal;
  const total = (items?.length ?? 0) + legacyDisplayCount;
  const hasAny =
    (items?.length ?? 0) > 0 ||
    (legacyComplete ? (legacyItems?.length ?? 0) > 0 : (archiveItems?.length ?? 0) > 0);
  const unavailable = Boolean(error && archiveError && legacyError);
  const monthGroups = useMemo(
    () =>
      groupCollectionByMonth(
        items ?? [],
        archiveItems ?? [],
        legacyItems ?? [],
        legacyComplete,
        resolvedAddress,
      ),
    [items, archiveItems, legacyItems, legacyComplete, resolvedAddress],
  );

  return (
    <div>
      <div className="flex flex-col gap-5 border-b border-ink/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="eyebrow">COLLECTORS</span>
          <h1 className="display-title mt-5 text-5xl sm:text-6xl">POAP 收藏</h1>
          <p className="mt-4 max-w-xl break-all font-mono text-xs text-ink/42">{resolvedAddress}</p>
        </div>
        <span className="self-start rounded-full border-2 border-[#7669d8] bg-white px-5 py-2.5 font-display text-sm font-bold text-[#4f457c] shadow-[4px_5px_0_#ddd9ff] sm:self-auto">
          {total.toLocaleString("zh-TW")} 枚 POAP
        </span>
      </div>
      {loading ? (
        <div className="mt-10 space-y-8" aria-label="正在載入收藏">
          {[0, 1, 2].map((group) => (
            <div key={group}>
              <div className="h-7 w-36 animate-pulse rounded-full bg-ink/8" />
              <div className="mt-5 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
                {[0, 1, 2, 3, 4].map((item) => (
                  <div
                    key={item}
                    className="aspect-square animate-pulse rounded-full bg-[#e7e3ff]"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="mt-9 soft-card rounded-[2rem] p-10 text-center">
          <h2 className="text-2xl font-bold">目前無法讀取收藏</h2>
          <p className="mt-3 text-sm text-ink/55">{archiveError || error}</p>
        </div>
      ) : hasAny ? (
        <>
          {(error || archiveError || legacyError || !legacyComplete) && (
            <p className="mt-7 rounded-2xl bg-blush/35 px-5 py-4 text-sm font-bold text-ink/65">
              {legacyError || !legacyComplete
                ? "鏈上收藏正在使用歷史快照補足；少數近期或已轉移的 POAP 可能稍後才會更新。"
                : "部分收藏暫時無法載入，已先顯示可讀取的內容。"}
            </p>
          )}
          <div className="mt-10 space-y-10 sm:space-y-12">
            {monthGroups.map((group) => (
              <section key={group.key} aria-labelledby={`collection-month-${group.key}`}>
                <h2
                  className="font-display text-2xl font-bold tracking-[-0.03em] text-[#40375f] sm:text-3xl"
                  id={`collection-month-${group.key}`}
                >
                  {group.label}
                </h2>
                <div className="mt-5 grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 sm:gap-6 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
                  {group.items.map((item, index) => (
                    <figure
                      className="group min-w-0"
                      key={item.key}
                      title={`${item.title} · ${item.fullDate}`}
                    >
                      <button
                        className="block aspect-square w-full rounded-full border-[3px] border-[#a89cff] bg-white p-[3px] shadow-[0_5px_0_rgba(193,186,255,.55)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_8px_0_rgba(193,186,255,.45)] focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#7669d8]"
                        type="button"
                        aria-label={`查看 ${item.title} 的收藏詳情`}
                        onClick={() => setSelected(item)}
                      >
                        <img
                          className="h-full w-full rounded-full object-cover"
                          src={item.imageUrl}
                          alt={`${item.title}，${item.fullDate}`}
                          loading={index < 8 ? "eager" : "lazy"}
                        />
                      </button>
                      <figcaption className="sr-only">{item.title}</figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {!legacyComplete && archiveCursor && (
            <div className="mt-9 text-center">
              <button
                className="btn-secondary"
                type="button"
                disabled={loadingMore}
                onClick={loadMoreArchive}
              >
                {loadingMore
                  ? "載入中…"
                  : `載入更多歷史 POAP（已顯示 ${archiveItems?.length ?? 0} / ${archiveTotal}）`}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="mt-9 grid min-h-80 place-items-center rounded-[2rem] border border-dashed border-ink/15 bg-white/25 p-8 text-center">
          <div>
            <span className="font-display text-6xl text-ink/18">0</span>
            <h2 className="mt-5 font-display text-3xl font-bold">尚未有收藏</h2>
            <p className="mt-3 text-sm text-ink/48">請使用主辦單位提供的專屬領取連結。</p>
          </div>
        </div>
      )}
      {selected ? (
        <CollectionDetail
          item={selected}
          archiveDetail={archiveDetail}
          loading={detailLoading}
          error={detailError}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

interface GalleryItem {
  key: string;
  title: string;
  imageUrl: string;
  date: Date;
  fullDate: string;
  source: "archive" | "legacy" | "live";
  dropId: number | null;
  tokenLabel: string;
  ownerAddress: string;
  network: string;
  mintedDate: string;
  collectorCount: number;
  location: string;
  description: string | null;
  eventUrl: string | null;
  technicalUrl: string | null;
}

interface MonthGroup {
  key: string;
  label: string;
  items: GalleryItem[];
}

function groupCollectionByMonth(
  liveItems: LiveHolding[],
  archiveItems: ArchiveHolding[],
  legacyItems: LegacyPoapHolding[],
  legacyComplete: boolean,
  ownerAddress: string,
): MonthGroup[] {
  const archiveByToken = new Map(
    archiveItems.map((item) => [`${normalizeArchiveNetwork(item.network)}:${item.poapId}`, item]),
  );
  const historicalItems: GalleryItem[] = legacyComplete
    ? legacyItems.map((item) => {
        const archive = archiveByToken.get(`${item.network}:${item.poapId}`);
        return toGalleryItem(
          `legacy-${item.chainId}-${item.poapId}`,
          {
            title: archive?.title ?? item.title,
            imageUrl: archive?.imageUrl || item.imageUrl,
            startsAt: archive?.startDate ?? item.startDate,
          },
          {
            source: archive ? "archive" : "legacy",
            dropId: archive?.dropId ?? item.dropId,
            tokenLabel: `Token #${item.poapId}`,
            ownerAddress,
            network: legacyNetworkName(item.network),
            mintedDate: item.mintedAt ? formatTimestamp(item.mintedAt) : "未保存",
            collectorCount: archive?.tokenCount ?? 0,
            location:
              [archive?.city ?? item.city, archive?.country ?? item.country]
                .filter(Boolean)
                .join(" · ") || "未提供",
            description: item.description,
            eventUrl: item.eventUrl,
            technicalUrl: item.explorerUrl,
          },
        );
      })
    : archiveItems.map((item) =>
        toGalleryItem(
          `archive-${item.sourceUid}`,
          {
            title: item.title,
            imageUrl: item.imageUrl,
            startsAt: item.startDate,
          },
          {
            source: "archive",
            dropId: item.dropId,
            tokenLabel: `Token #${item.poapId}`,
            ownerAddress: item.ownerAddress,
            network: archiveNetworkName(item.network),
            mintedDate: item.mintedOn ? formatTimestamp(item.mintedOn * 1000) : "未保存",
            collectorCount: item.tokenCount,
            location: [item.city, item.country].filter(Boolean).join(" · ") || "未提供",
            description: null,
            eventUrl: null,
            technicalUrl: null,
          },
        ),
      );
  const galleryItems: GalleryItem[] = [
    ...liveItems.map((item) =>
      toGalleryItem(`live-${item.eventId}-${item.tokenId}`, item, {
        source: "live",
        dropId: null,
        tokenLabel: item.tokenId ? `Token #${item.tokenId}` : "數位紀念",
        ownerAddress,
        network: chainName(item.chainId),
        mintedDate: formatTimestamp(item.mintedAt ?? item.claimedAt),
        collectorCount: item.mintedCount,
        location: "線上活動",
        description: item.description,
        eventUrl: item.eventUrl,
        technicalUrl: item.mintedTxHash
          ? `https://sepolia.basescan.org/tx/${item.mintedTxHash}`
          : null,
      }),
    ),
    ...historicalItems,
  ].sort((left, right) => right.date.getTime() - left.date.getTime());

  const groups = new Map<string, MonthGroup>();
  for (const item of galleryItems) {
    const valid = !Number.isNaN(item.date.getTime());
    const key = valid
      ? `${item.date.getUTCFullYear()}-${String(item.date.getUTCMonth() + 1).padStart(2, "0")}`
      : "unknown";
    const label = valid
      ? new Intl.DateTimeFormat("zh-TW", {
          year: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(item.date)
      : "日期未定";
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function toGalleryItem(
  key: string,
  item: { title: string; imageUrl: string; startsAt: string },
  metadata: Omit<GalleryItem, "key" | "title" | "imageUrl" | "date" | "fullDate">,
): GalleryItem {
  const date = new Date(item.startsAt);
  const fullDate = Number.isNaN(date.getTime())
    ? "日期未定"
    : new Intl.DateTimeFormat("zh-TW", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
  return { key, title: item.title, imageUrl: item.imageUrl, date, fullDate, ...metadata };
}

function CollectionDetail({
  item,
  archiveDetail,
  loading,
  error,
  onClose,
}: {
  item: GalleryItem;
  archiveDetail: ArchiveDropDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const description = archiveDetail?.description ?? item.description;
  const eventUrl = archiveDetail?.eventUrl ?? item.eventUrl;
  const location =
    [archiveDetail?.city, archiveDetail?.country].filter(Boolean).join(" · ") || item.location;
  const dropLabel = item.dropId ? `Drop #${item.dropId}` : "新發行";

  return (
    <div
      className="fixed inset-0 z-[80] overflow-y-auto bg-[#fbfaff] text-ink"
      role="dialog"
      aria-modal="true"
      aria-label={`${item.title} 收藏詳情`}
    >
      <div className="mx-auto min-h-full max-w-3xl pb-16">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#dedaff] bg-[#fbfaff]/95 px-5 py-4 backdrop-blur sm:px-8">
          <button
            className="grid h-11 w-11 place-items-center rounded-full border-2 border-[#7669d8] bg-white text-2xl font-bold text-[#4f457c] shadow-[3px_4px_0_#ddd9ff]"
            type="button"
            onClick={onClose}
            aria-label="返回收藏"
          >
            ←
          </button>
          <span className="font-display text-sm font-bold text-[#665b9a]">POAP 收藏</span>
          <span className="h-11 w-11" aria-hidden="true" />
        </header>

        <main>
          <section className="relative overflow-hidden bg-[#efedff] px-6 py-12 text-center sm:rounded-b-[3rem] sm:px-10 sm:py-16">
            <div className="absolute -left-12 top-12 h-28 w-28 rounded-full bg-[#ffc6d7]/65" />
            <div className="absolute -right-14 bottom-6 h-36 w-36 rounded-full bg-[#ccecc0]/70" />
            <div className="relative mx-auto aspect-square w-[min(72vw,22rem)] rounded-full border-[4px] border-[#a89cff] bg-white p-2 shadow-[0_12px_0_rgba(193,186,255,.55)]">
              <img
                className="h-full w-full rounded-full object-cover"
                src={item.imageUrl}
                alt={item.title}
              />
            </div>
          </section>

          <section className="px-5 pt-8 sm:px-10 sm:pt-10">
            <div className="flex flex-wrap gap-2 text-xs font-extrabold text-[#665b9a]">
              <span className="rounded-full bg-[#efedff] px-3 py-1.5">{dropLabel}</span>
              <span className="rounded-full bg-[#efedff] px-3 py-1.5">{item.tokenLabel}</span>
              {item.collectorCount > 0 ? (
                <span className="rounded-full bg-[#efedff] px-3 py-1.5">
                  {item.collectorCount.toLocaleString("zh-TW")} 人收藏
                </span>
              ) : null}
            </div>

            <h1 className="mt-5 font-display text-3xl font-bold leading-tight tracking-[-0.035em] sm:text-5xl">
              {item.title}
            </h1>

            <dl className="mt-7 grid gap-4 rounded-[2rem] border-2 border-[#dedaff] bg-white p-5 shadow-[6px_7px_0_#efedff] sm:grid-cols-2 sm:p-7">
              <Metadata label="收藏地址" value={item.ownerAddress} mono />
              <Metadata label="鑄造時間" value={item.mintedDate} />
              <Metadata label="活動日期" value={item.fullDate} />
              <Metadata label="網路" value={item.network} />
              <Metadata label="地點" value={location} />
              <Metadata label="紀念編號" value={`${dropLabel} · ${item.tokenLabel}`} />
            </dl>

            {loading ? (
              <div className="mt-8 h-28 animate-pulse rounded-[2rem] bg-[#efedff]" />
            ) : description ? (
              <section className="mt-9">
                <h2 className="font-display text-2xl font-bold">關於這份紀念</h2>
                <p className="mt-4 whitespace-pre-line text-base leading-8 text-ink/65">
                  {description}
                </p>
              </section>
            ) : null}

            {error ? <p className="mt-6 text-sm text-ink/45">部分活動說明暫時無法載入。</p> : null}

            {eventUrl || item.technicalUrl ? (
              <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 border-t border-ink/10 pt-6 text-sm font-bold text-[#665b9a]">
                {eventUrl ? (
                  <a href={eventUrl} target="_blank" rel="noreferrer">
                    活動連結 ↗
                  </a>
                ) : null}
                {item.technicalUrl ? (
                  <a href={item.technicalUrl} target="_blank" rel="noreferrer">
                    鏈上紀錄 ↗
                  </a>
                ) : null}
              </div>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

function Metadata({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold tracking-wider text-ink/38">{label}</dt>
      <dd className={`mt-1.5 break-words font-bold text-ink/78 ${mono ? "font-mono text-xs" : ""}`}>
        {value || "未提供"}
      </dd>
    </div>
  );
}

function formatTimestamp(value: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未保存";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(date);
}

function archiveNetworkName(value: string) {
  if (value.toLowerCase() === "xdai" || value.toLowerCase() === "gnosis") return "Gnosis";
  if (value.toLowerCase() === "eth" || value.toLowerCase() === "ethereum") return "Ethereum";
  return value || "未保存";
}

function normalizeArchiveNetwork(value: string) {
  const network = value.toLowerCase();
  if (network === "arbitrum" || network === "arbitrum-one") return "arbitrum-one";
  if (network === "xdai" || network === "gnosis") return "gnosis";
  if (network === "eth" || network === "ethereum") return "ethereum";
  if (network === "base") return "base";
  return network;
}

function legacyNetworkName(value: LegacyPoapHolding["network"]) {
  if (value === "arbitrum-one") return "Arbitrum";
  if (value === "gnosis") return "Gnosis";
  if (value === "ethereum") return "Ethereum";
  return "Base";
}

function chainName(chainId: number) {
  if (chainId === 84532) return "Base Sepolia";
  if (chainId === 8453) return "Base";
  return `Chain ${chainId}`;
}
