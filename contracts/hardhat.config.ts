import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      chainId: 84532,
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      accounts: [configVariable("BASE_SEPOLIA_PRIVATE_KEY")],
    },
  },
});
