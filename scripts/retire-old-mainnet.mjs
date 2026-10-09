#!/usr/bin/env node
/**
 * Freezes the vault being replaced (OLD_MAINNET_*) before the migration snapshot.
 * Only writes sign plans for MAINNET_OWNER; sign them with sign:mainnet. Never calls endIdo.
 *
 *   npm run retire-old:mainnet                     state + plan: IDO closeSale, IDO pause, token pause
 *   npm run retire-old:mainnet -- --check          all frozen? writes mainnet-run/old-cutoff.json
 *   npm run retire-old:mainnet -- --withdraw <to>  plan: withdrawTreasury(to, treasuryWithdrawable())
 */
import { existsSync, writeFileSync } from "node:fs";
import { formatUnits, getAddress, parseAbi } from "viem";
import { buildPlan, planTx, readPlan, writePlan } from "./lib/sign-plan.mjs";
import { OWNABLE_ABI, addressOf, mainnetClient, oldContracts, readMainnetEnv, runPath, writeEvidence } from "./lib/mainnet.mjs";

const VAULT = parseAbi([
  "function saleOpen() view returns (bool)",
  "function paused() view returns (bool)",
  "function treasuryWithdrawable() view returns (uint256)",
  "function totalImported() view returns (uint256)",
  "function totalContributed() view returns (uint256)",
]);
const TOKEN = parseAbi(["function paused() view returns (bool)"]);

const args = process.argv.slice(2);
const mode = args.includes("--check") ? "check" : args.includes("--withdraw") ? "withdraw" : "plan";
const env = readMainnetEnv();
const client = await mainnetClient(env);
const old = oldContracts(env);
const owner = addressOf(env, "MAINNET_OWNER");
const PLAN = runPath("plans", "retire-old.json");
const CUTOFF = runPath("old-cutoff.json");

async function state() {
  const [idoOwner, ckeyOwner, saleOpen, idoPaused, ckeyPaused, withdrawable, totalImported, totalContributed, block] = await Promise.all([
    client.readContract({ address: old.IDO, abi: OWNABLE_ABI, functionName: "owner" }),
    client.readContract({ address: old.CKEY, abi: OWNABLE_ABI, functionName: "owner" }),
    client.readContract({ address: old.IDO, abi: VAULT, functionName: "saleOpen" }),
    client.readContract({ address: old.IDO, abi: VAULT, functionName: "paused" }),
    client.readContract({ address: old.CKEY, abi: TOKEN, functionName: "paused" }),
    client.readContract({ address: old.IDO, abi: VAULT, functionName: "treasuryWithdrawable" }),
    client.readContract({ address: old.IDO, abi: VAULT, functionName: "totalImported" }),
    client.readContract({ address: old.IDO, abi: VAULT, functionName: "totalContributed" }),
    client.getBlockNumber(),
  ]);
  return { idoOwner: getAddress(idoOwner), ckeyOwner: getAddress(ckeyOwner), saleOpen, idoPaused, ckeyPaused, withdrawable, totalImported, totalContributed, block };
}

const s = await state();
console.log(JSON.stringify({
  oldIdo: old.IDO,
  oldCkey: old.CKEY,
  owner,
  ...s,
  withdrawable: formatUnits(s.withdrawable, 18),
  totalImported: formatUnits(s.totalImported, 18),
  totalContributed: formatUnits(s.totalContributed, 18),
  block: s.block.toString(),
  mode,
}, null, 2));
if (s.idoOwner !== owner || s.ckeyOwner !== owner) throw new Error("旧 IDO 或旧 token 的 Owner 不是 MAINNET_OWNER，计划会签不出去");

const frozen = !s.saleOpen && s.idoPaused && s.ckeyPaused;

