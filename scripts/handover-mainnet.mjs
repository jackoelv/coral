#!/usr/bin/env node
/**
 * Hands the five contracts from the one-time deployer to MAINNET_OWNER (Binance Wallet extension).
 *
 *   npm run handover:mainnet                       owner / pendingOwner of all five
 *   npm run handover:mainnet -- --apply            deployer calls transferOwnership(MAINNET_OWNER) x5
 *   npm run handover:mainnet -- --accept           plan of five acceptOwnership(), opens the sign page
 *   npm run handover:mainnet -- --check            owners = MAINNET_OWNER, pending = 0, deployer rejected
 *   npm run handover:mainnet -- --retire-deployer  BNB back to Owner, clear MAINNET_PRIVATE_KEY
 */
import { existsSync } from "node:fs";
import { formatEther, getAddress, parseAbi, zeroAddress } from "viem";
import { buildPlan, planTx, readPlan, writePlan } from "./lib/sign-plan.mjs";
import { servePlan } from "./lib/sign-server.mjs";
import {
  CONTRACT_KEYS,
  CONTRACT_NAMES,
  OWNABLE_ABI,
  confirmTyped,
  contracts,
  deployerAccount,
  mainnetClient,
  need,
  readMainnetEnv,
  roles,
  runPath,
  saveMainnetEnv,
  sendAsDeployer,
  writeEvidence,
} from "./lib/mainnet.mjs";
import { createWalletClient, http } from "viem";
import { bsc } from "viem/chains";

const args = process.argv.slice(2);
const mode = ["apply", "accept", "check", "retire-deployer"].find((m) => args.includes(`--${m}`)) || "preview";
const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const { deployer, owner, publisher } = roles(env, { requirePublisher: true });

async function state() {
  const rows = {};
  for (const key of CONTRACT_KEYS) {
    rows[key] = {
      address: a[key],
      owner: getAddress(await client.readContract({ address: a[key], abi: OWNABLE_ABI, functionName: "owner" })),
      pendingOwner: getAddress(await client.readContract({ address: a[key], abi: OWNABLE_ABI, functionName: "pendingOwner" })),
    };
  }
  return rows;
}

async function readiness() {
  const v = parseAbi(["function importFrozen() view returns (bool)", "function saleOpen() view returns (bool)"]);
  const r = parseAbi(["function publisher() view returns (address)", "function maxRootIncrease() view returns (uint256)"]);
  const n = parseAbi(["function imageURI() view returns (string)"]);
  const problems = [];
  if (!(await client.readContract({ address: a.IDO, abi: v, functionName: "importFrozen" }))) problems.push("还没 freezeImport");
  if (!(await client.readContract({ address: a.IDO, abi: v, functionName: "saleOpen" }))) problems.push("还没 openSale");
  if (getAddress(await client.readContract({ address: a.REWARDS, abi: r, functionName: "publisher" })) !== publisher) problems.push("publisher 还没设成 MAINNET_PUBLISHER");
  if ((await client.readContract({ address: a.REWARDS, abi: r, functionName: "maxRootIncrease" })) === 0n) problems.push("maxRootIncrease 是 0");
  if ((await client.readContract({ address: a.NFT, abi: n, functionName: "imageURI" })) !== need(env, "NFT_IMAGE_URI")) problems.push("NFT imageURI 和 NFT_IMAGE_URI 不同，先跑 nft-image:mainnet");
  if (!existsSync(runPath("import-interest-backfill.json"))) problems.push("没有补发账本 mainnet-run/import-interest-backfill.json，确认 settle:mainnet -- --apply 已完成");
  return problems;
}

async function check() {
  const rows = await state();
  const failures = [];
  for (const [key, row] of Object.entries(rows)) {
    if (row.owner !== owner) failures.push(`${key}.owner=${row.owner}`);
    if (row.pendingOwner !== zeroAddress) failures.push(`${key}.pendingOwner=${row.pendingOwner}`);
    try {
      await client.simulateContract({ address: a[key], abi: OWNABLE_ABI, functionName: "transferOwnership", args: [deployer], account: deployer });
      failures.push(`${key}: 部署账户仍能调用 onlyOwner`);
    } catch {
      // Expected: OwnableUnauthorizedAccount.
    }
  }
  try {
    await client.simulateContract({ address: a.IDO, abi: parseAbi(["function pause()"]), functionName: "pause", account: deployer });
    failures.push("IDO: 部署账户仍能 pause");
  } catch {
    // Expected.
  }
  return { rows, failures };
}

