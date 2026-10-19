#!/usr/bin/env bash
# Offline current-source validation; no deployment, credentials or accepted binary reuse.
set -euo pipefail
repo=$(realpath "${1:-$(dirname "$0")/..}")
test -f "$repo/integration/package-lock.json"
cd "$repo"
./scripts/test-sac003.sh
npm run typecheck --prefix integration
npm run build:wallet --prefix integration
npm test --prefix integration
