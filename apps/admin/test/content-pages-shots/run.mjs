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
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const shots = [
  ['list', '#list', (p) => p.getByText('Ramadan specials').waitFor()],
  ['list-filtered', '#list', async (p) => {
    await p.getByText('Ramadan specials').waitFor();
    await p.getByRole('button', { name: 'Landing pages' }).click();
    await p.getByLabel('Status').selectOption('draft');
  }],
  ['list-none', '#list', async (p) => {
    await p.getByText('Ramadan specials').waitFor();
    await p.getByLabel('Search by title or address').fill('zzz');
    await p.getByText('No page matches').waitFor();
  }],
  ['list-readonly', '#readonly', (p) => p.getByText(/view pages but not change/).waitFor()],
  ['list-empty', '#empty', (p) => p.getByText('No pages yet').waitFor()],
  ['list-error', '#failed', (p) => p.getByText(/could not be loaded/).waitFor()],
  ['new', '#new', (p) => p.getByRole('radio', { name: /Info page/ }).waitFor()],
  ['new-filled', '#new', async (p) => {
    await p.getByRole('radio', { name: /Campaign landing/ }).click();
    await p.getByLabel('Page title').fill('Ramadan specials');
    await p.getByLabel('Linked category').selectOption('c1');
  }],
  ['new-errors', '#new', async (p) => {
    await p.getByRole('radio', { name: /Info page/ }).waitFor();
    await p.getByLabel('Address').fill('cart');
    await p.getByRole('button', { name: 'Create draft' }).click();
    await p.getByText('Enter a title.').waitFor();
  }],
];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const [name, hash, ready] of shots) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/${hash}`);
      await page.evaluate((s) => globalThis.document.documentElement.setAttribute('data-theme', s), scheme);
      await ready(page);
      await page.waitForTimeout(250);
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
