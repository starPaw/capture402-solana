# Operator and release source

All reusable build, deployment, provisioning and recovery tooling is developed in this public repository. Actual credentials, installed approvals, host inventories, economic records and historical archives remain private external data.

- [Release source and rollback](CD.md): exact source, review/CI gates, controller installation and transactional rollback.
- [Development environment](DEV.md): separate service profiles, renderers, attempts and read-only diagnosis.
- [Isolated runtime](E2E.md) and [bounded provisioning](E2E-PROVISION.md): snapshot closure, custody, network and per-action gates.
- [Faucet](DEVNET-FAUCET.md) and [stock operator](FAUCET-STOCK.md): distinct claim, quote, issue and observation boundaries.
- [Wallet-scoped demo](PUBLIC-MERCHANT-DEMO.md) and [paid resource](PAID_RESOURCE.md): application controls and isolated installation.
- [Development host helpers](remote/README.md): local toolchain and unconfigured preview.

## Trusted installation data

Both Python controllers and TypeScript runtime consumers read schema 1 at the fixed `/etc/capture402/operational-data.json`. They reject symlinks, writable or non-root-owned ancestry/files, malformed data and changed file identities/bytes. There is no request/environment policy-path override. Grant only intended service users read access; operational configuration must remain non-writable to them. The separately protected deployment record is fixed at `/etc/capture402/deployment-identity.v1.json` and must match the trusted `deploymentRecordSha256`.

No live configuration is included. Every consumer requires the fields for its own feature; absent optional feature data refuses that feature. No field can turn a synthetic test record into installed acceptance. Source fixes repository name `starPaw/capture402-solana`; the `repositoryId` is unassigned until repository creation. Live repository operations require a positive assigned integer and `repositoryPrivate: false`, then independently check GitHub's numeric metadata response. A namespace string alone is insufficient.

| Fields | Consumer and constraints |
| --- | --- |
| `schema`, `repository`, `repositoryId`, `repositoryPrivate` | Schema 1 and assigned public source identity; no fabricated ID/default |
| `deploymentRecordSha256`, `acceptedExecutableSha256`, `acceptedExecutableSizeBytes` | Exact accepted record/executable digest; acceptance is an external review, not a computed self-approval |
| `publicOrigin`, `devOrigin`, `e2eOrigin`, `paidOrigin`, `deploymentSshTarget`, `legacyReleaseRoot` | Approved environment endpoints and SSH/layout facts; public `.invalid` values are unusable examples |
| `sponsorAddress`, `merchantAddress`, `mintAddress`, `browserAddress`, `e2eApplicationRelease`, `acceptedExternalFunding` | Fixed runtime/campaign identities, exact source release and original funding evidence |
| `merchantDemoPolicy`, `b3RecoverySourceSha`, `b3RecoveryPolicy`, `authorizeAbandonPolicies`, `authorizeIsolationPolicy` | Explicitly reviewed application/recovery policy; ordered abandon policies preserve earlier boundaries; no general UNKNOWN retry |
| `preSignerStop` (`source`, `entry`, `manifest`) | Exact observed stop source and hashes; separate original-intent/closure/action checks still apply |
| `admissionContracts.orders`, `admissionContracts.relay-attempts` | Each selected kind requires its exact original `reference`, `initialMaximum` and ordered `migrations` (`step`, `archive`, `reason`, `oldMaximum`, `oldUsed`, `carryForward`, `newMaximum`). Recognized cap/history and every preceding archive are mandatory; foreign or partial history refuses. An empty migration list applies only to an independently reviewed genuinely unmigrated journal. |
| `nodeArchiveSha256`, `dependencyArchiveSha256`, `dependencyInventorySha256`, `nodeBinarySha256`, `nodeArchiveDirectory` | Authenticated interpreter/dependency snapshot bytes; directory is one plain archive entry |
| `providerHost`, `signerCustody` | Approved Helius/QuickNode hostname and signer role UID/GID; no public RPC fallback or guessed custody |
| `restaurantCustody` | Approved non-root restaurant UID/GID; the stopped isolation operator pins the exact owner, group, inode and 0700 mode of the orders directory before proof and archive creation |
| `campaignReference`, `paidMint`, `programId`, `programData`, `paidPrekeySource`, `nodeSourceUid` | Installation-specific approval/program/stop facts required by stock/paid installers; incomplete values refuse |

Credentials are separate protected files/environment inputs, never values in public examples or logs. Keep every original signed wire, signature, journal, lock and reservation. An absent transaction lookup does not establish non-execution. No automatic resend, provider switch, state reset or compensating economic action is authorized by these tools.

## Local validation

Run `python3 -B -m unittest discover -s ops -p 'test_*.py'` for synthetic offline checks. `ops/dev_check.sh` builds the SBF from current pinned source before integration tests. Marked disposable Linux drivers additionally require their explicit marker/hostname, separately staged interpreter/dependency/source fixture packages and synthetic installation policy. They must never run against a live host or actual operational record. Source compilation, unit tests and renderer checks do not establish live or Linux platform acceptance.

Hosted checks, publication, installation, restarts and economic actions each require their own authorization. No controller is installed by preparing or reviewing this source.
