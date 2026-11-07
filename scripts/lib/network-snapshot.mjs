import { getAddress, zeroAddress } from "viem";
import { applyLog, accountRows, emptyIndexState, sortLogs } from "./reward-index.mjs";
import {
  bind,
  blockAtLeast,
  bpsForAccount,
  contribute,
  createState,
  noteImportedSelf,
  rewardOptionsForTime,
  setRole,
} from "./team-reward.mjs";

const UNIT = 10n ** 18n;
const CAP_BPS = 2500n;

function sumMap(map) {
  let total = 0n;
  for (const value of map.values()) total += value;
  return total;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Local `YYYYMMDD-HHMMSS`, for snapshot file names. */
export function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Exact USDT, grouped thousands, no rounding. Trailing zeros after the point are dropped. */
export function formatUsdt(wei) {
  const value = BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function shanghaiDay(unix) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(unix) * 1000));
}

/** `MM-DD HH:mm` in Asia/Shanghai. */
export function formatShanghai(unix) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(unix) * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Monday of the Shanghai calendar day, as `YYYY-MM-DD`. */
export function weekStart(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function pushFlow(flows, kind, log, amountWei) {
  if (amountWei === 0n) return;
  flows.push({
    kind,
    block: Number(log.blockNumber),
    logIndex: Number(log.logIndex ?? 0),
    amountWei,
  });
}

/**
 * Replay vault and rewards logs from an empty book.
 * Team claims leave the vault through TeamDisbursed, so that event is the outflow.
 * TeamClaimed is the same payment recorded on the rewards contract.
 */
export function replayNetwork(logs, { tierSwitchBlock = "", tierV3Block = "", roles = [] } = {}) {
  const state = emptyIndexState();
  state.tierSwitchBlock = tierSwitchBlock;
  state.tierV3Block = tierV3Block;
  for (const role of roles) {
    setRole(state, getAddress(role.wallet), role.role, role.effectiveBlock ?? role.effective_block);
  }
  const deposits = new Map();
  const imported = new Map();
  const directClaimed = new Map();
  const directClaimLogs = [];
  const teamClaimLogs = [];
  const flows = [];
  const sums = {
    contributed: 0n,
    imported: 0n,
    directEvents: 0n,
    directClaimed: 0n,
    teamClaimedPaid: 0n,
    teamDisbursed: 0n,
    treasury: 0n,
  };

  for (const log of sortLogs(logs)) {
    const name = log.eventName;
    if (name === "Contributed") {
      const wallet = getAddress(log.args.account);
      const amount = BigInt(log.args.amount);
      const beforeDirect = sumMap(state.direct);
      const beforeTeam = sumMap(state.teamRewards);
      applyLog(state, log);
      const list = deposits.get(wallet) || [];
      list.push({
        block: Number(log.blockNumber),
        logIndex: Number(log.logIndex ?? 0),
        tx: log.transactionHash,
        amountWei: amount,
      });
      deposits.set(wallet, list);
      pushFlow(flows, "in", log, amount);
      pushFlow(flows, "directAccrued", log, sumMap(state.direct) - beforeDirect);
      pushFlow(flows, "teamAccrued", log, sumMap(state.teamRewards) - beforeTeam);
      sums.contributed += amount;
      continue;
    }
    if (name === "VolumeImported") {
      const wallet = getAddress(log.args.account);
      const before = state.self.get(wallet) ?? 0n;
      applyLog(state, log);
      const delta = (state.self.get(wallet) ?? 0n) - before;
      imported.set(wallet, (imported.get(wallet) ?? 0n) + delta);
      pushFlow(flows, "import", log, delta);
      sums.imported += delta;
      continue;
    }
    if (name === "Claimed") {
      const wallet = getAddress(log.args.account);
      const amount = BigInt(log.args.amount);
      directClaimed.set(wallet, (directClaimed.get(wallet) ?? 0n) + amount);
      directClaimLogs.push({ tx: log.transactionHash, wallet, amountWei: amount });
      pushFlow(flows, "directClaim", log, amount);
      sums.directClaimed += amount;
      continue;
    }
    if (name === "TeamClaimed") {
      const wallet = getAddress(log.args.account);
      const paid = BigInt(log.args.paid);
      applyLog(state, log);
      teamClaimLogs.push({ tx: log.transactionHash, wallet, amountWei: paid });
      pushFlow(flows, "teamClaim", log, paid);
      sums.teamClaimedPaid += paid;
      continue;
    }
    if (name === "TeamDisbursed") {
      const amount = BigInt(log.args.amount);
      pushFlow(flows, "teamDisburse", log, amount);
      sums.teamDisbursed += amount;
      continue;
    }
    if (name === "TreasuryWithdrawn") {
      const amount = BigInt(log.args.amount);
      pushFlow(flows, "treasury", log, amount);
      sums.treasury += amount;
      continue;
    }
    if (name === "DirectRewardAccrued") {
      sums.directEvents += BigInt(log.args.amount);
      continue;
    }
    applyLog(state, log);
  }

  return {
    rows: accountRows(state),
    deposits,
    imported,
    directClaimed,
    directClaimLogs,
    teamClaimLogs,
    flows,
    sums,
  };
}

function noteOf(notes, wallet) {
  if (!notes) return null;
  const text = notes.get(wallet.toLowerCase()) ?? notes.get(wallet) ?? null;
  const trimmed = text == null ? "" : String(text).trim();
  return trimmed ? trimmed : null;
}

/**
 * One row per replayed wallet.
 * Network volume includes self. Network reward adds the indexed historical team reward.
 */
export function assembleAccounts({ rows, deposits, imported, directClaimed, notes, historical, blockTime }) {
  const problems = [];
  const accounts = rows.map((row) => {
    const wallet = getAddress(row.wallet);
    const depositList = (deposits.get(wallet) || []).map((deposit) => {
      const unix = blockTime.get(deposit.block);
      if (unix == null) throw new Error(`没有区块 ${deposit.block} 的时间`);
      return {
        at: new Date(unix * 1000).toISOString(),
        timeText: formatShanghai(unix),
        amountWei: deposit.amountWei,
        tx: deposit.tx,
        block: String(deposit.block),
      };
    });
    const importedWei = imported.get(wallet) ?? 0n;
    const historicalWei = historical?.get(wallet) ?? 0n;
    const selfWei = row.selfWei;
    const depositSum = depositList.reduce((sum, deposit) => sum + deposit.amountWei, 0n);
    if (depositSum + importedWei !== selfWei) {
      problems.push(`${wallet} 入金加导入 ${depositSum + importedWei} 和本人业绩 ${selfWei} 不同`);
    }
    return {
      wallet,
      referrer: row.referrer ? getAddress(row.referrer) : null,
      note: noteOf(notes, wallet),
      deposits: depositList,
      importedWei,
      selfWei,
      teamWei: row.teamWei,
      networkWei: selfWei + row.teamWei,
      directWei: row.directWei,
      teamRewardWei: row.teamRewardWei,
      historicalTeamRewardWei: historicalWei,
      networkRewardWei: row.teamRewardWei + historicalWei,
      totalRewardWei: row.directWei + row.teamRewardWei + historicalWei,
      directClaimedWei: directClaimed.get(wallet) ?? 0n,
      teamClaimedWei: row.claimedWei,
    };
  });
  return { accounts, problems };
}

function referrerOf(value) {
  if (!value) return null;
  const address = getAddress(value);
  return address === zeroAddress ? null : address;
}

function cmpNode(a, b) {
  if (a.networkWei !== b.networkWei) return a.networkWei > b.networkWei ? -1 : 1;
  return (a.wallet || "").localeCompare(b.wallet || "");
}

function sortTree(node) {
  node.children.sort(cmpNode);
  for (const child of node.children) sortTree(child);
}

/**
 * Roots have no referrer. More than one root sits under a synthetic 全部 node.
 * That node's volume is the sum of each wallet's own volume, so umbrellas are not counted twice.
 */
export function buildTree(accounts) {
  const problems = [];
  const byWallet = new Map();
  for (const account of accounts) {
    byWallet.set(account.wallet, { ...account, children: [] });
  }
  const roots = [];
  for (const node of byWallet.values()) {
    const parent = node.referrer ? byWallet.get(node.referrer) : null;
    if (!node.referrer || !parent) {
      if (node.referrer && !parent) problems.push(`${node.wallet} 的上级 ${node.referrer} 不在这次重放里`);
      roots.push(node);
      continue;
    }
    let cursor = parent;
    const seen = new Set([node.wallet]);
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor.wallet)) {
        cycle = true;
        break;
      }
      seen.add(cursor.wallet);
      cursor = cursor.referrer ? byWallet.get(cursor.referrer) : null;
    }
    if (cycle) {
      problems.push(`${node.wallet} 的邀请关系成环，这一支改挂在根上`);
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }
  roots.sort(cmpNode);
  for (const root of roots) sortTree(root);
  if (roots.length <= 1) return { roots, problems };

  const sum = (pick) => accounts.reduce((total, account) => total + pick(account), 0n);
  const depositWei = sum((account) => account.deposits.reduce((total, deposit) => total + deposit.amountWei, 0n));
  const all = {
    all: true,
    wallet: null,
    referrer: null,
    note: null,
    deposits: [],
    depositCount: accounts.reduce((total, account) => total + account.deposits.length, 0),
    depositWei,
    importedWei: sum((account) => account.importedWei),
    selfWei: sum((account) => account.selfWei),
    teamWei: 0n,
    networkWei: sum((account) => account.selfWei),
    directWei: sum((account) => account.directWei),
    teamRewardWei: sum((account) => account.teamRewardWei),
    historicalTeamRewardWei: sum((account) => account.historicalTeamRewardWei),
    networkRewardWei: sum((account) => account.networkRewardWei),
    totalRewardWei: sum((account) => account.totalRewardWei),
    directClaimedWei: sum((account) => account.directClaimedWei),
    teamClaimedWei: sum((account) => account.teamClaimedWei),
    children: roots,
  };
  return { roots: [all], problems };
}

