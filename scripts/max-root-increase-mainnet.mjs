#!/usr/bin/env node
/**
 * Owner 修改奖励合约的 maxRootIncrease。www.freedao.life 的 /admin/coral/publish 读的就是这个链上值。
 * 不读数据库。只读 .env.mainnet 的 BSC 主网 RPC，chainId 必须是 56。
 * --amount 是 e18 整数。318 USDT 写成 318000000000000000000，不要写成 318。
 * 默认只核对并模拟。--apply 才在 127.0.0.1 打开签名页，用 Chrome 插件或手机 imToken 签名。
 * 签名账户必须是链上 Owner。私钥不要导入这台电脑；Chrome 插件里的私钥在这台电脑上。
 * 签到一半断开时，用打印出来的计划路径跑 sign:mainnet 续签，不要再 --apply。
 *
 *   npm run max-increase:mainnet -- --amount 318000000000000000000
 *   npm run max-increase:mainnet -- --amount 318000000000000000000 --apply
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { formatUnits, getAddress } from "viem";
import { increasePlan, parseIncreaseArgs, REWARDS_ABI } from "./lib/max-root-increase.mjs";
import { CHAIN_ID, CONTRACT_NAMES, contracts, MAINNET_ENV, mainnetClient, need, readMainnetEnv, redact, runPath, stamp } from "./lib/mainnet.mjs";
import { readPlan, writePlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";
import { updateEnvText } from "./lib/testnet-env.mjs";

function writeEnvAmount(amount) {
  const text = readFileSync(MAINNET_ENV, "utf8");
  const next = updateEnvText(text, { MAX_ROOT_INCREASE_WEI: amount });
  const temp = `${MAINNET_ENV}.tmp-${process.pid}`;
  writeFileSync(temp, next, { mode: 0o600, flag: "wx" });
  renameSync(temp, MAINNET_ENV);
  chmodSync(MAINNET_ENV, 0o600);
}

async function main() {
  const args = parseIncreaseArgs(process.argv.slice(2));
  const env = readMainnetEnv();
  const client = await mainnetClient(env);
  const rewards = contracts(env).REWARDS;
  const owner = getAddress(await client.readContract({ address: rewards, abi: REWARDS_ABI, functionName: "owner" }));
  const code = await client.getCode({ address: owner });
  if (code && code !== "0x") throw new Error(`奖励合约 Owner ${owner} 是合约。Chrome 插件和 imToken 只能签个人地址`);
  if (getAddress(env.MAINNET_OWNER) !== owner) {
    throw new Error(`链上 Owner 是 ${owner}，.env.mainnet 的 MAINNET_OWNER 是 ${getAddress(env.MAINNET_OWNER)}`);
  }
  const current = await client.readContract({ address: rewards, abi: REWARDS_ABI, functionName: "maxRootIncrease" });
  const preview = {
    chainId: CHAIN_ID,
    rewards,
    contract: CONTRACT_NAMES.REWARDS,
    owner,
    current: current.toString(),
    currentUsdt: formatUnits(current, 18),
    amount: args.amount.toString(),
    amountUsdt: formatUnits(args.amount, 18),
    apply: args.apply,
  };
  console.log(JSON.stringify(preview));
  if (current === args.amount) {
    console.log("链上已经是这个 e18 整数。后台下次打开发布页就会显示它。");
    return;
  }
  await client.simulateContract({
    address: rewards,
    abi: REWARDS_ABI,
    functionName: "setMaxRootIncrease",
    args: [args.amount],
    account: owner,
  });
  if (!args.apply) {
    console.log(`模拟通过。确认后：npm run max-increase:mainnet -- --amount ${args.amount} --apply`);
    return;
  }
  const plan = increasePlan({ owner, rewards, current, amount: args.amount });
  const path = runPath("plans", `max-root-increase-${stamp()}.json`);
  writePlan(path, plan);
  console.log(`计划 ${path}`);
  await servePlan(path, {
    rpc: need(env, "BSC_MAINNET_RPC"),
    allowed: [rewards],
    port: args.port,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "",
  });
  const hash = readPlan(path).txs[0].hash;
  const after = await client.readContract({ address: rewards, abi: REWARDS_ABI, functionName: "maxRootIncrease" });
  if (after !== args.amount) {
    throw new Error(`链上 maxRootIncrease 是 ${after}，期望 ${args.amount}。交易 ${hash}`);
  }
  writeEnvAmount(args.amount.toString());
  console.log(JSON.stringify({
    tx: hash,
    maxRootIncrease: after.toString(),
    usdt: formatUnits(after, 18),
    env: "MAX_ROOT_INCREASE_WEI",
  }));
  console.log("链上已更新。www.freedao.life 的 /admin/coral/publish 下次读取就会用这个上限，不用重新部署。");
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
