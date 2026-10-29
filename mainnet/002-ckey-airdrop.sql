-- Additive tables for on-site CKEY airdrop records. Safe to run more than once.
-- Applied only against the production database by scripts/lib/ckey-airdrop-record.mjs.
CREATE TABLE IF NOT EXISTS "activity_airdrop_campaigns" (
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sender" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_airdrop_campaigns_pkey" PRIMARY KEY ("code")
);

CREATE TABLE IF NOT EXISTS "activity_airdrop_transfers" (
  "txHash" TEXT NOT NULL,
  "campaignCode" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "amountWei" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_airdrop_transfers_pkey" PRIMARY KEY ("txHash")
);

DO $$ BEGIN
  ALTER TABLE "activity_airdrop_transfers"
    ADD CONSTRAINT "activity_airdrop_transfers_campaignCode_fkey"
    FOREIGN KEY ("campaignCode") REFERENCES "activity_airdrop_campaigns"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "activity_airdrop_transfers_recipient_idx"
  ON "activity_airdrop_transfers" ("recipient");
CREATE INDEX IF NOT EXISTS "activity_airdrop_transfers_campaignCode_idx"
  ON "activity_airdrop_transfers" ("campaignCode");
CREATE INDEX IF NOT EXISTS "activity_airdrop_transfers_createdAt_idx"
  ON "activity_airdrop_transfers" ("createdAt");
