# Reference integration

This directory contains the x402 facilitator, payment lab, fixed-price paid-report example, direct payer recovery tools and source-visible deployment tooling. All future implementation and maintenance take place in the public repository.

## Local validation

Install locked dependencies with `CXXFLAGS=-std=c++20 npm ci`, then run `npm run typecheck` and `npm test`. Build the SBF artifact from the repository root before LiteSVM-backed tests. `npm run build:wallet` rebuilds the Solflare browser bundle and retains complete dependency license notices. Native `fs-ext` requires a compatible compiler and Node headers; Node.js 24 needs C++20.

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

The optional `circle-usdc-v1` profile distributes 0.50 Circle Devnet USDC and authorizes a maximum of 0.10 USDC for the payment lab, with 0.04 and 0.025 captures and a 0.035 release. The normal-path refund example is 0.01 USDC. A root-owned profile approval, separately approved campaign budget, dedicated pre-funded treasury, isolated storage and explicitly approved QuickNode Devnet endpoint are required. Legacy mode remains the default; the separate paid-report example retains its existing amounts. See [Circle setup](../ops/CIRCLE-USDC-SETUP.md) for configuration fields, policy hash boundaries, manual Circle Faucet funding and separately authorized live verification.
