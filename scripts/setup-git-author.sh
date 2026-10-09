#!/usr/bin/env bash
# Bind this clone to the repo-tracked author in .gitconfig.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME="$(git config -f "$ROOT/.gitconfig" --get user.name)"
EMAIL="$(git config -f "$ROOT/.gitconfig" --get user.email)"
git config --local include.path ../.gitconfig
git config --local user.name "$NAME"
git config --local user.email "$EMAIL"
echo "git author: $NAME <$EMAIL>"

