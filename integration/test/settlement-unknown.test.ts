import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { Facilitator } from "../src/facilitator.ts";
import { FileSubmissionJournal } from "../src/submission-journal.ts";
import { authorizePayload } from "../src/transactions.ts";
import { SETTLEMENT_UNKNOWN } from "../src/types.ts";
import { createHarness, type Harness } from "./fixture.ts";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
const facilitator = (journal: FileSubmissionJournal) => new Facilitator({
  network: h.ledger.network, programId: h.facilitator.programId,
  feePayer: h.facilitatorKey, ledger: h.ledger, journal,
});
const snapshot = (dir: string) => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]);

test.each(["unresolved", "finalized", "prepared"] as const)(
  "journal read failure after %s retains UNKNOWN, bytes and one submission across duplicate/restart", async state => {
    const dir = mkdtempSync(join(tmpdir(), "issue76-journal-"));
    const journal = new FileSubmissionJournal(dir);
    const body = h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })));
    const submit = h.ledger.submit;
    let broadcasts = 0;
    h.ledger.submit = async tx => {
      broadcasts += 1;
      if (state === "prepared") throw new Error("stop after durable prepare");
      const landed = await submit.call(h.ledger, tx);
      return state === "unresolved" ? { kind: "submitted" } : landed;
    };
    try {
      const original = await facilitator(journal).settle(body);
      expect(original.transaction).not.toBe("");
      const retained = snapshot(dir);
      const simulations = h.ledger.simulated.length;
      for (let restart = 0; restart < 2; restart++) {
        const reopened = new FileSubmissionJournal(dir);
        const spy = vi.spyOn(reopened, "findByMessageHash").mockImplementation(() => { throw new Error("journal unavailable"); });
        const app = createApp(facilitator(reopened));
        const responses = await Promise.all([1, 2].map(() => app.request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
        for (const response of responses) {
          expect(response.status).toBe(503);
          expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
          expect(await response.json()).toEqual(SETTLEMENT_UNKNOWN);
        }
        spy.mockRestore();
        expect(snapshot(dir)).toEqual(retained);
      }
      expect(broadcasts).toBe(1);
      expect(h.ledger.simulated.length).toBe(simulations);
      // Restoring journal access returns only the authenticated original, never another success.
      const recovered = await facilitator(new FileSubmissionJournal(dir)).settle(body);
      expect(recovered).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: original.transaction });
      expect(broadcasts).toBe(1);
      expect(snapshot(dir)).toEqual(retained);
    } finally { h.ledger.submit = submit; }
  },
);

test.each(["empty", "malformed", "foreign", "ambiguous"] as const)(
  "untrusted original journal signature (%s) produces application UNKNOWN without signing/submission", async fault => {
    const journal = new FileSubmissionJournal(mkdtempSync(join(tmpdir(), "issue76-untrusted-")));
    const body = h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })));
    const original = await facilitator(journal).settle(body);
    const entry = journal.list()[0]!;
    const foreignBody = h.body(authorizePayload(await h.signedAuthorize({ salt: h.newSalt() })));
    const foreign = await facilitator(new FileSubmissionJournal(mkdtempSync(join(tmpdir(), "issue76-foreign-")))).settle(foreignBody);
    const entries = [{ ...entry, signature: fault === "empty" ? "" : fault === "malformed" ? "invalid" : fault === "foreign" ? foreign.transaction : original.transaction }];
    if (fault === "ambiguous") entries.push(entry);
    vi.spyOn(journal, "findByMessageHash").mockReturnValue(entries);
    const submissions = h.ledger.submissions.length;
    const simulations = h.ledger.simulated.length;
    const response = await createApp(facilitator(journal)).request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SETTLEMENT_UNKNOWN);
    expect(h.ledger.submissions.length).toBe(submissions);
    expect(h.ledger.simulated.length).toBe(simulations);
  },
);
