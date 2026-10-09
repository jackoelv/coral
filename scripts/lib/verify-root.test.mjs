import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { buildMerkle } from "./merkle.mjs";

test("public leaf file rebuilds the published root", () => {
  const entries = [
    { account: "0x0000000000000000000000000000000000000001", cumulative: 10n },
    { account: "0x0000000000000000000000000000000000000002", cumulative: 20n },
  ];
  const tree = buildMerkle(entries);
  const contentHash = keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()]))));
  const again = buildMerkle(entries.map((e) => ({ ...e })));
  assert.equal(again.root, tree.root);
  assert.equal(contentHash, keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()])))));
});
