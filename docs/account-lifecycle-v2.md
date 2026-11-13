# V2 payment lifecycle and order custody

The project implements one payment protocol: v2. V1 wire/account support, Cargo
protocol selectors and the old authorization abandonment/isolation routes are
removed. This is a source change, not a deployment or migration of private runtime
state. No real-user v1 compatibility is required.

## Identity and authorization

The canonical Payment PDA uses these seeds, in order:

```
"auth-capture-v2", payer[32], salt[32], authorize_until_slot:u64le
```

The payer signs expiry `E` together with maximum `M`, capture deadline `Dc`, refund
deadline `Dr`, merchant, mint and creation funder. Authorization requires
`current_slot <= E <= current_slot + 1500`, with checked arithmetic and `E < u64::MAX`.
Closing Payment requires `current_slot > E`. These conditions never overlap, so
an old authorization cannot recreate its original PDA after closure, including
within the same transaction. Changing E derives another address and cannot revive
the old one. The local harness program ID is synthetic, not a deployment pin.

A new E or salt can create another PDA through a direct program transaction. The
selected business-order protection is **in the shared service journal**, not an
on-chain order tombstone. Every worker must use the same enrolled store. This
preserves full recovery of the original account storage deposits.

## Account and wire format

Payment has exact length 216 bytes and discriminator `SACPAY02`. Truncated,
extended, obsolete and internally inconsistent accounts are rejected.

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 8 | `SACPAY02` |
| 8 | 32 | payer |
| 40 | 32 | merchant |
| 72 | 32 | classic SPL mint |
| 104 | 32 | salt |
| 136 | 8 | maximum M, u64le |
| 144 | 8 | capture deadline Dc, i64le |
| 152 | 8 | refund deadline Dr, i64le |
| 160 | 8 | held H, u64le |
| 168 | 8 | captured and unrefunded F, u64le |
| 176 | 8 | authorization expiry E, u64le |
| 184 | 32 | immutable creation funder / rent recipient |

| Tag | Data | Operation |
| --- | --- | --- |
| 0 | `0,2,0,fee=0:u64,salt:32,M:u64,Dc:i64,Dr:i64,E:u64` (75 bytes) | Authorize |
| 1 | tag only | Payer reclaim after Dc |
| 2 | tag, amount:u64, release:bool, expectedH:u64, expectedF:u64 | Merchant capture and optional release |
| 3 | tag, expectedH:u64, expectedF:u64 | Merchant void |
| 4 | tag, amount:u64, expectedH:u64, expectedF:u64 | Merchant-funded refund |
| 5 | tag only | Close empty vault |
| 6 | tag only | Sweep surplus to payer |
| 7 | tag only | Close Payment |
| 8 | tag, salt:32, E:u64 | Recover post-retirement gifts |

All integers are little endian. Capture release accepts exactly 0 or 1. No
instruction changes the immutable terms or restores spent authorization capacity.
The exact account order/privileges are implemented in `src/lib.rs`,
`src/lifecycle.rs`, `integration/src/program.ts` and `integration/src/lifecycle.ts`.
The facilitator relays authorize/capture/void/refund only; reclaim remains
payer-direct. Cleanup helpers build instructions without automatically submitting.

## Closure and refund invariants

`H + F <= M` and exact signed expected balances remain mandatory. Each token CPI
revalidates canonical account identity, owner, mint and expected balance changes.
A failing second CPI rolls back the complete transaction.

- Every cleanup requires `H == 0`; escrow can never be closed while funds are held.
- Tag 5 closes the canonical zero-balance vault, including an empty frozen classic
  SPL account. Its SOL goes only to the immutable creation funder. Payment remains.
- Tag 6 sends unsolicited vault tokens only to the payer's canonical token account.
  It does not alter H, F, deadlines or the merchant's refund entitlement. Frozen
  nonempty accounts fail atomically.
