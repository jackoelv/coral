import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, zeroAddress } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { updateEnvText } from "./testnet-env.mjs";
import { databaseTarget } from "./testnet-ops.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MAINNET_EXAMPLE = resolve(ROOT, ".env.mainnet.example");
/** Rehearsal on a local fork only: NEMO_MAINNET_REHEARSAL=1 switches to .env.mainnet.rehearsal and mainnet-run-rehearsal/. */
export const REHEARSAL = process.env.NEMO_MAINNET_REHEARSAL === "1";
export const MAINNET_ENV = resolve(ROOT, REHEARSAL ? ".env.mainnet.rehearsal" : ".env.mainnet");
export const RUN_DIR = resolve(ROOT, REHEARSAL ? "mainnet-run-rehearsal" : "mainnet-run");
if (REHEARSAL) console.warn(`[演练] 读 ${MAINNET_ENV}，RPC 必须是 127.0.0.1 的主网分叉`);
export const CHAIN_ID = 56;
export const USDT = "0x55d398326f99059fF775485246999027B3197955";
export const PRODUCTION_DB_HOST = "ep-autumn-cake";
export const PRODUCTION_DB_NAME = "neondb";
export const PREVIEW_DB_NAME = "preview";
export const TEST_DB_HOST = "ep-empty-king";
export const FIXED_ENV = { NETWORK: "bscMainnet", CHAIN_ID: "56", BSC_MAINNET_USDT: USDT, CONFIRMATIONS: "15" };
export const CONTRACT_KEYS = ["CKEY", "NFT", "IDO", "REWARDS", "INTEREST"];
export const CONTRACT_NAMES = {
  CKEY: "CoralToken",
  NFT: "CoralNFT",
  IDO: "CoralIdo",
  REWARDS: "CoralRewards",
  INTEREST: "CoralNftInterest",
};
export const RECEIPT_CONFIRMATIONS = 3;

/** Reads only `.env.mainnet`. Values left in the shell are never used. */
export function readMainnetEnv({ allowMissingFixed = false } = {}) {
  if (!existsSync(MAINNET_ENV)) throw new Error("没有 .env.mainnet。先跑 npm run env:mainnet -- --apply");
  const env = parseEnv(readFileSync(MAINNET_ENV, "utf8"));
  if (!allowMissingFixed) assertFixedEnv(env);
  return env;
}

export function assertFixedEnv(env) {
  for (const [key, value] of Object.entries(FIXED_ENV)) {
    if ((env[key] || "").trim() !== value) throw new Error(`.env.mainnet 的 ${key} 必须是 ${value}`);
  }
}

export function saveMainnetEnv(updates) {
  const text = readFileSync(MAINNET_ENV, "utf8");
  const backup = `${MAINNET_ENV}.backup-${Date.now()}`;
  copyFileSync(MAINNET_ENV, backup);
  chmodSync(backup, 0o600);
  const temp = `${MAINNET_ENV}.tmp-${process.pid}`;
  writeFileSync(temp, updateEnvText(text, updates), { mode: 0o600, flag: "wx" });
  renameSync(temp, MAINNET_ENV);
  chmodSync(MAINNET_ENV, 0o600);
  console.log(`.env.mainnet 已更新，原文件备份为 ${backup}（含私钥，权限 600）。`);
}

export function need(env, key) {
  const value = (env[key] || "").trim();
  if (!value) throw new Error(`.env.mainnet 缺少 ${key}`);
  return value;
}

export function addressOf(env, key) {
  const address = getAddress(need(env, key));
  if (address === zeroAddress) throw new Error(`${key} 不能是零地址`);
  return address;
}

export function contracts(env) {
  return Object.fromEntries(CONTRACT_KEYS.map((key) => [key, addressOf(env, `BSC_MAINNET_${key}`)]));
}

export function positiveWei(env, key, { allowZero = false } = {}) {
  const raw = need(env, key);
  if (!/^\d+$/.test(raw)) throw new Error(`${key} 必须是整数 wei`);
  const value = BigInt(raw);
  if (!allowZero && value === 0n) throw new Error(`${key} 必须大于 0`);
  return value;
}

/** Throws when any two named addresses are equal. */
export function assertDistinct(named) {
  const seen = new Map();
  for (const [name, raw] of Object.entries(named)) {
    const address = getAddress(raw).toLowerCase();
    if (seen.has(address)) throw new Error(`${seen.get(address)} 和 ${name} 是同一个地址，三个账户必须两两不同`);
    seen.set(address, name);
  }
}

export function deployerAccount(env) {
  const key = need(env, "MAINNET_PRIVATE_KEY");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  if (env.MAINNET_DEPLOYER && getAddress(env.MAINNET_DEPLOYER) !== account.address) {
    throw new Error("MAINNET_DEPLOYER 和 MAINNET_PRIVATE_KEY 不对应");
  }
  return account;
}

/** Deployer, Owner, Publisher. Publisher may be absent until section 9. */
export function roles(env, { requirePublisher = false } = {}) {
  const deployer = env.MAINNET_PRIVATE_KEY ? deployerAccount(env).address : addressOf(env, "MAINNET_DEPLOYER");
  const owner = addressOf(env, "MAINNET_OWNER");
  const publisher = requirePublisher || env.MAINNET_PUBLISHER ? addressOf(env, "MAINNET_PUBLISHER") : null;
  assertDistinct(publisher ? { 部署账户: deployer, Owner: owner, Publisher: publisher } : { 部署账户: deployer, Owner: owner });
  return { deployer, owner, publisher };
}

