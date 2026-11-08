import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountsFromIndex,
  annotatePhase1Manual,
  assembleAccounts,
  buildDailySeries,
  buildTree,
  layoutVolumeParents,
  collectProblems,
  compareBooksToChain,
  compareIndexTotals,
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
  assert.match(html, /有 1 条需要看/);
  const quiet = renderPage({
    generatedAt: "2026-10-30 10:00:00",
    database: "production",
    ido: "0xido",
    rewards: "0xrewards",
    safeHead: "",
    checked: false,
    scope: "索引检查点 10",
    problems: [],
    notes: [],
    roots: tree.roots,
    days: [],
    weeks: [],
    review: [],
    snapshotName: "network-snapshot-test.json",
  });
  assert.match(quiet, /只读了正式库/);
  assert.match(quiet, /索引检查点 10/);
  assert.doesNotMatch(quiet, /每个地址/);
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
  const totals = compareIndexTotals({
    selfWei: 1_100n * UNIT,
    directWei: 100n * UNIT,
    teamClaimedWei: 70n * UNIT,
    orderWei: 1_000n * UNIT,
    payoutDirectWei: 90n * UNIT,
    payoutTeamWei: 70n * UNIT,
    chainTotals: {
      totalContributed: 1_000n * UNIT,
      totalImported: 100n * UNIT,
      totalDirectAccrued: 100n * UNIT,
      totalClaimed: 100n * UNIT,
      totalTeamPaid: 70n * UNIT,
    },
  });
  assert.deepEqual(totals.problems, []);
  assert.equal(totals.warnings.length, 1);
  const mismatch = compareIndexTotals({
    selfWei: 1n,
    directWei: 1n,
    teamClaimedWei: 1n,
    orderWei: 1n,
    chainTotals: {
      totalContributed: 2n,
      totalImported: 0n,
      totalDirectAccrued: 2n,
      totalClaimed: 2n,
      totalTeamPaid: 2n,
    },
  });
  assert.equal(mismatch.problems.length, 3);
});

test("phase-1 manual payments stay on the recorded wallets", () => {
  const blank = { deposits: [], referrer: null, importedWei: 0n, directWei: 0n, teamRewardWei: 0n, historicalTeamRewardWei: 0n, networkRewardWei: 0n, totalRewardWei: 0n, directClaimedWei: 0n, teamClaimedWei: 0n, teamWei: 0n };
  const accounts = annotatePhase1Manual([
    { ...blank, wallet: "0x30718824324b8Da00C15A8034a8075258Ba90b93", selfWei: 100n * UNIT, networkWei: 100n * UNIT },
    { ...blank, wallet: "0x3b86b370227B4d1714F36e496a26847F6d4EF4Ec", note: "张姐_强子", selfWei: 1000n * UNIT, networkWei: 1000n * UNIT, historicalTeamRewardWei: 3n * UNIT, networkRewardWei: 3n * UNIT, totalRewardWei: 3n * UNIT },
    { ...blank, wallet: "0x450fF060Dd6F9Ab91218A505a034a387836E27a5", note: "强子", selfWei: 100n * UNIT, networkWei: 100n * UNIT, directWei: 1102n * UNIT / 10n, totalRewardWei: 1102n * UNIT / 10n },
  ]);
  const html = renderPage({
    generatedAt: "2026-11-08",
    database: "production",
    ido: "0xido",
    rewards: "0xrewards",
    safeHead: "",
    problems: [],
    notes: [],
    roots: buildTree(accounts).roots,
    days: [],
    weeks: [],
    review: [],
    snapshotName: "t.json",
  });
  const card = (tail) => {
    const start = html.indexOf(`>${tail}<`);
    return html.slice(start, html.indexOf("</button>", start));
  };
  assert.match(card("0b93"), /直推 100（一期手动）/);
  assert.doesNotMatch(card("0b93"), /拨付 10/);
  assert.match(card("F4Ec"), /拨付 10（一期手动）/);
  assert.match(card("F4Ec"), /直推 0/);
  assert.match(card("F4Ec"), /合计 3/);
  assert.doesNotMatch(card("F4Ec"), /直推 100/);
  assert.match(card("27a5"), /直推 110\.2/);
  assert.match(card("27a5"), /拨付 10（一期手动）/);
});

