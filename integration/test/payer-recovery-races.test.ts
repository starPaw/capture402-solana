import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { payerFixture } from "./fixtures/payer-recovery-fixture.ts";
import { submitPayerRecovery } from "../src/payer-recovery.ts";
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
async function fixture() { const f = await payerFixture(); roots.push(f.root); return f; }
async function worker(f: Awaited<ReturnType<typeof fixture>>, role: string, request?: Awaited<ReturnType<typeof f.request>>) {
  const req = request ?? await f.request(), c = fork(resolve("test/fixtures/payer-race-worker.ts"), [JSON.stringify(f.paths), role, JSON.stringify({ ...req, domain: undefined, reader: undefined, backend: undefined })], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(c);
  const messages: any[] = [], pending: { name: string; done(): void }[] = []; let errors = "";
  c.stderr?.on("data", d => errors += d); c.on("message", m => { messages.push(m); for (const p of pending) if (p.name === m) p.done(); });
  return { c, messages, receive(name: string) { if (messages.includes(name)) return Promise.resolve(); return new Promise<void>((done, reject) => { const t = setTimeout(() => reject(new Error("missing " + name + errors)), 5000); pending.push({ name, done() { clearTimeout(t); done(); } }); }); } };
}
test.each(["order", "facilitator", "reclaim"])("real %s process blocks recovery until deadline, reservations remain", async role => {
  const f = await fixture(), req = await f.request(), w = await worker(f, role, req); await w.receive("entered");
  const before = readFileSync(f.path); await expect(submitPayerRecovery({ ...req, timeoutMs: 60 })).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(before); expect(f.calls.submission).toBe(0); w.c.send("release"); await w.receive("released");
});
test.each(["facilitator", "reclaim-reserve"])("%s process wins race: old reviewed offer refuses, no backend submission", async role => {
  const f = await fixture(), req = await f.request(), w = await worker(f, role, req); await w.receive("entered");
  const result = submitPayerRecovery(req); w.c.send("release"); await w.receive("released"); await expect(result).rejects.toThrow(); expect(f.calls.submission).toBe(0);
});
test("exclusive recovery fences real restaurant writer through lost backend response", async () => {
  const f = await fixture(), req = await f.request(); let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  f.backend.submit = async () => { f.calls.submission++; entered(); await gate; throw new Error("lost synthetic response"); };
  const result = submitPayerRecovery(req); await inside; const w = await worker(f, "order", req); await w.receive("ready"); expect(w.messages).not.toContain("entered");
  release(); await expect(result).rejects.toThrow(/reconcile original/); await w.receive("entered"); expect(w.messages).toContainEqual({ status: "pending" });
  w.c.send("release"); await w.receive("released"); expect(f.calls.submission).toBe(1);
});
test("actual restarted process cannot reconstruct fixture admission or send durable draft", async () => {
  const f = await fixture(), req = await f.request(); await submitPayerRecovery(req);
  const w = await worker(f, "restart", req); await w.receive("refused"); expect(w.messages).not.toContain("effect"); expect(f.calls.submission).toBe(1);
});
