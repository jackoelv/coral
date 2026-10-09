#!/usr/bin/env node
/**
 * 多签从金库转出管理员可提取的 USDT。只动 treasuryWithdrawable，直推准备金和已发布未领网体奖留在合约里。
 * 默认只查询上限。带 --to 和 --amount 时预览转账，加 --apply 才发送。
 * Gas 由 .env 的 TEST_PRIVATE_KEY 支付。三个签名人默认是钱包文件 index 17、18、19。
 *
 *   node scripts/withdraw-treasury-testnet.mjs
 *   node scripts/withdraw-treasury-testnet.mjs --signers 17,19,20
 *   node scripts/withdraw-treasury-testnet.mjs --to 0xabc... --amount 1
 *   node scripts/withdraw-treasury-testnet.mjs --to 21 --amount max --signers 17,18,20 --apply
 */
import { encodeFunctionData, formatUnits, getAddress, parseAbi } from "viem";
import { readTestnetEnv } from "./lib/testnet-env.mjs";
import { parseWithdrawAmount } from "./lib/treasury-withdraw.mjs";
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

const VAULT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function usdt() view returns (address)",
  "function treasuryWithdrawable() view returns (uint256)",
  "function directReserve() view returns (uint256)",
  "function reservedRewards() view returns (uint256)",
  "function withdrawTreasury(address to, uint256 amount)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

const apply = process.argv.includes("--apply");

function usdtText(amount, decimals) {
  return formatUnits(amount, decimals);
}

async function main() {
  const env = readTestnetEnv();
  const rows = loadWalletRows();
  const { publicClient, walletClient } = testnetClients(env);
  await assertChain(publicClient);
  const vault = getAddress(env.BSC_TESTNET_IDO || "");
  const multisig = getAddress(env.TESTNET_MULTISIG || "");
  const indexes = parseSignerSelection(process.argv, rows);
  const signers = apply
    ? indexes.map((index) => accountByIndex(rows, index))
    : indexes.map((index) => ({ address: addressByIndex(rows, index) }));

  const [owner, usdt, maxWei, directReserve, reserved] = await Promise.all([
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "usdt" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "treasuryWithdrawable" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "directReserve" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "reservedRewards" }),
  ]);
  const token = getAddress(usdt);
  const [decimals, symbol, balance] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] }),
  ]);
  const liveSigners = await signerList(publicClient, multisig);
  const teamOutstanding = reserved - directReserve;
  console.log(JSON.stringify({
    vault,
    owner: getAddress(owner),
    multisig,
    ownerIsMultisig: getAddress(owner) === multisig,
    token,
    symbol,
    decimals,
    balance: usdtText(balance, decimals),
    directReserve: usdtText(directReserve, decimals),
    teamOutstanding: usdtText(teamOutstanding, decimals),
    maxWithdraw: usdtText(maxWei, decimals),
    maxWithdrawWei: maxWei.toString(),
    signers: signers.map((account) => account.address),
  }, null, 2));

  const toToken = flagValue(process.argv, "to");
  const amountToken = flagValue(process.argv, "amount");
  if (!toToken && !amountToken) {
    console.log("以上是当前可转出上限。转出示例：node scripts/withdraw-treasury-testnet.mjs --to 0x收款地址 --amount 1");
    return;
  }
  if (!toToken || !amountToken) throw new Error("转出需要同时给出 --to 和 --amount");
  if (getAddress(owner) !== multisig) throw new Error("金库 Owner 还不是多签，不能用这把多签转出");
  const chosen = signers.map((account) => getAddress(account.address));
  const missing = chosen.filter((address) => !liveSigners.includes(address));
  if (missing.length > 0) throw new Error(`这几个地址不在当前 4 个签名人里：${missing.join(",")}`);

  const to = resolveAddress(rows, toToken, "--to");
  const amount = parseWithdrawAmount(amountToken, maxWei, decimals);
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "withdrawTreasury",
    args: [to, amount],
  });
  const before = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [to],
  });
  console.log(JSON.stringify({
    to,
    amount: usdtText(amount, decimals),
    amountWei: amount.toString(),
    recipientBalance: usdtText(before, decimals),
    apply,
  }));
  await publicClient.call({ account: multisig, to: vault, data });
  if (!apply) {
    console.log("模拟通过。确认后在同一条命令末尾加 --apply");
    return;
  }
  const receipt = await execMultisig({
    publicClient,
    walletClient,
    multisig,
    signers,
    target: vault,
    data,
    apply,
    rows,
  });
  const [after, left] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [to] }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "treasuryWithdrawable" }),
  ]);
  if (after - before !== amount) throw new Error(`收款地址增加 ${after - before}，不是本次金额 ${amount}`);
  console.log(JSON.stringify({
    tx: receipt.transactionHash,
    recipientBalance: usdtText(after, decimals),
    maxWithdraw: usdtText(left, decimals),
  }));
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || error, loadWalletRows()));
  process.exit(1);
});
