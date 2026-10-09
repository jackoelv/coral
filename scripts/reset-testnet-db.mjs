#!/usr/bin/env node
/**
 * 清空测试库里会和重新部署的金库对不上的数据。
 * 只连接主机名包含 ep-empty-king 的库。正式库直接拒绝。
 * 先打印完整数据库连接。默认只打印行数。--apply 才删除。
 *
 *   node scripts/reset-testnet-db.mjs
 *   node scripts/reset-testnet-db.mjs --apply
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import {
  assertSafeReset,
  CHAIN_INDEX_TABLES,
  SITE_RESET_TABLES,
  TESTNET_CHAIN_ID,
} from "./lib/testnet-ops.mjs";

const ENV_FILE = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);

function readEnv(file) {
  const text = readFileSync(file, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    env[line.slice(0, index)] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return env;
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法表名 ${name}`);
  return `"${name}"`;
}

async function tableExists(client, name) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return Boolean(rows[0]?.reg);
}

async function countTable(client, name) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(name)}`);
  return rows[0].n;
}

export async function resetTestnetDb(client, { chainId, apply }) {
  const counts = [];
  await client.query("BEGIN");
  try {
    const siteTables = [];
    for (const name of SITE_RESET_TABLES) {
      if (!(await tableExists(client, name))) {
        counts.push({ table: name, rows: 0, missing: true });
        continue;
      }
      siteTables.push(name);
      counts.push({ table: name, rows: await countTable(client, name) });
    }
    if (await tableExists(client, "VerificationCode")) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM "VerificationCode" WHERE "nomadUserId" IS NOT NULL`,
      );
      counts.push({ table: "VerificationCode.nomadUserId", rows: rows[0].n });
    }
    if (apply && siteTables.length > 0) {
      if (await tableExists(client, "VerificationCode")) {
        await client.query(`DELETE FROM "VerificationCode" WHERE "nomadUserId" IS NOT NULL`);
      }
      for (const name of siteTables) {
        if (name === "nomad_users") {
          await client.query(`UPDATE nomad_users SET "referrerId" = NULL`);
        }
        await client.query(`DELETE FROM ${quoteIdent(name)}`);
      }
      if (await tableExists(client, "activity_tasks")) {
        await client.query(`UPDATE activity_tasks SET "claimedCount" = 0`);
      }
    }

    for (const table of CHAIN_INDEX_TABLES) {
      if (!(await tableExists(client, table.name))) {
        counts.push({ table: table.name, rows: 0, missing: true });
        continue;
      }
      const where = `${table.chainColumn} = $1`;
      if (apply) {
        const deleted = await client.query(`DELETE FROM ${quoteIdent(table.name)} WHERE ${where}`, [chainId]);
        counts.push({ table: table.name, rows: deleted.rowCount });
      } else {
        const selected = await client.query(
          `SELECT count(*)::int AS n FROM ${quoteIdent(table.name)} WHERE ${where}`,
          [chainId],
        );
        counts.push({ table: table.name, rows: selected.rows[0].n });
      }
    }

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return counts;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const env = readEnv(ENV_FILE);
  const databaseUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  const target = assertSafeReset({
    databaseUrl,
    chainId: TESTNET_CHAIN_ID,
    idoAddress: env.BSC_TESTNET_IDO,
  });
  const indexerIdo = env.IDO_ADDRESS ? getAddress(env.IDO_ADDRESS) : "";
  console.log(`数据库连接: ${target.connection}`);
  console.log(
    JSON.stringify({
      apply,
      user: target.user,
      host: target.host,
      database: target.database,
      chainId: TESTNET_CHAIN_ID,
      ido: target.ido,
      indexerIdo: indexerIdo || null,
      indexerMatches: !indexerIdo || indexerIdo === target.ido,
    }),
  );
  if (indexerIdo && indexerIdo !== target.ido) {
    console.log("IDO_ADDRESS 与 BSC_TESTNET_IDO 不一致。索引行会按链 97 全部清掉，不限金库地址。");
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const identity = await client.query(`SELECT current_user AS "user", current_database() AS database`);
    console.log(`已连上: user=${identity.rows[0].user} database=${identity.rows[0].database} host=${target.host}`);
    const counts = await resetTestnetDb(client, { chainId: TESTNET_CHAIN_ID, apply });
    for (const row of counts) {
      console.log(`${row.table} ${row.missing ? "不存在" : apply ? "已删除" : "将删除"} ${row.rows}`);
    }
    if (!apply) console.log("dry-run。核对上面的数据库连接后，加 --apply 才会删除。");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