function addDays(dayKey, days) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function pointFrom(key, label, running, newIn) {
  const volume = running.cumIn + running.imported;
  const rewards = running.directAccrued + running.teamAccrued;
  const ratioBps = volume === 0n ? 0n : (rewards * 10000n) / volume;
  const remain = running.cumIn - running.directClaimed - running.teamDisbursed - running.treasury;
  return {
    key,
    label,
    newInWei: newIn.toString(),
    cumInWei: running.cumIn.toString(),
    remainWei: remain.toString(),
    teamAccruedWei: running.teamAccrued.toString(),
    teamClaimedWei: running.teamClaimed.toString(),
    ratioBps: Number(ratioBps),
    newInText: formatUsdt(newIn),
    cumInText: formatUsdt(running.cumIn),
    remainText: formatUsdt(remain),
    teamAccruedText: formatUsdt(running.teamAccrued),
    teamClaimedText: formatUsdt(running.teamClaimed),
    ratioText: ratioText(ratioBps),
  };
}

export function ratioText(bps) {
  const value = BigInt(bps);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

function differ(problems, wallet, label, indexed, chain) {
  if (BigInt(indexed) !== BigInt(chain)) problems.push(`${wallet} ${label}：索引 ${indexed}，合约 ${chain}`);
}

function walletOrders(orders) {
  const grouped = new Map();
  for (const order of orders) {
    const wallet = getAddress(order.wallet);
    const list = grouped.get(wallet) || [];
    list.push(order);
    grouped.set(wallet, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => Number(a.unix) - Number(b.unix) || String(a.tx).localeCompare(String(b.tx)));
  return grouped;
}

/**
 * Tree rows from the index. Live deposits come from chain orders.
 * The rest of self volume is imported history and is not given a deposit time.
 */
export function accountsFromIndex({ rows, orders, notes }) {
  const grouped = walletOrders(orders);
  const problems = [];
  const seen = new Set();
  const accounts = rows.map((row) => {
    const wallet = getAddress(row.wallet);
    seen.add(wallet);
    const selfWei = BigInt(row.selfWei ?? row.self_wei);
    const teamWei = BigInt(row.teamWei ?? row.team_wei);
    const directWei = BigInt(row.directWei ?? row.direct_wei);
    const teamRewardWei = BigInt(row.teamRewardWei ?? row.team_reward_wei);
    const historicalWei = BigInt(row.historicalTeamRewardWei ?? row.historical_team_reward_wei ?? 0);
    const deposits = (grouped.get(wallet) || []).map((order) => ({
      at: order.at,
      timeText: order.timeText,
      amountWei: BigInt(order.amountWei),
      tx: order.tx || "",
      block: order.block || "",
    }));
    const deposited = deposits.reduce((sum, deposit) => sum + deposit.amountWei, 0n);
    let importedWei = selfWei - deposited;
    if (importedWei < 0n) {
      problems.push(`${wallet} 订单合计 ${deposited} 大于索引本人业绩 ${selfWei}`);
      importedWei = 0n;
    }
    return {
      wallet,
      referrer: referrerOf(row.referrer),
      note: noteOf(notes, wallet),
      deposits,
      importedWei,
      selfWei,
      teamWei,
      networkWei: selfWei + teamWei,
      directWei,
      teamRewardWei,
      historicalTeamRewardWei: historicalWei,
      networkRewardWei: teamRewardWei + historicalWei,
      totalRewardWei: directWei + teamRewardWei + historicalWei,
      directClaimedWei: BigInt(row.directClaimedWei ?? 0),
      teamClaimedWei: BigInt(row.claimedWei ?? row.claimed_wei ?? 0),
    };
  });
  for (const wallet of grouped.keys()) {
    if (seen.has(wallet)) continue;
    problems.push(`${wallet} 有链上订单，索引里没有这个地址`);
  }
  return { accounts, problems };
}

/**
 * Rebuild the daily accrual from indexed orders. Imports are applied before the first order.
 * This does not read chain logs. A team payout is both the claim and the vault outflow.
 */
export function flowsFromBooks({ rows, orders, payouts = [], switchUnix = null, v3Unix = null, directSwitchUnix = null, roles = [] }) {
  const state = emptyIndexState();
  for (const row of rows) bind(state, getAddress(row.wallet), referrerOf(row.referrer));
  for (const role of roles) {
    setRole(state, getAddress(role.wallet), role.role, null, role.effectiveUnix ?? role.effective_unix);
  }
  const grouped = walletOrders(orders);
  const imported = new Map();
  for (const row of rows) {
    const wallet = getAddress(row.wallet);
    const deposited = (grouped.get(wallet) || []).reduce((sum, order) => sum + BigInt(order.amountWei), 0n);
    const importedWei = BigInt(row.selfWei ?? row.self_wei) - deposited;
    if (importedWei <= 0n) continue;
    noteImportedSelf(state, wallet, importedWei);
    imported.set(wallet, importedWei);
  }
  const times = [...orders, ...payouts].map((row) => Number(row.unix)).filter((unix) => Number.isFinite(unix));
  const firstUnix = times.length ? Math.min(...times) : Math.floor(Date.now() / 1000);
  const flows = [];
  let index = 0;
  for (const amountWei of imported.values()) {
    index += 1;
    flows.push({ kind: "import", block: 0, logIndex: index, unix: firstUnix, amountWei });
  }
  const sorted = [...orders].sort((a, b) => Number(a.unix) - Number(b.unix) || String(a.tx).localeCompare(String(b.tx)));
  for (const order of sorted) {
    const wallet = getAddress(order.wallet);
    const amount = BigInt(order.amountWei);
    const unix = Number(order.unix);
    const beforeDirect = sumMap(state.direct);
    const beforeTeam = sumMap(state.teamRewards);
    if (!state.referrer.has(wallet)) bind(state, wallet, null);
    contribute(state, wallet, amount, rewardOptionsForTime(unix, { switchUnix, v3Unix, directSwitchUnix }));
    index += 1;
    flows.push({ kind: "in", block: unix, logIndex: index, unix, amountWei: amount });
    const directDelta = sumMap(state.direct) - beforeDirect;
    const teamDelta = sumMap(state.teamRewards) - beforeTeam;
    if (directDelta !== 0n) flows.push({ kind: "directAccrued", block: unix, logIndex: index, unix, amountWei: directDelta });
    if (teamDelta !== 0n) flows.push({ kind: "teamAccrued", block: unix, logIndex: index, unix, amountWei: teamDelta });
  }
  for (const payout of payouts) {
    const amount = BigInt(payout.amountWei);
    const unix = Number(payout.unix);
    index += 1;
    if (payout.kind === "team") {
      flows.push({ kind: "teamClaim", block: unix, logIndex: index, unix, amountWei: amount });
      flows.push({ kind: "teamDisburse", block: unix, logIndex: index, unix, amountWei: amount });
    } else {
      flows.push({ kind: "directClaim", block: unix, logIndex: index, unix, amountWei: amount });
    }
  }
  return { rows: accountRows(state), flows, imported };
}

/**
 * Check the index against the vault fields the contract actually stores.
 * Team volume and team rewards are not stored per address on the vault.
 */
export function compareBooksToChain({ accounts, chainByWallet, chainTotals, orderWei, payoutDirectWei = 0n, payoutTeamWei = 0n }) {
  const accountProblems = [];
  const ledgerProblems = [];
  let selfSum = 0n;
  let directSum = 0n;
  let teamClaimedSum = 0n;
  let directClaimedSum = 0n;
  for (const account of accounts) {
    selfSum += account.selfWei;
    directSum += account.directWei;
    teamClaimedSum += account.teamClaimedWei;
    const chain = chainByWallet?.get(account.wallet);
    if (!chain) {
      accountProblems.push(`${account.wallet} 没有读到链上账户`);
      continue;
    }
    if (!chain.accountOk || !chain.account) {
      accountProblems.push(`${account.wallet} 读金库账户失败${chain.accountError ? `：${chain.accountError}` : ""}`);
      continue;
    }
    const onChain = chain.account;
    if (!onChain.registered) accountProblems.push(`${account.wallet} 在索引里，金库 getAccount 未注册`);
    if (!sameAddress(onChain.referrer, account.referrer)) {
      accountProblems.push(`${account.wallet} 金库上级 ${referrerOf(onChain.referrer) || "无"}，索引 ${account.referrer || "无"}`);
    }
    differ(accountProblems, account.wallet, "本人业绩", account.selfWei, onChain.selfVolume);
    differ(accountProblems, account.wallet, "直推计提", account.directWei, onChain.directRewards);
    if (!chain.claimedOk) accountProblems.push(`${account.wallet} 读奖励合约已领失败`);
    else differ(accountProblems, account.wallet, "网体已领", account.teamClaimedWei, chain.teamClaimed);
    directClaimedSum += BigInt(onChain.claimed);
  }
  if (chainTotals) {
    const volume = BigInt(chainTotals.totalContributed) + BigInt(chainTotals.totalImported);
    if (selfSum !== volume) accountProblems.push(`索引本人业绩合计 ${formatUsdt(selfSum)} USDT，金库收款加导入 ${formatUsdt(volume)} USDT`);
    if (directSum !== BigInt(chainTotals.totalDirectAccrued)) {
      accountProblems.push(`索引直推计提合计 ${formatUsdt(directSum)} USDT，金库 totalDirectAccrued ${formatUsdt(chainTotals.totalDirectAccrued)} USDT`);
    }
    if (teamClaimedSum !== BigInt(chainTotals.totalTeamPaid)) {
      accountProblems.push(`索引网体已领合计 ${formatUsdt(teamClaimedSum)} USDT，奖励合约 totalTeamPaid ${formatUsdt(chainTotals.totalTeamPaid)} USDT`);
    }
    if (directClaimedSum !== BigInt(chainTotals.totalClaimed)) {
      accountProblems.push(`金库各地址直推已领合计 ${formatUsdt(directClaimedSum)} USDT，totalClaimed ${formatUsdt(chainTotals.totalClaimed)} USDT`);
    }
    if (orderWei !== BigInt(chainTotals.totalContributed)) {
      ledgerProblems.push(`库里链上订单合计 ${formatUsdt(orderWei)} USDT，金库 totalContributed ${formatUsdt(chainTotals.totalContributed)} USDT`);
    }
    if (payoutDirectWei !== BigInt(chainTotals.totalClaimed)) {
      ledgerProblems.push(`拨付表直推领取 ${formatUsdt(payoutDirectWei)} USDT，金库 totalClaimed ${formatUsdt(chainTotals.totalClaimed)} USDT`);
    }
    if (payoutTeamWei !== BigInt(chainTotals.totalTeamPaid)) {
      ledgerProblems.push(`拨付表网体领取 ${formatUsdt(payoutTeamWei)} USDT，奖励合约 totalTeamPaid ${formatUsdt(chainTotals.totalTeamPaid)} USDT`);
    }
  }
  return { accountProblems, ledgerProblems };
}

/**
 * One point per Shanghai day from the first flow through the last.
 * Historical team rewards are included from the first day.
 * Vault remaining subtracts direct claims, team disbursements and treasury withdrawals once.
 */
export function buildDailySeries(flows, { historicalTeamWei = 0n } = {}) {
  const ordered = flows.slice().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || a.kind.localeCompare(b.kind));
  const running = {
    cumIn: 0n,
    imported: 0n,
    directAccrued: 0n,
    teamAccrued: BigInt(historicalTeamWei),
    directClaimed: 0n,
    teamClaimed: 0n,
    teamDisbursed: 0n,
    treasury: 0n,
  };
  const byDay = new Map();
  for (const flow of ordered) {
    if (flow.unix == null) throw new Error(`流水缺少时间（区块 ${flow.block}）`);
    const amount = BigInt(flow.amountWei);
    if (flow.kind === "in") running.cumIn += amount;
    else if (flow.kind === "import") running.imported += amount;
    else if (flow.kind === "directAccrued") running.directAccrued += amount;
    else if (flow.kind === "teamAccrued") running.teamAccrued += amount;
    else if (flow.kind === "directClaim") running.directClaimed += amount;
    else if (flow.kind === "teamClaim") running.teamClaimed += amount;
    else if (flow.kind === "teamDisburse") running.teamDisbursed += amount;
    else if (flow.kind === "treasury") running.treasury += amount;
    else throw new Error(`未知流水 ${flow.kind}`);
    const key = shanghaiDay(flow.unix);
    const bucket = byDay.get(key) || { newIn: 0n };
    if (flow.kind === "in") bucket.newIn += amount;
    bucket.running = { ...running };
    byDay.set(key, bucket);
  }
  const keys = [...byDay.keys()].sort();
  if (keys.length === 0) return [];
  const points = [];
  let previous = {
    cumIn: 0n,
    imported: 0n,
    directAccrued: 0n,
    teamAccrued: BigInt(historicalTeamWei),
    directClaimed: 0n,
    teamClaimed: 0n,
    teamDisbursed: 0n,
    treasury: 0n,
  };
  for (let key = keys[0]; key <= keys[keys.length - 1]; key = addDays(key, 1)) {
    const bucket = byDay.get(key);
    if (bucket) previous = bucket.running;
    points.push(pointFrom(key, `${key.slice(5)}`, previous, bucket ? bucket.newIn : 0n));
  }
  return points;
}

/** Week buckets start Monday. New receipts add up. The other figures are the week's last day. */
export function rollupWeeks(days) {
  const groups = new Map();
  for (const day of days) {
    const key = weekStart(day.key);
    const group = groups.get(key) || { key, newIn: 0n, last: null };
    group.newIn += BigInt(day.newInWei);
    group.last = day;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group.last,
    key: group.key,
    label: `${group.key.slice(5)} 当周`,
    newInWei: group.newIn.toString(),
    newInText: formatUsdt(group.newIn),
  }));
}

