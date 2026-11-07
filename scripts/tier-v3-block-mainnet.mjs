#!/usr/bin/env node
/**
 * 把网体切换区块写进 .env.mainnet 的 TEAM_TIER_V3_BLOCK。
 * 只影响该区块之后的新入金。已经记过的网体奖不重算。
 * 默认只打印建议区块。--apply 才写本地配置。
 * 线上定时任务读的是 Vercel Production 的 MAINNET_INDEX_TEAM_TIER_V3_BLOCK，本脚本不写 Vercel。
 * 这次只读 production 库的索引检查点。
 *
 *   npm run tier-v3:mainnet
 *   npm run tier-v3:mainnet -- --block 123456789 --apply
 */
import pg from "pg";
import { getAddress } from "viem";
import { contracts, mainnetClient, readMainnetEnv, redact, saveMainnetEnv, selectedDatabase } from "./lib/mainnet.mjs";
import { chooseSwitchBlock, DEFAULT_LEAD_BLOCKS, parseTierArgs } from "./lib/tier-v3-block.mjs";

async function main() {
  const args = parseTierArgs(process.argv.slice(2));
  const env = readMainnetEnv();
  const db = selectedDatabase(env, process.argv);
  if (db.name !== "production") throw new Error("切换区块只对正式库 production 设置。不要用 --db preview。");
  console.log(`这次用的是 production 库 ${db.target.host}/${db.target.database}。`);
  const client = await mainnetClient(env);
  const ido = getAddress(contracts(env).IDO);
  const head = await client.getBlockNumber();
  const database = new pg.Client({
    connectionString: db.url,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await database.connect();
  let indexed = null;
  try {
    const { rows } = await database.query(
      `SELECT last_block FROM coral_indexer_state WHERE chain_id = $1 AND ido_address = $2`,
      [56, ido],
    );
    indexed = rows[0] ? BigInt(rows[0].last_block) : null;
  } finally {
    await database.end();
  }
  const existing = (env.TEAM_TIER_V3_BLOCK || "").trim();
  console.log(JSON.stringify({
    head: head.toString(),
    indexed: indexed == null ? null : indexed.toString(),
    current: existing || null,
    lead: DEFAULT_LEAD_BLOCKS.toString(),
    requested: args.block == null ? null : args.block.toString(),
    apply: args.apply,
  }));
  if (existing && existing !== "0" && args.block == null) {
    const current = BigInt(existing);
    if (current <= head || (indexed != null && current <= indexed)) {
      throw new Error(`TEAM_TIER_V3_BLOCK=${current} 已经到达。改这个数字不会重算已经记过的入金。`);
    }
    console.log(`TEAM_TIER_V3_BLOCK 已经是 ${current}，还没到。要改的话加上 --block。`);
    console.log(`Vercel Production 的 MAINNET_INDEX_TEAM_TIER_V3_BLOCK 也要是 ${current}，并且定时任务代码已经部署。`);
    return;
  }
  const target = chooseSwitchBlock({ head, indexed, requested: args.block });
  console.log(`建议切换区块 ${target}。该区块之后的新入金才用新档位。定时任务每 10 分钟最多向前扫 2000 个区块。`);
  console.log("同一个数字还要写到 Vercel Production 的 MAINNET_INDEX_TEAM_TIER_V3_BLOCK。只改本地文件时，线上定时任务仍按旧档位写正式库。");
  if (!args.apply) {
    console.log(`这是预览。确认后：npm run tier-v3:mainnet -- --block ${target} --apply`);
    return;
  }
  saveMainnetEnv({ TEAM_TIER_V3_BLOCK: target.toString() });
  console.log(`已写入 TEAM_TIER_V3_BLOCK=${target}。`);
  console.log(`接着在 Vercel Production 设置 MAINNET_INDEX_TEAM_TIER_V3_BLOCK=${target}。在索引扫过 ${target} 之前设好。`);
}

let envForErrors = {};
try {
  envForErrors = readMainnetEnv({ allowMissingFixed: true });
} catch {
  envForErrors = {};
}

main().catch((error) => {
  console.error(redact(error?.shortMessage || error?.stack || error?.message || error, envForErrors));
  process.exit(1);
});
