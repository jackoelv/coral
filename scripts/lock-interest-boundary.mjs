#!/usr/bin/env node
/**
 * 找出 BSC 主网上，某个北京时间周日 00:00 对应的唯一高度。
 * 高度 N 的区块时间仍是 23:59:xx，N+1 已是 00:00:xx。
 * 没有 RPC_URL 时只说明，不假装已经查到区块。有 DATABASE_URL 时写入 nemo_interest_boundary。
 *
 *   RPC_URL=... node scripts/lock-interest-boundary.mjs
 *   RPC_URL=... DATABASE_URL=... node scripts/lock-interest-boundary.mjs --week 2960
 */
import { createPublicClient, http } from "viem";
import { interestWeek, weekBoundary } from "./lib/interest-week.mjs";

function argWeek() {
  const index = process.argv.indexOf("--week");
  if (index === -1) return null;
  return BigInt(process.argv[index + 1]);
}

if (!process.env.RPC_URL) {
  console.log("未锁定周边界：缺少 RPC_URL。主网周日 00:00（北京时间）的高度 N 需要从区块时间里找。");
  process.exit(0);
}

const client = createPublicClient({ transport: http(process.env.RPC_URL) });
const chainId = await client.getChainId();
if (chainId !== 56) {
  console.log(`链 ${chainId} 不用北京时间周界。只有 BSC 主网（56）锁定高度 N。`);
  process.exit(0);
}

const head = await client.getBlock();
const week = argWeek() ?? interestWeek(head.timestamp);
const boundary = weekBoundary(week);
if (head.timestamp < boundary) {
  console.log(`周 ${week} 的周日 00:00 还没到。边界 unix ${boundary}，当前区块 ${head.number} 时间 ${head.timestamp}。`);
  process.exit(0);
}

let lo = 0n;
let hi = head.number;
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  const block = await client.getBlock({ blockNumber: mid });
  if (block.timestamp < boundary) lo = mid + 1n;
  else hi = mid;
}

const blockN1 = lo;
if (blockN1 === 0n) {
  console.log(`周 ${week} 的边界落在创世块之前，没有高度 N。`);
  process.exit(0);
}
const blockN = blockN1 - 1n;
const [atN, atN1] = await Promise.all([
  client.getBlock({ blockNumber: blockN }),
  client.getBlock({ blockNumber: blockN1 }),
]);
if (!(atN.timestamp < boundary && atN1.timestamp >= boundary)) {
  throw new Error(`高度不唯一：N ${blockN} 时间 ${atN.timestamp}，N+1 ${blockN1} 时间 ${atN1.timestamp}，边界 ${boundary}`);
}

const row = {
  chainId,
  week: week.toString(),
  boundaryUnix: boundary.toString(),
  blockN: blockN.toString(),
  blockNTime: atN.timestamp.toString(),
  blockN1: blockN1.toString(),
  blockN1Time: atN1.timestamp.toString(),
};
console.log(JSON.stringify(row));

if (!process.env.DATABASE_URL) {
  console.log("未写入数据库：缺少 DATABASE_URL。上面这条就是高度 N。");
  process.exit(0);
}

const { default: pg } = await import("pg");
const { ensureSchema, saveInterestBoundary } = await import("./lib/reward-db.mjs");
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
await db.connect();
try {
  await ensureSchema(db);
  await saveInterestBoundary(db, {
    chainId,
    week: row.week,
    boundaryUnix: row.boundaryUnix,
    blockN: row.blockN,
    blockNTime: row.blockNTime,
    blockN1: row.blockN1,
    blockN1Time: row.blockN1Time,
  });
  console.log(`已写入 nemo_interest_boundary 周 ${row.week} 高度 N ${row.blockN}`);
} finally {
  await db.end();
}
