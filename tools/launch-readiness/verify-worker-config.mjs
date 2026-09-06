#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyMintRelayCoordinatorConfig } from "./worker-config.mjs";

const configPath = resolve(process.argv[2] || "wrangler.pilot.jsonc");
await verifyMintRelayCoordinatorConfig(configPath);
console.log(`Worker configuration verified: ${configPath}`);
