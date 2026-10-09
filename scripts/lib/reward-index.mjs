import { getAddress } from "viem";
import { bind, contribute, createState, noteImportedSelf, tiersForBlock } from "./team-reward.mjs";

function addr(value) {
  if (!value || value === "0x0000000000000000000000000000000000000000") return null;
  return getAddress(value);
}

function key(account) {
  return getAddress(account);
}

/**
 * Replay one decoded vault/rewards log into calculator state.
 * Import volumes set self and add that amount to every ancestor's umbrella.
 * They do not pay direct or team rewards. Rewards start on later deposits.
 * `claimed` is filled from TeamClaimed and is not part of the calculator.
 */
export function applyLog(state, log) {
  const name = log.eventName;
  if (name === "Registered" || name === "UserImported") {
    const account = key(log.args.account);
    if (!state.referrer.has(account)) bind(state, account, null);
    const referrer = name === "Registered" ? addr(log.args.referrer) : null;
    if (referrer) bind(state, account, referrer);
    return;
  }
  if (name === "ReferrerBound" || name === "ReferrerImported") {
    bind(state, key(log.args.account), addr(log.args.referrer));
    return;
  }
  if (name === "VolumeImported") {
    const account = key(log.args.account);
    if (!state.referrer.has(account)) bind(state, account, null);
    noteImportedSelf(state, account, log.args.selfVolume);
    return;
  }
  if (name === "Contributed") {
    const account = key(log.args.account);
    if (!state.referrer.has(account)) bind(state, account, null);
    contribute(state, account, BigInt(log.args.amount), {
      tiers: tiersForBlock(log.blockNumber, state.tierSwitchBlock),
    });
    return;
  }
  if (name === "TeamClaimed") {
    const account = key(log.args.account);
    const cumulative = BigInt(log.args.cumulative);
    const prev = state.claimed.get(account) ?? 0n;
    if (cumulative > prev) state.claimed.set(account, cumulative);
  }
}

export function emptyIndexState() {
  const state = createState();
  state.claimed = new Map();
  return state;
}

export function accountRows(state) {
  const wallets = new Set([
    ...state.self.keys(),
    ...state.team.keys(),
    ...state.referrer.keys(),
    ...state.teamRewards.keys(),
    ...state.direct.keys(),
    ...state.claimed.keys(),
  ]);
  return [...wallets].map((wallet) => ({
    wallet,
    referrer: state.referrer.get(wallet) || null,
    selfWei: state.self.get(wallet) ?? 0n,
    teamWei: state.team.get(wallet) ?? 0n,
    teamRewardWei: state.teamRewards.get(wallet) ?? 0n,
    directWei: state.direct.get(wallet) ?? 0n,
    claimedWei: state.claimed.get(wallet) ?? 0n,
  }));
}

export function sortLogs(logs) {
  return logs.slice().sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/**
 * Older chain-56 log nodes, tried after the configured RPC.
 * Free PublicNode and 1rpc stay off this list: historical eth_getLogs failed there.
 * Binance dataseed often rejects eth_getLogs, so it is only a fallback.
 */
export const MAINNET_LOG_RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://rpc-bsc.48.club",
  "https://bsc.rpc.blxrbdn.com",
];
export const MAINNET_LOG_SPAN = 5000n;

