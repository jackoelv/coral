#!/usr/bin/env node
/**
 * One-time correction for V3 peer bonuses booked before the volume gate.
 * Dry run prints the delta. --apply writes production team_reward_wei and
 * closes unpublished root plans. It does not publish a root.
 *
 *   node scripts/correct-v3-peer.mjs
 *   node scripts/correct-v3-peer.mjs --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, getAddress, http, parseAbiItem } from "viem";
import { bsc } from "viem/chains";
import { contracts, mainnetClient, need, readMainnetEnv, runPath, selectedDatabase } from "./lib/mainnet.mjs";
import { isGetLogsLimit, rpcLabel } from "./lib/reward-index.mjs";
import { BPS, OVERLAY_BPS, bpsForAccount, bind, contribute, createState, setRole } from "./lib/team-reward.mjs";

const APPLY = process.argv.includes("--apply");
const EXPECTED_COMMITTED = 3329310000000000000000n;
const QIANG = getAddress("0x450fF060Dd6F9Ab91218A505a034a387836E27a5");
const EXPECTED_DELTA = -1200000000000000000n;
const RECEIPT = runPath("v3-peer-correction.json");
const ZERO = "0x0000000000000000000000000000000000000000";
const CONTRIBUTED = parseAbiItem("event Contributed(address indexed account, uint256 amount, uint256 selfVolume, uint256 nemoAmount)");
const ROOT_PUBLISHED = parseAbiItem("event RootPublished(bytes32 indexed root, bytes32 contentHash, uint256 cumulative, string uri)");

function fmt(wei) {
  const v = BigInt(wei);
  const neg = v < 0n;
  const x = neg ? -v : v;
  const whole = x / 10n ** 18n;
  const frac = (x % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function referrerOf(value) {
  if (!value || String(value).toLowerCase() === ZERO) return null;
  return getAddress(value);
}

function snapshotState(source) {
  const next = createState();
  for (const [wallet, referrer] of source.referrer) bind(next, wallet, referrer);
  for (const [wallet, amount] of source.self) next.self.set(wallet, amount);
  for (const [wallet, amount] of source.team) next.team.set(wallet, amount);
  for (const [wallet, role] of source.roles) next.roles.set(wallet, { ...role });
  return next;
}

/** Previous V3 rule: any equal positive rate paid a peer bonus. Used only to measure the booked delta. */
function contributeLegacy(state, account, amount, opts) {
  state.self.set(account, (state.self.get(account) ?? 0n) + amount);
  const ref = state.referrer.get(account) || null;
  if (ref && (state.self.get(ref) ?? 0n) >= 100n * 10n ** 18n) {
    const paid = (amount * opts.directBps) / BPS;
    if (paid > 0n) state.direct.set(ref, (state.direct.get(ref) ?? 0n) + paid);
  }
  let prev = 0n;
  let established = 0n;
  let overlayOpen = false;
  let cursor = ref;
  while (cursor) {
    const rate = bpsForAccount(state, cursor, opts);
    if (rate > prev) {
      const reward = (amount * (rate - prev)) / BPS;
      if (reward > 0n) state.teamRewards.set(cursor, (state.teamRewards.get(cursor) ?? 0n) + reward);
      prev = rate;
      established = reward;
      overlayOpen = reward > 0n;
    } else if (rate === prev && rate > 0n && overlayOpen) {
      const overlay = (established * OVERLAY_BPS) / BPS;
      if (overlay > 0n) state.teamRewards.set(cursor, (state.teamRewards.get(cursor) ?? 0n) + overlay);
      overlayOpen = false;
    } else if (overlayOpen && rate < prev) overlayOpen = false;
    state.team.set(cursor, (state.team.get(cursor) ?? 0n) + amount);
    cursor = state.referrer.get(cursor) || null;
  }
}

function mapDelta(before, after) {
  const delta = new Map();
  for (const wallet of new Set([...before.keys(), ...after.keys()])) {
    const diff = (after.get(wallet) ?? 0n) - (before.get(wallet) ?? 0n);
    if (diff !== 0n) delta.set(wallet, diff);
  }
  return delta;
}

async function contributedLogs(client, address, fromBlock, toBlock) {
  const logs = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += 2000n) {
    const end = cursor + 1999n > toBlock ? toBlock : cursor + 1999n;
    let part;
    try {
      part = await client.getLogs({ address, event: CONTRIBUTED, fromBlock: cursor, toBlock: end });
    } catch (error) {
      if (!isGetLogsLimit(error) || end === cursor) throw error;
      const mid = cursor + (end - cursor) / 2n;
      part = [
        ...(await client.getLogs({ address, event: CONTRIBUTED, fromBlock: cursor, toBlock: mid })),
        ...(await client.getLogs({ address, event: CONTRIBUTED, fromBlock: mid + 1n, toBlock: end })),
      ];
    }
    logs.push(...part);
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  return logs;
}

