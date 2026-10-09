#!/usr/bin/env node
/**
 * Builds the team-reward Merkle root from the database and has MAINNET_PUBLISHER sign publishRoot
 * in the local sign page. Proofs are saved inactive first; the root becomes active in the database
 * only after a successful receipt and an on-chain check.
 *
 *   npm run publish:mainnet                          preview, compares the chain root, checks the 25% cap and maxRootIncrease
 *   npm run publish:mainnet -- --apply               same comparison; skip the signature when the chain already matches
 *   npm run publish:mainnet -- --content-uri         publish only the leaf-file URL, and only when the root already matches
 *   npm run publish:mainnet -- --content-uri --apply sign that URL; root, contentHash and cumulative stay the same
 *   npm run publish:mainnet -- --resume <plan>       reopen the same plan after a failed or closed signing
 *   add --db preview to use the preview.freedao.life database
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { getAddress, keccak256, parseAbi, toBytes } from "viem";
import { contentUriFor, decideContentUriPublish, rootFileName } from "./lib/content-uri.mjs";
import { buildMerkle, leafHash } from "./lib/merkle.mjs";
import { compareRootPublication, leavesFromDocument, readOnchainPublication } from "./lib/onchain-root.mjs";
import { ensureSchema, loadAccounts, lockName, saveRoot, tryLock, unlock } from "./lib/reward-db.mjs";
import { buildPlan, planTx, readPlan, writePlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";
import { contracts, json, mainnetClient, need, readMainnetEnv, roles, runPath, selectedDatabase, writeEvidence } from "./lib/mainnet.mjs";

const REWARDS = parseAbi([
  "function publisher() view returns (address)",
  "function merkleRoot() view returns (bytes32)",
  "function contentHash() view returns (bytes32)",
  "function committed() view returns (uint256)",
  "function contentUri() view returns (string)",
  "function totalTeamPaid() view returns (uint256)",
  "function maxRootIncrease() view returns (uint256)",
  "function rewardCap() view returns (uint256)",
]);
const VAULT = parseAbi(["function totalDirectAccrued() view returns (uint256)", "function rewards() view returns (address)"]);
const PUBLISH = "function publishRoot(bytes32 root, bytes32 contentHash, uint256 cumulative, string uri)";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const contentUriOnly = args.includes("--content-uri");
const resume = args.includes("--resume") ? resolve(args[args.indexOf("--resume") + 1]) : null;
const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const { publisher } = roles(env, { requirePublisher: true });
const db = selectedDatabase(env);
console.log(`当前数据库：${db.name}（库名 ${db.target.database}，主机 ${db.target.host}）。${db.name === "production" ? "这是正式库 neondb，不是 preview。" : "这是 preview 库，不是正式库 neondb。链是同一条主网。"}`);
if (getAddress(await client.readContract({ address: a.IDO, abi: VAULT, functionName: "rewards" })) !== a.REWARDS) throw new Error("金库的 rewards 不是 BSC_MAINNET_REWARDS");
const onchainPublisher = getAddress(await client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: "publisher" }));
if (onchainPublisher !== publisher) throw new Error(`链上 publisher 是 ${onchainPublisher}，不是 MAINNET_PUBLISHER`);

// Neon drops idle connections while the sign page waits for the phone; an unhandled
// 'error' event would kill the process mid-signing.
async function connectDb() {
  const c = new pg.Client({ connectionString: db.url, ssl: { rejectUnauthorized: false } });
  c.on("error", (error) => console.error(`数据库连接断开（${error.message}）。签名不受影响，签完登记时会重新连接。`));
  await c.connect();
  return c;
}

const pgClient = await connectDb();

async function activate({ plan, tx }) {
  const m = plan.meta;
  const [root, hash, committed] = await Promise.all(["merkleRoot", "contentHash", "committed"].map((fn) => client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: fn })));
  if (root !== m.root || hash !== m.contentHash || committed !== BigInt(m.cumulative)) throw new Error("回执成功，但链上 root / contentHash / committed 和计划不一致，未标记生效");
  const fresh = await connectDb();
  try {
    await saveRoot(fresh, { chainId: 56, idoAddress: a.IDO, root: m.root, contentHash: m.contentHash, cumulativeWei: BigInt(m.cumulative), txHash: tx.hash, proofs: [], active: true });
  } finally {
    await fresh.end().catch(() => {});
  }
  console.log(`root ${m.root} 已在 ${db.name} 库标为生效。交易 ${tx.hash}`);
  writeEvidence("publish-root", { root: m.root, contentHash: m.contentHash, cumulative: m.cumulative, txHash: tx.hash, db: db.name });
}

async function confirmUri({ plan, tx }) {
  const m = plan.meta;
  const [root, hash, committed, uri] = await Promise.all(["merkleRoot", "contentHash", "committed", "contentUri"].map((fn) => client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: fn })));
  if (root !== m.root || hash !== m.contentHash || committed !== BigInt(m.cumulative) || uri !== m.uri) {
    throw new Error("回执成功，但链上 root 或 contentUri 和这份补链接计划不一致");
  }
  console.log(`contentUri 已写上链：${uri}。交易 ${tx.hash}。root 没有改。`);
  writeEvidence("publish-content-uri", { root: m.root, contentHash: m.contentHash, cumulative: m.cumulative, uri, txHash: tx.hash, db: db.name });
}

function publicDocument(entries, root, contentHash) {
  return { root, contentHash, entries: entries.map((entry) => [entry.account, entry.cumulative.toString()]) };
}

function ensurePublicFile(entries, root, contentHash) {
  const fileName = rootFileName(a.IDO, root);
  const publicFile = runPath("roots", fileName);
  const document = publicDocument(entries, root, contentHash);
  if (!existsSync(publicFile)) writeFileSync(publicFile, `${JSON.stringify(document, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(publicFile, "utf8"));
  const check = leavesFromDocument(saved, contentHash);
  if (check.uriNote) throw new Error(`本地明细 ${publicFile} 和这次的 root 不一致：${check.uriNote}`);
  return { fileName, publicFile };
}

async function remoteLeafCount(uri, contentHash) {
  const response = await fetch(uri, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`明细文件 HTTP ${response.status}：${uri}`);
  const check = leavesFromDocument(await response.json(), contentHash);
  if (check.uriNote) throw new Error(`${uri}：${check.uriNote}`);
  return check.leaves;
}

function startBlock() {
  const raw = (env.INDEX_START_BLOCK || env.START_BLOCK || "").trim();
  if (!raw) return 0n;
  if (!/^\d+$/.test(raw)) throw new Error("INDEX_START_BLOCK 必须是区块号");
  return BigInt(raw);
}

try {
  await ensureSchema(pgClient);
  const chain = await readOnchainPublication({ client, rpc: need(env, "BSC_MAINNET_RPC"), address: a.REWARDS, startBlock: startBlock() });
  if (resume) {
    const plan = readPlan(resume);
    if (plan.meta?.kind === "publishContentUri") {
      if (getAddress(plan.meta.ido) !== a.IDO || plan.meta.db !== db.name) throw new Error("这份计划不是当前金库 / 数据库的补链接计划");
      if (chain.root !== plan.meta.root || chain.contentHash !== plan.meta.contentHash || String(chain.cumulative) !== plan.meta.cumulative) {
        throw new Error("链上 root 已经变了，这份补链接计划不能再签");
      }
      if ((chain.contentUri || "") === plan.meta.uri) console.log("链上 contentUri 已经是这份计划里的链接，不再签名。");
      else await servePlan(resume, { rpc: need(env, "BSC_MAINNET_RPC"), allowed: [a.REWARDS], onConfirmed: confirmUri, walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "" });
    } else if (plan.meta?.kind !== "publishRoot" || getAddress(plan.meta.ido) !== a.IDO || plan.meta.db !== db.name) throw new Error("这份计划不是当前金库 / 数据库的 publishRoot 计划");
    else {
    const comparison = compareRootPublication({
      chain,
      next: { root: plan.meta.root, contentHash: plan.meta.contentHash, cumulative: plan.meta.cumulative, leaves: null },
    });
    console.log(json({ chain, plan: plan.meta.root, match: comparison.fields, same: comparison.same }));
    if (comparison.same) {
      console.log("链上 root、contentHash、累计金额已经和这份计划一致，不再签名。");
      await activate({ plan, tx: { hash: chain.txHash } });
    } else {
      await servePlan(resume, { rpc: need(env, "BSC_MAINNET_RPC"), allowed: [a.REWARDS], onConfirmed: activate, walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "" });
    }
    }
  } else {
    const rows = await loadAccounts(pgClient, 56, a.IDO);
    const entries = rows
      .map((row) => ({ account: getAddress(row.wallet), cumulative: BigInt(row.team_reward_wei || 0) + BigInt(row.historical_team_reward_wei || 0) }))
      .filter((row) => row.cumulative > 0n)
      .sort((x, y) => x.account.toLowerCase().localeCompare(y.account.toLowerCase()));
    if (!entries.length) throw new Error("库里还没有可发放的网体奖。先跑 index:mainnet / settle-team:mainnet");
    const tree = buildMerkle(entries);
    const cumulative = entries.reduce((s, e) => s + e.cumulative, 0n);
    const contentHash = keccak256(toBytes(JSON.stringify(entries.map((e) => [e.account, e.cumulative.toString()]))));
    const [committed, paid, maxIncrease, cap] = await Promise.all(["committed", "totalTeamPaid", "maxRootIncrease", "rewardCap"].map((fn) => client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: fn })));
    const direct = await client.readContract({ address: a.IDO, abi: VAULT, functionName: "totalDirectAccrued" });
    const problems = [];
    if (cumulative < paid) problems.push(`累计 ${cumulative} 小于链上已支付 ${paid}`);
    if (direct + cumulative > cap) problems.push(`直推 + 网体累计 ${direct + cumulative} 超过 25% 帽 ${cap}`);
    if (maxIncrease === 0n) problems.push("链上 maxRootIncrease 是 0，主网必须限额");
    else if (cumulative > committed + maxIncrease) problems.push(`增量 ${cumulative - committed} 超过 maxRootIncrease ${maxIncrease}`);
    const next = { leaves: entries.length, cumulative, root: tree.root, contentHash };
    const comparison = compareRootPublication({ chain, next });
    console.log(json({
      chain,
      next,
      match: comparison.fields,
      same: comparison.same,
      db: `${db.name} ${db.target.host}`,
      increase: cumulative - committed,
      committed,
      maxRootIncrease: maxIncrease,
      directAccrued: direct,
      rewardCap: cap,
      problems,
      apply,
    }));
    if (contentUriOnly) {
      const { fileName, publicFile } = ensurePublicFile(entries, tree.root, contentHash);
      const uri = contentUriFor(env.CONTENT_URI, fileName);
      const decision = decideContentUriPublish({ sameRoot: comparison.same, chainUri: chain.contentUri, nextUri: uri });
      console.log(json({ contentUri: uri, chainContentUri: chain.contentUri || "", action: decision.action, publicFile }));
      if (decision.action === "refuse") throw new Error(decision.message);
      if (decision.action === "skip") {
        console.log(decision.message);
      } else {
        let leaves;
        try {
          leaves = await remoteLeafCount(uri, contentHash);
        } catch (error) {
          throw new Error(`还不能把 contentUri 写上链。先把 ${publicFile} 上传到 ${uri}。${error.message || error}`);
        }
        console.log(`明细文件可以打开，${leaves} 个地址，contentHash 和链上一致。`);
        if (!apply) {
          console.log(`${decision.message}确认后：npm run publish:mainnet -- --content-uri --apply${db.name === "preview" ? " --db preview" : ""}`);
        } else {
          const planPath = runPath("plans", `publish-uri-${tree.root}.json`);
          writePlan(planPath, buildPlan({
            chainId: 56,
            signer: publisher,
            signerRole: "Publisher",
            purpose: `只补 contentUri，不改 root（${entries.length} 个地址，累计 ${cumulative} wei）`,
            meta: { kind: "publishContentUri", ido: a.IDO, db: db.name, root: tree.root, contentHash, cumulative: cumulative.toString(), uri, publicFile },
            txs: [planTx({ label: "publishRoot", contract: "CoralRewards", to: a.REWARDS, signature: PUBLISH, args: [tree.root, contentHash, cumulative, uri] })],
          }));
          await servePlan(planPath, { rpc: need(env, "BSC_MAINNET_RPC"), allowed: [a.REWARDS], onConfirmed: confirmUri, walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "" });
        }
      }
    } else if (comparison.same) {
      console.log("链上 root、contentHash、累计金额和这次计算结果一致，不发布，也不消耗 gas。");
      if (!chain.contentUri) console.log("链上还没有 contentUri。明细文件上传后：npm run publish:mainnet -- --content-uri" + (db.name === "preview" ? " --db preview" : ""));
    } else if (problems.length) {
      throw new Error(problems.join("\n"));
    } else if (!apply) {
      console.log("和链上不一致，需要更新。确认后：npm run publish:mainnet -- --apply");
    } else {
      const name = lockName(56, a.IDO);
      if (!(await tryLock(pgClient, name))) throw new Error("另一个索引或发布进程正在运行");
      let planPath;
      try {
        const proofs = entries.map((e) => ({ wallet: e.account, cumulativeWei: e.cumulative, proof: tree.proofs.get(leafHash(e.account, e.cumulative)) || [] }));
        await saveRoot(pgClient, { chainId: 56, idoAddress: a.IDO, root: tree.root, contentHash, cumulativeWei: cumulative, txHash: null, proofs, active: false });
        const fileName = `56-${a.IDO.toLowerCase()}-${tree.root}.json`;
        const publicFile = runPath("roots", fileName);
        writeFileSync(publicFile, `${JSON.stringify({ root: tree.root, contentHash, entries: entries.map((e) => [e.account, e.cumulative.toString()]) }, null, 2)}\n`);
        const base = env.CONTENT_URI || "";
        const uri = base.endsWith("/") ? `${base}${fileName}` : base;
        planPath = runPath("plans", `publish-root-${tree.root}.json`);
        if (existsSync(planPath)) throw new Error(`已有同一 root 的计划 ${planPath}，用 --resume 继续`);
        const plan = buildPlan({
          chainId: 56,
          signer: publisher,
          signerRole: "Publisher",
          purpose: `发布网体奖 root（${entries.length} 个地址，累计 ${cumulative} wei）`,
          meta: { kind: "publishRoot", ido: a.IDO, db: db.name, root: tree.root, contentHash, cumulative: cumulative.toString(), publicFile },
          txs: [planTx({ label: "publishRoot", contract: "CoralRewards", to: a.REWARDS, signature: PUBLISH, args: [tree.root, contentHash, cumulative, uri] })],
        });
        writePlan(planPath, plan);
        console.log(`proof 已写入 ${db.name} 库（未生效）。公开明细 ${publicFile}${uri ? `，上传到 ${uri}` : "（CONTENT_URI 未设置）"}`);
      } finally {
        await unlock(pgClient, name);
      }
      await servePlan(planPath, { rpc: need(env, "BSC_MAINNET_RPC"), allowed: [a.REWARDS], onConfirmed: activate, walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "" });
      console.log(`下一步：npm run verify-root:mainnet -- ${runPath("roots", `56-${a.IDO.toLowerCase()}-${tree.root}.json`)}`);
    }
  }
} finally {
  await pgClient.end().catch(() => {});
}
