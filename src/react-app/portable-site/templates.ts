import type { PortableSiteManifest, PortableSiteRuntimeManifest } from "./types";

const POAP_IN = "https://poap.in";
const REPOSITORY = "https://github.com/glorylab/poapin-archive";

export function buildIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="robots" content="noindex,nofollow">
    <meta name="referrer" content="no-referrer">
    <meta name="description" content="A portable personal POAP archive.">
    <title>Personal POAP archive</title>
    <link rel="stylesheet" href="./assets/site.css">
    <script src="./assets/site.js" defer></script>
  </head>
  <body>
    <div class="page-shell">
      <header class="site-header">
        <a class="wordmark" href="#poaps" aria-label="Personal POAP archive home">
          <span class="wordmark__name">POAP</span>
          <span class="wordmark__archive">Personal archive</span>
        </a>
      </header>

      <main>
        <section class="hero" aria-labelledby="site-title">
          <p class="eyebrow">Personal POAP archive</p>
          <h1 id="site-title">Public collection snapshot</h1>
          <div class="hero__identity">
            <span>Address</span>
            <code id="owner-address">Reading the archive manifest…</code>
          </div>
          <p class="hero__copy">
            Browse preserved POAPs, Collections, Moments, and Capsules for this address.
            This site is read-only, has no analytics, and loads media only when requested.
          </p>
        </section>

        <nav class="tabs" aria-label="Archive sections">
          <a href="#poaps" data-tab="poaps">POAPs</a>
          <a href="#overview" data-tab="overview">Overview</a>
          <a href="#collections" data-tab="collections">Collections</a>
          <a href="#owned" data-tab="owned">Historically owned</a>
          <a href="#moments" data-tab="moments">Moments</a>
        </nav>

        <section class="view" id="archive-view" aria-live="polite">
          <div class="loading-card" role="status">Reading manifest…</div>
        </section>
      </main>

      <footer class="site-footer">
        <div class="site-footer__note">
          <strong>POAP is dead. Long live POAP!</strong>
          <span>A portable public archive generated from preserved snapshots.</span>
        </div>
        <nav class="site-footer__links" aria-label="Project links">
          <a href="${POAP_IN}" target="_blank" rel="noopener noreferrer">poap.in ↗</a>
          <a href="${REPOSITORY}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        </nav>
      </footer>
    </div>
  </body>
</html>
`;
}

export function buildArchiveBootstrap(manifest: PortableSiteRuntimeManifest): string {
  return (
    `globalThis.__POAPIN_ARCHIVE__.manifest(\n` +
    `  ${JSON.stringify(base64UrlEncode(JSON.stringify(manifest)))}\n` +
    `);\n`
  );
}

export function buildSiteCss(): string {
  return `:root {
  color-scheme: light;
  color: #274552;
  background: #4fafc1;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  --canvas: #4fafc1;
  --canvas-light: #87cdd9;
  --canvas-pale: #d9f0f4;
  --ink: #274552;
  --ink-soft: #2b6273;
  --ink-muted: #477787;
  --deep: #1d3943;
  --gold: #e0c72f;
  --gold-light: #f7f7ca;
  --gold-deep: #906618;
  --poap: #5c5aa0;
  --poap-pale: #e4cbf5;
  --surface: rgba(247, 253, 254, 0.74);
  --surface-strong: rgba(255, 255, 255, 0.92);
  --line: rgba(255, 255, 255, 0.46);
  --line-dark: rgba(39, 69, 82, 0.18);
  --shadow: 0 20px 50px rgba(28, 72, 82, 0.16);
  --radius-sm: 12px;
  --radius: 20px;
  --radius-lg: 30px;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--canvas); scroll-behavior: smooth; }
