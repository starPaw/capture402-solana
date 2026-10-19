# Circle Devnet USDC payment lab

This profile is implemented source, not an installed campaign, deployment approval or funded-wallet acceptance. No program change, redeployment or upgrade authority is needed. Obtain separate owner approval for the exact source, installed configuration, service changes, treasury funding and each bounded live test. Do not enable hosted Actions as part of setup.

## Network, assets and amounts

The `circle-usdc-v1` profile requires Solana Devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, CAIP-2 network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, program `992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o`, and Circle mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. The mint must be initialized, have six decimals and belong to the classic SPL Token Program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.

| Operation | Atomic units | USDC |
| --- | ---: | ---: |
| Faucet transfer | 500000 | 0.50 |
| Authorization maximum | 100000 | 0.10 |
| First capture | 40000 | 0.04 |
| Second capture | 25000 | 0.025 |
| Release after both captures | 35000 | 0.035 |
| Normal-path partial refund | 10000 | 0.01 |

The refund scenario refunds the full first capture (0.04), then releases the unused 0.06. The normal scenario allows the separate 0.01 refund only after both captures and release. Atomic capture transfers 0.04 and releases 0.06 in one program instruction. Partial capture followed by payer reclaim returns the remaining 0.06 at/after the original capture deadline. Void returns an eligible positive unused hold. Refunds are merchant-funded, bounded by captured/unrefunded value, and never replenish the authorization budget. Deadlines remain 150 seconds from offer generation and a refund window 30 seconds later; expiry itself moves nothing.

## QuickNode transport and manual funding

Configure the existing secret `SOLANA_RPC_URL` with the separately approved QuickNode **Solana Devnet** HTTPS endpoint. Standard `*.quiknode.pro` endpoints are required for this profile; custom domains need a separately reviewed source change. The existing `SAC006_E2E_RPC_POLICY_PATH` root-owned record must bind the exact endpoint SHA-256, accepted deployment-record SHA-256 and Devnet genesis. Never put endpoint credentials in a URL shown to users, logs, public examples or Git. Never switch providers following an uncertain send.

The runtime uses the existing `@solana/kit`, `RpcLedger` and `rpcBackend`: standard Solana account/fee/rent/blockhash queries, `sendTransaction` with `maxRetries: 0`, status observation and original finalized transaction lookup. Startup verifies both genesis and accepted executable identity. Circle claims and new payment operations repeat that identity check. No QuickNode SDK or new dependency is introduced. QuickNode supplies RPC and may support rate-limited Devnet SOL `requestAirdrop`; it does not issue USDC, and this implementation never calls an EVM x402 drip endpoint or a fictional USDC airdrop API.

