import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { createPresentationApp } from "../src/restaurant-server.js";

const web = new URL("../web/", import.meta.url);
const html = readFileSync(new URL("homepage.html", web), "utf8");
const app = () => createPresentationApp({ programId: "not-the-historical-program", network: "test", configured: false });

test("root is a separate static homepage; both restaurant routes and CSP are preserved", async () => {
  const ui = app();
  const root = await ui.request("/");
  expect(await root.text()).toBe(html);
  const demo = readFileSync(new URL("index.html", web), "utf8");
  for (const path of ["/customer", "/merchant"]) {
    const response = await ui.request(path);
    expect(await response.text()).toBe(demo);
    expect(response.headers.get("content-security-policy")).toBe(root.headers.get("content-security-policy"));
  }
  expect(root.headers.get("content-security-policy")).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(root.headers.get("x-content-type-options")).toBe("nosniff");
  expect(html).toContain('content="noindex,nofollow"');
  expect([...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1]))
    .toEqual(["/assets/homepage.css", "/assets/homepage.js"]);
  expect(html).not.toMatch(/<style|<script[^>]*>[^<]+|\sstyle=|\sonclick=/);
});

test.each([["homepage.css", "text/css"], ["homepage.js", "text/javascript"]])("only the exact GET asset %s is served", async (name, mime) => {
  const ui = app();
  const response = await ui.request(`/assets/${name}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(`${mime}; charset=utf-8`);
  expect(await response.text()).toBe(readFileSync(new URL(name, web), "utf8"));
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    expect((await ui.request(`/assets/${name}`, { method })).status).toBe(405);
  }
  for (const path of [`/assets/${name}/`, `/assets/${name}.extra`, "/assets/homepage-proof.json"]) {
    expect((await ui.request(path)).status).toBe(404);
  }
});

test("loading homepage and assets never calls economic backend or config", async () => {
  const requests: string[] = [];
  const backend = new Hono();
  backend.all("*", c => { requests.push(c.req.path); return c.text("unexpected backend", 500); });
  const ui = createPresentationApp({ programId: "unconfigured", network: "test", configured: false }, backend);
  for (const route of ["/", "/assets/homepage.css", "/assets/homepage.js"]) expect((await ui.request(route)).status).toBe(200);
  expect(requests).toEqual([]);
  const script = readFileSync(new URL("homepage.js", web), "utf8");
  expect(script).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|solana|solflare)\b|\/api\//);
});

test("public verification text makes no live deployment claim", () => {
  expect(html).toContain("Fixtures are not live settlement receipts");
  expect(html).toContain("No current deployment, production readiness or independent security-audit claim");
  expect(html).toContain("upgrade authority");
  expect(html).not.toMatch(/explorer\.solana|access required|github\.com\/starPaw\/capture402\//);
});

test("both no-JS paths preserve the fixed terms and conserve the illustrative budget", () => {
  const paths = [...html.matchAll(/<section data-path="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
  expect(paths.map(m => m[1])).toEqual(["stops", "completes"]);
  const expected = {
    stops: [[0, 0, 0, 0], [0, 0, 100, 0], [0, 40, 60, 0], [5, 40, 60, 0], [10, 40, 60, 0], [10, 40, 0, 60]],
    completes: [[0, 0, 0, 0], [0, 0, 100, 0], [0, 40, 60, 0], [5, 40, 60, 0], [5, 65, 35, 0], [5, 65, 0, 35]],
  };
  for (const [, name, body] of paths) {
    const states = [...body!.matchAll(/<li data-minute="(\d+)" data-paid="(\d+)" data-held="(\d+)" data-returned="(\d+)"/g)].map(m => m.slice(1).map(Number));
    expect(states).toEqual(expected[name as keyof typeof expected]);
    for (const [i, state] of states.entries()) {
      expect(state.slice(1).reduce((a, b) => a + b)).toBe(i === 0 ? 0 : 100);
      expect(state.every(n => Number.isInteger(n) && n >= 0)).toBe(true);
    }
    expect(body!.match(/Simulation · Example minute/g)).toHaveLength(6);
    expect(body!.match(/Deadline: minute 10/g)).toHaveLength(6);
  }
  expect([...html.matchAll(/<h1\b/g)]).toHaveLength(1);
  expect(html).toContain("Expiry does not move funds automatically.");
  expect(html).toContain("Capture402 does not verify usage or service delivery.");
  expect(html).toContain("Requires a payer-signed transaction; the deadline does not move funds automatically.");
  const example = html.split('id="demo"')[1]!.split('<section class="c402-home-wrap')[0]!;
  expect(example).not.toMatch(/explorer\.solana|signature|receipt|href="https?:/);
  expect(html).toContain('data-controls hidden');
  expect(html).toContain('data-interactive hidden');
});

test("verification layers remain readable without scripts", () => {
  expect([...html.matchAll(/<tbody>[\s\S]*?<\/tbody>/g)]).toHaveLength(1);
  for (const layer of ["Program", "Integration", "Browser", "Operations"]) expect(html).toContain(`<td>${layer}</td>`);
});

test("stable anchors and dedicated guide/evidence routes both resolve", async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const link of html.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(link[1]);
  for (const id of ["demo", "integration", "evidence", "proof", "latest-demo", "how-it-works", "developers"]) expect(ids).toContain(id);
  for (const route of ["/integrate", "/evidence"]) {
    expect(html).toContain(`href="${route}"`);
    expect((await app().request(route)).status).toBe(200);
  }
  for (const route of ["/homepage.html", "/assets/homepage-proof.json"]) expect((await app().request(route)).status).toBe(404);
  for (const [name, budget] of [["homepage.js", 20_000], ["homepage.css", 25_000]] as const) {
    expect(gzipSync(readFileSync(new URL(name, web))).byteLength).toBeLessThan(budget);
  }
  expect(gzipSync(Buffer.from(html)).byteLength + gzipSync(readFileSync(new URL("homepage.css", web))).byteLength + gzipSync(readFileSync(new URL("homepage.js", web))).byteLength).toBeLessThan(200_000);
});
