#!/usr/bin/env node
/**
 * 实时把网体业绩写入 Postgres，不写进合约。
 * 1. 保持主合约金库目前的简单设计。
 * 2. 直推的奖励在合约上面用户可以直接提现。
 * 3. 网体的奖励由管理员每过 24 小时统一计算，手动或自动跑脚本发放一次并更新 root。
 *    网体业绩不做实时提现，但要实时计算并写入数据库，不写进合约。只有用户提现时才更新到合约。
 *
 *   DATABASE_URL=postgres://... IDO_ADDRESS=0x... RPC_URL=... \
 *     node scripts/index-rewards.mjs
 *   ... node scripts/index-rewards.mjs --follow
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { accountRows, applyLog, formatIndexProgress, isArchiveLogRpc, isGetLogsLimit, isLogRpcTimeout, logQueryWindows, logRpcCandidates, logRpcFailure, planChunk, rpcErrorText, rpcLabel, sortLogs } from "./lib/reward-index.mjs";
import {
  ensureSchema,
  loadAccounts,
  loadCheckpoint,
  lockName,
  saveIndex,
  stateFromRows,
  tryLock,
  unlock,
} from "./lib/reward-db.mjs";

const IDO_EVENTS = [
  parseAbiItem("event Registered(address indexed account, bytes32 indexed code, address indexed referrer)"),
  parseAbiItem("event ReferrerBound(address indexed account, address indexed referrer)"),
  parseAbiItem("event UserImported(address indexed account, bytes32 indexed code)"),
  parseAbiItem("event ReferrerImported(address indexed account, address indexed referrer)"),
  parseAbiItem("event VolumeImported(address indexed account, uint256 selfVolume)"),
  parseAbiItem("event Contributed(address indexed account, uint256 amount, uint256 selfVolume, uint256 nemoAmount)"),
];
const REWARD_EVENTS = [
  parseAbiItem("event TeamClaimed(address indexed account, uint256 cumulative, uint256 paid)"),
];

function missingEnv() {
  const need = ["DATABASE_URL", "IDO_ADDRESS", "RPC_URL"].filter((name) => !process.env[name]);
  if (need.length === 0) return null;
  console.log(`索引未运行：缺少 ${need.join(", ")}。`);
  console.log("设置后再执行：node scripts/index-rewards.mjs");
  return need;
}

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

const logClients = new Map();
const logChainIds = new Map();
const skippedLogRpc = new Set();
let preferredLogRpc = null;

function clientForUrl(url) {
  if (!logClients.has(url)) logClients.set(url, createPublicClient({ transport: http(url, { retryCount: 0, timeout: 30_000 }) }));
  return logClients.get(url);
}

async function clientOnChain(url, chainId) {
  const client = clientForUrl(url);
  if (!logChainIds.has(url)) {
    try {
      logChainIds.set(url, await client.getChainId());
    } catch {
      logChainIds.set(url, null);
      if (!skippedLogRpc.has(url)) {
        console.error(`[index-mainnet] 节点失败 ${rpcLabel(url)}：确认链号失败。将尝试下一个节点。`);
        skippedLogRpc.add(url);
      }
      if (url === preferredLogRpc) preferredLogRpc = null;
    }
  }
  return logChainIds.get(url) === chainId ? client : null;
}

async function getLogsAdaptive(chainId, address, event, fromBlock, toBlock, depth = 0) {
  const windows = depth === 0 ? logQueryWindows(chainId, fromBlock, toBlock) : [{ from: fromBlock, to: toBlock }];
  if (windows.length > 1) {
    const logs = [];
    for (const window of windows) logs.push(...(await getLogsAdaptive(chainId, address, event, window.from, window.to, depth + 1)));
    return logs;
  }
  const urls = preferredLogRpc
    ? [preferredLogRpc, ...logRpcCandidates(chainId, process.env.RPC_URL).filter((url) => url !== preferredLogRpc)]
    : logRpcCandidates(chainId, process.env.RPC_URL);
  let sawLimit = false;
  let last = null;
  for (const url of urls) {
    const client = await clientOnChain(url, chainId);
    if (!client) continue;
    try {
      const logs = await client.getLogs({ address, event, fromBlock, toBlock });
      if (url !== preferredLogRpc) {
        if (url !== process.env.RPC_URL) console.warn(`[index-mainnet] eth_getLogs 改用备用节点 ${rpcLabel(url)}。`);
        preferredLogRpc = url;
      }
      return logs;
    } catch (error) {
      last = error;
      if (url === preferredLogRpc) preferredLogRpc = null;
      logRpcFailure("[index-mainnet]", url, error);
      if (isArchiveLogRpc(error) || isLogRpcTimeout(error)) {
        skippedLogRpc.add(url);
        continue;
      }
      if (isGetLogsLimit(error)) sawLimit = true;
    }
  }
  if (sawLimit && toBlock > fromBlock && depth < 24) {
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    return [
      ...(await getLogsAdaptive(chainId, address, event, fromBlock, mid, depth + 1)),
      ...(await getLogsAdaptive(chainId, address, event, mid + 1n, toBlock, depth + 1)),
    ];
  }
  const detail = last ? rpcErrorText(last) : "没有可用节点";
  if (last && isArchiveLogRpc(last) && !sawLimit) {
    throw new Error(`获取失败：没有节点能查询 chain ${chainId} 区块 ${fromBlock}-${toBlock} 的历史日志。${detail}`);
  }
  throw new Error(`获取失败：没有 chain ${chainId} 的 RPC 能完成 eth_getLogs ${fromBlock}-${toBlock}。${detail}`);
}

async function pullLogs(chainId, address, events, fromBlock, toBlock) {
  const out = [];
  for (const event of events) {
    const logs = await getLogsAdaptive(chainId, address, event, fromBlock, toBlock);
    for (const log of logs) {
      out.push({
        eventName: log.eventName,
        args: log.args,
        blockNumber: Number(log.blockNumber),
        logIndex: log.logIndex,
      });
    }
  }
  return out;
}

async function readHead(primary) {
  const expected = Number(process.env.CHAIN_ID || 56);
  const errors = [];
  for (const url of logRpcCandidates(expected, primary)) {
    try {
      const client = clientForUrl(url);
      const chainId = await client.getChainId();
      if (chainId !== expected) {
        const error = new Error(`链号是 ${chainId}，不是 ${expected}`);
        logRpcFailure("[index-mainnet]", url, error);
        errors.push(`${rpcLabel(url)}：${error.message}`);
        continue;
      }
      const head = await client.getBlockNumber();
      return { client, chainId, head, url };
    } catch (error) {
      logRpcFailure("[index-mainnet]", url, error);
      errors.push(`${rpcLabel(url)}：${rpcErrorText(error)}`);
    }
  }
  throw new Error(`获取失败：读取链头失败。${errors.join("；")}`);
}

async function indexOnce(client) {
  const headRead = await readHead(process.env.RPC_URL);
  const { chainId, head } = headRead;
  const ido = getAddress(process.env.IDO_ADDRESS);
  const rewards = process.env.REWARDS_ADDRESS ? getAddress(process.env.REWARDS_ADDRESS) : null;
  const confirmations = Number(process.env.CONFIRMATIONS ?? (chainId === 31337 ? 0 : 15));
  const safeHead = head - BigInt(confirmations);
  if (safeHead < 0n) return { indexed: 0, lastBlock: 0 };

  const name = lockName(chainId, ido);
  if (!(await tryLock(client, name))) {
    console.log(`chain ${chainId} 已有索引或发布进程在跑，本次跳过。`);
    return { indexed: 0, lastBlock: 0 };
  }
  try {
    await ensureSchema(client);
    const checkpoint = await loadCheckpoint(client, chainId, ido);
    const startBlock = BigInt(process.env.START_BLOCK ?? 0);
    const chunkBlocks = BigInt(process.env.CHUNK_BLOCKS ?? 2000);
    let last = checkpoint ? BigInt(checkpoint.last_block) : null;
    if (!planChunk({ lastBlock: last, startBlock, safeHead, chunkBlocks })) {
      console.log(`chain ${chainId} caught up at block ${checkpoint?.last_block ?? startBlock}`);
      return { indexed: 0, lastBlock: Number(checkpoint?.last_block ?? startBlock) };
    }

    const stored = await loadAccounts(client, chainId, ido);
    const state = stateFromRows(stored);
    state.tierSwitchBlock = process.env.TEAM_TIER_SWITCH_BLOCK || "";
    const origin = planChunk({ lastBlock: last, startBlock, safeHead, chunkBlocks }).from;
    const startedAt = Date.now();
    console.log(
      `chain ${chainId} 从区块 ${origin} 扫到 ${safeHead}，共 ${safeHead - origin + 1n} 个区块，每段 ${chunkBlocks}`,
    );
    let count = 0;
    for (;;) {
      const range = planChunk({ lastBlock: last, startBlock, safeHead, chunkBlocks });
      if (!range) break;
      console.log(`扫描 ${range.from}-${range.end}`);
      const logs = sortLogs([
        ...(await pullLogs(chainId, ido, IDO_EVENTS, range.from, range.end)),
        ...(rewards ? await pullLogs(chainId, rewards, REWARD_EVENTS, range.from, range.end) : []),
      ]);
      for (const log of logs) applyLog(state, log);
      const saved = await saveIndex(client, {
        chainId,
        idoAddress: ido,
        rewardsAddress: rewards,
        lastBlock: Number(range.end),
        rows: accountRows(state),
      });
      if (!saved) {
        console.log(`检查点已超过 ${range.end}，本轮停止，避免用旧账本覆盖。`);
        break;
      }
      count += logs.length;
      last = range.end;
      console.log(
        formatIndexProgress({
          origin,
          safeHead,
          doneBlock: last,
          chunkLogs: logs.length,
          totalLogs: count,
          startedAt,
          now: Date.now(),
        }),
      );
    }
    console.log(`chain ${chainId} indexed ${count} logs through block ${last}`);
    return { indexed: count, lastBlock: Number(last) };
  } finally {
    await unlock(client, name);
  }
}

const absent = missingEnv();
if (absent) process.exit(0);

const follow = process.argv.includes("--follow");
const intervalMs = Number(process.env.INTERVAL_MS || 15_000);
const client = await connect();
try {
  do {
    await indexOnce(client);
    if (follow) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (follow);
} finally {
  await client.end();
}
