#!/usr/bin/env node
/**
 * Read-only. Shows how much USDT the vault still needs.
 * Imported volume only reserves reward room; no USDT came with it.
 * Need = unclaimed direct + team outstanding in the active root + historical team rewards not yet in a root.
 *
 *   npm run fund:mainnet
 */
import { existsSync, readFileSync } from "node:fs";
import { formatUnits, parseAbi } from "viem";
import { USDT, contracts, mainnetClient, readMainnetEnv, runPath, writeEvidence } from "./lib/mainnet.mjs";

const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const VAULT = parseAbi(["function directReserve() view returns (uint256)", "function reservedRewards() view returns (uint256)", "function totalImported() view returns (uint256)", "function totalContributed() view returns (uint256)"]);
const REWARDS = parseAbi(["function committed() view returns (uint256)", "function totalTeamPaid() view returns (uint256)", "function rewardCap() view returns (uint256)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const [balance, direct, reserved, imported, contributed, committed, teamPaid, cap] = await Promise.all([
  client.readContract({ address: USDT, abi: ERC20, functionName: "balanceOf", args: [a.IDO] }),
  client.readContract({ address: a.IDO, abi: VAULT, functionName: "directReserve" }),
  client.readContract({ address: a.IDO, abi: VAULT, functionName: "reservedRewards" }),
  client.readContract({ address: a.IDO, abi: VAULT, functionName: "totalImported" }),
  client.readContract({ address: a.IDO, abi: VAULT, functionName: "totalContributed" }),
  client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: "committed" }),
  client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: "totalTeamPaid" }),
  client.readContract({ address: a.REWARDS, abi: REWARDS, functionName: "rewardCap" }),
]);
const file = runPath("historical-team-rewards.json");
const historical = existsSync(file) ? BigInt(JSON.parse(readFileSync(file, "utf8")).teamRewardWei) : 0n;
// Historical team rewards are inside `committed` once a root containing them is published.
const notYetCommitted = historical > committed ? historical - committed : 0n;
const need = reserved + notYetCommitted;
const gap = need > balance ? need - balance : 0n;
const u = (v) => formatUnits(v, 18);
const out = {
  vault: a.IDO,
  vaultUsdt: u(balance),
  unclaimedDirect: u(direct),
  teamCommitted: u(committed),
  teamPaid: u(teamPaid),
  reservedRewards: u(reserved),
  historicalTeamFile: existsSync(file) ? u(historical) : "(还没跑 settle-team:mainnet)",
  historicalNotYetInRoot: u(notYetCommitted),
  totalImported: u(imported),
  totalContributed: u(contributed),
  rewardCap: u(cap),
  need: u(need),
  gap: u(gap),
};
console.log(JSON.stringify(out, null, 2));
console.log(`证据 ${writeEvidence("fund", out)}`);
if (gap > 0n) console.log(`还差 ${u(gap)} USDT。用币安钱包从 Owner 地址直接转 USDT 到 ${a.IDO}（普通转账），然后再跑一次。`);
else console.log("金库余额够付已承诺的奖励。");
