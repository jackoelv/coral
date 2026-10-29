#!/usr/bin/env node
/**
 * Snapshots every CKEY holder from BSC mainnet into ckey-snapshots/.
 * The sqlite file stores balances and the last scanned block. Later runs read
 * only Transfer logs after that block. Each run still writes a full Excel file
 * of addresses with a positive balance, named with the local date and time.
 *
 *   npm run ckey:snapshot
 *
 * Reads .env.mainnet only. No private key. Does not write the production database.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress, parseAbi } from "viem";
import {
  applyTransfers,
  captureRows,
  formatCkey,
  holderRows,
  localTimestamp,
  nextRange,
  snapshotFilename,
  sumBalances,
  writeHolderWorkbook,
} from "./lib/ckey-holders.mjs";
import { scanLogs } from "./lib/migration.mjs";
import { ROOT, addressOf, mainnetClient, need, readMainnetEnv } from "./lib/mainnet.mjs";
import { rpcLabel } from "./lib/reward-index.mjs";

const DIR = resolve(ROOT, "ckey-snapshots");
const DB_PATH = resolve(DIR, "ckey-holders.sqlite");
const EVENTS = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const SUPPLY = parseAbi(["function totalSupply() view returns (uint256)"]);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS balances (
  address TEXT PRIMARY KEY,
  balance_wei TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  head_block INTEGER NOT NULL,
  transfer_count INTEGER NOT NULL,
  holder_count INTEGER NOT NULL,
  total_supply_wei TEXT,
  excel_path TEXT,
  status TEXT NOT NULL
);
`;

function indexStartBlock(env) {
  const raw = (env.INDEX_START_BLOCK || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("INDEX_START_BLOCK 必须是大于 0 的区块号");
  return BigInt(raw);
}

function confirmationsOf(env) {
  const raw = need(env, "CONFIRMATIONS");
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("CONFIRMATIONS 必须是正整数");
  return BigInt(raw);
}

function chunkBlocks(env) {
  const raw = (env.CHUNK_BLOCKS || "2000").trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("CHUNK_BLOCKS 必须是正整数");
  return BigInt(raw);
}

function meta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function loadBalances(db) {
  const balances = new Map();
  for (const row of db.prepare("SELECT address, balance_wei FROM balances").all()) {
    balances.set(row.address, BigInt(row.balance_wei));
  }
  return balances;
}

function saveBalances(db, balances, dirty) {
  const upsert = db.prepare(`
    INSERT INTO balances (address, balance_wei) VALUES (?, ?)
    ON CONFLICT(address) DO UPDATE SET balance_wei = excluded.balance_wei
  `);
  for (const address of dirty) upsert.run(address, balances.get(address).toString());
}

function excelPath(dir, date) {
  const name = snapshotFilename(date);
  const path = resolve(dir, name);
  if (!existsSync(path)) return path;
  const stamped = name.replace(/\.xlsx$/, `-${String(date.getMilliseconds()).padStart(3, "0")}.xlsx`);
  return resolve(dir, stamped);
}

async function readSupply(client, token, blockNumber) {
  try {
    return await client.readContract({
      address: token,
      abi: SUPPLY,
      functionName: "totalSupply",
      blockNumber,
    });
  } catch (error) {
    const raw = typeof error.details === "string" ? error.details : String(error.shortMessage || error.message);
    const detail = raw.replace(/https?:\/\/\S+/g, "RPC").slice(0, 180);
    throw new Error(`读不到区块 ${blockNumber} 的 totalSupply（${detail}）。日志节点需要能查这个高度的状态。`);
  }
}

async function scanTransfers(client, token, fromBlock, toBlock, chunk) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    const part = await scanLogs(client, { address: token, events: EVENTS, fromBlock: start, toBlock: end, chunk });
    logs.push(...part);
    console.log(`区块 ${start} - ${end}：本段 ${part.length} 条，累计 ${logs.length} 条`);
  }
  return logs;
}

async function snapshot(db, env) {
  const startedAt = new Date().toISOString();
  const token = addressOf(env, "BSC_MAINNET_CKEY");
  const configuredStart = indexStartBlock(env);
  const confirmations = confirmationsOf(env);
  const chunk = chunkBlocks(env);
  const rpc = need(env, "BSC_MAINNET_RPC");
  const logRpc = (env.BSC_MAINNET_INDEX_RPC || "").trim() || rpc;

  const storedToken = meta(db, "token");
  if (storedToken && getAddress(storedToken) !== token) {
    throw new Error(`ckey-holders.sqlite 里的代币是 ${storedToken}，当前 BSC_MAINNET_CKEY 是 ${token}。换合约请另存一份 sqlite。`);
  }
  const storedStart = meta(db, "start_block");
  if (storedStart && storedStart !== configuredStart.toString()) {
    console.warn(`INDEX_START_BLOCK 是 ${configuredStart}，账本起点是 ${storedStart}，这次仍从账本起点续扫`);
  }
  const startBlock = storedStart ? BigInt(storedStart) : configuredStart;
  const lastRaw = meta(db, "last_block");
  const lastBlock = lastRaw === null ? null : BigInt(lastRaw);

  const client = await mainnetClient(env);
  const logClient = logRpc === rpc ? client : await mainnetClient({ ...env, BSC_MAINNET_RPC: logRpc });
  const head = await client.getBlockNumber();
  if (head < confirmations) throw new Error(`链上头 ${head} 小于确认数 ${confirmations}`);
  const finalized = head - confirmations;
  const range = nextRange({ lastBlock, startBlock, finalized });

  let logs = [];
  if (range.scan) {
    console.log(`扫 CKEY ${token} 区块 ${range.fromBlock} - ${range.toBlock}，节点 ${rpcLabel(logRpc)}，确认高度 ${finalized}，链头 ${head}`);
    logs = await scanTransfers(logClient, token, range.fromBlock, range.toBlock, chunk);
  } else {
    console.log(`已扫到确认高度 ${finalized}，这次不重扫，只导出当前持仓`);
  }

  const balances = loadBalances(db);
  const dirty = applyTransfers(balances, logs.map((log) => ({
    from: log.args.from,
    to: log.args.to,
    value: log.args.value,
  })));
  const supply = await readSupply(logClient, token, range.toBlock);
  const sum = sumBalances(balances);
  if (sum !== supply) {
    throw new Error(`区块 ${range.toBlock} 本地合计 ${formatCkey(sum)} 和 totalSupply ${formatCkey(supply)} 不一致，检查点未前移`);
  }

  const capturedAt = new Date();
  const holders = holderRows(balances);
  const file = excelPath(DIR, capturedAt);
  const partial = `${file}.partial`;
  try {
    await writeHolderWorkbook(partial, holders, captureRows({
      token,
      startBlock: startBlock.toString(),
      fromBlock: range.fromBlock.toString(),
      toBlock: range.toBlock.toString(),
      headBlock: head.toString(),
      confirmations: confirmations.toString(),
      transferCount: String(logs.length),
      holderCount: String(holders.length),
      total: formatCkey(sum),
      totalSupply: supply.toString(),
      capturedAt: localTimestamp(capturedAt),
    }));
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }

  let committed = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = meta(db, "last_block");
    const expected = lastBlock === null ? null : lastBlock.toString();
    if (current !== expected) throw new Error("另一份快照已经写入这个账本，这次没有覆盖。请再跑一次。");
    if (!storedToken) {
      setMeta(db, "token", token);
      setMeta(db, "start_block", startBlock.toString());
    }
    saveBalances(db, balances, dirty);
    if (range.scan) setMeta(db, "last_block", range.toBlock.toString());
    db.prepare(`
      INSERT INTO runs (
        started_at, finished_at, from_block, to_block, head_block,
        transfer_count, holder_count, total_supply_wei, excel_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')
    `).run(
      startedAt,
      new Date().toISOString(),
      Number(range.fromBlock),
      Number(range.toBlock),
      Number(head),
      logs.length,
      holders.length,
      supply.toString(),
      file,
    );
    db.exec("COMMIT");
    committed = true;
  } catch (error) {
    if (!committed) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction is already closed */ }
    }
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, file);
  console.log(`持仓 ${holders.length} 个地址，合计 ${formatCkey(sum)} CKEY，区块 ${range.toBlock}`);
  console.log(file);
}

const env = readMainnetEnv();
mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
try {
  db.exec(SCHEMA);
  await snapshot(db, env);
} finally {
  db.close();
}
