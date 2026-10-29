-- Apply after 002, in one reviewed migration transaction. No existing rows are deleted.
ALTER TABLE activity_airdrop_transfers ADD COLUMN IF NOT EXISTS "blockNumber" BIGINT;
ALTER TABLE activity_airdrop_transfers ADD COLUMN IF NOT EXISTS "blockHash" TEXT;
ALTER TABLE activity_airdrop_transfers ADD COLUMN IF NOT EXISTS "logIndex" INTEGER;
ALTER TABLE activity_airdrop_transfers ADD COLUMN IF NOT EXISTS "blockTimestamp" TIMESTAMPTZ;
ALTER TABLE activity_airdrop_transfers ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS activity_airdrop_recipient_lower_idx ON activity_airdrop_transfers (lower(recipient));
CREATE TABLE IF NOT EXISTS activity_airdrop_batches (
  id TEXT PRIMARY KEY,
  "campaignCode" TEXT NOT NULL REFERENCES activity_airdrop_campaigns(code),
  fingerprint TEXT NOT NULL,
  manifest JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_airdrop_fingerprint_idx ON activity_airdrop_batches(fingerprint);
CREATE TABLE IF NOT EXISTS activity_airdrop_intents (
  "campaignCode" TEXT NOT NULL REFERENCES activity_airdrop_campaigns(code),
  "recipientKey" TEXT NOT NULL CHECK ("recipientKey" ~ '^0x[0-9a-f]{40}$'),
  "batchId" TEXT NOT NULL REFERENCES activity_airdrop_batches(id),
  "amountWei" TEXT NOT NULL CHECK ("amountWei" ~ '^[1-9][0-9]*$'),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','signing','confirmed')),
  nonce BIGINT,
  "txHash" TEXT,
  attempts JSONB NOT NULL DEFAULT '[]',
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("campaignCode", "recipientKey")
);
CREATE INDEX IF NOT EXISTS activity_airdrop_intent_recipient_idx ON activity_airdrop_intents("recipientKey");
