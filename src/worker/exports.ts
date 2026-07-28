import { artworkUrl } from "./media";
import { fetchHeldDropDetails } from "./holding-drops";
import { fetchPrivateHeldDropDetails } from "./private-held-drops";
import {
  EXPORT_BATCH_SIZE,
  fetchExportCatalog,
  fetchExportHoldingBatch,
  safeExternalUrl,
} from "./repository";
import type { D1ReadClient, DropDetail, ExportCatalogRow, ExportRecord, HoldingRow } from "./types";

export const MAX_SYNC_EXPORT_RECORDS = 5_000;

type ExportFormat = "csv" | "json";

interface ExportOptions {
  format: ExportFormat;
  address: string;
  total: number;
  snapshotId: string;
  catalogSnapshotId: string;
  snapshotAt: string;
  holdingsDb: D1ReadClient;
  catalogDb: D1ReadClient;
  collectionsDb: D1ReadClient;
  collectionsSnapshotId: string;
  mediaBaseUrl: string;
}

const CSV_HEADER = [
  "snapshot_id",
  "snapshot_at",
  "queried_address",
  "source_uid",
  "poap_id",
  "drop_id",
  "title",
  "start_date",
  "end_date",
  "city",
  "country",
  "event_url",
  "network",
  "minted_on",
  "transfer_count",
  "artwork_url",
  "is_private",
  "is_hidden",
].join(",");

export function createExportResponse(options: ExportOptions): Response {
  const stream = createExportStream(options);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(options.snapshotAt)?.[0] ?? "snapshot";
  const contentType =
    options.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="poapin-${options.address}-${date}.${options.format}"`,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function createExportStream(options: ExportOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  let emitted = 0;
  let cursor: { poapId: number; sourceUid: string } | null = null;
  const catalogCache = new Map<number, ExportCatalogRow>();
  const privateDropCache = new Map<number, DropDetail>();
  const holdingDropCache = new Map<number, DropDetail>();
  const resolvedDropIds = new Set<number>();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        if (options.format === "csv") {
          controller.enqueue(encoder.encode(`\uFEFF${CSV_HEADER}\r\n`));
        } else {
          const envelope = JSON.stringify({
            schema_version: "poapin-address-export-v3",
            snapshot_id: options.snapshotId,
            catalog_snapshot_id: options.catalogSnapshotId,
            snapshot_at: options.snapshotAt,
            generated_at: new Date().toISOString(),
            queried_address: options.address,
            count: options.total,
            notice:
              "Onchain holdings and address-bound preserved Drop metadata recorded at fixed archive snapshots; this is not live wallet data.",
          });
          controller.enqueue(encoder.encode(`${envelope.slice(0, -1)},"tokens":[`));
        }
        if (options.total === 0) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
        }
        return;
      }

      try {
        const holdings = await fetchExportHoldingBatch(options.holdingsDb, options.address, cursor);
        if (holdings.length === 0) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
          return;
        }

        const missingDropIds = holdings
          .map((holding) => holding.drop_id)
          .filter((dropId) => !resolvedDropIds.has(dropId));
        const fetchedCatalog = await fetchExportCatalog(options.catalogDb, missingDropIds);
        for (const [dropId, drop] of fetchedCatalog) catalogCache.set(dropId, drop);
        const privateDropIds = missingDropIds.filter((dropId) => !fetchedCatalog.has(dropId));
        const fetchedPrivateDrops =
          privateDropIds.length > 0
            ? await fetchPrivateHeldDropDetails(
                options.collectionsDb,
                privateDropIds,
                options.mediaBaseUrl,
                options.catalogSnapshotId,
                options.collectionsSnapshotId,
              )
            : new Map<number, DropDetail>();
        for (const [dropId, drop] of fetchedPrivateDrops) privateDropCache.set(dropId, drop);
        const holdingDropIds = privateDropIds.filter((dropId) => !fetchedPrivateDrops.has(dropId));
        const fetchedHoldingDrops =
          holdingDropIds.length > 0
            ? await fetchHeldDropDetails(options.holdingsDb, holdingDropIds, options.snapshotId)
            : new Map<number, DropDetail>();
        for (const [dropId, drop] of fetchedHoldingDrops) holdingDropCache.set(dropId, drop);
        for (const dropId of missingDropIds) resolvedDropIds.add(dropId);
        const records = holdings.map((holding) =>
          toExportRecord(
            options,
            holding,
            catalogCache.get(holding.drop_id),
            privateDropCache.get(holding.drop_id) ?? holdingDropCache.get(holding.drop_id),
          ),
        );
        const payload =
          options.format === "csv"
            ? records.map(toCsvRow).join("")
            : records
                .map(
                  (record, index) =>
                    `${emitted > 0 || index > 0 ? "," : ""}${JSON.stringify(record)}`,
                )
                .join("");
        controller.enqueue(encoder.encode(payload));
        emitted += holdings.length;

        const last = holdings.at(-1)!;
        cursor = { poapId: last.poap_id, sourceUid: last.source_uid };
        if (holdings.length < EXPORT_BATCH_SIZE || emitted >= options.total) {
          if (options.format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function toExportRecord(
  options: ExportOptions,
  holding: HoldingRow,
  drop: ExportCatalogRow | undefined,
  privateDrop: DropDetail | undefined,
): ExportRecord {
  return {
    snapshot_id: options.snapshotId,
    snapshot_at: options.snapshotAt,
    queried_address: options.address,
    source_uid: holding.source_uid,
    poap_id: holding.poap_id,
    drop_id: holding.drop_id,
    title: drop?.title ?? privateDrop?.title ?? `Archived POAP #${holding.poap_id}`,
    start_date: drop?.start_date ?? privateDrop?.startDate ?? "",
    end_date: drop?.end_date ?? privateDrop?.endDate ?? "",
    city: drop?.city ?? privateDrop?.city ?? null,
    country: drop?.country ?? privateDrop?.country ?? null,
    event_url: safeExternalUrl(drop?.event_url ?? privateDrop?.eventUrl ?? null),
    network: holding.network,
    minted_on: holding.minted_on,
    transfer_count: holding.transfer_count,
    artwork_url:
      privateDrop?.imageUrl ||
      (numericArtworkAvailable(drop)
        ? artworkUrl(options.mediaBaseUrl, options.catalogSnapshotId, holding.drop_id)
        : null),
    is_private: privateDrop?.isPrivate === true,
    is_hidden: privateDrop?.isHidden === true,
  };
}

function toCsvRow(record: ExportRecord): string {
  return (
    [
      record.snapshot_id,
      record.snapshot_at,
      record.queried_address,
      record.source_uid,
      record.poap_id,
      record.drop_id,
      record.title,
      record.start_date,
      record.end_date,
      record.city,
      record.country,
      record.event_url,
      record.network,
      record.minted_on,
      record.transfer_count,
      record.artwork_url,
      record.is_private,
      record.is_hidden,
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

function numericArtworkAvailable(drop: ExportCatalogRow | undefined): boolean {
  return drop !== undefined && Number(drop.has_artwork) === 1;
}

/** RFC 4180 quoting plus spreadsheet formula neutralization. */
export function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
