#!/usr/bin/env node
/**
 * Runs scripts/index-rewards.mjs against BSC mainnet with values from .env.mainnet only.
 * Checks RPC chainId 56 and the database host before connecting. No private keys are passed.
 * Only CHUNK_BLOCKS may come from the shell.
 *
 *   CHUNK_BLOCKS=2000 npm run index:mainnet
 *   npm run index:mainnet -- --follow
 *   npm run index:mainnet -- --db preview      index into the preview.freedao.life database
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, cleanEnv, contracts, mainnetClient, need, readMainnetEnv, selectedDatabase } from "./lib/mainnet.mjs";
import { MAINNET_LOG_RPCS, rpcLabel } from "./lib/reward-index.mjs";

const env = readMainnetEnv();
const indexRpc = (env.BSC_MAINNET_INDEX_RPC || "").trim() || need(env, "BSC_MAINNET_RPC");
await mainnetClient({ ...env, BSC_MAINNET_RPC: indexRpc });
const a = contracts(env);
if (need(env, "IDO_ADDRESS").toLowerCase() !== a.IDO.toLowerCase() || need(env, "REWARDS_ADDRESS").toLowerCase() !== a.REWARDS.toLowerCase()) {
  throw new Error("IDO_ADDRESS / REWARDS_ADDRESS 和 BSC_MAINNET_* 不一致");
}
const db = selectedDatabase(env);
console.log(`索引 chain 56 金库 ${a.IDO} -> ${db.name} 库 ${db.target.host}/${db.target.database}，起始区块 ${need(env, "START_BLOCK")}`);
console.log(`索引节点 ${rpcLabel(indexRpc)}，备用 ${MAINNET_LOG_RPCS.map((url) => rpcLabel(url)).join("、")}`);
const child = cleanEnv({
  DATABASE_URL: db.url,
  IDO_ADDRESS: a.IDO,
  REWARDS_ADDRESS: a.REWARDS,
  RPC_URL: indexRpc,
  CHAIN_ID: "56",
  CONFIRMATIONS: need(env, "CONFIRMATIONS"),
  START_BLOCK: need(env, "START_BLOCK"),
  CHUNK_BLOCKS: process.env.CHUNK_BLOCKS || env.CHUNK_BLOCKS || "2000",
  TEAM_TIER_SWITCH_BLOCK: env.TEAM_TIER_SWITCH_BLOCK || "",
});
const passthrough = process.argv.slice(2).filter((arg, i, all) => arg !== "--db" && all[i - 1] !== "--db");
const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/index-rewards.mjs"), ...passthrough], { cwd: ROOT, env: child, stdio: "inherit" });
process.exit(result.status ?? 1);
