import type { ArchiveMeta } from "../types";

export function AboutPage({ meta }: { meta: ArchiveMeta | null }) {
  return (
    <main className="about-page shell" id="main-content" tabIndex={-1}>
      <section className="about-hero">
        <span className="eyebrow">About this archive</span>
        <h1>A snapshot, not a live index.</h1>
        <p>
          POAPin Archive preserves a public POAP dataset so drops and address collections remain
          browsable and exportable after the original download service closes.
        </p>
      </section>

      <section className="about-grid">
        <article className="about-card glass-panel">
          <span className="about-card__number">01</span>
          <h2>What is preserved</h2>
          <p>
            Drop metadata, public ownership at the snapshot, reservation aggregates and the original
            WebP artwork supplied in the archive. During progressive publication, unavailable
            artwork uses a fallback until its immutable object arrives.
          </p>
        </article>
        <article className="about-card glass-panel">
          <span className="about-card__number">02</span>
          <h2>What is not preserved</h2>
          <p>
            This is not transfer history, a minting service, a wallet tracker or a promise that
            ownership still matches the current chain state.
          </p>
        </article>
        <article className="about-card glass-panel">
          <span className="about-card__number">03</span>
          <h2>Privacy boundary</h2>
          <p>
            Exact public addresses can be queried. We intentionally do not offer address discovery,
            partial matching, holder directories or reverse owner lists.
          </p>
        </article>
      </section>

      <section className="data-sheet">
        <div>
          <span className="eyebrow">Snapshot facts</span>
          <h2>The archive at a glance</h2>
        </div>
        <dl>
          <Fact label="Captured" value={meta ? formatDate(meta.snapshotAt) : "July 2026"} />
          <Fact label="Drops" value={formatNumber(meta?.counts.drops)} />
          <Fact label="Ownership records" value={formatNumber(meta?.counts.tokens)} />
          <Fact label="Unique addresses" value={formatNumber(meta?.counts.owners)} />
          <Fact label="WebP artworks" value={formatNumber(meta?.counts.artworks)} />
          <Fact label="Data model" value="SQLite schema v1" />
        </dl>
      </section>

      <section className="principles">
        <div>
          <span className="eyebrow">Built for the long run</span>
          <h2>Small runtime, open exports.</h2>
        </div>
        <div className="principles__copy">
          <p>
            The browser is a static React application. A small Hono Worker serves fixed, indexed
            queries from D1; response cache keys include the immutable snapshot version. Artwork is
            delivered directly from R2 through Cloudflare’s CDN.
          </p>
          <p>
            CSV and JSON exports contain snapshot data and stable source identifiers. For an exact
            address, they can include preserved private Drop metadata proven by that address’s
            holdings; global browsing remains redacted. Descriptions are rendered as plain text, and
            event links are treated as untrusted external destinations.
          </p>
        </div>
      </section>

      <section className="rights-note glass-panel">
        <h2>Code and content are different things.</h2>
        <p>
          The application source is released under the MIT License. That license does not grant new
          rights to POAP data, trademarks, issuer-provided descriptions or artwork. Those remain
          subject to their original rights and terms.
        </p>
      </section>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatNumber(value?: number) {
  return typeof value === "number" ? new Intl.NumberFormat("en").format(value) : "—";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}
