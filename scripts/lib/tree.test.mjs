import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareImport, codeToBytes32, toWei } from "./tree.mjs";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const C = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("codeToBytes32 left-pads ASCII", () => {
  const hex = codeToBytes32("ROOTANVL");
  assert.equal(hex.slice(0, 18), "0x" + Buffer.from("ROOTANVL", "ascii").toString("hex"));
  assert.equal(hex.length, 66);
});

test("uncompressed team volume and topo order", () => {
  const { ok, records, stats, errors } = prepareImport([
    { id: "a", wallet: A, inviteCode: "ROOTANVL", referrerId: null, selfUsdt: 1000 },
    { id: "c", wallet: C, inviteCode: "CAROL001", referrerId: "b", selfUsdt: 5000 },
    { id: "b", wallet: B, inviteCode: "BOB00001", referrerId: "a", selfUsdt: 1000 },
  ]);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(stats.users, 3);
  assert.equal(stats.maxDepth, 2);
  const byWallet = Object.fromEntries(records.map((r) => [r.wallet.toLowerCase(), r]));
  assert.equal(byWallet[A.toLowerCase()].teamWei, toWei(6000).toString());
  assert.equal(byWallet[B.toLowerCase()].teamWei, toWei(5000).toString());
  assert.equal(byWallet[C.toLowerCase()].teamWei, "0");
  assert.deepEqual(
    records.map((r) => r.inviteCode),
    ["ROOTANVL", "BOB00001", "CAROL001"],
  );
});

test("cycle is an error", () => {
  const { ok, errors } = prepareImport([
    { id: "a", wallet: A, inviteCode: "AAAA0001", referrerId: "b", selfUsdt: 1 },
    { id: "b", wallet: B, inviteCode: "BBBB0001", referrerId: "a", selfUsdt: 1 },
  ]);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.type === "cycle" || e.type === "cycle_walk"));
});