async function logClient(env, address, fromBlock) {
  const urls = ["https://rpc-bsc.48.club", "https://bsc.rpc.blxrbdn.com", need(env, "BSC_MAINNET_RPC")];
  let last;
  for (const url of urls) {
    const client = createPublicClient({ chain: bsc, transport: http(url, { retryCount: 0, timeout: 20_000 }) });
    try {
      await client.getLogs({ address, event: CONTRIBUTED, fromBlock, toBlock: fromBlock });
      console.log(`入金日志节点 ${rpcLabel(url)}`);
      return client;
    } catch (error) {
      last = error;
      console.log(`${rpcLabel(url)} 不能读入金日志`);
    }
  }
  throw last;
}

function replay(base, deposits, legacy) {
  const state = snapshotState(base);
  for (const deposit of deposits) {
    const opts = { v3: true, directBps: deposit.directBps, blockNumber: deposit.block };
    if (!state.referrer.has(deposit.wallet)) bind(state, deposit.wallet, null);
    if (legacy) contributeLegacy(state, deposit.wallet, deposit.amount, opts);
    else contribute(state, deposit.wallet, deposit.amount, opts);
  }
  return state;
}

function readReceipt() {
  try {
    return JSON.parse(readFileSync(RECEIPT, "utf8"));
  } catch {
    return null;
  }
}

const env = readMainnetEnv();
const db = selectedDatabase(env, process.argv);
if (db.name !== "production") throw new Error("这次只改正式库 production");
const chain = contracts(env);
const v3Block = BigInt((env.TEAM_TIER_V3_BLOCK || "").trim() || "0");
if (v3Block <= 0n) throw new Error("TEAM_TIER_V3_BLOCK 还没写");
console.log(`库 production（${db.target.host}/${db.target.database}），只${APPLY ? "改网体计提和未上链的发布记录" : "读"}，不发 root。`);

const { default: pg } = await import("pg");
const database = new pg.Client({ connectionString: db.url, ssl: { rejectUnauthorized: false } });
await database.connect();
let accounts;
let roles;
let checkpoint;
let plans;
let unpublishedRoots;
try {
  await database.query("BEGIN READ ONLY");
  checkpoint = (await database.query(
    `SELECT last_block, direct_bps_block FROM coral_indexer_state WHERE chain_id = 56 AND lower(ido_address) = lower($1)`,
    [chain.IDO],
  )).rows[0];
  accounts = (await database.query(
    `SELECT wallet, referrer, self_wei, team_wei, team_reward_wei, historical_team_reward_wei, direct_wei, claimed_wei
       FROM coral_team_account WHERE chain_id = 56 AND lower(ido_address) = lower($1)`,
    [chain.IDO],
  )).rows;
  roles = (await database.query(
    `SELECT wallet, role, effective_block FROM coral_reward_role WHERE chain_id = 56 AND lower(ido_address) = lower($1)`,
    [chain.IDO],
  )).rows;
  plans = (await database.query(
    `SELECT id, status, nonce, tx_hash, signer, document, created_at FROM coral_publish_plan
      WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND lower(rewards_address) = lower($2)
        AND status IN ('prepared', 'signing', 'submitted')
      ORDER BY created_at`,
    [chain.IDO, chain.REWARDS],
  )).rows;
  unpublishedRoots = (await database.query(
    `SELECT root, cumulative_wei, created_at FROM coral_team_root
      WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND active = false AND tx_hash IS NULL`,
    [chain.IDO],
  )).rows;
  await database.query("COMMIT");
} catch (error) {
  await database.query("ROLLBACK").catch(() => {});
  throw error;
}

if (!checkpoint) throw new Error("没有索引检查点");
const throughBlock = BigInt(checkpoint.last_block);
const directSwitch = checkpoint.direct_bps_block == null ? null : BigInt(checkpoint.direct_bps_block);
console.log(`索引检查点 ${throughBlock}，直推切换区块 ${directSwitch ?? "无"}，V3 区块 ${v3Block}。`);

const client = await mainnetClient(env);
const committed = await client.readContract({
  address: chain.REWARDS,
  abi: [parseAbiItem("function committed() view returns (uint256)")],
  functionName: "committed",
});
const active = (await database.query(
  `SELECT cumulative_wei, root FROM coral_team_root
    WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND active = true`,
  [chain.IDO],
)).rows;
if (active.length !== 1) throw new Error(`生效 root 有 ${active.length} 条，停止`);
if (BigInt(committed) !== EXPECTED_COMMITTED || BigInt(active[0].cumulative_wei) !== EXPECTED_COMMITTED) {
  throw new Error(`链上已发布 ${fmt(committed)}，生效 root ${fmt(active[0].cumulative_wei)}。含 1.2 的 root 如果已经上链，不能靠改库降下来。`);
}
console.log(`链上已发布 ${fmt(committed)}，和生效 root 一致。`);

