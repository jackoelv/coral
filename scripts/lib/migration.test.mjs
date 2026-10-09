import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroAddress } from "viem";
import { applyPaidOffset, compareWithOldVault, mergeChainContributions, readPaidOffset, scanLogs } from "./migration.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const usdt = (n) => BigInt(n) * 10n ** 18n;

const snapshot = () => [
  { id: "a", wallet: A, inviteCode: "AAAA", referrerId: null, selfUsdt: 0, orders: [] },
  { id: "b", wallet: B, inviteCode: "BBBB", referrerId: "a", selfUsdt: 100, orders: [{ usdt: 100, confirmedAt: "2026-08-06T00:00:00.000Z" }] },
];

test("a deposit on the old vault is added as a dated order", () => {
  const base = snapshot();
  const merged = mergeChainContributions(base, [
    { account: B.toLowerCase(), amountWei: usdt(400).toString(), confirmedAt: "2026-10-07T04:15:03.000Z", block: 126186268n, tx: "0xabc" },
  ]);
  const b = merged.find((u) => u.id === "b");
  assert.equal(b.selfUsdt, 500);
  assert.deepEqual(b.orders.map((o) => o.usdt), [100, 400]);
  assert.equal(b.orders[1].confirmedAt, "2026-10-07T04:15:03.000Z");
  assert.equal(base[1].selfUsdt, 100, "input is not mutated");
  assert.equal(base[1].orders.length, 1);
});

test("a deposit from an unknown wallet or of fractional USDT stops the merge", () => {
  assert.throws(() => mergeChainContributions(snapshot(), [{ account: C, amountWei: usdt(1).toString(), confirmedAt: "2026-10-07T00:00:00Z", block: 1, tx: "0x1" }]), /正式库里没有/);
  assert.throws(() => mergeChainContributions(snapshot(), [{ account: B, amountWei: (usdt(1) + 1n).toString(), confirmedAt: "2026-10-07T00:00:00Z", block: 1, tx: "0x1" }]), /不是整数 USDT/);
});

test("the merged snapshot must equal the old vault address by address", () => {
  const merged = mergeChainContributions(snapshot(), [{ account: B, amountWei: usdt(400).toString(), confirmedAt: "2026-10-07T04:15:03Z", block: 1, tx: "0x1" }]);
  const chain = new Map([
    [A, { registered: true, referrer: zeroAddress, selfVolume: 0n }],
    [B, { registered: true, referrer: A, selfVolume: usdt(500) }],
  ]);
  assert.deepEqual(compareWithOldVault(merged, chain), []);
  const missing = compareWithOldVault(snapshot(), chain);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /本人业绩/, "without the 400 the volume differs from the old vault");
  chain.set(B, { registered: true, referrer: C, selfVolume: usdt(500) });
  assert.match(compareWithOldVault(merged, chain)[0], /上级/);
  chain.delete(A);
  assert.ok(compareWithOldVault(merged, chain).some((p) => /没有注册/.test(p)));
});

test("team rewards claimed on the old contract are subtracted", () => {
  const rows = [
    { wallet: A, selfWei: 0n, teamWei: 0n, teamRewardWei: usdt(173) },
    { wallet: B, selfWei: 0n, teamWei: 0n, teamRewardWei: usdt(3) },
    { wallet: C, selfWei: 0n, teamWei: 0n, teamRewardWei: usdt(3) },
  ];
  const net = applyPaidOffset(rows, new Map([[A, usdt(173)]]));
  assert.deepEqual(net.map((r) => r.teamRewardWei), [0n, usdt(3), usdt(3)]);
  assert.equal(net[0].grossWei, usdt(173));
  assert.equal(net[0].offsetWei, usdt(173));
  assert.equal(net.reduce((s, r) => s + r.teamRewardWei, 0n), usdt(6));
});

test("an offset larger than the recomputed reward, or for a missing address, stops", () => {
  const rows = [{ wallet: A, selfWei: 0n, teamWei: 0n, teamRewardWei: usdt(100) }];
  assert.throws(() => applyPaidOffset(rows, new Map([[A, usdt(101)]])), /大于重算/);
  assert.throws(() => applyPaidOffset(rows, new Map([[B, usdt(1)]])), /没有这个地址/);
});

test("old-paid.json is read as checksummed wei", () => {
  const dir = mkdtempSync(join(tmpdir(), "paid-"));
  const file = join(dir, "old-paid.json");
  writeFileSync(file, JSON.stringify({ paid: { [A.toLowerCase()]: usdt(173).toString() } }));
  assert.equal(readPaidOffset(file).get(A), usdt(173));
  writeFileSync(file, JSON.stringify({ paid: { [A]: "1.5" } }));
  assert.throws(() => readPaidOffset(file), /整数 wei/);
});

test("scanLogs splits a failing range and keeps chain order", async () => {
  const calls = [];
  const client = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock > 1n) throw new Error("range too large");
      const out = [];
      for (let b = fromBlock; b <= toBlock; b++) out.push({ blockNumber: b, logIndex: 0 });
      return out.reverse();
    },
  };
  const logs = await scanLogs(client, { address: A, events: [], fromBlock: 10n, toBlock: 15n, chunk: 6n });
  assert.deepEqual(logs.map((l) => l.blockNumber), [10n, 11n, 12n, 13n, 14n, 15n]);
  assert.ok(calls.length > 1);
});