/** Host only. A path token is never printed. */
export function rpcLabel(url) {
  try {
    const parsed = new URL(url);
    const token = parsed.pathname.replace(/^\//, "");
    if (!token) return parsed.host;
    return `${parsed.host}（令牌 …${token.slice(-4)}）`;
  } catch {
    return "未知节点";
  }
}

export function redactRpcSecrets(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'<>]*publicnode\.com\/[A-Za-z0-9]+/gi, (url) => rpcLabel(url));
}

export function rpcErrorText(error) {
  const text = [error?.shortMessage, error?.details, error?.message, error?.cause?.details, error?.cause?.message]
    .filter(Boolean)
    .join(" | ");
  return redactRpcSecrets(text || String(error));
}

/** Prints the node and the error, then the caller tries the next node. */
export function logRpcFailure(prefix, url, error) {
  console.error(`${prefix} 节点失败 ${rpcLabel(url)}：${rpcErrorText(error)}。将尝试下一个节点。`);
  const stack = redactRpcSecrets(error?.stack || "");
  if (stack) console.error(stack);
}

/** Primary first. Extra log endpoints only on BSC mainnet, so a testnet index never reads chain 56. */
export function logRpcCandidates(chainId, primary) {
  const extra = Number(chainId) === 56 ? MAINNET_LOG_RPCS : [];
  return [...new Set([primary, ...extra].filter(Boolean))];
}

function logErrorText(error) {
  return `${error?.details || ""} ${error?.shortMessage || ""} ${error?.message || ""} ${error?.cause?.details || ""} ${error?.cause?.message || ""}`;
}

/** True when the range should be split: Binance -32005, or a node that caps eth_getLogs block span. */
export function isGetLogsLimit(error) {
  const text = logErrorText(error);
  return error?.code === -32005 || error?.name === "LimitExceededRpcError" || /limit exceeded/i.test(text) || /exceed maximum block range/i.test(text) || /limited to \d+ - \d+ blocks/i.test(text);
}

/** PublicNode and similar nodes reject historical logs instead of returning them. Splitting the range does not help. */
export function isArchiveLogRpc(error) {
  return /archive requests require|personal token|method eth_getLogs is not supported/i.test(logErrorText(error));
}

export function isLogRpcTimeout(error) {
  return error?.name === "TimeoutError" || /timed out|took too long/i.test(logErrorText(error));
}

/** Inclusive windows. Mainnet log nodes reject spans above MAINNET_LOG_SPAN, so a checkpoint chunk is queried in pieces. */
export function logQueryWindows(chainId, fromBlock, toBlock) {
  const span = Number(chainId) === 56 ? MAINNET_LOG_SPAN : toBlock - fromBlock + 1n;
  const windows = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += span) {
    const end = cursor + span - 1n;
    windows.push({ from: cursor, to: end > toBlock ? toBlock : end });
  }
  return windows;
}

/** Next inclusive block range. `lastBlock === null` means no checkpoint yet, so start at `startBlock`. */
export function planChunk({ lastBlock, startBlock, safeHead, chunkBlocks }) {
  const from = lastBlock == null ? startBlock : lastBlock + 1n;
  if (from > safeHead) return null;
  const size = chunkBlocks < 1n ? 1n : chunkBlocks;
  const end = from + size - 1n > safeHead ? safeHead : from + size - 1n;
  return { from, end };
}

/** Whole seconds, for progress lines. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/**
 * One progress line after a chunk is saved.
 * ETA uses blocks finished in this run divided by wall time, so it includes RPC and database writes.
 */
export function formatIndexProgress({ origin, safeHead, doneBlock, chunkLogs, totalLogs, startedAt, now }) {
  const span = safeHead >= origin ? safeHead - origin + 1n : 0n;
  const rawDone = doneBlock >= origin ? doneBlock - origin + 1n : 0n;
  const done = rawDone > span ? span : rawDone;
  const percent = span === 0n ? 100 : Number((done * 1000n) / span) / 10;
  const elapsed = Math.max(0, now - startedAt);
  const left = safeHead > doneBlock ? safeHead - doneBlock : 0n;
  let eta = "计算中";
  if (left === 0n) eta = "0秒";
  else if (elapsed > 0 && done > 0n) eta = formatDuration((elapsed * Number(left)) / Number(done));
  return `进度 ${doneBlock}/${safeHead} ${percent.toFixed(1)}%  本段 ${chunkLogs} 条  累计 ${totalLogs} 条  已用 ${formatDuration(elapsed)}  预计剩余 ${eta}`;
}
