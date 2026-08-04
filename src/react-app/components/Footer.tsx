import type { ArchiveMeta } from "../types";
import { Link } from "../router";

export function Footer({
  meta,
  mode = "combined",
}: {
  meta: ArchiveMeta | null;
  mode?: "combined" | "live-only";
}) {
  if (mode === "live-only") {
    return (
      <footer className="footer">
        <div className="shell footer__inner">
          <div className="footer__brand">
            <img src="/brand/logo_poap.svg" alt="" width="34" height="44" />
            <div>
              <strong>兆量富足教育協會數位紀念章</strong>
              <span>保存參與，也讓收藏由自己掌握。</span>
            </div>
          </div>
          <div className="footer__links">
            <Link href="/email/collection">Email 收藏</Link>
            <Link href="/help">領取支援與隱私</Link>
          </div>
          <p className="footer__legal">鏈上所有權以 Base 網路紀錄為準。</p>
        </div>
      </footer>
    );
  }
  return (
    <footer className="footer">
      <div className="shell footer__inner">
        <div className="footer__brand">
          <img src="/brand/logo_poap.svg" alt="" width="34" height="44" />
          <div>
            <strong>POAPin Archive</strong>
            <span>Built to keep public memories portable.</span>
          </div>
        </div>
        <div className="footer__links">
          <Link href="/drops">Browse Drops</Link>
          <Link href="/collections">Collections hub</Link>
          <Link href="/moments">Browse Moments</Link>
          <Link href="/about-data">About the data</Link>
          <Link href="/help">領取支援與隱私</Link>
          <a
            href="https://github.com/glorylab/poapin-archive"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open source on GitHub
          </a>
        </div>
        <p className="footer__legal">
          Code is open source. Archived data and issuer artwork retain their respective rights.
          {meta ? ` Snapshot ${meta.snapshotAt.slice(0, 10)}.` : ""}
        </p>
      </div>
    </footer>
  );
}