export function marketHeadroom({ contributedWei, importedWei, directWei, teamWei }) {
  const volume = BigInt(contributedWei) + BigInt(importedWei);
  const rewards = BigInt(directWei) + BigInt(teamWei);
  const cap = (volume * CAP_BPS) / 10000n;
  const ratioBps = volume === 0n ? 0n : (rewards * 10000n) / volume;
  return { volume, rewards, cap, ratioBps, room: cap - rewards };
}

function sameAddress(left, right) {
  const a = referrerOf(left);
  const b = referrerOf(right);
  return a === b;
}

function pushAmount(problems, wallet, label, actual, expected) {
  if (BigInt(actual) !== BigInt(expected)) problems.push(`${wallet} ${label} ${expected}，链上重放 ${actual}`);
}

/**
 * Chain totals and getAccount win over the index when they differ.
 * A quiet note is separate from the red problem list.
 */
export function collectProblems({
  replayRows,
  dbRows = [],
  chainByWallet,
  sums,
  chainTotals,
  orders = [],
  contributions = [],
  payouts = [],
  directClaimLogs = [],
  teamClaimLogs = [],
  indexerLastBlock = null,
  safeHead = null,
}) {
  const problems = [];
  const notes = [];
  if (indexerLastBlock != null && safeHead != null && BigInt(indexerLastBlock) < BigInt(safeHead)) {
    notes.push(`索引检查点在区块 ${indexerLastBlock}，快照补到 ${safeHead}，没有写回数据库。`);
  }

  const replay = new Map(replayRows.map((row) => [getAddress(row.wallet), row]));
  const db = new Map(dbRows.map((row) => [getAddress(row.wallet), row]));
  for (const [wallet, row] of replay) {
    const stored = db.get(wallet);
    if (!stored) {
      problems.push(`${wallet} 链上重放有这个地址，索引里没有`);
      continue;
    }
    if (!sameAddress(stored.referrer, row.referrer)) {
      problems.push(`${wallet} 索引上级 ${stored.referrer || "无"}，链上重放 ${row.referrer || "无"}`);
    }
    pushAmount(problems, wallet, "索引本人业绩", row.selfWei, stored.self_wei);
    pushAmount(problems, wallet, "索引伞下业绩", row.teamWei, stored.team_wei);
    pushAmount(problems, wallet, "索引网体奖", row.teamRewardWei, stored.team_reward_wei);
    pushAmount(problems, wallet, "索引直推奖", row.directWei, stored.direct_wei);
    pushAmount(problems, wallet, "索引网体已领", row.claimedWei, stored.claimed_wei);
  }
  for (const wallet of db.keys()) {
    if (!replay.has(wallet)) problems.push(`${wallet} 索引里有，链上重放没有`);
  }

  if (chainByWallet) {
    for (const [wallet, chain] of chainByWallet) {
      const row = replay.get(wallet);
      if (!chain.accountOk || !chain.account) {
        problems.push(`${wallet} 读金库账户失败${chain.accountError ? `：${chain.accountError}` : ""}`);
        continue;
      }
      if (!row) {
        if (chain.account.registered) problems.push(`${wallet} 金库已注册，链上重放没有`);
        continue;
      }
      const account = chain.account;
      if (!account.registered) problems.push(`${wallet} 链上重放有记录，金库 getAccount 未注册`);
      if (!sameAddress(account.referrer, row.referrer)) {
        problems.push(`${wallet} 金库上级 ${referrerOf(account.referrer) || "无"}，链上重放 ${row.referrer || "无"}`);
      }
      pushAmount(problems, wallet, "金库本人业绩", row.selfWei, account.selfVolume);
      pushAmount(problems, wallet, "金库直推计提", row.directWei, account.directRewards);
      pushAmount(problems, wallet, "金库直推已领", row.directClaimedWei ?? 0n, account.claimed);
      if (!chain.claimedOk) problems.push(`${wallet} 读奖励合约已领失败`);
      else pushAmount(problems, wallet, "奖励合约网体已领", row.claimedWei, chain.teamClaimed);
    }
  }

  const expect = (label, actual, expected) => {
    if (BigInt(actual) !== BigInt(expected)) problems.push(`${label} ${expected}，链上重放 ${actual}`);
  };
  if (chainTotals) {
    expect("金库 totalContributed", sums.contributed, chainTotals.totalContributed);
    expect("金库 totalImported", sums.imported, chainTotals.totalImported);
    expect("金库 totalDirectAccrued", sums.directEvents, chainTotals.totalDirectAccrued);
    expect("重放直推计提", replayRows.reduce((sum, row) => sum + row.directWei, 0n), chainTotals.totalDirectAccrued);
    expect("金库 totalClaimed", sums.directClaimed, chainTotals.totalClaimed);
    expect("奖励合约 totalTeamPaid", sums.teamClaimedPaid, chainTotals.totalTeamPaid);
    const reconstructed = sums.contributed - sums.directClaimed - sums.teamDisbursed - sums.treasury;
    if (BigInt(chainTotals.usdtBalance) < reconstructed) {
      problems.push(`金库 USDT 余额 ${chainTotals.usdtBalance} 少于按事件还原的 ${reconstructed}`);
    }
  }
  if (sums.directEvents !== replayRows.reduce((sum, row) => sum + row.directWei, 0n)) {
    problems.push("DirectRewardAccrued 合计和重放直推计提不一致");
  }
  if (sums.teamDisbursed !== sums.teamClaimedPaid) {
    problems.push(`TeamDisbursed ${sums.teamDisbursed} 和 TeamClaimed 实发 ${sums.teamClaimedPaid} 不一致`);
  }

  problems.push(...compareOrders(contributions, orders));
  problems.push(...comparePayouts(payouts, directClaimLogs, teamClaimLogs));
  return { problems, notes };
}

