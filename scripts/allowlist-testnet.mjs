#!/usr/bin/env node
/**
 * 多签把地址加入或移出 CKEY 转账白名单，并核对白名单转账。
 * 默认只打印。--apply 才发送。多签 gas 由 TEST_PRIVATE_KEY 支付。
 * 转账由持币地址自己签名，不打印私钥。
 *
 *   node scripts/allowlist-testnet.mjs add --account 5 --signers 17,19,20
 *   node scripts/allowlist-testnet.mjs remove --account 0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661 --signers 17,19,20 --apply
 *   node scripts/allowlist-testnet.mjs test --from 5 --to 4 --signers 0x2d1fc830d6ea39fbd8ca0684b601c350d465aEB1,0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE,0x5fb9fa20B90B4542a91487cd93817e7Fe78c87Bc --apply
 *
 * --signers 选定恰好 3 个当前签名人，写钱包 index 或 0x 地址。省略时用 17、18、19。
 * test 会：加入 --from、from 转 1 wei 给 --to、to 转回、两个未入名单的地址互转被拒绝、移出 --from、再转仍被拒绝。
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { bscTestnet } from "viem/chains";
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

const TOKEN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function transfersEnabled() view returns (bool)",
  "function transferAllowlist(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function setTransferAllowlist(address account, bool allowed)",
  "error TransfersLocked()",
]);

const command = process.argv[2];
const apply = process.argv.includes("--apply");
const AMOUNT = 1n;

function accountFor(rows, token, label) {
  const address = resolveAddress(rows, token, label);
  const row = rows.find((item) => item?.address && getAddress(item.address) === address);
  if (!row) throw new Error(`${label} ${address} 不在钱包文件里，不能代它转账`);
  const account = accountByIndex(rows, row.index);
  return { index: row.index, account };
}

function revertName(error) {
  if (!(error instanceof BaseError)) return "";
  const reverted = error.walk((item) => item instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName || "" : "";
}

async function allowlistOf(publicClient, token, address) {
  return publicClient.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "transferAllowlist",
    args: [address],
  });
}

async function sendTransfer(publicClient, env, account, token, to, amount) {
  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [to, amount] });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport: http(env.BSC_TESTNET_RPC) });
  const gas = await publicClient.estimateGas({ account, to: token, data });
  const hash = await walletClient.sendTransaction({ to: token, data, gas: (gas * 3n) / 2n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`转账回滚：${hash}`);
  return hash;
}

async function expectLocked(publicClient, token, from, to, amount) {
  try {
    await publicClient.simulateContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [to, amount],
      account: from,
    });
  } catch (error) {
    if (revertName(error) === "TransfersLocked") return;
    throw error;
  }
  throw new Error(`${from} 转给 ${to} 应当被拒绝，模拟却成功`);
}

async function setAllowlist({ publicClient, walletClient, multisig, signers, token, account, allowed, apply, rows }) {
  const data = encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: "setTransferAllowlist",
    args: [account, allowed],
  });
  await execMultisig({ publicClient, walletClient, multisig, signers, target: token, data, apply, rows });
  if (!apply) return;
  const now = await allowlistOf(publicClient, token, account);
  if (now !== allowed) throw new Error(`${account} 的白名单仍是 ${now}，期望 ${allowed}`);
}

async function main() {
  if (!["add", "remove", "test"].includes(command)) throw new Error("命令是 add、remove 或 test");
  const env = readTestnetEnv();
  const rows = loadWalletRows();
  const { publicClient, walletClient } = testnetClients(env);
  await assertChain(publicClient);
  const token = getAddress(env.BSC_TESTNET_CKEY || "");
  const multisig = getAddress(env.TESTNET_MULTISIG || "");
  const owner = getAddress(await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }));
  const enabled = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "transfersEnabled" });
  if (owner !== multisig) throw new Error(`CKEY Owner 是 ${owner}，还不是多签 ${multisig}`);
  if (enabled) throw new Error("transfersEnabled 已打开，白名单不再生效，拒绝改名单");

  const indexes = parseSignerSelection(process.argv, rows);
  const chosen = indexes.map((index) => addressByIndex(rows, index));
  const live = await signerList(publicClient, multisig);
  for (const address of chosen) {
    if (!live.includes(address)) throw new Error(`${address} 不是当前四个签名人之一：${live.join(",")}`);
  }
  const signers = indexes.map((index) => (apply ? accountByIndex(rows, index) : { address: addressByIndex(rows, index) }));
  console.log(JSON.stringify({ command, token, multisig, signers: chosen, apply }));

  if (command === "add" || command === "remove") {
    const account = resolveAddress(rows, flagValue(process.argv, "account"), "--account");
    const allowed = command === "add";
    const current = await allowlistOf(publicClient, token, account);
    console.log(JSON.stringify({ account, current, next: allowed }));
    if (current === allowed) {
      console.log(allowed ? "已经在白名单里" : "已经不在白名单里");
      return;
    }
    await setAllowlist({ publicClient, walletClient, multisig, signers, token, account, allowed, apply, rows });
    if (!apply) console.log(`dry-run。确认后加上 --apply`);
    return;
  }

  const from = accountFor(rows, flagValue(process.argv, "from"), "--from");
  const to = accountFor(rows, flagValue(process.argv, "to"), "--to");
  if (from.account.address === to.account.address) throw new Error("--from 和 --to 不能是同一个地址");
  const thirdIndex = [3, 4, 5, 6, 16].find((index) => {
    const address = addressByIndex(rows, index);
    return address !== from.account.address && address !== to.account.address;
  });
  if (thirdIndex === undefined) throw new Error("找不到第三个未参与互转的地址");
  const third = addressByIndex(rows, thirdIndex);
  for (const address of [from.account.address, to.account.address, third]) {
    if (await allowlistOf(publicClient, token, address)) throw new Error(`${address} 已经在白名单里。先 remove，再跑 test`);
  }
  const balance = await publicClient.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [from.account.address],
  });
  const peerBalance = await publicClient.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [to.account.address],
  });
  if (balance < AMOUNT || peerBalance < AMOUNT) throw new Error("from 和 to 都要至少持有 1 wei CKEY");
  console.log(JSON.stringify({
    from: from.account.address,
    to: to.account.address,
    third,
    amount: AMOUNT.toString(),
  }));
  if (!apply) {
    console.log("dry-run。确认后：npm run allowlist:testnet -- test --from <index或地址> --to <index或地址> --signers <三个签名人> --apply");
    return;
  }

  let listed = false;
  try {
    await setAllowlist({
      publicClient, walletClient, multisig, signers, token, account: from.account.address, allowed: true, apply, rows,
    });
    listed = true;
    const sent = await sendTransfer(publicClient, env, from.account, token, to.account.address, AMOUNT);
    console.log(`白名单地址转出 ${sent}`);
    const returned = await sendTransfer(publicClient, env, to.account, token, from.account.address, AMOUNT);
    console.log(`未入名单地址转回白名单地址 ${returned}`);
    await expectLocked(publicClient, token, to.account.address, third, AMOUNT);
    console.log("两个都不在白名单里的地址不能互转");
    await setAllowlist({
      publicClient, walletClient, multisig, signers, token, account: from.account.address, allowed: false, apply, rows,
    });
    listed = false;
    await expectLocked(publicClient, token, from.account.address, to.account.address, AMOUNT);
    console.log("移出白名单后，原地址再转仍被拒绝");
  } catch (error) {
    if (listed) {
      console.error("测试中断，正在把地址移出白名单");
      await setAllowlist({
        publicClient, walletClient, multisig, signers, token, account: from.account.address, allowed: false, apply: true, rows,
      });
    }
    throw error;
  }

  const endFrom = await publicClient.readContract({
    address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [from.account.address],
  });
  const endTo = await publicClient.readContract({
    address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [to.account.address],
  });
  if (endFrom !== balance || endTo !== peerBalance) throw new Error("往返后余额没有回到原值");
  if (await allowlistOf(publicClient, token, from.account.address)) throw new Error("测试结束后地址仍在白名单里");
  console.log("多签改白名单和白名单转账都已核对，名单和余额已回到测试前。");
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || error, loadWalletRows()));
  process.exit(1);
});
