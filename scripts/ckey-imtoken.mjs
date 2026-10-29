#!/usr/bin/env node
/**
 * Owner 用手机 imToken 做两件互不相干的事：铸造 CKEY，或把一个地址加入转账白名单。
 * 不读数据库。只读 .env.mainnet 的 BSC 主网 RPC，chainId 必须是 56。
 * 默认只核对并打印。--apply 才打开本机签名页，用 imToken 扫码确认。私钥不离开手机。
 * 手机当前账户必须是链上 Owner，网络必须是 BNB Smart Chain。
 * 签到一半断开时，用打印出来的计划路径跑 sign:mainnet 续签，不要再 --apply。
 *
 *   npm run ckey:mint -- --to 0x... --amount 1000
 *   npm run ckey:mint -- --to 0x... --amount 1000 --apply
 *   npm run ckey:allowlist -- --account 0x...
 *   npm run ckey:allowlist -- --account 0x... --apply
 */
import { formatUnits, getAddress } from "viem";
import {
  TOKEN_ABI,
  VAULT_ABI,
  ckeySignPlan,
  parseCkeyArgs,
} from "./lib/ckey-owner.mjs";
import { CHAIN_ID, contracts, mainnetClient, need, readMainnetEnv, redact, runPath, stamp } from "./lib/mainnet.mjs";
import { readPlan, writePlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";

async function ownerOf(client, token) {
  const owner = getAddress(await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }));
  const code = await client.getCode({ address: owner });
  if (code && code !== "0x") throw new Error(`CKEY Owner ${owner} 是合约。imToken 只能签手机里的个人地址`);
  return owner;
}

async function main() {
  const args = parseCkeyArgs(process.argv.slice(2));
  const env = readMainnetEnv();
  const client = await mainnetClient(env);
  const token = contracts(env).CKEY;
  const vault = contracts(env).IDO;
  const owner = await ownerOf(client, token);
  const port = process.argv.includes("--port") ? args.port : 8756;

  if (args.kind === "mint") {
    const [cap, supply, balance, allocated] = await Promise.all([
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "CAP" }),
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [args.to] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalNemoAllocated" }),
    ]);
    if (supply + args.amount > cap) {
      throw new Error(`剩余额度 ${formatUnits(cap - supply, 18)} 枚，不够铸 ${formatUnits(args.amount, 18)} 枚`);
    }
    await client.simulateContract({
      address: token, abi: TOKEN_ABI, functionName: "mint", args: [args.to, args.amount], account: owner,
    });
    console.log(JSON.stringify({
      kind: "mint",
      chainId: CHAIN_ID,
      token,
      owner,
      to: args.to,
      amount: formatUnits(args.amount, 18),
      balanceBefore: formatUnits(balance, 18),
      supplyBefore: formatUnits(supply, 18),
      cap: formatUnits(cap, 18),
      totalNemoAllocated: formatUnits(allocated, 18),
      apply: args.apply,
    }));
    if (!args.apply) {
      console.log("模拟通过。确认后：npm run ckey:mint -- --to <地址> --amount <枚数> --apply");
      return;
    }
    const plan = ckeySignPlan({ owner, token, kind: "mint", to: args.to, amount: args.amount });
    const path = runPath("plans", `ckey-mint-${stamp()}.json`);
    writePlan(path, plan);
    console.log(`计划 ${path}`);
    await servePlan(path, {
      rpc: need(env, "BSC_MAINNET_RPC"),
      allowed: [token],
      port,
      walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "",
    });
    const hash = readPlan(path).txs[0].hash;
    const [supplyAfter, balanceAfter, allocatedAfter] = await Promise.all([
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [args.to] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalNemoAllocated" }),
    ]);
    if (balanceAfter !== balance + args.amount) {
      throw new Error(`${args.to} 余额是 ${formatUnits(balanceAfter, 18)}，期望 ${formatUnits(balance + args.amount, 18)}。交易 ${hash}`);
    }
    if (supplyAfter !== supply + args.amount) {
      throw new Error(`总量是 ${formatUnits(supplyAfter, 18)}，期望 ${formatUnits(supply + args.amount, 18)}。交易 ${hash}`);
    }
    if (allocatedAfter !== allocated) {
      throw new Error(`totalNemoAllocated 从 ${allocated} 变成 ${allocatedAfter}。Owner 直接铸造不应改这个数。交易 ${hash}`);
    }
    console.log(JSON.stringify({
      tx: hash,
      balanceAfter: formatUnits(balanceAfter, 18),
      supplyAfter: formatUnits(supplyAfter, 18),
      totalNemoAllocated: formatUnits(allocatedAfter, 18),
    }));
    return;
  }

  const enabled = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "transfersEnabled" });
  if (enabled) throw new Error("transfersEnabled 已打开，白名单不再生效");
  const current = await client.readContract({
    address: token, abi: TOKEN_ABI, functionName: "transferAllowlist", args: [args.account],
  });
  console.log(JSON.stringify({
    kind: "allowlist",
    chainId: CHAIN_ID,
    token,
    owner,
    account: args.account,
    current,
    apply: args.apply,
  }));
  if (current) {
    console.log("已经在白名单里");
    return;
  }
  await client.simulateContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "setTransferAllowlist",
    args: [args.account, true],
    account: owner,
  });
  if (!args.apply) {
    console.log("模拟通过。确认后：npm run ckey:allowlist -- --account <地址> --apply");
    return;
  }
  const plan = ckeySignPlan({ owner, token, kind: "allowlist", account: args.account });
  const path = runPath("plans", `ckey-allowlist-${stamp()}.json`);
  writePlan(path, plan);
  console.log(`计划 ${path}`);
  await servePlan(path, {
    rpc: need(env, "BSC_MAINNET_RPC"),
    allowed: [token],
    port,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "",
  });
  const hash = readPlan(path).txs[0].hash;
  const now = await client.readContract({
    address: token, abi: TOKEN_ABI, functionName: "transferAllowlist", args: [args.account],
  });
  if (!now) throw new Error(`${args.account} 仍不在白名单里。交易 ${hash}`);
  console.log(JSON.stringify({ tx: hash, account: args.account, allowlist: true }));
}

let envForErrors = {};
try {
  envForErrors = readMainnetEnv({ allowMissingFixed: true });
} catch {
  envForErrors = {};
}

main().catch((error) => {
  console.error(redact(error?.shortMessage || error?.stack || error?.message || error, envForErrors));
  process.exit(1);
});
