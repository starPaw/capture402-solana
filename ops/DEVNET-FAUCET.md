# Bounded Devnet token claims

The faucet implementation provides fixed challenge/claim routes, wallet consent, durable daily admission and sponsorship limits. Browser requests pass through a trusted loopback proxy. Credentials, pool accounts and live campaign policy stay in private installation data; examples must use synthetic accounts. A claim response is not proof of finalized token delivery.

## Trusted installation boundary

Live controller entrypoints require `/etc/capture402/operational-data.json`: schema 1, root-owned regular file with a non-writable, symlink-free ancestry. Source code fixes `starPaw/capture402-solana`; the assigned numeric repository ID must be supplied by trusted installation policy after repository creation, together with `repositoryPrivate: false`. An absent or inconsistent identity refuses before network or runtime effects. No caller-controlled policy path or environment fallback can approve a release.

The deployment record lives at `/etc/capture402/deployment-identity.v1.json` and must match the trusted `deploymentRecordSha256`. Runtime accounts, endpoints, approved artifact hashes, source/campaign/stop identities, signer UID/GID, credentials and original approvals are private installed data. Public source supplies their validators and tools. Never package these private files, an accepted binary, historical Git objects or runtime journals into a source release.

## Safe use and validation

Inspect each command's argument parser and the installed policy before use. Preparation, installation, service restart, funding and economic submission need separate explicit authority. Preserve original wires, signatures, locks, reservations and receipts. Missing history or a timeout never proves non-execution. Do not clear, resend, change providers or substitute a new blockhash to bypass UNKNOWN.

Run local deterministic checks using `python3 -B -m unittest discover -s ops -p 'test_*.py'`, the Rust scripts and the integration tests. Linux-only systemd/nginx/strace tests require disposable hosts and explicit test flags. Skipped platform tests are not acceptance. Offline fixtures are synthetic; they cannot serve as an installed approval or real transaction receipt.

## Circle Devnet USDC profile

See [Circle USDC setup](CIRCLE-USDC-SETUP.md) for the separately approved `circle-usdc-v1` payment lab. It uses QuickNode through the existing `SOLANA_RPC_URL` and standard Solana RPC, and transfers 500000 units (0.50 USDC) from a dedicated pre-funded treasury. Circle Faucet funding is manual; QuickNode is not a USDC issuer. The fixed mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` with six decimals under the classic SPL Token Program.

Claims retain wallet message authorization, 24-hour cooldown, a maximum of 100 durable admissions, the separately approved token ceiling (at most 50 USDC), available treasury liquidity, native fee/rent budget, one signed original wire and finalized receipt verification. Refused/failed/uncertain admissions conservatively consume allowance. UNKNOWN retains all original custody and stops new economics. Recipient ATA creation is idempotent; token transfer uses `transferChecked`. No mint authority is loaded.

The existing schema-1 custom-token policy, state and legacy 100-token payment lab remain compatible. Circle requires a new schema-2 immutable policy, a root-owned profile approval and isolated Circle state; never alter existing policies or historical receipts in place. Public API routes remain compatible; the added read-only `/api/faucet/status?recipient=PUBLIC_ADDRESS` reports low treasury liquidity, cooldown, UNKNOWN and unavailable RPC. Claim replies display success only after original finalized proof. Status does not authorize a transfer.
