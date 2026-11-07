#!/usr/bin/env node
/**
 * Owner 把金库直推比例改成 500（5%）。
 * 交易确认之后的新入金按 5% 计提。已经计提的 10% 不动。
 * 这笔交易不改变网体档位，也不需要发布 root。
 * 默认只核对并模拟。--apply 才在 127.0.0.1 打开签名页。
 * 签名账户必须是金库 Owner，并且是浏览器或 imToken 里的第一个账户。
 * 签到一半断开时，用打印出来的计划路径跑 sign:mainnet 续签，不要再 --apply。
 *
 *   npm run direct:mainnet
 *   npm run direct:mainnet -- --apply
 */
import { getAddress } from "viem";
import { DIRECT_BPS_TARGET, directPlan, IDO_ABI, parseDirectArgs } from "./lib/direct-referral-bps.mjs";
import { CHAIN_ID, CONTRACT_NAMES, contracts, mainnetClient, need, readMainnetEnv, redact, runPath, stamp } from "./lib/mainnet.mjs";
import { readPlan, writePlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";

async function main() {
  const args = parseDirectArgs(process.argv.slice(2));
  const env = readMainnetEnv();
  const client = await mainnetClient(env);
  const ido = contracts(env).IDO;
  const owner = getAddress(await client.readContract({ address: ido, abi: IDO_ABI, functionName: "owner" }));
  const code = await client.getCode({ address: owner });
  if (code && code !== "0x") throw new Error(`金库 Owner ${owner} 是合约。Chrome 插件和 imToken 只能签个人地址`);
  if (getAddress(env.MAINNET_OWNER) !== owner) {
    throw new Error(`链上 Owner 是 ${owner}，.env.mainnet 的 MAINNET_OWNER 是 ${getAddress(env.MAINNET_OWNER)}`);
  }
  const current = await client.readContract({ address: ido, abi: IDO_ABI, functionName: "directReferralBps" });
  const head = await client.getBlockNumber();
  const v3 = (env.TEAM_TIER_V3_BLOCK || "").trim();
  console.log(JSON.stringify({
    chainId: CHAIN_ID,
    ido,
    contract: CONTRACT_NAMES.IDO,
    owner,
    head: head.toString(),
    current: current.toString(),
    target: DIRECT_BPS_TARGET.toString(),
    teamTierV3Block: v3 || null,
    apply: args.apply,
  }));
  console.log("交易确认后的新入金，金库按 5% 计提直推。已经计提的 10% 不变。网体档位不随这笔交易改变，也不用为它发布 root。");
  console.log("www 上的定时任务要先部署这次的索引代码，才会把之后的直推记成 5%。旧任务会继续按 10% 写入正式库。");
  if (current === DIRECT_BPS_TARGET) {
    console.log("链上直推比例已经是 500。");
    return;
  }
  await client.simulateContract({
    address: ido,
    abi: IDO_ABI,
    functionName: "setDirectReferralBps",
    args: [DIRECT_BPS_TARGET],
    account: owner,
  });
  if (!args.apply) {
    console.log("模拟通过。确认后：npm run direct:mainnet -- --apply");
    return;
  }
  const plan = directPlan({ owner, ido, current });
  const path = runPath("plans", `direct-referral-bps-${stamp()}.json`);
  writePlan(path, plan);
  console.log(`计划 ${path}`);
  await servePlan(path, {
    rpc: need(env, "BSC_MAINNET_RPC"),
    allowed: [ido],
    port: args.port,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "",
  });
  const hash = readPlan(path).txs[0].hash;
  const after = await client.readContract({ address: ido, abi: IDO_ABI, functionName: "directReferralBps" });
  if (after !== DIRECT_BPS_TARGET) {
    throw new Error(`链上直推比例是 ${after}，期望 ${DIRECT_BPS_TARGET}。交易 ${hash}`);
  }
  console.log(JSON.stringify({ tx: hash, directReferralBps: after.toString() }));
  console.log("链上已是 5%。之后的新入金按这个比例计提。已经发布的 root 不用重发。");
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
