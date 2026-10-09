/** Plan one historical import settlement. Amounts are wei. */

export const UNIT = 10n ** 18n;
export const NFT_MIN_SELF = 1000n * UNIT;
export const NFT_UNIT = 500n * UNIT;

export function nftsOwed(volume) {
  if (volume < NFT_MIN_SELF) return 0n;
  return volume / NFT_UNIT;
}

export function tokensFor(volume, tokensPerUsdt) {
  return (volume * tokensPerUsdt) / UNIT;
}

/** Beijing Sunday weeks. Same origin as CoralNftInterest. */
export const FIRST_SUNDAY_BEIJING = 230400n;
export const CALENDAR_WEEK = 7n * 24n * 60n * 60n;
export const BPS_DENOMINATOR = 10_000n;

export const DEFAULT_TIERS = [
  { minNfts: 2n, weeklyBps: 100n },
  { minNfts: 10n, weeklyBps: 200n },
  { minNfts: 20n, weeklyBps: 250n },
  { minNfts: 60n, weeklyBps: 300n },
];

export function calendarWeek(timestamp) {
  const ts = BigInt(timestamp);
  if (ts < FIRST_SUNDAY_BEIJING) return 0n;
  return (ts - FIRST_SUNDAY_BEIJING) / CALENDAR_WEEK;
}

export function weekStart(week) {
  return FIRST_SUNDAY_BEIJING + BigInt(week) * CALENDAR_WEEK;
}

export function formatBeijing(timestamp) {
  const shifted = new Date((Number(timestamp) + 8 * 60 * 60) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} +08`;
}

function unixTime(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.floor(value));
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`无法解析确认时间 ${value}`);
  return BigInt(Math.floor(ms / 1000));
}

export function weeklyAmount(nfts, tokensPerUsdt, tiers = DEFAULT_TIERS) {
  let bps = 0n;
  for (const tier of tiers) {
    if (nfts >= BigInt(tier.minNfts)) bps = BigInt(tier.weeklyBps);
  }
  if (bps === 0n || nfts === 0n) return 0n;
  const principal = nfts * NFT_UNIT * BigInt(tokensPerUsdt) / UNIT;
  return principal * bps / BPS_DENOMINATOR;
}

/**
 * Finished Beijing weeks from the order that first created each NFT count,
 * up to but not including the calendar week of saleOpenedAt.
 * The sale week and every later week stay with the interest contract.
 */
export function backfillInterest({
  orders,
  tokensPerUsdt,
  saleOpenedAt,
  now,
  tiers = DEFAULT_TIERS,
  accountCapBps = BPS_DENOMINATOR,
  globalRoom = 50_000_000n * UNIT,
  alreadyPaid = 0n,
}) {
  const rate = BigInt(tokensPerUsdt);
  const cutoff = calendarWeek(saleOpenedAt);
  const sorted = [...(orders || [])].sort((a, b) => {
    const left = unixTime(a.confirmedAt);
    const right = unixTime(b.confirmedAt);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const changes = [];
  let volume = 0n;
  for (const order of sorted) {
    volume += BigInt(order.usdt) * UNIT;
    const at = unixTime(order.confirmedAt);
    const week = calendarWeek(at);
    const nfts = nftsOwed(volume);
    const last = changes[changes.length - 1];
    if (last && last.week === week) {
      last.nfts = nfts;
      last.at = at;
    } else {
      changes.push({ week, nfts, at });
    }
  }

  const segments = [];
  let gross = 0n;
  let since = null;
  let firstWeek = null;
  for (let i = 0; i < changes.length; i++) {
    const nfts = changes[i].nfts;
    if (nfts < 2n) continue;
    if (since === null) {
      since = changes[i].at;
      firstWeek = changes[i].week;
    }
    let end = i + 1 < changes.length ? changes[i + 1].week : cutoff;
    if (end > cutoff) end = cutoff;
    const start = changes[i].week;
    if (end <= start) continue;
    const weeks = end - start;
    const amount = weeklyAmount(nfts, rate, tiers) * weeks;
    gross += amount;
    segments.push({ fromWeek: start, toWeek: end, nfts, weeks, amount, at: changes[i].at });
  }

  const finalNfts = changes.length === 0 ? 0n : changes[changes.length - 1].nfts;
  const ceiling = finalNfts * NFT_UNIT * rate / UNIT * BigInt(accountCapBps) / BPS_DENOMINATOR;
  const capped = gross > ceiling ? ceiling : gross;
  const unpaid = capped > BigInt(alreadyPaid) ? capped - BigInt(alreadyPaid) : 0n;
  const room = BigInt(globalRoom);
  const actual = unpaid > room ? room : unpaid;
  const weeks = firstWeek === null || cutoff <= firstWeek ? 0n : cutoff - firstWeek;
  return {
    since,
    weeks,
    gross,
    actual,
    orderVolume: volume,
    finalNfts,
    segments,
  };
}

/**
 * CKEY shortfall is tokensFor(volume) minus the wallet balance.
 * NFT grant is the imported count not yet granted.
 */
export function settlePlan(row) {
  const volume = BigInt(row.volume);
  const balance = BigInt(row.nemoBalance);
  const importedNfts = BigInt(row.importedNfts);
  const grantedNfts = BigInt(row.grantedNfts);
  const owed = nftsOwed(volume);
  if (importedNfts > owed) {
    throw new Error(`${row.wallet} 的导入 NFT ${importedNfts} 超过业绩应发 ${owed}`);
  }
  if (grantedNfts > importedNfts) {
    throw new Error(`${row.wallet} 已补发 ${grantedNfts} 张，超过导入 ${importedNfts} 张`);
  }
  const expectedNemo = tokensFor(volume, BigInt(row.tokensPerUsdt));
  return {
    wallet: row.wallet,
    volume,
    expectedNemo,
    nemoMint: balance >= expectedNemo ? 0n : expectedNemo - balance,
    nftGrant: importedNfts - grantedNfts,
  };
}
