#!/usr/bin/env node
/**
 * 部署可迁移的奖励合约，用多签提议并接受，种入旧合约已领金额，然后只对之后的入金启用新三档。
 * 默认只打印。--apply 才发送。不清索引库。
 *
 *   node scripts/rewards-migrate-testnet.mjs deploy
 *   node scripts/rewards-migrate-testnet.mjs propose --apply
 *   node scripts/rewards-migrate-testnet.mjs accept --apply
 */
import { readFileSync } from "node:fs";
import { encodeFunctionData, getAddress, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readTestnetEnv, saveTestnetEnv } from "./lib/testnet-env.mjs";
import {
  accountByIndex,
  addressByIndex,
  assertChain,
  execMultisig,
  loadWalletRows,
  redact,
  parseSignerSelection,
  testnetClients,
} from "./lib/multisig-exec.mjs";

const VAULT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function rewards() view returns (address)",
  "function proposedRewards() view returns (address)",
  "function proposedRewardsEta() view returns (uint256)",
  "function proposeRewards(address next)",
  "function acceptRewards()",
]);
const REWARDS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function publisher() view returns (address)",
  "function claimed(address) view returns (uint256)",
  "function totalTeamPaid() view returns (uint256)",
  "function claimsSeeded() view returns (bool)",
  "function setPublisher(address publisher_)",
  "function seedClaims(address[] accounts, uint256[] amounts)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const command = process.argv[2];
const apply = process.argv.includes("--apply");

function built(name) {
  return JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
}

