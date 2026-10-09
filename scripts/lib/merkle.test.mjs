import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMerkle, hashPair, leafHash } from "./merkle.mjs";

test("sorted-pair proofs rebuild the root", () => {
  const entries = [
    { account: "0x0000000000000000000000000000000000000001", cumulative: 30n * 10n ** 18n },
    { account: "0x0000000000000000000000000000000000000002", cumulative: 70n * 10n ** 18n },
    { account: "0x0000000000000000000000000000000000000003", cumulative: 10n * 10n ** 18n },
  ];
  const tree = buildMerkle(entries);
  for (const entry of entries) {
    const leaf = leafHash(entry.account, entry.cumulative);
    let hash = leaf;
    for (const sibling of tree.proofs.get(leaf)) {
      hash = hashPair(hash, sibling);
    }
    assert.equal(hash, tree.root);
  }
});
