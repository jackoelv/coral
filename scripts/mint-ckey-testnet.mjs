#!/usr/bin/env node
/**
 * 多签 Owner 直接铸造 CKEY。默认只读链上状态并模拟，--apply 才发送。
 * Gas 由 .env 的 TEST_PRIVATE_KEY 支付。签名用钱包文件，不打印私钥。
 *
 * 默认铸 5 亿枚给 0x84e8997f301FB0192df6D381eC5b176b84619905。
 *
 *   node scripts/mint-ckey-testnet.mjs
 *   node scripts/mint-ckey-testnet.mjs --signers 17,19,20
 *   node scripts/mint-ckey-testnet.mjs --to 0x84e8997f301FB0192df6D381eC5b176b84619905 --amount 500000000 --apply
 *
 * --amount 是整枚数量，18 位小数由脚本补上。--signers 选定恰好 3 个签名人，写钱包 index 或 0x 地址。
 * 省略时用 17、18、19。这笔铸造不计入金库 totalNemoAllocated，但占用 CKEY 的 10 亿枚 CAP。
 */
import { encodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits } from "viem";
import { readTestnetEnv } from "./lib/testnet-env.mjs";
import {
  accountByIndex,
  addressByIndex,
  assertChain,
  execMultisig,
  flagValue,
  loadWalletRows,
  parseSignerSelection,
  redact,
  resolveAddress,
  signerList,
  testnetClients,
} from "./lib/multisig-exec.mjs";

const DEFAULT_TO = "0x84e8997f301FB0192df6D381eC5b176b84619905";
const DEFAULT_AMOUNT = "500000000";

const TOKEN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function CAP() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "error NotAuthorized()",
  "error CapExceeded()",
  "error ZeroAddress()",
]);

const VAULT_ABI = parseAbi([
  "function totalNemoAllocated() view returns (uint256)",
]);

const apply = process.argv.includes("--apply");

function wholeTokens(raw) {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("--amount 要写成正整数枚数，例如 500000000");
  return parseUnits(raw, 18);
}

async function main() {
  const env = readTestnetEnv();
  const rows = loadWalletRows();
  const { publicClient, walletClient } = testnetClients(env);
  await assertChain(publicClient);

  const token = getAddress(env.BSC_TESTNET_CKEY || "");
  const vault = getAddress(env.BSC_TESTNET_IDO || "");
  const multisig = getAddress(env.TESTNET_MULTISIG || "");
  const to = resolveAddress(rows, flagValue(process.argv, "to") || DEFAULT_TO, "--to");
  const amountText = flagValue(process.argv, "amount") || DEFAULT_AMOUNT;
  const amount = wholeTokens(amountText);

  const indexes = parseSignerSelection(process.argv, rows);
  const chosen = indexes.map((index) => addressByIndex(rows, index));
  const live = await signerList(publicClient, multisig);
  for (const address of chosen) {
    if (!live.includes(address)) throw new Error(`${address} 不是当前四个签名人之一：${live.join(",")}`);
  }
  const signers = indexes.map((index) => (apply ? accountByIndex(rows, index) : { address: addressByIndex(rows, index) }));

  const [owner, cap, supply, balance, allocated] = await Promise.all([
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }),
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "CAP" }),
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [to] }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalNemoAllocated" }),
  ]);
  if (getAddress(owner) !== multisig) throw new Error(`CKEY Owner 是 ${owner}，还不是多签 ${multisig}`);
  if (supply + amount > cap) {
    throw new Error(`剩余额度 ${formatUnits(cap - supply, 18)} 枚，不够铸 ${formatUnits(amount, 18)} 枚`);
  }

  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [to, amount] });
  await publicClient.simulateContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "mint",
    args: [to, amount],
    account: multisig,
  });

  console.log(JSON.stringify({
    token,
    vault,
    multisig,
    to,
    amount: formatUnits(amount, 18),
    balanceBefore: formatUnits(balance, 18),
    balanceAfter: formatUnits(balance + amount, 18),
    supplyBefore: formatUnits(supply, 18),
    supplyAfter: formatUnits(supply + amount, 18),
    cap: formatUnits(cap, 18),
    totalNemoAllocated: formatUnits(allocated, 18),
    signers: chosen,
    apply,
  }));

  if (!apply) {
    console.log("模拟通过。确认后：node scripts/mint-ckey-testnet.mjs --apply");
    return;
  }

  const receipt = await execMultisig({
    publicClient, walletClient, multisig, signers, target: token, data, apply, rows,
  });
  const [supplyAfter, balanceAfter, allocatedAfter] = await Promise.all([
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
    publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [to] }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalNemoAllocated" }),
  ]);
  if (balanceAfter !== balance + amount) {
    throw new Error(`${to} 余额是 ${formatUnits(balanceAfter, 18)}，期望 ${formatUnits(balance + amount, 18)}`);
  }
  if (supplyAfter !== supply + amount) {
    throw new Error(`总量是 ${formatUnits(supplyAfter, 18)}，期望 ${formatUnits(supply + amount, 18)}`);
  }
  if (allocatedAfter !== allocated) {
    throw new Error(`totalNemoAllocated 从 ${allocated} 变成 ${allocatedAfter}，Owner 直接铸造不应改这个数`);
  }
  console.log(JSON.stringify({
    tx: receipt.transactionHash,
    balanceAfter: formatUnits(balanceAfter, 18),
    supplyAfter: formatUnits(supplyAfter, 18),
    totalNemoAllocated: formatUnits(allocatedAfter, 18),
  }));
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || error, loadWalletRows()));
  process.exit(1);
});
