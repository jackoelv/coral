#!/usr/bin/env node
/**
 * 测试网 3/4 多签。默认只打印。--apply 才发送。
 * Gas 由 .env 的 TEST_PRIVATE_KEY 支付。签名用钱包文件 index 17、18、19，不打印私钥。
 *
 *   node scripts/multisig-testnet.mjs deploy
 *   node scripts/multisig-testnet.mjs transfer --apply
 *   node scripts/multisig-testnet.mjs accept --apply
 *   node scripts/multisig-testnet.mjs exec --signers 17,19,20 --apply
 *   node scripts/multisig-testnet.mjs replace --apply
 *   node scripts/multisig-testnet.mjs restore
 *   node scripts/multisig-testnet.mjs restore --to 0x... --apply
 *
 * --signers 选定恰好 3 个签名人，写钱包 index 或 0x 地址。省略时用 17、18、19。
 * restore 把五个合约的 owner 从多签转回某个地址：多签执行 transferOwnership，目标地址再 acceptOwnership。
 * 省略 --to 时转回 TEST_PRIVATE_KEY 对应地址。目标必须能用 TEST_PRIVATE_KEY 或钱包文件里的私钥签名。
 */
import { readFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";
import { bscTestnet } from "viem/chains";
import { readTestnetEnv, saveTestnetEnv } from "./lib/testnet-env.mjs";
import {
  MULTISIG_ABI,
  SIGNER_INDEXES,
  TEMP_SIGNER_INDEX,
  accountByIndex,
  addressByIndex,
  assertChain,
  execMultisig,
  flagValue,
  loadWalletRows,
  redact,
  replaceMultisigSigner,
  parseSignerSelection,
  resolveAddress,
  signerList,
  testnetClients,
} from "./lib/multisig-exec.mjs";

const OWNABLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function minIdo() view returns (uint256)",
  "function setMinIdo(uint256 amount)",
]);

const CONTRACTS = [
  ["CKEY", "BSC_TESTNET_CKEY"],
  ["NFT", "BSC_TESTNET_NFT"],
  ["IDO", "BSC_TESTNET_IDO"],
  ["REWARDS", "BSC_TESTNET_REWARDS"],
  ["INTEREST", "BSC_TESTNET_INTEREST"],
];

const ZERO = "0x0000000000000000000000000000000000000000";
const command = process.argv[2];
const apply = process.argv.includes("--apply");

function acceptAccountFor(rows, payer, target) {
  if (getAddress(target) === getAddress(payer.address)) return payer;
  const row = rows.find((item) => item?.address && getAddress(item.address) === getAddress(target));
  if (!row?.privateKey) return null;
  return accountByIndex(rows, row.index);
}