1. Choose a dedicated campaign treasury/sponsor keypair and a distinct merchant wallet. Keep the treasury out of payer wallets and unrelated campaigns. This implementation intentionally uses that dedicated treasury as the campaign fee payer too; no additional key is loaded by the faucet.
2. After funding approval, open [Circle Faucet](https://faucet.circle.com/) manually, select **Solana Devnet / USDC**, and enter the approved treasury public address. Observe Circle's current limits. Do not scrape it or automate refills. Do not mint tokens or create a replacement mint.
3. Using only the approved endpoint, verify the returned funding signature at finalized commitment, the exact mint and treasury ATA. Retain funding evidence privately. Confirm the canonical treasury ATA contains sufficient USDC. Request Devnet SOL separately for treasury fees/recipient ATA rent, and for payer-direct reclaim fees; token balances cannot pay those fees.
4. Record a token distribution ceiling between 500000 and 50000000 atomic units, and approve the native sponsorship campaign ceiling separately. A full 100-claim campaign would distribute 50 USDC; available liquidity and the approved ceiling can allow fewer claims. Refill increases liquidity only: it never resets quota, cooldown, spending approvals or journals.

Official references: [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [Circle Faucet](https://faucet.circle.com/), [QuickNode getGenesisHash](https://www.quicknode.com/docs/solana/getGenesisHash), [QuickNode requestAirdrop](https://www.quicknode.com/docs/solana/requestAirdrop). Recheck issuer/provider documentation during live preparation; offline tests are not a live provider availability check.

## Trusted approval and isolated custody

Two independent installation slots are available. Set `SAC006_CIRCLE_INSTALLATION=main` on both main-site services to select `circleUsdcMainDemoProfile`, `circleUsdcMainAdmissionContracts` and `circleUsdcMainCustody` in the same fixed root-owned policy. Main uses the fixed namespace `/var/lib/capture402/circle-usdc-v1/`. Unset or `e2e` retains the original three `circleUsdc*` records and `/var/lib/capture402-e2e/circle-usdc-v1/` byte-for-byte. Unknown selectors and missing/malformed selected approvals refuse; there is no fallback. The selector grants no authority and cannot choose policy paths. Both slots must use distinct origins, treasuries and merchant keys. Every approved treasury is protected against legacy-profile downgrade regardless of the selected slot or key filename.

Use separate service users, keys, ports, native/token budgets, admission journals and all eight custody directories for main. The bindings below describe E2E; replace only the namespace with the fixed main namespace for main's separately approved installation. Never copy initialized state or reset quotas. Write journals and budget records as the intended service user, including operator setup operations, so strict custody ownership remains valid.

The separately installed main public ingress template is `integration/deploy/main/nginx-public-demo.conf`, with restaurant upstream `127.0.0.1:8898`. Define its independent HTTP-scope POST-only `capture402_main_public_post` map and `capture402_main_demo_public` limit zone at 20r/m. Preserve the main maintenance guard and TLS configuration. Keep facilitator ingress private and disable upstream retries. The legacy `capture402 deploy` controller refuses to replace ingress marked `X-Capture402-Environment main-circle`; future Circle updates require a separately reviewed installation that preserves the original journals, directory identities and policy hashes. Enabling the main profile requires an explicit operator cutover; publishing this source does not enable it.

Before the main cutover, back up and inspect the complete existing HTTPS server and include. If the server already has a `location / { return 404; }` fallback outside the managed include, remove only that duplicate block when installing the new template: the template owns the same deny-by-default fallback. Keep exactly one fallback, the maintenance guard, certificates and TLS directives. Stage the separate POST-only rate-limit zone in HTTP scope and validate the complete candidate with `nginx -t`.

Close public ingress with the persistent main maintenance marker before replacing controls. Verify 503 externally, reload the validated candidate, and wait until every previous nginx worker has drained. Verify the new private services, merchant ATA, configuration/profile hash and available faucet before enabling boot startup and removing the marker. Save the exact source and before/after control hashes privately. Roll back routing only before opening the new campaign; preserve all new and historical financial state. A failure after opening ingress requires maintenance and original-receipt inspection, with no financial reset or replay.

Leaving `SAC006_PAYMENT_PROFILE` unset or setting `legacy-test-v1` preserves the legacy faucet (1,000 custom tokens) and 100-token payment lab for the legacy treasury. A treasury named in the trusted Circle approval requires `circle-usdc-v1` on **both** facilitator and restaurant; a missing/legacy selector refuses before constructing RPC or opening campaign journals, regardless of key filename. Selecting a profile cannot approve one. The fixed root-owned `/etc/capture402/operational-data.json` must contain a separately reviewed `circleUsdcDemoProfile` object with exactly these fields:

```json
{
  "schema": 1,
  "reference": "OWNER_APPROVAL_REFERENCE",
  "profileId": "circle-usdc-v1",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "programId": "992QmwmwCebawRJsTCgvc8qnzGivbFaD39ZQE7VhHp7o",
  "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "decimals": 6,
  "sponsor": "APPROVED_TREASURY_PUBLIC_ADDRESS",
  "treasury": "APPROVED_TREASURY_PUBLIC_ADDRESS",
  "merchant": "APPROVED_MERCHANT_PUBLIC_ADDRESS",
  "origin": "https://approved-demo.example.invalid",
  "budget": "100000",
  "firstCapture": "40000",
  "secondCapture": "25000",
  "releaseRemainder": "35000",
  "refundExample": "10000",
  "faucetAmount": "500000",
  "cooldownSeconds": 86400,
  "maximumClaims": 100,
  "tokenSpendLimit": "50000000",
  "sponsorSpendLimit": "1000000000",
  "maximumOrders": 100,
  "maximumRelayAttempts": 600
}
```

This is an unusable template, not an approval. The source validator rejects placeholder addresses. `sponsorSpendLimit` preserves the existing cumulative 1 SOL ceiling for fees/rent; it is distinct from the USDC distribution ceiling. Root policy also retains the existing approved browser identity used by `CampaignBudget`. The browser does not receive private keys, endpoint details or operational records.

Add `circleUsdcAdmissionContracts` alongside the existing `admissionContracts`, with `orders` and `relay-attempts` contracts. Each has its own approved `reference`, `initialMaximum` (100 or 600 respectively) and an empty `migrations` array for this newly approved campaign. Keep legacy contracts and all historical migration archives unchanged. Initialize the two new admission journals using their existing `AdmissionJournal.initialize` API and matching approved contracts, source digest and reviewed starting counts. Never initialize over existing/partial custody.

Pre-create private, symlink-free directories (0700, intended service owner) beneath `/var/lib/capture402-e2e/circle-usdc-v1/`. After initialization, independently inspect and root-approve their identities in `circleUsdcCustody`; a namespace prefix alone does not authorize custody. Configure separate ports/origin and the following isolated locations before any separately authorized service activation:

| Setting/store | Circle location |
| --- | --- |
| Facilitator campaign budget (fixed) | `/var/lib/capture402-e2e/circle-usdc-v1/facilitator/campaign-budget` |
| Faucet (fixed) | `/var/lib/capture402-e2e/circle-usdc-v1/facilitator/faucet` |
| `SAC006_FACILITATOR_JOURNAL_DIR` | A pre-created submission directory beneath the Circle namespace |
| `SAC006_E2E_RELAY_ADMISSION_DIR` | A pre-created relay admission directory beneath the Circle namespace |
| `SAC006_STORE_DIR` | A pre-created resource store beneath the Circle namespace; also pre-create its `-restaurant` sibling |
| `SAC006_RECLAIM_JOURNAL_DIR` | A pre-created reclaim journal beneath the Circle namespace |
| `SAC006_E2E_ORDER_ADMISSION_DIR` | A pre-created order admission directory beneath the Circle namespace |

`circleUsdcCustody` has exactly `schema: 1`, `profileHash: profileHash(approval)` and `stores`. `stores` contains exactly the eight roles below. Each role has exactly `path` (the canonical absolute directory path), `device` and `inode` (decimal strings from `lstatSync(path, {bigint: true}).dev.toString()` and `.ino.toString()`). Record actual identities privately after inspecting the original stores; do not copy synthetic test identities. The native budget and faucet paths are fixed as above. All roles must have distinct paths and filesystem identities, with no role nested inside another.

| Role | Path binding |
| --- | --- |
| `submissions` | Exact `SAC006_FACILITATOR_JOURNAL_DIR` |
| `relayAdmission` | Exact `SAC006_E2E_RELAY_ADMISSION_DIR` |
| `campaignBudget` | Fixed facilitator campaign-budget directory |
| `faucet` | Fixed facilitator faucet directory |
| `resource` | Exact `SAC006_STORE_DIR` |
| `orders` | Exact `SAC006_STORE_DIR` plus `-restaurant` |
| `reclaims` | Exact `SAC006_RECLAIM_JOURNAL_DIR` (required for Circle) |
| `orderAdmission` | Exact `SAC006_E2E_ORDER_ADMISSION_DIR` |

Each service verifies its roles before RPC construction or journal opening, again before serving, and before each HTTP request. A missing manifest, fresh sibling, renamed/replaced directory, alias, mode/owner change or mismatch refuses; the service never initializes, migrates or repairs a store to pass this check. Keep original directory identities, counts, locks, reservations and UNKNOWN wires/signatures across restarts. Replacing storage requires separately approved migration evidence accounting for original used counts and unresolved liabilities, a stopped installation and a reviewed successor trust record. Updating environment variables, recreating a path or copying an approval reference is insufficient. This custody record is separate from `circleUsdcDemoProfile`, so it does not rewrite its schema or existing profile-bound hashes. Existing Circle installations require separate approval to install the new custody record before activating this source.

Initialize the new native budget using `CampaignBudget.initialize` with the approved sponsor, browser, genesis, reference and `spendLimit: "1000000000"`. This is a new separately approved campaign, not a migration or reset of an old budget. Keep any old uncertain economics and reservations untouched; installation approval must account for all unresolved liabilities before allowing a new campaign. Existing release controllers do not automatically install this profile or migrate legacy configuration.

Set `SAC006_ASSET_MINT` and `SAC006_ALLOWLIST_MINT` to the Circle mint; `SAC006_FEE_PAYER` and the facilitator key must match the approved treasury; merchant key and `SAC006_ALLOWLIST_MERCHANT` must match the approved merchant; public origin must match the approval. Set `SAC006_E2E_MAX_ORDERS=100` and `SAC006_SPONSOR_MAX_ATTEMPTS=600`. Keep the independently accepted deployment record, existing bearer authentication, signer custody and trusted endpoint policy mandatory.

The new faucet policy has exactly the existing identity fields plus `schema: 2`, `amount: "500000"`, `profileHash` and `tokenSpendLimit`. Retain `maximumClaims: 100` and `cooldownSeconds: 86400`. `pool` is the canonical classic-SPL ATA derived with `ata(approval.treasury, approval.mint)`; `profileHash` is `profileHash(approval)` from `integration/src/payment-profile.ts`. Set the other fields from the approved record (reference, origin, network, genesis, sponsor, mint). Root-install this JSON at `SAC006_E2E_FAUCET_POLICY_PATH` for both services. Initialize the **empty new faucet directory once** with `DevnetFaucetStore.initialize(directory, policy)`, under the intended owner, then open it with `new DevnetFaucetStore(directory, policy)` to verify custody. Initialization performs no RPC or token transfer. Do not edit an existing `policy.json` or state file to switch assets.

If public payer-scoped merchant controls are approved, install a separate schema-2 merchant policy at `SAC006_E2E_PUBLIC_MERCHANT_DEMO_POLICY_PATH`. Its exact fields are `schema`, `origin`, `network`, `programId`, `sponsor`, `merchant`, `mint`, `budget`, `maximumOrders`, `maximumRelayAttempts`, `profileHash` (derived from the approved Circle record), plus a nonempty `reference`. The restaurant also compares the actual private faucet health identity (profile hash, network, mint, treasury, pool and atomic claim amount) before new claims and payment health gates; a stale legacy facilitator refuses. Values come from `merchantDemoPolicy(CIRCLE_PROFILE)`; `validateMerchantDemoPolicy(value, CIRCLE_PROFILE)` must accept it. Legacy schema-1 delegation remains unchanged. No payer message grants transaction authority; the existing merchant signs each eligible fixed action separately.

## Fixed amounts, policy digests and historical compatibility

| Source/boundary | Legacy value or digest | Circle behavior |
| --- | --- | --- |
| `restaurant.ts` exported `DEMO_UNIT` / `DEMO_BUDGET` | 1000000 / 100000000 | Exports remain compatible; internal authorization, snapshot, recovery, capture/refund and funding checks use the selected profile |
| `payment-profile.ts`, browser `payment-profile.js` | Budget 100000000; captures 40000000/25000000; release 35000000; normal refund 10000000 | Budget 100000; captures 40000/25000; release 35000; normal refund 10000; browser tests compare both definitions |
| `devnet-faucet-store.ts` schema 1 | Amount 1000000000, cooldown 86400, maximum 100 | Schema 2 only, amount 500000, immutable approved token ceiling and profile hash |
| Faucet disk `policyHash` | SHA-256 of `JSON.stringify(policy, null, 2)` | Same algorithm over a new policy in separate state; old bytes/hashes are not changed |
| Faucet challenge `policyHash` | SHA-256 of compact `JSON.stringify(policy)`; original v1 HMAC domain | Same policy-bound authorization and domain; altered mint/amount/approval cannot replay into another policy |
| Circle approval `profileHash` | Absent in legacy records/messages | SHA-256 of JSON serialized with sorted top-level keys, computed by `profileHash`; pinned in faucet policy, merchant policy, browser config and merchant consent |
| Merchant delegation | Exact schema-1 trusted policy comparison; budget 100000000 | Separate schema-2 comparison plus Circle approval hash; consent message says 0.10 USDC and binds that hash |
| Admission and native campaign journals | Their original immutable policy hashes, used counts and migration histories | Separate newly approved contracts and stores; no historical rewriting |
| Paid-report example / wallet-free illustration | Existing separate 100-token example | Retains its independent legacy profile; this change selects the payment lab only |

Historical installed hash values and real receipts remain private external evidence. They are not copied into public fixtures. Neither setting an environment variable nor computing a hash creates approval. Source tests use synthetic account snapshots in a local SVM, including canonical addresses, and never issue Circle tokens.

## Live Devnet verification after explicit approval

1. Review the exact candidate source, trusted approval, deployment/executable identity, dedicated wallets, available USDC/SOL, token ceiling, native budget and admission counters. Approve installation/service activation separately. Do not use upgrade-authority credentials. Before accepting payment offers, create and verify the merchant's canonical classic-token USDC ATA using the approved treasury's native setup budget. A capture cannot create a missing merchant ATA. Retain the original setup transaction, finalize its native reservation as the intended service user, and confirm its token balance before opening public ingress.
2. Read `/api/config` through the selected origin: profile `circle-usdc-v1`, correct mint/program/network, atomic budget `100000`, public profile hash and approved treasury identity must agree. Read `/api/faucet/status?recipient=PUBLIC_ADDRESS`: unavailable reason must distinguish treasury low balance, cooldown, UNKNOWN and RPC failure. This endpoint is read-only, with a global 60/minute RPC inspection limit; liquidity is advisory and rechecked during claim.
3. With approval for **one** claim, connect a Devnet wallet and review/sign the exact `0.50 Devnet USDC` message. Save request ID, original signature and finalized slot privately. Confirm the exact original transfer finalized successfully before treating tokens as delivered. Check treasury and recipient ATAs and the 500000-unit delta. The sponsor pays recipient ATA creation and network fees.
4. With separate payment approval, review the retained offer and authorize up to 0.10 USDC, then explicitly request 0.04 capture, 0.025 capture and 0.035 release. Observe each original finalized receipt before the next action. Confirm the payment account's maximum, mint, deadlines, held and refundable balances. A wallet approval or RPC acknowledgement alone is not success.
5. Test alternative scenarios only under separately budgeted approvals and fresh explicit payer consent. The normal 0.01 refund requires merchant liquidity and its original open refund window. For reclaim, fund payer SOL and wait for the actual immutable capture deadline; expiry itself returns nothing.
6. For a timeout or UNKNOWN, retain the original signed bytes/signature, journal, lock, quota and full native reservation. Inspect only the original `/api/faucet/claims/:id` or order receipts; never resend, regenerate a blockhash, reset state, switch provider or refill to bypass unresolved economics. Cooldowns count from durable claim admission, including refusals/failures, and reserved claims conservatively consume their full token allowance.

## Offline validation

From the repository root, run `./scripts/test-sac003.sh`, `npm run typecheck --prefix integration`, `npm test --prefix integration`, and `npm run build:wallet --prefix integration`. The Rust script rebuilds the SBF from current source and runs SAC-001/002/003. Tests execute both faucet modes, real local SBF payment lifecycles, wallet message checks and a loopback standard JSON-RPC transport; they do not contact QuickNode, Circle or Devnet.

For real Chromium rendering with synthetic HTTPS API responses, set `RESTAURANT_PLAYWRIGHT_MODULE` to an existing Playwright `index.mjs`, set `RESTAURANT_QA_OUTPUT` to a private pre-created output directory, then run `node --experimental-strip-types integration/browser/circle-usdc-check.mjs`. The fixture permits only its own loopback origin and checks amount labels, balance thresholds, normalized bars, receipt signatures, availability failures and desktop/mobile layout with zero POST/signing operations. Browser fixtures do not establish live-wallet or economic acceptance.
