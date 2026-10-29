-- Per-address cap for one claim-style grant. Default 500 CKEY. Owner changes it from the website.
-- Additive. Safe to run more than once. Does not alter activity_airdrop_* tables.
CREATE TABLE IF NOT EXISTS ckey_claim_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  "maxPerAddressWei" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ckey_claim_settings_amount_check CHECK ("maxPerAddressWei" ~ '^[1-9][0-9]*$')
);

INSERT INTO ckey_claim_settings (id, "maxPerAddressWei")
VALUES (1, '500000000000000000000')
ON CONFLICT (id) DO NOTHING;
