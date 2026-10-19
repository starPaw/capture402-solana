# Capture402 for Solana

Capture402 is an experimental authorization-and-capture payment program for Solana, with an x402 reference integration, browser payment lab, paid-report example and operator tooling.

A payer authorizes an immutable maximum and deadline. The merchant signs captures, unused-balance releases and refunds. At or after the capture deadline, the payer can reclaim unused escrow directly. Expiry does not move funds automatically. The program does not verify work or service delivery.

## Development

All source, tests, documentation, build tooling, CI, release tooling and future product development belong in `starPaw/capture402-solana`. Sensitive operational data, keys, provider credentials, internal prompts and conversations remain outside this repository. There is no private source upstream or private prerequisite Git history.

Product integrations with AI agents are part of the public product. Do not place real payment receipts, customer records, wallet identities or operational acceptance records in fixtures. Use explicit synthetic fixtures for local tests.

## Build and check

Use Rust from `rust-toolchain.toml`, cargo-build-sbf 2.2.14 with platform-tools v1.53, and Node.js 22 or later with a working C++ compiler for `fs-ext` (Node.js 24 requires C++20).

```sh
cargo-build-sbf --tools-version v1.53 --arch v0 -- --locked
cargo test --locked --test sac001 --test sac002 --test sac003
cd integration
CXXFLAGS=-std=c++20 npm ci
npm run typecheck
npm test
npm run build:wallet
```

The SBF test artifact is built from source into `target/deploy/svm_auth_capture.so`. No accepted deployment binary or private Git object is required. `npm ci` builds a native filesystem locking dependency; review dependency changes before installing. Lockfiles pin the dependency graph. Browser fixture commands and runtime setup are in [integration/README.md](integration/README.md). Operational guards and release procedures are in [ops/README.md](ops/README.md).

Local tests use synthetic identities and loopback servers. They do not sign live wallet requests, fund wallets, deploy programs or establish current service availability. A passing scanner is not a privacy or security certification. Deployment acceptance must separately verify executable identity, network, authority and trusted configuration.

## Proposed public CI policy

The prepared Components workflow runs only by explicit manual dispatch for a release gate, security review or Linux-only behavior. Ordinary pushes and pull requests do not trigger hosted work. Both jobs use read-only repository permissions, pinned actions and the current source-built SBF. They receive no deployment credentials. After repository creation, independently verify its numeric ID and set `CAPTURE402_REPOSITORY_ID`; the identity gate refuses an unassigned or mismatched ID. Workflow availability does not authorize deployment or payment operations. Routine validation stays local.

## Scope and limits

- Classic SPL Token only; Token-2022 and wrapped SOL are rejected.
- Immutable authorization terms; no automatic top-up, extension or replay after uncertainty.
- Payment identity accounts remain allocated in v1; there is no close/reset instruction.
- The paid-report example requires all four finalized proofs and durable persistence before delivering both artifacts. Interrupted or UNKNOWN runs retain reservations and may block new report payments indefinitely.
- The browser payment lab, operator recovery tools, provisioning tools and deployment controllers remain source-visible. Installing them is not authorization for live actions.

This is a proposed local x402 SVM extension, not an upstream-approved binding or published npm SDK. Production readiness and independent security acceptance are not established.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and the bundled dependency notices. Existing crate and package names are retained for compatibility.
