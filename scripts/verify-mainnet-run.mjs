#!/usr/bin/env node
/**
 * Wraps scripts/verify-mainnet.mjs for .env.mainnet. Read-only.
 * --stage deployed: expected owner is the deployer (before handover).
 * --stage ready: expected owner is MAINNET_OWNER, plus publisher, limits and totalImported.
 * Output is saved under mainnet-run/evidence/.
 *
 *   npm run verify:mainnet -- --stage deployed
 *   npm run verify:mainnet -- --stage ready
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { CONTRACT_KEYS, ROOT, cleanEnv, need, positiveWei, readMainnetEnv, roles, runPath, stamp } from "./lib/mainnet.mjs";

const args = process.argv.slice(2);
const stage = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : "deployed";
if (!["deployed", "ready"].includes(stage)) throw new Error("--stage 只能是 deployed 或 ready");
const env = readMainnetEnv();
const keys = ["NETWORK", "CHAIN_ID", "BSC_MAINNET_RPC", "BSC_MAINNET_USDT", "NFT_IMAGE_URI", ...CONTRACT_KEYS.map((k) => `BSC_MAINNET_${k}`)];
const out = Object.fromEntries(keys.map((k) => [k, need(env, k)]));

if (stage === "deployed") {
  out.EXPECTED_OWNER = roles(env).deployer;
} else {
  const { owner, publisher } = roles(env, { requirePublisher: true });
  out.EXPECTED_OWNER = owner;
  out.EXPECTED_PUBLISHER = publisher;
  out.EXPECTED_MAX_ROOT_INCREASE_WEI = positiveWei(env, "MAX_ROOT_INCREASE_WEI").toString();
  out.EXPECTED_HISTORICAL_TEAM_BUDGET_WEI = positiveWei(env, "HISTORICAL_TEAM_BUDGET_WEI", { allowZero: true }).toString();
  const importFile = runPath("import-data.json");
  if (!existsSync(importFile)) throw new Error("没有 mainnet-run/import-data.json，无法核对 totalImported");
  const data = JSON.parse(readFileSync(importFile, "utf8"));
  out.EXPECTED_TOTAL_IMPORTED_WEI = data.records.reduce((sum, r) => sum + BigInt(r.selfWei || 0), 0n).toString();
}
getAddress(out.EXPECTED_OWNER);

const temp = runPath("evidence", `.verify-${stage}-${process.pid}.env`);
writeFileSync(temp, Object.entries(out).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
try {
  const broadcast = resolve(ROOT, "broadcast/Deploy.s.sol/56/run-latest.json");
  const argv = [resolve(ROOT, "scripts/verify-mainnet.mjs"), "--env", temp, "--stage", stage];
  if (existsSync(broadcast)) argv.push("--broadcast", broadcast);
  const result = spawnSync(process.execPath, argv, { cwd: ROOT, env: cleanEnv({}), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const text = `${result.stdout || ""}`;
  const file = runPath("evidence", `verify-${stage}-${stamp()}.json`);
  writeFileSync(file, text, { mode: 0o600 });
  process.stdout.write(text);
  if (result.stderr) process.stderr.write(result.stderr.split(need(env, "BSC_MAINNET_RPC")).join("[BSC_MAINNET_RPC]"));
  console.log(`证据 ${file}`);
  if (result.status !== 0) {
    console.error("验收没有通过，不要往下走。");
    process.exit(result.status || 1);
  }
} finally {
  rmSync(temp, { force: true });
}
