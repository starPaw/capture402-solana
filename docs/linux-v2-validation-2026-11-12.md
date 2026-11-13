# V2 Linux validation and tool assessment, 2026-11-12

This record covers the uncommitted v2 working tree based on
`a570ddee8063b2d560b7177195670b74d21c2884`. It supersedes the platform skips in
the [November 9 record](account-lifecycle-v2.md#recorded-validation-2026-11-09),
without changing that historical record. All keys, orders and transactions were
synthetic. No deployment, hosted workflow, live RPC, wallet payment or installed
operational-service change was performed.

The tested code/configuration fingerprint is
`40201a999eae49d6071fa70dd6c54e71d1c30861756fe1b8dd68a5ff4d010642`.
It hashes the sorted compact JSON map of 342 non-Markdown source-file names to
their SHA-256 values, excluding ignored and deleted files. The private evidence
manifest retains the complete map; Markdown edits do not change this fingerprint.

## Tool decisions

Official release information and locked dependency metadata were checked before
updating. The required release candidate remains a separate regression target.

| Component | Qualified version / decision |
| --- | --- |
| Agave | 4.4.0-rc.1 retained; stable 4.4.1 additionally tested |
| Host Rust | 1.99.1, pinned in `rust-toolchain.toml` |
| SBF builder | cargo-build-sbf 4.6.0, platform-tools v1.58, SBPF v3 |
| SBF Rust | 1.95.0 from platform-tools; separate from host Rust |
| Node.js / npm | 26.13.1 LTS / bundled 11.20.0; Node pinned in `.nvmrc` |
| TypeScript / Vitest / esbuild | 7.0.2 / 5.1.0 / 0.28.2 |
| Rust / Node LiteSVM | 0.18.2 / 1.6.2; Rust embedded runtime remains Agave 4.3.2 |
| nginx | 1.31.8 mainline, compiled only inside the disposable Linux VM |
| Solana Kit / system / token clients | 8.6.0 / 0.16.0 / 0.18.0 |
| Hono / Node adapter | 4.13.18 / 2.1.8 |
| Web3.js / Solflare SDK | 1.98.4 / 1.4.2 retained for wallet compatibility |

Web3.js 3.2.1 was evaluated but changes transaction serialization to an asynchronous
API. The current Solflare SDK still consumes the synchronous API. The compatible
Web3.js version therefore remains pinned. Overrides select jayson 5.0.0 and UUID
11.1.1, removing the affected transitive dependencies. The final npm audit reports
**zero known vulnerabilities**; this is the registry audit result, not a security
certification. The reviewed install-script policy names exact package versions.
Library version numbers do not re-enable payment protocol v1.

Release sources: [Agave 4.4.1](https://github.com/anza-xyz/agave/releases/tag/v4.4.1),
[SBF builder 4.6.0](https://github.com/anza-xyz/cargo-build-sbf/releases/tag/cargo-build-sbf%40v4.6.0),
[platform-tools v1.58](https://github.com/anza-xyz/platform-tools/releases/tag/v1.58),
[Rust 1.99.1](https://blog.rust-lang.org/2026/10/15/Rust-1.99.1/),
[Node 26.13.1](https://nodejs.org/en/blog/release/v26.13.1),
[nginx releases](https://nginx.org/en/download.html),
[LiteSVM 0.18.2](https://github.com/LiteSVM/litesvm/releases/tag/v0.18.2),
and [Web3.js 3.2.1](https://github.com/solana-foundation/solana-web3.js/releases/tag/v3.2.1).

## Fixes and added checks

- Node 26 removed the old type-transform flag. Crash workers now use native type
  stripping; a TypeScript parameter property was rewritten as an explicit field.
  `erasableSyntaxOnly` catches unsupported syntax during typechecking. Worker
  stderr is included in failed crash assertions.
- The faucet status handler is explicitly asynchronous to satisfy the updated
  Hono/TypeScript handler contract. Economic behavior is unchanged.
- The wallet bundler emits escaped multiline strings, preserving their values
  while avoiding trailing spaces from dependency template literals. Its generated
  JavaScript and license notice files match byte-for-byte on Linux and macOS.
- The manual workflow no longer invokes the deleted v1 isolation-custody test.
  A source check validates any explicitly named workflow test files. The paid
  runtime preparation tool requires the qualified Node version before staging;
  it does not install or replace an operational interpreter.
- Root/systemd tests accept an explicitly marked disposable VM as well as the
  existing disposable CI runner. Marker ownership, file type and permissions are
  checked. The Linux runner fails on skipped tests.
- Debian 13 can place `/tmp` on tmpfs. Journal tests use ext4-backed `/var/tmp`;
  rejection of volatile and unsupported storage remains intact.
- Thirteen new native EIO cases cover reservation-directory persistence and the
  write, file-fsync and directory-fsync boundaries of claim, signed wire,
  dispatch intent and observation. Restarted processes retain UNKNOWN and cannot
  sign or dispatch another authorization with a new expiry or salt.
- A two-phase fixture checks a real kernel boot-ID change and then races eight
  fresh processes against the same permanent order reservation. Original file
  hashes, snapshot, signature count and submission count must remain unchanged.

## Environment and evidence

Linux application/platform checks used a dedicated Debian 13 arm64 VM, kernel
6.12.116+deb13-arm64, ext4, systemd 257.13, strace 6.13 and nginx 1.31.8. Application
tests ran as a non-root fixture user. Privileged operator tests used randomized
temporary service names, synthetic installation data and loopback listeners.
The host ran macOS arm64. The sole program artifact SHA-256 is:

```
4dfa82968abaadb927e4d27ba5df4f82aefbe5a3afc66ef14072cd9530c83769
```

| Check | Result |
| --- | --- |
| Linux TypeScript / nginx / native fault suites | 2,019 passed in 77 files; zero skipped; typecheck passed |
| Linux operator / root / systemd suites | 320 passed; zero skipped, including all 29 formerly skipped checks |
| Rust unit and LiteSVM suites | 84 passed; zero ignored |
| Native order-journal EIO cases | 13 passed, included in the Linux total |
| Actual VM reboot | UNKNOWN and original journal bytes retained; eight competing processes; zero new signatures/submissions |
| Actual Agave 4.4.0-rc.1, macOS arm64 | 22 scenario checks and 16 facilitator process invocations passed; feature set 3993424257 |
| Actual Agave 4.4.1, macOS arm64 | Same 22 checks and 16 process invocations passed; feature set 2681577653 |
| Bounded lifecycle model | 708 states, 2,590 accepted edges, 9,702 reference comparisons, 1,080 failed-transfer checks |
| Browser fixtures | 66 payment-lab checks across five widths; nine reconnect checks, zero economic POSTs |
| Final wallet build follow-up | Matching Linux/macOS bundle hashes; 216 focused wallet/application checks passed on Linux; typecheck passed |
| Build/static checks | SBF and wallet builds, Rust formatting, Clippy with warnings denied, shell syntax, public-path scan and whitespace check passed |
| Dependency audit | Zero known npm vulnerabilities; no unreviewed install scripts |

Both actual Agave versions executed rent return, real account deallocation,
replay/revival rejection, refund after vault closure, atomic rollback, success and
lost-response UNKNOWN, parallel requests and fresh facilitator processes after
closure. Changing E or salt never caused a second service dispatch for the same
business order. Under both tested rent profiles, closing the original Payment and
vault returned 4,433,520 lamports to the recorded funder. Transaction fees remain
separate and non-refundable.

Raw local test logs, the integration JSON report, tool metadata and synthetic
reboot journals are retained privately outside tracked source. The Linux runner
prints its evidence location. The earlier transfer attempt included macOS
AppleDouble metadata; the source transfer was corrected to exclude extended
attributes. A later optional-tool download exhausted temporary host space; only
regenerable build/download caches were cleared. The original reboot journal was
kept and verified again after the test VM restarted.

## Explicit limits

The actual Agave validator passes above are **on macOS**, not Linux. The official
Linux x86_64 4.4.0-rc.1 binary was checksum-verified and started through QEMU user
emulation in the arm64 VM. It stopped before transactions because `io_uring`
returned ENOSYS and Agave asserted that support was required. Inspection of
[QEMU 11.1.2's syscall dispatcher](https://github.com/qemu/qemu/blob/v11.1.2/linux-user/syscall.c)
also found no io_uring syscall implementation. This is an environment-blocked
check, not a successful Linux-validator run. Completing it requires a separate
Linux x86_64 test machine with working io_uring. No Agave storage guard was patched
or bypassed to obtain a passing result.

The SBF build succeeds but cargo-build-sbf 4.6.0 emits `Invalid syscall code 65537`.
Inspection found that its local diagnostic passes the whole unstripped ELF to an
instruction-byte verifier. The matching byte sequence is at file offset 123376
inside `.symtab`, outside `.text` (7432 through 122703). This indicates a false
diagnostic from treating metadata as instructions. The stripped artifact is
accepted by LiteSVM and both actual Agave validators. The warning remains visible;
no upstream fix or warning-free build is claimed.

Business-order deduplication is limited to workers using the same enrolled service
store. Direct on-chain transactions bypass that business-order policy, as chosen
for full rent recovery. UNKNOWN remains blocking; absent accounts, expired E or a
closed Payment never authorize another payment. The checks do not establish
power-loss behavior for every storage device, real-wallet acceptance, native
Linux x86_64 validator acceptance or an independent security audit.
