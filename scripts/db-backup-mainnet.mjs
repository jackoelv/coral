#!/usr/bin/env node
/**
 * Full backup of the production FreeDao database before any mainnet schema change.
 * Default prints the target. --apply runs pg_dump --format=custom on the whole database.
 * --restore-check <dump> restores into RESTORE_DATABASE_URL (an empty, separate database)
 * and compares row counts. db-migrate:mainnet requires a passing restore check.
 *
 *   npm run db-backup:mainnet
 *   npm run db-backup:mainnet -- --apply
 *   npm run db-backup:mainnet -- --restore-check /Users/jack/Documents/Sensitive/<file>.dump
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { cleanEnv, need, productionDatabase, PRODUCTION_DB_HOST, readMainnetEnv, sha256File, stamp, TEST_DB_HOST, writeEvidence } from "./lib/mainnet.mjs";
import { databaseTarget } from "./lib/testnet-ops.mjs";

const BACKUP_DIR = "/Users/jack/Documents/Sensitive";
const env = readMainnetEnv();
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];

function split(url) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  return { uri: u.toString(), password };
}

function tool(name) {
  const result = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`本机没有 ${name}。先装：brew install postgresql@17，然后把 $(brew --prefix postgresql@17)/bin 加进 PATH`);
  }
  return Number(result.stdout.match(/(\d+)\.\d+/)?.[1] || 0);
}

async function connect(url) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function rowCounts(client) {
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const counts = {};
  for (const { tablename } of rows) {
    const result = await client.query(`SELECT count(*)::bigint AS n FROM "public"."${tablename.replace(/"/g, '""')}"`);
    counts[tablename] = Number(result.rows[0].n);
  }
  return counts;
}

async function backup(apply) {
  const url = need(env, "DATABASE_URL_UNPOOLED");
  const target = productionDatabase(url);
  productionDatabase(need(env, "DATABASE_URL"));
  if (databaseTarget(need(env, "DATABASE_URL")).database !== target.database) throw new Error("DATABASE_URL 和 DATABASE_URL_UNPOOLED 不是同一个库");
  const client = await connect(url);
  let server;
  let counts;
  try {
    server = (await client.query("SHOW server_version")).rows[0].server_version;
    counts = await rowCounts(client);
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({ host: target.host, database: target.database, user: target.user, server, tables: Object.keys(counts).length, counts, apply }, null, 2));
  if (!apply) {
    console.log(`预览完成。主机含 ${PRODUCTION_DB_HOST}，是正式库。确认后：npm run db-backup:mainnet -- --apply`);
    return;
  }
  const major = tool("pg_dump");
  const serverMajor = Number(server.match(/^(\d+)/)[1]);
  if (major < serverMajor) throw new Error(`pg_dump ${major} 低于服务端 ${serverMajor}，换同版本或更高版本`);
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const file = resolve(BACKUP_DIR, `freedao-production-${target.database}-${stamp()}.dump`);
  const started = new Date().toISOString();
  const { uri, password } = split(url);
  const result = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", file, "--dbname", uri], {
    env: cleanEnv({ PGPASSWORD: password }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`pg_dump 失败\n${(result.stderr || "").split(password).join("[PASSWORD]")}`);
  const record = {
    file,
    bytes: statSync(file).size,
    sha256: sha256File(file),
    started,
    finished: new Date().toISOString(),
    host: target.host,
    database: target.database,
    server,
    pgDumpMajor: major,
    counts,
  };
  writeFileSync(`${file}.json`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(record, null, 2));
  console.log(`证据 ${writeEvidence("db-backup", record)}`);
  console.log("下一步：准备一个独立的空库，把连接串填到 .env.mainnet 的 RESTORE_DATABASE_URL，然后：");
  console.log(`npm run db-backup:mainnet -- --restore-check ${file}`);
}

async function restoreCheck(file) {
  if (!existsSync(file) || !existsSync(`${file}.json`)) throw new Error("找不到备份文件或它的 .json 记录");
  const record = JSON.parse(readFileSync(`${file}.json`, "utf8"));
  if (sha256File(file) !== record.sha256) throw new Error("备份文件 SHA256 和记录不一致");
  const url = need(env, "RESTORE_DATABASE_URL");
  const target = databaseTarget(url);
  if (target.host.includes(PRODUCTION_DB_HOST) || target.host.includes(TEST_DB_HOST)) throw new Error("RESTORE_DATABASE_URL 不能是正式库或测试网库");
  const client = await connect(url);
  try {
    const existing = await rowCounts(client);
    if (Object.keys(existing).length) throw new Error(`恢复目标不是空库：已有 ${Object.keys(existing).length} 张表`);
  } finally {
    await client.end();
  }
  tool("pg_restore");
  const { uri, password } = split(url);
  const result = spawnSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", uri, file], {
    env: cleanEnv({ PGPASSWORD: password }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`pg_restore 失败\n${(result.stderr || "").split(password).join("[PASSWORD]")}`);
  const after = await connect(url);
  let restored;
  try {
    restored = await rowCounts(after);
  } finally {
    await after.end();
  }
  const diff = Object.keys({ ...record.counts, ...restored }).filter((t) => record.counts[t] !== restored[t]);
  const out = { file, sha256: record.sha256, restoreHost: target.host, restoreDatabase: target.database, tables: Object.keys(restored).length, diff, ok: diff.length === 0, checkedAt: new Date().toISOString() };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) throw new Error(`行数不一致：${diff.join(", ")}`);
  writeFileSync(`${file}.restore-ok.json`, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  console.log(`证据 ${writeEvidence("db-restore-check", out)}`);
  console.log("恢复核对通过。再用旧 life 和新候选各登录一次、查一个账户。然后：");
  console.log(`npm run db-migrate:mainnet -- --backup ${file}`);
}

if (args.includes("--restore-check")) await restoreCheck(resolve(value("--restore-check")));
else await backup(args.includes("--apply"));
