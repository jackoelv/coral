/** Classic differential + 60k overlay. Mirrors the former on-chain NemoTeamReward. */

export const UNIT = 10n ** 18n;
export const BPS = 10_000n;
export const OVERLAY_BPS = 1_000n;
export const TOP_BPS = 1_000n;
export const DIRECT_BPS = 1_000n;
export const DIRECT_BPS_V3 = 500n;
export const MIN_SELF = 100n * UNIT;
export const ROLE_LEADER = "team_leader";
export const ROLE_BIG = "big_leader";
export const BIG_SELF_MIN = 1_000n * UNIT;
export const BIG_SELF_BPS = 800n;
/** Team-leader peer bonus needs this much self + umbrella, even after the 14% tier. Edit this number. */
export const LEADER_PEER_QUAL = 60_000n * UNIT;
/** Big-leader peer bonus needs this much self + umbrella. The 8/11/14% differential is unchanged. Edit this number. */
export const BIG_PEER_QUAL = 500_000n * UNIT;

export const TIERS = [
  [500n * UNIT, 300n],
  [2_000n * UNIT, 500n],
  [10_000n * UNIT, 700n],
  [30_000n * UNIT, 900n],
  [60_000n * UNIT, 1_000n],
];

/** Used for deposits at or after TEAM_TIER_SWITCH_BLOCK, and before TEAM_TIER_V3_BLOCK. */
export const TIERS_V2 = [
  [1_000n * UNIT, 300n],
  [10_000n * UNIT, 500n],
  [80_000n * UNIT, 1_000n],
];

export const TIERS_V3_PUBLIC = [
  [10_000n * UNIT, 300n],
  [30_000n * UNIT, 600n],
  [60_000n * UNIT, 900n],
];

export const TIERS_V3_LEADER = [
  [1_000n * UNIT, 800n],
  [3_000n * UNIT, 1_100n],
  [6_000n * UNIT, 1_400n],
];

/** Qual thresholds above the self floor. The 8% step is self volume, not this table. */
export const TIERS_V3_BIG = [
  [3_000n * UNIT, 1_100n],
  [6_000n * UNIT, 1_400n],
];

export function bpsForQual(qual, tiers = TIERS) {
  let rate = 0n;
  for (const [vol, bps] of tiers) {
    if (qual >= vol) rate = bps;
  }
  return rate;
}

export function blockAtLeast(blockNumber, switchBlock) {
  if (switchBlock == null || switchBlock === "" || switchBlock === "0") return false;
  const block = blockNumber == null || blockNumber === "" ? 0n : BigInt(blockNumber);
  return block >= BigInt(switchBlock);
}

/** Empty or "0" keeps every block on the original five tiers. V3 is chosen separately. */
export function tiersForBlock(blockNumber, switchBlock) {
  if (!blockAtLeast(blockNumber, switchBlock)) return TIERS;
  return TIERS_V2;
}

export function directBpsForBlock(blockNumber, v3Block) {
  return blockAtLeast(blockNumber, v3Block) ? DIRECT_BPS_V3 : DIRECT_BPS;
}

export function directBpsProblem(onChainBps, blockNumber, v3Block) {
  const bps = BigInt(onChainBps);
  if (bps !== DIRECT_BPS && bps !== DIRECT_BPS_V3) {
    return `区块 ${blockNumber} 链上直推比例是 ${bps}，只接受 1000 或 500`;
  }
  if (blockAtLeast(blockNumber, v3Block) && bps !== DIRECT_BPS_V3) {
    return `区块 ${blockNumber} 已过切换区块，链上直推仍是 ${bps}，应为 500`;
  }
  return null;
}

export function rewardOptionsForBlock(blockNumber, { tierSwitchBlock = "", tierV3Block = "" } = {}) {
  const v3 = blockAtLeast(blockNumber, tierV3Block);
  return {
    v3,
    blockNumber,
    directBps: DIRECT_BPS,
    tiers: v3 ? TIERS_V3_PUBLIC : tiersForBlock(blockNumber, tierSwitchBlock),
  };
}

