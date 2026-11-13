# Reference integration

This directory contains the x402 facilitator, payment lab, fixed-price paid-report example, direct payer recovery tools and source-visible deployment tooling. All future implementation and maintenance take place in the public repository.

All runtime, SDK, application and recovery paths use the v2 payment protocol. V1 wire/account decoding and authorization-abandonment/isolation routes are removed. Stored evidence is never deleted or converted into a fresh authorization. Storage schema versions and named campaign profiles are independent of the payment protocol.

## Local validation

Install locked dependencies with `CXXFLAGS=-std=c++20 npm ci`, then run `npm run typecheck` and `npm test`. Build the SBF artifact from the repository root before LiteSVM-backed tests. `npm run build:wallet` rebuilds the Solflare browser bundle and retains complete dependency license notices. Native `fs-ext` requires a compatible compiler and Node headers; Use Node.js 26.13.1 LTS from the root `.nvmrc`; its native addons need C++20. The versioned `allowScripts` entries authorize only the reviewed locked native build scripts.

The required regression target is Agave 4.4.0-rc.1. Stable Agave 4.4.1 is also qualified: select its isolated CLI directory in `PATH` and set `CAPTURE402_TEST_AGAVE_VERSION=4.4.1`. Run `npm run test:agave` after building `scripts/build-sbf.sh` from the repository root to check that exact runtime in a temporary local ledger. This opt-in test owns its validator process, uses generated loopback ports and synthetic keys, submits each test transaction once, and removes its ledger after stopping the process. It accepts no external RPC endpoint and uses no installed wallet/configuration. The regular suite uses LiteSVM 1.6.2; simulator results alone do not establish compatibility with every Agave feature configuration.

[ABI builders](src/program.ts) and [lifecycle helpers](src/lifecycle.ts) require an explicit signed expiry E. The 75-byte authorize wire and 216-byte Payment share the same v2 identity in every component. The common facilitator co-signs only merchant-authenticated v2 offers and reserves the stable business order before accessing the sponsor signer. `extra` carries `protocolVersion: 2`, `authorizeUntilSlot`, `orderId` and `orderProof` in addition to the monetary terms. Quotes bind E to an observed cluster slot, never a guessed block height.

The [order journal](src/v2-order-journal.ts) permanently reserves `(namespace, businessOrderId)`, independently of payer, salt, E or PDA. All workers for the merchant must open the same enrolled local store. It retains original request, signed wire/signature, dispatch intent and finalized evidence. UNKNOWN and FAILED never release a reservation. No startup auto-initialization, directory recreation, TTL, reset or economic retry exists. APFS/HFS on macOS and ext4/XFS/Btrfs on Linux are supported; independent disks and network filesystems are not.

The [standalone authorizer](src/v2-order-authorizer.ts) uses the same store and accepts business IDs from trusted server storage. An existing order returns its original snapshot without signing or sending. `AUTHORIZED` proves only the original hold's finalized authorization. It does not prove capture or delivery. Low-level builders and direct transactions bypass the service's business-order boundary.

`npm test` includes SDK, HTTP service, restart, multiprocess contention, SIGKILL and write/fsync fault tests. `npm run test:agave` also runs separate facilitator processes against the disposable validator, closes the winning Payment, restarts the services and refuses fresh E/salt attempts even after a lost response.

The complete Linux suite runs with `scripts/test-linux-v2.sh` from the repository
root in an explicitly marked disposable systemd VM. It requires installed nginx,
strace, locked dependencies, the current SBF artifact and a non-root fixture user
selected by `CAPTURE402_LINUX_TEST_USER`. Set `CAPTURE402_E2E_DISPOSABLE=1` only in
that VM. The root-owned regular marker `/etc/capture402-e2e-disposable` must contain
`DISPOSABLE_SYNTHETIC_E2E_TEST_ONLY` and must not be group/world writable. Never
place the marker on an operational machine. The runner uses durable `/var/tmp`
storage, rejects tmpfs, and fails if either test suite skips a check. It prints the
private evidence directory containing the environment and integration results.

The two-phase `test/fixtures/v2-vm-restart.ts` fixture separately verifies a real
VM reboot: run `prepare` as the fixture user against a new owned 0700 directory,
reboot only the disposable VM, then run `verify` against that same directory. It
checks a changed kernel boot ID, unchanged original journal bytes and eight
concurrent workers refusing a second authorization. Preserve that directory
between phases; do not recreate it or replace its enrollment.

Web3.js stays at 1.98.4 because the current Solflare SDK requires synchronous
transaction serialization. The checked overrides use jayson 5.0.0 and UUID 11.1.1
to remove vulnerable transitive dependencies. The optional macOS fsevents install
script is explicitly denied; the non-watch test and build commands do not need it.
See the [tool assessment and Linux results](../docs/linux-v2-validation-2026-11-12.md).


Browser checks require an existing Playwright installation and Chromium. Set each module variable to the absolute local `playwright/index.mjs` path and each output variable to a private directory outside the repository. The fixtures serve loopback only and reject external requests.

```sh
HOMEPAGE_PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" HOMEPAGE_QA_OUTPUT="$QA_OUTPUT/homepage" node --experimental-strip-types browser/homepage-check.mjs
GUIDE_PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" GUIDE_QA_OUTPUT="$QA_OUTPUT/guide" node --experimental-strip-types browser/guide-check.mjs
RESTAURANT_PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" RESTAURANT_QA_OUTPUT="$QA_OUTPUT/restaurant" node --experimental-strip-types browser/restaurant-check.mjs
RESTAURANT_PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" RESTAURANT_QA_OUTPUT="$QA_OUTPUT/wallet" node --experimental-strip-types browser/wallet-reconnect-check.mjs
```

