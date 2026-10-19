# Isolated development environment

deploy_dev.py manages isolated development releases, retained deployment attempts, read-only diagnosis and explicit same-signature reconciliation. dev_environment.py renders separate service and environment templates. dev_bootstrap.sh prepares a reviewed checkout and dev_check.sh builds the current SBF source before local tests. Runtime keys, journals and accepted deployment records are external inputs.

## Trusted installation boundary

Live controller entrypoints require `/etc/capture402/operational-data.json`: schema 1, root-owned regular file with a non-writable, symlink-free ancestry. Source code fixes `starPaw/capture402-solana`; the assigned numeric repository ID must be supplied by trusted installation policy after repository creation, together with `repositoryPrivate: false`. An absent or inconsistent identity refuses before network or runtime effects. No caller-controlled policy path or environment fallback can approve a release.

The deployment record lives at `/etc/capture402/deployment-identity.v1.json` and must match the trusted `deploymentRecordSha256`. Runtime accounts, endpoints, approved artifact hashes, source/campaign/stop identities, signer UID/GID, credentials and original approvals are private installed data. Public source supplies their validators and tools. Never package these private files, an accepted binary, historical Git objects or runtime journals into a source release.

## Safe use and validation

Inspect each command's argument parser and the installed policy before use. Preparation, installation, service restart, funding and economic submission need separate explicit authority. Preserve original wires, signatures, locks, reservations and receipts. Missing history or a timeout never proves non-execution. Do not clear, resend, change providers or substitute a new blockhash to bypass UNKNOWN.

Run local deterministic checks using `python3 -B -m unittest discover -s ops -p 'test_*.py'`, the Rust scripts and the integration tests. Linux-only systemd/nginx/strace tests require disposable hosts and explicit test flags. Skipped platform tests are not acceptance. Offline fixtures are synthetic; they cannot serve as an installed approval or real transaction receipt.
