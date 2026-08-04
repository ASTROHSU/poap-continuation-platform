import { useEffect, useState } from "react";
import { ApiError, resolveAddressName } from "../api";
import { ErrorState } from "../components/States";
import { Link, navigate } from "../router";
import type { ArchiveMeta } from "../types";
import { isAbortError } from "../utils";
import { OwnerPage } from "./OwnerPage";
import { LiveOwnerPage } from "./LiveOwnerPage";

const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;

export function AddressRoutePage({
  identifier,
  pathname,
  meta,
  archiveEnabled = true,
}: {
  identifier: string;
  pathname: string;
  meta: ArchiveMeta | null;
  archiveEnabled?: boolean;
}) {
  const address = identifier.toLowerCase();
  if (ADDRESS_PATTERN.test(address)) {
    return (
      <CanonicalOwnerPage
        address={address}
        requestedPathname={pathname}
        meta={meta}
        archiveEnabled={archiveEnabled}
      />
    );
  }

  if (!archiveEnabled) return <InvalidAddressIdentifier liveOnly />;

  const looksLikeEns =
    identifier.length <= 255 && identifier.includes(".") && !/[\/\\?#\s]/u.test(identifier);
  if (!looksLikeEns) return <InvalidAddressIdentifier />;

  return <EnsAddressResolver name={identifier} />;
}

function CanonicalOwnerPage({
  address,
  requestedPathname,
  meta,
  archiveEnabled,
}: {
  address: string;
  requestedPathname: string;
  meta: ArchiveMeta | null;
  archiveEnabled: boolean;
}) {
  useEffect(() => {
    if (requestedPathname !== `/address/${address}`) {
      navigate(`/address/${address}`, { replace: true });
    }
  }, [address, requestedPathname]);

  return archiveEnabled ? (
    <OwnerPage address={address} meta={meta} />
  ) : (
    <LiveOwnerPage address={address} />
  );
}

function EnsAddressResolver({ name }: { name: string }) {
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    document.title = `${name} · POAP Archive`;

    resolveAddressName(name, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const address = response.address.toLowerCase();
        if (!ADDRESS_PATTERN.test(address)) {
          setError("The ENS response did not contain a valid Ethereum address.");
          return;
        }
        navigate(`/address/${address}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setError("No Ethereum address was found for this ENS name.");
        } else if (cause instanceof ApiError && cause.status === 400) {
          setError("This is not a valid ENS name.");
        } else if (cause instanceof ApiError && cause.status === 429) {
          setError("ENS lookup is busy right now. Please try again in a moment.");
        } else {
          setError("ENS lookup is temporarily unavailable. A complete 0x address still works.");
        }
      });

    return () => controller.abort();
  }, [name, retry]);

  return (
    <main className="owner-page owner-resolver shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/">
        ← Back to the homepage
      </Link>
      <section className="owner-resolver__panel glass-panel">
        <span className="eyebrow">Resolving ENS</span>
        <h1>{name}</h1>
        {error ? (
          <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />
        ) : (
          <p role="status" aria-live="polite">
            Finding the Ethereum address, then opening its preserved POAP collection…
          </p>
        )}
      </section>
    </main>
  );
}

function InvalidAddressIdentifier({ liveOnly = false }: { liveOnly?: boolean }) {
  return (
    <main className="owner-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href="/">
        ← Back to the homepage
      </Link>
      <section className="owner-resolver__panel glass-panel">
        <span className="eyebrow">Address lookup</span>
        <h1>That address is not valid</h1>
        <p>
          {liveOnly
            ? "請輸入包含 40 個十六進位字元的完整 0x 錢包地址。"
            : "Use a complete 0x address or an ENS name such as poap.eth."}
        </p>
      </section>
    </main>
  );
}