const rows = await state();
console.log(JSON.stringify({ deployer, owner, publisher, contracts: rows, mode }, null, 2));

if (mode === "preview") {
  const problems = await readiness();
  if (problems.length) console.log(`移交前还没完成：\n- ${problems.join("\n- ")}`);
  console.log("确认后：npm run handover:mainnet -- --apply");
} else if (mode === "apply") {
  const problems = await readiness();
  if (problems.length) throw new Error(`移交前还没完成：\n- ${problems.join("\n- ")}`);
  const account = deployerAccount(env);
  for (const key of CONTRACT_KEYS) {
    const row = rows[key];
    if (row.owner === owner) continue;
    if (row.owner !== account.address) throw new Error(`${key} 的 Owner 是 ${row.owner}，不是部署账户`);
    if (row.pendingOwner === owner) continue;
    await sendAsDeployer({ env, client, account, to: a[key], abi: OWNABLE_ABI, functionName: "transferOwnership", args: [owner], label: `${key}.transferOwnership` });
  }
  const after = await state();
  for (const [key, row] of Object.entries(after)) if (row.owner !== owner && row.pendingOwner !== owner) throw new Error(`${key}.pendingOwner 不是 MAINNET_OWNER`);
  console.log("五个 pendingOwner 都是 MAINNET_OWNER，部署账户仍是 Owner。下一步：npm run handover:mainnet -- --accept");
} else if (mode === "accept") {
  const path = runPath("plans", "accept-ownership.json");
  let plan;
  if (existsSync(path)) {
    plan = readPlan(path);
    if (getAddress(plan.signer) !== owner) throw new Error("已有的 accept-ownership.json 签名人不是 MAINNET_OWNER");
    console.log(`续签已有计划 ${path}`);
  } else {
    const txs = [];
    for (const key of CONTRACT_KEYS) {
      if (rows[key].owner === owner) continue;
      if (rows[key].pendingOwner !== owner) throw new Error(`${key}.pendingOwner 不是 MAINNET_OWNER，先跑 --apply`);
      txs.push(planTx({ label: `${CONTRACT_NAMES[key]} acceptOwnership`, contract: CONTRACT_NAMES[key], to: a[key], signature: "function acceptOwnership()" }));
    }
    if (!txs.length) {
      console.log("五个合约 Owner 都已是 MAINNET_OWNER。");
      process.exit(0);
    }
    plan = buildPlan({ chainId: 56, signer: owner, signerRole: "Owner", purpose: "五个合约接受所有权（Ownable2Step）", txs });
    writePlan(path, plan);
  }
  await servePlan(path, { rpc: need(env, "BSC_MAINNET_RPC"), allowed: Object.values(a), walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || "" });
  console.log("五笔都已成功。下一步：npm run handover:mainnet -- --check");
} else if (mode === "check") {
  const { failures } = await check();
  console.log(`证据 ${writeEvidence("handover-check", { owner, failures })}`);
  if (failures.length) throw new Error(`移交核对没通过：\n${failures.join("\n")}`);
  console.log("五个合约都归 MAINNET_OWNER，部署账户已无权限。下一步：npm run handover:mainnet -- --retire-deployer");
} else if (mode === "retire-deployer") {
  const { failures } = await check();
  if (failures.length) throw new Error(`移交还没完成，不能退役部署账户：\n${failures.join("\n")}`);
  const account = deployerAccount(env);
  const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account.address }), client.getGasPrice()]);
  const fee = 21_000n * gasPrice * 2n;
  const value = balance > fee ? balance - fee : 0n;
  await confirmTyped("RETIRE", `把部署账户剩余 ${formatEther(value)} BNB 转给 Owner ${owner}，然后清空 MAINNET_PRIVATE_KEY。`);
  if (value > 0n) {
    const wallet = createWalletClient({ account, chain: bsc, transport: http(need(env, "BSC_MAINNET_RPC")) });
    const hash = await wallet.sendTransaction({ to: owner, value, gas: 21_000n, gasPrice: gasPrice * 2n });
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3 });
    if (receipt.status !== "success") throw new Error(`BNB 转回失败 ${hash}`);
    console.log(`BNB 已转回 ${hash}`);
  }
  saveMainnetEnv({ MAINNET_PRIVATE_KEY: "" });
  console.log("MAINNET_PRIVATE_KEY 已清空。注意 .env.mainnet.backup-* 里仍有旧私钥，部署账户已无合约权限；确认后可以删除这些备份。");
}