export function compareOrders(contributions, orders) {
  const problems = [];
  const byTx = new Map();
  for (const order of orders) {
    if (!order.tx) continue;
    const tx = order.tx.toLowerCase();
    if (byTx.has(tx)) problems.push(`订单交易 ${tx} 重复`);
    byTx.set(tx, order);
  }
  const seen = new Set();
  for (const row of contributions) {
    const tx = String(row.tx || "").toLowerCase();
    seen.add(tx);
    const whole = row.amountWei % UNIT === 0n ? row.amountWei / UNIT : null;
    const order = byTx.get(tx);
    if (whole == null) {
      if (order) problems.push(`${tx} 不是整数 USDT，库里却有订单`);
      continue;
    }
    if (!order) {
      problems.push(`${row.wallet} 链上入金 ${whole} USDT 没有对应订单 ${tx}`);
      continue;
    }
    if (getAddress(order.wallet) !== getAddress(row.wallet)) {
      problems.push(`${tx} 订单钱包 ${order.wallet}，链上是 ${row.wallet}`);
    }
    if (BigInt(order.amountUsdt) !== whole) {
      problems.push(`${tx} 订单 ${order.amountUsdt} USDT，链上 ${whole} USDT`);
    }
  }
  for (const [tx, order] of byTx) {
    if (!seen.has(tx)) problems.push(`库里订单 ${tx}（${order.wallet} ${order.amountUsdt} USDT）在链上入金日志里没有`);
  }
  return problems;
}

