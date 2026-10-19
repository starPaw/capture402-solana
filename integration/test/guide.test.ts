import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { createPresentationApp } from "../src/restaurant-server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const web = new URL("../web/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, web), "utf8");
const info = { programId: "unconfigured", network: "test", configured: false };
const routes = [["/integrate", "integrate.html", "text/html"], ["/evidence", "evidence.html", "text/html"], ["/assets/guide.css", "guide.css", "text/css"]] as const;

test.each(routes)("%s is exact, GET-only and isolated from economic backend", async (route, file, mime) => {
  const requests: string[] = [];
  const backend = new Hono();
  backend.all("*", c => { requests.push(c.req.path); return c.text("unexpected", 500); });
  const app = createPresentationApp(info, backend);
  const response = await app.request(route);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(`${mime}; charset=utf-8`);
  expect(await response.text()).toBe(read(file));
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const csp = response.headers.get("content-security-policy");
  expect(csp).toBe((await app.request("/")).headers.get("content-security-policy"));
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    expect((await app.request(route, { method })).status).toBe(405);
  }
  expect(requests).toEqual([]);
});

test("near-miss routes, source manifests and private files are not served", async () => {
  const app = createPresentationApp(info);
  for (const path of ["/integrate/", "/evidence/", "/integrate.html", "/evidence.html", "/integratex", "/assets/guide.css/", "/assets/guide.css.extra", "/assets/guide-sources.json", "/assets/../guide-sources.json", "/docs/non-served-source.md", "/src/paid-report.ts"]) {
    expect((await app.request(path)).status, path).toBe(404);
  }
});

test("static navigation resolves, source links resolve within the public source tree", async () => {
  const app = createPresentationApp(info);
  for (const name of ["homepage.html", "integrate.html", "evidence.html"]) {
    const html = read(name);
    expect(html).not.toContain("github.com/starPaw/svm-auth-capture");
    expect(html).not.toMatch(/<form|mailto:|\sonclick=|\sstyle=/);
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1]!, "https://fixture.invalid/" + (name === "homepage.html" ? "" : name.replace(".html", "")));
      if (url.origin === "https://fixture.invalid") {
        const response = await app.request(url.pathname);
        expect(response.status, `${name}: ${url.pathname}`).toBe(200);
        if (url.hash) expect(await response.text()).toContain(`id="${url.hash.slice(1)}"`);
      } else if (url.hostname === "github.com" && url.pathname.startsWith("/starPaw/capture402-solana/blob/")) {
        const prefix = "/starPaw/capture402-solana/blob/main/";
        expect(url.pathname.startsWith(prefix)).toBe(true);
        expect(existsSync(root + url.pathname.slice(prefix.length))).toBe(true);
      }
    }
  }
  for (const name of ["integrate.html", "evidence.html"]) {
    const html = read(name);
    expect(html).toContain('content="noindex,nofollow"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script|<style|<iframe/);
  }
});

test("source manifest verifies current public files without private Git history", () => {
  for (const record of JSON.parse(read("guide-sources.json"))) {
    expect(record.path).not.toMatch(/^\/|\.\./);
    const bytes = readFileSync(root + record.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
  }
  expect(read("evidence.html")).toContain("NOT RUN");
  expect(read("evidence.html")).toContain("independent human acceptance");
});

test("guide distinguishes real helpers from pseudocode and preserves delivery/recovery limits", () => {
  const html = read("integrate.html");
  const client = readFileSync(new URL("../src/paid-report-client.ts", import.meta.url), "utf8");
  for (const helper of ["prepareReport", "submitReport", "retrieveReport", "readPaidReport"]) {
    expect(html).toContain(helper); expect(client).toContain(`function ${helper}(`);
  }
  for (const text of ["Pseudocode — not runnable", "Classic SPL Token", "Token-2022", "wrapped SOL", "local extension", "all four proofs", "durable persistence", "no per-stage delivery", "all new paid-report economics indefinitely", "permanently", "merchant consent and liquidity", "Expiry moves no funds automatically", "not demonstrate reclaim with the application server stopped"]) expect(html).toContain(text);
  expect(html).not.toMatch(/https?:\/\/[^\s"<]*(?:helius|quicknode)|npm install|guaranteed delivery/);
});

test("comparison names shared capabilities, authority and exit differences with pinned primary sources", () => {
  const html = read("integrate.html");
  expect(html).toContain('<section id="compare">');
  expect(html).toContain('<details><summary>Technical comparison, source revisions and costs</summary>');
  for (const name of ["Immediate x402", "Payment Channels / MPP sessions", "Capture402", "Base Commerce Payments"]) expect(html).toContain(name);
  expect(html).toContain("https://github.com/starPaw/capture402-solana/blob/main/src/lib.rs");
  expect([...html.matchAll(/https:\/\/github.com\/(?:x402-foundation|solana-foundation|base)\/[^\s"]+\/blob\/[a-f0-9]{40}\//g)].length).toBeGreaterThanOrEqual(3);
  for (const claim of ["partial capture, expiry and payer reclaim", "relative grace period", "Payer withdrawal", "merchant-signed collections", "operator can partially capture", "no cost advantage is claimed"]) expect(html).toContain(claim);
  expect(html).not.toMatch(/globally unique|guaranteed delivery|cheaper than|faster than/);
});

test.each(["nginx-resource.conf", "dev/nginx-routes.conf", "e2e/nginx-public-demo.conf"])("%s allows only the exact new GET presentation routes", name => {
  const config = readFileSync(new URL(`../deploy/${name}`, import.meta.url), "utf8");
  const match = [...config.matchAll(/location ~ "([^"]+)" \{([^}]+\}[^}]*?)\n\}/g)].find(m => m[1]!.includes("homepage"));
  expect(match).toBeDefined();
  const regex = new RegExp(match![1]!.replaceAll("\\\\", "\\"));
  for (const route of ["/integrate", "/evidence", "/assets/guide.css"]) expect(regex.test(route)).toBe(true);
  for (const route of ["/integrate/", "/evidence.html", "/assets/guide.css.extra", "/assets/guide-sources.json", "/settle", "/verify", "/docs/ARCHITECTURE.md"]) expect(regex.test(route)).toBe(false);
  expect(match![2]).toContain("if ($request_method != GET) { return 405; }");
});
