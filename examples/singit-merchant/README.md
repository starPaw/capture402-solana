# Isolated SingIt merchant and buyer MCP example

Preparation for [MVP-07](https://github.com/bubon-ik/singit-agent-pay/issues/14).
All files are confined to this folder. No SingIt source, payment service, ABI,
operator installation or live configuration is modified.

The merchant sells an expense-quality report: exact integer totals by category,
duplicate invoice IDs, an input digest and the purchased artifact digest. Amounts
are caller-supplied integer units, not assumed to be USDC. Duplicate rows remain
in the totals and are explicitly flagged. The bundled input is synthetic.

The buyer talks to a separate merchant process over MCP stdio. Both use SingIt's
actual streamable HTTP MCP surface for payment operations. A human/operator
creates the mandate beforehand through `POST /human/mandate`. The buyer never
creates or expands a mandate. Payment clients send separate buyer and merchant
bearer tokens; the merchant alone calls capture using its authenticated role.

The quote authorizes a maximum of **1 mock USDC**. The merchant captures **0.65**
with `releaseRemainder: true`, releasing **0.35 in the same instruction**. A
separate refund/dispute flow is deliberately outside this example. Purchased
bytes are persisted before capture and delivered only after a known successful
outcome and durable completion. Identical completed requests replay those bytes.

## Current boundary

This preparation is **mock only**. Both entrypoints refuse devnet before making
a request. That restriction must remain until the final integrated auth,
idempotency, storage, custody, recovery and environment gates in MVP-01–06 are
accepted. This example targets SingIt's trusted-principal and idempotency-aware
MCP contract, verified against public source
[`1c4a45e840c7e16445b89594d4a5de7e6b2d7201`](https://github.com/bubon-ik/singit-agent-pay/commit/1c4a45e840c7e16445b89594d4a5de7e6b2d7201).
Every `hold`, `capture` and `release` call requires a stable `idempotencyKey`.
The purchase uses `report:<orderId>:hold` and `report:<orderId>:capture`; the
atomic remainder release belongs to that capture intent. Upstream deduplication
does not enable automatic retries: interrupted local attempts still block new
purchases and retain their original state.

This is a real MCP client/server integration and a useful deterministic artifact,
not evidence of a real LLM decision, live devnet payment, independent review or
full MVP-07 acceptance. A model-based buyer can use the merchant tools later;
its actual client trace and useful completion remain separate acceptance work.
Buyer and merchant processes require no model API, model credentials, wallet
keys, RPC credentials or human approval secrets. Their role tokens are private
configuration. Only the separate human setup step uses the human route secret.

## Local use

Use Node.js 22 or later and install the locked dependencies here with `npm ci`.
Start an explicitly mock SingIt HTTP entrypoint separately. It must bind to
`127.0.0.1`, use `SINGIT_BACKEND=mock`, and configure distinct
`SINGIT_BUYER_TOKEN`, `SINGIT_MERCHANT_TOKEN` and `SINGIT_HUMAN_ROUTE_SECRET`.
Set its `SINGIT_PAYER_ADDRESS=buyer-agent` and
`SINGIT_MERCHANT_ADDRESS=seller-agent` to match the synthetic roles below.
Load token values from private local configuration; never include them in tool
arguments, source, logs or URLs. Set the following buyer variables locally:

```sh
export PAYMENT_PROFILE=mock
export PAYMENT_MCP_URL=http://127.0.0.1:8787/mcp
export REPORT_PAYER=buyer-agent
export REPORT_MERCHANT=seller-agent
export MERCHANT_STATE_DIR="$PRIVATE_TEST_ROOT/merchant"
export BUYER_STATE_DIR="$PRIVATE_TEST_ROOT/buyer"
# Load SINGIT_BUYER_TOKEN and SINGIT_MERCHANT_TOKEN from private configuration.
node buyer.mjs sample.json "$HUMAN_ISSUED_MANDATE_ID" synthetic-report-intent-0001
```

`PRIVATE_TEST_ROOT` must be a private, dedicated absolute directory outside every
Git checkout. The buyer's stdio child receives its merchant token, the mock
endpoint, role names and merchant state path; buyer and human credentials are
excluded. The local launcher holds both agent tokens so it can start that child;
this is not independent wallet custody. An MCP client can also start
`node merchant.mjs` with only `SINGIT_MERCHANT_TOKEN` and the common mock settings,
then use `quote_report`, `purchase_report` and read-only `get_report`.

Before starting the buyer, the human/operator issues one mandate in a separate
session through `POST http://127.0.0.1:8787/human/mandate`. Send
`content-type: application/json` and `x-singit-human-secret` from the private
operator configuration. The JSON body contains `payer: "buyer-agent"`,
`totalBudget: "1000000"`, `perTxCap: "1000000"`, a future Unix-seconds
`expiresAt`, and `allowedCounterparties: ["seller-agent"]`. Use the returned
`mandate.id` as `HUMAN_ISSUED_MANDATE_ID`. Issue once; after a lost response,
observe the original mandate instead of issuing another. Authenticated agents
cannot use MCP `create_mandate`, and an agent token cannot authorize the human
HTTP route. Keep `SINGIT_HUMAN_ROUTE_SECRET` outside the buyer environment.

Keep the original intent and both stores after failure. There is no automatic
resume, retry, compensation, state reset or provider fallback. Read `get_report`
to observe delivery. A known completed buyer record can be replayed without any
payment call. An unresolved operation blocks new purchases even after restart.
Locks are never removed because of their age; establish that the owner process
has stopped before any manual lock repair. The application lock is not a global
wallet-custody solution; that remains MVP-04. Mock payment state is ephemeral:
do not treat a restarted MockBackend as a restored economic ledger.

Overlapping buyer calls sharing one store refuse before another payment attempt.
Completion writes retain the original pending record until the replacement is
durable. Failed completion candidates never authorize delivery, including after
restart; preserve both the pending record and candidate bytes. A crash during
pending-record cleanup may conservatively leave an order unresolved.

## Verification

```sh
npm test
SINGIT_CHECKOUT="$PUBLIC_SINGIT_CHECKOUT" npm test
```

The second command launches the unmodified external SingIt entrypoint with a
curated mock-only environment, synthetic wallets and ephemeral role/human
credentials. It exercises real authenticated HTTP and stdio MCP transports,
human-only mandate issuance, role and invalid-token refusals, exactly one
hold/capture per report, atomic remainder release, artifact delivery and known
successful idempotency replay. A separate synthetic hold/release contract check
verifies release-key replay without adding a release step to the report purchase.
Without `SINGIT_CHECKOUT`, this transport test is explicitly skipped. Fault tests
cover overlap, lost responses, completion flush failures and restart. None sends
an RPC request or signs a wallet transaction.

MCP SDK v1 APIs: [client](https://ts.sdk.modelcontextprotocol.io/client),
[server](https://ts.sdk.modelcontextprotocol.io/server). This client intentionally
matches the v1 SDK used by SingIt; it does not silently migrate protocol versions.
