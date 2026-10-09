#!/usr/bin/env node
/**
 * Recomputes a published root from its public file and compares it with the chain and the database.
 *
 *   npm run verify-root:mainnet -- mainnet-run/roots/<file>.json
 *   npm run verify-root:mainnet -- <file> --db preview
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { keccak256, parseAbi, toBytes } from "viem";
import { buildMerkle } from "./lib/merkle.mjs";
import { contracts, json, mainnetClient, readMainnetEnv, selectedDatabase, writeEvidence } from "./lib/mainnet.mjs";

const file = process.argv.slice(2).find((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--db");
if (!file) throw new Error("用法：npm run verify-root:mainnet -- <明细文件>");
const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const db = selectedDatabase(env);
const doc = JSON.parse(readFileSync(resolve(file), "utf8"));
const entries = doc.entries.map(([account, cumulative]) => ({ account, cumulative: BigInt(cumulative) }));
const tree = buildMerkle(entries);
const contentHash = keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()]))));
const sum = entries.reduce((s, e) => s + e.cumulative, 0n);
const ABI = parseAbi(["function merkleRoot() view returns (bytes32)", "function contentHash() view returns (bytes32)", "function committed() view returns (uint256)"]);
const [root, hash, committed] = await Promise.all(["merkleRoot", "contentHash", "committed"].map((fn) => client.readContract({ address: a.REWARDS, abi: ABI, functionName: fn })));

const pgClient = new pg.Client({ connectionString: db.url, ssl: { rejectUnauthorized: false } });
await pgClient.connect();
let active;
let proofCount;
try {
  active = (await pgClient.query(`SELECT root, content_hash, cumulative_wei, tx_hash FROM coral_team_root WHERE chain_id = 56 AND ido_address = $1 AND active`, [a.IDO])).rows;
  proofCount = Number((await pgClient.query(`SELECT count(*) AS n FROM coral_team_proof WHERE chain_id = 56 AND ido_address = $1 AND root = $2`, [a.IDO, doc.root])).rows[0].n);
} finally {
  await pgClient.end();
}
const checks = {
  fileRoot: tree.root === doc.root,
  fileContentHash: contentHash === doc.contentHash,
  chainRoot: root === doc.root,
  chainContentHash: hash === doc.contentHash,
  chainCommitted: committed === sum,
  dbOneActive: active.length === 1,
  dbActiveRoot: active[0]?.root === doc.root && active[0]?.content_hash === doc.contentHash && active[0]?.cumulative_wei === sum.toString(),
  dbProofs: proofCount === entries.length,
};
const ok = Object.values(checks).every(Boolean);
console.log(json({ leaves: entries.length, cumulative: sum, root: doc.root, db: db.name, checks, ok }));
console.log(`证据 ${writeEvidence("verify-root", { file: resolve(file), checks, ok })}`);
if (!ok) {
  console.error("核对失败。不要再发布，先查清哪一项不一致。");
  process.exit(1);
}
