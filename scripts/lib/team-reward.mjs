/** Classic differential + 60k overlay. Mirrors the former on-chain NemoTeamReward. */

export const UNIT = 10n ** 18n;
export const BPS = 10_000n;
export const OVERLAY_BPS = 1_000n;
export const TOP_BPS = 1_000n;
export const DIRECT_BPS = 1_000n;
export const MIN_SELF = 100n * UNIT;

export const TIERS = [
  [500n * UNIT, 300n],
  [2_000n * UNIT, 500n],
  [10_000n * UNIT, 700n],
  [30_000n * UNIT, 900n],
  [60_000n * UNIT, 1_000n],
];

/** Used for deposits at or after TEAM_TIER_SWITCH_BLOCK. Earlier deposits stay on TIERS. */
export const TIERS_V2 = [
  [1_000n * UNIT, 300n],
  [10_000n * UNIT, 500n],
  [80_000n * UNIT, 1_000n],
];

export function bpsForQual(qual, tiers = TIERS) {
  let rate = 0n;
  for (const [vol, bps] of tiers) {
    if (qual >= vol) rate = bps;
  }
  return rate;
}

/** Empty or "0" keeps every block on the original five tiers. */
export function tiersForBlock(blockNumber, switchBlock) {
  if (switchBlock == null || switchBlock === "" || switchBlock === "0") return TIERS;
  const block = blockNumber == null ? 0n : BigInt(blockNumber);
  return block >= BigInt(switchBlock) ? TIERS_V2 : TIERS;
}

export function createState() {
  return {
    self: new Map(),
    team: new Map(),
    referrer: new Map(),
    teamRewards: new Map(),
    direct: new Map(),
  };
}

function get(map, key) {
  return map.get(key) ?? 0n;
}

export function bind(state, account, referrer) {
  state.referrer.set(account, referrer || null);
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

/**
 * Apply one deposit. Qualification is read before this deposit is added to upline volume.
 * The depositor's own tier does not compress upline (prevBps starts at 0).
 */
export function contribute(state, account, amount, opts = {}) {
  const directBps = opts.directBps ?? DIRECT_BPS;
  const minSelf = opts.minSelf ?? MIN_SELF;
  const tiers = opts.tiers ?? TIERS;
  state.self.set(account, get(state.self, account) + amount);

  const ref = state.referrer.get(account) || null;
  let directPaid = 0n;
  if (ref && get(state.self, ref) >= minSelf) {
    directPaid = (amount * directBps) / BPS;
    if (directPaid > 0n) state.direct.set(ref, get(state.direct, ref) + directPaid);
  }

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
      if (reward > 0n) {
        state.teamRewards.set(cursor, get(state.teamRewards, cursor) + reward);
        deltas.push({ account: cursor, amount: reward, kind: "diff" });
      }
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
    if (overlay > 0n) {
      state.teamRewards.set(overlayAncestor, get(state.teamRewards, overlayAncestor) + overlay);
      deltas.push({ account: overlayAncestor, amount: overlay, kind: "overlay" });
    }
  }

  return { directTo: ref, directPaid, deltas, overlayTo: overlay > 0n ? overlayAncestor : null, overlay };
}

export function teamOf(state, account) {
  return get(state.teamRewards, account);
}

export function directOf(state, account) {
  return get(state.direct, account);
}
