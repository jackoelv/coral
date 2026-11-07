import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyLog, emptyIndexState, restoreDirectBps } from "./reward-index.mjs";
import {
  UNIT,
  bpsForQual,
  bind,
  contribute,
  createState,
  directOf,
  seedSelf,
  teamOf,
  TIERS,
  TIERS_V2,
  tiersForBlock,
  directBpsForBlock,
  directBpsProblem,
  rewardOptionsForBlock,
  setRole,
} from "./team-reward.mjs";

const golden = JSON.parse(readFileSync(new URL("../fixtures/team-golden.json", import.meta.url), "utf8"));
const u = (n) => BigInt(n) * UNIT;

function assertUnits(actual, expected) {
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(actual(k).toString(), (BigInt(v) * UNIT).toString(), k);
  }
}

test("bps boundaries", () => {
  assert.equal(bpsForQual(u(499)), 0n);
  assert.equal(bpsForQual(u(500)), 300n);
  assert.equal(bpsForQual(u(2000)), 500n);
  assert.equal(bpsForQual(u(10000)), 700n);
  assert.equal(bpsForQual(u(30000)), 900n);
  assert.equal(bpsForQual(u(60000)), 1000n);
});

test("self 10k then direct 1000 pays 10 percent direct and 7 percent team", () => {
  const s = createState();
  bind(s, "bob", null);
  bind(s, "carol", "bob");
  contribute(s, "bob", u(10_000));
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(bpsForQual(s.self.get("bob") + (s.team.get("bob") ?? 0n)), 700n);

  const tx = contribute(s, "carol", u(1000));
  assert.equal(tx.directTo, "bob");
  assert.equal(tx.directPaid, u(100));
  assert.equal(directOf(s, "bob"), u(100));
  assert.equal(teamOf(s, "bob"), u(70));
});

test("golden self500 then recruit 1000", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(500));
  contribute(s, "bob", u(1000));
  const g = golden.cases[0];
  assertUnits((k) => directOf(s, k), g.direct);
  assertUnits((k) => teamOf(s, k), g.team);
});

test("golden self 30k then recruit 10k", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(30_000));
  contribute(s, "bob", u(10_000));
  const g = golden.cases[1];
  assertUnits((k) => directOf(s, k), g.direct);
  assertUnits((k) => teamOf(s, k), g.team);
});

test("golden ABCD", () => {
  const s = createState();
  for (const [who, ref] of [
    ["alice", null],
    ["bob", "alice"],
    ["carol", "bob"],
    ["dave", "carol"],
  ]) {
    bind(s, who, ref);
  }
  contribute(s, "alice", u(10_000));
  contribute(s, "bob", u(10_000));
  assert.equal(teamOf(s, "alice"), u(700));
  contribute(s, "carol", u(10_000));
  assert.equal(teamOf(s, "bob"), u(700));
  assert.equal(teamOf(s, "alice"), u(700));
  const { self, team } = s;
  const qual = self.get("alice") + team.get("alice");
  assert.equal(bpsForQual(qual), 900n);
  contribute(s, "dave", u(10_000));
  const g = golden.cases[2];
  assertUnits((k) => directOf(s, k), g.direct);
  assertUnits((k) => teamOf(s, k), g.team);
});

test("golden two max-tier overlay is 21 percent", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  contribute(s, "alice", u(60_000));
  contribute(s, "bob", u(60_000));
  const before = teamOf(s, "alice") + directOf(s, "bob") + teamOf(s, "bob");
  const tx = contribute(s, "carol", u(10_000));
  const g = golden.cases[3];
  assertUnits((k) => directOf(s, k), g.direct);
  assertUnits((k) => teamOf(s, k), g.team);
  const spent = tx.directPaid + tx.deltas.reduce((a, d) => a + d.amount, 0n);
  assert.equal(spent, u(g.lastTxTeamPlusDirect));
  assert.equal(teamOf(s, "alice") - u(6000), u(100));
  assert.ok(before >= 0n);
});

