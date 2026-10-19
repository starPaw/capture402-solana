// Local, unconfigured presentation fixture. No economic backend is constructed.
// Use an existing Playwright installation; no application dependency is added.
// HOMEPAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs HOMEPAGE_QA_OUTPUT=/path/to/artifacts node --experimental-strip-types browser/homepage-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createPresentationApp } from '../src/restaurant-server.ts';
const { chromium } = await import(pathToFileURL(process.env.HOMEPAGE_PLAYWRIGHT_MODULE));
const output = process.env.HOMEPAGE_QA_OUTPUT;
assert.ok(output, 'Choose a sanitized evidence output directory');
await mkdir(output, { recursive: true });
const app = createPresentationApp({ programId: 'unconfigured-presentation-fixture', network: 'test', configured: false });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = {
  scope: 'Local presentation/browser fixture only; no live, wallet or economic acceptance.',
  fixture: 'loopback ephemeral createPresentationApp, no economic backend',
  viewports: [], states: [], errors: [], requests: [], unexpectedRequests: [], checks: [],
};
try {
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  async function context(options = {}, demo = false, navigation = false) {
    const ctx = await browser.newContext(options);
    const allowed = demo ? ['/customer', '/merchant', '/assets/style.css'] : navigation
      ? ['/', '/integrate', '/evidence', '/assets/homepage.css', '/assets/homepage.js', '/assets/guide.css']
      : ['/', '/assets/homepage.css', '/assets/homepage.js'];
    await ctx.route('**/*', route => {
      const request = route.request(); const target = new URL(request.url());
      if (target.origin !== url || request.method() !== 'GET' || !allowed.includes(target.pathname)) {
        report.unexpectedRequests.push({ origin: target.origin === url ? 'fixture' : 'external', path: target.pathname, method: request.method() });
        return route.abort();
      }
      return route.continue();
    });
    ctx.on('page', page => {
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
      page.on('request', request => report.requests.push({ context: demo ? 'payment lab, JS disabled' : navigation ? 'navigation' : options.javaScriptEnabled === false ? 'no JS' : 'illustration', path: new URL(request.url()).pathname, method: request.method() }));
    });
    // Any provider or storage access is a failure, rather than a simulated wallet.
    await ctx.addInitScript(() => {
      for (const name of ['solana', 'solflare', 'ethereum', 'localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { get() { throw new Error(`Forbidden illustration access: ${name}`); } });
      }
      window.addEventListener('wallet-standard:app-ready', () => { throw new Error('Wallet discovery attempted'); });
    });
    return ctx;
  }
  const ctx = await context({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(output, 'desktop-1440x900.png') });
  await page.screenshot({ path: join(output, 'desktop-full.png'), fullPage: true });
  for (const [width, height] of [[1440, 900], [390, 844], [360, 844], [320, 740], [720, 450], [360, 225]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px horizontal overflow`);
    report.viewports.push({ width, height, horizontalOverflow: false });
    if (width === 390 || width === 360 && height === 844) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(output, `opening-${width}x${height}.png`) });
      await page.locator('#demo').screenshot({ path: join(output, `example-${width}px.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const terms = await page.locator('.c402-home-terms').innerText();
  const expected = {
    stops: [[0, 0, 0, 0], [0, 0, 100, 0], [0, 40, 60, 0], [5, 40, 60, 0], [10, 40, 60, 0], [10, 40, 0, 60]],
    completes: [[0, 0, 0, 0], [0, 0, 100, 0], [0, 40, 60, 0], [5, 40, 60, 0], [5, 65, 35, 0], [5, 65, 0, 35]],
  };
  const actions = {
    stops: ['Simulate authorization', 'Simulate capture 40', 'Advance example time', 'Advance example time', 'Simulate payer reclaim 60', 'Restart example'],
    completes: ['Simulate authorization', 'Simulate capture 40', 'Advance example time', 'Simulate capture 25', 'Simulate merchant release 35', 'Restart example'],
  };
  async function state(outcome, step) {
    const totals = (await page.locator('[data-total]').allTextContents()).map(Number);
    const minute = Number(await page.locator('[data-time]').innerText());
    assert.deepEqual([minute, ...totals], expected[outcome][step]);
    assert.equal(totals.reduce((a, b) => a + b), step === 0 ? 0 : 100);
    assert.ok(totals.every(n => Number.isInteger(n) && n >= 0));
    assert.equal(await page.locator('.c402-home-terms').innerText(), terms);
    assert.equal(await page.locator('[data-outcome][aria-pressed=true]').getAttribute('data-outcome'), outcome);
    assert.equal(await page.locator('[data-reclaim]').isVisible(), outcome === 'stops' && step >= 4);
    assert.match(await page.locator('.c402-home-mode').innerText(), /no wallet or transactions/);
    assert.match(await page.locator('[data-state-label]').innerText(), /Simulation/);
    assert.equal(await page.locator('[data-next]').count(), 1);
    assert.equal(await page.locator('[data-next]').innerText(), actions[outcome][step]);
    assert.equal(await page.locator('[data-time-axis]').getAttribute('max'), '10');
    assert.equal(await page.locator('#demo a[href*="explorer"]').count(), 0);
    assert.deepEqual(await page.locator('[data-segment]').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('width')))), totals);
    report.states.push({ outcome, step, minute, paid: totals[0], held: totals[1], returned: totals[2] });
  }
  await state('stops', 0);
  await page.locator('[data-explore]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'example-title');
  await page.locator('[data-next]').dblclick(); await state('stops', 1);
  await page.locator('[data-reset]').click(); await state('stops', 0);
  // Native keyboard activation follows the default path, including expiry.
  for (let step = 1; step <= 5; step++) {
    await page.locator('[data-next]').focus();
    await page.keyboard.press(step % 2 ? 'Enter' : 'Space');
    await state('stops', step);
    if (step === 4) {
      await page.waitForTimeout(250);
      await state('stops', 4);
      await page.locator('#demo').screenshot({ path: join(output, 'deadline-held60.png') });
    }
  }
  await page.locator('#demo').screenshot({ path: join(output, 'payer-reclaimed60.png') });
  await page.locator('[data-next]').click(); await state('stops', 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'example-title');
  // Reset and switch from every state; stale actions cannot cross state generations.
  for (const outcome of ['stops', 'completes']) {
    for (let target = 0; target <= 5; target++) {
      await page.locator(`[data-outcome="${outcome}"]`).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'example-title');
      await state(outcome, 0);
      for (let step = 1; step <= target; step++) { await page.locator('[data-next]').click(); await state(outcome, step); }
      if (outcome === 'completes' && target === 5) await page.locator('#demo').screenshot({ path: join(output, 'merchant-released35.png') });
      await page.evaluate(() => { window.staleExampleAction = document.querySelector('[data-next]'); });
      const other = outcome === 'stops' ? 'completes' : 'stops';
      await page.locator(`[data-outcome="${other}"]`).click();
      await page.evaluate(() => { window.staleExampleAction.click(); window.staleExampleAction.click(); });
      await state(other, 0);
      await page.locator(`[data-outcome="${outcome}"]`).click();
      for (let step = 1; step <= target; step++) await page.locator('[data-next]').click();
      await page.locator('[data-reset]').click(); await state(outcome, 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'example-title');
      assert.match(await page.locator('[data-announcement]').innerText(), /Example restarted; no real funds moved/);
    }
  }
  await page.evaluate(() => { const action = document.querySelector('[data-next]'); action.click(); action.click(); action.dispatchEvent(new MouseEvent('click')); });
  await state('completes', 1);
  await page.reload({ waitUntil: 'networkidle' }); await state('stops', 0);
  report.checks.push('Both complete numeric paths, no movement at expiry, immutable terms, reset/switch from every state, stale/repeated action rejection, reload default');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'content');
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator('.c402-home-menu');
  await menu.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await menu.evaluate(e => e.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await menu.evaluate(e => e.open), false);
  assert.equal(await menu.locator('summary').evaluate(e => e === document.activeElement), true);
  await menu.locator('summary').click();
  await menu.getByRole('link', { name: 'Example', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'example-title');
  await page.locator('#proof details summary').click();
  assert.equal(await page.locator('#proof details').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  assert.equal(await page.locator('#proof tbody tr').count(), 4);
  assert((await page.locator('#latest-demo').textContent()).includes('independently reviewed deployment'));
  assert.equal(await page.locator('#latest-demo a').getAttribute('href'), '/customer');
  assert.deepEqual(await page.locator('a[href^="#"]').evaluateAll(links => links.filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash)), []);
  await writeFile(join(output, 'accessibility-tree.txt'), await page.locator('#c402-home-root').ariaSnapshot());
  report.checks.push('Keyboard Enter/Space through default path, skip link, explore/reset/switch focus, menu Escape/link focus, preserved anchors; semantic tree retained, no screen-reader-session claim');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await page.locator('#c402-home-root *').evaluateAll(nodes => nodes.filter(e => {
    const s = getComputedStyle(e); return s.transitionDuration.split(',').some(n => parseFloat(n) !== 0) || s.animationName !== 'none';
  }).map(e => e.tagName)), []);
  await page.locator('[data-next]').click(); await state('stops', 1);
  report.checks.push('Reduced-motion media active: zero transitions/animations; actions remain usable; no autoplay or timer');
  // Check final rendered text contrast against its nearest opaque ancestor surface.
  report.contrast = await page.evaluate(() => {
    function rgb(value) { return value.match(/[\d.]+/g).map(Number).slice(0, 3); }
    function luminance(color) { const c = color.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
    const failures = []; let checked = 0; let minimum = 100;
    for (const element of document.querySelectorAll('#c402-home-root *')) {
      if (!element.getClientRects().length || element.closest('[aria-hidden=true]') || element.closest('.c402-home-sr') || element.matches(':disabled') || ![...element.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden') continue;
      let ancestor = element; let background = 'rgba(0,0,0,0)';
      while (ancestor) { background = getComputedStyle(ancestor).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break; ancestor = ancestor.parentElement; }
      const a = luminance(rgb(style.color)); const b = luminance(rgb(background)); const ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      checked++; minimum = Math.min(minimum, ratio);
      if (ratio < (large ? 3 : 4.5)) failures.push({ text: element.textContent.slice(0,80), color: style.color, background, ratio });
    }
    return { checked, minimum, failures };
  });
  assert.deepEqual(report.contrast.failures, []);
  report.targetSizes = await page.locator('a,button,summary').evaluateAll(elements => elements.filter(e => e.getClientRects().length && !e.closest('.c402-home-skip')).map(e => ({ text: e.textContent.trim(), height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width })).filter(e => e.height < 44 || e.width < 44));
  assert.deepEqual(report.targetSizes, []);
  report.checks.push('Rendered text contrast >= AA thresholds; visible interactive targets at least 44x44px');

  const noJsContext = await context({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const fallback = await noJsContext.newPage(); await fallback.goto(url);
  assert.equal(await fallback.locator('[data-controls]').isVisible(), false);
  assert.equal(await fallback.locator('[data-interactive]').isVisible(), false);
  for (const path of ['stops', 'completes']) {
    assert.equal(await fallback.locator(`[data-path="${path}"] li`).count(), 6);
    for (const item of await fallback.locator(`[data-path="${path}"] li`).all()) assert.equal(await item.isVisible(), true);
  }
  await fallback.locator('#proof summary').click();
  assert.equal(await fallback.locator('#proof details').evaluate(e => e.open), true);
  assert.equal(await fallback.evaluate(() => document.documentElement.scrollWidth), 390);
  await fallback.locator('#demo').screenshot({ path: join(output, 'no-js-both-paths.png') });
  report.checks.push('No JS: two complete ordered simulations, fixed terms, explicit reclaim boundary and historical disclosures usable');
  await noJsContext.close();
  for (const name of ['style.css', 'app.js', 'wallet.js', 'receipt-state.js']) {
    const response = await app.request(`/assets/${name}`);
    assert.equal(response.status, 200, `${name} application asset status`);
    assert.match(response.headers.get('content-type') ?? '', name.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
    assert.equal(await response.text(), readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8'));
  }
  for (const route of ['/customer', '/merchant']) {
    const demoContext = await context({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } }, true);
    const demo = await demoContext.newPage(); const requestStart = report.requests.length;
    await demo.goto(new URL(route, url).href);
    assert.match(await demo.title(), /^Capture402 payment lab · Live Devnet$/);
    assert.match(await demo.locator('header').innerText(), /Capture402\s+Payment lab/);
    assert.equal(await demo.locator('#terms-heading').innerText(), '100 test-token maximum');
    assert.equal(await demo.locator('#next-step').innerText(), 'Check readiness');
    assert.match(await demo.locator('noscript').innerText(), /JavaScript is required to inspect original orders and use the wallet\. No payment actions are available here without it\./);
    assert.equal(await demo.locator('#next-action').isDisabled(), true);
    assert.equal(await demo.locator('link[rel="stylesheet"][href="/assets/style.css"]').count(), 1);
    assert.equal(await demo.locator('script[type="module"][src="/assets/app.js"]').count(), 1);
    assert.equal(await demo.locator('link[href="/assets/homepage.css"]').count(), 0);
    const routeRequests = report.requests.slice(requestStart).filter(r => r.context === 'payment lab, JS disabled');
    assert.deepEqual([...new Set(routeRequests.map(r => `${r.method} ${r.path}`))].sort(), ['GET /assets/style.css', `GET ${route}`].sort());
    await demo.screenshot({ path: join(output, `${route.slice(1)}-preserved.png`) });
    await demoContext.close();
  }
  report.checks.push('Customer and merchant show the Capture402 payment lab, exact application assets and no-JS payment explanation; homepage CSS stays isolated');
  assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.errors, []);
  const homeRequests = report.requests.filter(r => r.context === 'illustration');
  assert.deepEqual([...new Set(homeRequests.map(r => `${r.method} ${r.path}`))].sort(), ['GET /', 'GET /assets/homepage.css', 'GET /assets/homepage.js']);
  report.checks.push('Zero unexpected requests; homepage only GET / and CSS/JS. Zero provider/storage access, wallet discovery, economic/API/RPC calls or browser errors');
  const navContext = await context({ viewport: { width: 1440, height: 900 } }, false, true);
  const navPage = await navContext.newPage();
  await navPage.goto(url);
  await navPage.locator('.c402-home-desktop-nav a[href="/integrate"]').click();
  assert.equal(new URL(navPage.url()).pathname, '/integrate');
  await navPage.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/integrate', '/evidence']) {
    await navPage.goto(url);
    await navPage.locator('.c402-home-menu summary').click();
    await navPage.locator(`.c402-home-menu a[href="${route}"]`).click();
    assert.equal(new URL(navPage.url()).pathname, route);
  }
  await navContext.close();
  const noJsNavigation = await context({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } }, false, true);
  const noJsPage = await noJsNavigation.newPage();
  await noJsPage.goto(url);
  await noJsPage.locator('.c402-home-menu summary').click();
  await noJsPage.locator('.c402-home-menu a[href="/evidence"]').click();
  assert.equal(new URL(noJsPage.url()).pathname, '/evidence');
  await noJsNavigation.close();
  report.checks.push('Desktop and mobile route links reach /integrate and /evidence; mobile route navigation also works without JavaScript');
  assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.errors, []);
  report.requests = [...new Map(report.requests.map(r => [`${r.context} ${r.method} ${r.path}`, r])).values()];
  await writeFile(join(output, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); server.close();
}
