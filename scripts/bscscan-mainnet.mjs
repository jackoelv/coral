#!/usr/bin/env node
/**
 * Verifies the five mainnet contracts on BscScan with forge verify-contract.
 * Constructor args are cut from the real creation calldata, so they match what was deployed.
 * Refuses when the local out/ bytecode is not the prefix of the deployed creation code.
 *
 *   npm run bscscan:mainnet
 *   npm run bscscan:mainnet -- --apply
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { CONTRACT_KEYS, CONTRACT_NAMES, ROOT, cleanEnv, contracts, mainnetClient, need, readMainnetEnv, redact, writeEvidence } from "./lib/mainnet.mjs";

const apply = process.argv.includes("--apply");
const env = readMainnetEnv();
const client = await mainnetClient(env);
const a = contracts(env);
const run = JSON.parse(readFileSync(resolve(ROOT, "broadcast/Deploy.s.sol/56/run-latest.json"), "utf8"));
const toml = readFileSync(resolve(ROOT, "foundry.toml"), "utf8");
const solc = toml.match(/solc\s*=\s*"([^"]+)"/)?.[1];
const runs = toml.match(/optimizer_runs\s*=\s*(\d+)/)?.[1];
const evm = toml.match(/evm_version\s*=\s*"([^"]+)"/)?.[1];
if (solc !== "0.8.28" || runs !== "200") throw new Error(`foundry.toml 编译设置是 solc ${solc} / runs ${runs}，和冻结版本 0.8.28 / 200 不一致`);

const jobs = [];
for (const key of CONTRACT_KEYS) {
  const name = CONTRACT_NAMES[key];
  const tx = run.transactions.find((t) => t.contractName === name && t.transactionType === "CREATE");
  if (!tx || getAddress(tx.contractAddress) !== a[key]) throw new Error(`${name} 的部署记录和 .env.mainnet 地址不一致`);
  const live = await client.getTransaction({ hash: tx.hash });
  const artifact = JSON.parse(readFileSync(resolve(ROOT, `out/${name}.sol/${name}.json`), "utf8"));
  const bytecode = artifact.bytecode.object.toLowerCase();
  const input = live.input.toLowerCase();
  if (!input.startsWith(bytecode)) throw new Error(`${name} 的本地编译产物和链上创建代码不一致。不要改源码后再验证，先回到冻结版本 forge build`);
  jobs.push({ key, name, address: a[key], constructorArgs: `0x${input.slice(bytecode.length)}`, path: `src/${name}.sol:${name}` });
}
console.log(JSON.stringify({ solc, optimizerRuns: Number(runs), evm, contracts: jobs.map((j) => ({ ...j, constructorArgs: `${j.constructorArgs.slice(0, 74)}…(${(j.constructorArgs.length - 2) / 2} bytes)` })), apply }, null, 2));
if (!apply) {
  console.log("预览完成。确认后：npm run bscscan:mainnet -- --apply");
  process.exit(0);
}

const results = [];
for (const job of jobs) {
  const result = spawnSync(`${homedir()}/.foundry/bin/forge`, [
    "verify-contract", job.address, job.path,
    "--chain", "56",
    "--constructor-args", job.constructorArgs,
    "--num-of-optimizations", runs,
    "--compiler-version", `v${solc}`,
    "--watch",
  ], { cwd: ROOT, env: cleanEnv({ ETHERSCAN_API_KEY: need(env, "BSCSCAN_API_KEY") }), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const output = redact(`${result.stdout || ""}${result.stderr || ""}`, env);
  console.log(`== ${job.name} ${job.address}\n${output}`);
  const ok = result.status === 0 && /Pass - Verified|already verified/i.test(output);
  results.push({ name: job.name, address: job.address, ok });
}
console.log(`证据 ${writeEvidence("bscscan", results)}`);
if (results.some((r) => !r.ok)) {
  console.error("有合约没有显示已验证。看上面的输出，修好后再跑一次 --apply（已验证的会跳过）。");
  process.exit(1);
}
console.log("五个合约都已在 BscScan 验证。");
