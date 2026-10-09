#!/usr/bin/env node
/**
 * 用库里的累计网体奖组 Merkle root。
 * 默认只打印。--apply 在本地电脑用 PUBLISHER_PRIVATE_KEY 调用 publishRoot，发布即生效。
 * 先把 proof 和明细写入数据库，再发交易。没有 DATABASE_URL / RPC / 私钥时不假装已上链。
 *
 *   DATABASE_URL=... node scripts/publish-root.mjs
 *   DATABASE_URL=... RPC_URL=... PUBLISHER_PRIVATE_KEY=0x... REWARDS_ADDRESS=0x... IDO_ADDRESS=0x... \
 *     node scripts/publish-root.mjs --apply
 */
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbi, toBytes } from "viem";
import { mkdir, writeFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { buildMerkle, leafHash } from "./lib/merkle.mjs";
import { ensureSchema, loadAccounts, lockName, saveRoot, tryLock, unlock } from "./lib/reward-db.mjs";

const rewardsAbi = parseAbi([
  "function publishRoot(bytes32 root, bytes32 contentHash, uint256 cumulative, string uri)",
  "function publisher() view returns (address)",
  "function merkleRoot() view returns (bytes32)",
  "function totalTeamPaid() view returns (uint256)",
  "function historicalTeamBudget() view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function totalContributed() view returns (uint256)",
  "function totalImported() view returns (uint256)",
  "function totalDirectAccrued() view returns (uint256)",
  "function rewards() view returns (address)",
]);

class Stop extends Error {}

function explain(message) {
  console.log(message);
  throw new Stop();
}

if (!process.env.DATABASE_URL) {
  console.log("未发布 root：缺少 DATABASE_URL。索引先写入业绩，再运行本脚本。");
  process.exit(0);
}

const apply = process.argv.includes("--apply");
const activate = process.argv.includes("--activate");
const { default: pg } = await import("pg");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  await ensureSchema(client);
  const chainId = Number(process.env.CHAIN_ID || 0);
  if (!chainId) explain("未发布 root：设置 CHAIN_ID（本地 31337，BSC 测试网 97，主网 56）。");

  if (activate) {
    explain("publishRoot 发布即生效，不再需要 --activate。核对用 scripts/verify-root.mjs。");
  }

  if (!process.env.IDO_ADDRESS) explain("未发布 root：设置 IDO_ADDRESS，账户按金库地址分开存放。");
  const ido = getAddress(process.env.IDO_ADDRESS);
  const rows = await loadAccounts(client, chainId, ido);
  const entries = rows
    .map((row) => ({
      account: getAddress(row.wallet),
      cumulative: BigInt(row.team_reward_wei || 0) + BigInt(row.historical_team_reward_wei || 0),
    }))
    .filter((row) => row.cumulative > 0n)
    .sort((a, b) => a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
  if (entries.length === 0) explain("库里还没有可发放的网体奖。先跑 scripts/index-rewards.mjs。");

  const tree = buildMerkle(entries);
  const teamSum = entries.reduce((sum, entry) => sum + entry.cumulative, 0n);
  const contentHash = keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()]))));
  const proofs = entries.map((entry) => ({
    wallet: entry.account,
    cumulativeWei: entry.cumulative,
    proof: tree.proofs.get(leafHash(entry.account, entry.cumulative)) || [],
  }));

  console.log(
    JSON.stringify({
      leaves: entries.length,
      cumulative: teamSum.toString(),
      root: tree.root,
      contentHash,
      apply,
    }),
  );

  if (!apply) {
    console.log("dry-run。确认后加 --apply 才会先写 proof，再调用 publishRoot。");
    throw new Stop();
  }
  if (process.env.PRIVATE_KEY && !process.env.PUBLISHER_PRIVATE_KEY) {
    explain("未提交 root：请设置 PUBLISHER_PRIVATE_KEY。PRIVATE_KEY 不会用来发布。proof 尚未写入。");
  }
  if (!process.env.RPC_URL || !process.env.PUBLISHER_PRIVATE_KEY || !process.env.REWARDS_ADDRESS) {
    explain("未提交 root：--apply 需要 RPC_URL、PUBLISHER_PRIVATE_KEY、REWARDS_ADDRESS、IDO_ADDRESS。proof 尚未写入。");
  }

  const rewards = getAddress(process.env.REWARDS_ADDRESS);
  const transport = http(process.env.RPC_URL);
  const chain = {
    id: chainId,
    name: "nemo",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL] } },
  };
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain, transport });
  const [contributed, imported, direct, alreadyPaid, budget] = await Promise.all([
    publicClient.readContract({
      address: getAddress(process.env.IDO_ADDRESS),
      abi: vaultAbi,
      functionName: "totalContributed",
    }),
    publicClient.readContract({
      address: getAddress(process.env.IDO_ADDRESS),
      abi: vaultAbi,
      functionName: "totalImported",
    }).catch(() => {
      throw new Error("当前金库没有记下历史入金总额。重新部署并导入后，totalImported 才会等于各地址本人业绩之和。");
    }),
    publicClient.readContract({
      address: getAddress(process.env.IDO_ADDRESS),
      abi: vaultAbi,
      functionName: "totalDirectAccrued",
    }),
    publicClient.readContract({ address: rewards, abi: rewardsAbi, functionName: "totalTeamPaid" }),
    publicClient.readContract({ address: rewards, abi: rewardsAbi, functionName: "historicalTeamBudget" }),
  ]);
  if (teamSum < alreadyPaid) {
    throw new Error(`累计 ${teamSum} 小于链上已支付 ${alreadyPaid}`);
  }
  const cap = ((contributed + imported) * 2500n) / 10_000n + budget;
  if (direct + teamSum > cap) {
    throw new Error(`直推 + 网体累计超过 25% 帽：合计 ${direct + teamSum}，上限 ${cap}`);
  }
  const onchainPublisher = await publicClient.readContract({
    address: rewards,
    abi: rewardsAbi,
    functionName: "publisher",
  });
  if (getAddress(onchainPublisher) !== account.address) {
    throw new Error(`私钥地址 ${account.address} 不是 publisher ${onchainPublisher}`);
  }

  const name = lockName(chainId, ido);
  if (!(await tryLock(client, name))) {
    throw new Error("另一个索引或发布进程正在运行");
  }
  try {
    const saved = {
      chainId,
      idoAddress: ido,
      root: tree.root,
      contentHash,
      cumulativeWei: teamSum,
      proofs,
    };
    await saveRoot(client, { ...saved, txHash: null, active: false });
    const outDir = process.env.PUBLIC_DIR || "roots";
    await mkdir(outDir, { recursive: true });
    const publicFile = `${outDir}/${chainId}-${ido.toLowerCase()}-${tree.root}.json`;
    await writeFile(
      publicFile,
      `${JSON.stringify(
        { root: tree.root, contentHash, entries: entries.map((e) => [e.account, e.cumulative.toString()]) },
        null,
        2,
      )}\n`,
    );
    console.log(`公开明细 ${publicFile}，上传到 CONTENT_URI 后社区可用 verify-root 核对。`);
    const hash = await wallet.writeContract({
      address: rewards,
      abi: rewardsAbi,
      functionName: "publishRoot",
      args: [tree.root, contentHash, teamSum, process.env.CONTENT_URI || ""],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`publishRoot failed ${hash}`);
    await saveRoot(client, { ...saved, txHash: hash, active: true });
    console.log(`publishRoot ${hash} 已生效。明细 ${process.env.CONTENT_URI || "(未设置 CONTENT_URI)"}`);
  } finally {
    await unlock(client, name);
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
} finally {
  await client.end();
}
