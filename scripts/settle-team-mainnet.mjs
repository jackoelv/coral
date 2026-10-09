#!/usr/bin/env node
/**
 * Runs scripts/settle-historical-team.mjs on mainnet-run/import-data.json.
 * Output goes to mainnet-run/historical-team-rewards.json. --apply writes the database only, no transactions.
 *
 *   npm run settle-team:mainnet
 *   npm run settle-team:mainnet -- --apply
 *   npm run settle-team:mainnet -- --apply --db preview
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUN_DIR, ROOT, cleanEnv, contracts, readMainnetEnv, runPath, selectedDatabase } from "./lib/mainnet.mjs";

const env = readMainnetEnv();
const a = contracts(env);
if (!existsSync(runPath("import-data.json"))) throw new Error("没有 mainnet-run/import-data.json，先跑 import:mainnet");
const db = selectedDatabase(env);
const prod = selectedDatabase(env, []);
console.log(`历史网体奖 -> ${db.name} 库 ${db.target.host}/${db.target.database}，金库 ${a.IDO}`);

// settle-historical-team.mjs reads its env from a file. Give it a scoped one, then delete it.
const scoped = runPath(`.settle-team-${process.pid}.env`);
writeFileSync(scoped, [`DATABASE_URL=${JSON.stringify(db.url)}`, `CHAIN_ID="56"`, `IDO_ADDRESS=${JSON.stringify(a.IDO)}`].join("\n") + "\n", { mode: 0o600 });
const prodFile = runPath(`.settle-team-prod-${process.pid}.env`);
writeFileSync(prodFile, `DATABASE_URL=${JSON.stringify(prod.url)}\n`, { mode: 0o600 });
try {
  const passthrough = process.argv.slice(2).filter((arg, i, all) => arg !== "--db" && all[i - 1] !== "--db");
  const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/settle-historical-team.mjs"), ...passthrough], {
    cwd: RUN_DIR,
    env: cleanEnv({ NEMO_ENV_FILE: scoped, PROD_ENV_FILE: prodFile }),
    stdio: "inherit",
  });
  if (result.status === 0) {
    console.log(`明细在 ${runPath("historical-team-rewards.json")}。`);
    console.log("打印的合计能被导入额的 25% 覆盖时 HISTORICAL_TEAM_BUDGET_WEI 填 0，不够时填差额（wei），不要重复计提。");
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scoped, { force: true });
  rmSync(prodFile, { force: true });
}
