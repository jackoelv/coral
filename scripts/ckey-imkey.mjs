#!/usr/bin/env node
/**
 * Owner 用 imKey 做两件互不相干的事：铸造 CKEY，或把一个地址加入转账白名单。
 * 不读数据库。只读 .env.mainnet 的 BSC 主网 RPC，chainId 必须是 56。
 * 默认只核对并打印。--apply 才打开本机页面，由插在这台电脑上的 imKey 离线签名。
 * 设备路径固定是 m/44'/60'/0'/0/0，也就是 imToken 里 imKey 的第一个 EVM 地址。
 *
 *   npm run ckey:mint:imkey -- --to 0x... --amount 1000
 *   npm run ckey:mint:imkey -- --to 0x... --amount 1000 --apply
 *   npm run ckey:allowlist:imkey -- --account 0x...
 *   npm run ckey:allowlist:imkey -- --account 0x... --apply
 */
import { formatUnits, getAddress } from "viem";
import {
  TOKEN_ABI,
  VAULT_ABI,
  allowlistCall,
  mintCall,
  parseCkeyArgs,
} from "./lib/ckey-owner.mjs";
import { serveImkey } from "./lib/imkey-page.mjs";
import { CHAIN_ID, contracts, mainnetClient, readMainnetEnv, redact } from "./lib/mainnet.mjs";

async function readToken(client, token, owner) {
  const code = await client.getCode({ address: owner });
  if (code && code !== "0x") throw new Error(`CKEY Owner ${owner} 是合约。imKey 只能签硬件钱包自己的地址`);
  const [cap, supply, enabled] = await Promise.all([
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: "CAP" }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: "transfersEnabled" }),
  ]);
  return { cap, supply, enabled };
}

async function main() {
  const args = parseCkeyArgs(process.argv.slice(2));
  const env = readMainnetEnv();
  const client = await mainnetClient(env);
  const token = contracts(env).CKEY;
  const vault = contracts(env).IDO;
  const owner = getAddress(await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }));
  const { cap, supply, enabled } = await readToken(client, token, owner);

  if (args.kind === "mint") {
    const call = mintCall(args.to, args.amount);
    const [balance, allocated] = await Promise.all([
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
      console.log("模拟通过。确认后：npm run ckey:mint:imkey -- --to <地址> --amount <枚数> --apply");
      return;
    }
    const { hash } = await serveImkey({
      rpc: env.BSC_MAINNET_RPC,
      chainId: CHAIN_ID,
      owner,
      token,
      purpose: `铸造 ${formatUnits(args.amount, 18)} 枚 CKEY 到 ${args.to}`,
      call,
      port: args.port,
    });
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

  if (enabled) throw new Error("transfersEnabled 已打开，白名单不再生效");
  const call = allowlistCall(args.account);
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
    console.log("模拟通过。确认后：npm run ckey:allowlist:imkey -- --account <地址> --apply");
    return;
  }
  const { hash } = await serveImkey({
    rpc: env.BSC_MAINNET_RPC,
    chainId: CHAIN_ID,
    owner,
    token,
    purpose: `把 ${args.account} 加入 CKEY 转账白名单`,
    call,
    port: args.port,
  });
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
