import { useEffect, useMemo, useRef, useState } from "react";
import { getDrop } from "../api";
import { DropCollectors } from "../components/DropCollectors";
import { ErrorState } from "../components/States";
import { CalendarIcon, ExternalIcon, LocationIcon } from "../icons";
import { Link } from "../router";
import type { Drop } from "../types";
import { isAbortError, safeHttpUrl } from "../utils";

export function DropPage({ dropId }: { dropId: number }) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [retry, setRetry] = useState(0);
  const copyResetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDrop(null);
    setImageFailed(false);
    setCopyStatus("idle");
    getDrop(dropId, controller.signal)
      .then((value) => {
        setDrop(value);
        const title = value.title.trim() || `POAP drop #${value.dropId}`;
        document.title = `${title.slice(0, 100)} · POAP Archive`;
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : "Unknown archive error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dropId, retry]);

  useEffect(() => {
    if (!drop?.isPrivate) return;
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement("meta");
    const previousContent = existing?.content;
    if (!existing) {
      robots.name = "robots";
      document.head.appendChild(robots);
    }
    robots.content = "noindex,nofollow";
    return () => {
      if (existing) robots.content = previousContent ?? "";
      else robots.remove();
    };
  }, [drop?.isPrivate]);

  const eventUrl = useMemo(() => safeExternalUrl(drop?.eventUrl), [drop?.eventUrl]);
  const artworkUrl = useMemo(() => safeHttpUrl(drop?.imageUrl), [drop?.imageUrl]);

  if (loading) {
    return (
      <main className="detail-page shell" id="main-content" tabIndex={-1}>
        <div className="detail-skeleton glass-panel" role="status" aria-label="Loading POAP drop">
          <span className="skeleton skeleton--hero" />
          <span className="skeleton skeleton--heading" />
          <span className="skeleton skeleton--paragraph" />
        </div>
      </main>
    );
  }

  if (error || !drop) {
    return (
      <main className="detail-page shell" id="main-content" tabIndex={-1}>
        <ErrorState
          message={error || "Drop not found"}
          onRetry={() => setRetry((value) => value + 1)}
        />
      </main>
    );
  }

  const location = [drop.city?.trim(), drop.country?.trim()].filter(Boolean).join(", ");
  const title = drop.title.trim() || `POAP drop #${drop.dropId}`;
  const canShowArtwork = drop.hasArtwork !== false && artworkUrl !== null && !imageFailed;
  const eventFormat =
    drop.isVirtual === true
      ? "Virtual event"
      : drop.isVirtual === false
        ? "In-person event"
        : "Format unspecified";

  const copyDropId = async () => {
    try {
      await copyText(String(drop.dropId));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1_800);
  };

  return (
    <main className="detail-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/drops">
        ← Back to Drops
      </Link>
      <article className="drop-detail">
        <div className="drop-detail__visual">
          {canShowArtwork ? (
            <img
              className="drop-detail__glow"
              src={artworkUrl ?? undefined}
              alt=""
              aria-hidden="true"
            />
          ) : null}
          <div className="drop-detail__image-wrap">
            {canShowArtwork ? (
              <img
                src={artworkUrl ?? undefined}
                alt={`Artwork for ${title}`}
                decoding="async"
                fetchPriority="high"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <div className="detail-fallback">
                <img src="/brand/logo_poap.svg" alt="Artwork unavailable" />
              </div>
            )}
          </div>
        </div>

        <div className="drop-detail__content glass-panel">
          <div className="detail-kicker">
            <span>{drop.isPrivate ? "Private POAP Drop" : "POAP Drop"}</span>
            <button type="button" onClick={copyDropId} aria-live="polite">
              #{drop.dropId} ·{" "}
              {copyStatus === "copied"
                ? "Copied"
                : copyStatus === "error"
                  ? "Copy failed"
                  : "Copy ID"}
            </button>
          </div>
          <h1>{title}</h1>

          <div className="detail-facts">
            <span>
              <CalendarIcon />
              {formatDateRange(drop.startDate, drop.endDate)}
            </span>
            {location ? (
              <span>
                <LocationIcon />
                {location}
              </span>
            ) : null}
            <span className="detail-facts__tag">{eventFormat}</span>
          </div>

          {drop.description ? (
            <p className="drop-description">{drop.description}</p>
          ) : (
            <p className="drop-description is-muted">
              No description was included in this archive snapshot.
            </p>
          )}

          <dl className="metadata-grid">
            <MetaItem label="Year" value={String(drop.year)} />
            <MetaItem label="Collected" value={formatCount(drop.tokenCount)} />
            {drop.fancyId?.trim() ? (
              <MetaItem label="Fancy ID" value={drop.fancyId.trim()} />
            ) : null}
            <MetaItem
              label="Platform"
              value={drop.platform?.trim() || drop.channel?.trim() || "—"}
            />
            {drop.platform?.trim() && drop.channel?.trim() ? (
              <MetaItem label="Channel" value={drop.channel.trim()} />
            ) : null}
            <MetaItem label="Timezone" value={drop.timezone?.trim() || "—"} />
            {drop.integratorId?.trim() ? (
              <MetaItem label="Integrator" value={drop.integratorId.trim()} />
            ) : null}
            {typeof drop.dropTransferCount === "number" ? (
              <MetaItem label="Drop transfers" value={formatCount(drop.dropTransferCount)} />
            ) : null}
            {typeof drop.reservationsTotal === "number" ? (
              <MetaItem label="Reservations" value={formatCount(drop.reservationsTotal)} />
            ) : null}
            {typeof drop.momentsUploaded === "number" ? (
              <MetaItem label="Moments uploaded" value={formatCount(drop.momentsUploaded)} />
            ) : null}
            {formatMetadataDate(drop.createdAt) ? (
              <MetaItem label="Created" value={formatMetadataDate(drop.createdAt) ?? "—"} />
            ) : null}
            {formatMetadataDate(drop.expiryDate) ? (
              <MetaItem label="Claim expiry" value={formatMetadataDate(drop.expiryDate) ?? "—"} />
            ) : null}
            {formatMetadataDate(drop.featuredOn) ? (
              <MetaItem label="Featured" value={formatMetadataDate(drop.featuredOn) ?? "—"} />
            ) : null}
            <MetaItem label="Snapshot status" value="Preserved" />
          </dl>

          <div className="detail-actions">
            {eventUrl ? (
              <a
                className="button button--gold"
                href={eventUrl}
                target="_blank"
                rel="nofollow noopener noreferrer"
              >
                Visit event page <ExternalIcon />
              </a>
            ) : null}
            {drop.hasArtwork !== false && artworkUrl ? (
              <a
                className="button button--outline"
                href={artworkUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original artwork
              </a>
            ) : null}
            <Link className="button button--outline" href={`/moments?drop=${drop.dropId}`}>
              Explore Moments
            </Link>
          </div>
          <p className="snapshot-note">
            {drop.isPrivate
              ? "This private record is available by exact Drop ID and remains excluded from archive browsing."
              : "This record reflects a preserved snapshot and may not match current ownership or event metadata."}
          </p>
        </div>
      </article>

      <DropCollectors dropId={drop.dropId} tokenCount={drop.tokenCount} />
    </main>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function safeExternalUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatDateRange(startValue: string, endValue?: string | null) {
  const start = new Date(startValue);
  const end = endValue ? new Date(endValue) : null;
  if (Number.isNaN(start.getTime())) return "Date unavailable";
  const format = new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (!end || Number.isNaN(end.getTime()) || utcDateKey(start) === utcDateKey(end))
    return format.format(start);
  return `${format.format(start)} – ${format.format(end)}`;
}

function formatCount(value?: number) {
  return typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—";
}

function formatMetadataDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function utcDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.className = "copy-helper";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy command was rejected");
  } finally {
    textarea.remove();
  }
}
