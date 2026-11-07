#!/usr/bin/env node
/**
 * Read-only Coral snapshot from the production index.
 * Checks each indexed wallet against the vault and rewards contract, then writes
 * JSON and an HTML invite tree into ckey-snapshots/. Does not scan historical logs
 * and does not write the database.
 *
 *   node scripts/export-network-snapshot.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, parseAbi } from "viem";
import { USDT, ROOT, contracts, mainnetClient, readMainnetEnv, redact, selectedDatabase } from "./lib/mainnet.mjs";
import { rpcErrorText } from "./lib/reward-index.mjs";
import { directBpsProblem } from "./lib/team-reward.mjs";
import {
  accountsFromIndex,
  annotateRewardRoles,
  bigLeaderCandidates,
  buildDailySeries,
  buildTree,
  compareBooksToChain,
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
const UNIT = 10n ** 18n;
const VIEWS = parseAbi([
  "function totalContributed() view returns (uint256)",
  "function totalImported() view returns (uint256)",
  "function totalDirectAccrued() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function directReferralBps() view returns (uint256)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
]);
const REWARD_VIEWS = parseAbi([
  "function claimed(address) view returns (uint256)",
  "function totalTeamPaid() view returns (uint256)",
  "function committed() view returns (uint256)",
  "function rewardCap() view returns (uint256)",
  "function historicalTeamBudget() view returns (uint256)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

function normalizeAccount(raw) {
  if (Array.isArray(raw)) {
    const [referrer, , selfVolume, directRewards, claimed, registered] = raw;
    return { referrer, selfVolume, directRewards, claimed, registered };
  }
  return {
    referrer: raw.referrer,
    selfVolume: raw.selfVolume,
    directRewards: raw.directRewards,
    claimed: raw.claimed,
    registered: raw.registered,
  };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

async function readOrFail(client, call, blockNumber) {
  try {
    return await client.readContract({ ...call, blockNumber });
  } catch (error) {
    throw new Error(`${call.functionName} 读取失败：${rpcErrorText(error)}`);
  }
}

async function readChainAccounts(client, ido, rewards, wallets, blockNumber) {
  const out = new Map();
  let done = 0;
  await pool(wallets, 8, async (wallet) => {
    const [account, claimed] = await Promise.all([
      client.readContract({ address: ido, abi: VIEWS, functionName: "getAccount", args: [wallet], blockNumber }).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error }),
      ),
      client.readContract({ address: rewards, abi: REWARD_VIEWS, functionName: "claimed", args: [wallet], blockNumber }).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error }),
      ),
    ]);
    out.set(wallet, {
      accountOk: account.ok,
      account: account.ok ? normalizeAccount(account.result) : null,
      accountError: account.ok ? "" : rpcErrorText(account.error).slice(0, 180),
      claimedOk: claimed.ok,
      teamClaimed: claimed.ok ? claimed.result : null,
    });
    done += 1;
    if (done % 20 === 0 || done === wallets.length) console.log(`读账户 ${done}/${wallets.length}`);
  });
  return out;
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

  const client = await mainnetClient(env);
  const head = await client.getBlockNumber();
  console.log(`链头 ${head}。按地址核对金库账户和奖励合约，不扫历史日志。`);
  let switchUnix = null;
  let v3Unix = null;
  let directSwitchUnix = null;
  const switchBlock = (env.TEAM_TIER_SWITCH_BLOCK || "").trim();
  const v3Block = (env.TEAM_TIER_V3_BLOCK || "").trim();
  if (switchBlock && switchBlock !== "0") {
    const block = await client.getBlock({ blockNumber: BigInt(switchBlock) });
    switchUnix = Number(block.timestamp);
  }
  if (directBpsBlock != null && BigInt(directBpsBlock) <= head) {
    const block = await client.getBlock({ blockNumber: BigInt(directBpsBlock) });
    directSwitchUnix = Number(block.timestamp);
  }
  if (v3Block && v3Block !== "0" && BigInt(v3Block) <= head) {
    const block = await client.getBlock({ blockNumber: BigInt(v3Block) });
    v3Unix = Number(block.timestamp);
  }
  const chainTotals = {
    totalContributed: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalContributed" }, head),
    totalImported: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalImported" }, head),
    totalDirectAccrued: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalDirectAccrued" }, head),
    totalClaimed: await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "totalClaimed" }, head),
    totalTeamPaid: await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "totalTeamPaid" }, head),
  };
  const usdtBalance = await readOrFail(client, { address: USDT, abi: ERC20, functionName: "balanceOf", args: [a.IDO] }, head);
  const committed = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "committed" }, head);
  const rewardCap = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "rewardCap" }, head);
  const historicalBudget = await readOrFail(client, { address: a.REWARDS, abi: REWARD_VIEWS, functionName: "historicalTeamBudget" }, head);

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
  annotateRewardRoles(built.accounts, roleRows, { head, v3Block });
  const roleTimes = new Map();
  for (const role of roleRows) {
    const block = BigInt(role.effective_block);
    if (block > head) {
      role.effectiveUnix = "9007199254740991";
      continue;
    }
    if (!roleTimes.has(String(role.effective_block))) {
      const fetched = await client.getBlock({ blockNumber: block });
      roleTimes.set(String(role.effective_block), Number(fetched.timestamp));
    }
    role.effectiveUnix = roleTimes.get(String(role.effective_block));
  }
  const wallets = built.accounts.map((account) => account.wallet);
  const chainByWallet = await readChainAccounts(client, a.IDO, a.REWARDS, wallets, head);
  const orderWei = orders.reduce((sum, order) => sum + order.amountWei, 0n);
  const payoutDirectWei = payouts.filter((row) => row.kind === "direct").reduce((sum, row) => sum + row.amountWei, 0n);
  const payoutTeamWei = payouts.filter((row) => row.kind === "team").reduce((sum, row) => sum + row.amountWei, 0n);
  const checked = compareBooksToChain({
    accounts: built.accounts,
    chainByWallet,
    chainTotals,
    orderWei,
    payoutDirectWei,
    payoutTeamWei,
  });
  const replayProblems = [];
  const books = flowsFromBooks({ rows, orders, payouts, switchUnix, v3Unix, directSwitchUnix, roles: roleRows });
  const replayByWallet = new Map(books.rows.map((row) => [getAddress(row.wallet), row]));
  for (const account of built.accounts) {
    const replay = replayByWallet.get(account.wallet);
    if (!replay) continue;
    if (replay.teamWei !== account.teamWei) replayProblems.push(`${account.wallet.slice(0, 6)}…${account.wallet.slice(-4)} 按订单重放的伞下 ${formatUsdt(replay.teamWei)} USDT，索引 ${formatUsdt(account.teamWei)} USDT`);
    if (replay.teamRewardWei !== account.teamRewardWei) replayProblems.push(`${account.wallet.slice(0, 6)}…${account.wallet.slice(-4)} 按订单重放的网体奖 ${formatUsdt(replay.teamRewardWei)} USDT，索引 ${formatUsdt(account.teamRewardWei)} USDT`);
    if (replay.directWei !== account.directWei) replayProblems.push(`${account.wallet.slice(0, 6)}…${account.wallet.slice(-4)} 按订单重放的直推 ${formatUsdt(replay.directWei)} USDT，索引 ${formatUsdt(account.directWei)} USDT`);
  }
  const problems = [...built.problems, ...checked.accountProblems];
  const directBps = await readOrFail(client, { address: a.IDO, abi: VIEWS, functionName: "directReferralBps" }, head);
  const bpsProblem = directBpsProblem(directBps, head, v3Block);
  if (bpsProblem) problems.push(bpsProblem);
  const candidates = bigLeaderCandidates(built.accounts);
  const warnings = [...checked.ledgerProblems, ...replayProblems];
  const tree = buildTree(built.accounts);
  problems.push(...tree.problems);

  const historicalWei = built.accounts.reduce((sum, account) => sum + account.historicalTeamRewardWei, 0n);
  const directWei = built.accounts.reduce((sum, account) => sum + account.directWei, 0n);
  const teamRewardWei = built.accounts.reduce((sum, account) => sum + account.teamRewardWei, 0n);
  const importedWei = built.accounts.reduce((sum, account) => sum + account.importedWei, 0n);
  const days = buildDailySeries(books.flows, { historicalTeamWei: historicalWei });
  const weeks = rollupWeeks(days);
  const headroom = marketHeadroom({
    contributedWei: chainTotals.totalContributed,
    importedWei: chainTotals.totalImported,
    directWei,
    teamWei: teamRewardWei + historicalWei,
  });
  const paid = chainTotals.totalClaimed + chainTotals.totalTeamPaid;
  const afterPayouts = chainTotals.totalContributed - paid;
  const gap = usdtBalance - afterPayouts;
  const review = [
    `累计收款 ${formatUsdt(chainTotals.totalContributed)} USDT，导入业绩 ${formatUsdt(chainTotals.totalImported)} USDT。`,
    `直推已领取 ${formatUsdt(chainTotals.totalClaimed)} USDT，网体已领取 ${formatUsdt(chainTotals.totalTeamPaid)} USDT。收款减去这两项是 ${formatUsdt(afterPayouts)} USDT。链上金库 USDT 余额 ${formatUsdt(usdtBalance)} USDT。`,
    gap === 0n
      ? "链上余额和收款减去已领取一致。"
      : `余额和这项差 ${formatUsdt(gap)} USDT。差出来的是另行转入的备付，或从金库提走、没有记成领取的钱。`,
    `直推计提 ${formatUsdt(directWei)} USDT。网体计提 ${formatUsdt(teamRewardWei + historicalWei)} USDT，其中历史网体奖 ${formatUsdt(historicalWei)} USDT。`,
    `市场拨比 ${ratioText(headroom.ratioBps)}。25% 帽是 ${formatUsdt(headroom.cap)} USDT，${headroom.room >= 0n ? `还剩 ${formatUsdt(headroom.room)} USDT` : `已超过 ${formatUsdt(-headroom.room)} USDT`}。`,
    `奖励合约当前帽 ${formatUsdt(rewardCap)} USDT，已发布承诺 ${formatUsdt(committed)} USDT，历史网体预算 ${formatUsdt(historicalBudget)} USDT。`,
  ];
  const notesForPage = [
    "入金时间来自正式库的链上订单，领取时间来自拨付表。没有重扫历史日志。",
    "每个地址的上级、本人业绩、直推计提和网体已领已和合约核对。网体业绩和网体计提是索引算出来的，合约不按地址保存这两项。",
    ...warnings,
  ];
  if (indexerLastBlock != null) notesForPage.push(`索引检查点在区块 ${indexerLastBlock}，这次读取的链头是 ${head}。`);
  if (candidates.length) notesForPage.push(`大团队长候选，尚未标记：${candidates.join("，")}。本人满 1 万，或本人满 1000 且至少 3 个直推下级各自满 1000。这不是标记。`);
  const generatedAt = new Date().toISOString();
  const snapshot = {
    ok: problems.length === 0,
    database: db.name,
    generatedAt,
    chainId: 56,
    ido: a.IDO,
    rewards: a.REWARDS,
    head: head.toString(),
    indexerLastBlock: indexerLastBlock == null ? null : String(indexerLastBlock),
    notes: notesForPage,
    problems,
    warnings,
    totals: {
      contributedWei: chainTotals.totalContributed.toString(),
      importedWei: chainTotals.totalImported.toString(),
      directWei: directWei.toString(),
      teamRewardWei: teamRewardWei.toString(),
      historicalTeamRewardWei: historicalWei.toString(),
      directClaimedWei: chainTotals.totalClaimed.toString(),
      teamClaimedWei: chainTotals.totalTeamPaid.toString(),
      usdtBalanceWei: usdtBalance.toString(),
      rewardCapWei: rewardCap.toString(),
      committedWei: committed.toString(),
      historicalBudgetWei: historicalBudget.toString(),
      ratioBps: headroom.ratioBps.toString(),
      indexedImportedWei: importedWei.toString(),
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
    safeHead: head.toString(),
    problems,
    notes: notesForPage,
    roots: tree.roots,
    days,
    weeks,
    review,
    snapshotName,
  }));
  if (problems.length || warnings.length) {
    const reportPath = resolve(DIR, reportName);
    const lines = [
      ...problems.map((line) => `差异 ${line}`),
      ...warnings.map((line) => `订单或拨付表 ${line}`),
    ];
    writeFileSync(reportPath, `${lines.join("\n")}\n`);
    console.log(problems.length ? `合约核对有 ${problems.length} 条差异。` : "每个地址的合约字段和索引一致。");
    if (warnings.length) console.log(`订单或拨付表还有 ${warnings.length} 条和合约合计不一致，写在 ${reportPath}`);
  } else {
    console.log("核对通过。");
  }
  console.log(snapshotPath);
  console.log(pagePath);
} catch (error) {
  console.error(redact(error?.stack || error?.message || String(error), env));
  process.exit(1);
}
