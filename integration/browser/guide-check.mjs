// Loopback presentation only. Uses an existing Playwright installation, no economic backend.
// GUIDE_PLAYWRIGHT_MODULE and GUIDE_QA_OUTPUT configure local tools and retained output.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createPresentationApp } from '../src/restaurant-server.ts';
const { chromium } = await import(pathToFileURL(process.env.GUIDE_PLAYWRIGHT_MODULE));
const output = process.env.GUIDE_QA_OUTPUT;
await mkdir(output, { recursive: true });
const server = serve({ fetch: createPresentationApp({ programId: 'unconfigured', network: 'test', configured: false }).fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const report = { browser: browser.version(), scope: 'Local unconfigured presentation; no economic backend, no external navigation', viewports: [], requests: [], errors: [], checks: [] };
  const context = await browser.newContext();
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { report.errors.push('Unexpected external request'); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') report.errors.push(e.text()); });
  page.on('request', r => report.requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
  await page.addInitScript(() => {
    for (const key of ['solana', 'solflare', 'ethereum']) Object.defineProperty(window, key, { get() { throw Error('Wallet touched'); } });
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/integrate', '/evidence']) {
      await page.goto(origin + path, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('h1').count(), 1);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to content');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'content');
      for (const summary of await page.locator('details summary').all()) await summary.click();
      if (path === '/integrate') {
        const comparison = page.locator('#compare details');
        const comparisonSummary = comparison.locator('summary');
        await comparisonSummary.focus();
        await page.keyboard.press('Enter');
        assert.equal(await comparison.evaluate(e => e.open), false);
        await page.keyboard.press('Space');
        assert.equal(await comparison.evaluate(e => e.open), true);
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.equal(layout.scrollWidth, width, `${path} ${width}px overflow`);
      report.viewports.push({ path, ...layout, detailsExpanded: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(output, `${path.slice(1)}-${width}.png`) });
      if (path === '/integrate' && (width === 1440 || width === 320)) {
        await page.locator('#compare').screenshot({ path: join(output, `compare-${width}.png`) });
      }
      const anchors = await page.locator('.contents a').evaluateAll(es => es.map(e => e.getAttribute('href')));
      for (const anchor of anchors) {
        await page.locator(`.contents a[href="${anchor}"]`).click();
        assert.equal(new URL(page.url()).hash, anchor);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await page.locator('.c402-home-desktop-nav a[href="/integrate"]').click();
  await page.waitForURL(origin + '/integrate');
  await page.locator('a.button[href="#sequence"]').click();
  assert.equal(new URL(page.url()).hash, '#sequence');
  await page.locator('a.button[href="/evidence"]').click();
  await page.waitForURL(origin + '/evidence');
  await page.locator('a.button[href="/integrate#reclaim"]').click();
  await page.waitForURL(origin + '/integrate#reclaim');
  assert.equal(await page.locator('#reclaim h2').innerText(), 'If the application server is unavailable.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.locator('.c402-home-menu summary').click();
  await page.locator('.c402-home-menu a[href="/integrate"]').click();
  await page.waitForURL(origin + '/integrate');
  await page.goto(origin);
  await page.locator('.c402-home-menu summary').click();
  await page.locator('.c402-home-menu a[href="/evidence"]').click();
  await page.waitForURL(origin + '/evidence');
  report.checks.push('Homepage mobile menu route links navigate to guide and evidence');
  report.checks.push('Homepage → integration → evidence → standalone recovery navigation; all section links resolve');
  await writeFile(join(output, 'accessibility-tree.txt'), await page.locator('main').ariaSnapshot());
  const fallback = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const nojs = await fallback.newPage();
  for (const path of ['/integrate', '/evidence']) {
    await nojs.goto(origin + path);
    await nojs.locator('details summary').first().click();
    assert.equal(await nojs.locator('details').first().evaluate(e => e.open), true);
    assert.equal(await nojs.evaluate(() => document.documentElement.scrollWidth), 390);
  }
  await nojs.goto(origin);
  await nojs.locator('.c402-home-menu summary').click();
  await nojs.locator('.c402-home-menu a[href="/integrate"]').click();
  assert.equal(new URL(nojs.url()).pathname, '/integrate');
  report.checks.push('No-JS mobile menu reaches the guide');
  report.checks.push('1440/390/320px expanded evidence and guide: no overflow; native disclosures and skip link; JavaScript-disabled 390px navigation');
  report.requests = [...new Map(report.requests.map(r => [`${r.method} ${r.path}`, r])).values()];
  assert(report.requests.every(r => r.method === 'GET' && ['/', '/integrate', '/evidence', '/assets/guide.css', '/assets/homepage.css', '/assets/homepage.js'].includes(r.path)));
  assert.deepEqual(report.errors, []);
  report.checks.push('Only static GET requests; no API/config, RPC, wallet access, POST, external request or browser error');
  await writeFile(join(output, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}