export async function mainnetClient(env) {
  const rpc = need(env, "BSC_MAINNET_RPC");
  if (REHEARSAL && !/^http:\/\/127\.0\.0\.1:\d+/.test(rpc)) throw new Error("演练模式只允许连本机分叉 RPC");
  const client = createPublicClient({ chain: bsc, transport: http(rpc, { retryCount: 2, timeout: 30_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`BSC_MAINNET_RPC 是 chainId ${chainId}，不是 56，停止`);
  return client;
}

export function redact(text, env) {
  let out = String(text);
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (/PRIVATE_KEY|DATABASE_URL|API_KEY|SECRET|RPC|PROJECT_ID/.test(key)) out = out.split(value).join(`[${key}]`);
  }
  return out;
}

export function runPath(...parts) {
  const path = resolve(RUN_DIR, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function json(value) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function writeEvidence(name, value) {
  const path = runPath("evidence", `${name}-${stamp()}.json`);
  writeFileSync(path, `${json(value)}\n`, { mode: 0o600 });
  return path;
}

/** Interactive confirmation. Refuses when stdin is not a terminal. */
export async function confirmTyped(expected, prompt) {
  if (REHEARSAL && process.env.NEMO_MAINNET_REHEARSAL_YES === "1") {
    console.warn(`[演练] 自动确认 ${expected}：${prompt}`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error(`需要在终端里输入 ${expected} 确认，当前不是交互终端`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt}\n输入 ${expected} 继续，其他任意内容取消：`)).trim();
    if (answer !== expected) throw new Error("已取消，未发送任何交易");
  } finally {
    rl.close();
  }
}

/**
 * Sends one transaction from the local deployer key.
 * Calldata is encoded here, gas comes from an HTTP RPC estimate times 1.5,
 * and only a successful receipt counts.
 */
export async function sendAsDeployer({ env, client, account, to, abi, functionName, args = [], label }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const estimate = await client.estimateGas({ account: account.address, to, data });
  const wallet = createWalletClient({ account, chain: bsc, transport: http(need(env, "BSC_MAINNET_RPC")) });
  const hash = await wallet.sendTransaction({ to, data, gas: (estimate * 3n) / 2n, value: 0n });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: RECEIPT_CONFIRMATIONS });
  if (receipt.status !== "success") throw new Error(`${label || functionName} 回滚：${hash}`);
  console.log(`${label || functionName} ${hash} gasUsed=${receipt.gasUsed}`);
  return { hash, receipt };
}

export function read(client, address, abi, functionName, args = []) {
  return client.readContract({ address, abi, functionName, args });
}

/** Production database only: the old neondb on the formal Neon host, never the test database or the preview database. */
export function productionDatabase(url) {
  const target = databaseTarget(url);
  if (target.host.includes(TEST_DB_HOST)) throw new Error(`${target.host} 是测试库，主网脚本拒绝连接`);
  if (!target.host.includes(PRODUCTION_DB_HOST) || target.database !== PRODUCTION_DB_NAME) {
    throw new Error(`${target.host}/${target.database} 不是正式库 ${PRODUCTION_DB_HOST}/${PRODUCTION_DB_NAME}，拒绝连接`);
  }
  return target;
}

/** preview.freedao.life uses the preview database on the same Neon host. neondb stays the old production database. */
export function previewDatabase(url) {
  const target = databaseTarget(url);
  if (target.host.includes(TEST_DB_HOST)) throw new Error("PREVIEW_DATABASE_URL 指向了测试网的库，拒绝");
  if (target.database === PRODUCTION_DB_NAME) throw new Error("PREVIEW_DATABASE_URL 指向了正式库 neondb，拒绝");
  if (target.host.includes(PRODUCTION_DB_HOST) && target.database !== PREVIEW_DB_NAME) {
    throw new Error("PREVIEW_DATABASE_URL 指向了正式库，拒绝");
  }
  return target;
}

/** `--db production|preview`. Default production. A bare `preview` is rejected: npm eats `--db` unless the command has `--`. */
export function selectedDatabase(env, argv = process.argv) {
  for (const [i, arg] of argv.entries()) {
    if ((arg === "preview" || arg === "production") && argv[i - 1] !== "--db") {
      throw new Error(`看到单独的「${arg}」，但没有 --db。npm 会把 --db 吃掉。请用：npm run <命令> -- --db ${arg}`);
    }
  }
  const index = argv.indexOf("--db");
  const name = index === -1 ? "production" : argv[index + 1];
  if (name === "production") return { name, url: need(env, "DATABASE_URL"), target: productionDatabase(need(env, "DATABASE_URL")) };
  if (name === "preview") return { name, url: need(env, "PREVIEW_DATABASE_URL"), target: previewDatabase(need(env, "PREVIEW_DATABASE_URL")) };
  throw new Error("--db 只能是 production 或 preview");
}

/** Child-process environment: PATH/HOME plus explicit values. No inherited secrets. */
export function cleanEnv(values) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || "en_US.UTF-8" };
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) env[key] = String(value);
  return env;
}

export function nftsOwed(selfWei) {
  if (selfWei < 1000n * 10n ** 18n) return 0n;
  return selfWei / (500n * 10n ** 18n);
}

export const OWNABLE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "acceptOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
];
