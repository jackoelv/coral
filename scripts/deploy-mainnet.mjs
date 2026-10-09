#!/usr/bin/env node
/**
 * Deploys the five Nemo contracts to BSC mainnet with the one-time deployer key.
 * Default: read-only checks and a forge simulation (no broadcast).
 * --apply: type 56 to confirm, broadcast, verify on chain, write addresses back to .env.mainnet.
 * --sync: deployment already succeeded, only the write-back failed. Re-read broadcast and write back.
 *
 * The deployer stays Owner of all five contracts until handover:mainnet.
 *
 *   npm run deploy:mainnet
 *   npm run deploy:mainnet -- --apply
 *   npm run deploy:mainnet -- --sync
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatEther, getAddress, parseAbi, zeroAddress } from "viem";
import { creationReceipt, validateCreation } from "./lib/deployment-receipt.mjs";
import {
  CONTRACT_KEYS,
  CONTRACT_NAMES,
  ROOT,
  USDT,
  cleanEnv,
  confirmTyped,
  deployerAccount,
  mainnetClient,
  need,
  readMainnetEnv,
  redact,
  roles,
  saveMainnetEnv,
  writeEvidence,
} from "./lib/mainnet.mjs";

const apply = process.argv.includes("--apply");
const syncOnly = process.argv.includes("--sync");
if (apply && syncOnly) throw new Error("--apply 和 --sync 不能同时用");
const ARTIFACT = resolve(ROOT, "broadcast/Deploy.s.sol/56/run-latest.json");
const forge = `${homedir()}/.foundry/bin/forge`;

const env = readMainnetEnv();
const client = await mainnetClient(env);
const account = deployerAccount(env);
const { deployer, owner, publisher } = roles(env);
const imageUri = need(env, "NFT_IMAGE_URI");
if (!imageUri.startsWith("https://")) throw new Error("NFT_IMAGE_URI 必须是 https 地址");

const already = CONTRACT_KEYS.filter((k) => env[`BSC_MAINNET_${k}`]);
if (already.length && !syncOnly) {
  throw new Error(`.env.mainnet 已有 ${already.map((k) => `BSC_MAINNET_${k}`).join(", ")}。不要再部署一套；部署成功只是写回失败时用 --sync`);
}

function forgeEnv() {
  return cleanEnv({
    NETWORK: "bscMainnet",
    ALLOW_MAINNET: "true",
    MAINNET_PRIVATE_KEY: need(env, "MAINNET_PRIVATE_KEY"),
    OWNER: deployer,
    NFT_IMAGE_URI: imageUri,
    FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
  });
}

function runForge(extra) {
  const result = spawnSync(forge, ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", need(env, "BSC_MAINNET_RPC"), ...extra, "-vv"], {
    cwd: ROOT,
    env: forgeEnv(),
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const output = redact(`${result.stdout || ""}${result.stderr || ""}`, env);
  return { ok: !result.error && result.status === 0, output };
}

async function preview() {
  const [nonce, balance, usdtCode, gasPrice] = await Promise.all([
    client.getTransactionCount({ address: deployer }),
    client.getBalance({ address: deployer }),
    client.getCode({ address: USDT }),
    client.getGasPrice(),
  ]);
  const decimals = await client.readContract({ address: USDT, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  let image = { status: 0, type: "" };
  try {
    const r = await fetch(imageUri, { method: "HEAD", redirect: "follow" });
    image = { status: r.status, type: r.headers.get("content-type") || "" };
  } catch (error) {
    image = { status: 0, type: error.message };
  }
  const checks = {
    chainId: 56,
    deployer,
    owner,
    publisher: publisher || "(未填，第 9 节前必须填)",
    deployerNonce: nonce,
    deployerBnb: formatEther(balance),
    gasPriceGwei: Number(gasPrice) / 1e9,
    usdt: USDT,
    usdtHasCode: Boolean(usdtCode && usdtCode !== "0x"),
    usdtDecimals: decimals,
    nftImage: { uri: imageUri, ...image },
  };
  console.log(JSON.stringify(checks, null, 2));
  if (nonce !== 0) throw new Error(`部署账户 nonce 是 ${nonce}，不是全新地址。查清楚是否已经部署过`);
  if (!checks.usdtHasCode || decimals !== 18) throw new Error("官方 USDT 地址没有字节码或不是 18 位");
  if (image.status !== 200) console.warn(`警告：NFT 图片 HTTP ${image.status}。可以先部署，但第 12 节移交前必须让它返回 200。`);
  if (new URL(imageUri).host === "test.freedao.life") console.warn("NFT 图片暂时用 test.freedao.life。正式站上线后改成 www.freedao.life 的地址，再跑 nft-image:mainnet。");
  if (!/^[1-9]\d*$/.test((env.MAX_ROOT_INCREASE_WEI || "").trim())) console.warn("MAX_ROOT_INCREASE_WEI 还没填。部署不用这个值；跑 publisher:mainnet 之前必须填一个大于 0 的 wei。");

  console.log("forge 模拟部署（不广播）…");
  const sim = runForge([]);
  console.log(sim.output);
  if (!sim.ok) throw new Error("forge 模拟失败，未广播");
  const estimate = sim.output.match(/Estimated amount required:\s*([\d.]+)/);
  const required = estimate ? Number(estimate[1]) : null;
  console.log(JSON.stringify({ estimatedBnb: required, recommendTransferBnb: required ? (required * 2).toFixed(6) : null, deployerBnb: formatEther(balance) }, null, 2));
  return { balance, required };
}

async function broadcast() {
  const { balance, required } = await preview();
  if (required === null) throw new Error("没读到 forge 的 gas 估算，停止");
  if (Number(formatEther(balance)) < required * 1.2) throw new Error(`部署账户 BNB 不够：有 ${formatEther(balance)}，估算 ${required}，至少要 1.2 倍`);
  await confirmTyped("56", `即将在 BSC 主网（chainId 56）用 ${deployer} 部署五个合约，花真实 BNB。`);
  const started = Date.now();
  const run = runForge(["--broadcast", "--slow"]);
  console.log(run.output);
  if (!run.ok) throw new Error("广播没有全部成功，.env.mainnet 未更新。不要重复 --apply。先查 broadcast/Deploy.s.sol/56/run-latest.json 和部署账户 nonce");
  if (statSync(ARTIFACT).mtimeMs < started) throw new Error("没找到本次部署记录，拒绝使用旧地址");
}

async function sync() {
  if (!existsSync(ARTIFACT)) throw new Error(`没有 ${ARTIFACT}`);
  const run = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  if (Number(run.chain) !== 56) throw new Error("部署记录不是 chain 56");
  if (!run.receipts?.length || run.receipts.some((r) => BigInt(r.status) !== 1n)) throw new Error("部署记录里有失败或缺失的回执");
  if (run.transactions.some((t) => t.contractName === "MockUSDT")) throw new Error("主网部署不应出现 MockUSDT");
  const a = {};
  const blocks = [];
  for (const key of CONTRACT_KEYS) {
    const name = CONTRACT_NAMES[key];
    const creates = run.transactions.filter((t) => t.contractName === name && t.transactionType === "CREATE");
    if (creates.length !== 1) throw new Error(`${name} 的部署记录必须恰好一条`);
    const tx = creates[0];
    if (getAddress(tx.transaction.from) !== deployer) throw new Error(`${name} 不是部署账户发的`);
    const record = creationReceipt(run, tx);
    const live = await client.getTransactionReceipt({ hash: record.transactionHash });
    validateCreation(tx, await client.getTransaction({ hash: record.transactionHash }), live);
    a[key] = getAddress(tx.contractAddress);
    blocks.push(live.blockNumber);
  }
  const r = (key, fn, type = "address") => client.readContract({ address: a[key], abi: parseAbi([`function ${fn}() view returns (${type})`]), functionName: fn });
  const failures = [];
  const expect = (name, actual, expected) => {
    const ok = typeof actual === "string" ? actual.toLowerCase() === String(expected).toLowerCase() : actual === expected;
    if (!ok) failures.push(`${name}: ${actual} != ${expected}`);
  };
  expect("IDO.usdt", await r("IDO", "usdt"), USDT);
  if (await r("CKEY", "name", "string") !== "Ckey") failures.push("CKEY.name metadata mismatch");
  if (await r("CKEY", "symbol", "string") !== "CKEY") failures.push("CKEY.symbol metadata mismatch");
  if (await r("NFT", "name", "string") !== "FreeDaoRWA") failures.push("NFT.name metadata mismatch");
  if (await r("NFT", "symbol", "string") !== "FREEDAONFT") failures.push("NFT.symbol metadata mismatch");
  expect("IDO.nemo", await r("IDO", "nemo"), a.CKEY);
  expect("IDO.nft", await r("IDO", "nft"), a.NFT);
  expect("IDO.rewards", await r("IDO", "rewards"), a.REWARDS);
  expect("IDO.nftInterest", await r("IDO", "nftInterest"), a.INTEREST);
  expect("CKEY.minter", await r("CKEY", "minter"), a.IDO);
  expect("NFT.minter", await r("NFT", "minter"), a.IDO);
  expect("CKEY.interestMinter", await r("CKEY", "interestMinter"), a.INTEREST);
  expect("REWARDS.vault", await r("REWARDS", "vault"), a.IDO);
  expect("INTEREST.vault", await r("INTEREST", "vault"), a.IDO);
  for (const key of CONTRACT_KEYS) {
    expect(`${key}.owner`, await r(key, "owner"), deployer);
    expect(`${key}.pendingOwner`, await r(key, "pendingOwner"), zeroAddress);
  }
  expect("IDO.rewardsDelay", await r("IDO", "rewardsDelay", "uint256"), 86400n);
  expect("IDO.weekDuration", await r("IDO", "weekDuration", "uint256"), 604800n);
  expect("IDO.weekByBlock", await r("IDO", "weekByBlock", "bool"), false);
  expect("IDO.saleOpen", await r("IDO", "saleOpen", "bool"), false);
  expect("IDO.importFrozen", await r("IDO", "importFrozen", "bool"), false);
  expect("INTEREST.calendarWeeks", await r("INTEREST", "calendarWeeks", "bool"), true);
  expect("INTEREST.FIRST_SUNDAY_BEIJING", await r("INTEREST", "FIRST_SUNDAY_BEIJING", "uint256"), 230400n);
  expect("NFT.imageURI", await r("NFT", "imageURI", "string"), imageUri);
  if (failures.length) {
    console.error(failures.join("\n"));
    throw new Error("链上参数或关联不对，.env.mainnet 未更新");
  }
  const block = blocks.reduce((x, y) => (x < y ? x : y)).toString();
  const updates = {
    ...Object.fromEntries(CONTRACT_KEYS.map((key) => [`BSC_MAINNET_${key}`, a[key]])),
    INDEX_START_BLOCK: block,
    START_BLOCK: block,
    IDO_ADDRESS: a.IDO,
    REWARDS_ADDRESS: a.REWARDS,
    RPC_URL: need(env, "BSC_MAINNET_RPC"),
  };
  saveMainnetEnv(updates);
  const evidence = writeEvidence("deploy", { addresses: a, startBlock: block, deployer, broadcast: ARTIFACT });
  console.log(JSON.stringify({ addresses: a, startBlock: block, evidence }, null, 2));
  console.log("五个合约 Owner 都是部署账户。下一步：npm run verify:mainnet -- --stage deployed");
}

if (!apply && !syncOnly) {
  await preview();
  console.log("预览完成，没有广播。确认后：npm run deploy:mainnet -- --apply");
} else {
  if (apply) await broadcast();
  await sync();
}
