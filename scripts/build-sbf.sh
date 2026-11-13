#!/usr/bin/env bash
# One pinned source build shared by local checks and the manual CI workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(solana --version)" in
  "solana-cli 4.4.0-rc.1 "*|"solana-cli 4.4.1 "*) ;;
  *) echo "Capture402 requires Agave 4.4.0-rc.1 or 4.4.1." >&2; exit 1 ;;
esac
if [[ "$(cargo-build-sbf --version)" != $'cargo-build-sbf 4.6.0\n'* ]]; then
  echo "Capture402 requires cargo-build-sbf 4.6.0." >&2
  exit 1
fi

# There is one v2 artifact. No protocol selectors or entrypoint feature overrides.
for arg in "$@"; do
  case "$arg" in
    --protocol-*|--features|--features=*|-F*|--all-features|--no-default-features)
      echo "Only the v2 protocol is supported; SBF feature overrides are forbidden." >&2
      exit 1
      ;;
  esac
done
# Keep the optional SBF compiler override out of subsequent host Rust test builds.
set -- --tools-version v1.58 --arch v3 --sbf-out-dir target/deploy -- --locked "$@"
if [[ -n "${CAPTURE402_SBF_RUSTC:-}" ]]; then
  RUSTC="$CAPTURE402_SBF_RUSTC" cargo-build-sbf --no-rustup-override "$@"
else
  cargo-build-sbf "$@"
fi
