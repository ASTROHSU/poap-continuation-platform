import { useEffect, useMemo, useState } from "react";
import {
  getArchiveCollectors,
  getArchiveDrop,
  getArchiveHoldings,
  getAppConfig,
  getLegacyPoapHoldings,
  getLiveCollectors,
  getLiveHoldings,
  readableError,
  verifyMagicSession,
  type ArchiveCollector,
  type ArchiveDropDetail,
  type ArchiveHolding,
  type LegacyPoapHolding,
  type LiveCollector,
  type LiveHolding,
} from "../lib/live-api";
import { resumeMagicEmailSession, revealMagicEvmPrivateKey } from "../lib/magic-wallet";
import { looksLikeEnsName } from "../lib/recipient-input";

interface MagicCollectionOwner {
  email: string;
  address: `0x${string}`;
  publishableKey: string;
}

export default function WalletCollectionDemo({
  address,
  displayName = "",
}: {
  address: string;
  displayName?: string;
}) {
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
  const [magicOwner, setMagicOwner] = useState<MagicCollectionOwner | null>(null);
  const [showKeyExport, setShowKeyExport] = useState(false);
  const [exportingKey, setExportingKey] = useState(false);
  const [keyExportError, setKeyExportError] = useState("");

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
    let active = true;
    setMagicOwner(null);
    setShowKeyExport(false);
    setKeyExportError("");

    const restoreOwner = async () => {
      try {
        const config = await getAppConfig();
        const publishableKey = config.embeddedWallet.publishableKey;
        if (!config.embeddedWallet.enabled || !publishableKey) return;

        const session = await resumeMagicEmailSession(publishableKey);
        if (!session) return;
        const verified = await verifyMagicSession(session.didToken, session.email);
        const targetAddress = address.trim().toLowerCase();
        if (verified.address.toLowerCase() !== targetAddress) return;

        if (active) {
          setMagicOwner({
            email: session.email,
            address: verified.address,
            publishableKey,
          });
        }
      } catch {
        // Collection pages remain public. Account controls simply stay hidden
        // when an authenticated Magic session cannot be verified.
      }
    };

    void restoreOwner();
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
    if (!showKeyExport) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exportingKey) setShowKeyExport(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showKeyExport, exportingKey]);

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
  const collectionName = looksLikeEnsName(displayName) ? displayName.trim() : "";
  const identityName = magicOwner?.email || collectionName;
  const identityTitleSize = magicOwner?.email
    ? identityName.length > 28
      ? "text-[1.45rem]"
      : identityName.length > 20
        ? "text-[1.75rem]"
        : "text-[2.2rem]"
    : "text-5xl";
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

  const exportPrivateKey = async () => {
    if (!magicOwner || exportingKey) return;
    setExportingKey(true);
    setKeyExportError("");
    try {
      await revealMagicEvmPrivateKey(magicOwner.publishableKey);
      setShowKeyExport(false);
    } catch (problem) {
      const message = problem instanceof Error ? problem.message.toLowerCase() : "";
      if (
        message.includes("not approved") ||
        message.includes("not enabled") ||
        message.includes("unauthorized") ||
        message.includes("access")
      ) {
        setKeyExportError("Magic 尚未替這個應用程式開啟私鑰匯出功能。");
      } else {
        setKeyExportError("目前無法開啟私鑰匯出，請確認仍以這個 Email 登入後再試一次。");
      }
    } finally {
      setExportingKey(false);
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-5 border-b border-ink/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="eyebrow">COLLECTORS</span>
          <h1
            className={`display-title mt-5 max-w-full [overflow-wrap:anywhere] [text-wrap:balance] leading-[1.05] ${identityTitleSize} sm:text-6xl`}
          >
            {identityName || "POAP 收藏"}
          </h1>
          <div className="mt-4 flex max-w-xl items-start gap-2">
            <p className="min-w-0 break-all font-mono text-xs leading-8 text-ink/42">
              {resolvedAddress}
            </p>
            {magicOwner ? (
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-[#7669d8]/65 bg-white/80 text-[#514777] shadow-[2px_3px_0_#ddd9ff] transition duration-200 hover:-translate-y-0.5 hover:border-[#7669d8] hover:bg-white hover:shadow-[2px_4px_0_#c9c2ff] focus-visible:outline-4 focus-visible:outline-offset-3 focus-visible:outline-[#a89cff]"
                type="button"
                aria-label="匯出私鑰"
                title="匯出私鑰"
                onClick={() => {
                  setKeyExportError("");
                  setShowKeyExport(true);
                }}
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="15" r="3" />
                  <path d="m10.2 12.8 7.3-7.3 2 2-1.6 1.6 1.2 1.2-2.1 2.1-1.2-1.2-3.4 3.4" />
                </svg>
              </button>
            ) : null}
          </div>
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
      {showKeyExport && magicOwner ? (
        <div
          className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-[#2d2847]/55 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="key-export-title"
        >
          <div className="w-full max-w-lg rounded-[2rem] border-2 border-[#514777] bg-white p-6 shadow-[10px_12px_0_#bdb6ff] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow">WALLET CONTROL</span>
                <h2 id="key-export-title" className="mt-4 font-display text-3xl font-bold">
                  匯出錢包私鑰
                </h2>
              </div>
              <button
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-[#7669d8] bg-white text-xl font-bold text-[#4f457c]"
                type="button"
                aria-label="關閉"
                disabled={exportingKey}
                onClick={() => setShowKeyExport(false)}
              >
                ×
              </button>
            </div>
            <p className="mt-6 text-base leading-7 text-ink/65">
              私鑰代表這個錢包的完整控制權。任何取得私鑰的人都能操作其中資產，請勿截圖、傳送或貼給任何人。
            </p>
            <div className="mt-5 rounded-2xl bg-[#efedff] p-4 text-sm leading-6 text-[#514777]">
              Magic 會在安全視窗中直接向你顯示私鑰；本站不會讀取、收到或保存私鑰。
            </div>
            {keyExportError ? (
              <p className="mt-4 text-sm font-medium text-[#ab5e74]" role="alert">
                {keyExportError}
              </p>
            ) : null}
            <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                className="btn-secondary"
                type="button"
                disabled={exportingKey}
                onClick={() => setShowKeyExport(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                type="button"
                disabled={exportingKey}
                onClick={exportPrivateKey}
              >
                {exportingKey ? "正在開啟…" : "我了解，繼續匯出"}
              </button>
            </div>
          </div>
        </div>
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
  eventSlug: string | null;
  tokenLabel: string;
  ownerAddress: string;
  network: string;
  mintedDate: string;
  collectorCount: number;
  location: string;
  description: string | null;
  eventUrl: string | null;
  technicalUrl: string | null;
  ownerExplorerUrl: string;
}

interface CollectorListItem {
  ownerAddress: string;
  explorerUrl: string;
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
            eventSlug: null,
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
            ownerExplorerUrl: addressExplorerUrl(item.chainId, ownerAddress),
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
            eventSlug: null,
            tokenLabel: `Token #${item.poapId}`,
            ownerAddress: item.ownerAddress,
            network: archiveNetworkName(item.network),
            mintedDate: item.mintedOn ? formatTimestamp(item.mintedOn * 1000) : "未保存",
            collectorCount: item.tokenCount,
            location: [item.city, item.country].filter(Boolean).join(" · ") || "未提供",
            description: null,
            eventUrl: null,
            technicalUrl: null,
            ownerExplorerUrl: addressExplorerUrl(item.network, item.ownerAddress),
          },
        ),
      );
  const galleryItems: GalleryItem[] = [
    ...liveItems.map((item) =>
      toGalleryItem(`live-${item.eventId}-${item.tokenId}`, item, {
        source: "live",
        dropId: null,
        eventSlug: item.slug,
        tokenLabel: item.tokenId ? `Token #${item.tokenId}` : "數位紀念",
        ownerAddress,
        network: chainName(item.chainId),
        mintedDate: formatTimestamp(item.mintedAt ?? item.claimedAt),
        collectorCount: item.mintedCount,
        location: "線上活動",
        description: item.description,
        eventUrl: item.eventUrl,
        technicalUrl: item.mintedTxHash
          ? transactionExplorerUrl(item.chainId, item.mintedTxHash)
          : null,
        ownerExplorerUrl: addressExplorerUrl(item.chainId, ownerAddress),
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
  const [showCollectors, setShowCollectors] = useState(false);
  const [collectors, setCollectors] = useState<CollectorListItem[]>([]);
  const [collectorsCursor, setCollectorsCursor] = useState<string | null>(null);
  const [collectorsLoading, setCollectorsLoading] = useState(false);
  const [collectorsError, setCollectorsError] = useState("");
  const description = archiveDetail?.description ?? item.description;
  const eventUrl = archiveDetail?.eventUrl ?? item.eventUrl;
  const location =
    [archiveDetail?.city, archiveDetail?.country].filter(Boolean).join(" · ") || item.location;
  const dropLabel = item.dropId ? `Drop #${item.dropId}` : "新發行";

  useEffect(() => {
    setShowCollectors(false);
    setCollectors([]);
    setCollectorsCursor(null);
    setCollectorsError("");
  }, [item.key]);

  const loadCollectors = async (cursor: string | null = null) => {
    if (collectorsLoading) return;
    setCollectorsLoading(true);
    setCollectorsError("");
    try {
      if (item.source === "live" && item.eventSlug) {
        const result = await getLiveCollectors(item.eventSlug);
        setCollectors(
          result.items.map((collector: LiveCollector) => ({
            ownerAddress: collector.ownerAddress,
            explorerUrl: addressExplorerUrl(result.chainId, collector.ownerAddress),
          })),
        );
        setCollectorsCursor(null);
      } else if (item.dropId) {
        const result = await getArchiveCollectors(item.dropId, cursor);
        const nextItems = result.items.map((collector: ArchiveCollector) => ({
          ownerAddress: collector.ownerAddress,
          explorerUrl: addressExplorerUrl(collector.network, collector.ownerAddress),
        }));
        setCollectors((current) =>
          mergeCollectors(cursor ? [...current, ...nextItems] : nextItems),
        );
        setCollectorsCursor(result.nextCursor);
      }
    } catch (collectorError) {
      setCollectorsError(readableError(collectorError));
    } finally {
      setCollectorsLoading(false);
    }
  };

  const toggleCollectors = () => {
    const next = !showCollectors;
    setShowCollectors(next);
    if (next && collectors.length === 0 && !collectorsLoading) void loadCollectors();
  };
  const visibleCollectors = collectors.filter(
    (collector) => collector.ownerAddress.toLowerCase() !== item.ownerAddress.toLowerCase(),
  );

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
                <button
                  className="rounded-full bg-[#efedff] px-3 py-1.5 transition hover:bg-[#dedaff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#665b9a]"
                  type="button"
                  aria-expanded={showCollectors}
                  onClick={toggleCollectors}
                >
                  {item.collectorCount.toLocaleString("zh-TW")} 人收藏
                  <span className="ml-1" aria-hidden="true">
                    {showCollectors ? "↑" : "↓"}
                  </span>
                </button>
              ) : null}
            </div>

            <h1 className="mt-5 font-display text-3xl font-bold leading-tight tracking-[-0.035em] sm:text-5xl">
              {item.title}
            </h1>

            <dl className="mt-7 grid gap-4 rounded-[2rem] border-2 border-[#dedaff] bg-white p-5 shadow-[6px_7px_0_#efedff] sm:grid-cols-2 sm:p-7">
              <Metadata
                label="收藏地址"
                value={item.ownerAddress}
                href={item.ownerExplorerUrl}
                mono
              />
              <Metadata label="鑄造時間" value={item.mintedDate} />
              <Metadata label="活動日期" value={item.fullDate} />
              <Metadata label="網路" value={item.network} />
              <Metadata label="地點" value={location} />
              <Metadata label="紀念編號" value={`${dropLabel} · ${item.tokenLabel}`} />
            </dl>

            {showCollectors ? (
              <section className="mt-7 rounded-[2rem] border-2 border-[#dedaff] bg-white p-5 shadow-[6px_7px_0_#efedff] sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-display text-xl font-bold">收藏者</h2>
                    <p className="mt-1 text-sm leading-6 text-ink/50">
                      僅顯示公開錢包地址，不顯示 Email。
                    </p>
                  </div>
                  <button
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#efedff] font-bold text-[#665b9a]"
                    type="button"
                    onClick={() => setShowCollectors(false)}
                    aria-label="收起收藏者清單"
                  >
                    ×
                  </button>
                </div>

                {visibleCollectors.length > 0 ? (
                  <ol className="mt-5 divide-y divide-ink/10">
                    {visibleCollectors.map((collector, index) => (
                      <li key={collector.ownerAddress}>
                        <a
                          className="flex items-center gap-3 py-3.5 text-[#4f457c] transition hover:text-[#7669d8]"
                          href={collector.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#efedff] text-xs font-extrabold">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 break-all font-mono text-xs font-bold leading-5 sm:text-sm">
                            {collector.ownerAddress}
                          </span>
                          <span className="shrink-0 text-sm font-bold" aria-hidden="true">
                            ↗
                          </span>
                        </a>
                      </li>
                    ))}
                  </ol>
                ) : null}

                {collectorsLoading ? (
                  <p className="mt-5 text-sm font-bold text-[#665b9a]">正在載入收藏者…</p>
                ) : null}
                {collectorsError ? (
                  <p className="mt-5 text-sm font-bold text-[#b35b72]">
                    收藏者清單暫時無法載入，請稍後再試。
                  </p>
                ) : null}
                {!collectorsLoading && !collectorsError && visibleCollectors.length === 0 ? (
                  <p className="mt-5 text-sm text-ink/50">目前沒有其他可顯示的收藏者。</p>
                ) : null}
                {collectorsCursor && !collectorsLoading ? (
                  <button
                    className="mt-5 w-full rounded-full border-2 border-[#7669d8] bg-white px-5 py-3 text-sm font-extrabold text-[#5d52aa]"
                    type="button"
                    onClick={() => void loadCollectors(collectorsCursor)}
                  >
                    顯示更多收藏者
                  </button>
                ) : null}
              </section>
            ) : null}

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
  href,
  mono = false,
}: {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold tracking-wider text-ink/38">{label}</dt>
      <dd className={`mt-1.5 break-words font-bold text-ink/78 ${mono ? "font-mono text-xs" : ""}`}>
        {href ? (
          <a
            className="inline-flex max-w-full items-start gap-1 text-[#5d52aa] underline decoration-[#c8c1ff] underline-offset-4 hover:text-[#7669d8]"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            <span className="break-all">{value || "未提供"}</span>
            <span className="shrink-0 font-sans" aria-hidden="true">
              ↗
            </span>
          </a>
        ) : (
          value || "未提供"
        )}
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

function addressExplorerUrl(network: string | number, address: string) {
  const normalized = String(network).toLowerCase();
  if (normalized === "84532" || normalized.includes("sepolia")) {
    return `https://sepolia.basescan.org/address/${address}`;
  }
  if (normalized === "8453" || normalized === "base") {
    return `https://basescan.org/address/${address}`;
  }
  if (normalized === "42161" || normalized.includes("arbitrum")) {
    return `https://arbiscan.io/address/${address}`;
  }
  if (normalized === "100" || normalized === "xdai" || normalized === "gnosis") {
    return `https://gnosisscan.io/address/${address}`;
  }
  return `https://etherscan.io/address/${address}`;
}

function transactionExplorerUrl(chainId: number, transactionHash: string) {
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${transactionHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${transactionHash}`;
  if (chainId === 42161) return `https://arbiscan.io/tx/${transactionHash}`;
  if (chainId === 100) return `https://gnosisscan.io/tx/${transactionHash}`;
  return `https://etherscan.io/tx/${transactionHash}`;
}

function mergeCollectors(items: CollectorListItem[]) {
  const unique = new Map<string, CollectorListItem>();
  for (const item of items) unique.set(item.ownerAddress.toLowerCase(), item);
  return [...unique.values()];
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
