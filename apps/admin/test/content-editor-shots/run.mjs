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
  ['content', '#content', (p) => p.getByRole('heading', { name: 'Hero' }).waitFor()],
  ['content-system', '#content-system', (p) => p.getByText(/Filled by the app/).waitFor()],
  [
    'content-readonly',
    '#content-readonly',
    (p) => p.getByText(/view this page but not change/).waitFor(),
  ],
  [
    'content-edit-banner',
    '#content',
    async (p) => {
      await p.getByRole('button', { name: /^Edit/ }).first().click();
      await p.getByRole('heading', { name: 'Edit Banner' }).waitFor();
    },
  ],
  [
    'content-edit-errors',
    '#edit-errors',
    async (p) => {
      await p.getByRole('button', { name: /^Edit/ }).first().click();
      await p.getByLabel(/^Title/).fill('');
      await p.getByRole('button', { name: 'Save to draft' }).click();
      await p.getByText('Check the marked fields and try again.').waitFor();
    },
  ],
  [
    'content-edit-text',
    '#content',
    async (p) => {
      await p.getByRole('button', { name: /^Edit/ }).nth(4).click();
      await p.getByRole('heading', { name: 'Edit Text' }).waitFor();
    },
  ],
  [
    'content-add-menu',
    '#content',
    async (p) => {
      await p.getByRole('button', { name: 'Add module' }).nth(2).click();
      await p.getByRole('menuitem', { name: 'Image and text' }).waitFor();
    },
  ],
  [
    'content-add-shelf',
    '#content',
    async (p) => {
      await p.getByRole('button', { name: 'Add module' }).nth(2).click();
      await p.getByRole('menuitem', { name: 'Product shelf' }).click();
      await p.getByRole('heading', { name: 'Add Product shelf' }).waitFor();
    },
  ],
  [
    'content-remove',
    '#content',
    async (p) => {
      await p.getByRole('button', { name: 'More actions for Product shelf' }).first().click();
      await p.getByRole('menuitem', { name: 'Remove' }).click();
      await p.getByRole('heading', { name: 'Remove Product shelf?' }).waitFor();
    },
  ],
  [
    'content-stale',
    '#content-stale',
    async (p) => {
      await p.getByRole('switch', { name: 'Show Banner to buyers' }).click();
      await p.getByText(/changed since you opened it/).waitFor();
    },
  ],
  ['settings', '#settings', (p) => p.getByLabel('Page title').waitFor()],
  ['settings-pending', '#settings-pending', (p) => p.getByText(/wait for publishing/).waitFor()],
  [
    'settings-errors',
    '#settings-errors',
    async (p) => {
      await p.getByLabel('Page title').fill('');
      await p.getByLabel('Address').fill('home');
      await p.getByLabel('Search and share title').fill('x'.repeat(75));
      await p.getByRole('button', { name: 'Save to draft' }).click();
      await p.getByText('Enter a title.').waitFor();
    },
  ],
  ['settings-system', '#settings-system', (p) => p.getByLabel('Page title').waitFor()],
  [
    'settings-readonly',
    '#settings-readonly',
    (p) => p.getByText(/view this page but not change/).waitFor(),
  ],
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
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
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
