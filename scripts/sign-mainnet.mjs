#!/usr/bin/env node
/**
 * Local sign page for a plan in mainnet-run/plans/.
 * imToken on the phone signs through WalletConnect. A browser extension still works.
 * The page listens on 127.0.0.1 only and never accepts hand-typed calldata.
 * Plans with chainId 97 (testnet rehearsal) use .env; chainId 56 uses .env.mainnet.
 * publishRoot plans are resumed with `publish:mainnet -- --resume`, which also activates the root.
 *
 *   npm run sign:mainnet -- mainnet-run/plans/<plan>.json
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { getAddress } from "viem";
import { ROOT, contracts, need, oldContracts, readMainnetEnv } from "./lib/mainnet.mjs";
import { readPlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";

const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!file) throw new Error("用法：npm run sign:mainnet -- mainnet-run/plans/<计划>.json");
const path = resolve(file);
const plan = readPlan(path);
if (plan.meta?.kind === "publishRoot") throw new Error("这是发布 root 的计划，用 npm run publish:mainnet -- --resume <计划> 继续，签完才会把 root 标为生效");

let rpc;
let allowed;
let walletConnectProjectId = "";
if (plan.chainId === 56) {
  const env = readMainnetEnv();
  rpc = need(env, "BSC_MAINNET_RPC");
  if (plan.meta?.kind === "retireOld") {
    const old = oldContracts(env);
    allowed = [old.IDO, old.CKEY];
  } else {
    allowed = Object.values(contracts(env));
  }
  walletConnectProjectId = env.WALLETCONNECT_PROJECT_ID || "";
} else if (plan.chainId === 97) {
  const env = parseEnv(readFileSync(resolve(ROOT, ".env"), "utf8"));
  rpc = env.BSC_TESTNET_RPC;
  allowed = ["CKEY", "NFT", "IDO", "REWARDS", "INTEREST"].map((k) => env[`BSC_TESTNET_${k}`]).filter(Boolean).map((x) => getAddress(x));
  walletConnectProjectId = env.WALLETCONNECT_PROJECT_ID || "";
} else {
  throw new Error(`不支持 chainId ${plan.chainId}`);
}
const port = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 8756;
await servePlan(path, { rpc, allowed, port, walletConnectProjectId });
console.log("计划里的交易都已成功。");
