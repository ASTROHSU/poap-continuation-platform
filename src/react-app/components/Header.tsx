import type { ArchiveMeta } from "../types";
import { Link, useLocation } from "../router";

interface HeaderProps {
  meta: ArchiveMeta | null;
  mode?: "combined" | "live-only";
}

export function Header({ meta, mode = "combined" }: HeaderProps) {
  const { pathname } = useLocation();
  if (mode === "live-only") {
    return (
      <header className="site-header">
        <div className="site-header__inner shell">
          <Link className="brand" href="/" aria-label="兆量富足教育協會數位紀念章首頁">
            <img src="/brand/logo_poap.svg" alt="" width="34" height="44" />
            <span className="brand__archive">數位紀念章</span>
          </Link>
          <nav className="nav" aria-label="主要導覽">
            <Link className={pathname === "/" ? "nav__link is-active" : "nav__link"} href="/">
              首頁
            </Link>
            <Link
              className={pathname.startsWith("/email/") ? "nav__link is-active" : "nav__link"}
              href="/email/collection"
            >
              Email 收藏
            </Link>
            <Link
              className={pathname === "/help" ? "nav__link is-active" : "nav__link"}
              href="/help"
            >
              支援
            </Link>
          </nav>
          <div className="snapshot-pill" title="Base 鏈上數位紀念章">
            <span className="snapshot-pill__dot" aria-hidden="true" />
            <span>Base</span>
          </div>
        </div>
      </header>
    );
  }
  const onMomentsRoute =
    pathname.startsWith("/moments") || /^\/owners\/[^/]+\/moments\/?$/.test(pathname);
  const active = onMomentsRoute
    ? "moments"
    : pathname.startsWith("/collections")
      ? "collections"
      : pathname === "/about-data"
        ? "about"
        : pathname === "/drops" || pathname === "/drops/" || pathname.startsWith("/drop/")
          ? "drops"
          : pathname === "/"
            ? "home"
            : "";

  return (
    <header className="site-header">
      <div className="site-header__inner shell">
        <Link className="brand" href="/" aria-label="POAPin Archive home">
          <img src="/brand/title_poapin_s.png" alt="POAPin" width="132" height="32" />
          <span className="brand__archive">Archive</span>
        </Link>

        <nav className="nav" aria-label="Primary navigation">
          <Link
            className={active === "home" ? "nav__link is-active" : "nav__link"}
            href="/"
            aria-current={active === "home" ? "page" : undefined}
            data-nav-optional="home"
          >
            Home
          </Link>
          <Link
            className={active === "drops" ? "nav__link is-active" : "nav__link"}
            href="/drops"
            aria-current={active === "drops" ? "page" : undefined}
          >
            Drops
          </Link>
          <Link
            className={active === "collections" ? "nav__link is-active" : "nav__link"}
            href="/collections"
            aria-current={active === "collections" ? "page" : undefined}
          >
            Collections
          </Link>
          <Link
            className={active === "moments" ? "nav__link is-active" : "nav__link"}
            href="/moments"
            aria-current={active === "moments" ? "page" : undefined}
          >
            Moments
          </Link>
          <Link
            className={active === "about" ? "nav__link is-active" : "nav__link"}
            href="/about-data"
            aria-current={active === "about" ? "page" : undefined}
            data-nav-optional="about"
          >
            About
          </Link>
        </nav>

        <div
          className="snapshot-pill"
          title={meta?.snapshotAt ?? "Loading snapshot metadata"}
          aria-live="polite"
        >
          <span className="snapshot-pill__dot" aria-hidden="true" />
          <span>{meta ? `Snapshot ${formatSnapshot(meta.snapshotAt)}` : "Snapshot"}</span>
        </div>
      </div>
    </header>
  );
}

function formatSnapshot(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
