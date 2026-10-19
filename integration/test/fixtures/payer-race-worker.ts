import { RecoveryDomain } from "../../src/coordination.ts";
import { FileSubmissionJournal } from "../../src/submission-journal.ts";
import { RestaurantOrders } from "../../src/restaurant.ts";
import { submitPayerRecovery } from "../../src/payer-recovery.ts";
const [raw, role, requestRaw] = process.argv.slice(2), paths = JSON.parse(raw!), req = JSON.parse(requestRaw!), domain = new RecoveryDomain(paths);
let release!: () => void; const gate = new Promise<void>(r => release = r); process.on("message", m => { if (m === "release") release(); });
process.send!("ready");
try {
  if (role === "restart") {
    await submitPayerRecovery({ ...req, domain, reader: {} as never, backend: { simulate: async () => { process.send!("effect"); return { ok: true }; }, submit: async () => { process.send!("effect"); return { kind: "submitted" }; } } });
    process.send!("unexpected");
  } else await domain.run("shared", async () => {
    if (role === "order") { const order = new RestaurantOrders(paths.orders, domain).read(req.orderId); process.send!({ status: order.status }); }
    process.send!("entered"); await gate;
    if (role === "facilitator") new FileSubmissionJournal(paths.facilitator, { coordination: domain }).resolve(req.captureSignature, { result: "unresolved", recordedAt: "synthetic-process-race" });
    if (role === "reclaim-reserve") {
      const { getTransactionDecoder, getBase64Encoder, getSignatureFromTransaction } = await import("@solana/kit");
      const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(req.transactionBase64)));
      new FileSubmissionJournal(paths.reclaim, { coordination: domain }).prepare({ signature, transactionBase64: req.transactionBase64, operation: "reclaim", messageHash: req.offer.messageHash, payment: req.offer.payment, payer: req.offer.payer, blockhash: req.offer.lifetime.blockhash, blockhashSlot: req.offer.lifetime.blockhashSlot, expectedHeld: req.offer.held, expectedRefundable: req.offer.refundable });
    }
    process.send!("released");
  }, 2000);
} catch { process.send!("refused"); }
process.disconnect!();
