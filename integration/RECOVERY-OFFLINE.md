# Offline payer reclaim and merchant refund scenarios

Companion to SingIt Agent Pay MVP-05/MVP-08 and journal/runtime PR
[#23](https://github.com/bubon-ik/singit-agent-pay/pull/23), head
`643dac3070b97677e24ce7c457ced924f82839e2`. This procedure prepares local evidence;
it accepts no live deployment, payer key, RPC configuration or operational run.
The default merchant profile remains mock.

## Local commands

Use the pinned Rust 1.90.0 toolchain, cargo-build-sbf 2.2.14/platform-tools v1.53,
Node 24 and existing locked dependencies. Run from this public checkout:

```sh
cargo-build-sbf --tools-version v1.53 --arch v0 -- --locked --offline
cargo test --locked --offline --test sac001 --test sac002 --test sac003
npm --prefix integration run typecheck
npm --prefix integration run test:recovery:offline
python3 -B ops/check_local_paths.py
```

The test command selects only synthetic fixtures. LiteSVM executes the current
source-built SBF. Recovery identity tests inject RPC responses; they do not open
a provider endpoint. Fixtures may bind ephemeral loopback HTTP ports. Missing
dependencies, a missing SBF or blocked loopback are failed prerequisites, not
SKIPPED successes. Linux process/filesystem acceptance remains separate.

## Executable economic scenarios

`test/mvp-recovery-offline.test.ts` covers a 1,000,000-unit authorization and
650,000-unit capture using disposable local keys and token accounts:

| Case | Required result |
| --- | --- |
| Before Dc / at Dc | Early reclaim refuses with no journal/send. Advancing Clock alone moves no tokens. Payer reclaim at Dc returns exactly H=350,000; merchant balance and F=650,000 remain unchanged |
| Payer-only signing | Reclaim fee payer and sole signer are the stored payer. No merchant/facilitator route is called; another payer refuses before send |
| Insufficient SOL | Unsigned simulation fails before a submission/reservation; all payment/token state remains unchanged |
| H=0 after full capture | No reclaim receipt, journal entry or send. Captured value remains F=1,000,000; H=0 does not demonstrate repayment |
| Lost reclaim response after landing | Saved wire/signature equal the submitted transaction. Reopened journal retains `submit-threw`; H=0 cannot resolve the original or create a successor |
| Ambiguous reclaim with positive H | Reopened journal retains the exact original wire/signature and unresolved outcome. A new blockhash does not permit a second submission or free the positive hold |
| Refund after reclaim | Independent merchant-funded 100,000 refund changes F to 550,000, moves merchant ATA to payer ATA, and leaves H=0, vault and immutable maximum unchanged |
| Missing merchant signature | Refund is refused before submission with no account changes |
| Merchant liquidity shortage | Token simulation refuses before submission and preserves captured F and all accounts |
| At Dr | Refund is refused before submission; the refund deadline is strict |

The focused command also runs existing reclaim offer, crash, race, journal and
synthetic deployment-identity suites. `sac001`/`sac002`/`sac003` provide on-chain
authority, deadline, expected-(H,F), liquidity/CPI rollback and contention checks.
SingIt adds service accounting, original operation-ID/receipt recovery, transport
roles, budget preservation and byte-preserving v1/v2 journal/runtime checks.
The tests do not replace one another or prove live economic finality.

## Bind the existing operator route before any live use

The existing direct payer CLI is `src/reclaim.ts`; unsigned-offer review is
`src/reclaim-offer-cli.ts`. Neither is an MCP tool. The ordinary route pins an
accepted deployment record, constructs `RpcLedger`, checks genesis and deployment,
uses stored payer/server/mint terms and simulates before journaling/submission.
The low-level `submitReclaim` function receives a trusted ledger/program; it
cannot independently establish an external operator approval or wallet custody.

Prepare the following cross-repository binding in the private run packet. An
unfilled or mismatched field leaves operational recovery unaccepted:

| Capture402 identity/input | Must agree with SingIt and original evidence |
| --- | --- |
| Independently accepted deployment-record digest and source/artifact identity | Selected existing deployment; source/ABI relationship reviewed, not inferred from a matching address |
| Network CAIP-2 and full genesis hash | Selected Solana devnet network |
| Program, loader, ProgramData, deployment slot, executable bytes/digest/size, upgrade authority | SingIt deployment pin and a recorded no-upgrade policy for the verification window |
| Mint and token program | Original hold mint, six decimals and canonical classic SPL Token accounts; never a token selected after failure |
| Payment PDA, payer, merchant, salt, immutable maximum, Dc/Dr | Original mandate/business intent, hold operation ID, authorized wire and stored on-chain terms |
| Approved RPC configuration identifier | Same approved provider; credentials remain private and absent from agent context/logs |
| Payer key path and SOL fee readiness | Existing payer identity, local signer only, explicit fee/attempt cap; no merchant consent needed |
| Journal and operational custody | Retained originals, same wallet namespace, no active competing runtime, no unresolved original action |

The two executable digest fields have different definitions. Capture402's
deployment record hashes `executableSize` bytes after the 45-byte ProgramData
metadata and independently requires all remaining allocation bytes to be zero.
SingIt's `SINGIT_EXECUTABLE_SHA256` hashes the complete payload after that
metadata, including allocation padding. Record both digests, source size and
payload size; independently verify the source-sized bytes and zero padding.
Matching deployed identity requires this byte-level linkage, not literal equality
of the two hashes when padding is present. Do not copy one digest into both pins.

Do not manufacture an acceptance record, install policy, substitute fixtures for
an installed record, start a controller or read a wallet key to fill this table
while doing offline preparation. A live read-only preflight itself needs the
separate operational authorization specified in the runbook.

Reclaim authorization names one positive remaining hold at/after Dc and its
fee/attempt cap. It is separate from the normal purchase's one authorize plus
one atomic capture. This MVP procedure excludes the CLI's `--retry-after` and
`--blockhash-slot` continuations. Pending, missing history, expired blockhash or
an absent/zero account never independently permits another send. Preserve the
originals and stop on uncertainty.

The installed deployment and namespace must be checked again under that
authorization; synthetic identity tests are insufficient. Reclaim success must
be accepted from the particular original finalized outcome and exact token
effects. It does not automatically update SingIt's journal or restore a mandate.
Captured funds require a separate merchant-funded refund before Dr, with merchant
authority, liquidity and fees; they are not recoverable by payer reclaim.
