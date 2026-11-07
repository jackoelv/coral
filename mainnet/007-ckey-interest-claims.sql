-- Additive. CKEY weekly interest claims (InterestClaimed) and the scan cursor.
-- Safe to run more than once. Does not alter existing tables.
-- coral_ckey_interest_scan.last_block is the last block whose totalInterestMinted
-- matches the rows below it. The next scan starts at last_block + 1.
-- Do not trust a wide eth_getLogs on this RPC: a 2,000-block window can omit
-- InterestClaimed. Compare the contract's totalInterestMinted and read the
-- transaction receipt for any block the counter moves.
CREATE TABLE IF NOT EXISTS coral_ckey_interest_claim (
  chain_id bigint NOT NULL,
  interest_address text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_time timestamptz,
  wallet text NOT NULL,
  amount_wei text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS coral_ckey_interest_claim_wallet_idx
  ON coral_ckey_interest_claim (chain_id, wallet);
CREATE INDEX IF NOT EXISTS coral_ckey_interest_claim_block_idx
  ON coral_ckey_interest_claim (chain_id, block_number);

CREATE TABLE IF NOT EXISTS coral_ckey_interest_scan (
  chain_id bigint NOT NULL,
  interest_address text NOT NULL,
  from_block bigint NOT NULL,
  last_block bigint NOT NULL,
  claim_count integer NOT NULL,
  amount_wei text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, interest_address)
);