- Tag 7 requires slot > E, an absent canonical vault, and either F == 0 or time >= Dr.
  It zeros and shrinks Payment data, drains its SOL to the same creation funder,
  then assigns the account to the system program. A recreated or prefunded vault
  is rechecked during execution and blocks deletion.
- Refunds before Dr remain merchant-funded and can execute after vault closure.
  Payment cannot be deleted while a positive refund entitlement remains live.
- Tag 8 requires the expired identity and an empty system-owned retired Payment.
  It sends new SOL/token gifts and a recreated vault's rent to the fixed payer;
  it cannot infer an old rent recipient after that record has been deleted.
- Duplicate accounts, wrong destination, wrong PDA bump, overflow, wrong mint,
  unsafe token owner/delegate/close authority and malformed instruction data fail.

Cleanup is permissionless. Its transaction fee payer may differ from the original
funder; the cleaner cannot redirect rent. Full initial storage deposits are
recoverable when closure guards are satisfied. Network transaction fees are not
rent and are not refunded. A third party may delay cleanup by recreating or
funding a vault, but cannot redirect custody or remove held/refundable funds.

## One business order, one permanent reservation

The trusted merchant derives a stable business key from merchant identity and its
server-owned order ID. Salt, E, payer and PDA are not part of the reservation key.
The resource service authenticates the complete quote with an HMAC over v2 terms,
including the order key and expiry. The payer's transaction signature separately
provides economic consent. Editing the order ID in HTTP JSON cannot mint another
valid quote. Report manifests bind protocol, expiry, order ID and proof too.

`Facilitator.settle` and `V2OrderAuthorizer` use `V2OrderJournal`:

1. Validate the exact signed terms and trusted merchant identity. Existing order
   reservations are checked before mutable account/deadline preflight.
2. Atomically claim the stable business key with exclusive directory creation.
   Fsync the immutable request and its directory before sponsor signing.
3. Save the exact signed wire and signature durably before dispatch intent.
4. Save dispatch intent durably, revalidate custody, and send once.
5. Record AUTHORIZED only after the original finalized wire is verified and its
   observation is durably persisted. Otherwise retain UNKNOWN.

The journal has no release, retry, reset, TTL or resume-signing API. Its in-process
lease cannot be reconstructed after restart. Concurrent requests, including
requests with new E or salt, can claim at most one attempt. Partial writes,
SIGKILL, missing files, changed enrollment, malformed chains, fsync failures and
ambiguous receipts retain a blocking reservation. FAILED also remains reserved.
Original finalized receipts are evidence of one economic event, never permission
for duplicate fulfillment.

