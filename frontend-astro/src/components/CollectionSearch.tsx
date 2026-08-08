import { useEffect, useState } from "react";
import {
  completePendingEmailReservations,
  getAppConfig,
  readableError,
  resolveEns,
  verifyMagicSession,
} from "../lib/live-api";
import { loginWithMagicEmail } from "../lib/magic-wallet";
import { looksLikeEnsName } from "../lib/recipient-input";

export default function CollectionSearch() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const resetRestoredSearch = () => {
      setSearching(false);
      setError("");
    };
    window.addEventListener("pageshow", resetRestoredSearch);
    return () => window.removeEventListener("pageshow", resetRestoredSearch);
  }, []);

  const search = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) {
      setError("請輸入 Email、ENS 或 Ethereum 地址");
      return;
    }
    if (value.includes("@")) {
      setSearching(true);
      setError("");
      try {
        const config = await getAppConfig();
        if (!config.embeddedWallet.enabled || !config.embeddedWallet.publishableKey) {
          window.location.href = `/email/collection?email=${encodeURIComponent(value)}`;
          return;
        }
        const magic = await loginWithMagicEmail(
          config.embeddedWallet.publishableKey,
          value,
          config.embeddedWallet.emailTemplateName,
        );
        const verified = await verifyMagicSession(magic.didToken, value);
        await completePendingEmailReservations(verified.address);
        window.location.href = `/address/${encodeURIComponent(verified.address)}`;
      } catch (problem) {
        setError(readableError(problem));
        setSearching(false);
      }
      return;
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
      window.location.href = `/address/${encodeURIComponent(value)}`;
      return;
    }
    if (looksLikeEnsName(value)) {
      setSearching(true);
      setError("");
      try {
        const resolved = await resolveEns(value);
        const query = new URLSearchParams({ name: resolved.name });
        window.location.href = `/address/${encodeURIComponent(resolved.address)}?${query}`;
      } catch (problem) {
        setError(readableError(problem));
        setSearching(false);
      }
      return;
    }
    setError("請輸入有效的 Email、ENS 或 Ethereum 地址");
  };

  return (
    <form className="mt-8" onSubmit={search}>
      <label className="sr-only" htmlFor="collection-search">
        搜尋 POAP 收藏
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="collection-search"
          className="field min-h-[3.6rem] flex-1"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError("");
          }}
          placeholder="Email、ENS 或 Ethereum 地址"
        />
        <button className="btn-primary min-w-32" type="submit" disabled={searching}>
          {searching ? "查詢中…" : "查看收藏"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-[#ab5e74]">{error}</p>}
    </form>
  );
}
