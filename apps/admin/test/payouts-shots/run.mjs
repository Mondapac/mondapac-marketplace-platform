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
const dist = join(here, 'dist');
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
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const ALL = [
  'list',
  'hold',
  'approve',
  'approve-typed',
  'approve-blocked',
  'filters-open',
  'chips',
];
// ONLY=filters-open,chips retakes just those states; WIDTHS=1280,375 just those widths.
const only = process.env.ONLY ? process.env.ONLY.split(',') : ALL.slice(0, 5);
const widths = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [1280, 768, 375];
/** Sets one condition in the open filter panel, adding a row after the ones already there. */
async function setCondition(dialog, field, value, first) {
  if (!first) await dialog.getByRole('button', { name: 'Add condition' }).click();
  await dialog.getByLabel('Field').last().selectOption(field);
  await dialog.getByLabel('Value').last().selectOption(value);
}
for (const scheme of ['light', 'dark']) {
  for (const width of widths) {
    for (const name of only) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByRole('table').waitFor();
      if (name === 'hold') {
        await page.getByRole('button', { name: /^Actions for payout 00000100/ }).click();
        await page.getByRole('menuitem', { name: 'Hold payouts…' }).click();
        await page.getByRole('dialog').waitFor();
      }
      if (name.startsWith('approve')) {
        const ref = name === 'approve-blocked' ? '00000101' : '00000100';
        await page.getByRole('button', { name: new RegExp(`^Actions for payout ${ref}`) }).click();
        await page.getByRole('menuitem', { name: 'Approve…' }).click();
        await page.getByRole('dialog').getByText('Transfer', { exact: true }).waitFor();
        if (name === 'approve-typed') {
          await page.getByLabel(`Type ${ref} to confirm`).fill(ref);
        }
      }
      if (name === 'filters-open' || name === 'chips') {
        await page.getByRole('button', { name: /^Filter/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Filter' });
        await dialog.waitFor();
        await setCondition(dialog, 'status', 'awaiting-approval', true);
        await setCondition(dialog, 'minAmount', '100', false);
        await setCondition(dialog, 'maxAmount', '1000', false);
        if (name === 'chips') {
          await dialog.getByRole('button', { name: 'Apply' }).click();
          await page.getByRole('button', { name: /^Remove filter Status/ }).waitFor();
        }
      }
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({
        path: join(out, `${name}-${width}-${scheme}.png`),
        fullPage: true,
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
