#!/usr/bin/env node
/**
 * Deployer sets the rewards publisher, the per-publish increase limit and the historical team budget.
 * Values already correct are skipped. The publisher key never touches this machine.
 *
 *   npm run publisher:mainnet
 *   npm run publisher:mainnet -- --apply
 */
import { getAddress, parseAbi } from "viem";
import { contracts, deployerAccount, mainnetClient, positiveWei, readMainnetEnv, roles, sendAsDeployer, writeEvidence } from "./lib/mainnet.mjs";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function publisher() view returns (address)",
  "function maxRootIncrease() view returns (uint256)",
  "function historicalTeamBudget() view returns (uint256)",
  "function committed() view returns (uint256)",
  "function setPublisher(address)",
  "function setMaxRootIncrease(uint256)",
  "function setHistoricalTeamBudget(uint256)",
]);
const apply = process.argv.includes("--apply");
const env = readMainnetEnv();
const client = await mainnetClient(env);
const { publisher } = roles(env, { requirePublisher: true });
const account = deployerAccount(env);
const rewards = contracts(env).REWARDS;
const maxIncrease = positiveWei(env, "MAX_ROOT_INCREASE_WEI");
const budget = positiveWei(env, "HISTORICAL_TEAM_BUDGET_WEI", { allowZero: true });
const r = (fn) => client.readContract({ address: rewards, abi: ABI, functionName: fn });

const owner = getAddress(await r("owner"));
if (owner !== account.address) throw new Error(`奖励合约 Owner 是 ${owner}，不是部署账户。移交之后请在签名页用 Owner 签 setPublisher`);
const current = { publisher: getAddress(await r("publisher")), maxRootIncrease: await r("maxRootIncrease"), historicalTeamBudget: await r("historicalTeamBudget") };
const steps = [
  ["setPublisher", publisher, current.publisher === publisher],
  ["setMaxRootIncrease", maxIncrease, current.maxRootIncrease === maxIncrease],
  ["setHistoricalTeamBudget", budget, current.historicalTeamBudget === budget],
];
console.log(JSON.stringify({ rewards, current, target: { publisher, maxRootIncrease: maxIncrease, historicalTeamBudget: budget }, todo: steps.filter((s) => !s[2]).map((s) => s[0]), apply }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
if (!apply) {
  console.log("预览完成。确认后：npm run publisher:mainnet -- --apply");
  process.exit(0);
}
for (const [fn, value, done] of steps) {
  if (done) continue;
  await sendAsDeployer({ env, client, account, to: rewards, abi: ABI, functionName: fn, args: [value] });
}
const after = { publisher: getAddress(await r("publisher")), maxRootIncrease: await r("maxRootIncrease"), historicalTeamBudget: await r("historicalTeamBudget") };
if (after.publisher !== publisher || after.maxRootIncrease !== maxIncrease || after.historicalTeamBudget !== budget) throw new Error("链上核对失败");
console.log(`链上三项已一致。证据 ${writeEvidence("publisher", after)}`);
