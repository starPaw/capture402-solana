#!/usr/bin/env bash
# Offline v2 validation. The single program executes only in local LiteSVM.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build-sbf.sh
cargo test --locked
python3 -B scripts/check_account_lifecycle_model.py
npm test --prefix integration -- test/program-v2.test.ts test/v2-order-journal.test.ts test/v2-order-authorizer.test.ts test/v2-order-rpc.test.ts test/facilitator-orders.test.ts test/order-runtime.test.ts