These are DOM fixtures, not live-wallet acceptance. Keep screenshots, logs and receipts outside Git until individually reviewed.

The Circle browser fixture also supports `SAC006_TEST_NGINX=/absolute/path/to/nginx`: run `browser/circle-usdc-check.mjs` with the restaurant Playwright/output variables above. It starts an isolated HTTPS proxy on a temporary loopback port using the checked-in E2E routes, preserving the HTTP method and path rules. Synthetic status/order responses pass through nginx rather than browser request interception; the fixture performs no signing or POST. Set `SAC006_TEST_NGINX` for `npm test` to exercise the ingress tests, and `SAC006_TEST_NGINX_ISOLATED_PORTS=1` when fixed fixture upstream ports are occupied. No installed nginx configuration or service is used.

## Runtime setup

Every facilitator/operator that can authorize requires these explicit settings:

- `SAC006_V2_ORDER_JOURNAL_DIR`: the original shared enrolled directory.
- `SAC006_V2_ORDER_ENROLLMENT_PATH`: a separately retained enrollment pin outside that directory.
- `SAC006_V2_ORDER_ENROLLMENT_SHA256`: SHA-256 of the exact pin file bytes in trusted configuration.
- `SOLANA_RPC_URL`: the approved endpoint; enrollment `providerId` is `orderProviderId(endpoint)`, binding its exact spelling without disclosing it.
- `SAC006_BEARER_TOKEN`: the trusted resource/facilitator secret also authenticating order quotes. This MAC does not replace payer consent.

Enrollment is a separate, explicit offline action using `initializeV2OrderJournal(newPath, binding)`. Preserve its returned enrollment in the external pin and configure its hash. Runtime only opens and verifies existing custody. Never create an empty replacement, rotate namespace to clear orders, or roll back an old backup. Existing private runtime/acceptance files are not migrated by changing source. No live installation or deployment is performed by local tests.

Run `node --experimental-strip-types src/presentation-preview.ts` from `integration/` for an unconfigured, loopback-only preview on port 18788. It exposes the public presentation and returns 503 for economic API routes; it reads no installed acceptance data or credentials. The configured restaurant server retains its mandatory trusted deployment checks. Economic services require independently accepted deployment data, source-built executable bytes, configured network identity, private credentials and isolated durable storage. See [deploy/README.md](deploy/README.md) and the validated schema in [src/operational-data.ts](src/operational-data.ts). Operational policy uses the fixed administrator-owned `/etc/capture402/operational-data.json` trust boundary; caller-controlled configuration must not replace trusted acceptance.

Keep service keys, provider endpoints, installed deployment records, journals, original signed wires, receipts and user data private. Configure trusted Helius or QuickNode endpoints explicitly. Do not fall back to public RPC, change providers after an uncertain send, refresh a blockhash or manufacture a new payment to bypass an unresolved outcome. Setup instructions do not authorize live signing, funding or deployment.

## Paid report

`prepareReport`, `submitReport`, `retrieveReport` and `readPaidReport` in [src/paid-report-client.ts](src/paid-report-client.ts) implement the client side. Independently validate the quote, policy, manifest and complete unsigned message before accessing a signer. One authorization funds 100 test tokens, then merchant-signed operations capture 40, capture 25 and release 35. These are fixed synthetic-demo prices, not usage metering.

The application verifies all four original finalized transactions and expected token/account effects and durably saves the complete immutable response before delivering both artifacts. There is no per-stage delivery. Authenticated retrieval reads the same saved result and does not retry economics. Incomplete or UNKNOWN runs retain their original reservations; all new report payments may remain blocked indefinitely. Live UNKNOWN-CAPTURE recovery remains unsupported and must refuse execution. Use separate report and lab storage/coordination domains.

## Wallet-signed direct reclaim

At or after the original capture deadline, the payer can reclaim a positive unused hold directly through the program. This needs the original payment identity, independently trusted deployment/network, trusted RPC, canonical token accounts and payer funds for the network fee. Merchant consent is not required. Expiry itself sends no transaction.

Use [src/reclaim-offer-cli.ts](src/reclaim-offer-cli.ts) to prepare the unsigned offer and review its digest before signing. Preserve the exact reviewed message, offer, signed wire and journal. Submit the original signed bytes once; after uncertainty observe the original signature and retain the reservation. Missing history is not proof of non-execution. [src/reclaim.ts](src/reclaim.ts) is the direct payer CLI. Review each CLI's required arguments and validation before use. Browser reclaim uses application routes and is not a demonstration of recovery with that server unavailable.

Refund is different: before the refund deadline the merchant funds it from its own token account, bounded by captured, unrefunded value. It needs merchant consent and liquidity and never restores the authorization budget.

The reproducible [offline recovery/refund scenarios](RECOVERY-OFFLINE.md) cover
the existing payer-only route, SOL shortage, captured-fund preservation, merchant
authority/liquidity and lost responses. They define the private deployment-binding
checklist for SingIt PR #23; they do not authorize or accept live recovery.

## Circle USDC payment lab

The optional `circle-usdc-v1` profile distributes 0.50 Circle Devnet USDC and authorizes a maximum of 0.10 USDC for the payment lab, with 0.04 and 0.025 captures and a 0.035 release. The normal-path refund example is 0.01 USDC. A root-owned profile approval, separately approved campaign budget, dedicated pre-funded treasury, isolated storage and explicitly approved QuickNode Devnet endpoint are required. The custom test-token profile remains the default; both profiles use payment protocol v2. The separate paid-report example retains its existing amounts. See [Circle setup](../ops/CIRCLE-USDC-SETUP.md) for configuration fields, policy hash boundaries, manual Circle Faucet funding and separately authorized live verification.
