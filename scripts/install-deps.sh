#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/lib"

if [ ! -f "$ROOT/lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol" ]; then
  rm -rf "$ROOT/lib/openzeppelin-contracts"
  git clone --depth 1 --branch v5.4.0 \
    https://github.com/OpenZeppelin/openzeppelin-contracts.git \
    "$ROOT/lib/openzeppelin-contracts"
fi

if [ ! -f "$ROOT/lib/forge-std/src/Test.sol" ]; then
  rm -rf "$ROOT/lib/forge-std"
  git clone --depth 1 --branch v1.9.6 \
    https://github.com/foundry-rs/forge-std.git \
    "$ROOT/lib/forge-std"
fi

echo "deps ok"