async function claimedRows(env, ido) {
  const databaseUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL，不能读取已领金额");
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT wallet, claimed_wei FROM coral_team_account
       WHERE chain_id = 97 AND lower(ido_address) = lower($1) AND claimed_wei <> '0'`,
      [ido],
    );
    return rows.map((row) => ({ wallet: getAddress(row.wallet), amount: BigInt(row.claimed_wei) }));
  } finally {
    await client.end();
  }
}

async function main() {
  const env = readTestnetEnv();
  const rows = loadWalletRows();
  const { account, publicClient, walletClient } = testnetClients(env);
  await assertChain(publicClient);
  const vault = getAddress(env.BSC_TESTNET_IDO);
  const multisig = getAddress(env.TESTNET_MULTISIG || ZERO);
  if (multisig === ZERO) throw new Error("缺少 TESTNET_MULTISIG");
  const indexes = parseSignerSelection(process.argv, rows);
  const signers = apply
    ? indexes.map((index) => accountByIndex(rows, index))
    : indexes.map((index) => ({ address: addressByIndex(rows, index) }));
  const oldRewards = getAddress(env.BSC_TESTNET_REWARDS);
  const next = env.BSC_TESTNET_REWARDS_NEXT ? getAddress(env.BSC_TESTNET_REWARDS_NEXT) : null;

  if (command === "deploy") {
    console.log(JSON.stringify({ vault, owner: multisig, payer: account.address, apply }));
    if (next && await publicClient.getCode({ address: next }) !== "0x") {
      console.log(`已有下一份奖励合约 ${next}。不重复部署。`);
      return;
    }
    if (!apply) {
      console.log("dry-run。确认后：node scripts/rewards-migrate-testnet.mjs deploy --apply");
      return;
    }
    const compiled = built("CoralRewardsMigratable");
    const hash = await walletClient.deployContract({
      abi: compiled.abi,
      bytecode: compiled.bytecode.object,
      args: [vault, multisig, {
        chainId: 97n,
        usdt: getAddress(env.BSC_TESTNET_USDT),
        rewardsDelay: 600n,
        nftCap: 10_000n,
        directReferralBps: 1_000n,
        minIdo: 10n ** 18n,
        tokensPerUsdt: 100n * 10n ** 18n,
        weekDuration: 3_600n,
        weekByBlock: false,
        ambassadorMin: 100n * 10n ** 18n,
        partnerMin: 1_000n * 10n ** 18n,
      }],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`奖励合约部署失败：${hash}`);
    const deployed = getAddress(receipt.contractAddress);
    const owner = getAddress(await publicClient.readContract({ address: deployed, abi: REWARDS_ABI, functionName: "owner" }));
    if (owner !== multisig) throw new Error("新奖励合约 Owner 不是多签");
    saveTestnetEnv({ BSC_TESTNET_REWARDS_NEXT: deployed });
    console.log(JSON.stringify({ rewardsNext: deployed, tx: hash }));
    console.log("还没有切换。下一步 propose。");
    return;
  }

  if (!next) throw new Error("缺少 BSC_TESTNET_REWARDS_NEXT。先运行 deploy --apply");
  const vaultOwner = getAddress(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "owner" }));
  if (vaultOwner !== multisig) throw new Error("金库 Owner 还不是多签。先完成多签 accept");

  if (command === "propose") {
    const current = getAddress(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "rewards" }));
    const proposed = getAddress(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "proposedRewards" }));
    const eta = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "proposedRewardsEta" });
    console.log(JSON.stringify({ current, proposed, eta: eta.toString(), next }));
    if (current === next) {
      console.log("金库已经指向新奖励合约。");
      return;
    }
    if (proposed === next) {
      console.log(`已经提议。到期时间 ${eta}。到点后运行 accept。`);
      return;
    }
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "proposeRewards", args: [next] });
    await execMultisig({ publicClient, walletClient, multisig, signers, target: vault, data, apply, rows });
    if (!apply) console.log("dry-run。确认后：node scripts/rewards-migrate-testnet.mjs propose --apply");
    return;
  }

  if (command === "accept") {
    const current = getAddress(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "rewards" }));
    const eta = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "proposedRewardsEta" });
    const now = BigInt((await publicClient.getBlock()).timestamp);
    console.log(JSON.stringify({ current, next, eta: eta.toString(), now: now.toString() }));
    if (current !== next) {
      if (now < eta) {
        console.log(`还要等 ${eta - now} 秒。到点后再运行 accept --apply。`);
        return;
      }
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "acceptRewards" });
      console.log("将接受新奖励合约。");
      if (apply) await execMultisig({ publicClient, walletClient, multisig, signers, target: vault, data, apply, rows });
    }
    const publisher = getAddress(privateKeyToAccount(env.PUBLISHER_PRIVATE_KEY).address);
    const currentPublisher = getAddress(await publicClient.readContract({ address: next, abi: REWARDS_ABI, functionName: "publisher" }));
    if (currentPublisher !== publisher) {
      const data = encodeFunctionData({ abi: REWARDS_ABI, functionName: "setPublisher", args: [publisher] });
      console.log(`把 publisher 从 ${currentPublisher} 设为 ${publisher}`);
      if (apply) await execMultisig({ publicClient, walletClient, multisig, signers, target: next, data, apply, rows });
    }
    const seeded = await publicClient.readContract({ address: next, abi: REWARDS_ABI, functionName: "claimsSeeded" });
    const claims = await claimedRows(env, vault);
    const oldPaid = await publicClient.readContract({ address: oldRewards, abi: REWARDS_ABI, functionName: "totalTeamPaid" });
    let sum = 0n;
    for (const row of claims) {
      const onChain = await publicClient.readContract({
        address: oldRewards, abi: REWARDS_ABI, functionName: "claimed", args: [row.wallet],
      });
      if (onChain !== row.amount) throw new Error(`${row.wallet} 数据库已领 ${row.amount}，旧合约是 ${onChain}。先重新索引再接受`);
      sum += row.amount;
    }
    if (sum !== oldPaid) throw new Error(`已领合计 ${sum}，旧合约 totalTeamPaid ${oldPaid}。先重新索引再接受`);
    console.log(JSON.stringify({ claims: claims.length, totalTeamPaid: sum.toString(), seeded }));
    if (!seeded) {
      const data = encodeFunctionData({
        abi: REWARDS_ABI,
        functionName: "seedClaims",
        args: [claims.map((row) => row.wallet), claims.map((row) => row.amount)],
      });
      if (!apply) {
        console.log("dry-run。确认后：node scripts/rewards-migrate-testnet.mjs accept --apply");
        return;
      }
      await execMultisig({ publicClient, walletClient, multisig, signers, target: next, data, apply, rows });
    }
    if (!apply) return;
    const seededPaid = await publicClient.readContract({ address: next, abi: REWARDS_ABI, functionName: "totalTeamPaid" });
    if (seededPaid !== oldPaid) throw new Error(`新合约 totalTeamPaid ${seededPaid}，旧合约 ${oldPaid}`);
    const logs = await publicClient.getLogs({
      address: vault,
      event: parseAbiItem("event RewardsUpdated(address indexed rewards)"),
      fromBlock: BigInt(env.START_BLOCK || env.INDEX_START_BLOCK || 1),
      toBlock: "latest",
    });
    const matched = logs.filter((log) => getAddress(log.args.rewards) === next);
    if (!matched.length) throw new Error("找不到指向新奖励合约的 RewardsUpdated");
    const switchBlock = matched[matched.length - 1].blockNumber.toString();
    saveTestnetEnv({
      BSC_TESTNET_REWARDS: next,
      REWARDS_ADDRESS: next,
      TEAM_TIER_SWITCH_BLOCK: switchBlock,
    });
    console.log(JSON.stringify({ rewards: next, switchBlock }));
    console.log("不要清索引库。接着入金，再跑 index:rewards 和 publish:root。切换区块之前的入金仍按旧五档。");
    return;
  }

  throw new Error("命令是 deploy、propose 或 accept");
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || error, loadWalletRows()));
  process.exit(1);
});
