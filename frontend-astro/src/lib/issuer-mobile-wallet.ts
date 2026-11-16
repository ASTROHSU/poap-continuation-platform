import type { WalletChoice, WalletProvider } from "./issuer-wallet";

// This module is loaded only after a deliberate click. Pairing never signs or sends a transaction.
export interface MobileProvider {
  accounts: string[];
  chainId: number;
  session?: unknown;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MobilePairing {
  connect(): Promise<WalletChoice>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
}

export function mobileProjectId(value: string | undefined): string {
  const id = value?.trim() || "";
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error("手機錢包連線尚未完成設定，請先聯絡管理者。");
  return id;
}

async function initialize(projectId: string, origin: string): Promise<MobileProvider> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  return EthereumProvider.init({
    projectId,
    chains: [8453],
    methods: ["eth_sendTransaction"],
    optionalMethods: [],
    events: ["accountsChanged", "chainChanged"],
    optionalEvents: [],
    rpcMap: { 8453: "https://base-rpc.publicnode.com" },
    showQrModal: false,
    telemetryEnabled: false,
    logger: "silent",
    metadata: {
      name: "底加活動管理",
      description: "連接本人錢包並核對活動發行交易",
      url: origin,
      icons: ["https://poap.blocktrend.today/brand/titsia-app-icon-512.png"],
    },
  });
}

export async function createMobilePairing(
  options: { projectId: string; origin: string; onUri: (uri: string) => void },
  init: typeof initialize = initialize,
): Promise<MobilePairing> {
  const projectId = mobileProjectId(options.projectId);
  const provider = await init(projectId, options.origin);
  let cancelled = false;
  let connecting = false;
  let rejectCancelled: ((error: Error) => void) | undefined;
  const display = (value: unknown) => {
    if (!cancelled && typeof value === "string" && /^wc:[a-z0-9]+@2\?/.test(value))
      options.onUri(value);
  };
  const requireSession = () => {
    if (cancelled || !provider.session) throw new Error("手機錢包已斷線，請重新連接。");
  };
  const wallet: WalletProvider = {
    async request({ method, params }) {
      requireSession();
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [...provider.accounts];
      if (method === "eth_chainId") return `0x${provider.chainId.toString(16)}`;
      if (method !== "eth_sendTransaction") throw new Error("此發行頁未允許這項錢包操作。");
      return provider.request({ method, params: params ? [...params] : undefined });
    },
    on: (event, listener) => {
      provider.on(event, listener);
    },
    removeListener: (event, listener) => {
      provider.removeListener(event, listener);
    },
  };
  async function disconnect() {
    cancelled = true;
    rejectCancelled?.(new Error("已取消手機錢包連線。"));
    provider.removeListener("display_uri", display);
    if (provider.session) await provider.disconnect();
  }
  return {
    async connect() {
      if (cancelled) throw new Error("已取消手機錢包連線。");
      if (connecting) throw new Error("手機錢包正在連線，請勿重複操作。");
      connecting = true;
      provider.on("display_uri", display);
      try {
        if (!provider.session) {
          const cancellation = new Promise<never>((_, reject) => {
            rejectCancelled = reject;
          });
          const approval = provider.connect().then(async () => {
            if (cancelled) {
              if (provider.session) await provider.disconnect();
              throw new Error("已取消手機錢包連線。");
            }
          });
          // New SDK versions cannot abort approval(). Release the UI immediately and
          // separately close any session created by a late approval of this old QR.
          await Promise.race([approval, cancellation]);
        }
        if (cancelled) {
          if (provider.session) await provider.disconnect();
          throw new Error("已取消手機錢包連線。");
        }
        requireSession();
        return {
          id: "rabby-mobile-walletconnect",
          name: "手機 Rabby（WalletConnect）",
          provider: wallet,
        };
      } finally {
        connecting = false;
        rejectCancelled = undefined;
        provider.removeListener("display_uri", display);
      }
    },
    cancel: disconnect,
    disconnect,
  };
}
