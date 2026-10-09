#!/usr/bin/env node
/**
 * 给已导入的历史地址补一次 CKEY 和 NFT，并按确认入金时间补开售前的周息。
 * 默认只预览。--apply 才发送。重复执行会跳过已经补过的部分。
 *
 * 周息合约只从开售那一周起算，补 NFT 时也会先按 0 张结清，所以开售前的周息由这里直接铸进钱包。
 * 周数按北京时间每周日 00:00 计算，补到开售那一周之前。开售当周及之后仍由周息合约领取。
 * 没有 NFT 的地址周息为 0。不从客户钱包拉 USDT，不记直推，不记网体。
 * 历史直推不补：已经手动发过一部分，没发的以后继续手动发。
 * 铸币不计入金库 totalNemoAllocated，也不计入周息合约的已领额度；单人 100% 本金上限和总上限在这里先扣掉。
 * 已补金额记在 import-interest-backfill.json，重跑靠它避免再补一次。
 *
 * 测试网（默认）读 .env 的 BSC_TESTNET_* 和 TEST_PRIVATE_KEY。
 * 主网加 --network mainnet，读 BSC_MAINNET_RPC、BSC_MAINNET_IDO、BSC_MAINNET_CKEY、MAINNET_PRIVATE_KEY。
 * 控制人必须仍是这把私钥。已经交给多签时拒绝发送。
 *
 *   npm run settle:imported
 *   npm run settle:imported -- --apply
 *   npm run settle:imported -- --network mainnet
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  backfillInterest,
  formatBeijing,
  nftsOwed,
  settlePlan,
} from "./lib/settle-imported.mjs";

const NETWORKS = {
  testnet: {
    chainId: 97,
    name: "bsc-testnet",
    nativeName: "tBNB",
    rpcKey: "BSC_TESTNET_RPC",
    pkKey: "TEST_PRIVATE_KEY",
    idoKey: "BSC_TESTNET_IDO",
    nemoKey: "BSC_TESTNET_CKEY",
  },
  mainnet: {
    chainId: 56,
    name: "bsc",
    nativeName: "BNB",
    rpcKey: "BSC_MAINNET_RPC",
    pkKey: "MAINNET_PRIVATE_KEY",
    idoKey: "BSC_MAINNET_IDO",
    nemoKey: "BSC_MAINNET_CKEY",
  },
};

const VAULT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function saleOpen() view returns (bool)",
  "function nftInterest() view returns (address)",
  "function tokensPerUsdt() view returns (uint256)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
  "function importedNfts(address) view returns (uint256)",
  "function grantedNfts(address) view returns (uint256)",
  "function nft() view returns (address)",
  "function saleOpenedAt() view returns (uint256)",
  "function grantNft(address account, uint256 count)",
]);

const TOKEN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

const NFT_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const INTEREST_ABI = parseAbi([
  "function saleOpened() view returns (bool)",
  "function settledThrough(address) view returns (uint256)",
  "function pending(address) view returns (uint256)",
  "function tiersOf(uint256 versionId) view returns ((uint256 minNfts, uint256 weeklyBps)[])",
  "function accountCapBps() view returns (uint256)",
  "function interestCap() view returns (uint256)",
  "function totalAccrued() view returns (uint256)",
]);

const LEDGER = "import-interest-backfill.json";
const PROD_ENV = process.env.PROD_ENV_FILE || "/Users/jack/git/github/FreeDao/.env.production.local";

function networkName() {
  const index = process.argv.indexOf("--network");
  const name = index === -1 ? "testnet" : process.argv[index + 1];
  const network = NETWORKS[name];
  if (!network) throw new Error("--network 只能是 testnet 或 mainnet");
  return network;
}

function readRepoEnv() {
  const file = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);
  return parseEnv(readFileSync(file, "utf8"));
}

function unpackAccount(acc) {
  if (acc && typeof acc === "object" && !Array.isArray(acc) && acc.selfVolume !== undefined) return acc;
  const [referrer, inviteCode, selfVolume, directRewards, claimed, registered] = acc;
  return { referrer, inviteCode, selfVolume, directRewards, claimed, registered };
}

function importPath() {
  return resolve(process.argv.includes("--in")
    ? process.argv[process.argv.indexOf("--in") + 1]
    : "import-data.json");
}

function loadRecords() {
  const file = importPath();
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data.ok || !Array.isArray(data.records)) throw new Error(`${file} 不是一份通过检查的导入文件`);
  return data.records.map((row) => ({ ...row, wallet: getAddress(row.wallet) }));
}

function readLedger(ido) {
  try {
    const data = JSON.parse(readFileSync(resolve(LEDGER), "utf8"));
    if (getAddress(data.ido) !== getAddress(ido)) return { ido, paid: {} };
    return { ido, paid: data.paid || {} };
  } catch {
    return { ido, paid: {} };
  }
}

function writeLedger(ledger) {
  writeFileSync(resolve(LEDGER), `${JSON.stringify(ledger, null, 2)}\n`);
}

function envValue(file, key) {
  const lines = readFileSync(file, "utf8").split("\n").filter((row) => row.startsWith(`${key}=`));
  const line = lines[lines.length - 1];
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

async function fillOrders(records) {
  const missing = records.filter((row) => {
    const volume = BigInt(row.selfWei || 0);
    return nftsOwed(volume) >= 2n && (!Array.isArray(row.orders) || row.orders.length === 0);
  });
  if (missing.length === 0) return;
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: envValue(PROD_ENV, "DATABASE_URL"),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const orders = await client.query(`
      SELECT u."walletAddress" AS wallet, o."amountUsdt" AS amount_usdt,
             COALESCE(o."confirmedAt", o."createdAt") AS confirmed_at
      FROM nomad_contribution_orders o
      JOIN nomad_users u ON u.id = o."userId"
      WHERE o.status = 'confirmed'
      ORDER BY COALESCE(o."confirmedAt", o."createdAt") ASC
    `);
    const byWallet = new Map();
    for (const row of orders.rows) {
      const wallet = getAddress(row.wallet);
      const list = byWallet.get(wallet) || [];
      list.push({ usdt: Number(row.amount_usdt), confirmedAt: new Date(row.confirmed_at).toISOString() });
      byWallet.set(wallet, list);
    }
    for (const record of missing) {
      const key = getAddress(record.sourceWallet || record.wallet);
      record.orders = byWallet.get(key) || [];
    }
  } finally {
    await client.end();
  }
}

function printInterest(plan) {
  const row = plan.interest;
  console.log(plan.wallet);
  console.log(`  以前的时间: ${formatBeijing(row.since)}`);
  console.log(`  今天的时间: ${formatBeijing(row.now)}`);
  console.log(`  过去了多少周: ${row.weeks}`);
  console.log(`  应该补多少周息: ${formatUnits(row.gross, 18)} CKEY`);
  console.log(`  实际补了多少周息: ${formatUnits(row.actual, 18)} CKEY`);
  if (row.alreadyPaid > 0n) console.log(`  此前已补: ${formatUnits(row.alreadyPaid, 18)} CKEY`);
  for (const segment of row.segments) {
    if (row.segments.length === 1) continue;
    console.log(`  ${formatBeijing(segment.at)} 起 ${segment.nfts} 张，${segment.weeks} 周，${formatUnits(segment.amount, 18)} CKEY`);
  }
}

async function send(wallet, publicClient, address, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  const gas = await publicClient.estimateGas({ account: wallet.account.address, to: address, data });
  const hash = await wallet.sendTransaction({ to: address, data, gas: (gas * 3n) / 2n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} 失败：${hash}`);
  return hash;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const network = networkName();
  const env = readRepoEnv();
  const rpc = env[network.rpcKey];
  const pk = env[network.pkKey];
  if (!rpc || !pk) throw new Error(`缺少 ${network.rpcKey} 或 ${network.pkKey}`);
  if (!env[network.idoKey] || !env[network.nemoKey]) {
    throw new Error(`缺少 ${network.idoKey} 或 ${network.nemoKey}`);
  }
  const ido = getAddress(env[network.idoKey]);
  const nemo = getAddress(env[network.nemoKey]);
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: network.nativeName, symbol: network.nativeName, decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  if (await publicClient.getChainId() !== network.chainId) {
    throw new Error(`RPC 不是 ${network.name}（${network.chainId}）`);
  }

  const [vaultOwner, tokenOwner, saleOpen, interest, tokensPerUsdt, nft, saleOpenedAt] = await Promise.all([
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "owner" }),
    publicClient.readContract({ address: nemo, abi: TOKEN_ABI, functionName: "owner" }),
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "saleOpen" }),
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "nftInterest" }),
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "tokensPerUsdt" }),
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "nft" }),
    publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "saleOpenedAt" }),
  ]);
  if (getAddress(vaultOwner) !== account.address || getAddress(tokenOwner) !== account.address) {
    throw new Error("金库或 CKEY 的控制人不是当前私钥。交给多签之后不要用这把钥匙补发。");
  }
  if (!saleOpen) throw new Error("尚未开售。先完成冻结并开售，再补发。");
  if (getAddress(interest) === "0x0000000000000000000000000000000000000000") {
    throw new Error("金库还没有周息合约，补发时无法结算周息。");
  }
  const saleOpened = await publicClient.readContract({
    address: interest,
    abi: INTEREST_ABI,
    functionName: "saleOpened",
  });
  if (!saleOpened) throw new Error("周息合约还没开始计周。先开售，再补发。");
  if (saleOpenedAt === 0n) throw new Error("金库还没有开售时间。");

  const [nowBlock, tierRows, accountCapBps, interestCap, totalAccrued] = await Promise.all([
    publicClient.getBlock(),
    publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "tiersOf", args: [0n] }),
    publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "accountCapBps" }),
    publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "interestCap" }),
    publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "totalAccrued" }),
  ]);
  const tiers = tierRows.map((tier) => ({
    minNfts: tier.minNfts ?? tier[0],
    weeklyBps: tier.weeklyBps ?? tier[1],
  }));
  const records = loadRecords();
  await fillOrders(records);
  const ledger = readLedger(ido);
  let globalUsed = totalAccrued;
  for (const amount of Object.values(ledger.paid)) globalUsed += BigInt(amount);

  const plans = [];
  for (const record of records) {
    const address = record.wallet;
    const accountState = unpackAccount(await publicClient.readContract({
      address: ido,
      abi: VAULT_ABI,
      functionName: "getAccount",
      args: [address],
    }));
    if (!accountState.registered) throw new Error(`${address} 还没导入到当前金库`);
    const [importedNfts, grantedNfts, nemoBalance] = await Promise.all([
      publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "importedNfts", args: [address] }),
      publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "grantedNfts", args: [address] }),
      publicClient.readContract({ address: nemo, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] }),
    ]);
    const plan = settlePlan({
      wallet: address,
      volume: accountState.selfVolume,
      nemoBalance,
      importedNfts,
      grantedNfts,
      tokensPerUsdt,
    });
    if (plan.volume === 0n) continue;
    plan.interest = null;
    if (importedNfts >= 2n) {
      const orders = record.orders || [];
      if (orders.length === 0) throw new Error(`${address} 有 NFT，但导入文件和来源库都没有确认入金时间`);
      const alreadyPaid = BigInt(ledger.paid[address] || 0);
      const room = interestCap > globalUsed ? interestCap - globalUsed : 0n;
      const interest = backfillInterest({
        orders,
        tokensPerUsdt,
        saleOpenedAt,
        now: nowBlock.timestamp,
        tiers,
        accountCapBps,
        globalRoom: room,
        alreadyPaid,
      });
      if (interest.finalNfts !== importedNfts) {
        throw new Error(`${address} 的确认订单对应 ${interest.finalNfts} 张 NFT，链上导入的是 ${importedNfts} 张`);
      }
      if (interest.orderVolume > plan.volume) {
        throw new Error(`${address} 的确认订单合计超过链上业绩`);
      }
      globalUsed += interest.actual;
      plan.interest = { ...interest, now: nowBlock.timestamp, alreadyPaid };
    }
    plans.push(plan);
  }

  const nemoMint = plans.reduce((sum, plan) => sum + plan.nemoMint, 0n);
  const nftGrant = plans.reduce((sum, plan) => sum + plan.nftGrant, 0n);
  const interestGross = plans.reduce((sum, plan) => sum + (plan.interest?.gross || 0n), 0n);
  const interestActual = plans.reduce((sum, plan) => sum + (plan.interest?.actual || 0n), 0n);
  console.log(JSON.stringify({
    network: network.name,
    chainId: network.chainId,
    ido,
    accounts: plans.length,
    nemoMint: formatUnits(nemoMint, 18),
    nftGrant: nftGrant.toString(),
    interestGross: formatUnits(interestGross, 18),
    interestActual: formatUnits(interestActual, 18),
    saleOpenedAt: formatBeijing(saleOpenedAt),
    now: formatBeijing(nowBlock.timestamp),
    apply,
  }));
  console.log("周息按北京时间每周日 00:00 为一周，补到开售那一周之前。开售当周及之后由周息合约计算，不在这里重复补。");
  for (const plan of plans) {
    if (plan.nemoMint === 0n && plan.nftGrant === 0n && !plan.interest) continue;
    if (plan.nemoMint > 0n || plan.nftGrant > 0n) {
      console.log(`${plan.wallet} volume=${formatUnits(plan.volume, 18)} nemo=${formatUnits(plan.nemoMint, 18)} nft=${plan.nftGrant}`);
    }
    if (plan.interest) printInterest(plan);
  }
  if (!apply) {
    console.log("dry-run。确认后加 --apply。已补过的地址会跳过。");
    return;
  }

  for (const plan of plans) {
    if (plan.nemoMint > 0n) {
      await publicClient.simulateContract({
        address: nemo,
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [plan.wallet, plan.nemoMint],
        account: account.address,
      });
      const before = await publicClient.readContract({
        address: nemo, abi: TOKEN_ABI, functionName: "balanceOf", args: [plan.wallet],
      });
      const hash = await send(wallet, publicClient, nemo, TOKEN_ABI, "mint", [plan.wallet, plan.nemoMint]);
      const after = await publicClient.readContract({
        address: nemo, abi: TOKEN_ABI, functionName: "balanceOf", args: [plan.wallet],
      });
      if (after - before !== plan.nemoMint) throw new Error(`${plan.wallet} CKEY 增量不符：${hash}`);
      console.log(`${plan.wallet} nemo ${hash}`);
    }
    if (plan.interest && plan.interest.actual > 0n) {
      await publicClient.simulateContract({
        address: nemo,
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [plan.wallet, plan.interest.actual],
        account: account.address,
      });
      const before = await publicClient.readContract({
        address: nemo, abi: TOKEN_ABI, functionName: "balanceOf", args: [plan.wallet],
      });
      const hash = await send(wallet, publicClient, nemo, TOKEN_ABI, "mint", [plan.wallet, plan.interest.actual]);
      const after = await publicClient.readContract({
        address: nemo, abi: TOKEN_ABI, functionName: "balanceOf", args: [plan.wallet],
      });
      if (after - before !== plan.interest.actual) throw new Error(`${plan.wallet} 周息增量不符：${hash}`);
      ledger.paid[plan.wallet] = (plan.interest.alreadyPaid + plan.interest.actual).toString();
      writeLedger(ledger);
      console.log(`${plan.wallet} 实际补了多少周息: ${formatUnits(plan.interest.actual, 18)} CKEY ${hash}`);
    }
    if (plan.nftGrant > 0n) {
      await publicClient.simulateContract({
        address: ido,
        abi: VAULT_ABI,
        functionName: "grantNft",
        args: [plan.wallet, plan.nftGrant],
        account: account.address,
      });
      const beforeNfts = await publicClient.readContract({
        address: nft, abi: NFT_ABI, functionName: "balanceOf", args: [plan.wallet],
      });
      const hash = await send(wallet, publicClient, ido, VAULT_ABI, "grantNft", [plan.wallet, plan.nftGrant]);
      const [afterNfts, granted, settled, pending] = await Promise.all([
        publicClient.readContract({ address: nft, abi: NFT_ABI, functionName: "balanceOf", args: [plan.wallet] }),
        publicClient.readContract({ address: ido, abi: VAULT_ABI, functionName: "grantedNfts", args: [plan.wallet] }),
        publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "settledThrough", args: [plan.wallet] }),
        publicClient.readContract({ address: interest, abi: INTEREST_ABI, functionName: "pending", args: [plan.wallet] }),
      ]);
      if (afterNfts - beforeNfts !== plan.nftGrant) throw new Error(`${plan.wallet} NFT 增量不符：${hash}`);
      if (granted < plan.nftGrant) throw new Error(`${plan.wallet} 补发计数未增加：${hash}`);
      console.log(`${plan.wallet} nft ${hash} settledThrough=${settled} pending=${formatUnits(pending, 18)}`);
    }
  }
  console.log("历史地址补发完成。历史周息已直接打进钱包。开售当周及之后的周息，等该周结束后在周息合约领取。");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
