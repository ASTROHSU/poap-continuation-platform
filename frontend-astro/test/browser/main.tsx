import { useState } from "react";
import { createRoot } from "react-dom/client";
import IssuerWalletPanel from "../../src/components/IssuerWalletPanel";
import "./style.css";

const events = [
  { slug: "platform-operations-okx-bybit-2026-11", title: "平台操作課：OKX、Bybit" },
  { slug: "december-book-club-2026", title: "12 月線上讀書會" },
  { slug: "platform-operations-firstrade-etoro-2026-12", title: "平台操作課：Firstrade、eToro" },
].map((event) => ({
  ...event,
  imageUrl: "/artwork.svg",
  chainId: 8453,
  maxSupply: 200,
  tokenId: null,
  contractAddress: null,
}));
function Harness() {
  const [selected, setSelected] = useState(0);
  const [issued, setIssued] = useState<Record<string, boolean>>({});
  const selectedEvent = events[selected];
  const event =
    selectedEvent && issued[selectedEvent.slug]
      ? {
          ...selectedEvent,
          tokenId: String(selected + 11),
          contractAddress: "0x9375b610859b1a5feea3c7c7c45fc20712f506cb",
        }
      : selectedEvent;
  return (
    <>
      <nav>
        {events.map((event, i) => (
          <button key={event.slug} onClick={() => setSelected(i)}>
            選擇 {i + 11}
          </button>
        ))}
        <button onClick={() => setSelected(-1)}>回到列表</button>
      </nav>
      <IssuerWalletPanel
        status="draft"
        event={event ?? null}
        onSynchronize={async (slug) => {
          const target = window as any;
          (target.__syncCalls ??= []).push(slug);
          if (target.__deferSync)
            await new Promise((resolve) => {
              (target.__syncResolvers ??= {})[slug] = resolve;
            });
          setIssued((current) => ({ ...current, [slug]: true }));
          return {
            status: "published",
            transactionHash: `0x${"a".repeat(64)}`,
            claimUrl: `https://example.test/claim/${slug}?code=test-only`,
          };
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
