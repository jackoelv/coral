/** Invite-tree helpers for FreeDao → CoralIdo import. */

export function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

export function codeToBytes32(code) {
  const s = normalizeCode(code);
  if (!s || s.length > 32) {
    throw new Error(`invalid invite code length: ${code}`);
  }
  if (!/^[A-Z0-9]+$/.test(s)) {
    throw new Error(`invalid invite code chars: ${code}`);
  }
  const buf = Buffer.alloc(32);
  buf.write(s, "ascii");
  return `0x${buf.toString("hex")}`;
}

export function toWei(usdtInt) {
  return BigInt(usdtInt) * 10n ** 18n;
}

export function checksumWallet(addr) {
  if (!addr || typeof addr !== "string") return null;
  const a = addr.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;
  return a;
}

/**
 * @param {Array<{id: string, wallet: string, inviteCode: string, referrerId: string|null, selfUsdt: number}>} users
 */
export function prepareImport(users, { maxDepth = 64 } = {}) {
  const byId = new Map();
  const errors = [];
  const seenWallet = new Set();
  const seenCode = new Set();

  for (const raw of users) {
    const wallet = checksumWallet(raw.wallet);
    const inviteCode = normalizeCode(raw.inviteCode);
    if (!wallet) {
      errors.push({ type: "bad_wallet", id: raw.id, wallet: raw.wallet });
      continue;
    }
    if (seenWallet.has(wallet)) {
      errors.push({ type: "dup_wallet", id: raw.id, wallet });
      continue;
    }
    if (!inviteCode) {
      errors.push({ type: "missing_code", id: raw.id, wallet });
      continue;
    }
    if (seenCode.has(inviteCode)) {
      errors.push({ type: "dup_code", id: raw.id, inviteCode });
      continue;
    }
    try {
      codeToBytes32(inviteCode);
    } catch (e) {
      errors.push({ type: "bad_code", id: raw.id, inviteCode, message: e.message });
      continue;
    }
    seenWallet.add(wallet);
    seenCode.add(inviteCode);
    byId.set(raw.id, {
      id: raw.id,
      wallet,
      inviteCode,
      referrerId: raw.referrerId || null,
      selfUsdt: Number(raw.selfUsdt || 0),
      selfWei: toWei(Number(raw.selfUsdt || 0)),
      teamWei: 0n,
      depth: 0,
    });
  }

  const children = new Map();
  for (const u of byId.values()) {
    if (!u.referrerId) continue;
    if (!byId.has(u.referrerId)) {
      errors.push({ type: "dangling_referrer", id: u.id, referrerId: u.referrerId });
      u.referrerId = null;
      continue;
    }
    const list = children.get(u.referrerId) || [];
    list.push(u.id);
    children.set(u.referrerId, list);
  }

  const indeg = new Map();
  for (const id of byId.keys()) indeg.set(id, 0);
  for (const [parent, kids] of children) {
    if (!byId.has(parent)) continue;
    for (const k of kids) indeg.set(k, (indeg.get(k) || 0) + 1);
  }

  const queue = [];
  for (const [id, d] of indeg) {
    if (d === 0) queue.push(id);
  }
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const k of children.get(id) || []) {
      const next = indeg.get(k) - 1;
      indeg.set(k, next);
      if (next === 0) queue.push(k);
    }
  }
  if (topo.length !== byId.size) {
    const leftover = [...byId.keys()].filter((id) => !topo.includes(id));
    errors.push({ type: "cycle", ids: leftover });
  }

  const visiting = new Set();
  const memo = new Map();
  function teamOf(id) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) {
      errors.push({ type: "cycle", id });
      return 0n;
    }
    visiting.add(id);
    let team = 0n;
    for (const cid of children.get(id) || []) {
      const child = byId.get(cid);
      team += child.selfWei + teamOf(cid);
    }
    visiting.delete(id);
    memo.set(id, team);
    return team;
  }

  for (const id of byId.keys()) {
    const u = byId.get(id);
    u.teamWei = teamOf(id);
    let depth = 0;
    let cursor = u.referrerId;
    const seen = new Set([id]);
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push({ type: "cycle_walk", id });
        break;
      }
      seen.add(cursor);
      depth += 1;
      cursor = byId.get(cursor)?.referrerId ?? null;
    }
    u.depth = depth;
    if (depth > maxDepth) {
      errors.push({ type: "depth", id: u.id, depth, maxDepth });
    }
  }

  const volumeMismatches = [];
  for (const u of byId.values()) {
    let expect = 0n;
    for (const cid of children.get(u.id) || []) {
      const child = byId.get(cid);
      expect += child.selfWei + child.teamWei;
    }
    if (expect !== u.teamWei) {
      volumeMismatches.push({ id: u.id, wallet: u.wallet, got: u.teamWei.toString(), expect: expect.toString() });
    }
  }

  const ordered = topo.map((id) => byId.get(id)).filter(Boolean);
  const records = ordered.map((u) => ({
    id: u.id,
    wallet: u.wallet,
    inviteCode: u.inviteCode,
    referrer: u.referrerId ? byId.get(u.referrerId)?.wallet ?? null : null,
    selfWei: u.selfWei.toString(),
    teamWei: u.teamWei.toString(),
    selfUsdt: u.selfUsdt,
    depth: u.depth,
  }));

  return {
    ok: errors.length === 0 && volumeMismatches.length === 0,
    errors,
    volumeMismatches,
    stats: {
      users: records.length,
      withReferrer: records.filter((r) => r.referrer).length,
      maxDepth: records.reduce((m, r) => Math.max(m, r.depth), 0),
      totalSelfUsdt: records.reduce((s, r) => s + r.selfUsdt, 0),
    },
    records,
  };
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