const logsClient = await logClient(env, chain.IDO, v3Block);
const logs = await contributedLogs(logsClient, chain.IDO, v3Block, throughBlock);
console.log(`V3 区块到检查点的入金 ${logs.length} 笔。`);

const base = createState();
const stored = new Map();
for (const row of accounts) {
  const wallet = getAddress(row.wallet);
  bind(base, wallet, referrerOf(row.referrer));
  base.self.set(wallet, BigInt(row.self_wei));
  base.team.set(wallet, BigInt(row.team_wei));
  stored.set(wallet, {
    team: BigInt(row.team_reward_wei),
    historical: BigInt(row.historical_team_reward_wei || 0),
    claimed: BigInt(row.claimed_wei),
    direct: BigInt(row.direct_wei),
  });
}
for (const role of roles) setRole(base, getAddress(role.wallet), role.role, role.effective_block);

const deposits = logs.map((log) => ({
  wallet: getAddress(log.args.account),
  amount: log.args.amount,
  block: log.blockNumber,
  tx: log.transactionHash,
  directBps: directSwitch != null && log.blockNumber >= directSwitch ? 500n : 1000n,
}));
for (const deposit of deposits) {
  const row = stored.get(deposit.wallet);
  if (!row && !base.referrer.has(deposit.wallet)) throw new Error(`${deposit.wallet} 有 V3 入金，索引里没有这个地址`);
  base.self.set(deposit.wallet, (base.self.get(deposit.wallet) ?? 0n) - deposit.amount);
  let cursor = base.referrer.get(deposit.wallet) || null;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    base.team.set(cursor, (base.team.get(cursor) ?? 0n) - deposit.amount);
    cursor = base.referrer.get(cursor) || null;
  }
}
for (const [wallet, amount] of base.self) if (amount < 0n) throw new Error(`${wallet} 扣掉 V3 入金后本人业绩为负`);
for (const [wallet, amount] of base.team) if (amount < 0n) throw new Error(`${wallet} 扣掉 V3 入金后伞下业绩为负`);

const legacy = replay(base, deposits, true);
const fixed = replay(base, deposits, false);
const teamDelta = mapDelta(legacy.teamRewards, fixed.teamRewards);
const directDelta = mapDelta(legacy.direct, fixed.direct);
if (directDelta.size) {
  for (const [wallet, delta] of directDelta) console.log(`直推差额 ${wallet} ${fmt(delta)}`);
  throw new Error("直推差额不是 0，停止");
}
const rows = [...teamDelta.entries()];
console.log("网体计提差额：");
if (!rows.length) console.log("  无");
for (const [wallet, delta] of rows) console.log(`  ${wallet} ${fmt(delta)}`);
if (rows.length !== 1 || rows[0][0] !== QIANG || rows[0][1] !== EXPECTED_DELTA) {
  throw new Error(`差额不是强子 ${QIANG} 的 ${fmt(EXPECTED_DELTA)} USDT，停止`);
}
const txs = deposits.map((deposit) => deposit.tx.toLowerCase());
const previous = readReceipt();
if (previous?.status === "applied" && previous.wallet === QIANG && Array.isArray(previous.txs) && previous.txs.join() === txs.join()) {
  console.log("这一批入金已经扣过，没有再改。");
  await database.end();
  process.exit(0);
}
for (const [wallet, delta] of rows) {
  const book = stored.get(wallet);
  const next = book.team + delta;
  if (next < 0n) throw new Error(`${wallet} 扣完后网体奖为负`);
  if (next + book.historical < book.claimed) {
    throw new Error(`${wallet} 扣完后 ${fmt(next + book.historical)} 低于已领 ${fmt(book.claimed)}`);
  }
  console.log(`${wallet.slice(-4)} 网体奖 ${fmt(book.team)} → ${fmt(next)}，已领 ${fmt(book.claimed)}。`);
}

