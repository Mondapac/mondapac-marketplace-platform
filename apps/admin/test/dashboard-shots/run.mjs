import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'out');
mkdirSync(out, { recursive: true });
const vitePath = process.env.VITE_PATH;
if (!vitePath) throw new Error('set VITE_PATH to the vite package folder');
execFileSync(
  'node',
  [join(vitePath, 'bin/vite.js'), 'build', '--config', join(here, 'vite.config.mjs')],
  { stdio: 'inherit', env: process.env },
);
const dist = process.env.SHOTS_DIST ?? join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = join(dist, p === '/' || !extname(p) ? 'index.html' : p);
  if (!existsSync(f)) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' })
    .end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const requireFrom = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_PATH
  ? requireFrom(process.env.PLAYWRIGHT_PATH)
  : requireFrom('playwright');
const browser = await chromium.launch();
// name, scenario: the dashboard with every card, a withheld net earnings, one day of data, no sales
const views = [
  ['admin-dashboard', 'full', [1280, 768, 375, 360]],
  ['admin-dashboard-partial', 'partial', [1280]],
  ['admin-dashboard-sparse', 'sparse', [1280]],
  ['admin-dashboard-empty', 'empty', [1280]],
  ['admin-dashboard-custom', 'custom', [1280, 375]],
  ['admin-dashboard-custom-refused', 'custom-bad', [1280, 375]],
  // Dashboards v2 phase 2 cards: full (above), every card short of data, every card failed.
  ['admin-dashboard-p2-not-enough', 'p2-thin', [1280, 768, 375]],
  ['admin-dashboard-p2-failed', 'p2-failed', [1280, 375]],
  // Drill-down: keyboard focus on a status link of Orders by status, and a pointer on a day of
  // the revenue chart (its link column; the tooltip and marker show the hovered day).
  ['admin-dashboard-drill-focus', 'full', [1280, 375], 'drill-focus'],
  ['admin-dashboard-drill-hover', 'full', [1280, 375], 'drill-hover'],
];
// SHOTS_ONLY: a comma-separated list of view names to take (all when unset).
const only = process.env.SHOTS_ONLY?.split(',');
for (const scheme of ['light', 'dark']) {
  for (const [name, scenario, widths, action] of views) {
    if (only !== undefined && !only.includes(name)) continue;
    for (const width of widths) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/?s=${scenario}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
      await page.waitForTimeout(500);
      if (action === 'drill-focus') {
        // A Tab first, so the browser shows focus as it does for a keyboard user.
        await page.keyboard.press('Tab');
        await page.getByRole('link', { name: /^View orders: Delivered/ }).focus();
        await page.waitForTimeout(200);
      }
      if (action === 'drill-hover') {
        const day = page.locator('svg a[data-point-link]').nth(4);
        await day.scrollIntoViewIfNeeded();
        await day.hover();
        await page.waitForTimeout(200);
      }
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({ path: join(out, `${name}-${width}-${scheme}.png`), fullPage: true });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
