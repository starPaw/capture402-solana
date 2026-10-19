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
creates the mandate beforehand. The buyer never creates or expands a mandate;
the merchant alone calls capture using its configured role.

The quote authorizes a maximum of **1 mock USDC**. The merchant captures **0.65**
with `releaseRemainder: true`, releasing **0.35 in the same instruction**. A
separate refund/dispute flow is deliberately outside this example. Purchased
bytes are persisted before capture and delivered only after a known successful
outcome and durable completion. Identical completed requests replay those bytes.

## Current boundary

This preparation is **mock only**. Both entrypoints refuse devnet before making
a request. That restriction must remain until the final integrated auth,
idempotency, storage, custody, recovery and environment gates in MVP-01–06 are
accepted. Current SingIt main does not carry idempotency keys through MCP. The
example supplies stable intent keys, but does not claim upstream deduplication.
Instead, an interrupted local attempt blocks subsequent purchase attempts.

This is a real MCP client/server integration and a useful deterministic artifact,
not evidence of a real LLM decision, live devnet payment, independent review or
full MVP-07 acceptance. A model-based buyer can use the merchant tools later;
its actual client trace and useful completion remain separate acceptance work.
No model API, model credentials, wallet keys, RPC credentials or human approval
secrets are required by this example.

## Local use

Use Node.js 22 or later and install the locked dependencies here with `npm ci`.
Start an explicitly mock SingIt HTTP entrypoint separately. It must bind to
`127.0.0.1`. Set the following variables locally; the URL below is a loopback
example, never a provider endpoint:

```sh
export PAYMENT_PROFILE=mock
export PAYMENT_MCP_URL=http://127.0.0.1:8787/mcp
export REPORT_PAYER=buyer-agent
export REPORT_MERCHANT=seller-agent
export MERCHANT_STATE_DIR="$PRIVATE_TEST_ROOT/merchant"
export BUYER_STATE_DIR="$PRIVATE_TEST_ROOT/buyer"
node buyer.mjs sample.json "$HUMAN_ISSUED_MANDATE_ID" synthetic-report-intent-0001
```

`PRIVATE_TEST_ROOT` must be a private, dedicated absolute directory outside every
Git checkout. The buyer's stdio child receives only the mock endpoint, role names
and merchant state path. An MCP client can also start `node merchant.mjs` directly
and use `quote_report`, `purchase_report` and read-only `get_report`.

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

The second command additionally launches the unmodified external SingIt entrypoint
with a curated mock-only environment and synthetic wallets. It exercises real
HTTP and stdio MCP transports, checks exactly one hold/capture, released remainder,
artifact delivery and duplicate retrieval. Without `SINGIT_CHECKOUT`, that test is
explicitly skipped. Fault tests cover a lost capture response, post-capture store
failure, restart, foreign payment terms and a lost hold response. None sends an
RPC request or signs a wallet transaction.

MCP SDK v1 APIs: [client](https://ts.sdk.modelcontextprotocol.io/client),
[server](https://ts.sdk.modelcontextprotocol.io/server). This client intentionally
matches the v1 SDK used by SingIt; it does not silently migrate protocol versions.
