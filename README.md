# Capture402 for Solana

Capture402 is an experimental authorization-and-capture payment program for Solana, with an x402 reference integration, browser payment lab, paid-report example and operator tooling.

A payer authorizes an immutable maximum and deadline. The merchant signs captures, unused-balance releases and refunds. At or after the capture deadline, the payer can reclaim unused escrow directly. Expiry does not move funds automatically. The program does not verify work or service delivery.

## Development

All source, tests, documentation, build tooling, CI, release tooling and future product development belong in `starPaw/capture402-solana`. Sensitive operational data, keys, provider credentials, internal prompts and conversations remain outside this repository. There is no private source upstream or private prerequisite Git history.

Product integrations with AI agents are part of the public product. Do not place real payment receipts, customer records, wallet identities or operational acceptance records in fixtures. Use explicit synthetic fixtures for local tests.

The project implements v2 only. Previous usage was Devnet experimentation without real users or payments; v1 wire formats, accounts and protocol selectors are rejected. UNKNOWN handling, durable journals and protection against duplicate payment remain mandatory.

## Build and check

Use Rust from `rust-toolchain.toml`, Agave 4.4.0-rc.1 with cargo-build-sbf 4.6.0 and platform-tools v1.58 (SBF Rust 1.95.0), and Node.js 26.13.1 LTS from `.nvmrc` with a working C++20 compiler for `fs-ext`.

```sh
./scripts/build-sbf.sh
cargo test --locked
cd integration
CXXFLAGS=-std=c++20 npm ci
npm run typecheck
npm test
npm run build:wallet
```

Run `./scripts/test-v2.sh` from the repository root for the single v2 SBF, monetary/lifecycle tests, abstract model and order journal tests. All protocol tests run without feature flags.

The [Linux validation record](docs/linux-v2-validation-2026-11-12.md) covers nginx,
systemd, native storage faults and restart/concurrency checks. Its disposable-VM
runner `scripts/test-linux-v2.sh` rejects skipped checks.

The SBF test artifact is built from source into `target/deploy/svm_auth_capture.so`. No accepted deployment binary or private Git object is required. `npm ci` builds a native filesystem locking dependency; review dependency changes before installing. Lockfiles pin the dependency graph. Browser fixture commands and runtime setup are in [integration/README.md](integration/README.md). Operational guards and release procedures are in [ops/README.md](ops/README.md).

Agave 4.4.0-rc.1 remains the required regression target; stable Agave 4.4.1 is an additional qualified target. Host Rust is 1.99.1; the SBF compiler is the separate Rust 1.95.0 supplied by platform-tools v1.58. The shared build script checks CLI/builder versions and explicitly selects SBPF v3, building the sole v2 payment protocol with a 216-byte Payment. The separate experimental Solana runtime ABI v2 is not enabled. An existing isolated platform-tools cache can be selected with `SOLANA_PLATFORM_TOOLS_DIR` and its compiler with `CAPTURE402_SBF_RUSTC`; the latter applies only to SBF compilation, leaving host tests on the pinned host Rust.

Rust LiteSVM 0.18.2 and Node LiteSVM 1.6.2 exercise the compiled artifact. The Rust lockfile pins the embedded Agave runtime to 4.3.2 and the default LiteSVM mainnet feature profile; this is distinct from testing Agave 4.4 itself. For that check, run:

```sh
npm run test:agave --prefix integration
```

Build the artifact first with `./scripts/build-sbf.sh` (or `./scripts/test-v2.sh`). The Agave check starts and stops its own disposable, loopback-only `solana-test-validator` 4.4.0-rc.1. It loads the current binary at a synthetic genesis identity and verifies its bytes. It exercises monetary operations and closure, sponsor rent returns, refund after vault closure, replay/revival guards, dust, retired gifts and batched cleanup. It does not use an installed CLI configuration or submit deployment transactions.

The core derives canonical token addresses once per instruction and reuses only their checked identities and the checked payment bump. It reloads and validates token ownership, mint, state and exact balances after each CPI. Payment data is written directly into the v2 account layout. `tests/support/compute.rs` checks 128 deterministic identities across eight operations, including balance/state invariants and CU regression ceilings. Capture+release's failing second CPI remains covered by both Rust tests and the Agave check. CU measurements apply to the pinned runtime, feature set and fixture; they are not fee quotes or a guarantee for every address or network configuration.

Local tests use synthetic identities and loopback servers. They do not sign live wallet requests, fund wallets, deploy programs or establish current service availability. A passing scanner is not a privacy or security certification. Deployment acceptance must separately verify executable identity, network, authority and trusted configuration.

## Proposed public CI policy

The prepared Components workflow runs only by explicit manual dispatch for a release gate, security review or Linux-only behavior. Ordinary pushes and pull requests do not trigger hosted work. Both jobs use read-only repository permissions, pinned actions and the current source-built SBF. They receive no deployment credentials. After repository creation, independently verify its numeric ID and set `CAPTURE402_REPOSITORY_ID`; the identity gate refuses an unassigned or mismatched ID. Workflow availability does not authorize deployment or payment operations. Routine validation stays local.

## Scope and limits

- Classic SPL Token only; Token-2022 and wrapped SOL are rejected.
- Immutable authorization terms; no automatic top-up, extension or replay after uncertainty.
- [V2 cleanup](docs/account-lifecycle-v2.md) returns vault and Payment storage deposits to their recorded creation funder. Cleanup requires zero held funds; Payment closure also requires slot > signed expiry E and no remaining live refund entitlement. Closing a vault preserves merchant-funded refunds.
- Every facilitator authorization uses a permanent shared business-order journal. The merchant authenticates the order ID and all quote terms; a new salt, E, payer or Payment PDA cannot bypass an existing order reservation. Missing/changed journals stop signing and sending.
- No on-chain order tombstone is retained, so the full initial account rent can be recovered. Direct transactions outside the service, independent stores and restored old backups are outside the business-order guarantee. Closing accounts and missing/pruned history never turn UNKNOWN into permission to pay again.
- The paid-report example requires all four finalized proofs and durable persistence before delivering both artifacts. Interrupted or UNKNOWN runs retain reservations and may block new report payments indefinitely.
- The browser payment lab, operator recovery tools, provisioning tools and deployment controllers remain source-visible. Installing them is not authorization for live actions.

This is a proposed local x402 SVM extension, not an upstream-approved binding or published npm SDK. Production readiness and independent security acceptance are not established.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and the bundled dependency notices. Existing crate and package names are retained for compatibility.
