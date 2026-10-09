-- Review-only until production FULL BACKUP + RESTORE TEST are approved.
-- Snapshot 2026-10-06: production had no Nemo tables. Tables were renamed nemo_* -> coral_* on 2026-10-10.
-- Never run reset:testnet-db or prisma db push --accept-data-loss on production.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
 IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('coral_invite_cache','coral_indexer_state','coral_team_account','coral_team_root','coral_team_proof','coral_interest_boundary')) THEN
 RAISE EXCEPTION 'A Nemo table already exists; inspect schema before applying this new-table migration';
 END IF;
END $$;
-- CreateTable
CREATE TABLE "coral_invite_cache" (
    "chainId" INTEGER NOT NULL,
    "idoAddress" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coral_invite_cache_pkey" PRIMARY KEY ("chainId","idoAddress","inviteCode")
);

-- CreateIndex
CREATE INDEX "coral_invite_cache_chainId_idoAddress_wallet_idx" ON "coral_invite_cache"("chainId", "idoAddress", "wallet");



CREATE TABLE IF NOT EXISTS coral_indexer_state (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  rewards_address text,
  last_block bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, ido_address)
);
CREATE TABLE IF NOT EXISTS coral_team_account (
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
CREATE TABLE IF NOT EXISTS coral_team_root (
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
CREATE TABLE IF NOT EXISTS coral_interest_boundary (
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
CREATE TABLE IF NOT EXISTS coral_team_proof (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  root text NOT NULL,
  wallet text NOT NULL,
  cumulative_wei text NOT NULL,
  proof jsonb NOT NULL,
  PRIMARY KEY (chain_id, ido_address, root, wallet)
);

COMMIT;
