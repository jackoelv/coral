#!/usr/bin/env node
/**
 * 给测试钱包文件里的每个地址铸造 MockUSDT。只读 address，不读私钥。
 * 默认每个地址 100000 USDT。铸造交易由 .env 的 TEST_PRIVATE_KEY 付 gas。
 * 默认只打印。--apply 才发送。
 *
 *   npm run mint:test-usdt
 *   npm run mint:test-usdt -- --apply
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { getAddress, createPublicClient, http, parseAbi, parseEther, formatEther } from "viem";
import { parseEnv } from "node:util";
import { usdtMintTargets } from "./lib/testnet-ops.mjs";

const ENV_FILE = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);
const DEFAULT_WALLETS = "/Users/jack/Documents/Sensitive/nemo-bsc-testnet-wallets.json";
const EACH_USDT = "100000";

function readEnv(file) {
  return parseEnv(readFileSync(file, "utf8"));
}

function mintOne({ cast, usdt, to, rpc, privateKey }) {
  const result = spawnSync(
    cast,
    ["send", usdt, "mint(address,uint256)", to, `${EACH_USDT}ether`, "--rpc-url", rpc, "--private-key", privateKey, "--json"],
    { encoding: "utf8" },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output.includes(privateKey)) {
    throw new Error(`${to} 铸造失败，输出里含有私钥，已中止`);
  }
  if (result.status !== 0) throw new Error(`${to} 铸造失败\n${output.trim()}`);
  const receipt = JSON.parse(result.stdout);
  if (BigInt(receipt.status) !== 1n || !receipt.transactionHash) throw new Error(`${to}没有成功回执`);
  return receipt.transactionHash;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const fileEnv = readEnv(ENV_FILE);
  const rpc = fileEnv.BSC_TESTNET_RPC;
  const usdtRaw = fileEnv.BSC_TESTNET_USDT;
  const privateKey = fileEnv.TEST_PRIVATE_KEY;
  const walletsFile = process.env.WALLETS_FILE || DEFAULT_WALLETS;
  if (!rpc || !usdtRaw || !privateKey) {
    throw new Error("缺少 BSC_TESTNET_RPC、BSC_TESTNET_USDT 或 TEST_PRIVATE_KEY");
  }
  for (const key of ['BSC_TESTNET_RPC','BSC_TESTNET_USDT','TEST_PRIVATE_KEY']) {
    if (process.env[key] && process.env[key] !== fileEnv[key]) console.log(`${key}: 忽略终端残留值，使用.env`);
  }
  const usdt = getAddress(usdtRaw);
  const ido = getAddress(fileEnv.BSC_TESTNET_IDO);
  const client = createPublicClient({transport:http(rpc)});
  if (await client.getChainId() !== 97) throw new Error('RPC不是测试网97');
  const vaultUsdt = await client.readContract({address:ido,abi:parseAbi(['function usdt() view returns(address)']),functionName:'usdt'});
  if (getAddress(vaultUsdt)!==usdt) throw new Error('MockUSDT与当前金库usdt()不一致，拒绝铸币');
  const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
  const balance = address => client.readContract({address:usdt,abi:tokenAbi,functionName:'balanceOf',args:[address]});

  const targets = usdtMintTargets(JSON.parse(readFileSync(walletsFile, "utf8")));
  console.log(JSON.stringify({ wallets: targets.length, each: EACH_USDT, apply, usdt }, null, 0));
  for (const row of targets) console.log(`${row.index} ${row.address}`);
  if (!apply) {
    console.log("dry-run。确认后加 --apply 才会铸造。");
    return;
  }

  const cast = `${homedir()}/.foundry/bin/cast`;
  for (const row of targets) {
    const before = await balance(row.address);
    const hash = mintOne({ cast, usdt, to: row.address, rpc, privateKey });
    const receipt = await client.getTransactionReceipt({hash});
    if (receipt.status !== 'success' || getAddress(receipt.to)!==usdt) throw new Error(`${row.address}铸币回执核对失败：${hash}`);
    const after = await balance(row.address);
    if (after - before !== parseEther(EACH_USDT)) throw new Error(`${row.address}余额增量不符：${hash}，请检查并停止重跑`);
    console.log(`${row.index} ${row.address} ${hash} balance=${formatEther(after)} USDT`);
  }
  console.log(`完成：${targets.length} 个地址各 ${EACH_USDT} USDT。`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
