#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build-sbf.sh
cargo test --locked --test sac001 --test sac002 -- --nocapture
