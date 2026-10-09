import { getAddress } from "viem";
import { bind, contribute, teamOf } from "./team-reward.mjs";
import { accountRows, emptyIndexState } from "./reward-index.mjs";

const UNIT = 10n ** 18n;

function unix(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.floor(value));
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`无法解析确认时间 ${value}`);
  return BigInt(Math.floor(ms / 1000));
}

/**
 * Replay confirmed orders in time order.
 * Umbrella and historical team rewards follow the same differential rules as a live deposit.
 * Direct rewards are calculated and then discarded; they stay on the manual ledger.
 */
export function settleHistoricalTeam(records) {
  const state = emptyIndexState();
  const expected = new Map();
  for (const record of records) {
    const wallet = getAddress(record.wallet);
    bind(state, wallet, record.referrer ? getAddress(record.referrer) : null);
    expected.set(wallet, BigInt(record.selfWei || 0));
  }

  const events = [];
  for (const record of records) {
    const wallet = getAddress(record.wallet);
    for (const order of record.orders || []) {
      events.push({ wallet, usdt: BigInt(order.usdt), at: unix(order.confirmedAt) });
    }
  }
  events.sort((a, b) => {
    if (a.at < b.at) return -1;
    if (a.at > b.at) return 1;
    return a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase());
  });

  let directExcluded = 0n;
  for (const event of events) {
    const paid = contribute(state, event.wallet, event.usdt * UNIT);
    directExcluded += paid.directPaid;
  }

  for (const [wallet, self] of expected) {
    const got = state.self.get(wallet) ?? 0n;
    if (self === 0n && got === 0n) continue;
    if (got !== self) {
      throw new Error(`${wallet} 的确认订单合计 ${got} 与导入业绩 ${self} 不一致`);
    }
  }

  const rows = accountRows(state)
    .filter((row) => row.selfWei > 0n || row.teamWei > 0n || row.teamRewardWei > 0n)
    .map((row) => ({
      wallet: row.wallet,
      selfWei: row.selfWei,
      teamWei: row.teamWei,
      teamRewardWei: teamOf(state, row.wallet),
    }));
  const teamRewardWei = rows.reduce((sum, row) => sum + row.teamRewardWei, 0n);
  return { rows, teamRewardWei, directExcluded };
}