function claimKey(kind, tx) {
  return `${kind}:${String(tx || "").toLowerCase()}`;
}

export function comparePayouts(payouts, directClaimLogs, teamClaimLogs) {
  const problems = [];
  const chain = new Map();
  const add = (kind, log) => {
    const key = claimKey(kind, log.tx);
    const current = chain.get(key) || { kind, tx: log.tx, wallet: log.wallet, amountWei: 0n };
    current.amountWei += log.amountWei;
    chain.set(key, current);
  };
  for (const log of directClaimLogs) add("direct", log);
  for (const log of teamClaimLogs) add("team", log);
  const seen = new Set();
  for (const payout of payouts) {
    const key = claimKey(payout.kind, payout.tx);
    seen.add(key);
    const found = chain.get(key);
    if (!found) {
      problems.push(`拨付表 ${payout.kind} ${payout.tx} 在链上领取日志里没有`);
      continue;
    }
    if (found.amountWei % UNIT !== 0n) {
      problems.push(`${payout.tx} 链上领取不是整数 USDT，拨付表却有记录`);
      continue;
    }
    if (BigInt(payout.amountUsdt) !== found.amountWei / UNIT) {
      problems.push(`${payout.tx} 拨付表 ${payout.amountUsdt} USDT，链上 ${found.amountWei / UNIT} USDT`);
    }
    if (getAddress(payout.wallet) !== getAddress(found.wallet)) {
      problems.push(`${payout.tx} 拨付表钱包 ${payout.wallet}，链上是 ${found.wallet}`);
    }
  }
  for (const [key, found] of chain) {
    if (seen.has(key) || found.amountWei % UNIT !== 0n) continue;
    problems.push(`${found.wallet} 链上${found.kind === "team" ? "网体" : "直推"}领取 ${found.amountWei / UNIT} USDT 没有写入拨付表 ${found.tx}`);
  }
  return problems;
}