if (mode === "plan") {
  if (frozen) {
    console.log("旧合约已经关闭并暂停。下一步：npm run retire-old:mainnet -- --check");
    process.exit(0);
  }
  if (existsSync(PLAN)) {
    const plan = readPlan(PLAN);
    if (getAddress(plan.signer) !== owner) throw new Error(`${PLAN} 的签名人不是 MAINNET_OWNER`);
    console.log(`已有计划 ${PLAN}，继续签：npm run sign:mainnet -- mainnet-run/plans/retire-old.json`);
    process.exit(0);
  }
  const txs = [];
  if (s.saleOpen) txs.push(planTx({ label: "旧 IDO closeSale", contract: "OldIdo", to: old.IDO, signature: "function closeSale()" }));
  if (!s.idoPaused) txs.push(planTx({ label: "旧 IDO pause", contract: "OldIdo", to: old.IDO, signature: "function pause()" }));
  if (!s.ckeyPaused) txs.push(planTx({ label: "旧 token pause", contract: "OldToken", to: old.CKEY, signature: "function pause()" }));
  writePlan(PLAN, buildPlan({
    chainId: 56,
    signer: owner,
    signerRole: "Owner",
    purpose: "关闭并暂停被替换的旧金库和旧 token，冻结迁移快照",
    meta: { kind: "retireOld", oldIdo: old.IDO, oldCkey: old.CKEY },
    txs,
  }));
  console.log(`已写 ${PLAN}（${txs.length} 笔）。下一步：npm run sign:mainnet -- mainnet-run/plans/retire-old.json`);
} else if (mode === "check") {
  if (!frozen) throw new Error("旧合约还没全部关闭：saleOpen 要为 false，旧 IDO 和旧 token 都要暂停");
  const signed = existsSync(PLAN) ? readPlan(PLAN).txs.map((tx) => ({ label: tx.label, status: tx.status, hash: tx.hash })) : [];
  const cutoff = {
    checkedAt: new Date().toISOString(),
    oldIdo: old.IDO,
    oldRewards: old.REWARDS,
    oldCkey: old.CKEY,
    checkedAtBlock: s.block.toString(),
    totalImported: s.totalImported.toString(),
    totalContributed: s.totalContributed.toString(),
    signed,
  };
  writeFileSync(CUTOFF, `${JSON.stringify(cutoff, null, 2)}\n`, { mode: 0o600 });
  console.log(`证据 ${writeEvidence("retire-old-check", cutoff)}`);
  console.log(`旧合约已冻结，写入 ${CUTOFF}。下一步：部署新合约，然后 npm run snapshot:mainnet`);
} else {
  const raw = args[args.indexOf("--withdraw") + 1];
  if (!raw || raw.startsWith("--")) throw new Error("用法：npm run retire-old:mainnet -- --withdraw <收款地址>");
  const to = getAddress(raw);
  if (!existsSync(CUTOFF)) throw new Error("还没跑 --check，旧合约未确认冻结，先不要转出");
  if (!frozen) throw new Error("旧合约不再处于冻结状态，停止");
  if (s.withdrawable === 0n) {
    console.log("旧金库可提金额是 0，不用转出。");
    process.exit(0);
  }
  const path = runPath("plans", "retire-old-withdraw.json");
  if (existsSync(path)) throw new Error(`${path} 已存在。签完或确认作废后删掉再生成`);
  writePlan(path, buildPlan({
    chainId: 56,
    signer: owner,
    signerRole: "Owner",
    purpose: `旧金库可提余额 ${formatUnits(s.withdrawable, 18)} USDT 转到 ${to}`,
    meta: { kind: "retireOld", oldIdo: old.IDO, to, amount: s.withdrawable.toString() },
    txs: [planTx({ label: "旧 IDO withdrawTreasury", contract: "OldIdo", to: old.IDO, signature: "function withdrawTreasury(address to, uint256 amount)", args: [to, s.withdrawable] })],
  }));
  console.log(`已写 ${path}。下一步：npm run sign:mainnet -- mainnet-run/plans/retire-old-withdraw.json`);
}
