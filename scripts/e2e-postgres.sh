#!/usr/bin/env bash
# Real Postgres + Anvil end-to-end: old-schema migration, index, publish, claim, verify.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
# Anvil's public default account 0. Local chain only; also the default publisher after Deploy.
KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
docker rm -f nemo-pg >/dev/null 2>&1
docker run -d --name nemo-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine >/dev/null || exit 1
anvil --chain-id 31337 --silent >/tmp/nemo-anvil.log 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null; docker rm -f nemo-pg >/dev/null 2>&1' EXIT
for i in $(seq 1 30); do docker exec nemo-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
export DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres PGSSL=disable

echo "== old schema (pre-R5) with one stale row"
docker exec -i nemo-pg psql -q -U postgres <<'SQL'
CREATE TABLE coral_team_account (chain_id bigint NOT NULL, wallet text NOT NULL, referrer text,
  self_wei text NOT NULL DEFAULT '0', team_wei text NOT NULL DEFAULT '0', team_reward_wei text NOT NULL DEFAULT '0',
  direct_wei text NOT NULL DEFAULT '0', claimed_wei text NOT NULL DEFAULT '0', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, wallet));
INSERT INTO coral_team_account (chain_id, wallet, team_reward_wei) VALUES (31337, '0x000000000000000000000000000000000000dEaD', '999000000000000000000');
SQL

echo "== deploy + 300 accounts"
bash scripts/scale-network.sh 2>&1 | rg "chain 31337 ido|merkle claim ok|teamAccounts"
export IDO_ADDRESS=0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
export REWARDS_ADDRESS=0x610178dA211FEF7D417bC0e6FeD39F05609AD788
export RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337

echo "== index (START_BLOCK=0, CHUNK_BLOCKS=100)"
START_BLOCK=0 CHUNK_BLOCKS=100 node scripts/index-rewards.mjs || exit 1
echo "== index again (should be caught up)"
node scripts/index-rewards.mjs || exit 1
docker exec nemo-pg psql -At -U postgres -c "SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='coral_team_account'::regclass AND i.indisprimary"
docker exec nemo-pg psql -At -U postgres -c "SELECT ido_address='' AS stale, count(*) FROM coral_team_account GROUP BY 1 ORDER BY 1"

echo "== publish refuses PRIVATE_KEY"
PRIVATE_KEY=$KEY0 node scripts/publish-root.mjs --apply | tail -1
echo "== publish refuses wrong key"
PUBLISHER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d node scripts/publish-root.mjs --apply 2>&1 | rg -o "不是 publisher.*" | head -1
echo "== publish"
PUBLIC_DIR=/tmp/nemo-roots PUBLISHER_PRIVATE_KEY=$KEY0 node scripts/publish-root.mjs --apply || exit 1
docker exec nemo-pg psql -At -U postgres -c "SELECT root, active, tx_hash IS NOT NULL FROM coral_team_root"
FILE=$(ls -t /tmp/nemo-roots/*.json | head -1)
echo "== verify-root"
node scripts/verify-root.mjs "$FILE" || exit 1
echo "== republish same root keeps it active"
PUBLIC_DIR=/tmp/nemo-roots PUBLISHER_PRIVATE_KEY=$KEY0 node scripts/publish-root.mjs --apply | tail -1
docker exec nemo-pg psql -At -U postgres -c "SELECT count(*) FILTER (WHERE active) FROM coral_team_root"
echo "== tampered file fails"
node -e 'const f=require(process.argv[1]);f.entries[0][1]=(BigInt(f.entries[0][1])+1n).toString();require("fs").writeFileSync("/tmp/nemo-bad.json",JSON.stringify(f))' "$FILE"
node scripts/verify-root.mjs /tmp/nemo-bad.json; echo "tampered exit $?"

echo "== claim with DB proof"
ROW=$(docker exec nemo-pg psql -At -U postgres -c "SELECT p.wallet, p.cumulative_wei, p.proof::text FROM coral_team_proof p JOIN coral_team_root r USING (chain_id, ido_address, root) JOIN coral_team_account a ON a.chain_id=p.chain_id AND a.ido_address=p.ido_address AND a.wallet=p.wallet WHERE r.active AND a.claimed_wei='0' ORDER BY jsonb_array_length(proof) DESC LIMIT 1")
W=$(echo "$ROW" | cut -d'|' -f1); C=$(echo "$ROW" | cut -d'|' -f2); P=$(echo "$ROW" | cut -d'|' -f3 | tr -d '" ')
echo "wallet $W cumulative $C proofLen $(echo "$P" | tr ',' '\n' | wc -l)"
cast rpc anvil_impersonateAccount "$W" >/dev/null
cast rpc anvil_setBalance "$W" 0x56BC75E2D63100000 >/dev/null
cast send --unlocked --from "$W" "$REWARDS_ADDRESS" "claim(uint256,bytes32[])" "$C" "$P" --rpc-url $RPC_URL >/dev/null && echo "claim ok"
echo "claimed onchain $(cast call $REWARDS_ADDRESS 'claimed(address)(uint256)' $W --rpc-url $RPC_URL)"
node scripts/index-rewards.mjs >/dev/null
echo "claimed in db $(docker exec nemo-pg psql -At -U postgres -c "SELECT claimed_wei FROM coral_team_account WHERE ido_address='$IDO_ADDRESS' AND wallet='$W'")"

echo "== concurrent lock"
docker exec nemo-pg psql -At -U postgres -c "SELECT 1" >/dev/null
node -e '
const pg=require("pg");
(async()=>{const {tryLock,lockName}=await import("./scripts/lib/reward-db.mjs");
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
console.log("holder locked", await tryLock(c, lockName(31337, process.env.IDO_ADDRESS)));
const {execSync}=require("child_process");
console.log(execSync("node scripts/index-rewards.mjs").toString().trim());
await c.end();})();'
echo "E2E DONE"
