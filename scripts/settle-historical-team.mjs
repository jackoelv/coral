#!/usr/bin/env node
/**
 * 按确认入金的时间顺序，重算历史伞下和历史网体奖。
 * 默认只打印。--apply 把历史网体奖写入索引库，不发送交易，不记直推。
 *
 * 伞下规模由索引在扫到 VolumeImported 时计入。本脚本负责历史网体奖。
 * 发布 root 时，叶子金额 = 开售后新网体奖 + 这里写下的历史网体奖。
 *
 * 当前已部署的测试网奖励合约还没有 historicalTeamBudget。
 * 主网用新合约时，先把额度设成打印出的合计，并把等额 USDT 打进金库，再发布 root。
 *
 * 换合约迁移时加 --paid-offset <文件>：每个地址扣掉旧奖励合约上已经领过的网体奖，只把差额写进索引库。
 *
 *   npm run settle:historical-team
 *   npm run settle:historical-team -- --apply
 *   npm run settle:historical-team -- --paid-offset old-paid.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { formatUnits, getAddress } from "viem";
import { settleHistoricalTeam } from "./lib/historical-team.mjs";
import { applyPaidOffset, readPaidOffset } from "./lib/migration.mjs";
import { ensureSchema } from "./lib/reward-db.mjs";

const OUT = "historical-team-rewards.json";
const PROD_ENV = process.env.PROD_ENV_FILE || "/Users/jack/git/github/FreeDao/.env.production.local";

function readRepoEnv() {
  const file = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);
  return parseEnv(readFileSync(file, "utf8"));
}

function envValue(file, key) {
  const lines = readFileSync(file, "utf8").split("\n").filter((row) => row.startsWith(`${key}=`));
  const line = lines[lines.length - 1];
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

function loadRecords() {
  const file = resolve("import-data.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data.ok || !Array.isArray(data.records)) throw new Error(`${file} 不是一份通过检查的导入文件`);
  return data.records.map((row) => ({
    ...row,
    wallet: getAddress(row.wallet),
    referrer: row.referrer ? getAddress(row.referrer) : null,
  }));
}

async function fillOrders(records) {
  const missing = records.filter((row) => BigInt(row.selfWei || 0) > 0n && (!Array.isArray(row.orders) || row.orders.length === 0));
  if (missing.length === 0) return;
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: envValue(PROD_ENV, "DATABASE_URL"),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const orders = await client.query(`
      SELECT u."walletAddress" AS wallet, o."amountUsdt" AS amount_usdt,
             COALESCE(o."confirmedAt", o."createdAt") AS confirmed_at
      FROM nomad_contribution_orders o
      JOIN nomad_users u ON u.id = o."userId"
      WHERE o.status = 'confirmed'
      ORDER BY COALESCE(o."confirmedAt", o."createdAt") ASC
    `);
    const byWallet = new Map();
    for (const row of orders.rows) {
      const wallet = getAddress(row.wallet);
      const list = byWallet.get(wallet) || [];
      list.push({ usdt: Number(row.amount_usdt), confirmedAt: new Date(row.confirmed_at).toISOString() });
      byWallet.set(wallet, list);
    }
    for (const record of missing) {
      record.orders = byWallet.get(getAddress(record.sourceWallet || record.wallet)) || [];
    }
  } finally {
    await client.end();
  }
}

async function writeIndex(env, rows) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await ensureSchema(client);
    const chainId = Number(env.CHAIN_ID);
    const ido = getAddress(env.IDO_ADDRESS);
    for (const row of rows) {
      if (row.teamRewardWei === 0n && !row.offsetWei) continue;
      await client.query(
        `INSERT INTO coral_team_account
           (chain_id, ido_address, wallet, referrer, self_wei, team_wei, team_reward_wei, historical_team_reward_wei, direct_wei, claimed_wei)
         VALUES ($1, $2, $3, NULL, $4, $5, '0', $6, '0', '0')
         ON CONFLICT (chain_id, ido_address, wallet)
         DO UPDATE SET historical_team_reward_wei = EXCLUDED.historical_team_reward_wei,
                       updated_at = now()`,
        [chainId, ido, row.wallet, row.selfWei.toString(), row.teamWei.toString(), row.teamRewardWei.toString()],
      );
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const offsetAt = process.argv.indexOf("--paid-offset");
  const offsetFile = offsetAt === -1 ? null : process.argv[offsetAt + 1];
  if (offsetAt !== -1 && (!offsetFile || offsetFile.startsWith("--"))) throw new Error("--paid-offset 后面要跟文件路径");
  const records = loadRecords();
  await fillOrders(records);
  const settled = settleHistoricalTeam(records);
  const rows = offsetFile ? applyPaidOffset(settled.rows, readPaidOffset(resolve(offsetFile))) : settled.rows;
  const grossWei = settled.teamRewardWei;
  const offsetWei = rows.reduce((sum, row) => sum + (row.offsetWei || 0n), 0n);
  const netWei = rows.reduce((sum, row) => sum + row.teamRewardWei, 0n);
  const payload = {
    generatedAt: new Date().toISOString(),
    paidOffset: offsetFile ? resolve(offsetFile) : null,
    grossTeamRewardWei: grossWei.toString(),
    offsetWei: offsetWei.toString(),
    teamRewardWei: netWei.toString(),
    directExcludedWei: settled.directExcluded.toString(),
    rows: rows.map((row) => ({
      wallet: row.wallet,
      selfWei: row.selfWei.toString(),
      teamWei: row.teamWei.toString(),
      grossWei: (row.grossWei ?? row.teamRewardWei).toString(),
      offsetWei: (row.offsetWei ?? 0n).toString(),
      teamRewardWei: row.teamRewardWei.toString(),
    })),
  };
  writeFileSync(resolve(OUT), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    accounts: rows.length,
    grossHistoricalTeamReward: formatUnits(grossWei, 18),
    paidOnOldContract: formatUnits(offsetWei, 18),
    historicalTeamReward: formatUnits(netWei, 18),
    directExcluded: formatUnits(settled.directExcluded, 18),
    budget: netWei.toString(),
    apply,
  }));
  console.log("直推不进这次清算。历史网体奖按下表。伞下已经包含导入业绩，开售后的新入金按这个规模定档。");
  for (const row of rows) {
    if (row.selfWei === 0n && row.teamRewardWei === 0n && !row.offsetWei) continue;
    const offset = offsetFile ? ` 总额=${formatUnits(row.grossWei, 18)} 旧合约已领=${formatUnits(row.offsetWei, 18)}` : "";
    console.log(`${row.wallet} 本人=${formatUnits(row.selfWei, 18)} 伞下=${formatUnits(row.teamWei, 18)}${offset} 历史网体奖=${formatUnits(row.teamRewardWei, 18)}`);
  }
  if (!apply) {
    console.log(`dry-run。明细在 ${OUT}。确认后加 --apply 写入索引库。发布 root 前，新奖励合约要把 historicalTeamBudget 设成 ${formatUnits(netWei, 18)} USDT，并先把这笔 USDT 打进金库。`);
    return;
  }
  await writeIndex(readRepoEnv(), rows);
  console.log("历史网体奖已写入索引库。重新跑索引不会把它清掉。");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