async function sendFrom(publicClient, from, to, data, rpc) {
  const client = createWalletClient({ account: from, chain: bscTestnet, transport: http(rpc) });
  const gas = await publicClient.estimateGas({ account: from, to, data });
  const hash = await client.sendTransaction({ to, data, gas: (gas * 3n) / 2n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`交易回滚：${hash}`);
  return receipt;
}

function artifact(name) {
  const file = new URL(`../out/${name}.sol/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function owners(publicClient) {
  const out = [];
  for (const [name, key] of CONTRACTS) {
    const address = getAddress(process.env[key] || "");
    const owner = getAddress(await publicClient.readContract({ address, abi: OWNABLE_ABI, functionName: "owner" }));
    const pending = getAddress(await publicClient.readContract({
      address,
      abi: OWNABLE_ABI,
      functionName: "pendingOwner",
    }));
    out.push({ name, key, address, owner, pending });
  }
  return out;
}

async function main() {
  const env = readTestnetEnv();
  Object.assign(process.env, env);
  const rows = loadWalletRows();
  const { account, publicClient, walletClient } = testnetClients(env);
  await assertChain(publicClient);
  const multisig = env.TESTNET_MULTISIG ? getAddress(env.TESTNET_MULTISIG) : null;

  if (command === "deploy") {
    const signers = SIGNER_INDEXES.map((index) => addressByIndex(rows, index));
    console.log(JSON.stringify({ signers, payer: account.address, apply }));
    if (!apply) {
      console.log("dry-run。确认后：node scripts/multisig-testnet.mjs deploy --apply");
      return;
    }
    const built = artifact("CoralMultisig");
    const hash = await walletClient.deployContract({
      abi: built.abi,
      bytecode: built.bytecode.object,
      args: [signers],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`多签部署失败：${hash}`);
    const deployed = getAddress(receipt.contractAddress);
    const live = await signerList(publicClient, deployed);
    if (live.some((addr, i) => addr !== signers[i])) throw new Error("链上签名人与钱包文件不一致");
    saveTestnetEnv({ TESTNET_MULTISIG: deployed });
    console.log(JSON.stringify({ multisig: deployed, tx: hash }));
    return;
  }

  if (!multisig) throw new Error("缺少 TESTNET_MULTISIG。先运行 deploy --apply");
  const indexes = parseSignerSelection(process.argv, rows);
  const signers = apply ? indexes.map((index) => accountByIndex(rows, index)) : indexes.map((index) => ({ address: addressByIndex(rows, index) }));

  if (command === "transfer") {
    const current = await owners(publicClient);
    for (const row of current) console.log(`${row.name} owner=${row.owner} pending=${row.pending}`);
    if (!apply) {
      console.log("dry-run。确认后：node scripts/multisig-testnet.mjs transfer --apply");
      return;
    }
    for (const row of current) {
      if (row.owner === multisig) {
        console.log(`${row.name} 已是多签`);
        continue;
      }
      if (row.owner !== account.address) throw new Error(`${row.name} 的 Owner 不是 TEST_PRIVATE_KEY，不能发起转移`);
      if (row.pending === multisig) {
        console.log(`${row.name} 已发起，等待 accept`);
        continue;
      }
      const data = encodeFunctionData({ abi: OWNABLE_ABI, functionName: "transferOwnership", args: [multisig] });
      const gas = await publicClient.estimateGas({ account, to: row.address, data });
      const hash = await walletClient.sendTransaction({ to: row.address, data, gas: (gas * 3n) / 2n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${row.name} transferOwnership 回滚：${hash}`);
      console.log(`${row.name} ${hash}`);
    }
    return;
  }

  if (command === "accept") {
    const current = await owners(publicClient);
    for (const row of current) console.log(`${row.name} owner=${row.owner} pending=${row.pending}`);
    if (!apply) {
      console.log("dry-run。确认后：node scripts/multisig-testnet.mjs accept --apply");
      return;
    }
    for (const row of current) {
      if (row.owner === multisig) {
        console.log(`${row.name} 已接受`);
        continue;
      }
      if (row.pending !== multisig) throw new Error(`${row.name} 的 pendingOwner 不是多签。先运行 transfer --apply`);
      const data = encodeFunctionData({ abi: OWNABLE_ABI, functionName: "acceptOwnership" });
      await execMultisig({ publicClient, walletClient, multisig, signers, target: row.address, data, apply, rows });
      const owner = getAddress(await publicClient.readContract({ address: row.address, abi: OWNABLE_ABI, functionName: "owner" }));
      if (owner !== multisig) throw new Error(`${row.name} 接受后 Owner 不是多签`);
    }
    return;
  }

  if (command === "exec") {
    const ido = getAddress(env.BSC_TESTNET_IDO);
    const owner = getAddress(await publicClient.readContract({ address: ido, abi: OWNABLE_ABI, functionName: "owner" }));
    if (owner !== multisig) throw new Error("金库 Owner 还不是多签。先完成 accept");
    const current = await publicClient.readContract({ address: ido, abi: OWNABLE_ABI, functionName: "minIdo" });
    const data = encodeFunctionData({ abi: OWNABLE_ABI, functionName: "setMinIdo", args: [current] });
    console.log(`把最低入金设成当前值 ${current}，只验证 Owner 权限，不改变规则。`);
    await execMultisig({ publicClient, walletClient, multisig, signers, target: ido, data, apply, rows });
    if (!apply) console.log("dry-run。确认后：node scripts/multisig-testnet.mjs exec --apply");
    return;
  }

  if (command === "replace") {
    const live = await signerList(publicClient, multisig);
    const outgoing = addressByIndex(rows, SIGNER_INDEXES[3]);
    const incoming = addressByIndex(rows, TEMP_SIGNER_INDEX);
    console.log(JSON.stringify({ live, outgoing, incoming }));
    if (!live.includes(outgoing)) throw new Error("index 20 不在当前签名人里，拒绝替换");
    if (!apply) {
      console.log("dry-run。--apply 会把 index 20 换成 index 16，再用 17、18、19 换回来。");
      return;
    }
    await replaceMultisigSigner({
      publicClient, walletClient, multisig, signers, oldSigner: outgoing, next: incoming, apply, rows,
    });
    const mid = await signerList(publicClient, multisig);
    if (!mid.includes(incoming) || mid.includes(outgoing)) throw new Error("换入后签名人名单不对");
    await replaceMultisigSigner({
      publicClient, walletClient, multisig, signers, oldSigner: incoming, next: outgoing, apply, rows,
    });
    const restored = await signerList(publicClient, multisig);
    const expected = SIGNER_INDEXES.map((index) => addressByIndex(rows, index));
    if (restored.some((addr, i) => addr !== expected[i])) throw new Error(`换回后签名人不是 17-20：${restored.join(",")}`);
    console.log("签名人已换出并换回。当前仍是 index 17、18、19、20。");
    return;
  }

  if (command === "restore") {
    const toToken = flagValue(process.argv, "to");
    const target = toToken ? resolveAddress(rows, toToken, "to") : account.address;
    if (target === multisig) throw new Error("目标不能是多签合约");
    if (target === ZERO) throw new Error("目标不能是零地址");
    const acceptor = acceptAccountFor(rows, account, target);
    const live = await signerList(publicClient, multisig);
    const chosen = signers.map((item) => getAddress(item.address));
    for (const addr of chosen) {
      if (!live.includes(addr)) throw new Error(`${addr} 不是当前多签签名人`);
    }
    const current = await owners(publicClient);
    console.log(JSON.stringify({
      target,
      acceptor: acceptor ? acceptor.address : null,
      signers: chosen,
      apply,
    }));
    for (const row of current) console.log(`${row.name} owner=${row.owner} pending=${row.pending}`);
    for (const row of current) {
      if (row.owner !== multisig && row.owner !== target) {
        throw new Error(`${row.name} 的 Owner 既不是多签也不是目标地址，拒绝转回`);
      }
    }
    if (!acceptor) {
      throw new Error("目标地址没有可用私钥。用 TEST_PRIVATE_KEY 对应地址，或钱包文件里带私钥的 index / 地址");
    }
    if (!apply) {
      const toFlag = toToken ? ` --to ${toToken}` : "";
      console.log(`dry-run。确认后：node scripts/multisig-testnet.mjs restore${toFlag} --apply`);
      console.log("多签会执行 transferOwnership，随后目标地址自己调用 acceptOwnership。");
      return;
    }
    for (const row of current) {
      if (row.owner === target) {
        console.log(`${row.name} 已是目标地址`);
        continue;
      }
      if (row.pending !== target) {
        const data = encodeFunctionData({ abi: OWNABLE_ABI, functionName: "transferOwnership", args: [target] });
        await execMultisig({ publicClient, walletClient, multisig, signers, target: row.address, data, apply, rows });
      }
      const pending = getAddress(await publicClient.readContract({
        address: row.address,
        abi: OWNABLE_ABI,
        functionName: "pendingOwner",
      }));
      if (pending !== target) throw new Error(`${row.name} 的 pendingOwner 不是目标地址`);
      const data = encodeFunctionData({ abi: OWNABLE_ABI, functionName: "acceptOwnership" });
      const receipt = await sendFrom(publicClient, acceptor, row.address, data, env.BSC_TESTNET_RPC);
      const owner = getAddress(await publicClient.readContract({
        address: row.address,
        abi: OWNABLE_ABI,
        functionName: "owner",
      }));
      if (owner !== target) throw new Error(`${row.name} 接受后 Owner 不是目标地址`);
      console.log(`${row.name} 已转回 ${receipt.transactionHash}`);
    }
    return;
  }

  throw new Error("命令是 deploy、transfer、accept、exec、replace 或 restore");
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || error, loadWalletRows()));
  process.exit(1);
});