The runtime opens the same directory with a separately pinned enrollment and hash.
Network, genesis, program, merchant and the configured endpoint identity must match.
It never initializes a new journal at startup or silently changes RPC provider.
See [runtime configuration](../integration/README.md#runtime-setup). The supported
local filesystems are APFS/HFS and ext4/XFS/Btrfs. Independent replica disks,
network filesystems, lost custody or restoration of an older journal backup do not
provide this service guarantee and must not be treated as fresh authorization.

## UNKNOWN and preserved evidence

Account absence means neither "never paid" nor "successfully closed by our wire".
A valid authorization may have landed, been captured/refunded and later closed.
Expired E, expired blockhash, pruned history, a balance snapshot or another
closer's transaction does not prove the original request's outcome.

Original order records, locks, reservations, signed wires, signatures and submission
journals remain retained. The old mechanisms that classified an absent Payment as
an unfunded authorization and permitted a successor are removed from the server,
browser and ingress allowlists. Unsupported stored orders fail closed without
rewriting or deleting their evidence. Storage schema version 1, x402 v2 and named
campaign profiles are separate from the payment ABI version.

Reconciliation observes the original signature/evidence. It does not retry an
uncertain economic operation. Payer recovery requires an existing canonical v2
Payment with a positive hold, current finalized evidence and fresh explicit payer
consent. Missing Payment never enables a new payment or a guessed reclaim.
Paid-report delivery requires all original finalized proofs and durable result
persistence; missing required account evidence leaves the run blocked.

## Local validation

The [2026-11-12 Linux follow-up](linux-v2-validation-2026-11-12.md) records the
updated toolchain, the previously skipped platform checks and their exact scope.
The 2026-11-09 results below remain a historical record of the earlier artifact.

Build the single artifact with `scripts/build-sbf.sh`. It accepts Agave 4.4.0-rc.1 or 4.4.1 and pins
cargo-build-sbf 4.6.0, platform-tools v1.58 and SBPF v3. Solana's experimental
runtime ABI v2 is a separate feature and is not enabled. No dual artifact or
payment-protocol Cargo feature remains.

- `cargo test --locked`: unit guards, monetary invariants, 128 deterministic CU
  identities, replay/revival, close/deallocation and rollback scenarios.
- `python3 -B scripts/check_account_lifecycle_model.py`: bounded exhaustive model
  against reference monetary arithmetic, closure and replay invariants. It is not
  a proof of the runtime implementation.
- `npm run --prefix integration typecheck` and `npm run --prefix integration test`:
  real SBF integration, HTTP flows, order authentication, crash/restart, concurrent
  service instances, multiprocess journal races and file/fsync fault injection.
- `npm run --prefix integration test:agave`: disposable loopback Agave 4.4.0-rc.1,
  executable verified against the source artifact, real rent return/deallocation,
  rollback, gifts/dust, refund after vault close, concurrent independent facilitator
  processes and restart after closure with success or a deliberately lost response.

LiteSVM uses its own pinned embedded runtime/feature profile; its results are
reported separately from the actual Agave validator. The local validator loads
program bytes in genesis, uses generated temporary keys and contacts no external
RPC. These checks do not deploy, restart installed services, establish human wallet
acceptance or constitute an independent security audit.

### Recorded validation, 2026-11-09

The tested source is the uncommitted working tree based on
`a570ddee8063b2d560b7177195670b74d21c2884`, on macOS arm64 with host Rust 1.98.1,
Node.js 24.20.0 and Chromium 151.0.7922.34. The sole SBF artifact SHA-256 is
`6bf019b05825fc746e3cddb4d202869b5c72d33b7517dfb5f205ad50c71598bc`.

| Check | Result |
| --- | --- |
| Rust unit and LiteSVM suites | 84 passed; 1,024 measured operations across 128 identities |
| TypeScript integration | 1,912 passed, 94 skipped; typecheck passed |
| Python operator tooling | 289 passed, 29 skipped |
| Actual Agave 4.4.0-rc.1, feature set 3993424257 | 22 scenario checks passed, including 16 separate facilitator process invocations |
| Bounded lifecycle model | 708 states, 2,590 accepted edges, 9,702 reference comparisons, 1,080 failed-transfer checks |
| Browser fixtures | 66 payment-lab checks across five widths; 9 wallet reconnect checks, zero economic POSTs |
| Static/build checks | SBF build, wallet build, Rust formatting, Clippy with warnings denied, public-path scan and diff whitespace check passed |

Agave exercised success and lost-response UNKNOWN, competing processes, actual
Payment/vault deallocation, then fresh processes attempting the same order with
new E and salt. Each original order dispatched once; every subsequent attempt
was refused, and the original journal observation remained unchanged. Closing
the original 216-byte Payment and 165-byte vault returned 4,433,520 lamports of
storage deposits to the recorded funder under this validator's rent parameters.

The skipped integration checks require an explicitly configured nginx binary or
Linux native write/fsync fault tracing. The skipped operator checks require
Linux/root/systemd isolation. They were not executed on macOS. Browser fixtures
use synthetic wallet responses; real wallet/user acceptance remains unverified.
No deployment, external RPC transaction or installed-service change was performed.

Official runtime reference: [Agave v4.4.0-rc.1](https://github.com/anza-xyz/agave/releases/tag/v4.4.0-rc.1).
Account storage deposits and owner modification rules are described in the
[Solana account documentation](https://solana.com/docs/core/accounts).
