#!/usr/bin/env node
/**
 * 从 FreeDao 生产库只读导出已注册钱包，导入已部署的 BNB 测试网金库。
 * 默认只预览。--apply 上链。--open 在导入完成之后冻结并开售。
 *
 *   node scripts/import-prod-to-testnet.mjs
 *   node scripts/import-prod-to-testnet.mjs --apply
 *   node scripts/import-prod-to-testnet.mjs --open
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const prodEnv = process.env.PROD_ENV_FILE || "/Users/jack/git/github/FreeDao/.env.production.local";
const nemoEnv = process.env.NEMO_ENV_FILE || "/Users/jack/git/github/coral/.env";

function envValue(file, key) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((row) => row.startsWith(`${key}=`));
  const line = lines[lines.length - 1];
  if (!line) throw new Error(`${key} missing`);
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

const apply = process.argv.includes("--apply");
const open = process.argv.includes("--open");
const prodUrl = envValue(prodEnv, "DATABASE_URL");
const rpc = envValue(nemoEnv, "BSC_TESTNET_RPC");
const ido = getAddress(envValue(nemoEnv, "BSC_TESTNET_IDO"));
const pk = envValue(nemoEnv, "TEST_PRIVATE_KEY");

const exported = spawnSync("node", ["scripts/export-freedao.mjs", "--network", "bscMainnet", "--out", "import-data.json"], {
  env: { ...process.env, DATABASE_URL: prodUrl },
  encoding: "utf8",
});
if (exported.status !== 0) {
  console.error(exported.stderr || exported.stdout);
  process.exit(exported.status || 1);
}
console.log(exported.stdout);

const data = JSON.parse(readFileSync("import-data.json", "utf8"));
if (!data.ok) {
  console.error("导出未通过，未发送交易。");
  console.error(JSON.stringify(data.errors, null, 2));
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const chain = {
  id: 97,
  name: "bsc-testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
};
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const abi = parseAbi([
  "function importFrozen() view returns (bool)",
  "function freezeImport()",
  "function openSale()",
  "function saleOpen() view returns (bool)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
]);
const frozen = await publicClient.readContract({ address: ido, abi, functionName: "importFrozen" });
console.log(JSON.stringify({ records: data.records.length, importFrozen: frozen, apply, open }));

if (frozen && apply) {
  console.error("链上已经冻结导入，不能再写入这 30 个地址。");
  process.exit(1);
}

if (apply) {
  const childEnv = { ...process.env, DATABASE_URL: prodUrl, RPC_URL: rpc, IDO_ADDRESS: ido, TEST_PRIVATE_KEY: pk, CHAIN_ID: "97" };
  delete childEnv.PRIVATE_KEY;
  const imported = spawnSync("node", ["scripts/import-onchain.mjs", "--apply", "--in", "import-data.json"], {
    env: childEnv,
    encoding: "utf8",
  });
  console.log(imported.stdout);
  if (imported.stderr) console.error(imported.stderr);
  if (imported.status !== 0) process.exit(imported.status || 1);
}

if (open) {
  if (!apply) {
    const first = await publicClient.readContract({
      address: ido,
      abi,
      functionName: "getAccount",
      args: [getAddress(data.records[0].wallet)],
    });
    const registered = Array.isArray(first) ? Boolean(first[5]) : Boolean(first.registered);
    if (!registered) {
      console.error("链上还没有这批用户。先 --apply，确认成功后再 --open。");
      process.exit(1);
    }
  }
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  if (!frozen) {
    const freezeHash = await wallet.writeContract({ address: ido, abi, functionName: "freezeImport" });
    await publicClient.waitForTransactionReceipt({ hash: freezeHash });
    console.log(`freezeImport ${freezeHash}`);
  }
  const openHash = await wallet.writeContract({ address: ido, abi, functionName: "openSale" });
  await publicClient.waitForTransactionReceipt({ hash: openHash });
  console.log(`openSale ${openHash}`);
}

if (!apply && !open) console.log("dry-run。确认 import-data.json 后加 --apply。导入成功后再 --open。");
