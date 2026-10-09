#!/usr/bin/env node
/**
 * Adds the coral_* tables to the production database. Additive only: stops if any Coral table exists.
 * Requires a backup that passed `db-backup:mainnet -- --restore-check`.
 *
 *   npm run db-migrate:mainnet -- --backup <dump>
 *   npm run db-migrate:mainnet -- --backup <dump> --apply
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { confirmTyped, need, productionDatabase, readMainnetEnv, sha256File, writeEvidence } from "./lib/mainnet.mjs";

const DEFAULT_SQL = new URL("../mainnet/001-additive-schema.sql", import.meta.url).pathname;
const NEMO_TABLES = ["coral_invite_cache", "coral_indexer_state", "coral_team_account", "coral_team_root", "coral_team_proof", "coral_interest_boundary"];
const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const apply = args.includes("--apply");

const env = readMainnetEnv();
const url = need(env, "DATABASE_URL_UNPOOLED");
const target = productionDatabase(url);
const backup = value("--backup") && resolve(value("--backup"));
if (!backup) throw new Error("用法：npm run db-migrate:mainnet -- --backup <备份 .dump>");
const okFile = `${backup}.restore-ok.json`;
if (!existsSync(backup) || !existsSync(okFile)) throw new Error("这份备份还没通过恢复核对。先跑 db-backup:mainnet -- --restore-check");
const ok = JSON.parse(readFileSync(okFile, "utf8"));
if (!ok.ok || ok.sha256 !== sha256File(backup)) throw new Error("恢复核对记录和备份文件对不上");
const record = JSON.parse(readFileSync(`${backup}.json`, "utf8"));
if (record.host !== target.host || record.database !== target.database) throw new Error("备份来自另一个库");
const ageHours = (Date.now() - Date.parse(record.finished)) / 3_600_000;
if (ageHours > 24) throw new Error(`备份已经 ${ageHours.toFixed(1)} 小时，重新备份再迁移`);

const sqlPath = resolve(value("--sql") || DEFAULT_SQL);
const sql = readFileSync(sqlPath, "utf8");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [NEMO_TABLES]);
  const existing = rows.map((r) => r.table_name);
  console.log(JSON.stringify({ host: target.host, database: target.database, backup, backupSha256: ok.sha256, sql: sqlPath, sqlSha256: sha256File(sqlPath), existingNemoTables: existing, apply }, null, 2));
  if (existing.length) throw new Error(`正式库已有 ${existing.join(", ")}。这是只加表的迁移，先人工核对结构，不要重复执行`);
  if (!apply) {
    console.log("预览完成。确认后加 --apply。");
    process.exit(0);
  }
  await confirmTyped("MIGRATE", `将在正式库 ${target.host}/${target.database} 执行 ${sqlPath}`);
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`迁移失败，已回滚：${error.message}`);
  }
  const after = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [NEMO_TABLES]);
  const created = after.rows.map((r) => r.table_name).sort();
  const result = { host: target.host, database: target.database, created, sqlSha256: sha256File(sqlPath), backupSha256: ok.sha256 };
  console.log(JSON.stringify(result, null, 2));
  console.log(`证据 ${writeEvidence("db-migrate", result)}`);
  console.log("从现在到开售，旧网站不要再确认新订单或改邀请关系。截止时间按北京时间记下来。");
} finally {
  await client.end();
}
