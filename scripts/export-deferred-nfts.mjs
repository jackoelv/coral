#!/usr/bin/env node
/**
 * 导出本期达到 NFT 上限后「待下一期发放」的张数，作为下一期导入和 grantNft 的名单。
 * 在 closeSale 之后的某个区块做快照，任何人用同一个区块重跑都应得到同一份文件。
 *
 *   RPC_URL=... IDO_ADDRESS=0x... [SNAPSHOT_BLOCK=12345] [START_BLOCK=0] \
 *     node scripts/export-deferred-nfts.mjs > deferred.json
 */
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem } from "viem";

const need = ["RPC_URL", "IDO_ADDRESS"].filter((name) => !process.env[name]);
if (need.length) {
  console.error(`未导出：缺少 ${need.join(", ")}。`);
  process.exit(0);
}

const ido = getAddress(process.env.IDO_ADDRESS);
const client = createPublicClient({ transport: http(process.env.RPC_URL) });
const snapshot = process.env.SNAPSHOT_BLOCK ? BigInt(process.env.SNAPSHOT_BLOCK) : await client.getBlockNumber();
const start = BigInt(process.env.START_BLOCK ?? 0);
const chunk = BigInt(process.env.CHUNK_BLOCKS ?? 5000);
const event = parseAbiItem("event NftDeferred(address indexed account, uint256 totalDeferred)");
const abi = parseAbi([
  "function nftDeferred(address) view returns (uint256)",
  "function getAccount(address) view returns ((address referrer, bytes32 inviteCode, uint256 selfVolume, uint256 directRewards, uint256 claimed, bool registered))",
]);

const wallets = new Set();
for (let from = start; from <= snapshot; from += chunk) {
  const to = from + chunk - 1n > snapshot ? snapshot : from + chunk - 1n;
  const logs = await client.getLogs({ address: ido, event, fromBlock: from, toBlock: to });
  for (const log of logs) wallets.add(getAddress(log.args.account));
}

const entries = [];
let total = 0n;
for (const wallet of [...wallets].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
  const [count, account] = await Promise.all([
    client.readContract({ address: ido, abi, functionName: "nftDeferred", args: [wallet], blockNumber: snapshot }),
    client.readContract({ address: ido, abi, functionName: "getAccount", args: [wallet], blockNumber: snapshot }),
  ]);
  if (count === 0n) continue;
  total += count;
  entries.push({ wallet, referrer: account.referrer, selfVolumeWei: account.selfVolume.toString(), deferred: Number(count) });
}

console.log(
  JSON.stringify(
    { chainId: await client.getChainId(), ido, snapshotBlock: snapshot.toString(), totalDeferred: total.toString(), entries },
    null,
    2,
  ),
);
