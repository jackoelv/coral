import { getAddress } from "viem";
import { emptyIndexState } from "./reward-index.mjs";
import { bind } from "./team-reward.mjs";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nemo_indexer_state (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  rewards_address text,
  last_block bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, ido_address)
);
CREATE TABLE IF NOT EXISTS nemo_team_account (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  wallet text NOT NULL,
  referrer text,
  self_wei text NOT NULL DEFAULT '0',
  team_wei text NOT NULL DEFAULT '0',
  team_reward_wei text NOT NULL DEFAULT '0',
  historical_team_reward_wei text NOT NULL DEFAULT '0',
  direct_wei text NOT NULL DEFAULT '0',
  claimed_wei text NOT NULL DEFAULT '0',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, ido_address, wallet)
);
CREATE TABLE IF NOT EXISTS nemo_team_root (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  root text NOT NULL,
  content_hash text NOT NULL,
  cumulative_wei text NOT NULL,
  tx_hash text,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, ido_address, root)
);
CREATE TABLE IF NOT EXISTS nemo_interest_boundary (
  chain_id bigint NOT NULL,
  week bigint NOT NULL,
  boundary_unix bigint NOT NULL,
  block_n bigint,
  block_n_time bigint,
  block_n1 bigint,
  block_n1_time bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, week)
);
CREATE TABLE IF NOT EXISTS nemo_team_proof (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  root text NOT NULL,
  wallet text NOT NULL,
  cumulative_wei text NOT NULL,
  proof jsonb NOT NULL,
  PRIMARY KEY (chain_id, ido_address, root, wallet)
);
`;

const SCOPED_KEYS = {
  nemo_team_account: ["chain_id", "ido_address", "wallet"],
  nemo_team_root: ["chain_id", "ido_address", "root"],
  nemo_team_proof: ["chain_id", "ido_address", "root", "wallet"],
};

export function advisoryKey(name) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x811c9dc5);
  }
  return [h1 | 0, h2 | 0];
}

export function lockName(chainId, idoAddress) {
  return `nemo:${chainId}:${idoAddress.toLowerCase()}`;
}

export async function tryLock(client, name) {
  const [a, b] = advisoryKey(name);
  const { rows } = await client.query(`SELECT pg_try_advisory_lock($1::int, $2::int) AS locked`, [a, b]);
  return Boolean(rows[0].locked);
}

export async function unlock(client, name) {
  const [a, b] = advisoryKey(name);
  await client.query(`SELECT pg_advisory_unlock($1::int, $2::int)`, [a, b]);
}

export async function ensureSchema(client) {
  await client.query(SCHEMA_SQL);
  for (const [table, cols] of Object.entries(SCOPED_KEYS)) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ido_address text NOT NULL DEFAULT ''`);
    if (table === "nemo_team_account") {
      await client.query(
        `ALTER TABLE nemo_team_account ADD COLUMN IF NOT EXISTS historical_team_reward_wei text NOT NULL DEFAULT '0'`,
      );
    }
    const { rows } = await client.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [table],
    );
    if (rows.map((row) => row.attname).join(",") === cols.join(",")) continue;
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
    await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${cols.join(", ")})`);
  }
}

export async function loadCheckpoint(client, chainId, idoAddress) {
  const { rows } = await client.query(
    `SELECT last_block, rewards_address FROM nemo_indexer_state WHERE chain_id = $1 AND ido_address = $2`,
    [chainId, idoAddress],
  );
  return rows[0] || null;
}

export function stateFromRows(rows) {
  const state = emptyIndexState();
  for (const row of rows) {
    const wallet = getAddress(row.wallet);
    bind(state, wallet, row.referrer ? getAddress(row.referrer) : null);
    const selfWei = BigInt(row.self_wei);
    const teamWei = BigInt(row.team_wei);
    const teamRewardWei = BigInt(row.team_reward_wei);
    const directWei = BigInt(row.direct_wei);
    const claimedWei = BigInt(row.claimed_wei);
    if (selfWei > 0n) state.self.set(wallet, selfWei);
    if (teamWei > 0n) state.team.set(wallet, teamWei);
    if (teamRewardWei > 0n) state.teamRewards.set(wallet, teamRewardWei);
    if (directWei > 0n) state.direct.set(wallet, directWei);
    if (claimedWei > 0n) state.claimed.set(wallet, claimedWei);
  }
  return state;
}

export async function loadAccounts(client, chainId, idoAddress) {
  const { rows } = await client.query(
    `SELECT wallet, referrer, self_wei, team_wei, team_reward_wei, historical_team_reward_wei, direct_wei, claimed_wei
     FROM nemo_team_account WHERE chain_id = $1 AND ido_address = $2`,
    [chainId, idoAddress],
  );
  return rows;
}

export async function saveIndex(client, { chainId, idoAddress, rewardsAddress, lastBlock, rows }) {
  await client.query("BEGIN");
  try {
    const advanced = await client.query(
      `INSERT INTO nemo_indexer_state (chain_id, ido_address, rewards_address, last_block)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, ido_address)
       DO UPDATE SET rewards_address = EXCLUDED.rewards_address,
                     last_block = EXCLUDED.last_block,
                     updated_at = now()
       WHERE nemo_indexer_state.last_block < EXCLUDED.last_block
       RETURNING last_block`,
      [chainId, idoAddress, rewardsAddress, lastBlock],
    );
    if (advanced.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    for (const row of rows) {
      await client.query(
        `INSERT INTO nemo_team_account
           (chain_id, ido_address, wallet, referrer, self_wei, team_wei, team_reward_wei, direct_wei, claimed_wei)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (chain_id, ido_address, wallet)
         DO UPDATE SET referrer = EXCLUDED.referrer,
                       self_wei = EXCLUDED.self_wei,
                       team_wei = EXCLUDED.team_wei,
                       team_reward_wei = EXCLUDED.team_reward_wei,
                       direct_wei = EXCLUDED.direct_wei,
                       claimed_wei = EXCLUDED.claimed_wei,
                       updated_at = now()`,
        [
          chainId,
          idoAddress,
          row.wallet,
          row.referrer,
          row.selfWei.toString(),
          row.teamWei.toString(),
          row.teamRewardWei.toString(),
          row.directWei.toString(),
          row.claimedWei.toString(),
        ],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function saveRoot(client, { chainId, idoAddress, root, contentHash, cumulativeWei, txHash, proofs, active }) {
  await client.query("BEGIN");
  try {
    if (active) {
      await client.query(
        `UPDATE nemo_team_root SET active = false WHERE chain_id = $1 AND ido_address = $2 AND root <> $3`,
        [chainId, idoAddress, root],
      );
    }
    await client.query(
      `INSERT INTO nemo_team_root (chain_id, ido_address, root, content_hash, cumulative_wei, tx_hash, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_id, ido_address, root)
       DO UPDATE SET content_hash = EXCLUDED.content_hash,
                     cumulative_wei = EXCLUDED.cumulative_wei,
                     tx_hash = COALESCE(EXCLUDED.tx_hash, nemo_team_root.tx_hash),
                     active = EXCLUDED.active OR nemo_team_root.active`,
      [chainId, idoAddress, root, contentHash, cumulativeWei.toString(), txHash, active],
    );
    for (const proof of proofs) {
      await client.query(
        `INSERT INTO nemo_team_proof (chain_id, ido_address, root, wallet, cumulative_wei, proof)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (chain_id, ido_address, root, wallet)
         DO UPDATE SET cumulative_wei = EXCLUDED.cumulative_wei, proof = EXCLUDED.proof`,
        [chainId, idoAddress, root, proof.wallet, proof.cumulativeWei.toString(), JSON.stringify(proof.proof)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function saveInterestBoundary(client, row) {
  await client.query(
    `INSERT INTO nemo_interest_boundary
       (chain_id, week, boundary_unix, block_n, block_n_time, block_n1, block_n1_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, week)
     DO UPDATE SET boundary_unix = EXCLUDED.boundary_unix,
                   block_n = EXCLUDED.block_n,
                   block_n_time = EXCLUDED.block_n_time,
                   block_n1 = EXCLUDED.block_n1,
                   block_n1_time = EXCLUDED.block_n1_time,
                   updated_at = now()`,
    [row.chainId, row.week, row.boundaryUnix, row.blockN, row.blockNTime, row.blockN1, row.blockN1Time],
  );
}
