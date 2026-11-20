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
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});

const STATES = (process.env.SHOTS_ONLY ?? 'list,filters,sort,columns,export,empty,error').split(
  ',',
);
const WIDTHS = (process.env.SHOTS_WIDTHS ?? '1280,768,375').split(',').map(Number);

async function openTool(page, name) {
  await page
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await page.getByRole('dialog', { name }).waitFor();
}

for (const scheme of ['light', 'dark']) {
  for (const width of WIDTHS) {
    for (const name of STATES) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const search = name === 'empty' || name === 'error' ? `?state=${name}` : '';
      await page.goto(`http://127.0.0.1:${port}/${search}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      if (name === 'error') {
        await page.getByRole('button', { name: 'Try again' }).waitFor();
      } else if (name === 'empty') {
        await page.getByText('No payouts yet').waitFor();
      } else {
        await page.getByRole('table').waitFor();
      }
      if (name === 'filters') {
        await openTool(page, 'Filter');
        await page.getByLabel('Field').selectOption('payoutOn');
        await page.getByLabel('Value').selectOption('next-7-days');
        await page.getByRole('button', { name: 'Add condition' }).click();
        await page.getByLabel('Field').last().selectOption('minAmount');
        await page.getByLabel('Value').last().selectOption('500');
        await page.getByRole('button', { name: 'Apply' }).click();
        await page.getByRole('button', { name: /^Remove filter Payout on/ }).waitFor();
        await openTool(page, 'Filter');
      }
      if (name === 'sort') await openTool(page, 'Sort');
      if (name === 'columns') await openTool(page, 'Columns');
      if (name === 'export') {
        await page
          .getByRole('checkbox', { name: /^Select Payout/ })
          .first()
          .check();
        await page.getByRole('button', { name: 'Bulk action' }).click();
        await page.getByRole('menuitem', { name: /^Export/ }).click();
        await page.getByRole('dialog', { name: /^Export/ }).waitFor();
      }
      if (name === 'tabs') {
        const nav = page.getByRole('navigation', { name: 'Payout status' });
        const scrolls = await nav.evaluate((el) => el.scrollWidth > el.clientWidth);
        await page.getByRole('button', { name: /^Settled/ }).focus();
        await page.waitForTimeout(300);
        const left = await nav.evaluate((el) => el.scrollLeft);
        const inView = await page.getByRole('button', { name: /^Settled/ }).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const n = el.parentElement.getBoundingClientRect();
          return r.left >= n.left - 1 && r.right <= n.right + 1;
        });
        console.log('tabs scroll:', scrolls, 'scrollLeft:', left, 'focused tab in view:', inView);
      }
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => {
        const root = globalThis.document.documentElement;
        return root.scrollWidth > root.clientWidth;
      });
      console.log(name, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({
        path: join(out, `earnings-${name}-${width}-${scheme}.png`),
        fullPage: true,
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
