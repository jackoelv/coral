import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountsFromIndex,
  assembleAccounts,
  buildDailySeries,
  buildTree,
  collectProblems,
  compareBooksToChain,
  compareOrders,
  fileStamp,
  flowsFromBooks,
  formatShanghai,
  formatUsdt,
  marketHeadroom,
  replayNetwork,
  renderPage,
  rollupWeeks,
  shanghaiDay,
  weekStart,
} from "./network-snapshot.mjs";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const C = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const UNIT = 10n ** 18n;

function log(eventName, args, block, logIndex = 0, tx = `0x${String(block).padStart(64, "a")}`) {
  return { eventName, args, blockNumber: block, logIndex, transactionHash: tx };
}

function sampleLogs() {
  return [
    log("UserImported", { account: A }, 1, 0),
    log("UserImported", { account: B }, 1, 1),
    log("ReferrerImported", { account: B, referrer: A }, 1, 2),
    log("VolumeImported", { account: A, selfVolume: 100n * UNIT }, 2),
    log("VolumeImported", { account: B, selfVolume: 10_000n * UNIT }, 3),
    log("Contributed", { account: B, amount: 1_000n * UNIT }, 10, 0, `0x${"b".repeat(64)}`),
    log("Claimed", { account: A, amount: 100n * UNIT }, 11, 0, `0x${"c".repeat(64)}`),
    log("TeamDisbursed", { to: A, amount: 70n * UNIT }, 12, 0, `0x${"d".repeat(64)}`),
    log("TeamClaimed", { account: A, cumulative: 70n * UNIT, paid: 70n * UNIT }, 12, 1, `0x${"d".repeat(64)}`),
  ];
}

test("replay keeps import, deposit and pays the upline without double-counting a team claim", () => {
  const replay = replayNetwork(sampleLogs());
  const row = Object.fromEntries(replay.rows.map((item) => [item.wallet, item]));
  assert.equal(row[A].directWei, 100n * UNIT);
  assert.equal(row[A].teamRewardWei, 70n * UNIT);
  assert.equal(row[A].teamWei, 11_000n * UNIT);
  assert.equal(row[A].selfWei, 100n * UNIT);
  assert.equal(row[B].selfWei, 11_000n * UNIT);
  assert.equal(replay.deposits.get(B)[0].amountWei, 1_000n * UNIT);
  assert.equal(replay.imported.get(A), 100n * UNIT);
  assert.equal(replay.sums.teamDisbursed, 70n * UNIT);
  assert.equal(replay.sums.teamClaimedPaid, 70n * UNIT);
  assert.equal(replay.sums.contributed - replay.sums.directClaimed - replay.sums.teamDisbursed - replay.sums.treasury, 830n * UNIT);

  const day = shanghaiDay(Date.parse("2026-10-30T00:30:00+08:00") / 1000);
  const flows = replay.flows.map((flow) => ({ ...flow, unix: Date.parse("2026-10-30T00:30:00+08:00") / 1000 }));
  const series = buildDailySeries(flows, { historicalTeamWei: 50n * UNIT });
  assert.equal(series.length, 1);
  assert.equal(series[0].key, day);
  assert.equal(series[0].newInWei, (1_000n * UNIT).toString());
  assert.equal(series[0].remainWei, (830n * UNIT).toString());
  assert.equal(series[0].teamAccruedWei, (120n * UNIT).toString());
  assert.equal(series[0].ratioBps, 198);
});

test("shanghai day rolls at midnight and weeks start Monday", () => {
  const justBefore = Date.parse("2026-10-30T00:00:00+08:00") / 1000 - 1;
  assert.equal(shanghaiDay(justBefore), "2026-10-29");
  assert.equal(shanghaiDay(justBefore + 1), "2026-10-30");
  assert.equal(formatShanghai(justBefore + 1), "10-30 00:00");
  assert.equal(weekStart("2026-10-30"), "2026-10-26");
  assert.equal(fileStamp(new Date(2026, 9, 30, 10, 7, 8)), "20261030-100708");
  assert.equal(formatUsdt(1500n * UNIT + 5n * 10n ** 16n), "1,500.05");
});

test("two roots sit under 全部 and the total does not double-count umbrellas", () => {
  const accounts = [
    { wallet: A, referrer: null, note: "根", deposits: [], importedWei: 0n, selfWei: 100n * UNIT, teamWei: 50n * UNIT, networkWei: 150n * UNIT, directWei: 1n, teamRewardWei: 2n, historicalTeamRewardWei: 0n, networkRewardWei: 2n, totalRewardWei: 3n, directClaimedWei: 0n, teamClaimedWei: 0n },
    { wallet: B, referrer: A, note: null, deposits: [{ timeText: "10-30 01:00", amountWei: 50n * UNIT, at: "", tx: "0x1", block: "1" }], importedWei: 0n, selfWei: 50n * UNIT, teamWei: 0n, networkWei: 50n * UNIT, directWei: 0n, teamRewardWei: 0n, historicalTeamRewardWei: 0n, networkRewardWei: 0n, totalRewardWei: 0n, directClaimedWei: 0n, teamClaimedWei: 0n },
    { wallet: C, referrer: null, note: null, deposits: [], importedWei: 0n, selfWei: 7n * UNIT, teamWei: 0n, networkWei: 7n * UNIT, directWei: 0n, teamRewardWei: 0n, historicalTeamRewardWei: 0n, networkRewardWei: 0n, totalRewardWei: 0n, directClaimedWei: 0n, teamClaimedWei: 0n },
  ];
  const tree = buildTree(accounts);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].all, true);
  assert.equal(tree.roots[0].networkWei, 157n * UNIT);
  assert.equal(tree.roots[0].children.length, 2);
  const html = renderPage({
    generatedAt: "2026-10-30 10:00:00",
    database: "production",
    ido: "0xido",
    rewards: "0xrewards",
    safeHead: "10",
    problems: ["示例差异"],
    notes: [],
    roots: tree.roots,
    days: [],
    weeks: [],
    review: ["累计收款 0 USDT"],
    snapshotName: "network-snapshot-test.json",
  });
  assert.match(html, /2266/);
  assert.match(html, /根/);
  assert.match(html, /10-30 01:00/);
  assert.match(html, /核对没有通过/);
  assert.match(html, /id="map"/);
  assert.match(html, /function paintEdges/);
  assert.match(html, /function fullyOpen/);
  assert.match(html, /function setBranch/);
  assert.match(html, /按周/);
});

