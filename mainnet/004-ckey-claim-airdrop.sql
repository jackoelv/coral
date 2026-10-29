-- Claim-style CKEY airdrop drafts. Additive. Safe to run more than once.
-- Does not alter activity_airdrop_* push-transfer tables.
-- draft: uploaded by an editor. proposed: editor committed the list hash on chain.
-- granted: reviewer submitted the matching list. rejected: closed in the database or on chain.
CREATE TABLE IF NOT EXISTS ckey_claim_batches (
  id TEXT PRIMARY KEY,
  "batchId" TEXT NOT NULL UNIQUE,
  submitter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  "listHash" TEXT NOT NULL,
  "totalWei" TEXT NOT NULL,
  "proposeTxHash" TEXT,
  reviewer TEXT,
  "txHash" TEXT,
  "rejectTxHash" TEXT,
  note TEXT,
  "chainId" INTEGER NOT NULL,
  contract TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ckey_claim_batches_status_check CHECK (status IN ('draft', 'proposed', 'rejected', 'granted')),
  CONSTRAINT ckey_claim_batches_batch_id_check CHECK ("batchId" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT ckey_claim_batches_list_hash_check CHECK ("listHash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT ckey_claim_batches_total_check CHECK ("totalWei" ~ '^[1-9][0-9]*$')
);

CREATE TABLE IF NOT EXISTS ckey_claim_entries (
  id TEXT PRIMARY KEY,
  "batchDbId" TEXT NOT NULL REFERENCES ckey_claim_batches (id),
  position INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  "amountWei" TEXT NOT NULL,
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ckey_claim_entries_amount_check CHECK ("amountWei" ~ '^[1-9][0-9]*$'),
  CONSTRAINT ckey_claim_entries_reason_check CHECK (char_length(reason) BETWEEN 1 AND 200),
  CONSTRAINT ckey_claim_entries_recipient_batch_unique UNIQUE ("batchDbId", recipient),
  CONSTRAINT ckey_claim_entries_position_unique UNIQUE ("batchDbId", position)
);

CREATE INDEX IF NOT EXISTS ckey_claim_entries_recipient_idx ON ckey_claim_entries (lower(recipient));
