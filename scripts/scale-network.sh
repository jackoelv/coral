#!/usr/bin/env bash
# Run the hundreds-account deposit flow.
# local: expects Anvil on 127.0.0.1:8545, deploys, then sends the transactions.
# bscTestnet: broadcasts only when BSC_TESTNET_RPC and TEST_PRIVATE_KEY are set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
NETWORK="${NETWORK:-local}"

if [ "$NETWORK" = "bscTestnet" ]; then
  if [ -z "${BSC_TESTNET_RPC:-}" ] || [ -z "${TEST_PRIVATE_KEY:-}" ]; then
    echo "BSC testnet was not broadcast."
    echo "Set BSC_TESTNET_RPC and TEST_PRIVATE_KEY, then re-run: NETWORK=bscTestnet bash scripts/scale-network.sh"
    exit 0
  fi
  NETWORK=bscTestnet forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$BSC_TESTNET_RPC" --private-key "$TEST_PRIVATE_KEY" --broadcast -vv
  RPC_URL="$BSC_TESTNET_RPC" CHAIN_ID=97 TEST_PRIVATE_KEY="$TEST_PRIVATE_KEY" node scripts/scale-anvil.mjs
  exit $?
fi

if [ "$NETWORK" != "local" ]; then
  echo "NETWORK must be local or bscTestnet (mainnet is not broadcast by this script)"
  exit 1
fi

bash "$ROOT/scripts/local-up.sh"
node scripts/scale-anvil.mjs