test("a missing order and a lagging index are both reported", () => {
  const replay = replayNetwork(sampleLogs());
  for (const row of replay.rows) row.directClaimedWei = replay.directClaimed.get(row.wallet) ?? 0n;
  const { problems } = collectProblems({
    replayRows: replay.rows,
    dbRows: [],
    sums: { ...replay.sums, directEvents: replay.rows.reduce((sum, row) => sum + row.directWei, 0n) },
    chainTotals: null,
    contributions: [{ wallet: B, tx: `0x${"b".repeat(64)}`, amountWei: 1_000n * UNIT }],
    orders: [],
  });
  assert.ok(problems.some((line) => line.includes("没有对应订单")));
  assert.ok(problems.some((line) => line.includes("索引里没有")));
});

test("orders that match the chain stay quiet, and headroom uses the 25% cap", () => {
  const tx = `0x${"b".repeat(64)}`;
  assert.deepEqual(compareOrders(
    [{ wallet: B, tx, amountWei: 1_000n * UNIT }],
    [{ wallet: B, tx, amountUsdt: 1000 }],
  ), []);
  const room = marketHeadroom({ contributedWei: 1_000n * UNIT, importedWei: 0n, directWei: 100n * UNIT, teamWei: 0n });
  assert.equal(room.cap, 250n * UNIT);
  assert.equal(room.room, 150n * UNIT);
  assert.equal(room.ratioBps, 1000n);
});

test("indexed orders rebuild the same rewards and a chain mismatch is reported", () => {
  const unix = Date.parse("2026-10-30T00:30:00+08:00") / 1000;
  const rows = [
    { wallet: A, referrer: null, selfWei: 100n * UNIT, teamWei: 11_000n * UNIT, directWei: 100n * UNIT, teamRewardWei: 70n * UNIT, historicalTeamRewardWei: 0n, claimedWei: 70n * UNIT },
    { wallet: B, referrer: A, selfWei: 11_000n * UNIT, teamWei: 0n, directWei: 0n, teamRewardWei: 0n, historicalTeamRewardWei: 0n, claimedWei: 0n },
  ];
  const orders = [{ wallet: B, amountWei: 1_000n * UNIT, unix, tx: "0x1", at: "2026-10-30T00:30:00.000Z", timeText: "10-30 00:30" }];
  const built = accountsFromIndex({ rows, orders, notes: new Map([[A.toLowerCase(), "根"]]) });
  assert.equal(built.accounts[0].note, "根");
  assert.equal(built.accounts[0].importedWei, 100n * UNIT);
  assert.equal(built.accounts[1].deposits[0].timeText, "10-30 00:30");
  const books = flowsFromBooks({
    rows,
    orders,
    payouts: [
      { kind: "direct", amountWei: 100n * UNIT, unix: unix + 60 },
      { kind: "team", amountWei: 70n * UNIT, unix: unix + 120 },
    ],
  });
  const replay = Object.fromEntries(books.rows.map((row) => [row.wallet, row]));
  assert.equal(replay[A].directWei, 100n * UNIT);
  assert.equal(replay[A].teamRewardWei, 70n * UNIT);
  const series = buildDailySeries(books.flows);
  assert.equal(series[0].remainWei, (830n * UNIT).toString());
  const { accountProblems } = compareBooksToChain({
    accounts: built.accounts,
    chainByWallet: new Map([[A, { accountOk: true, claimedOk: true, account: { referrer: null, selfVolume: 90n * UNIT, directRewards: 100n * UNIT, claimed: 0n, registered: true }, teamClaimed: 70n * UNIT }]]),
    chainTotals: null,
    orderWei: 1_000n * UNIT,
  });
  assert.ok(accountProblems.some((line) => line.includes("本人业绩")));
});

test("weeks sum new receipts and keep the last running total", () => {
  const flows = [
    { kind: "in", block: 1, logIndex: 0, unix: Date.parse("2026-10-26T10:00:00+08:00") / 1000, amountWei: 100n * UNIT },
    { kind: "in", block: 2, logIndex: 0, unix: Date.parse("2026-10-27T10:00:00+08:00") / 1000, amountWei: 50n * UNIT },
    { kind: "directClaim", block: 3, logIndex: 0, unix: Date.parse("2026-10-27T12:00:00+08:00") / 1000, amountWei: 10n * UNIT },
  ];
  const days = buildDailySeries(flows);
  const weeks = rollupWeeks(days);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].label, "10-26 当周");
  assert.equal(weeks[0].newInWei, (150n * UNIT).toString());
  assert.equal(weeks[0].cumInWei, (150n * UNIT).toString());
  assert.equal(weeks[0].remainWei, (140n * UNIT).toString());
});