export function rewardOptionsForTime(unix, { switchUnix = null, v3Unix = null, directSwitchUnix = null } = {}) {
  const v3 = v3Unix != null && Number(unix) >= Number(v3Unix);
  const v2 = !v3 && switchUnix != null && Number(unix) >= Number(switchUnix);
  const directBps = directSwitchUnix != null && Number(unix) >= Number(directSwitchUnix) ? DIRECT_BPS_V3 : DIRECT_BPS;
  return {
    v3,
    atUnix: unix,
    directBps,
    tiers: v3 ? TIERS_V3_PUBLIC : v2 ? TIERS_V2 : TIERS,
  };
}

export function createState() {
  return {
    self: new Map(),
    team: new Map(),
    referrer: new Map(),
    teamRewards: new Map(),
    direct: new Map(),
    roles: new Map(),
    directBpsProblems: [],
  };
}

function get(map, key) {
  return map.get(key) ?? 0n;
}

export function bind(state, account, referrer) {
  state.referrer.set(account, referrer || null);
}

export function setRole(state, account, role, effectiveBlock = null, effectiveUnix = null) {
  if (!state.roles) state.roles = new Map();
  if (role !== ROLE_LEADER && role !== ROLE_BIG) {
    state.roles.delete(account);
    return;
  }
  state.roles.set(account, {
    role,
    effectiveBlock: effectiveBlock == null || effectiveBlock === "" ? null : BigInt(effectiveBlock),
    effectiveUnix: effectiveUnix == null || effectiveUnix === "" ? null : BigInt(effectiveUnix),
  });
}

export function roleAt(state, account, opts = {}) {
  const row = state.roles?.get(account);
  if (!row || (row.role !== ROLE_LEADER && row.role !== ROLE_BIG)) return null;
  if (opts.blockNumber != null && opts.blockNumber !== "" && row.effectiveBlock != null) {
    if (BigInt(opts.blockNumber) < row.effectiveBlock) return null;
  } else if (opts.atUnix != null && opts.atUnix !== "" && row.effectiveUnix != null) {
    if (BigInt(opts.atUnix) < row.effectiveUnix) return null;
  }
  return row.role;
}

export function bpsForAccount(state, account, opts = {}) {
  const minSelf = opts.minSelf ?? MIN_SELF;
  const self = get(state.self, account);
  if (self < minSelf) return 0n;
  const qual = self + get(state.team, account);
  if (!opts.v3) return bpsForQual(qual, opts.tiers ?? TIERS);
  const role = roleAt(state, account, opts);
  if (role === ROLE_BIG) {
    const floor = self >= BIG_SELF_MIN ? BIG_SELF_BPS : 0n;
    const qualRate = bpsForQual(qual, TIERS_V3_BIG);
    return qualRate > floor ? qualRate : floor;
  }
  if (role === ROLE_LEADER) return bpsForQual(qual, TIERS_V3_LEADER);
  return bpsForQual(qual, TIERS_V3_PUBLIC);
}

/** Volume required before this account's differential can pay a peer bonus to the next same-rate upline. */
export function peerQualMin(role) {
  if (role === ROLE_BIG) return BIG_PEER_QUAL;
  if (role === ROLE_LEADER) return LEADER_PEER_QUAL;
  return TIERS_V3_PUBLIC[TIERS_V3_PUBLIC.length - 1][0];
}

export function peerEligible(state, account, opts = {}) {
  const qual = get(state.self, account) + get(state.team, account);
  return qual >= peerQualMin(roleAt(state, account, opts));
}

/** Historical self volume only. Does not pay rewards and does not change uplines. */
export function seedSelf(state, account, amount) {
  state.self.set(account, BigInt(amount));
}

/**
 * Imported self volume counts toward every ancestor's umbrella.
 * The absolute value is the account's imported total. A later correction applies only the delta.
 * This does not pay direct or team rewards for the imported amount.
 */
export function noteImportedSelf(state, account, absoluteSelf) {
  const next = BigInt(absoluteSelf);
  const prev = get(state.self, account);
  state.self.set(account, next);
  const delta = next - prev;
  if (delta === 0n) return;
  let cursor = state.referrer.get(account) || null;
  while (cursor) {
    const team = get(state.team, cursor) + delta;
    if (team < 0n) throw new Error(`${cursor} 的伞下业绩不能为负`);
    state.team.set(cursor, team);
    cursor = state.referrer.get(cursor) || null;
  }
}

