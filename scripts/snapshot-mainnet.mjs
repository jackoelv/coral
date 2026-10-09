#!/usr/bin/env node
/**
 * Builds mainnet-run/import-data.json for a vault replacement.
 * Base: neondb users and confirmed orders (read-only). Added: every Contributed on the frozen old vault.
 * Every address is checked against the old vault (referrer, self volume), and the totals against
 * totalImported + totalContributed. Team rewards already claimed on the old rewards contract go to
 * mainnet-run/old-paid.json; settle-team:mainnet subtracts them.
 *
 *   npm run snapshot:mainnet
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, getAddress, parseAbi } from "viem";
import { compareWithOldVault, mergeChainContributions, scanLogs } from "./lib/migration.mjs";
import { ROOT, cleanEnv, mainnetClient, need, oldContracts, productionDatabase, readMainnetEnv, runPath, sha256File, writeEvidence } from "./lib/mainnet.mjs";
import { rpcLabel } from "./lib/reward-index.mjs";
import { chunk } from "./lib/tree.mjs";

const WEI = 10n ** 18n;
const VAULT = parseAbi([
  "function saleOpen() view returns (bool)",
  "function paused() view returns (bool)",
  "function totalImported() view returns (uint256)",
  "function totalContributed() view returns (uint256)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
]);
const REWARDS = parseAbi(["function claimed(address) view returns (uint256)", "function totalTeamPaid() view returns (uint256)"]);
const EVENTS = parseAbi([
  "event Registered(address indexed account, bytes32 indexed code, address indexed referrer)",
  "event ReferrerBound(address indexed account, address indexed referrer)",
  "event Contributed(address indexed account, uint256 amount, uint256 selfVolume, uint256 nemoAmount)",
  "event UserImported(address indexed account, bytes32 indexed code)",
]);

const env = readMainnetEnv();
const client = await mainnetClient(env);
const logRpc = (env.BSC_MAINNET_INDEX_RPC || "").trim() || need(env, "BSC_MAINNET_RPC");
const logClient = await mainnetClient({ ...env, BSC_MAINNET_RPC: logRpc });
const old = oldContracts(env);
const CUTOFF = runPath("old-cutoff.json");
const SNAPSHOT = runPath("migration-snapshot.json");
const PAID = runPath("old-paid.json");
const FILE = runPath("import-data.json");

if (!existsSync(CUTOFF)) throw new Error("没有 mainnet-run/old-cutoff.json。先关闭旧合约：npm run retire-old:mainnet，签完再 -- --check");
if (getAddress(JSON.parse(readFileSync(CUTOFF, "utf8")).oldIdo) !== old.IDO) throw new Error("old-cutoff.json 记录的旧金库和 OLD_MAINNET_IDO 不同");
if (existsSync(runPath("import-lock.json"))) throw new Error("新金库已经开始导入，不能再改导入文件");

const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
const [saleOpen, paused] = await Promise.all([read(old.IDO, VAULT, "saleOpen"), read(old.IDO, VAULT, "paused")]);
if (saleOpen || !paused) throw new Error("旧金库没有处于关闭并暂停的状态，快照可能还会变，停止");

const head = await client.getBlockNumber();
const chunkBlocks = BigInt(process.env.CHUNK_BLOCKS || env.CHUNK_BLOCKS || 2000);
console.log(`扫旧金库 ${old.IDO} 区块 ${old.startBlock} - ${head}，节点 ${rpcLabel(logRpc)}`);
const logs = await scanLogs(logClient, { address: old.IDO, events: EVENTS, fromBlock: old.startBlock, toBlock: head, chunk: chunkBlocks });
const byName = (name) => logs.filter((log) => log.eventName === name);
const live = [...byName("Registered"), ...byName("ReferrerBound")];
if (live.length) {
  throw new Error(`旧金库上有 ${live.length} 条开售后的注册或绑定，正式库里没有这些关系，本脚本不处理：\n${live.map((l) => `${l.eventName} ${l.args.account} ${l.transactionHash}`).join("\n")}`);
}

const blockTimes = new Map();
for (const log of byName("Contributed")) {
  if (!blockTimes.has(log.blockNumber)) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    blockTimes.set(log.blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
  }
}
const contributions = byName("Contributed").map((log) => ({
  account: getAddress(log.args.account),
  amountWei: log.args.amount.toString(),
  confirmedAt: blockTimes.get(log.blockNumber),
  block: log.blockNumber.toString(),
  tx: log.transactionHash,
}));

async function loadProduction() {
  const url = need(env, "DATABASE_URL");
  const target = productionDatabase(url);
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const users = await db.query(`SELECT id, "walletAddress" AS wallet, "inviteCode" AS invite, "referrerId" AS referrer_id FROM nomad_users`);
    const orders = await db.query(`
      SELECT "userId" AS user_id, "amountUsdt" AS amount_usdt, COALESCE("confirmedAt", "createdAt") AS confirmed_at
      FROM nomad_contribution_orders
      WHERE status = 'confirmed'
      ORDER BY COALESCE("confirmedAt", "createdAt") ASC
    `);
    const byUser = new Map();
    for (const row of orders.rows) {
      const list = byUser.get(row.user_id) || [];
      list.push({ usdt: Number(row.amount_usdt), confirmedAt: new Date(row.confirmed_at).toISOString(), source: "neondb" });
      byUser.set(row.user_id, list);
    }
    console.log(`正式库 ${target.host}/${target.database} 只读：${users.rows.length} 个用户，${orders.rows.length} 笔确认订单`);
    return users.rows.map((row) => {
      const list = byUser.get(row.id) || [];
      return {
        id: row.id,
        wallet: row.wallet,
        inviteCode: row.invite,
        referrerId: row.referrer_id,
        selfUsdt: list.reduce((sum, order) => sum + order.usdt, 0),
        orders: list,
      };
    });
  } finally {
    await db.end();
  }
}

const users = mergeChainContributions(await loadProduction(), contributions);
const wallets = users.map((user) => getAddress(user.wallet));

const problems = [];
const imported = new Set(byName("UserImported").map((log) => getAddress(log.args.account)));
for (const wallet of wallets) if (!imported.has(wallet)) problems.push(`${wallet} 在正式库里，但旧金库没有导入过`);
for (const wallet of imported) if (!wallets.includes(wallet)) problems.push(`${wallet} 旧金库导入过，但正式库里没有`);

const chain = new Map();
const paid = new Map();
for (const group of chunk(wallets, 25)) {
  const accounts = await Promise.all(group.map((wallet) => read(old.IDO, VAULT, "getAccount", [wallet])));
  const claimed = await Promise.all(group.map((wallet) => read(old.REWARDS, REWARDS, "claimed", [wallet])));
  group.forEach((wallet, i) => {
    chain.set(wallet, accounts[i]);
    if (claimed[i] > 0n) paid.set(wallet, claimed[i]);
  });
}
problems.push(...compareWithOldVault(users, chain));

const [totalImported, totalContributed, totalTeamPaid] = await Promise.all([
  read(old.IDO, VAULT, "totalImported"),
  read(old.IDO, VAULT, "totalContributed"),
  read(old.REWARDS, REWARDS, "totalTeamPaid"),
]);
const totalWei = users.reduce((sum, user) => sum + BigInt(user.selfUsdt) * WEI, 0n);
if (totalWei !== totalImported + totalContributed) problems.push(`快照合计 ${totalWei} 不等于旧金库 totalImported + totalContributed ${totalImported + totalContributed}`);
const paidSum = [...paid.values()].reduce((sum, wei) => sum + wei, 0n);
if (paidSum !== totalTeamPaid) problems.push(`逐地址已领合计 ${paidSum} 不等于旧奖励合约 totalTeamPaid ${totalTeamPaid}`);

if (problems.length) {
  const evidence = writeEvidence("snapshot-problems", { problems });
  throw new Error(`快照核对没通过（${problems.length} 项），未写导入文件。看 ${evidence}\n${problems.slice(0, 20).join("\n")}`);
}

writeFileSync(SNAPSHOT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  oldIdo: old.IDO,
  oldRewards: old.REWARDS,
  scannedTo: head.toString(),
  totalImported: totalImported.toString(),
  totalContributed: totalContributed.toString(),
  contributions,
  users,
}, null, 2)}\n`, { mode: 0o600 });
writeFileSync(PAID, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  oldRewards: old.REWARDS,
  totalTeamPaid: totalTeamPaid.toString(),
  paid: Object.fromEntries([...paid].map(([wallet, wei]) => [wallet, wei.toString()])),
}, null, 2)}\n`, { mode: 0o600 });

const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/export-freedao.mjs"), "--in", SNAPSHOT, "--out", FILE, "--network", "bscMainnet"], {
  cwd: ROOT,
  env: cleanEnv({}),
  encoding: "utf8",
});
if (result.status !== 0) throw new Error(`生成导入文件失败\n${result.stderr || result.stdout}`);

console.log(JSON.stringify({
  users: users.length,
  totalSelfUsdt: formatUnits(totalWei, 18),
  oldTotalImported: formatUnits(totalImported, 18),
  oldTotalContributed: formatUnits(totalContributed, 18),
  chainDeposits: contributions.map((c) => ({ account: c.account, usdt: formatUnits(BigInt(c.amountWei), 18), confirmedAt: c.confirmedAt, tx: c.tx })),
  paidOnOldRewards: Object.fromEntries([...paid].map(([wallet, wei]) => [wallet, formatUnits(wei, 18)])),
  importData: FILE,
  sha256: sha256File(FILE),
}, null, 2));
console.log(`证据 ${writeEvidence("snapshot", { users: users.length, totalWei, contributions, paid: Object.fromEntries(paid) })}`);
console.log("核对通过。下一步：npm run import:mainnet（不要带 --refresh）");
