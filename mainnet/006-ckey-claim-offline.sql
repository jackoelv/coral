-- Offline community airdrop. Additive. Safe to run more than once.
-- kind: standard keeps address,amount,reason. offline stores address,reason and a deposit snapshot.
ALTER TABLE ckey_claim_batches ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE ckey_claim_entries ADD COLUMN IF NOT EXISTS "depositUsdt" TEXT;

DO $$ BEGIN
  ALTER TABLE ckey_claim_batches
    ADD CONSTRAINT ckey_claim_batches_kind_check CHECK (kind IN ('standard', 'offline'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