test("golden overlay pays nearest max tier", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  bind(s, "dave", "carol");
  contribute(s, "alice", u(60_000));
  contribute(s, "bob", u(60_000));
  contribute(s, "carol", u(60_000));
  const aliceBefore = teamOf(s, "alice");
  const bobBefore = teamOf(s, "bob");
  const carolBefore = teamOf(s, "carol");
  contribute(s, "dave", u(10_000));
  assert.equal(directOf(s, "carol"), u(1000));
  assert.equal(teamOf(s, "carol") - carolBefore, u(1000));
  assert.equal(teamOf(s, "bob") - bobBefore, u(100));
  assert.equal(teamOf(s, "alice") - aliceBefore, 0n);
});

test("qualified referrer earns direct and team on a 50 deposit", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(100));
  const atFloor = contribute(s, "bob", u(50));
  assert.equal(atFloor.directPaid, u(5));
  assert.equal(directOf(s, "alice"), u(5));
  assert.equal(teamOf(s, "alice"), 0n);
  assert.equal(s.team.get("alice"), u(50));

  contribute(s, "alice", u(400));
  const atTier = contribute(s, "bob", u(50));
  assert.equal(atTier.directPaid, u(5));
  assert.equal(teamOf(s, "alice"), (u(50) * 300n) / 10_000n);
});

test("unqualified referrer earns nothing and the gap moves up", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  contribute(s, "alice", u(500));
  contribute(s, "bob", u(50));
  const tx = contribute(s, "carol", u(100));
  assert.equal(tx.directTo, "bob");
  assert.equal(tx.directPaid, 0n);
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(directOf(s, "alice"), u(5));
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "alice"), (u(150) * 300n) / 10_000n);
  assert.equal(s.team.get("bob"), u(100));
});

test("crossing 100 does not backfill earlier downline deposits", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(50));
  contribute(s, "bob", u(1_000));
  assert.equal(directOf(s, "alice"), 0n);
  assert.equal(teamOf(s, "alice"), 0n);
  contribute(s, "alice", u(50));
  assert.equal(directOf(s, "alice"), 0n);
  assert.equal(teamOf(s, "alice"), 0n);
  contribute(s, "bob", u(100));
  assert.equal(directOf(s, "alice"), u(10));
  assert.equal(teamOf(s, "alice"), (u(100) * 300n) / 10_000n);
  assert.equal(s.team.get("alice"), u(1_100));
});

test("zero self with a huge downline takes no differential and no overlay", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  bind(s, "dave", "bob");
  contribute(s, "alice", u(60_000));
  contribute(s, "carol", u(60_000));
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(s.team.get("bob"), u(60_000));
  const before = teamOf(s, "alice");
  const tx = contribute(s, "dave", u(1_000));
  assert.equal(tx.directPaid, 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "alice") - before, u(100));
  assert.equal(tx.overlay, 0n);
});

test("single max tier has no overlay", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(60_000));
  contribute(s, "bob", u(10_000));
  const g = golden.cases[5];
  assertUnits((k) => directOf(s, k), g.direct);
  assertUnits((k) => teamOf(s, k), g.team);
});

test("deposit 99 pays a qualified upline and nothing to the depositor", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(500));
  const tx = contribute(s, "bob", u(99));
  assert.equal(tx.directPaid, u(99) / 10n);
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "alice"), (u(99) * 300n) / 10_000n);
});

test("top up 1 then a new recruit pays direct, the deposit made at 99 is not backfilled", () => {
  const s = createState();
  bind(s, "bob", null);
  bind(s, "carol", "bob");
  bind(s, "dave", "bob");
  contribute(s, "bob", u(99));
  contribute(s, "carol", u(100));
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  contribute(s, "bob", u(1));
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  const tx = contribute(s, "dave", u(100));
  assert.equal(tx.directPaid, u(10));
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(s.team.get("bob"), u(200));
});

test("self 100 and downline 300 stays under 500 so team stays zero", () => {
  const s = createState();
  bind(s, "bob", null);
  bind(s, "carol", "bob");
  contribute(s, "bob", u(100));
  const tx = contribute(s, "carol", u(300));
  assert.equal(tx.directPaid, u(30));
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(s.self.get("bob") + s.team.get("bob"), u(400));
});

