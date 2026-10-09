import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareImport } from "./tree.mjs";
import { remapForNetwork, simulatedAddress } from "./addresses.mjs";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

test("simulated addresses are stable and not the source wallet", () => {
  const one = simulatedAddress("local", "user-1");
  const two = simulatedAddress("local", "user-1");
  const other = simulatedAddress("bscTestnet", "user-1");
  assert.equal(one, two);
  assert.match(one, /^0x[a-f0-9]{40}$/);
  assert.notEqual(one, other);
});

test("local remap keeps the tree and volumes, mainnet keeps wallets", () => {
  const prepared = prepareImport([
    { id: "a", wallet: A, inviteCode: "ROOTANVL", referrerId: null, selfUsdt: 1000 },
    { id: "b", wallet: B, inviteCode: "BOB00001", referrerId: "a", selfUsdt: 500 },
  ]);
  assert.equal(prepared.ok, true);

  const local = remapForNetwork(prepared.records, "local");
  const byId = Object.fromEntries(local.records.map((r) => [r.id, r]));
  assert.equal(byId.b.referrer, byId.a.wallet);
  assert.notEqual(byId.a.wallet, A.toLowerCase());
  assert.equal(byId.b.selfWei, prepared.records.find((r) => r.id === "b").selfWei);
  assert.equal(byId.a.teamWei, prepared.records.find((r) => r.id === "a").teamWei);
  assert.equal(local.map.length, 2);

  const main = remapForNetwork(prepared.records, "bscMainnet");
  assert.equal(main.records.find((r) => r.id === "a").wallet, A.toLowerCase());
  assert.equal(main.map[0].simulated, false);
});
