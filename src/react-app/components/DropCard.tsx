import { useState } from "react";
import { CalendarIcon, LocationIcon } from "../icons";
import { Link } from "../router";
import type { Drop } from "../types";
import { safeHttpUrl } from "../utils";

interface DropCardProps {
  drop: Drop;
  priority?: boolean;
  tokenLabel?: string;
}

export function DropCard({ drop, priority = false, tokenLabel }: DropCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const location = [clean(drop.city), clean(drop.country)].filter(Boolean).join(", ");
  const date = formatDate(drop.startDate);
  const artworkUrl = safeHttpUrl(drop.imageUrl);
  const title = clean(drop.title) || `POAP drop #${drop.dropId}`;
  const canShowArtwork = drop.hasArtwork !== false && artworkUrl !== null && !imageFailed;
  const badge = drop.isPrivate ? "Private Drop" : drop.isVirtual ? "Virtual" : null;
  const content = (
    <>
      <div className="drop-card__artwork">
        <div className="drop-card__fallback" aria-hidden="true">
          <img src="/brand/logo_poap.svg" alt="" />
        </div>
        {canShowArtwork ? (
          <img
            className="drop-card__image"
            src={artworkUrl ?? undefined}
            alt=""
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : null}
        {badge ? <span className="drop-card__type">{badge}</span> : null}
      </div>

      <div className="drop-card__body">
        <h3 title={title}>{title}</h3>
        <div className="drop-card__meta">
          <span>
            <CalendarIcon />
            {date || (drop.year > 0 ? drop.year : "Date unavailable")}
          </span>
          {location ? (
            <span>
              <LocationIcon />
              {location}
            </span>
          ) : null}
        </div>
        {tokenLabel ? <span className="drop-card__token">{tokenLabel}</span> : null}
        {!tokenLabel && typeof drop.tokenCount === "number" ? (
          <span className="drop-card__token">{formatNumber(drop.tokenCount)} collected</span>
        ) : null}
      </div>
    </>
  );

  return (
    <article className="drop-card">
      <Link
        className="drop-card__link"
        href={`/drop/${drop.dropId}`}
        aria-label={drop.isPrivate ? `View private Drop ${title}` : `View ${title}`}
      >
        {content}
      </Link>
    </article>
  );
}

function clean(value?: string | null) {
  return value?.trim() || "";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en").format(value);
}
