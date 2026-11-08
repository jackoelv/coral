#!/usr/bin/env node
/**
 * Mark one address for the local settlement book.
 * Default is a dry run. --apply writes production unless --db preview is set.
 * A new mark starts at the next block. Clearing a mark that has already reached
 * its block is refused, because this script does not replay history.
 *
 *   node scripts/mark-reward-role.mjs --wallet 0x... --role team_leader
 *   node scripts/mark-reward-role.mjs --wallet 0x... --role big_leader --effective-block 123 --apply
 *
 * team_leader uses the 8/11/14 table and is included in publishRoot.
 * big_leader is an internal mark: 9% of a downline deposit, paid manually, never published.
 *   node scripts/mark-reward-role.mjs --wallet 0x... --clear --apply
 *   npm run role:mark -- --wallet 0x... --role team_leader --db preview --apply
 */
import pg from "pg";
import { getAddress } from "viem";
import { ensureSchema } from "./lib/reward-db.mjs";
import { ROLE_BIG, ROLE_LEADER } from "./lib/team-reward.mjs";
import { contracts, mainnetClient, need, readMainnetEnv, selectedDatabase } from "./lib/mainnet.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith("--")) return "";
  return args[index + 1];
};

const apply = args.includes("--apply");
const clear = args.includes("--clear");
const role = value("--role");
const walletArg = value("--wallet");
const blockArg = value("--effective-block");
const note = value("--note");

if (!walletArg || (clear && role) || (!clear && role !== ROLE_LEADER && role !== ROLE_BIG)) {
  throw new Error("用法: --wallet 0x... --role team_leader|big_leader [--effective-block N] [--note 文字] [--apply]，或 --wallet 0x... --clear [--apply]");
}
if (blockArg && !/^\d+$/.test(blockArg)) throw new Error("--effective-block 必须是区块号");

const env = readMainnetEnv();
const db = selectedDatabase(env, args);
const ido = getAddress(contracts(env).IDO);
const wallet = getAddress(walletArg);
const chain = await mainnetClient(env);
const head = await chain.getBlockNumber();
const effectiveBlock = blockArg ? BigInt(blockArg) : head + 1n;

console.log(`库 ${db.name} ${db.target.host}/${db.target.database}，金库 ${ido}，链头 ${head}。`);

const client = new pg.Client({
  connectionString: db.url,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  await ensureSchema(client);
  const current = await client.query(
    `SELECT role, effective_block FROM coral_reward_role WHERE chain_id = $1 AND ido_address = $2 AND wallet = $3`,
    [56, ido, wallet],
  );
  const existing = current.rows[0] || null;
  if (clear) {
    if (!existing) throw new Error(`${wallet} 没有标记`);
    if (BigInt(existing.effective_block) <= head) {
      throw new Error(`${wallet} 的标记已在区块 ${existing.effective_block} 生效。这次不重算已经记过的入金。`);
    }
    console.log(`将删除 ${wallet} 的 ${existing.role}，生效区块 ${existing.effective_block} 还没到。`);
    if (!apply) {
      console.log("这是预览。加上 --apply 才会写入。");
      process.exit(0);
    }
    await client.query(
      `DELETE FROM coral_reward_role WHERE chain_id = $1 AND ido_address = $2 AND wallet = $3`,
      [56, ido, wallet],
    );
    console.log("已删除。");
    process.exit(0);
  }

  if (existing && BigInt(existing.effective_block) <= head && existing.role !== role && effectiveBlock <= head) {
    throw new Error(`${wallet} 的 ${existing.role} 已生效。把 --effective-block 设到链头 ${head} 之后，只影响之后的入金。`);
  }
  console.log(`${existing ? "将更新" : "将写入"} ${wallet} ${role}，生效区块 ${effectiveBlock}。`);
  if (!apply) {
    console.log("这是预览。加上 --apply 才会写入。");
    process.exit(0);
  }
  await client.query(
    `INSERT INTO coral_reward_role (chain_id, ido_address, wallet, role, effective_block, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain_id, ido_address, wallet)
     DO UPDATE SET role = EXCLUDED.role,
                   effective_block = EXCLUDED.effective_block,
                   note = EXCLUDED.note,
                   updated_at = now()`,
    [56, ido, wallet, role, effectiveBlock.toString(), note],
  );
  console.log("已写入。");
} finally {
  await client.end();
}
