import { renameSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./fixture.ts";
import { Facilitator } from "../src/facilitator.ts";
import { V2OrderJournal } from "../src/v2-order-journal.ts";
import { authorizePayload } from "../src/transactions.ts";
import { closeEmptyVaultV2Instruction, closePaymentV2Instruction, voidV2Instruction } from "../src/lifecycle.ts";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.close(); });
const orderId = "c".repeat(64);
function restarted() {
  const original = h.orderConfig.orderJournal;
  return new Facilitator({ ...h.orderConfig, orderJournal: new V2OrderJournal(original.root, original.enrollment),
    network: h.ledger.network, programId: h.facilitator.programId, feePayer: h.facilitatorKey, ledger: h.ledger });
}
async function request(expiry = 1500n, salt = h.newSalt()) {
  const requirements = h.requirements({}, {orderId, authorizeUntilSlot:expiry.toString()});
  const tx = await h.signedAuthorize({salt, authorizeUntilSlot:expiry});
  return h.body(authorizePayload(tx), requirements);
}

test.each([false, true])("shared service journal blocks new E and salt after restart and closure; lost response=%s", async lost => {
  const salt = h.newSalt();
  if (lost) h.ledger.failSubmit = "after-landing";
  const result = await h.facilitator.settle(await request(20n, salt));
  expect(result.success).toBe(!lost);
  const identity = {protocolVersion:2 as const, programId:h.facilitator.programId, payer:h.payer.address,
    server:h.server.address,mint:h.mint,rentRefundRecipient:h.facilitatorKey.address,salt,authorizeUntilSlot:20n};
  h.ok(await h.direct([await voidV2Instruction(identity,100n,0n)], [h.server]));
  const clock=h.svm.getClock();clock.slot=21n;h.svm.setClock(clock);
  h.ok(await h.direct([await closeEmptyVaultV2Instruction(identity),await closePaymentV2Instruction(identity)]));
  const before=h.orderConfig.orderJournal.snapshot(orderId);
  expect(before.status).toBe(lost?"UNKNOWN":"AUTHORIZED");
  const submit=vi.spyOn(h.ledger,"submit"),simulate=vi.spyOn(h.ledger,"simulate"),reads=vi.spyOn(h.ledger,"getAccount");
  for (let i=0;i<4;i++) await expect(restarted().settle(await request(100n+BigInt(i)))).rejects.toThrow(/reserved|unavailable/);
  expect(submit).not.toHaveBeenCalled();expect(simulate).not.toHaveBeenCalled();expect(reads).not.toHaveBeenCalled();
  expect(h.orderConfig.orderJournal.snapshot(orderId)).toEqual(before);
});

test("parallel service instances with distinct signed wires claim one business order", async () => {
  const requests=await Promise.all(Array.from({length:8},(_,i)=>request(100n+BigInt(i))));
  const results=await Promise.allSettled(requests.map(body=>restarted().settle(body)));
  expect(results.filter(r=>r.status==="fulfilled" && r.value.success)).toHaveLength(1);
  expect(h.ledger.submissions).toHaveLength(1);
  expect(h.orderConfig.orderJournal.snapshot(orderId).status).toBe("AUTHORIZED");
});

test.each(["orderId","authorizeUntilSlot","protocolVersion"])("unsigned %s changes cannot create new order authority",async field=>{
  const body=await request();
  (body.paymentRequirements.extra as Record<string,unknown>)[field]=field==="orderId"?"d".repeat(64):field==="protocolVersion"?1:"1499";
  const result=await h.facilitator.settle(body);
  expect(result.success).toBe(false);expect(h.ledger.submissions).toHaveLength(0);
  expect(h.orderConfig.orderJournal.hasReservation(orderId)).toBe(false);
});

test("missing durable order store prevents sponsor signing and dispatch",async()=>{
  const relay=new Facilitator({orderKey:h.orderConfig.orderKey,network:h.ledger.network,programId:h.facilitator.programId,
    feePayer:h.facilitatorKey,ledger:h.ledger});
  await expect(relay.settle(await request())).rejects.toThrow("journal required");
  expect(h.ledger.submissions).toHaveLength(0);
});

test("custody changed while reserving sponsor budget stops before signing",async()=>{
  const journal=h.orderConfig.orderJournal;
  let signed=0;
  const feePayer=Object.create(h.facilitatorKey);
  Object.defineProperty(feePayer,"keyPair",{get(){signed++;return h.facilitatorKey.keyPair;}});
  const relay=new Facilitator({...h.orderConfig,network:h.ledger.network,programId:h.facilitator.programId,feePayer,ledger:h.ledger,
    sponsorBudget:{reserve:async()=>{renameSync(journal.root,journal.root+"-retained");return "budget-reserved";},observe:async()=>{}}});
  await expect(relay.settle(await request())).rejects.toThrow("retain UNKNOWN");
  expect(signed).toBe(0);expect(h.ledger.submissions).toHaveLength(0);
});