test("self 500 earns 3 percent team on the next deposit", () => {
  const s = createState();
  bind(s, "bob", null);
  bind(s, "carol", "bob");
  contribute(s, "bob", u(500));
  const tx = contribute(s, "carol", u(100));
  assert.equal(tx.directPaid, u(10));
  assert.equal(teamOf(s, "bob"), u(3));
});

test("qual 400 pays no team, adding 100 self then a later deposit pays 3 percent", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(400));
  const before = contribute(s, "bob", u(100));
  assert.equal(before.directPaid, u(10));
  assert.equal(teamOf(s, "alice"), 0n);
  contribute(s, "alice", u(100));
  assert.equal(teamOf(s, "alice"), 0n);
  const after = contribute(s, "bob", u(100));
  assert.equal(after.directPaid, u(10));
  assert.equal(teamOf(s, "alice"), u(3));
});

test("crossing 2000 on a downline deposit still pays the old 3 percent, the next deposit pays 5", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "alice");
  contribute(s, "alice", u(500));
  const crossing = contribute(s, "bob", u(1500));
  assert.equal(crossing.directPaid, u(150));
  assert.equal(teamOf(s, "alice"), (u(1500) * 300n) / 10_000n);
  assert.equal(s.self.get("alice") + s.team.get("alice"), u(2000));
  const next = contribute(s, "carol", u(100));
  assert.equal(next.directPaid, u(10));
  assert.equal(teamOf(s, "alice") - (u(1500) * 300n) / 10_000n, u(5));
});

test("tier boundaries are exact on one wei", () => {
  const edges = [
    [500n, 300n],
    [2_000n, 500n],
    [10_000n, 700n],
    [30_000n, 900n],
    [60_000n, 1_000n],
  ];
  for (const [vol, bps] of edges) {
    assert.equal(bpsForQual(u(vol) - 1n), vol === 500n ? 0n : edges[edges.findIndex((e) => e[0] === vol) - 1][1]);
    assert.equal(bpsForQual(u(vol)), bps);
    const s = createState();
    bind(s, "alice", null);
    bind(s, "bob", "alice");
    seedSelf(s, "alice", u(vol) - 1n);
    contribute(s, "bob", u(100));
    assert.equal(teamOf(s, "alice"), (u(100) * bpsForQual(u(vol) - 1n)) / 10_000n, `below ${vol}`);
    const t = createState();
    bind(t, "alice", null);
    bind(t, "bob", "alice");
    seedSelf(t, "alice", u(vol));
    contribute(t, "bob", u(100));
    assert.equal(teamOf(t, "alice"), (u(100) * bps) / 10_000n, `at ${vol}`);
  }
});

test("one wei below 100 earns no direct, exactly 100 earns on a 1 USDT deposit", () => {
  const below = createState();
  bind(below, "alice", null);
  bind(below, "bob", "alice");
  seedSelf(below, "alice", u(100) - 1n);
  const missed = contribute(below, "bob", u(1));
  assert.equal(missed.directPaid, 0n);
  assert.equal(teamOf(below, "alice"), 0n);

  const exact = createState();
  bind(exact, "alice", null);
  bind(exact, "bob", "alice");
  seedSelf(exact, "alice", u(100));
  const paid = contribute(exact, "bob", u(1));
  assert.equal(paid.directPaid, u(1) / 10n);
  assert.equal(teamOf(exact, "alice"), 0n);
});

test("imported self counts for later rewards and the import itself pays nothing", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  seedSelf(s, "alice", u(1000));
  assert.equal(directOf(s, "alice"), 0n);
  assert.equal(teamOf(s, "alice"), 0n);
  assert.equal(s.team.get("alice") ?? 0n, 0n);
  const tx = contribute(s, "bob", u(100));
  assert.equal(tx.directPaid, u(10));
  assert.equal(teamOf(s, "alice"), u(3));
});

test("unqualified middle node does not compress and is not an overlay slot", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  bind(s, "dave", "carol");
  contribute(s, "alice", u(10_000));
  contribute(s, "bob", u(50));
  contribute(s, "carol", u(2_000));
  const beforeAlice = teamOf(s, "alice");
  const tx = contribute(s, "dave", u(1_000));
  assert.equal(tx.directPaid, u(100));
  assert.equal(directOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "bob"), 0n);
  assert.equal(teamOf(s, "carol") , u(50));
  assert.equal(teamOf(s, "alice") - beforeAlice, u(20));
  assert.equal(tx.overlay, 0n);
});