function payTeam(state, account, reward, deltas, kind) {
  if (reward <= 0n) return;
  state.teamRewards.set(account, get(state.teamRewards, account) + reward);
  deltas.push({ account, amount: reward, kind });
}

function walkClassic(state, ref, amount, tiers, minSelf) {
  let prev = 0n;
  let cursor = ref;
  let dNode = null;
  let dTeam = 0n;
  let overlayAncestor = null;
  const deltas = [];

  while (cursor) {
    const self = get(state.self, cursor);
    const qual = self + get(state.team, cursor);
    const rate = self >= minSelf ? bpsForQual(qual, tiers) : 0n;
    let reward = 0n;
    if (rate > prev) {
      reward = (amount * (rate - prev)) / BPS;
      payTeam(state, cursor, reward, deltas, "diff");
      prev = rate;
    }
    if (rate === TOP_BPS) {
      if (!dNode) {
        dNode = cursor;
        dTeam = reward;
      } else if (!overlayAncestor) {
        overlayAncestor = cursor;
      }
    }
    state.team.set(cursor, get(state.team, cursor) + amount);
    cursor = state.referrer.get(cursor) || null;
  }

  let overlay = 0n;
  if (overlayAncestor && dTeam > 0n) {
    overlay = (dTeam * OVERLAY_BPS) / BPS;
    payTeam(state, overlayAncestor, overlay, deltas, "overlay");
  }
  return { deltas, overlay, overlayTo: overlay > 0n ? overlayAncestor : null };
}

function walkV3(state, ref, amount, opts) {
  let prev = 0n;
  let established = 0n;
  let overlayOpen = false;
  const deltas = [];
  let cursor = ref;
  while (cursor) {
    const rate = bpsForAccount(state, cursor, opts);
    if (rate > prev) {
      const reward = (amount * (rate - prev)) / BPS;
      payTeam(state, cursor, reward, deltas, "diff");
      prev = rate;
      established = reward;
      overlayOpen = reward > 0n && peerEligible(state, cursor, opts);
    } else if (rate === prev && rate > 0n && overlayOpen) {
      payTeam(state, cursor, (established * OVERLAY_BPS) / BPS, deltas, "overlay");
      overlayOpen = false;
    } else if (overlayOpen && rate < prev) {
      overlayOpen = false;
    }
    state.team.set(cursor, get(state.team, cursor) + amount);
    cursor = state.referrer.get(cursor) || null;
  }
  const overlays = deltas.filter((row) => row.kind === "overlay");
  const overlay = overlays.reduce((sum, row) => sum + row.amount, 0n);
  return { deltas, overlay, overlayTo: overlays.length ? overlays[overlays.length - 1].account : null };
}

/**
 * Apply one deposit. Qualification is read before this deposit is added to upline volume.
 * The depositor's own tier does not compress upline (prev starts at 0).
 */
export function contribute(state, account, amount, opts = {}) {
  const minSelf = opts.minSelf ?? MIN_SELF;
  const v3 = opts.v3 === true;
  const directBps = opts.directBps ?? (v3 ? DIRECT_BPS_V3 : DIRECT_BPS);
  const tiers = opts.tiers ?? TIERS;
  state.self.set(account, get(state.self, account) + amount);

  const ref = state.referrer.get(account) || null;
  let directPaid = 0n;
  if (ref && get(state.self, ref) >= minSelf) {
    directPaid = (amount * directBps) / BPS;
    if (directPaid > 0n) state.direct.set(ref, get(state.direct, ref) + directPaid);
  }

  const walked = v3 ? walkV3(state, ref, amount, { ...opts, v3: true, minSelf }) : walkClassic(state, ref, amount, tiers, minSelf);
  return { directTo: ref, directPaid, ...walked };
}

export function teamOf(state, account) {
  return get(state.teamRewards, account);
}

export function directOf(state, account) {
  return get(state.direct, account);
}
