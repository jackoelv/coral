import { readFileSync } from "node:fs";
import { getAddress, zeroAddress } from "viem";

const WEI = 10n ** 18n;

/**
 * Adds deposits made on the old vault after its import to the database snapshot.
 * `users` come from neondb ({ id, wallet, inviteCode, referrerId, selfUsdt, orders }).
 * `contributions` come from Contributed logs ({ account, amountWei, confirmedAt, block, tx }).
 * A deposit from a wallet that is not in the snapshot, or one that is not whole USDT, stops the merge.
 */
export function mergeChainContributions(users, contributions) {
  const byWallet = new Map();
  const out = users.map((user) => {
    const copy = { ...user, orders: [...(user.orders || [])] };
    byWallet.set(getAddress(user.wallet), copy);
    return copy;
  });
  for (const row of contributions) {
    const wallet = getAddress(row.account);
    const user = byWallet.get(wallet);
    if (!user) throw new Error(`旧金库上 ${wallet} 有入金 ${row.tx}，但正式库里没有这个用户`);
    const amount = BigInt(row.amountWei);
    if (amount === 0n || amount % WEI !== 0n) throw new Error(`${row.tx} 的入金 ${amount} wei 不是整数 USDT`);
    const usdt = Number(amount / WEI);
    user.orders.push({ usdt, confirmedAt: row.confirmedAt, source: "chain", block: Number(row.block), tx: row.tx });
    user.selfUsdt = Number(user.selfUsdt || 0) + usdt;
  }
  for (const user of out) user.orders.sort((x, y) => Date.parse(x.confirmedAt) - Date.parse(y.confirmedAt));
  return out;
}

/**
 * Compares the merged snapshot with the old vault, address by address.
 * `chain` maps wallet -> { registered, referrer, selfVolume }. Returns the problems; empty means equal.
 */
export function compareWithOldVault(users, chain) {
  const walletById = new Map(users.map((user) => [user.id, getAddress(user.wallet)]));
  const problems = [];
  for (const user of users) {
    const wallet = getAddress(user.wallet);
    const state = chain.get(wallet);
    if (!state?.registered) {
      problems.push(`${wallet} 在旧金库里没有注册`);
      continue;
    }
    const expectedRef = user.referrerId ? walletById.get(user.referrerId) || zeroAddress : zeroAddress;
    if (getAddress(state.referrer || zeroAddress) !== expectedRef) {
      problems.push(`${wallet} 旧金库上级 ${state.referrer}，快照里是 ${expectedRef}`);
    }
    const self = BigInt(Number(user.selfUsdt || 0)) * WEI;
    if (BigInt(state.selfVolume) !== self) {
      problems.push(`${wallet} 旧金库本人业绩 ${state.selfVolume}，快照里是 ${self}`);
    }
    const orderSum = (user.orders || []).reduce((sum, order) => sum + BigInt(order.usdt) * WEI, 0n);
    if (orderSum !== self) problems.push(`${wallet} 订单合计 ${orderSum} 和本人业绩 ${self} 不同`);
  }
  return problems;
}

/** getLogs in block ranges. A failed range is split in half until it is one block. */
export async function scanLogs(client, { address, events, fromBlock, toBlock, chunk = 2000n }) {
  const logs = [];
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    ranges.push([start, start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n]);
  }
  while (ranges.length) {
    const [from, to] = ranges.shift();
    try {
      logs.push(...(await client.getLogs({ address, events, fromBlock: from, toBlock: to, strict: true })));
    } catch (error) {
      if (from === to) throw error;
      const mid = from + (to - from) / 2n;
      ranges.unshift([from, mid], [mid + 1n, to]);
    }
  }
  return logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

/** Reads old-paid.json: { paid: { wallet: wei } }. */
export function readPaidOffset(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data.paid !== "object") throw new Error(`${path} 没有 paid 字段`);
  const paid = new Map();
  for (const [wallet, wei] of Object.entries(data.paid)) {
    if (!/^\d+$/.test(String(wei))) throw new Error(`${path} 里 ${wallet} 的金额不是整数 wei`);
    paid.set(getAddress(wallet), BigInt(wei));
  }
  return paid;
}

/**
 * Subtracts team rewards already paid by the old rewards contract.
 * Each row keeps grossWei and offsetWei; teamRewardWei becomes the net.
 * Paying more on the old contract than the recomputed total means the inputs disagree, so it stops.
 */
export function applyPaidOffset(rows, paid) {
  const seen = new Set();
  const out = rows.map((row) => {
    const wallet = getAddress(row.wallet);
    seen.add(wallet);
    const gross = BigInt(row.teamRewardWei);
    const offset = paid.get(wallet) || 0n;
    if (offset > gross) throw new Error(`${wallet} 在旧合约已领 ${offset}，大于重算的历史网体奖 ${gross}`);
    return { ...row, grossWei: gross, offsetWei: offset, teamRewardWei: gross - offset };
  });
  for (const [wallet, offset] of paid) {
    if (offset > 0n && !seen.has(wallet)) throw new Error(`${wallet} 在旧合约已领 ${offset}，但重算结果里没有这个地址`);
  }
  return out;
}