test("a 60000 deposit does not let the depositor compress an upline still at 3 percent", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  contribute(s, "alice", u(500));
  const tx = contribute(s, "bob", u(60_000));
  assert.equal(tx.directPaid, u(6_000));
  assert.equal(teamOf(s, "alice"), u(1_800));
  assert.equal(teamOf(s, "bob"), 0n);
});

test("three max tiers pay overlay only to the nearest second node", () => {
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  bind(s, "carol", "bob");
  bind(s, "dave", "carol");
  bind(s, "eve", "dave");
  contribute(s, "alice", u(60_000));
  contribute(s, "bob", u(60_000));
  contribute(s, "carol", u(60_000));
  contribute(s, "dave", u(60_000));
  const aliceBefore = teamOf(s, "alice");
  const bobBefore = teamOf(s, "bob");
  const carolBefore = teamOf(s, "carol");
  const tx = contribute(s, "eve", u(1_000));
  assert.equal(tx.directPaid, u(100));
  assert.equal(teamOf(s, "dave"), u(100));
  assert.equal(teamOf(s, "carol") - carolBefore, u(10));
  assert.equal(teamOf(s, "bob") - bobBefore, 0n);
  assert.equal(teamOf(s, "alice") - aliceBefore, 0n);
  assert.equal(tx.overlay, u(10));
});

test("alternating qualified links keep the differential gaps", () => {
  const s = createState();
  const names = ["a", "b", "c", "d", "e", "f"];
  bind(s, "a", null);
  for (let i = 1; i < names.length; i++) bind(s, names[i], names[i - 1]);
  contribute(s, "a", u(60_000));
  contribute(s, "b", u(50));
  contribute(s, "c", u(10_000));
  contribute(s, "d", u(90));
  contribute(s, "e", u(2_000));
  const tx = contribute(s, "f", u(1_000));
  assert.equal(tx.directTo, "e");
  assert.equal(tx.directPaid, u(100));
  assert.equal(directOf(s, "d"), 0n);
  assert.equal(directOf(s, "b"), 0n);
  assert.equal(teamOf(s, "d"), 0n);
  assert.equal(teamOf(s, "b"), 0n);
  assert.equal(teamOf(s, "e"), u(50));
  assert.equal(teamOf(s, "c"), u(1663) / 10n);
  assert.equal(teamOf(s, "a"), u(10977) / 10n);
});

test("v2 tiers start at 1000, 10000 and 80000", () => {
  assert.equal(bpsForQual(u(999), TIERS_V2), 0n);
  assert.equal(bpsForQual(u(1000), TIERS_V2), 300n);
  assert.equal(bpsForQual(u(10_000), TIERS_V2), 500n);
  assert.equal(bpsForQual(u(80_000), TIERS_V2), 1000n);
  assert.equal(tiersForBlock(99, "100"), TIERS);
  assert.equal(tiersForBlock(100, "100"), TIERS_V2);
  assert.equal(tiersForBlock(100, ""), TIERS);

  function teamPaid(tiers) {
    const s = createState();
    bind(s, "up", null);
    bind(s, "down", "up");
    contribute(s, "up", u(500), { tiers });
    contribute(s, "down", u(1000), { tiers });
    return teamOf(s, "up");
  }
  assert.equal(teamPaid(TIERS), u(30));
  assert.equal(teamPaid(TIERS_V2), 0n);
});

function v3(extra = {}) {
  return { v3: true, ...extra };
}

