#!/usr/bin/env node
/**
 * Runs scripts/settle-imported.mjs --network mainnet with .env.mainnet and mainnet-run/ files.
 * Ledger: mainnet-run/import-interest-backfill.json. Do not delete it.
 * Only before handover: the deployer must still own the vault and CKEY.
 *
 *   npm run settle:mainnet
 *   npm run settle:mainnet -- --apply
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUN_DIR, ROOT, cleanEnv, contracts, deployerAccount, mainnetClient, need, readMainnetEnv, runPath, selectedDatabase } from "./lib/mainnet.mjs";

const env = readMainnetEnv();
await mainnetClient(env);
const a = contracts(env);
deployerAccount(env);
const input = runPath("import-data.json");
if (!existsSync(input)) throw new Error("没有 mainnet-run/import-data.json");
const prod = selectedDatabase(env, []);

const scoped = runPath(`.settle-${process.pid}.env`);
writeFileSync(scoped, [
  `BSC_MAINNET_RPC=${JSON.stringify(need(env, "BSC_MAINNET_RPC"))}`,
  `BSC_MAINNET_IDO=${JSON.stringify(a.IDO)}`,
  `BSC_MAINNET_CKEY=${JSON.stringify(a.CKEY)}`,
  `MAINNET_PRIVATE_KEY=${JSON.stringify(need(env, "MAINNET_PRIVATE_KEY"))}`,
].join("\n") + "\n", { mode: 0o600 });
const prodFile = runPath(`.settle-prod-${process.pid}.env`);
writeFileSync(prodFile, `DATABASE_URL=${JSON.stringify(prod.url)}\n`, { mode: 0o600 });
try {
  const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/settle-imported.mjs"), "--network", "mainnet", "--in", input, ...process.argv.slice(2)], {
    cwd: RUN_DIR,
    env: cleanEnv({ NEMO_ENV_FILE: scoped, PROD_ENV_FILE: prodFile }),
    stdio: "inherit",
  });
  if (result.status === 0) console.log(`账本 ${runPath("import-interest-backfill.json")}，不要删除。`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scoped, { force: true });
  rmSync(prodFile, { force: true });
}
