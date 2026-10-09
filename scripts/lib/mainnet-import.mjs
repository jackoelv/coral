import { getAddress, zeroAddress } from "viem";
import { codeToBytes32 } from "./tree.mjs";
import { nftsOwed } from "./mainnet.mjs";

export const NFT_CAP = 10_000n;

/** Checks the export before anything goes on chain. Returns totals and every problem found. */
export function analyzeImport(records) {
  const errors = [];
  const byWallet = new Map();
  const codes = new Map();
  let totalWei = 0n;
  let totalNfts = 0n;
  for (const row of records) {
    let wallet;
    try {
      wallet = getAddress(row.wallet);
    } catch {
      errors.push(`钱包地址无效：${row.wallet}`);
      continue;
    }
    if (byWallet.has(wallet)) errors.push(`钱包重复：${wallet}`);
    byWallet.set(wallet, row);
    try {
      const code = codeToBytes32(row.inviteCode);
      if (codes.has(code)) errors.push(`邀请码重复：${row.inviteCode}（${codes.get(code)} 和 ${wallet}）`);
      codes.set(code, wallet);
    } catch (error) {
      errors.push(`${wallet} 邀请码不合格（只允许大写 A-Z0-9，最长 32 位）：${row.inviteCode}`);
    }
    const self = BigInt(row.selfWei || 0);
    totalWei += self;
    totalNfts += nftsOwed(self);
  }
  for (const [wallet, row] of byWallet) {
    if (!row.referrer) continue;
    const referrer = getAddress(row.referrer);
    if (referrer === wallet) errors.push(`${wallet} 的上级是自己`);
    else if (!byWallet.has(referrer)) errors.push(`${wallet} 的上级 ${referrer} 不在导入名单里`);
  }
  const depth = depths(byWallet, errors);
  if (totalNfts > NFT_CAP) errors.push(`导入应占 NFT ${totalNfts} 张，超过总量 ${NFT_CAP}`);
  return { count: byWallet.size, totalWei, totalNfts, maxDepth: Math.max(0, ...depth.values()), depth, errors };
}

function depths(byWallet, errors) {
  const depth = new Map();
  for (const start of byWallet.keys()) {
    const path = [];
    let cur = start;
    while (cur && !depth.has(cur)) {
      if (path.includes(cur)) {
        errors.push(`邀请关系成环：${[...path.slice(path.indexOf(cur)), cur].join(" -> ")}`);
        for (const w of path) depth.set(w, 0);
        break;
      }
      path.push(cur);
      const ref = byWallet.get(cur)?.referrer;
      cur = ref ? getAddress(ref) : null;
      if (cur && !byWallet.has(cur)) cur = null;
    }
    let base = cur && depth.has(cur) ? depth.get(cur) + 1 : 0;
    for (let i = path.length - 1; i >= 0; i--) {
      if (!depth.has(path[i])) depth.set(path[i], base);
      base = depth.get(path[i]) + 1;
    }
  }
  return depth;
}

/**
 * Compares the file with chain state and returns only what is still missing.
 * `chain` maps wallet -> { registered, inviteCode, referrer, selfVolume }.
 * Anything already on chain but different from the file is a conflict, not an overwrite.
 */
export function pendingImport(records, chain, depth) {
  const users = [];
  const referrers = [];
  const volumes = [];
  const conflicts = [];
  for (const row of records) {
    const wallet = getAddress(row.wallet);
    const code = codeToBytes32(row.inviteCode);
    const state = chain.get(wallet);
    if (!state?.registered) users.push({ wallet, code });
    else if (state.inviteCode.toLowerCase() !== code.toLowerCase()) conflicts.push(`${wallet} 链上邀请码和文件不同`);
    if (row.referrer) {
      const expected = getAddress(row.referrer);
      const current = state?.referrer ? getAddress(state.referrer) : zeroAddress;
      if (current === zeroAddress) referrers.push({ wallet, referrer: expected, depth: depth.get(wallet) ?? 0 });
      else if (current !== expected) conflicts.push(`${wallet} 链上上级 ${current}，文件里是 ${expected}`);
    }
    const self = BigInt(row.selfWei || 0);
    if (self !== (state?.selfVolume ?? 0n)) volumes.push({ wallet, selfWei: self });
  }
  // An account cannot bind a referrer once it has children, so bind top-down.
  referrers.sort((x, y) => x.depth - y.depth);
  return { users, referrers, volumes, conflicts };
}

/** Full comparison after import. Returns mismatches; empty means the chain equals the file. */
export function verifyImported(records, chain, codeOwners) {
  const problems = [];
  for (const row of records) {
    const wallet = getAddress(row.wallet);
    const state = chain.get(wallet);
    const code = codeToBytes32(row.inviteCode);
    if (!state?.registered) { problems.push(`${wallet} 未注册`); continue; }
    if (state.inviteCode.toLowerCase() !== code.toLowerCase()) problems.push(`${wallet} 邀请码不符`);
    if ((codeOwners.get(code.toLowerCase()) || zeroAddress) !== wallet) problems.push(`${row.inviteCode} 的 codeToAccount 不是 ${wallet}`);
    const expectedRef = row.referrer ? getAddress(row.referrer) : zeroAddress;
    if (getAddress(state.referrer || zeroAddress) !== expectedRef) problems.push(`${wallet} 上级不符`);
    if (state.selfVolume !== BigInt(row.selfWei || 0)) problems.push(`${wallet} 本人业绩不符`);
  }
  return problems;
}