test("v3 on 10u pays 0.5 direct, 0.9 then 0.5 differential, and peer on the actual team reward", () => {
  const s = createState();
  bind(s, "leader", null);
  bind(s, "public", "leader");
  bind(s, "child", "public");
  setRole(s, "leader", "team_leader");
  contribute(s, "leader", u(6_000), v3());
  contribute(s, "public", u(60_000), v3());
  const tx = contribute(s, "child", u(10), v3());
  assert.equal(tx.directPaid, u(5) / 10n);
  assert.equal(tx.deltas.find((row) => row.account === "public" && row.kind === "diff").amount, u(9) / 10n);
  assert.equal(tx.deltas.find((row) => row.account === "leader" && row.kind === "diff").amount, u(5) / 10n);

  const same = createState();
  bind(same, "upper", null);
  bind(same, "lower", "upper");
  bind(same, "child", "lower");
  contribute(same, "upper", u(60_000), v3());
  contribute(same, "lower", u(60_000), v3());
  const nine = contribute(same, "child", u(10), v3());
  assert.equal(nine.directPaid, u(5) / 10n);
  const lowerTeam = nine.deltas.find((row) => row.account === "lower" && row.kind === "diff").amount;
  const peer = nine.deltas.find((row) => row.account === "upper" && row.kind === "overlay").amount;
  assert.equal(lowerTeam, u(9) / 10n);
  assert.equal(peer, u(9) / 100n);

  const tops = createState();
  bind(tops, "upper", null);
  bind(tops, "lower", "upper");
  bind(tops, "child", "lower");
  setRole(tops, "upper", "team_leader");
  setRole(tops, "lower", "team_leader");
  contribute(tops, "upper", u(6_000), v3());
  contribute(tops, "lower", u(6_000), v3());
  const fourteen = contribute(tops, "child", u(10), v3());
  assert.equal(fourteen.deltas.find((row) => row.account === "lower").amount, u(14) / 10n);
  assert.equal(fourteen.deltas.find((row) => row.account === "upper"), undefined);

  const reached = createState();
  bind(reached, "upper", null);
  bind(reached, "lower", "upper");
  bind(reached, "child", "lower");
  setRole(reached, "upper", "team_leader");
  setRole(reached, "lower", "team_leader");
  contribute(reached, "upper", u(60_000), v3());
  contribute(reached, "lower", u(60_000), v3());
  const peerLeader = contribute(reached, "child", u(10), v3());
  assert.equal(peerLeader.deltas.find((row) => row.account === "lower").amount, u(14) / 10n);
  assert.equal(peerLeader.deltas.find((row) => row.account === "upper").amount, u(14) / 100n);
});

test("v3 public 30k tier pays no peer bonus", () => {
  const s = createState();
  bind(s, "upper", null);
  bind(s, "lower", "upper");
  bind(s, "child", "lower");
  contribute(s, "upper", u(20_000), v3());
  contribute(s, "lower", u(30_000), v3());
  const tx = contribute(s, "child", u(100), v3());
  assert.equal(tx.deltas.find((row) => row.account === "lower" && row.kind === "diff").amount, u(6));
  assert.equal(tx.deltas.find((row) => row.account === "upper"), undefined);
});

test("v3 big leader peer waits for 500k volume", () => {
  function peer(lowerSelf) {
    const s = createState();
    bind(s, "upper", null);
    bind(s, "lower", "upper");
    bind(s, "child", "lower");
    setRole(s, "upper", "big_leader");
    setRole(s, "lower", "big_leader");
    contribute(s, "upper", u(1_000), v3());
    contribute(s, "lower", u(lowerSelf), v3());
    return contribute(s, "child", u(10), v3()).deltas.find((row) => row.account === "upper" && row.kind === "overlay");
  }
  assert.equal(peer(6_000), undefined);
  assert.equal(peer(500_000).amount, u(14) / 100n);
});

test("v3 peer uses the compressed team reward and stops at the next same rate", () => {
  const s = createState();
  bind(s, "top", null);
  bind(s, "mid", "top");
  bind(s, "low", "mid");
  bind(s, "child", "low");
  setRole(s, "top", "team_leader");
  setRole(s, "mid", "team_leader");
  contribute(s, "top", u(6_000), v3());
  contribute(s, "mid", u(6_000), v3());
  contribute(s, "low", u(60_000), v3());
  const tx = contribute(s, "child", u(10), v3());
  assert.equal(tx.deltas.find((row) => row.account === "low").amount, u(9) / 10n);
  assert.equal(tx.deltas.find((row) => row.account === "mid").amount, u(5) / 10n);
  assert.equal(tx.deltas.find((row) => row.account === "top").amount, u(5) / 100n);
  assert.equal(tx.deltas.filter((row) => row.account === "top").length, 1);
});