body {
  min-height: 100vh;
  margin: 0;
  background-color: var(--canvas);
  background-image: radial-gradient(rgba(255, 255, 255, 0.35) 1px, transparent 1px);
  background-size: 16px 16px;
  color: var(--ink);
}
body::before {
  position: fixed;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(circle at 12% 6%, rgba(255, 255, 255, 0.28), transparent 29%),
    radial-gradient(circle at 88% 22%, rgba(224, 199, 47, 0.12), transparent 25%),
    linear-gradient(180deg, transparent 70%, rgba(39, 69, 82, 0.08));
  content: "";
  pointer-events: none;
}
a { color: inherit; text-underline-offset: 0.22em; }
button, input { color: inherit; font: inherit; }
:focus-visible {
  outline: 3px solid var(--gold);
  outline-offset: 3px;
  box-shadow: 0 0 0 5px var(--deep);
}
::selection { background: var(--gold-light); color: var(--deep); }
.page-shell {
  display: flex;
  width: min(1280px, calc(100% - 32px));
  min-height: 100vh;
  min-height: 100svh;
  margin: 0 auto;
  flex-direction: column;
}
main { min-width: 0; flex: 1 0 auto; }
.site-header {
  display: flex;
  align-items: center;
  min-height: 62px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.34);
}
.wordmark {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--deep);
  text-decoration: none;
}
.wordmark__name {
  font-size: 0.9rem;
  font-weight: 900;
  letter-spacing: -0.035em;
}
.wordmark__archive {
  border: 1px solid rgba(39, 69, 82, 0.18);
  border-radius: 999px;
  background: var(--gold-light);
  padding: 4px 8px;
  color: var(--deep);
  font-size: 0.58rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.hero {
  max-width: 880px;
  margin-top: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
  padding: clamp(24px, 4vw, 40px);
}
.eyebrow {
  display: flex;
  margin: 0 0 10px;
  align-items: center;
  gap: 8px;
  color: var(--deep);
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.eyebrow::before {
  width: 24px;
  height: 2px;
  background: var(--gold);
  content: "";
}
h1 {
  max-width: 760px;
  margin: 0;
  color: var(--deep);
  font-size: clamp(1.8rem, 4vw, 2.7rem);
  font-weight: 820;
  letter-spacing: -0.055em;
  line-height: 1.02;
}
.hero__identity {
  display: flex;
  max-width: 100%;
  width: fit-content;
  flex-wrap: wrap;
  align-items: center;
  margin: 16px 0 0;
  padding: 8px 11px;
  border: 1px solid var(--line-dark);
  border-radius: var(--radius-sm);
  color: var(--ink-soft);
  background: rgba(255, 255, 255, 0.54);
  gap: 7px 10px;
  font-size: 0.68rem;
}
.hero__identity span { font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
.hero__identity code {
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--poap);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}
.hero__copy {
  max-width: 680px;
  margin: 15px 0 0;
  color: var(--ink);
  font-size: 0.9rem;
  line-height: 1.62;
}
.tabs {
  position: sticky;
  z-index: 5;
  top: 0;
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding: 11px 0;
  margin-top: 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.32);
  border-bottom: 1px solid rgba(255, 255, 255, 0.32);
  background: rgba(79, 175, 193, 0.9);
  backdrop-filter: blur(16px);
}
.tabs a {
  flex: 0 0 auto;
  min-height: 40px;
  padding: 10px 13px;
  border-radius: 999px;
  color: var(--deep);
  font-size: 0.78rem;
  font-weight: 750;
  text-decoration: none;
}
.tabs a:hover { background: rgba(255, 255, 255, 0.24); }
.tabs a[aria-current="page"] { color: var(--deep); background: var(--gold-light); }
.view { min-height: 440px; padding: 38px 0 76px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.section-heading h2 {
  margin: 0;
  color: var(--deep);
  font-size: clamp(1.4rem, 3vw, 2.05rem);
  font-weight: 820;
  letter-spacing: -0.04em;
}
.section-heading p { max-width: 560px; margin: 0; color: var(--deep); font-size: 0.84rem; line-height: 1.55; }
.summary-grid, .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 14px;
}
.metric, .card, .loading-card, .empty-card, .error-card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 16px 42px rgba(28, 72, 82, 0.1);
}
.metric { min-height: 100px; padding: 18px; }
.metric span {
  display: block;
  color: var(--ink-soft);
  font-size: 0.7rem;
  font-weight: 760;
  letter-spacing: 0.01em;
}
.metric strong {
  display: block;
  margin-top: 13px;
  color: var(--deep);
  font-size: clamp(1.7rem, 4vw, 2.15rem);
  font-variant-numeric: tabular-nums;
  font-weight: 820;
  letter-spacing: -0.045em;
  line-height: 1;
}
.overview-note {
  max-width: 820px;
  margin: 18px 0 0;
  border-left: 3px solid var(--gold);
  padding: 8px 12px;
  color: var(--deep);
  font-size: 0.82rem;
  line-height: 1.55;
}
.overview-context { margin-top: 40px; }
.overview-context h3 {
  margin: 0 0 14px;
  color: var(--deep);
  font-size: 1.05rem;
  font-weight: 820;
}
.summary-grid--secondary { grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); }
.summary-grid--secondary .metric { min-height: 98px; background: rgba(255, 255, 255, 0.52); }
.summary-grid--secondary .metric strong { font-size: 1.65rem; }
.card { min-width: 0; padding: 18px; }
.card h3 {
  margin: 0;
  color: var(--deep);
  font-size: 1rem;
  font-weight: 820;
  letter-spacing: -0.025em;
  line-height: 1.25;
}
.card p { color: var(--ink); font-size: 0.82rem; line-height: 1.55; }
.card a { overflow-wrap: anywhere; color: var(--poap); }
.card__meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.pill {
  padding: 5px 8px;
  border: 1px solid var(--line-dark);
  border-radius: 999px;
  color: var(--ink-soft);
  font-size: 0.7rem;
}
.record-details { margin-top: 14px; border-top: 1px solid var(--line-dark); padding-top: 12px; }
.record-details summary { color: var(--poap); cursor: pointer; font-size: 0.76rem; font-weight: 750; }
.record-details pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink);
  font: 0.7rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.media-action {
  width: 100%;
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid rgba(92, 90, 160, 0.3);
  border-radius: var(--radius-sm);
  color: var(--poap);
  background: rgba(92, 90, 160, 0.07);
  cursor: pointer;
  font-weight: 750;
}
.media-action:hover { background: rgba(92, 90, 160, 0.14); }
.media-action--artwork {
  display: grid;
  width: min(100%, 210px);
  min-height: 0;
  aspect-ratio: 1;
  place-items: center;
  margin: 0 auto 16px;
  border-color: var(--line-dark);
  border-radius: 50%;
  padding: 24px;
  background: rgba(217, 240, 244, 0.8);
  font-weight: 720;
}
.media-action--artwork:hover { background: rgba(228, 203, 245, 0.62); }
.poap-card__artwork-unavailable {
  display: grid;
  width: min(100%, 210px);
  min-height: 0;
  aspect-ratio: 1;
  place-items: center;
  margin: 0 auto 16px;
  border: 1px dashed var(--line-dark);
  border-radius: 50%;
  color: var(--ink-soft);
  background: rgba(217, 240, 244, 0.58);
  font-size: 0.78rem;
}
.poap-card__source {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.67rem;
}
.dataset-toolbar, .dataset-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  margin: 14px 0;
}
.dataset-toolbar input, .dataset-pager input {
  min-height: 42px;
  min-width: 0;
  border: 1px solid var(--line-dark);
  border-radius: var(--radius-sm);
  padding: 0 12px;
  color: var(--ink);
  background: var(--surface-strong);
}
.dataset-toolbar input { flex: 1 1 240px; }
.dataset-pager input { width: 82px; }
.dataset-control {
  min-height: 42px;
  padding: 0 15px;
  border: 1px solid var(--line-dark);
  border-radius: var(--radius-sm);
  color: var(--deep);
  background: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  font-weight: 750;
}
.dataset-control:hover { background: var(--surface-strong); }
.dataset-control:disabled { cursor: not-allowed; opacity: 0.42; }
.dataset-status { margin-right: auto; color: var(--deep); font-size: 0.78rem; }
.media-frame { margin: 14px 0 0; }
.media-frame img, .media-frame video {
  display: block;
  width: 100%;
  max-height: 430px;
  border-radius: var(--radius-sm);
  object-fit: contain;
  background: var(--canvas-pale);
}
.media-frame audio { display: block; width: 100%; }
.poap-card .media-frame {
  width: min(100%, 210px);
  aspect-ratio: 1;
  overflow: hidden;
  margin: 0 auto 16px;
  border-radius: 50%;
}
.poap-card .media-frame img {
  height: 100%;
  max-height: none;
  border-radius: 50%;
}
.dataset-group + .dataset-group { margin-top: 44px; }
.dataset-group > h3 {
  display: flex;
  margin: 0 0 14px;
  align-items: center;
  gap: 8px;
  color: var(--deep);
  font-size: 0.72rem;
  font-weight: 850;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.dataset-group > h3::before {
  width: 20px;
  height: 2px;
  background: var(--gold);
  content: "";
}
.holdings-timeline { display: grid; gap: 40px; }
.holding-month__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 20px 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.44);
  padding-bottom: 9px;
  gap: 18px;
}
.holding-month__heading h4 {
  margin: 0;
  color: var(--deep);
  font-size: clamp(1.05rem, 2vw, 1.3rem);
  font-weight: 820;
  letter-spacing: -0.035em;
}
.holding-month__heading span {
  flex: 0 0 auto;
  color: var(--deep);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
}
.holding-month .card { background: rgba(247, 253, 254, 0.8); }
.loading-card, .empty-card, .error-card { padding: 28px; color: var(--deep); }
.error-card { color: #8d3f36; border-color: rgba(141, 63, 54, 0.28); }
.site-footer {
  display: flex;
  margin-top: auto;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 0 38px;
  border-top: 1px solid rgba(255, 255, 255, 0.34);
  color: var(--deep);
}
.site-footer__note {
  display: flex;
  max-width: 620px;
  flex-direction: column;
  gap: 5px;
}
.site-footer__note strong { font-size: 0.82rem; }
.site-footer__note span { font-size: 0.68rem; line-height: 1.5; }
.site-footer__links {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 18px;
}
.site-footer__links a {
  min-height: 40px;
  color: var(--deep);
  font-size: 0.76rem;
  font-weight: 800;
  line-height: 40px;
  text-decoration: none;
}
.site-footer__links a:hover { text-decoration: underline; }
@media (max-width: 700px) {
  .site-footer { align-items: flex-start; flex-direction: column; justify-content: center; }
  .site-header { min-height: 58px; }
  .hero { margin-top: 20px; border-radius: var(--radius); padding: 22px; }
  .hero__identity { border-radius: var(--radius-sm); }
  .section-heading { align-items: flex-start; flex-direction: column; }
  .site-footer__links { justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;
}

export function buildSiteJs(): string {
  return `(() => {
  "use strict";

  const bootstrapPath = "assets/archive.bootstrap.js";
  const view = document.querySelector("#archive-view");
  const address = document.querySelector("#owner-address");
  const tabLinks = Array.from(document.querySelectorAll("[data-tab]"));
  const dataCache = new Map();
  const fileIndex = new Map();
  const transportLoads = new Map();
  const verifiedJsonCache = new Map();
  const pageSize = 48;
  let manifest;
  let dropLookupPromise;
  let routeEpoch = 0;

  Object.defineProperty(globalThis, "__POAPIN_ARCHIVE__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      manifest(payload) {
        registerTransport(bootstrapPath, "manifest", payload);
      },
      chunk(path, payload) {
        registerTransport(path, "chunk", payload);
      },
    }),
  });

  const manifestPromise = loadRuntimeManifest();

  window.addEventListener("hashchange", route);
  view.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page-dataset]");
    if (pageButton) {
      changePage(
        pageButton.dataset.pageDataset,
        Number(pageButton.dataset.pageDirection || 0),
        pageButton.dataset.pageAction || "",
      );
      return;
    }
    const searchButton = event.target.closest("[data-search-dataset]");
    if (searchButton) {
      searchDataset(
        searchButton.dataset.searchDataset,
        searchButton.dataset.searchAction || "search",
      );
      return;
    }
    const button = event.target.closest("[data-media-url]");
    if (!button) return;
    mountMedia(button);
  });
  view.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const pageInput = event.target.closest("[data-page-input]");
    if (pageInput) {
      event.preventDefault();
      changePage(pageInput.dataset.pageInput, 0, "go");
      return;
    }
    const searchInput = event.target.closest("[data-search-input]");
    if (searchInput) {
      event.preventDefault();
      searchDataset(searchInput.dataset.searchInput, "search");
    }
  });

  route();

  async function route() {
    const epoch = ++routeEpoch;
    const current = (location.hash || "#poaps").slice(1);
    const routeName = ["overview", "poaps", "collections", "owned", "moments"].includes(current)
      ? current
      : "poaps";
    tabLinks.forEach((link) => {
      if (link.dataset.tab === routeName) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    view.innerHTML = '<div class="loading-card" role="status">Reading archive…</div>';
    try {
      const currentManifest = await manifestPromise;
      if (epoch !== routeEpoch) return;
      if (routeName === "overview") renderOverview(currentManifest);
      else await renderTab(routeName, currentManifest, epoch);
    } catch (error) {
      if (epoch === routeEpoch) renderError(error);
    }
  }

  function renderOverview(currentManifest) {
    const counts = currentManifest.counts;
    const context = element("section", "overview-context");
    context.append(
      element("h3", "", "Archive context"),
      grid([
        metric("Related collection profiles", counts.collectionProfiles),
        metric("Private held Drops", counts.privateHeldDrops),
        metric("Hidden held Drops", counts.hiddenHeldDrops),
        metric("Unavailable Drop details", counts.unavailableDropReferences),
      ], "summary-grid summary-grid--secondary"),
    );
    view.replaceChildren(
      heading("Archive summary", "Exact public relationships recorded in manifest.json."),
      grid([
        metric("POAP holdings", counts.holdings),
        metric("Preserved Drops", counts.uniqueDrops),
        metric("Owned Collections at snapshot", counts.ownedCollections),
        metric("Public authored Moments", counts.publicAuthoredMoments),
        metric("Public tagged Moments", counts.publicTaggedMoments),
        metric("Public Capsules owned at snapshot", counts.ownedCapsules),
      ], "summary-grid"),
      element(
        "p",
        "overview-note",
        "Owned Collections and Capsules reflect the archived owner field. Authored and tagged " +
          "Moments remain separate, so their counts are never combined.",
      ),
      context,
    );
  }

  async function renderTab(tab, currentManifest, epoch) {
    const datasets = currentManifest.datasets.filter((dataset) => dataset.tab === tab);
    const dropsById = tab === "poaps" ? await loadDropLookup() : new Map();
    const loaded = await Promise.all(
      datasets.map(async (dataset) => {
        const state = datasetState(dataset);
        return { state, items: await currentPageItems(state) };
      }),
    );
    const titles = {
      poaps: ["POAPs", "Artwork stays dormant until you choose to load it."],
      collections: ["Collections", "Collections connected to the POAP drops in this export."],
      owned: ["Historically owned collections", "Complete public segments for collections whose archived owner field matches this address; this does not prove current control."],
      moments: ["Moments and capsules", "Authored and tagged public Moments stay separate; media remains click-to-load."],
    };
    const content = document.createDocumentFragment();
    content.append(heading(titles[tab][0], titles[tab][1]));
    if (loaded.every(({ state }) => state.count === 0)) {
      content.append(message("Nothing was exported for this section.", "empty-card"));
    } else {
      loaded.forEach(({ state, items }) => {
        if (state.count === 0) return;
        const group = element("section", "dataset-group");
        const total = state.matches ? state.matches.length : state.count;
        group.append(element("h3", "", state.label + " · " + state.count));
        group.append(datasetToolbar(state));
        if (items.length === 0) {
          group.append(message("No records match this search.", "empty-card"));
        } else if (state.id === "holdings") {
          group.append(groupHoldingsByMonth(items, dropsById));
        } else {
          group.append(
            grid(
              items.map((item) => renderRecord(state.id, item)),
              "card-grid",
            ),
          );
        }
        group.append(datasetPager(state, total));
        content.append(group);
      });
    }
    if (epoch === routeEpoch) view.replaceChildren(content);
  }

  function datasetState(dataset) {
    if (dataCache.has(dataset.id)) return dataCache.get(dataset.id);
    const chunkCounts = dataset.paths.map((path) => {
      const file = fileIndex.get(path);
      if (!file || !Number.isSafeInteger(file.count) || file.count < 0) {
        throw new Error(path + " is missing record-count metadata.");
      }
      return file.count;
    });
    if (chunkCounts.reduce((total, count) => total + count, 0) !== dataset.count) {
      throw new Error(dataset.id + " chunk counts do not match manifest.json.");
    }
    const state = {
      ...dataset,
      chunkCounts,
      chunks: new Map(),
      page: 0,
      query: "",
      matches: null,
    };
    dataCache.set(dataset.id, state);
    return state;
  }

  async function loadChunk(dataset, index) {
    if (dataset.chunks.has(index)) return dataset.chunks.get(index);
    const path = dataset.paths[index];
    if (!path) throw new Error("Portable archive chunk index is out of range.");
    const body = await verifiedJson(path);
    if (
      body.schemaVersion !== "poapin-portable-data-v1" ||
      body.dataset !== dataset.id ||
      body.address !== manifest.address ||
      !sameJson(body.snapshotIds, manifest.snapshotIds) ||
      !sameJson(body.sources, manifest.sources) ||
      !body.chunk ||
      body.chunk.index !== index + 1 ||
      body.chunk.total !== dataset.paths.length ||
      body.count !== dataset.chunkCounts[index] ||
      !Array.isArray(body.items) ||
      body.items.length !== body.count
    ) {
      throw new Error(path + " does not belong to this portable archive.");
    }
    dataset.chunks.set(index, body.items);
    return body.items;
  }

  async function loadDropLookup() {
    if (dropLookupPromise) return dropLookupPromise;
    const dataset = manifest.datasets.find((entry) => entry.id === "drops");
    if (!dataset) return new Map();
    const state = datasetState(dataset);
    dropLookupPromise = Promise.all(
      state.paths.map((_path, index) => loadChunk(state, index)),
    ).then((chunks) => {
      const lookup = new Map();
      chunks.flat().forEach((drop) => lookup.set(drop.dropId, drop));
      return lookup;
    });
    try {
      return await dropLookupPromise;
    } catch (error) {
      dropLookupPromise = undefined;
      throw error;
    }
  }

  async function currentPageItems(dataset) {
    const source = dataset.matches;
    const start = dataset.page * pageSize;
    const end = start + pageSize;
    if (source) return source.slice(start, end);
    const items = [];
    let chunkStart = 0;
    for (let index = 0; index < dataset.paths.length; index += 1) {
      const chunkEnd = chunkStart + dataset.chunkCounts[index];
      if (chunkEnd > start && chunkStart < end) {
        const chunk = await loadChunk(dataset, index);
        items.push(
          ...chunk.slice(
            Math.max(0, start - chunkStart),
            Math.min(chunk.length, end - chunkStart),
          ),
        );
      }
      if (chunkStart >= end) break;
      chunkStart = chunkEnd;
    }
    return items;
  }

  async function changePage(datasetId, direction, action) {
    try {
      const dataset = dataCache.get(datasetId);
      if (!dataset) return;
      const total = dataset.matches ? dataset.matches.length : dataset.count;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (action === "go") {
        const input = view.querySelector('[data-page-input="' + datasetId + '"]');
        const requested = Number(input?.value);
        if (Number.isFinite(requested)) {
          dataset.page = Math.max(0, Math.min(pages - 1, Math.trunc(requested) - 1));
        }
      } else {
        dataset.page = Math.max(0, Math.min(pages - 1, dataset.page + direction));
      }
      await route();
    } catch (error) {
      renderError(error);
    }
  }

  async function searchDataset(datasetId, action) {
    try {
      const dataset = dataCache.get(datasetId);
      if (!dataset) return;
      const input = view.querySelector('[data-search-input="' + datasetId + '"]');
      const query = action === "clear" ? "" : String(input?.value || "").trim().slice(0, 120);
      dataset.query = query;
      dataset.page = 0;
      if (!query) {
        dataset.matches = null;
      } else {
        view.setAttribute("aria-busy", "true");
        const all = [];
        for (let index = 0; index < dataset.paths.length; index += 1) {
          all.push(...await loadChunk(dataset, index));
        }
        const dropsById = dataset.id === "holdings" ? await loadDropLookup() : null;
        const normalized = query.toLocaleLowerCase("en-US");
        dataset.matches = all.filter((item) => {
          const searchable = dropsById
            ? { holding: item, drop: dropsById.get(item.dropId) || null }
            : item;
          return JSON.stringify(searchable).toLocaleLowerCase("en-US").includes(normalized);
        });
      }
      await route();
    } catch (error) {
      renderError(error);
    } finally {
      view.removeAttribute("aria-busy");
    }
  }

  function datasetToolbar(dataset) {
    const toolbar = element("div", "dataset-toolbar");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search every archived field";
    input.value = dataset.query;
    input.dataset.searchInput = dataset.id;
    input.setAttribute("aria-label", "Search " + dataset.label);
    const search = control("Search", "searchDataset", dataset.id);
    search.dataset.searchAction = "search";
    const clear = control("Clear", "searchDataset", dataset.id);
    clear.dataset.searchAction = "clear";
    clear.disabled = !dataset.query;
    toolbar.append(input, search, clear);
    return toolbar;
  }

  function datasetPager(dataset, total) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    dataset.page = Math.max(0, Math.min(dataset.page, pages - 1));
    const start = total === 0 ? 0 : dataset.page * pageSize + 1;
    const end = Math.min(total, (dataset.page + 1) * pageSize);
    const pager = element("div", "dataset-pager");
    pager.append(element("span", "dataset-status", start + "–" + end + " of " + total));
    const previous = control("Previous", "pageDataset", dataset.id);
    previous.dataset.pageDirection = "-1";
    previous.disabled = dataset.page === 0;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(pages);
    input.value = String(dataset.page + 1);
    input.dataset.pageInput = dataset.id;
    input.setAttribute("aria-label", "Page number");
    const go = control("Go", "pageDataset", dataset.id);
    go.dataset.pageAction = "go";
    const next = control("Next", "pageDataset", dataset.id);
    next.dataset.pageDirection = "1";
    next.disabled = dataset.page + 1 >= pages;
    pager.append(previous, input, element("span", "", "of " + pages), go, next);
    return pager;
  }

  function control(label, dataName, datasetId) {
    const button = element("button", "dataset-control", label);
    button.type = "button";
    button.dataset[dataName] = datasetId;
    return button;
  }

  function renderRecord(datasetId, item) {
    if (datasetId === "holdings") return holdingCard(item);
    if (datasetId === "drops") return dropCard(item);
    if (datasetId === "unavailable-drop-references") return unavailableDropCard(item);
    if (datasetId === "collection-profiles") return collectionCard(item);
    if (datasetId === "held-drop-memberships") return membershipCard(item);
    if (datasetId === "authored-moment-associations") {
      return momentAssociationCard(item, "Authored");
    }
    if (datasetId === "tagged-moment-associations") {
      return momentAssociationCard(item, "Tagged");
    }
    if (datasetId === "owned-collections") return ownedCollectionCard(item);
    if (datasetId === "moments" || datasetId === "moments-authored") {
      return momentCard(item, "Authored");
    }
    if (datasetId === "moments-tagged") return momentCard(item, "Tagged");
    if (datasetId === "capsules") return capsuleCard(item);
    return genericCard(item);
  }

  function holdingCard(item, drop) {
    const card = element("article", "card poap-card");
    const title = drop?.title || "Drop " + item.dropId;
    if (drop?.hasArtwork !== false && drop?.imageUrl) {
      const artwork = mediaButton("Load artwork for " + title, drop.imageUrl, "image", "");
      artwork.classList.add("media-action--artwork");
      card.append(artwork);
    } else {
      card.append(element("div", "poap-card__artwork-unavailable", "Artwork unavailable"));
    }
    card.append(element("h3", "", title));
    if (drop?.description) card.append(element("p", "", drop.description));
    card.append(meta([
      "Token " + item.poapId,
      "Drop " + item.dropId,
      item.network || "",
      drop?.isHidden ? "Hidden Drop" : "",
      drop?.isPrivate ? "Private Drop" : "",
      formatMintedDate(item.mintedOn),
      item.transferCount !== undefined ? item.transferCount + " transfers" : "",
    ]));
    card.append(
      element(
        "p",
        "poap-card__source",
        "Source " + (item.sourceUid || "not recorded"),
      ),
    );
    return withArchiveFields(card, { holding: item, drop: drop || null });
  }

  function groupHoldingsByMonth(items, dropsById) {
    const groups = new Map();
    items.forEach((item) => {
      const month = mintedMonth(item.mintedOn);
      const group = groups.get(month.key) || { ...month, items: [] };
      group.items.push(item);
      groups.set(month.key, group);
    });
    const timeline = element("div", "holdings-timeline");
    [...groups.values()]
      .sort((left, right) => {
        if (left.key === "unknown") return 1;
        if (right.key === "unknown") return -1;
        return right.key.localeCompare(left.key);
      })
      .forEach((group) => {
      const section = element("section", "holding-month");
      const header = element("div", "holding-month__heading");
      header.append(
        element("h4", "", group.label),
        element("span", "", group.items.length + " on this page"),
      );
      section.append(
        header,
        grid(
          group.items.map((item) => holdingCard(item, dropsById.get(item.dropId))),
          "card-grid",
        ),
      );
      timeline.append(section);
      });
    return timeline;
  }

  function mintedMonth(value) {
    const date = unixDate(value);
    if (!date) return { key: "unknown", label: "Mint date unavailable" };
    return {
      key: date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0"),
      label: "Minted in " + new Intl.DateTimeFormat("en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    };
  }

  function formatMintedDate(value) {
    const date = unixDate(value);
    if (!date) return "";
    return "Minted " + new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  function unixDate(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dropCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", item.title || "Drop " + item.dropId));
    card.append(element("p", "", item.description || "No public Drop description archived."));
    card.append(meta([
      item.year ? String(item.year) : "",
      item.city || item.country || "",
      item.dropId !== undefined ? "Drop " + item.dropId : "",
      item.isHidden ? "Hidden Drop" : "",
      item.isPrivate ? "Private Drop" : "",
    ]));
    if (item.hasArtwork !== false && item.imageUrl) {
      card.append(mediaButton("Load archived artwork", item.imageUrl, "image", ""));
    }
    return withArchiveFields(card, item);
  }

  function unavailableDropCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", "Drop " + item.dropId));
    card.append(
      element(
        "p",
        "",
        "No preserved Drop detail was available in this archive snapshot. This may be a missing or hidden record.",
      ),
    );
    card.append(meta(["Reference preserved", "Metadata unavailable"]));
    return withArchiveFields(card, item);
  }

  function collectionCard(profile) {
    const collection = profile.collection || {};
    const card = element("article", "card");
    card.append(element("h3", "", collection.title || "Untitled collection"));
    card.append(element("p", "", collection.description || "No description archived."));
    card.append(meta([
      collection.type || "",
      collection.itemCount !== undefined ? collection.itemCount + " items" : "",
      collection.isVerified ? "Verified" : "",
    ]));
    const mediaUrl = collection.logoUrl || collection.bannerUrl ||
      (profile.media || []).find((entry) => entry.eligibleForPublish && entry.objectUrl)?.objectUrl;
    if (mediaUrl) card.append(mediaButton("Load collection media", mediaUrl, "image", ""));
    return withArchiveFields(card, profile);
  }

  function membershipCard(item) {
    const card = element("article", "card");
    const collection = item.collection || {};
    card.append(element("h3", "", collection.title || "Collection membership"));
    card.append(element("p", "", "Matched drops: " + (item.matchedDropIds || []).join(", ")));
    return withArchiveFields(card, item);
  }

  function momentAssociationCard(item, relation) {
    const card = element("article", "card");
    card.append(element("h3", "", "Collection " + item.collectionId));
    card.append(
      element(
        "p",
        "",
        (item.momentIds || []).length +
          " public " +
          relation.toLocaleLowerCase("en-US") +
          " Moments are associated through archived Drop membership.",
      ),
    );
    card.append(meta([relation + " Moment relationship"]));
    return withArchiveFields(card, item);
  }

  function ownedCollectionCard(item) {
    const profile = item.profile || {};
    const collection = profile.collection || {};
    const card = element("article", "card");
    card.append(element("h3", "", collection.title || "Owned collection"));
    card.append(element("p", "", collection.description || "Complete public export included."));
    card.append(meta([
      item.collectionId !== undefined ? "Collection " + item.collectionId : "",
      item.manifest?.counts?.items !== undefined ? item.manifest.counts.items + " items" : "",
    ]));
    const mediaUrl = collection.logoUrl || collection.bannerUrl;
    if (mediaUrl) card.append(mediaButton("Load collection media", mediaUrl, "image", ""));
    return withArchiveFields(card, item);
  }

  function momentCard(item, relation) {
    const card = element("article", "card");
    card.append(element("h3", "", item.displayId || "Moment " + item.momentId));
    card.append(element("p", "", item.description || "No description archived."));
    card.append(meta([
      relation,
      item.createdOn || "",
      item.mediaCount !== undefined ? item.mediaCount + " media" : "",
      item.mediaPreservationState || "",
      (item.dropIds || []).length ? "Drops " + item.dropIds.join(", ") : "",
      (item.collectionIds || []).length ? "Collections " + item.collectionIds.join(", ") : "",
    ]));
    (item.links || []).forEach((link) => {
      const anchor = safeExternalLink(link.url, link.title || link.url || "Archived link");
      if (anchor) card.append(anchor);
      if (link.imageUrl) {
        card.append(mediaButton("Load link preview", link.imageUrl, "image", ""));
      }
    });
    if ((item.userTags || []).length) {
      card.append(
        element(
          "p",
          "",
          "Tagged people: " +
            item.userTags.map((tag) => tag.ens || tag.address || "unnamed").join(", "),
        ),
      );
    }
    (item.capsules || []).forEach((capsule) => {
      card.append(
        element(
          "p",
          "",
          "Capsule: " + (capsule.title || capsule.externalId || capsule.capsuleId),
        ),
      );
      if (capsule.imageUrl) {
        card.append(mediaButton("Load capsule image", capsule.imageUrl, "image", ""));
      }
    });
    (item.media || []).forEach((media, index) => {
      if (!media.url) return;
      card.append(mediaButton(
        "Load " + (media.kind || "media") + " " + (index + 1),
        media.url,
        media.kind || "other",
        media.mimeType || "",
      ));
    });
    return withArchiveFields(card, item);
  }

  function capsuleCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", item.title || item.externalId || "Capsule " + item.capsuleId));
    card.append(element("p", "", item.description || "No public Capsule description archived."));
    card.append(meta([item.createdOn || "", item.owner ? "Owner " + item.owner : ""]));
    const link = safeExternalLink(item.url, "Open archived Capsule URL");
    if (link) card.append(link);
    if (item.imageUrl) card.append(mediaButton("Load capsule image", item.imageUrl, "image", ""));
    return withArchiveFields(card, item);
  }

  function genericCard(item) {
    const card = element("article", "card");
    const title = item.drop?.title || item.artistId || item.suggestionId || item.dropId || "Record";
    card.append(element("h3", "", String(title)));
    card.append(element("p", "", "Open Archived fields for the complete preserved record."));
    return withArchiveFields(card, item);
  }

  function withArchiveFields(card, item) {
    const details = element("details", "record-details");
    details.append(element("summary", "", "Archived fields"));
    details.append(element("pre", "", JSON.stringify(item, null, 2)));
    card.append(details);
    return card;
  }

  function safeExternalLink(value, label) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      const anchor = element("a", "", label);
      anchor.href = parsed.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      return anchor;
    } catch {
      return null;
    }
  }

  function mediaButton(label, url, kind, mimeType) {
    const button = element("button", "media-action", label);
    button.type = "button";
    button.dataset.mediaUrl = url;
    button.dataset.mediaKind = kind;
    button.dataset.mediaMime = mimeType;
    return button;
  }

  function mountMedia(button) {
    const url = safeMediaUrl(button.dataset.mediaUrl);
    if (!url) {
      button.textContent = "Media URL is unavailable";
      button.disabled = true;
      return;
    }
    const kind = button.dataset.mediaKind;
    const frame = element("figure", "media-frame");
    let media;
    if (kind === "image") {
      media = document.createElement("img");
      media.alt = "";
      media.loading = "lazy";
      media.decoding = "async";
      media.src = url;
    } else if (kind === "video" || kind === "audio") {
      media = document.createElement(kind);
      media.controls = true;
      media.preload = "none";
      const source = document.createElement("source");
      source.src = url;
      if (button.dataset.mediaMime) source.type = button.dataset.mediaMime;
      media.append(source);
    } else {
      const link = element("a", "", "Open media");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      media = link;
    }
    frame.append(media);
    button.replaceWith(frame);
  }

  function safeMediaUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function heading(title, copy) {
    const wrapper = element("div", "section-heading");
    wrapper.append(element("h2", "", title), element("p", "", copy));
    return wrapper;
  }

  function metric(label, value) {
    const card = element("article", "metric");
    card.append(element("span", "", label), element("strong", "", String(value)));
    return card;
  }

  function meta(values) {
    const wrapper = element("div", "card__meta");
    values.filter(Boolean).forEach((value) => wrapper.append(element("span", "pill", value)));
    return wrapper;
  }

  function grid(children, className) {
    const wrapper = element("div", className);
    children.forEach((child) => wrapper.append(child));
    return wrapper;
  }

  function message(copy, className) {
    return element("div", className, copy);
  }

  function validateManifest(value) {
    if (
      !value ||
      value.schemaVersion !== "poapin-portable-runtime-v1" ||
      !/^0x[0-9a-f]{40}$/.test(value.address || "") ||
      !value.snapshotIds ||
      !value.sources ||
      !value.sources.collections?.releaseId ||
      !value.sources.moments?.releaseId ||
      !/^[0-9a-f]{64}$/.test(value.sources.moments?.sourceDatabaseSha256 || "") ||
      !/^[0-9a-f]{64}$/.test(value.sources.moments?.buildManifestSha256 || "") ||
      !sameJson(value.snapshotIds, {
        holdings: value.sources.holdings?.snapshotId,
        collections: value.sources.collections?.snapshotId,
        moments: value.sources.moments?.snapshotId,
      }) ||
      !value.counts ||
      !Array.isArray(value.datasets) ||
      !Array.isArray(value.files)
    ) {
      throw new Error("The local archive index is not a supported POAPin portable archive.");
    }
    const paths = new Set();
    value.files.forEach((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        !isSafeTransportPath(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.count) ||
        file.count < 0 ||
        !file.payload ||
        file.payload.encoding !== "base64url" ||
        file.payload.mimeType !== "application/json" ||
        !Number.isSafeInteger(file.payload.bytes) ||
        file.payload.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(file.payload.sha256 || "")
      ) {
        throw new Error("The local archive index contains invalid data integrity metadata.");
      }
      paths.add(file.path);
    });
    const datasetPaths = new Set();
    value.datasets.forEach((dataset) => {
      if (
        !dataset ||
        typeof dataset.id !== "string" ||
        !Number.isSafeInteger(dataset.count) ||
        dataset.count < 0 ||
        !Array.isArray(dataset.paths) ||
        dataset.paths.some(
          (path) => !paths.has(path) || datasetPaths.has(path) || !isSafeTransportPath(path),
        )
      ) {
        throw new Error("The local archive index contains an invalid dataset.");
      }
      dataset.paths.forEach((path) => datasetPaths.add(path));
    });
    if (datasetPaths.size !== paths.size) {
      throw new Error("The local archive index contains unreferenced data.");
    }
  }

  async function verifiedJson(path) {
    if (verifiedJsonCache.has(path)) return verifiedJsonCache.get(path);
    const pending = (async () => {
      const expected = fileIndex.get(path);
      if (!expected?.payload) {
        throw new Error(path + " is not declared by the local archive index.");
      }
      const encoded = await loadTransport(path, "chunk");
      const expectedEncodedLength = Math.ceil((expected.payload.bytes * 4) / 3);
      if (encoded.length !== expectedEncodedLength) {
        throw new Error(path + " failed its payload byte-length check.");
      }
      const bytes = decodeBase64Url(encoded, path);
      if (bytes.byteLength !== expected.payload.bytes) {
        throw new Error(path + " failed its payload byte-length check.");
      }
      if (await sha256Hex(bytes) !== expected.payload.sha256) {
        throw new Error(path + " failed its payload SHA-256 check.");
      }
      return parseJsonBytes(bytes, path);
    })();
    verifiedJsonCache.set(path, pending);
    try {
      return await pending;
    } catch (error) {
      verifiedJsonCache.delete(path);
      throw error;
    }
  }

  async function loadRuntimeManifest() {
    const encoded = await loadTransport(bootstrapPath, "manifest");
    const value = parseJsonBytes(decodeBase64Url(encoded, bootstrapPath), bootstrapPath);
    validateManifest(value);
    manifest = value;
    value.files.forEach((file) => fileIndex.set(file.path, file));
    address.textContent = value.address;
    document.title = "POAP archive · " + shortAddress(value.address);
    return value;
  }

  function loadTransport(path, kind) {
    if (!isSafeTransportPath(path)) {
      return Promise.reject(new Error("The portable archive requested an unsafe local path."));
    }
    if (transportLoads.has(path)) {
      return Promise.reject(new Error(path + " was requested more than once."));
    }
    const state = { kind, registered: false, payload: "", error: null };
    transportLoads.set(path, state);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = new URL(path, document.baseURI).href;
      script.addEventListener("load", () => {
        transportLoads.delete(path);
        script.remove();
        if (state.error) reject(state.error);
        else if (!state.registered) reject(new Error(path + " did not register portable data."));
        else resolve(state.payload);
      });
      script.addEventListener("error", () => {
        transportLoads.delete(path);
        script.remove();
        reject(new Error("Could not read " + path + "."));
      });
      document.head.append(script);
    });
  }

  function registerTransport(path, kind, payload) {
    const state = transportLoads.get(path);
    if (!state || state.kind !== kind) return;
    if (state.registered) {
      state.error = new Error(path + " registered portable data more than once.");
      return;
    }
    if (typeof payload !== "string") {
      state.error = new Error(path + " registered invalid portable data.");
      return;
    }
    state.registered = true;
    state.payload = payload;
  }

  function decodeBase64Url(value, path) {
    if (
      typeof value !== "string" ||
      value.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new Error(path + " is not valid Base64URL data.");
    }
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
    let binary;
    try {
      binary = atob(padded);
    } catch {
      throw new Error(path + " is not valid Base64URL data.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function parseJsonBytes(bytes, path) {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(path + " is not valid portable JSON.");
    }
  }

  function isSafeTransportPath(path) {
    return (
      typeof path === "string" &&
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\\\") &&
      !path.split("/").includes("..")
    );
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function renderError(error) {
    const copy = error instanceof Error ? error.message : "The portable archive could not be read.";
    view.replaceChildren(message(copy, "error-card"));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function shortAddress(value) {
    return value.length > 14 ? value.slice(0, 8) + "…" + value.slice(-6) : value;
  }
})();
`;
}

export function buildReadme(manifest: PortableSiteManifest): string {
  return `# Personal POAP archive

This folder is a complete, read-only personal archive generated by [poap.in](${POAP_IN}).
The archive code is open source at [glorylab/poapin-archive](${REPOSITORY}).

Address: \`${manifest.address}\`

## What is included

- ${manifest.counts.holdings} token-level POAP holdings and ${manifest.counts.uniqueDrops} preserved Drop records
- ${manifest.counts.privateHeldDrops} private Drop records included because this exact address held a matching token
- ${manifest.counts.hiddenHeldDrops} hidden Drop records included because this exact address held a matching token
- ${manifest.counts.unavailableDropReferences} genuinely unavailable referenced Drop IDs without preserved details
- ${manifest.counts.collectionProfiles} related collection profiles
- ${manifest.counts.heldDropMemberships} formal held-Drop → Collection memberships
- ${manifest.counts.authoredMomentAssociations} authored-Moment → Collection associations
- ${manifest.counts.ownedCollections} fully exported historically owned collections
- ${manifest.counts.publicAuthoredMoments} public authored moments
- ${manifest.counts.publicTaggedMoments} public moments that tag this address
- ${manifest.counts.ownedCapsules} public Capsules whose archived owner matched this address

“Historically owned” means the archived Collection owner field matched this exact address at the
snapshot. It is kept separate from Collections that merely contain a held Drop or are associated
with an authored Moment, and it does not prove current control.

Double-click \`index.html\` to browse this archive directly from the extracted folder. The same
files can also be served by any static host. The page reads a small local archive index first;
each section then loads the verified data chunks it needs and shows records in small pages.
Archived media URLs remain in the data, but media is requested only after a visitor clicks its
load button.

## Integrity and portability

\`manifest.json\` records the UTF-8 byte length, record count, and SHA-256 digest for every
other generated file; \`checksums.sha256\` is convenient for standard checksum tools. Local data
payloads are also checked before they are parsed. All paths are relative. No account connection,
API, database, build step, local server, or hosted runtime is required.

See \`DEPLOY.md\` for direct-upload instructions and \`prompts/\` for agent-ready deployment
prompts. Keep the entire folder together when moving or deploying it.
`;
}

export function buildDeployGuide(): string {
  return `# Deploy this portable archive

Deploy the **contents of this folder**, with \`index.html\` at the published root. If you
received a ZIP, extract it first unless the destination explicitly accepts a ZIP upload.
Do not rewrite the relative paths under \`assets/\` or \`data/\`.

Before deploying, you can simply double-click \`index.html\` in the extracted folder. It should
open the archive in a current browser without starting a local server.

## Direct upload

1. **Cloudflare Drop (recommended):** open <https://www.cloudflare.com/drop/> and upload this ZIP
   or the extracted folder. Keep the private Claim URL secret and finish claiming the deployment
   within 60 minutes; merely opening that URL is not enough.
2. **Vercel Drop:** sign in at <https://vercel.com/drop>, upload this ZIP or the extracted folder,
   select a Team and project name, then deploy.
3. **Filebase Sites:** extract the ZIP, open Sites in Filebase Console, create a Site, and upload
   the entire folder. Filebase Sites accepts a folder or CAR, not this transport ZIP.
4. **Internet Computer (advanced):** publish the extracted folder with an ICP asset canister only
   after reviewing the identity, cycles, canister, and update implications.

After deployment, open the root URL and check Overview, POAPs, Collections, Historically owned,
and Moments. Media should remain dormant until its button is clicked.

## Agent-assisted deployment

Copy the matching file from \`prompts/\` into your coding agent. Replace optional placeholders
such as \`YOUR_DOMAIN\` only when you want a custom domain. Never paste provider tokens into a
prompt; use the provider's authorization flow or local secret storage.

Project links: [poap.in](${POAP_IN}) · [GitHub](${REPOSITORY})
`;
}

export function buildAgentPrompts(manifest: PortableSiteManifest): Record<string, string> {
  const shortAddress = manifest.address.slice(2, 10);
  const compatibilityDate = manifest.generatedAt?.slice(0, 10) ?? "2026-07-23";
  const context = `This folder is a generated, pure-static personal POAP archive for ${manifest.address}.
It already contains index.html, relative assets, data chunks, manifest.json, README.md, and DEPLOY.md.
Do not introduce a framework, server runtime, database, analytics, wallet connection, or build step.
Preserve every relative path. Do not fetch or copy remote POAP/Moment media during deployment.
Keep the visible links to ${POAP_IN} and ${REPOSITORY}.
Verify manifest file sizes and SHA-256 digests before publishing. Never print or commit credentials.`;

  return {
    "prompts/cloudflare.md": `# Deploy with Cloudflare

${context}

Confirm that index.html is at the extracted folder root. Use Wrangler 4.102.0 or newer. If this
environment is not signed in to Cloudflare, run:

\`npm exec --yes wrangler@latest -- deploy --assets <site-directory> --name poap-${shortAddress} --temporary --compatibility-date ${compatibilityDate}\`

If Cloudflare OAuth or API credentials are already available, remove \`--temporary\` and deploy
normally. Request the homepage and verify HTTP 200, hash navigation, dormant media, and the two
fixed project links. Return the workers.dev URL. For a temporary deployment, return the Claim URL
only to the user and remind them to complete the claim within 60 minutes. Treat that Claim URL as
a bearer credential: never write it to code, README files, analytics, commits, logs, or public
messages. If \`YOUR_DOMAIN\` is requested, attach it only after the preview works.
`,
    "prompts/vercel.md": `# Deploy with Vercel

${context}

Confirm that index.html is at the extracted folder root. Use the latest Vercel CLI. If this
environment is not signed in, run \`npx vercel@latest login\` and give the user the device
authorization URL and code so they can approve it from another browser; never ask them to paste
an access token into chat. After authorization, run:

\`npx vercel@latest --cwd <site-directory> --yes --prod\`

Verify HTTP 200, relative assets, hash navigation, dormant media, and the two fixed project links.
Do not commit the \`.vercel\` directory or credentials. If \`YOUR_DOMAIN\` is requested, attach it
only after the generated deployment works. Return the production vercel.app URL.
`,
    "prompts/filebase.md": `# Deploy with Filebase Sites

${context}

Use the user's authorized Filebase Console session. Open Sites, create a Site with an available
lowercase name based on \`poap-${shortAddress}\`, select “Upload now”, and upload the entire
extracted folder. Filebase Sites accepts a folder or CAR, not the transport ZIP. Wait for the
myfilebase.site address, then verify the homepage, hash navigation, dormant media, and fixed
project links. Return the public URL and available CID/deployment details. Do not claim that the
remote media is stored inside the Site: it intentionally references media.poap.in. Do not claim
that a pin is permanent. Configure \`YOUR_DOMAIN\` only if requested and supported by the plan.
`,
    "prompts/icp.md": `# Deploy to the Internet Computer

${context}

Prepare to deploy the extracted folder as static assets on the Internet Computer. First show the
user the selected dfx identity, target network, estimated cycles, canister creation/update
implications, and exact commands. Wait for explicit approval before spending cycles or creating a
canister. Keep index.html at the asset root, preserve content types, and do not add server-side
logic. Verify the manifest, relative assets, hash tabs, dormant media, and fixed project links.
Never expose seed phrases, PEM files, identities, or wallet credentials. Configure
\`YOUR_DOMAIN\` only after the canister URL works. Return the canister identifier and public URL.
`,
  };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
