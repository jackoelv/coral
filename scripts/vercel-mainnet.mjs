#!/usr/bin/env node
/**
 * Uploads the verified mainnet contract addresses to the FreeDao Vercel project.
 *   --target mainnetpreview   preview.freedao.life (branch life_mainnet_preview)
 *   --target production       www.freedao.life (branch life); also removes testnet/local public vars
 * Public values only: no private keys, database URLs, SESSION_SECRET or CRON_SECRET.
 * NEXT_PUBLIC_* are baked in at build time: redeploy the target branch afterwards.
 *
 *   npm run vercel:mainnet-preview
 *   npm run vercel:mainnet-preview -- --apply
 *   npm run vercel:mainnet-production
 *   npm run vercel:mainnet-production -- --apply
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { getAddress, parseAbi } from "viem";
import { ROOT, USDT, contracts, mainnetClient, need, readMainnetEnv } from "./lib/mainnet.mjs";

const PROJECT_DIR = "/Users/jack/git/github/FreeDao";
const args = process.argv.slice(2);
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : null;
if (!["mainnetpreview", "production"].includes(target)) throw new Error("--target 只能是 mainnetpreview 或 production");
const apply = args.includes("--apply");

const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const publicRpc = need(env, "BSC_MAINNET_PUBLIC_RPC");
if (!publicRpc.startsWith("https://")) throw new Error("BSC_MAINNET_PUBLIC_RPC 必须是 https");
const startBlock = need(env, "INDEX_START_BLOCK");

const testnetFile = resolve(ROOT, ".env");
if (!existsSync(testnetFile)) console.warn("没有测试网 .env，跳过“不是测试网地址”这项检查；链 56 字节码检查照常。");
const testnet = existsSync(testnetFile) ? parseEnv(readFileSync(testnetFile, "utf8")) : {};
const testAddresses = new Set(Object.entries(testnet).filter(([k, v]) => /^BSC_TESTNET_/.test(k) && /^0x[0-9a-fA-F]{40}$/.test(v)).map(([, v]) => v.toLowerCase()));
for (const [key, address] of Object.entries(a)) {
  if (testAddresses.has(address.toLowerCase())) throw new Error(`${key} 是测试网地址`);
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${key} ${address} 在链 56 上没有字节码`);
}
if (getAddress(await client.readContract({ address: a.IDO, abi: parseAbi(["function usdt() view returns (address)"]), functionName: "usdt" })) !== USDT) throw new Error("金库 usdt() 不是官方 USDT");
const rpcChain = await fetch(publicRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.json());
if (rpcChain.result !== "0x38") throw new Error("BSC_MAINNET_PUBLIC_RPC 不是链 56");

const set = {
  NEXT_PUBLIC_CHAIN_NETWORK: "mainnet",
  NEXT_PUBLIC_MAINNET_VAULT_ENABLED: "true",
  NEXT_PUBLIC_BSC_MAINNET_USDT: USDT,
  NEXT_PUBLIC_BSC_MAINNET_IDO: a.IDO,
  NEXT_PUBLIC_BSC_MAINNET_REWARDS: a.REWARDS,
  NEXT_PUBLIC_BSC_MAINNET_INTEREST: a.INTEREST,
  NEXT_PUBLIC_BSC_MAINNET_NFT: a.NFT,
  NEXT_PUBLIC_BSC_MAINNET_RPC: publicRpc,
  NEMO_MAINNET_RPC_URL: publicRpc,
  INDEX_START_BLOCK: startBlock,
};
if (env.TEAM_TIER_SWITCH_BLOCK) set.TEAM_TIER_SWITCH_BLOCK = env.TEAM_TIER_SWITCH_BLOCK;

function vercel(argv, input) {
  const result = spawnSync("vercel", [...argv, "--cwd", PROJECT_DIR], { input, encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) throw new Error(`vercel ${argv.slice(0, 3).join(" ")} 失败\n${output}`);
  return output;
}

function listed() {
  const out = [];
  for (const line of vercel(["env", "ls", target]).split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(name) && !["NAME", "COMMON"].includes(name)) {
      const others = ["Production", "Preview", "Development", "mainnetpreview"].filter((l) => l.toLowerCase() !== target && line.includes(l));
      out.push({ name, shared: others.length > 0 });
    }
  }
  return out;
}

const existing = listed();
const removable = target === "production"
  ? existing.filter((v) => v.name === "NEXT_PUBLIC_NEMO_NETWORK" || v.name === "NEXT_PUBLIC_LOCAL_CHAIN_ID" || v.name.startsWith("NEXT_PUBLIC_BSC_TESTNET_") || v.name.startsWith("NEXT_PUBLIC_LOCAL_"))
  : [];
for (const [k, v] of Object.entries(set)) console.log(`${k}=${v} -> ${target}`);
for (const v of removable) console.log(`${v.shared ? "需手动解除（和其他环境共用）" : "删除"} ${v.name} <- ${target}`);
if (!apply) {
  console.log(`预览完成，没有调用 vercel env 写入。确认后加 --apply。`);
  process.exit(0);
}
for (const [k, v] of Object.entries(set)) {
  vercel(["env", "add", k, target, "--force"], v);
  console.log(`${k} -> ${target}`);
}
for (const v of removable) {
  if (v.shared) continue;
  vercel(["env", "rm", v.name, target, "--yes"]);
  console.log(`removed ${v.name} <- ${target}`);
}
const shared = removable.filter((v) => v.shared);
if (shared.length) console.log(`这些变量和其他环境共用，脚本没有删除，请在 Vercel 界面里取消勾选 ${target}：${shared.map((v) => v.name).join(", ")}`);
const branch = target === "production" ? "life" : "life_mainnet_preview";
console.log(`已写入 ${target}。重新部署 ${branch} 分支后前端才会用这些地址；不要 Promote 旧构建。`);
