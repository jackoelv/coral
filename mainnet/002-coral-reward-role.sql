-- Additive. Safe to run on a database that already has coral_* tables.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS coral_reward_role (
  chain_id bigint NOT NULL,
  ido_address text NOT NULL,
  wallet text NOT NULL,
  role text NOT NULL,
  effective_block bigint NOT NULL,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, ido_address, wallet)
);
COMMIT;