test("v3 big leader needs 1000 self for 8 percent, a team leader can use umbrella volume", () => {
  function pay(role, self, team) {
    const s = createState();
    bind(s, "up", null);
    bind(s, "mid", "up");
    bind(s, "child", "mid");
    setRole(s, "up", role);
    contribute(s, "up", u(self), v3());
    contribute(s, "mid", u(team), v3());
    contribute(s, "child", u(10), v3());
    return teamOf(s, "up");
  }
  assert.equal(pay("big_leader", 500, 1_500), 0n);
  assert.equal(pay("team_leader", 500, 1_500), u(8) / 10n);
  assert.equal(pay("big_leader", 1_000, 0), u(8) / 10n);
});

test("v3 block keeps earlier deposits on the old direct rate and old tiers", () => {
  assert.equal(directBpsForBlock(9, "10"), 1_000n);
  assert.equal(directBpsForBlock(10, "10"), 500n);
  assert.equal(directBpsForBlock(10, ""), 1_000n);
  assert.equal(rewardOptionsForBlock(9, { tierV3Block: "10" }).v3, false);
  assert.equal(rewardOptionsForBlock(10, { tierV3Block: "10" }).v3, true);
  const s = createState();
  bind(s, "alice", null);
  bind(s, "bob", "alice");
  setRole(s, "alice", "team_leader");
  contribute(s, "alice", u(6_000), rewardOptionsForBlock(1, { tierV3Block: "10" }));
  const before = contribute(s, "bob", u(10), rewardOptionsForBlock(1, { tierV3Block: "10" }));
  assert.equal(before.directPaid, u(1));
  assert.equal(before.deltas.find((row) => row.account === "alice").amount, u(5) / 10n);
  assert.equal(rewardOptionsForBlock(10, { tierV3Block: "10" }).directBps, 1_000n);
  const next = contribute(s, "bob", u(10), rewardOptionsForBlock(10, { tierV3Block: "10" }));
  assert.equal(next.directPaid, u(1));
  assert.equal(next.deltas.find((row) => row.account === "alice").amount, u(14) / 10n);
  const switched = contribute(s, "bob", u(10), { ...rewardOptionsForBlock(11, { tierV3Block: "10" }), directBps: 500n });
  assert.equal(switched.directPaid, u(5) / 10n);
});

test("direct bps may move to 500 before the team switch, and must be 500 after it", () => {
  assert.equal(directBpsProblem(500n, 9, "10"), null);
  assert.equal(directBpsProblem(1000n, 9, ""), null);
  assert.match(directBpsProblem(1000n, 10, "10"), /应为 500/);
  assert.match(directBpsProblem(700n, 10, ""), /只接受/);
});

test("indexer direct rate follows the bps event and ignores the team switch block", () => {
  const alice = "0x1111111111111111111111111111111111111111";
  const bob = "0x2222222222222222222222222222222222222222";
  const s = emptyIndexState();
  s.tierV3Block = "100";
  applyLog(s, { eventName: "Contributed", blockNumber: 1n, args: { account: alice, amount: u(100), selfVolume: 0n, nemoAmount: 0n } });
  applyLog(s, { eventName: "Registered", blockNumber: 2n, args: { account: bob, code: "0x00", referrer: alice } });
  applyLog(s, { eventName: "Contributed", blockNumber: 3n, args: { account: bob, amount: u(10), selfVolume: 0n, nemoAmount: 0n } });
  assert.equal(s.direct.get(alice), u(1));
  applyLog(s, { eventName: "DirectReferralBpsUpdated", blockNumber: 4n, args: { bps: 500n } });
  applyLog(s, { eventName: "Contributed", blockNumber: 50n, args: { account: bob, amount: u(10), selfVolume: 0n, nemoAmount: 0n } });
  assert.equal(s.direct.get(alice), u(15) / 10n);
  assert.equal(s.directBpsBlock, 4n);
  assert.equal(s.directBpsProblems.length, 0);
  const restored = emptyIndexState();
  restoreDirectBps(restored, { direct_bps: "500", direct_bps_block: "4" });
  assert.equal(restored.directBps, 500n);
  assert.equal(restored.directBpsBlock, 4n);
});
