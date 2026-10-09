#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${RPC_URL:-http://127.0.0.1:8545}"
PK="${LOCAL_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "$RPC" | grep -q 0x7a69; then
  echo "Anvil is not reachable at $RPC (expected chainId 31337)."
  echo "Start it first: anvil --chain-id 31337"
  exit 1
fi

bash "$ROOT/scripts/install-deps.sh"

echo "==> Deploy MockUSDT + CoralToken + CoralIdo"
forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC" --private-key "$PK" --broadcast -vv

BROADCAST="$ROOT/broadcast/DeployLocal.s.sol/31337/run-latest.json"
if [ ! -f "$BROADCAST" ]; then
  echo "missing broadcast json: $BROADCAST"
  exit 1
fi

IDO_ADDRESS="$(python3 - <<'PY' "$BROADCAST"
import json, sys
path = sys.argv[1]
data = json.load(open(path))
txs = data.get("transactions") or []
ido = None
usdt = None
nemo = None
for t in txs:
    name = (t.get("contractName") or "")
    addr = t.get("contractAddress")
    if name == "CoralIdo":
        ido = addr
    if name == "MockUSDT":
        usdt = addr
    if name == "CoralToken":
        nemo = addr
print(ido or "")
if usdt:
    sys.stderr.write(f"USDT {usdt}\n")
if nemo:
    sys.stderr.write(f"CKEY {nemo}\n")
PY
)"

if [ -z "$IDO_ADDRESS" ]; then
  echo "could not parse CoralIdo address from $BROADCAST"
  exit 1
fi

echo "==> Seed ROOTANVL"
IDO_ADDRESS="$IDO_ADDRESS" LOCAL_PRIVATE_KEY="$PK" forge script script/SeedLocal.s.sol:SeedLocal \
  --rpc-url "$RPC" --private-key "$PK" --broadcast -vv

echo
echo "CoralIdo: $IDO_ADDRESS"
echo "Root invite code: ROOTANVL"
echo "Next: forge test -vvv"
