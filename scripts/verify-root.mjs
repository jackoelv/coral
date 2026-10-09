#!/usr/bin/env node
/**
 * 用公开明细重算 Merkle root，和链上 contentHash / root 比对。
 * 不一致只打印，不在链上挑战。没有文件时不假装已核对。
 *
 *   node scripts/verify-root.mjs scripts/fixtures/root-public.json
 */
import { readFile } from "node:fs/promises";
import { keccak256, toBytes } from "viem";
import { buildMerkle } from "./lib/merkle.mjs";

const file = process.argv[2];
if (!file) {
  console.log("用法：node scripts/verify-root.mjs <明细.json>");
  console.log("JSON 形如 {\"root\",\"contentHash\",\"entries\":[[\"0x...\",\"wei\"]]}");
  process.exit(0);
}

const doc = JSON.parse(await readFile(file, "utf8"));
const entries = doc.entries.map(([account, cumulative]) => ({ account, cumulative: BigInt(cumulative) }));
const tree = buildMerkle(entries);
const contentHash = keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()]))));
const rootOk = tree.root === doc.root;
const hashOk = contentHash === doc.contentHash;
console.log(JSON.stringify({ leaves: entries.length, rootOk, hashOk, root: tree.root, contentHash }));
if (!rootOk || !hashOk) {
  console.log("核对失败。这是链下差异：请发布方说明，并用更正后的 root 再发一期。");
  process.exit(1);
}
console.log("核对通过。");
