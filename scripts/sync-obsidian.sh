#!/usr/bin/env bash
# Sync Obsidian vault to the hosted Petals Memory API.
#
# Usage:
#   ./scripts/sync-obsidian.sh          # default batch of 50
#   ./scripts/sync-obsidian.sh 100      # custom batch size
#   ./scripts/sync-obsidian.sh 0        # unlimited (full sync)
#   ./scripts/sync-obsidian.sh --dry    # dry run
#   ./scripts/sync-obsidian.sh 20 --dry # batch of 20, dry run

set -euo pipefail
cd "$(dirname "$0")/.."

BATCH_SIZE="${1:-50}"
DRY_RUN="false"

for arg in "$@"; do
  if [[ "$arg" == "--dry" ]]; then
    DRY_RUN="true"
  fi
done

# Strip --dry from BATCH_SIZE if it was the first arg
if [[ "$BATCH_SIZE" == "--dry" ]]; then
  BATCH_SIZE=50
fi

OBSIDIAN_VAULT_PATH="$HOME/Notes" \
MEMORY_API_URL="https://petals.chat/api/memory" \
MEMORY_API_KEY="petals-MOZxhaWDqMyLWeBGKbTdUTpxeUhILGkKxyfLXeYmHUsgHeQIxQwRJeeLRcKlrzjZ" \
OBSIDIAN_INCLUDE="0 Inbox" \
OBSIDIAN_BATCH_SIZE="$BATCH_SIZE" \
OBSIDIAN_MIN_WORDS=30 \
OBSIDIAN_MAX_WORDS=5000 \
OBSIDIAN_DRY_RUN="$DRY_RUN" \
pnpm run tsx scripts/sync-obsidian.ts
