import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes, zeroHash } from "viem";
import { compareRootPublication, formatShanghai, leavesFromDocument, publicationSearchFloor } from "./onchain-root.mjs";

const ROOT = `0x${"11".repeat(32)}`;
const HASH = `0x${"22".repeat(32)}`;

test("publication search stays inside the recent window", () => {
  assert.equal(publicationSearchFloor(1_000_000n, 0n), 600_000n);
  assert.equal(publicationSearchFloor(1_000_000n, 900_000n), 900_000n);
  assert.equal(publicationSearchFloor(1_000_000n, 100n), 600_000n);
  assert.equal(publicationSearchFloor(1000n, 0n), 0n);
});

test("shanghai time is the block clock plus eight hours", () => {
  assert.equal(formatShanghai(0n), "1970-01-01 08:00:00 +08");
  assert.equal(formatShanghai(null), null);
});

test("an unpublished root is not the same as a new one", () => {
  const result = compareRootPublication({
    chain: { root: zeroHash, contentHash: zeroHash, cumulative: 0n, leaves: null },
    next: { root: ROOT, contentHash: HASH, cumulative: 10n, leaves: 2 },
  });
  assert.equal(result.published, false);
  assert.equal(result.same, false);
});

test("root, content hash and cumulative must all match before skipping a publish", () => {
  const chain = { root: ROOT, contentHash: HASH, cumulative: 10n, leaves: 2 };
  assert.equal(compareRootPublication({ chain, next: { root: ROOT, contentHash: HASH, cumulative: "10", leaves: 2 } }).same, true);
  assert.equal(compareRootPublication({ chain, next: { root: ROOT, contentHash: HASH, cumulative: 11n, leaves: 2 } }).same, false);
  assert.equal(compareRootPublication({ chain, next: { root: ROOT, contentHash: HASH, cumulative: 10n, leaves: 3 } }).same, false);
  const withoutLeaves = compareRootPublication({
    chain: { ...chain, leaves: null },
    next: { root: ROOT.toUpperCase(), contentHash: HASH, cumulative: 10n, leaves: 9 },
  });
  assert.equal(withoutLeaves.same, true);
  assert.equal(withoutLeaves.fields.leaves, undefined);
});

test("a public file counts leaves only when its content hash matches the chain", () => {
  const doc = { entries: [["0x1111111111111111111111111111111111111111", "1"]] };
  const hash = keccak256(toBytes(JSON.stringify(doc.entries)));
  assert.equal(leavesFromDocument(doc, hash).leaves, 1);
  assert.equal(leavesFromDocument(doc, HASH).leaves, null);
  assert.match(leavesFromDocument(doc, HASH).uriNote, /不一致/);
});