export function previewProblems(problems, limit = 20) {
  if (problems.length <= limit) return problems;
  return [...problems.slice(0, limit), `另有 ${problems.length - limit} 条，写在核对报告里。`];
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function embed(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const ROLE_LABEL = { team_leader: "团队长", big_leader: "大团队长" };

export function annotateRewardRoles(accounts, roles, { head = 0n, v3Block = "" } = {}) {
  const v3 = blockAtLeast(head, v3Block);
  const byWallet = new Map((roles || []).map((role) => [getAddress(role.wallet), role]));
  for (const account of accounts) {
    const role = byWallet.get(account.wallet);
    if (!role) continue;
    account.rewardRole = role.role;
    const name = ROLE_LABEL[role.role] || role.role;
    const effective = BigInt(role.effective_block ?? role.effectiveBlock ?? 0);
    if (!v3 || BigInt(head) < effective) {
      account.roleLabel = `${name} 待生效`;
      continue;
    }
    const state = createState();
    state.self.set(account.wallet, account.selfWei);
    state.team.set(account.wallet, account.teamWei);
    setRole(state, account.wallet, role.role);
    const bps = bpsForAccount(state, account.wallet, { v3: true, blockNumber: head });
    account.roleLabel = bps > 0n ? `${name} ${Number(bps) / 100}%` : name;
  }
  return accounts;
}

export function bigLeaderCandidates(accounts) {
  const children = new Map();
  for (const account of accounts) {
    if (!account.referrer) continue;
    const list = children.get(account.referrer) || [];
    list.push(account);
    children.set(account.referrer, list);
  }
  const hits = [];
  for (const account of accounts) {
    if (account.rewardRole === "big_leader") continue;
    const directs = (children.get(account.wallet) || []).filter((child) => child.selfWei >= 1_000n * UNIT);
    if (account.selfWei >= 10_000n * UNIT || (account.selfWei >= 1_000n * UNIT && directs.length >= 3)) hits.push(account.wallet);
  }
  return hits;
}

function depositLine(node) {
  if (node.all) {
    const parts = [];
    if (node.depositCount) parts.push(`入金 ${node.depositCount} 笔 ${formatUsdt(node.depositWei)}`);
    if (node.importedWei > 0n) parts.push(`导入 ${formatUsdt(node.importedWei)}`);
    return parts.join(" · ") || "无入金";
  }
  const depositSum = node.deposits.reduce((sum, deposit) => sum + deposit.amountWei, 0n);
  const parts = node.deposits.map((deposit) => `${deposit.timeText} ${formatUsdt(deposit.amountWei)}`);
  if (node.deposits.length > 1) parts.unshift(`合计 ${formatUsdt(depositSum)}`);
  if (node.importedWei > 0n) parts.push(`导入 ${formatUsdt(node.importedWei)}`);
  return parts.join(" · ") || "无入金";
}

function renderNode(node) {
  const tail = node.all ? "全部" : node.wallet.slice(-4);
  const query = [node.wallet || "", tail, node.note || ""].join(" ").toLowerCase();
  const kids = node.children.length
    ? `<ul>${node.children.map((child) => renderNode(child)).join("")}</ul>`
    : "";
  const note = node.note ? `<span class="note">${esc(node.note)}</span>` : "";
  const role = node.roleLabel ? `<span class="note">${esc(node.roleLabel)}</span>` : "";
  const down = node.children.length ? `<span class="muted">下级 ${node.children.length}</span>` : "";
  return `<li${node.all ? ' data-all="1"' : ""} data-q="${esc(query)}"><button type="button" class="row${node.children.length ? "" : " leaf"}" title="${esc(node.wallet || "全部地址")}"><span class="mark"></span><span class="tail">${esc(tail)}</span>${note}${role}<span>${esc(depositLine(node))}</span><span>${node.all ? "全网业绩" : "业绩"} ${esc(formatUsdt(node.networkWei))}</span><span>直推 ${esc(formatUsdt(node.directWei))}</span><span>网体 ${esc(formatUsdt(node.networkRewardWei))}</span><span>合计 ${esc(formatUsdt(node.totalRewardWei))}</span>${down}</button>${kids}</li>`;
}

/** Single HTML file. Data is embedded. Day and week charts are drawn in the page. */
export function renderPage({
  generatedAt,
  database,
  ido,
  rewards,
  safeHead,
  problems,
  notes,
  roots,
  days,
  weeks,
  review,
  snapshotName,
}) {
  const status = problems.length
    ? `<div class="bad"><b>核对没有通过，共 ${problems.length} 条。</b>页面数字仍用链上重放。${previewProblems(problems).map((line) => `<div>${esc(line)}</div>`).join("")}</div>`
    : `<div class="ok">核对通过。每个地址的上级、本人业绩、直推计提和网体已领都和合约一致。</div>`;
  const noteBox = notes.length ? `<div class="note-box">${notes.map((line) => `<div>${esc(line)}</div>`).join("")}</div>` : "";
  const tree = roots.length ? `<div id="map"><ul id="tree">${roots.map((root) => renderNode(root)).join("")}</ul></div>` : `<p>这次重放没有地址。</p>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coral 邀请树 ${esc(generatedAt)}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; font: 15px/1.45 "PingFang SC", "Noto Sans SC", system-ui, sans-serif; color: #07363f; background: #f3f7f6; }
header { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 8px; }
main { width: 100%; }
main > h2, main > .toolbar, main > .chart, main > #readout, main > .review { width: min(1180px, calc(100% - 32px)); margin-left: auto; margin-right: auto; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 28px 0 10px; }
.meta, .muted { color: #4b666c; }
.toolbar { display: flex; gap: 12px; align-items: center; margin: 16px 0; }
input[type="search"] { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid #c5d8d6; border-radius: 8px; }
button.mode, .row { font: inherit; color: inherit; }
button.mode { border: 1px solid #c5d8d6; background: #fff; border-radius: 999px; padding: 6px 12px; cursor: pointer; }
button.mode[aria-pressed="true"] { background: #07363f; color: #fff; border-color: #07363f; }
.ok, .bad, .note-box, .review { border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
.ok { background: #e5f6ef; }
.bad { background: #fde8e8; color: #7f1d1d; }
.note-box { background: #eef3f8; }
#map { overflow: auto; max-height: 78vh; margin: 4px 16px 20px; border: 1px solid #d5e6e3; border-radius: 18px; cursor: grab; background-color: #f7fbfa; background-image: radial-gradient(#d3e4e1 1.15px, transparent 1.15px); background-size: 22px 22px; }
#map.dragging { cursor: grabbing; user-select: none; }
#tree, #tree ul { list-style: none; margin: 0; padding: 0; }
#tree { display: flex; flex-direction: column; align-items: flex-start; width: max-content; padding: 36px 48px; }
#tree > li, #tree ul > li { display: flex; align-items: center; position: relative; }
#tree ul { position: relative; display: flex; flex-direction: column; justify-content: center; padding: 0 0 0 28px; }
#tree ul[hidden], #tree li[hidden] { display: none; }
#tree ul::before { content: ""; position: absolute; left: 0; top: 50%; width: 14px; border-top: 2px solid #5eaea9; }
#tree ul > li { padding: 7px 0; }
#tree ul > li::before { content: ""; position: absolute; left: -14px; top: 0; bottom: 0; width: 14px; border-left: 2px solid #5eaea9; }
#tree ul > li::after { content: ""; position: absolute; left: -14px; top: 50%; width: 14px; border-top: 2px solid #5eaea9; }
#tree ul > li.edge-first::before { top: 50%; border-top: 2px solid #5eaea9; border-top-left-radius: 12px; }
#tree ul > li.edge-last::before { bottom: 50%; border-bottom: 2px solid #5eaea9; border-bottom-left-radius: 12px; }
#tree ul > li.edge-first::after, #tree ul > li.edge-last::after { content: none; }
#tree ul > li.edge-only::before { top: 50%; bottom: auto; height: 0; border: 0; border-top: 2px solid #5eaea9; border-radius: 0; }
.row { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 196px; min-width: 196px; flex: none; padding: 10px 22px 9px 12px; border: 1px solid #d5ebe8; border-radius: 16px; background: #fff; text-align: left; line-height: 1.35; cursor: pointer; box-shadow: 0 8px 18px rgba(7,54,63,.07); overflow-wrap: anywhere; }
.row.leaf { cursor: default; }
.row.empty { background: #f4faf9; border-style: dashed; }
.row:has(.note) { box-shadow: inset 3px 0 0 #ea580c, 0 8px 18px rgba(7,54,63,.07); }
li.hit > .row { outline: 2px solid #d97706; outline-offset: 2px; }
#tree ul li:has(> ul:not([hidden])) > .row { border-color: #12b3be; box-shadow: 0 0 0 3px rgba(0,221,224,.18); }
.tail { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; font-size: 16px; }
.tail::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 99px; background: #00dde0; vertical-align: 1px; }
.note { color: #9a3412; font-weight: 700; font-size: 13px; }
.row > span:not(.mark):not(.tail):not(.note) { font-size: 12px; color: #3e646b; }
.metrics { display: grid; grid-template-columns: 1fr 1fr; column-gap: 8px; width: 100%; }
.metrics > span { font-size: 12px; color: #3e646b; }
.mark { position: absolute; right: 8px; top: 8px; width: auto; color: #0c7c86; font-size: 13px; line-height: 1; }
.row.leaf .mark { display: none; }
li:has(> ul:not([hidden])) > .row .mark::before { content: "–"; }
li:has(> ul[hidden]) > .row .mark::before { content: "+"; }
#tree > li > .row { width: 214px; min-width: 214px; background: #07363f; color: #f4fffc; border-color: #07363f; border-style: solid; }
#tree > li > .row .tail::before { background: #9ef6cd; }
#tree > li > .row .note { color: #ffd7a8; }
#tree > li > .row > span:not(.mark):not(.tail):not(.note),
#tree > li > .row .metrics > span { color: #c7eee8; }
#tree > li > .row .mark { color: #9ef6cd; }
.row.empty .tail::before { background: #b7cdca; }
#tree > li > .row.empty .tail::before { background: #9ef6cd; }
.chart { background: #fff; border-radius: 12px; padding: 8px 8px 16px; margin: 12px 0 20px; }
.chart svg { width: 100%; height: auto; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 10px 16px; padding: 4px 8px 0; font-size: 13px; }
.swatch { display: inline-block; width: 12px; height: 12px; margin-right: 4px; vertical-align: -1px; }
#readout { min-height: 1.4em; margin: 4px 8px 0; }
.review p { margin: 6px 0; }
</style>
</head>
<body>
<header>
<h1>Coral 邀请树</h1>
<p class="meta">正式库 ${esc(database)} · 只读 · 截止区块 ${esc(safeHead)} · ${esc(generatedAt)}<br>金库 ${esc(ido)} · 奖励 ${esc(rewards)}<br>快照 ${esc(snapshotName)}。地址只显示后四位，悬停可看完整地址。从左向右展开。点一下展开该节点的全部下级，再点一下全部收起。空白处可以拖动画布。</p>
${status}
${noteBox}
<div class="toolbar"><input id="q" type="search" placeholder="搜后四位、完整地址或备注" autocomplete="off"></div>
</header>
<main>
${tree}
<h2>收款与拨付</h2>
<div class="toolbar">
<button type="button" class="mode" id="by-day" aria-pressed="true">按天</button>
<button type="button" class="mode" id="by-week" aria-pressed="false">按周</button>
</div>
<div id="charts" class="chart"></div>
<p id="readout" class="muted"></p>
<section class="review">${review.map((line) => `<p>${esc(line)}</p>`).join("")}</section>
</main>
<script>
const DAYS = ${embed(days)};
const WEEKS = ${embed(weeks)};
function childList(li) { return li.querySelector(":scope > ul"); }
function fullyOpen(li) {
  const ul = childList(li);
  if (!ul || ul.children.length === 0) return true;
  if (ul.hidden) return false;
  for (const child of ul.children) if (!fullyOpen(child)) return false;
  return true;
}
function setBranch(li, open) {
  const ul = childList(li);
  if (!ul) return;
  ul.hidden = !open;
  for (const child of ul.children) setBranch(child, open);
}
function paintEdges() {
  for (const ul of document.querySelectorAll("#tree ul")) {
    const items = [...ul.children];
    const visible = items.filter((li) => !li.hidden);
    for (const li of items) li.classList.remove("edge-first", "edge-last", "edge-only");
    if (!visible.length) continue;
    visible[0].classList.add("edge-first");
    visible[visible.length - 1].classList.add("edge-last");
    if (visible.length === 1) visible[0].classList.add("edge-only");
  }
}
function initTree() {
  for (const li of document.querySelectorAll("#tree li")) {
    li.hidden = false;
    li.classList.remove("hit");
  }
  for (const ul of document.querySelectorAll("#tree ul")) ul.hidden = true;
  for (const li of document.querySelectorAll("#tree > li")) {
    const ul = childList(li);
    if (ul) ul.hidden = false;
  }
  paintEdges();
}
function applyFilter() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  if (!q) { initTree(); return; }
  for (const li of document.querySelectorAll("#tree li")) {
    const self = (li.dataset.q || "").includes(q);
    const kid = [...li.querySelectorAll("li")].some((node) => (node.dataset.q || "").includes(q));
    li.hidden = !(self || kid);
    li.classList.toggle("hit", self);
  }
  for (const li of document.querySelectorAll("#tree li")) {
    const ul = childList(li);
    if (!ul || li.hidden) continue;
    ul.hidden = ![...li.querySelectorAll("li")].some((node) => !node.hidden && (node.dataset.q || "").includes(q));
  }
  paintEdges();
}
function tighten() {
  for (const row of document.querySelectorAll("#tree .row")) {
    if (row.querySelector(".metrics")) continue;
    const metrics = document.createElement("span");
    metrics.className = "metrics";
    for (const span of [...row.children]) {
      if (/^(业绩|直推|网体|合计)\s/.test(span.textContent)) metrics.append(span);
    }
    if (!metrics.childElementCount) continue;
    const down = [...row.children].find((span) => span.classList.contains("muted"));
    row.insertBefore(metrics, down || null);
  }
}
function markEmpty() {
  for (const row of document.querySelectorAll("#tree .row")) {
    row.classList.toggle("empty", [...row.children].some((node) => node.textContent === "无入金"));
  }
}
function bindMap() {
  const map = document.getElementById("map");
  if (!map) return;
  let drag = null;
  map.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".row")) return;
    drag = { x: event.clientX, y: event.clientY, left: map.scrollLeft, top: map.scrollTop, id: event.pointerId };
    map.setPointerCapture(event.pointerId);
    map.classList.add("dragging");
  });
  map.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    map.scrollLeft = drag.left - (event.clientX - drag.x);
    map.scrollTop = drag.top - (event.clientY - drag.y);
  });
  function end(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
    map.classList.remove("dragging");
  }
  map.addEventListener("pointerup", end);
  map.addEventListener("pointercancel", end);
}
document.getElementById("tree")?.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  const li = row.parentElement;
  if (!childList(li) || childList(li).children.length === 0) return;
  setBranch(li, !fullyOpen(li));
  paintEdges();
});
document.getElementById("q").addEventListener("input", applyFilter);
function wei(value) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const n = Number(abs / 1000000000000n) / 1e6;
  return neg ? -n : n;
}
function nice(max) {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * exp;
}
function panel(rows, title, series, unit) {
  const wrap = document.createElement("section");
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = "<b>" + title + "</b>" + series.map((item) => '<span><i class="swatch" style="background:' + item.color + (item.type === "cap" ? ";opacity:.45" : "") + '"></i>' + item.name + "</span>").join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 960 280");
  const values = [];
  for (const row of rows) for (const item of series) if (item.key) values.push(row[item.key]);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (unit === "pct") max = Math.max(max, 25);
  if (max === min) max = min + 1;
  max = unit === "pct" ? Math.max(25, nice(max)) : nice(max);
  if (min < 0) min = -nice(-min);
  const left = 72, right = 16, top = 16, bottom = 36;
  const width = 960 - left - right, height = 280 - top - bottom;
  const x = (i) => left + (rows.length === 1 ? width / 2 : (i * width) / (rows.length - 1));
  const y = (v) => top + ((max - v) * height) / (max - min);
  const ns = "http://www.w3.org/2000/svg";
  function el(name, attrs) {
    const node = document.createElementNS(ns, name);
    for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
    return node;
  }
  for (let tick = 0; tick <= 4; tick++) {
    const value = min + ((max - min) * tick) / 4;
    const yy = y(value);
    svg.append(el("line", { x1: left, x2: 960 - right, y1: yy, y2: yy, stroke: "#e4eeec" }));
    const label = unit === "pct" ? value.toFixed(0) + "%" : (value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k" : value.toFixed(value < 10 ? 1 : 0));
    const tickText = el("text", { x: left - 8, y: yy + 4, "text-anchor": "end", fill: "#4b666c", "font-size": "12" });
    tickText.textContent = label;
    svg.append(tickText);
  }
  const step = Math.ceil(rows.length / 12);
  rows.forEach((row, i) => {
    if (i % step !== 0) return;
    const axis = el("text", { x: x(i), y: 268, "text-anchor": "middle", fill: "#4b666c", "font-size": "12" });
    axis.textContent = row.label;
    svg.append(axis);
  });
  const bar = series.find((item) => item.type === "bar");
  if (bar) {
    const bw = Math.max(2, (width / rows.length) * 0.62);
    rows.forEach((row, i) => {
      const v = row[bar.key];
      const y0 = y(0), y1 = y(v);
      svg.append(el("rect", { x: x(i) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), fill: bar.color }));
    });
  }
  for (const item of series) {
    if (item.type === "cap") {
      svg.append(el("line", { x1: left, x2: 960 - right, y1: y(item.value), y2: y(item.value), stroke: item.color, "stroke-dasharray": "5 4" }));
    } else if (item.type === "line") {
      svg.append(el("polyline", { fill: "none", stroke: item.color, "stroke-width": "2", points: rows.map((row, i) => x(i) + "," + y(row[item.key])).join(" ") }));
    }
  }
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * 960;
    let best = 0, dist = Infinity;
    rows.forEach((row, i) => { const d = Math.abs(x(i) - px); if (d < dist) { dist = d; best = i; } });
    const row = rows[best];
    document.getElementById("readout").textContent = row.label + "  新增 " + row.newInText + "  累计 " + row.cumInText + "  收款减已领取 " + row.remainText + "  拨比 " + row.ratioText + "  网体已计提 " + row.teamAccruedText + "  网体已领取 " + row.teamClaimedText;
  });
  wrap.append(legend, svg);
  return wrap;
}
function draw(rows) {
  const host = document.getElementById("charts");
  host.innerHTML = "";
  document.getElementById("readout").textContent = "";
  if (!rows.length) { host.textContent = "这段时间没有链上收款。"; return; }
  const view = rows.map((row) => ({ ...row, newIn: wei(row.newInWei), cum: wei(row.cumInWei), remain: wei(row.remainWei), accrued: wei(row.teamAccruedWei), claimed: wei(row.teamClaimedWei), ratio: row.ratioBps / 100 }));
  host.append(
    panel(view, "收款", [
      { type: "bar", key: "newIn", name: "新增收款", color: "#8fd0cf" },
      { type: "line", key: "cum", name: "累计收款", color: "#07363f" },
      { type: "line", key: "remain", name: "收款减已领取", color: "#0c7c86" },
    ], "usdt"),
    panel(view, "市场拨比", [
      { type: "line", key: "ratio", name: "市场拨比", color: "#b45309" },
      { type: "cap", value: 25, name: "25% 帽", color: "#b45309" },
    ], "pct"),
    panel(view, "网体拨付", [
      { type: "line", key: "accrued", name: "网体已计提", color: "#1d4e89" },
      { type: "line", key: "claimed", name: "网体已领取", color: "#7c3aed" },
    ], "usdt"),
  );
}
document.getElementById("by-day").addEventListener("click", () => { draw(DAYS); document.getElementById("by-day").setAttribute("aria-pressed", "true"); document.getElementById("by-week").setAttribute("aria-pressed", "false"); });
document.getElementById("by-week").addEventListener("click", () => { draw(WEEKS); document.getElementById("by-week").setAttribute("aria-pressed", "true"); document.getElementById("by-day").setAttribute("aria-pressed", "false"); });
tighten();
markEmpty();
initTree();
bindMap();
draw(DAYS);
</script>
</body>
</html>
`;
}

export function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
