import { createRoot } from "react-dom/client";
import IssuerWalletPanel from "../../src/components/IssuerWalletPanel";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <IssuerWalletPanel
    status="draft"
    event={{
      slug: "platform-operations-okx-bybit-2026-11",
      title: "平台操作課：OKX、Bybit",
      imageUrl: "/artwork.svg",
      chainId: 8453,
      maxSupply: 200,
      tokenId: null,
      contractAddress: null,
    }}
  />,
);
