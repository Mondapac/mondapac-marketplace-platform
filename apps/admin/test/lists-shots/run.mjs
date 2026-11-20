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
}).listen(0);
const port = server.address().port;
const { chromium } = createRequire(process.env.PW_PATH ?? import.meta.url)('playwright');
const browser = await chromium.launch();
// [list, first row text, row name for the Actions menu, menu item, dialog title, bulk item]
const lists = [
  ['activities', 'Grocery', 'Grocery', 'Deactivate…', 'Deactivate Grocery?', null],
  ['tags', 'BBQ', 'BBQ', 'Edit…', null, null],
  ['suggestions', 'Eid gifts', 'Eid gifts', 'Approve…', 'Approve “Eid gifts”?', 'Reject ticked…'],
  [
    'proposals',
    'Al Noor Grocers',
    'Persian spices',
    'Reject…',
    'Reject “Persian spices”?',
    'Approve ticked…',
  ],
];
for (const [list, first, rowName, item, dialogTitle, bulkItem] of lists) {
  if (process.env.ONLY && process.env.ONLY !== list) continue;
  for (const scheme of ['light', 'dark']) {
    for (const width of [1280, 768, 375]) {
      for (const step of ['list', 'menu', 'dialog', 'bulk']) {
        if (step === 'dialog' && dialogTitle === null) continue;
        if (step === 'bulk' && bulkItem === null) continue;
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
          deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/?list=${list}`);
        await page.evaluate(
          (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
          scheme,
        );
        await page.getByText(first, { exact: true }).first().waitFor();
        if (step === 'menu' || step === 'dialog') {
          await page.getByRole('button', { name: `Actions for ${rowName}` }).click();
          await page.getByRole('menuitem', { name: item }).waitFor();
        }
        if (step === 'dialog') {
          await page.getByRole('menuitem', { name: item }).click();
          await page.getByRole('dialog', { name: dialogTitle }).waitFor();
        }
        if (step === 'bulk') {
          await page.getByRole('checkbox', { name: `Select ${rowName}` }).click();
          await page.getByRole('button', { name: 'Bulk action' }).click();
          await page.getByRole('menuitem', { name: bulkItem }).click();
          await page.getByRole('dialog').waitFor();
        }
        await page.waitForTimeout(300);
        const over = await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
        );
        console.log(list, step, width, scheme, 'horizontal overflow:', over);
        await page.screenshot({
          path: join(out, `${list}-${step}-${width}-${scheme}.png`),
          fullPage: step === 'list',
        });
        await ctx.close();
      }
    }
  }
}
await browser.close();
server.close();