test("volume parent redraws the umbrella and keeps indexed rewards", () => {
  const admin = "0xD25FFDaB817a1961E7c3224403d54a0182550968";
  const qiang = "0x450fF060Dd6F9Ab91218A505a034a387836E27a5";
  const jack = "0xB6c3CcdA14a5e3a82C3788e8c7B0Da1f217115Cb";
  const child = "0xEE61F0fb3712f42F0BF4F3051696583a092ba224";
  const other = "0x1111111111111111111111111111111111111111";
  const blank = { deposits: [], importedWei: 0n, directWei: 0n, teamRewardWei: 0n, historicalTeamRewardWei: 0n, networkRewardWei: 0n, totalRewardWei: 0n, directClaimedWei: 0n, teamClaimedWei: 0n };
  const accounts = [
    { ...blank, wallet: admin, referrer: null, note: "Admin_OKX", selfWei: 0n, teamWei: 51831n * UNIT, networkWei: 51831n * UNIT },
    { ...blank, wallet: qiang, referrer: admin, note: "强子", selfWei: 100n * UNIT, teamWei: 45030n * UNIT, networkWei: 45130n * UNIT, directWei: 1102n * UNIT / 10n, teamRewardWei: 113031n * UNIT / 100n, networkRewardWei: 113031n * UNIT / 100n, totalRewardWei: (1102n * UNIT / 10n) + (113031n * UNIT / 100n) },
    { ...blank, wallet: other, referrer: qiang, selfWei: 45030n * UNIT, teamWei: 0n, networkWei: 45030n * UNIT },
    { ...blank, wallet: jack, referrer: qiang, note: "JACK_BNB", selfWei: 501n * UNIT, teamWei: 6200n * UNIT, networkWei: 6701n * UNIT },
    { ...blank, wallet: child, referrer: jack, note: "天祥", selfWei: 6200n * UNIT, teamWei: 0n, networkWei: 6200n * UNIT },
  ];
  const laid = layoutVolumeParents(accounts, [{ wallet: jack, volumeParent: admin, note: "JACK_BNB" }]);
  assert.equal(laid.problems.length, 0);
  assert.match(laid.notes[0], /JACK_BNB 的计算上级是 Admin_OKX，链上推荐人仍是强子/);
  const tree = buildTree(accounts);
  const root = tree.roots[0];
  assert.equal(root.wallet, admin);
  assert.deepEqual(root.children.map((node) => node.wallet).sort(), [jack, qiang].sort());
  const qiangNode = root.children.find((node) => node.wallet === qiang);
  assert.equal(qiangNode.networkWei, 45130n * UNIT);
  assert.equal(qiangNode.children.some((node) => node.wallet === jack), false);
  assert.equal(qiangNode.directWei, 1102n * UNIT / 10n);
  assert.equal(qiangNode.teamRewardWei, 113031n * UNIT / 100n);
  const jackNode = root.children.find((node) => node.wallet === jack);
  assert.equal(jackNode.networkWei, 6701n * UNIT);
  assert.equal(jackNode.chainReferrer, qiang);
  const html = renderPage({
    generatedAt: "2026-11-08",
    database: "production",
    ido: "0xido",
    rewards: "0xrewards",
    safeHead: "",
    problems: [],
    notes: laid.notes,
    roots: tree.roots,
    days: [],
    weeks: [],
    review: [],
    snapshotName: "t.json",
    volumeMode: true,
  });
  const card = (tail) => {
    const start = html.indexOf(`>${tail}<`);
    return html.slice(start, html.indexOf("</button>", start));
  };
  assert.match(card("15Cb"), /链上推荐人仍是强子/);
  assert.match(card("15Cb"), /业绩 6,701/);
  assert.match(card("27a5"), /业绩 45,130/);
  assert.match(card("27a5"), /直推 110\.2/);
  assert.match(card("27a5"), /网体 1,130\.31/);
  assert.match(html, /业绩按计算上级重算/);
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
