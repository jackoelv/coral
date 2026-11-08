#!/usr/bin/env node
/**
 * Read-only Coral snapshot from the production index.
 * The default reads the database only and writes JSON plus an HTML invite tree
 * into ckey-snapshots/. It does not scan logs and does not write the database.
 *
 *   npm run network:snapshot
 *   npm run network:check
 *
 * --check reads contract totals once and compares them with the index sums.
 * It does not read each address.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, parseAbi } from "viem";
import { USDT, ROOT, contracts, mainnetClient, readMainnetEnv, redact, selectedDatabase } from "./lib/mainnet.mjs";
import { rpcErrorText } from "./lib/reward-index.mjs";
import { directBpsProblem } from "./lib/team-reward.mjs";
import {
  accountsFromIndex,
  annotatePhase1Manual,
  annotateRewardRoles,
  buildDailySeries,
  buildTree,
  layoutVolumeParents,
  compareIndexTotals,
  fileStamp,
  flowsFromBooks,
  formatShanghai,
  formatUsdt,
  jsonReplacer,
  marketHeadroom,
  ratioText,
  renderPage,
  rollupWeeks,
} from "./lib/network-snapshot.mjs";

const DIR = resolve(ROOT, "ckey-snapshots");
const CHECK = process.argv.includes("--check");
const UNIT = 10n ** 18n;
const VIEWS = parseAbi([
  "function totalContributed() view returns (uint256)",
  "function totalImported() view returns (uint256)",
  "function totalDirectAccrued() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function directReferralBps() view returns (uint256)",
]);
const REWARD_VIEWS = parseAbi([
  "function claimed(address) view returns (uint256)",
  "function totalTeamPaid() view returns (uint256)",
  "function committed() view returns (uint256)",
  "function rewardCap() view returns (uint256)",
  "function historicalTeamBudget() view returns (uint256)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function readOrFail(client, call, blockNumber) {
  try {
    return await client.readContract({ ...call, blockNumber });
  } catch (error) {
    throw new Error(`${call.functionName} 读取失败：${rpcErrorText(error)}`);
  }
}

async function blockUnix(client, block, head) {
  if (block == null || block === "" || block === "0") return null;
  const height = BigInt(block);
  if (height <= 0n || height > head) return null;
  const fetched = await client.getBlock({ blockNumber: height });
  return Number(fetched.timestamp);
}

function weiFromUsdt(amount) {
  return BigInt(amount) * UNIT;
}

function unixOf(value) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`无法解析时间 ${value}`);
  return Math.floor(ms / 1000);
}

const env = readMainnetEnv();
const db = selectedDatabase(env);
if (db.name !== "production") throw new Error("这份快照只读正式库 production");
console.log(`这次用正式库 ${db.name}（${db.target.host}/${db.target.database}），只读，不写库，不发 root。`);

const stamp = fileStamp();
const snapshotName = `network-snapshot-${stamp}.json`;
const pageName = `network-tree-${stamp}.html`;
const reportName = `network-reconcile-${stamp}.txt`;

try {
  const a = contracts(env);
  const { default: pg } = await import("pg");
  const database = new pg.Client({ connectionString: db.url, ssl: { rejectUnauthorized: false } });
  await database.connect();
  let stored = [];
  let notes = new Map();
  let orderRows = [];
  let payoutRows = [];
  let indexerLastBlock = null;
  let directBpsBlock = null;
  let roleRows = [];
  let volumeRoots = [];
  try {
    await database.query("BEGIN READ ONLY");
    const bpsColumn = await database.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'coral_indexer_state' AND column_name = 'direct_bps_block'`,
    );
    const checkpoint = await database.query(
      `SELECT last_block${bpsColumn.rowCount ? ", direct_bps_block" : ""}
         FROM coral_indexer_state WHERE chain_id = $1 AND lower(ido_address) = lower($2)`,
      [56, a.IDO],
    );
    indexerLastBlock = checkpoint.rows[0] ? checkpoint.rows[0].last_block : null;
    directBpsBlock = checkpoint.rows[0]?.direct_bps_block ?? null;
    const accounts = await database.query(
      `SELECT wallet, referrer, self_wei, team_wei, team_reward_wei, historical_team_reward_wei, direct_wei, claimed_wei
         FROM coral_team_account WHERE chain_id = $1 AND lower(ido_address) = lower($2)`,
      [56, a.IDO],
    );
    stored = accounts.rows;
    const noteRows = await database.query(
      `SELECT "walletAddress" AS wallet, "adminNote" AS note FROM nomad_users WHERE "adminNote" IS NOT NULL AND btrim("adminNote") <> ''`,
    );
    notes = new Map(noteRows.rows.map((row) => [getAddress(row.wallet).toLowerCase(), String(row.note).trim()]));
    const orders = await database.query(
      `SELECT u."walletAddress" AS wallet, o."amountUsdt" AS amount, o."txHash" AS tx,
              COALESCE(o."confirmedAt", o."createdAt") AS at
         FROM nomad_contribution_orders o
         JOIN nomad_users u ON u.id = o."userId"
        WHERE o.status = 'confirmed' AND o."adminNote" = 'chain'`,
    );
    orderRows = orders.rows;
    const payoutTable = await database.query(`SELECT to_regclass('public.nomad_chain_payouts') AS name`);
    if (payoutTable.rows[0].name) {
      const payouts = await database.query(
        `SELECT tx_hash AS tx, wallet, kind, amount_usdt AS amount, created_at AS at FROM nomad_chain_payouts`,
      );
      payoutRows = payouts.rows;
    }
    const volumeTable = await database.query(`SELECT to_regclass('public.coral_volume_root') AS name`);
    if (volumeTable.rows[0].name) {
      const volumes = await database.query(
        `SELECT wallet, volume_parent, note FROM coral_volume_root WHERE chain_id = $1 AND lower(ido_address) = lower($2)`,
        [56, a.IDO],
      );
      volumeRoots = volumes.rows;
    }
    const roleTable = await database.query(`SELECT to_regclass('public.coral_reward_role') AS name`);
    if (roleTable.rows[0].name) {
      const roles = await database.query(
        `SELECT wallet, role, effective_block FROM coral_reward_role WHERE chain_id = $1 AND lower(ido_address) = lower($2)`,
        [56, a.IDO],
      );
      roleRows = roles.rows;
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await database.end();
  }
  console.log(`正式库账户 ${stored.length} 个，有备注 ${notes.size} 个，链上订单 ${orderRows.length} 笔，拨付记录 ${payoutRows.length} 笔。索引检查点 ${indexerLastBlock ?? "无"}。`);
  console.log(CHECK ? "这次读链上合计，不按地址读。" : "这次只读数据库，不读链。");

  const v3Block = (env.TEAM_TIER_V3_BLOCK || "").trim();
  let head = null;
  let switchUnix = null;
  let v3Unix = null;
  let directSwitchUnix = null;
  let chainTotals = null;
  let usdtBalance = null;
  let committed = null;
  let rewardCap = null;
  let historicalBudget = null;
  if (CHECK) {
    const client = await mainnetClient(env);
    head = await client.getBlockNumber();
    const switchBlock = (env.TEAM_TIER_SWITCH_BLOCK || "").trim();
    switchUnix = await blockUnix(client, switchBlock, head);
    directSwitchUnix = await blockUnix(client, directBpsBlock, head);
    v3Unix = await blockUnix(client, v3Block, head);
    for (const role of roleRows) {
      const height = BigInt(role.effective_block ?? 0);
      role.effectiveUnix = height > head ? Number.MAX_SAFE_INTEGER : await blockUnix(client, role.effective_block, head);
    }
    chainTotals = {
      totalContributed: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalContributed" }, head),
      totalImported: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalImported" }, head),
      totalDirectAccrued: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalDirectAccrued" }, head),
      totalClaimed: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalClaimed" }, head),
      totalTeamPaid: await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "totalTeamPaid" }, head),
    };
    usdtBalance = await readOrFail(client, { address: USDT, abi: ERC20, functionName: "balanceOf", args: [a.IDO] }, head);
    committed = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "committed" }, head);
    rewardCap = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "rewardCap" }, head);
    historicalBudget = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "historicalTeamBudget" }, head);
    const directBps = await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "directReferralBps" }, head);
    chainTotals.directBpsProblem = directBpsProblem(directBps, head, v3Block);
  }

  const orders = orderRows.map((row) => {
    const unix = unixOf(row.at);
    return {
      wallet: getAddress(row.wallet),
      amountWei: weiFromUsdt(row.amount),
      tx: row.tx || "",
      unix,
      at: new Date(unix * 1000).toISOString(),
      timeText: formatShanghai(unix),
    };
  });
  const payouts = payoutRows.map((row) => ({
    wallet: getAddress(row.wallet),
    kind: row.kind === "team" ? "team" : "direct",
    amountWei: weiFromUsdt(row.amount),
    tx: row.tx || "",
    unix: unixOf(row.at),
  }));
  const rows = stored.map((row) => ({
    wallet: getAddress(row.wallet),
    referrer: row.referrer,
    selfWei: BigInt(row.self_wei),
    teamWei: BigInt(row.team_wei),
    directWei: BigInt(row.direct_wei),
    teamRewardWei: BigInt(row.team_reward_wei),
    historicalTeamRewardWei: BigInt(row.historical_team_reward_wei || 0),
    claimedWei: BigInt(row.claimed_wei),
  }));
  const built = accountsFromIndex({ rows, orders, notes });
  annotatePhase1Manual(built.accounts);
  const laid = layoutVolumeParents(built.accounts, volumeRoots);
  const checkpoint = indexerLastBlock == null ? 0n : BigInt(indexerLastBlock);
  annotateRewardRoles(built.accounts, roleRows, { head: head ?? checkpoint, v3Block });
  const orderWei = orders.reduce((sum, order) => sum + order.amountWei, 0n);
  const payoutDirectWei = payouts.filter((row) => row.kind === "direct").reduce((sum, row) => sum + row.amountWei, 0n);
  const payoutTeamWei = payouts.filter((row) => row.kind === "team").reduce((sum, row) => sum + row.amountWei, 0n);
  const books = flowsFromBooks({
    rows,
    orders,
    payouts,
    switchUnix,
    v3Unix,
    directSwitchUnix,
    roles: CHECK ? roleRows : [],
  });
  let manualWei = 0n;
  for (const account of built.accounts) {
    const manual = books.manualRewards?.get(account.wallet) ?? 0n;
    account.manualRewardWei = manual;
    manualWei += manual;
  }
  const tree = buildTree(built.accounts);
  const historicalWei = built.accounts.reduce((sum, account) => sum + account.historicalTeamRewardWei, 0n);
  const directWei = built.accounts.reduce((sum, account) => sum + account.directWei, 0n);
  const teamRewardWei = built.accounts.reduce((sum, account) => sum + account.teamRewardWei, 0n);
  const teamClaimedWei = built.accounts.reduce((sum, account) => sum + account.teamClaimedWei, 0n);
  const selfWei = built.accounts.reduce((sum, account) => sum + account.selfWei, 0n);
  const importedWei = built.accounts.reduce((sum, account) => sum + account.importedWei, 0n);
  const compared = CHECK
    ? compareIndexTotals({ selfWei, directWei, teamClaimedWei, orderWei, payoutDirectWei, payoutTeamWei, chainTotals })
    : { problems: [], warnings: [] };
  const problems = [...built.problems, ...laid.problems, ...tree.problems, ...compared.problems];
  if (chainTotals?.directBpsProblem) problems.push(chainTotals.directBpsProblem);
  const warnings = compared.warnings;
  const days = buildDailySeries(books.flows, { historicalTeamWei: historicalWei });
  const weeks = rollupWeeks(days);
  const headroom = marketHeadroom({
    contributedWei: CHECK ? chainTotals.totalContributed : selfWei - importedWei,
    importedWei: CHECK ? chainTotals.totalImported : importedWei,
    directWei,
    teamWei: teamRewardWei + historicalWei,
  });
  const review = [
    `索引本人业绩合计 ${formatUsdt(selfWei)} USDT。订单入金 ${formatUsdt(orderWei)} USDT，导入 ${formatUsdt(importedWei)} USDT。`,
    `索引直推计提 ${formatUsdt(directWei)} USDT。网体计提 ${formatUsdt(teamRewardWei + historicalWei)} USDT，其中历史网体奖 ${formatUsdt(historicalWei)} USDT。网体已领 ${formatUsdt(teamClaimedWei)} USDT。`,
    `拨付表记录直推领取 ${formatUsdt(payoutDirectWei)} USDT，网体领取 ${formatUsdt(payoutTeamWei)} USDT。`,
    `链下另计 ${formatUsdt(manualWei)} USDT。这是内部标记的 9%，不进发布 root，按地址人工拨付。`,
    `市场拨比 ${ratioText(headroom.ratioBps)}。25% 帽是 ${formatUsdt(headroom.cap)} USDT，${headroom.room >= 0n ? `还剩 ${formatUsdt(headroom.room)} USDT` : `已超过 ${formatUsdt(-headroom.room)} USDT`}。`,
  ];
  if (CHECK) {
    const paid = chainTotals.totalClaimed + chainTotals.totalTeamPaid;
    const afterPayouts = chainTotals.totalContributed - paid;
    const gap = usdtBalance - afterPayouts;
    const unpublished = teamRewardWei + historicalWei - committed;
    review.push(
      `链上收款 ${formatUsdt(chainTotals.totalContributed)} USDT，导入 ${formatUsdt(chainTotals.totalImported)} USDT。直推已领 ${formatUsdt(chainTotals.totalClaimed)} USDT，网体已领 ${formatUsdt(chainTotals.totalTeamPaid)} USDT。`,
      `收款减去已领是 ${formatUsdt(afterPayouts)} USDT。金库 USDT 余额 ${formatUsdt(usdtBalance)} USDT。${gap === 0n ? "两项一致。" : `差额 ${formatUsdt(gap)} USDT，是另行转入的备付，或提走后没有记成领取的钱。`}`,
      `奖励合约当前帽 ${formatUsdt(rewardCap)} USDT，已发布承诺 ${formatUsdt(committed)} USDT，索引网体计提比已发布多 ${formatUsdt(unpublished)} USDT。历史网体预算 ${formatUsdt(historicalBudget)} USDT。`,
    );
  }
  const volumeMode = volumeRoots.length > 0;
  const notesForPage = [
    volumeMode
      ? "入金时间来自正式库的链上订单，领取时间来自拨付表。业绩按计算上级重算。直推、网体和合计仍是索引里已经记下的数字。"
      : "入金时间来自正式库的链上订单，领取时间来自拨付表。节点上的业绩和收益来自索引。",
    "标了「一期手动」的直推和拨付是第一期线下转的，不在索引里，也不进合计和发布 root。",
    "网体业绩和网体计提合约不按地址保存。增长图按订单重放，仍沿链上推荐人，不带 --check 时不知道档位切换的链上时间。",
    ...laid.notes,
    ...warnings,
  ];
  if (!CHECK) notesForPage.push("这次没有读链。要对合计，再跑 npm run network:check。");
  if (indexerLastBlock != null) notesForPage.push(CHECK ? `索引检查点在区块 ${indexerLastBlock}，链头是 ${head}。` : `索引检查点在区块 ${indexerLastBlock}。`);
  const generatedAt = new Date().toISOString();
  const snapshot = {
    ok: problems.length === 0,
    database: db.name,
    generatedAt,
    chainId: 56,
    ido: a.IDO,
    rewards: a.REWARDS,
    checked: CHECK,
    head: head == null ? null : head.toString(),
    indexerLastBlock: indexerLastBlock == null ? null : String(indexerLastBlock),
    notes: notesForPage,
    problems,
    warnings,
    totals: {
      contributedWei: (CHECK ? chainTotals.totalContributed : orderWei).toString(),
      importedWei: (CHECK ? chainTotals.totalImported : importedWei).toString(),
      directWei: directWei.toString(),
      teamRewardWei: teamRewardWei.toString(),
      manualRewardWei: manualWei.toString(),
      historicalTeamRewardWei: historicalWei.toString(),
      directClaimedWei: (CHECK ? chainTotals.totalClaimed : payoutDirectWei).toString(),
      teamClaimedWei: teamClaimedWei.toString(),
      usdtBalanceWei: usdtBalance == null ? null : usdtBalance.toString(),
      rewardCapWei: rewardCap == null ? null : rewardCap.toString(),
      committedWei: committed == null ? null : committed.toString(),
      historicalBudgetWei: historicalBudget == null ? null : historicalBudget.toString(),
      ratioBps: headroom.ratioBps.toString(),
      indexedImportedWei: importedWei.toString(),
      selfWei: selfWei.toString(),
    },
    accounts: built.accounts,
  };

  mkdirSync(DIR, { recursive: true });
  const snapshotPath = resolve(DIR, snapshotName);
  const pagePath = resolve(DIR, pageName);
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, jsonReplacer, 2)}\n`);
  writeFileSync(pagePath, renderPage({
    generatedAt,
    database: db.name,
    ido: a.IDO,
    rewards: a.REWARDS,
    safeHead: head == null ? "" : head.toString(),
    checked: CHECK,
    scope: CHECK ? `截止区块 ${head}` : `索引检查点 ${indexerLastBlock ?? "无"}`,
    problems,
    notes: notesForPage,
    roots: tree.roots,
    days,
    weeks,
    review,
    snapshotName,
    volumeMode,
  }));
  if (problems.length || warnings.length) {
    const reportPath = resolve(DIR, reportName);
    const lines = [
      ...problems.map((line) => `差异 ${line}`),
      ...warnings.map((line) => `订单或拨付表 ${line}`),
    ];
    writeFileSync(reportPath, `${lines.join("\n")}\n`);
    console.log(problems.length ? `有 ${problems.length} 条差异。` : "索引合计和链上合计一致。");
    if (warnings.length) console.log(`订单或拨付表还有 ${warnings.length} 条和链上合计不一致，写在 ${reportPath}`);
  } else if (CHECK) {
    console.log("链上合计和索引一致。");
  } else {
    console.log("已按数据库写出，没有读链。");
  }
  console.log(snapshotPath);
  console.log(pagePath);
} catch (error) {
  console.error(redact(error?.stack || error?.message || String(error), env));
  process.exit(1);
}
