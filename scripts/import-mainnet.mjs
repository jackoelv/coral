#!/usr/bin/env node
/**
 * Imports historical FreeDao users into the mainnet vault with the deployer key.
 * Reads the production database read-only. Keeps real wallets; no test address mapping.
 * Writes only invite codes, referrers and self volume. No CKEY, NFT or direct rewards here.
 *
 *   npm run import:mainnet                 export + checks, no transactions
 *   npm run import:mainnet -- --apply      write missing batches, then verify every address
 *   npm run import:mainnet -- --open       freezeImport (irreversible) + openSale
 *   npm run import:mainnet -- --refresh    re-export before the first --apply
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, getAddress, parseAbi } from "viem";
import { analyzeImport, pendingImport, verifyImported } from "./lib/mainnet-import.mjs";
import {
  ROOT,
  cleanEnv,
  confirmTyped,
  contracts,
  deployerAccount,
  mainnetClient,
  need,
  productionDatabase,
  readMainnetEnv,
  runPath,
  sendAsDeployer,
  sha256File,
  writeEvidence,
} from "./lib/mainnet.mjs";
import { chunk } from "./lib/tree.mjs";

const BATCH = 40;
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const open = args.includes("--open");
const refresh = args.includes("--refresh");
const FILE = runPath("import-data.json");
const LOCK = runPath("import-lock.json");

const VAULT = parseAbi([
  "function owner() view returns (address)",
  "function importFrozen() view returns (bool)",
  "function saleOpen() view returns (bool)",
  "function nftInterest() view returns (address)",
  "function totalImported() view returns (uint256)",
  "function codeToAccount(bytes32) view returns (address)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
  "function importUsers(address[] wallets, bytes32[] codes)",
  "function importReferrers(address[] wallets, address[] referrers)",
  "function importVolumes(address[] wallets, uint256[] selfVolumes)",
  "function freezeImport()",
  "function openSale()",
]);
const INTEREST = parseAbi(["function saleOpened() view returns (bool)"]);

const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);

function exportFresh() {
  const url = need(env, "DATABASE_URL");
  const target = productionDatabase(url);
  const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/export-freedao.mjs"), "--network", "bscMainnet", "--out", FILE], {
    cwd: ROOT,
    env: cleanEnv({ DATABASE_URL: url }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`导出失败\n${(result.stderr || result.stdout).split(url).join("[DATABASE_URL]")}`);
  console.log(`从正式库 ${target.host}/${target.database} 只读导出到 ${FILE}`);
}

function load() {
  const data = JSON.parse(readFileSync(FILE, "utf8"));
  if (data.network !== "bscMainnet") throw new Error("导入文件不是 bscMainnet 导出的");
  if (!data.ok) throw new Error(`导出检查没通过：${JSON.stringify(data.errors).slice(0, 2000)}`);
  return data.records;
}

async function chainState(records) {
  const map = new Map();
  for (const group of chunk(records, 25)) {
    const rows = await Promise.all(group.map((r) => client.readContract({ address: a.IDO, abi: VAULT, functionName: "getAccount", args: [getAddress(r.wallet)] })));
    group.forEach((r, i) => map.set(getAddress(r.wallet), rows[i]));
  }
  return map;
}

async function codeOwners(records) {
  const { codeToBytes32 } = await import("./lib/tree.mjs");
  const map = new Map();
  for (const group of chunk(records, 25)) {
    const codes = group.map((r) => codeToBytes32(r.inviteCode));
    const owners = await Promise.all(codes.map((c) => client.readContract({ address: a.IDO, abi: VAULT, functionName: "codeToAccount", args: [c] })));
    codes.forEach((c, i) => map.set(c.toLowerCase(), getAddress(owners[i])));
  }
  return map;
}

async function verifyAll(records, analysis) {
  const state = await chainState(records);
  const problems = verifyImported(records, state, await codeOwners(records));
  const totalImported = await client.readContract({ address: a.IDO, abi: VAULT, functionName: "totalImported" });
  if (totalImported !== analysis.totalWei) problems.push(`totalImported ${totalImported} 不等于文件合计 ${analysis.totalWei}`);
  return { problems, totalImported };
}

if (refresh && existsSync(LOCK)) throw new Error("已经开始写链，不能重新导出。输入文件要和第一次 --apply 时一致");
if (existsSync(runPath("old-cutoff.json"))) {
  if (!existsSync(runPath("migration-snapshot.json"))) throw new Error("旧合约已关闭，处于迁移中。先跑 npm run snapshot:mainnet，它会把旧金库上的入金并进导入文件");
  if (refresh || !existsSync(FILE)) throw new Error("迁移中不能从正式库重新导出，会漏掉旧金库上的入金。重跑 npm run snapshot:mainnet 生成导入文件");
}
if (!existsSync(FILE) || (refresh && !apply && !open)) exportFresh();
const records = load();
const analysis = analyzeImport(records);
const sha = sha256File(FILE);
const nftRows = records
  .map((r) => ({ wallet: r.wallet, self: BigInt(r.selfWei || 0) }))
  .filter((r) => r.self >= 1000n * 10n ** 18n);
console.log(JSON.stringify({
  file: FILE,
  sha256: sha,
  records: analysis.count,
  totalSelfUsdt: formatUnits(analysis.totalWei, 18),
  totalNfts: analysis.totalNfts,
  maxDepth: analysis.maxDepth,
  withNft: nftRows.length,
  errors: analysis.errors,
  ido: a.IDO,
  mode: open ? "open" : apply ? "apply" : "preview",
}, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
for (const r of nftRows) console.log(`  ${r.wallet} 本人 ${formatUnits(r.self, 18)} USDT -> NFT ${r.self / (500n * 10n ** 18n)} 张`);
if (analysis.errors.length) throw new Error("导入文件有问题，未发送交易。先在源库修正再 --refresh");

const [owner, frozen, saleOpen] = await Promise.all(["owner", "importFrozen", "saleOpen"].map((fn) => client.readContract({ address: a.IDO, abi: VAULT, functionName: fn })));

if (!apply && !open) {
  const pending = pendingImport(records, await chainState(records), analysis.depth);
  console.log(JSON.stringify({ importFrozen: frozen, saleOpen, toImport: { users: pending.users.length, referrers: pending.referrers.length, volumes: pending.volumes.length }, conflicts: pending.conflicts }, null, 2));
  console.log("预览完成，未发送交易。人工核对上面的总数、合计和 NFT 后：npm run import:mainnet -- --apply");
  process.exit(0);
}
const account = deployerAccount(env);
if (getAddress(owner) !== account.address) throw new Error("金库 Owner 不是部署账户。移交之后不能再导入");

if (apply) {
  if (frozen) throw new Error("链上已冻结导入，不能再写");
  if (existsSync(LOCK)) {
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    if (lock.sha256 !== sha || getAddress(lock.ido) !== a.IDO) throw new Error("导入文件或金库地址和第一次 --apply 时不同，拒绝续跑");
  } else {
    writeFileSync(LOCK, `${JSON.stringify({ sha256: sha, ido: a.IDO, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  const pending = pendingImport(records, await chainState(records), analysis.depth);
  if (pending.conflicts.length) throw new Error(`链上已有数据和文件冲突：\n${pending.conflicts.join("\n")}`);
  console.log(JSON.stringify({ users: pending.users.length, referrers: pending.referrers.length, volumes: pending.volumes.length }));
  const send = (functionName, args, label) => sendAsDeployer({ env, client, account, to: a.IDO, abi: VAULT, functionName, args, label });
  for (const [i, batch] of chunk(pending.users, BATCH).entries()) {
    await send("importUsers", [batch.map((u) => u.wallet), batch.map((u) => u.code)], `importUsers #${i + 1}（${batch.length}）`);
  }
  for (const [i, batch] of chunk(pending.referrers, BATCH).entries()) {
    await send("importReferrers", [batch.map((u) => u.wallet), batch.map((u) => u.referrer)], `importReferrers #${i + 1}（${batch.length}）`);
  }
  for (const [i, batch] of chunk(pending.volumes, BATCH).entries()) {
    await send("importVolumes", [batch.map((u) => u.wallet), batch.map((u) => u.selfWei)], `importVolumes #${i + 1}（${batch.length}）`);
  }
  const { problems, totalImported } = await verifyAll(records, analysis);
  const evidence = writeEvidence("import", { sha256: sha, records: analysis.count, totalImported, problems });
  if (problems.length) throw new Error(`逐地址核对没通过（${problems.length} 项），看 ${evidence}`);
  console.log(`逐地址核对通过：${analysis.count} 个地址，totalImported=${formatUnits(totalImported, 18)} USDT。证据 ${evidence}`);
  console.log("下一步：CHUNK_BLOCKS=2000 npm run index:mainnet");
}

if (open) {
  const { problems } = await verifyAll(records, analysis);
  if (problems.length) throw new Error(`导入还没核对通过，不能冻结：\n${problems.slice(0, 20).join("\n")}`);
  const send = (functionName) => sendAsDeployer({ env, client, account, to: a.IDO, abi: VAULT, functionName });
  if (!frozen) {
    await confirmTyped("FREEZE", "freezeImport 不可逆，之后不能再导入任何历史用户。");
    await send("freezeImport");
  }
  if (!saleOpen) {
    await confirmTyped("OPEN", `openSale 会从现在（北京时间 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}）所在的周开始计周息。`);
    await send("openSale");
  }
  const interest = await client.readContract({ address: a.IDO, abi: VAULT, functionName: "nftInterest" });
  const result = {
    importFrozen: await client.readContract({ address: a.IDO, abi: VAULT, functionName: "importFrozen" }),
    saleOpen: await client.readContract({ address: a.IDO, abi: VAULT, functionName: "saleOpen" }),
    interestSaleOpened: await client.readContract({ address: interest, abi: INTEREST, functionName: "saleOpened" }),
  };
  console.log(JSON.stringify(result));
  if (!result.importFrozen || !result.saleOpen || !result.interestSaleOpened) throw new Error("冻结或开售状态不对");
  console.log("已冻结并开售。下一步：npm run settle:mainnet");
}