const receipt = {
  status: "pending",
  throughBlock: throughBlock.toString(),
  txs,
  deltaWei: EXPECTED_DELTA.toString(),
  wallet: QIANG,
  plans: plans.map((plan) => ({ id: plan.id, status: plan.status, nonce: plan.nonce, tx: plan.tx_hash })),
  unpublishedRoots: unpublishedRoots.map((row) => row.root),
};
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`待发布计划 ${plans.length} 份，没有交易哈希的未生效 root ${unpublishedRoots.length} 条。`);
for (const plan of plans) console.log(`  计划 ${plan.id} ${plan.status} nonce ${plan.nonce ?? "无"} tx ${plan.tx_hash || "无"}`);
for (const row of unpublishedRoots) console.log(`  未上链 root ${row.root.slice(0, 10)} 累计 ${fmt(row.cumulative_wei)}`);

if (!APPLY) {
  console.log("这是预览。部署新索引之后再跑 --apply。");
  await database.end();
  process.exit(0);
}

for (const plan of plans) {
  if (plan.status === "prepared") continue;
  if (plan.tx_hash) {
    const receiptLog = await client.getTransactionReceipt({ hash: plan.tx_hash }).catch(() => null);
    if (!receiptLog) throw new Error(`计划 ${plan.id} 的交易 ${plan.tx_hash} 还查不到，停止`);
    if (receiptLog.status === "success") {
      const published = receiptLog.logs.some((log) => {
        if (log.address.toLowerCase() !== chain.REWARDS.toLowerCase()) return false;
        try {
          return decodeEventLog({ abi: [ROOT_PUBLISHED], data: log.data, topics: log.topics }).eventName === "RootPublished";
        } catch {
          return false;
        }
      });
      if (published) throw new Error(`计划 ${plan.id} 已经在链上发布，停止`);
    }
  }
  if (plan.nonce != null) {
    const publisher = getAddress(plan.signer);
    const latest = await client.getTransactionCount({ address: publisher, blockTag: "latest" });
    const pending = await client.getTransactionCount({ address: publisher, blockTag: "pending" });
    if (latest > Number(plan.nonce) || pending !== latest) {
      throw new Error(`计划 ${plan.id} 的 nonce ${plan.nonce} 可能已经发出。链上 nonce ${latest}，排队 ${pending}。停止`);
    }
  } else if (plan.status !== "prepared") {
    throw new Error(`计划 ${plan.id} 是 ${plan.status} 但没有 nonce，停止`);
  }
}

const saved = readReceipt();
if (saved.throughBlock !== throughBlock.toString() || saved.txs.join() !== txs.join()) {
  throw new Error("预览之后检查点或入金变了。重新预览，不要在旧结果上 --apply。");
}

try {
  await database.query("BEGIN");
  const book = stored.get(QIANG);
  const updated = await database.query(
    `UPDATE coral_team_account
        SET team_reward_wei = (team_reward_wei::numeric + $4::numeric)::text,
            updated_at = now()
      WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND lower(wallet) = lower($2)
        AND team_reward_wei = $3
        AND team_reward_wei::numeric + $4::numeric + historical_team_reward_wei::numeric >= claimed_wei::numeric
      RETURNING team_reward_wei`,
    [chain.IDO, QIANG, book.team.toString(), EXPECTED_DELTA.toString()],
  );
  if (updated.rowCount !== 1) throw new Error("没有改到强子的网体奖。金额已经变过，或扣完会低于已领");
  if (BigInt(updated.rows[0].team_reward_wei) + stored.get(QIANG).historical < stored.get(QIANG).claimed) {
    throw new Error("扣完后低于已领");
  }
  const closed = await database.query(
    `UPDATE coral_publish_plan SET status = 'superseded', updated_at = now()
      WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND lower(rewards_address) = lower($2)
        AND status IN ('prepared', 'signing', 'submitted')
      RETURNING id`,
    [chain.IDO, chain.REWARDS],
  );
  const proofs = await database.query(
    `DELETE FROM coral_team_proof
      WHERE chain_id = 56 AND lower(ido_address) = lower($1)
        AND root IN (
          SELECT root FROM coral_team_root
           WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND active = false AND tx_hash IS NULL
        )`,
    [chain.IDO],
  );
  const roots = await database.query(
    `DELETE FROM coral_team_root
      WHERE chain_id = 56 AND lower(ido_address) = lower($1) AND active = false AND tx_hash IS NULL
      RETURNING root`,
    [chain.IDO],
  );
  await database.query("COMMIT");
  console.log(`已扣网体奖。作废计划 ${closed.rowCount} 份，删除 proof ${proofs.rowCount} 行、未上链 root ${roots.rowCount} 条。`);
} catch (error) {
  await database.query("ROLLBACK").catch(() => {});
  throw error;
}
writeFileSync(RECEIPT, `${JSON.stringify({ ...receipt, status: "applied", appliedAt: new Date().toISOString() }, null, 2)}\n`);
await database.end();
console.log("库已改完。后台重新生成发布时，增量应是 12 USDT，记在 1379，强子不再增加。");
