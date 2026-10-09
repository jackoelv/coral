import { createPublicClient, http, keccak256, parseAbi, parseAbiItem, toBytes, zeroHash } from "viem";
import { isArchiveLogRpc, isGetLogsLimit, isLogRpcTimeout, MAINNET_LOG_RPCS, MAINNET_LOG_SPAN } from "./reward-index.mjs";

const ROOT_PUBLISHED = parseAbiItem("event RootPublished(bytes32 indexed root, bytes32 contentHash, uint256 cumulative, string uri)");
const LOOKBACK = 400_000n;

/** Don't scan the whole chain. Stay inside the deploy window, and never look back more than 400k blocks. */
export function publicationSearchFloor(head, startBlock) {
  const cap = head > LOOKBACK ? head - LOOKBACK : 0n;
  if (startBlock == null || startBlock <= 0n) return cap;
  return startBlock > cap ? startBlock : cap;
}

/** Shanghai wall time of a block timestamp. */
export function formatShanghai(unixSeconds) {
  if (unixSeconds == null) return null;
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Number(unixSeconds) * 1000));
  return `${formatted} +08`;
}

function sameHex(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/**
 * Chain storage against the root just built from the database.
 * `leaves` is compared only when the chain URI file could be read.
 */
export function compareRootPublication({ chain, next }) {
  const published = !sameHex(chain.root, zeroHash);
  const fields = {
    root: published && sameHex(chain.root, next.root),
    contentHash: published && sameHex(chain.contentHash, next.contentHash),
    cumulative: published && String(chain.cumulative) === String(next.cumulative),
  };
  if (chain.leaves != null && next.leaves != null) fields.leaves = chain.leaves === next.leaves;
  const same = fields.root && fields.contentHash && fields.cumulative && fields.leaves !== false;
  return { published, fields, same };
}

/** Leaf count from a public file, only when its content hash matches the chain. */
export function leavesFromDocument(doc, expectedContentHash) {
  if (!doc || !Array.isArray(doc.entries)) return { leaves: null, uriNote: "明细文件没有 entries" };
  const contentHash = keccak256(toBytes(JSON.stringify(doc.entries)));
  if (expectedContentHash && !sameHex(contentHash, expectedContentHash)) {
    return { leaves: null, uriNote: "明细文件的 contentHash 和链上不一致，不拿来对比" };
  }
  return { leaves: doc.entries.length, uriNote: null };
}

/**
 * Current root stored on the rewards contract, plus the RootPublished time.
 * Log queries use the endpoints that actually serve BSC historical eth_getLogs.
 */
export async function readOnchainPublication({ client, rpc, address, startBlock = 0n, fetchImpl = globalThis.fetch }) {
  const abi = parseAbi([
    "function merkleRoot() view returns (bytes32)",
    "function contentHash() view returns (bytes32)",
    "function committed() view returns (uint256)",
    "function contentUri() view returns (string)",
  ]);
  const [root, contentHash, committed, contentUri] = await Promise.all(
    ["merkleRoot", "contentHash", "committed", "contentUri"].map((functionName) => client.readContract({ address, abi, functionName })),
  );
  const chain = {
    root,
    contentHash,
    cumulative: committed,
    contentUri: contentUri || "",
    leaves: null,
    publishedAt: null,
    blockNumber: null,
    txHash: null,
    uriNote: null,
    timeNote: null,
  };
  if (sameHex(root, zeroHash)) {
    chain.timeNote = "链上还没有 root";
    return chain;
  }
  const uri = await describeUri(contentUri, contentHash, fetchImpl);
  chain.leaves = uri.leaves;
  chain.uriNote = uri.uriNote;
  try {
    const head = await client.getBlockNumber();
    const floor = publicationSearchFloor(head, startBlock);
    const found = await findPublicationLog({ rpc, address, root, head, floor });
    if (!found) {
      chain.timeNote = `从区块 ${floor} 到 ${head} 没有查到和当前 root 对应的 RootPublished`;
      return chain;
    }
    const block = await client.getBlock({ blockNumber: found.blockNumber });
    chain.publishedAt = formatShanghai(block.timestamp);
    chain.blockNumber = found.blockNumber;
    chain.txHash = found.transactionHash;
    if (found.newerMismatch) chain.timeNote = "比这笔更新的日志 root 和链上存储不一致";
  } catch (error) {
    chain.timeNote = `没有查到发布时间：${error.shortMessage || error.message || error}`;
  }
  return chain;
}

async function describeUri(uri, contentHash, fetchImpl) {
  if (!uri) return { leaves: null, uriNote: "链上没有 contentUri，只对比 root、contentHash 和累计金额" };
  if (!/^https?:\/\//i.test(uri)) return { leaves: null, uriNote: "contentUri 不是 http(s) 链接，链上没有可读取的叶子明细" };
  try {
    const response = await fetchImpl(uri, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { leaves: null, uriNote: `明细文件 HTTP ${response.status}` };
    return leavesFromDocument(await response.json(), contentHash);
  } catch (error) {
    return { leaves: null, uriNote: `读不到链上明细：${error.message || error}` };
  }
}

async function findPublicationLog({ rpc, address, root, head, floor }) {
  const urls = [...new Set([...MAINNET_LOG_RPCS, rpc].filter(Boolean))];
  let lastError = null;
  for (const url of urls) {
    const logClient = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000 }) });
    try {
      if ((await logClient.getChainId()) !== 56) continue;
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      return await scanBackward(logClient, address, root, head, floor);
    } catch (error) {
      lastError = error;
      if (isArchiveLogRpc(error) || isLogRpcTimeout(error)) continue;
      throw error;
    }
  }
  throw lastError ?? new Error("没有节点能查询 RootPublished");
}

async function scanBackward(logClient, address, root, head, floor) {
  let cursor = head;
  let newerMismatch = false;
  while (cursor >= floor) {
    const from = cursor - MAINNET_LOG_SPAN + 1n < floor ? floor : cursor - MAINNET_LOG_SPAN + 1n;
    const logs = await logsInWindow(logClient, address, from, cursor);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber < b.blockNumber ? 1 : -1));
    for (const log of logs) {
      if (sameHex(log.args.root, root)) {
        return { blockNumber: log.blockNumber, transactionHash: log.transactionHash, newerMismatch };
      }
      newerMismatch = true;
    }
    if (from === floor) break;
    cursor = from - 1n;
  }
  return null;
}

async function logsInWindow(logClient, address, fromBlock, toBlock, depth = 0) {
  try {
    return await logClient.getLogs({ address, event: ROOT_PUBLISHED, fromBlock, toBlock });
  } catch (error) {
    if (isGetLogsLimit(error) && toBlock > fromBlock && depth < 8) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [
        ...(await logsInWindow(logClient, address, fromBlock, mid, depth + 1)),
        ...(await logsInWindow(logClient, address, mid + 1n, toBlock, depth + 1)),
      ];
    }
    throw error;
  }
}
