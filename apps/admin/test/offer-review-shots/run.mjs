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

// Each view: a ready text, then named steps that act on the page before the screenshot.
const views = {
  first: {
    ready: 'Medjool dates 500 g',
    steps: {
      list: async () => undefined,
      drawer: async (page) => {
        await page.getByRole('button', { name: 'Review Lamb shoulder, halal' }).click();
        await page.getByRole('dialog', { name: 'Offer review' }).waitFor();
        await page.waitForTimeout(300);
      },
      'bulk-ok': async (page) => {
        for (const name of ['Medjool dates 500 g', 'Tahini 450 g']) {
          await page.getByRole('checkbox', { name: `Select ${name}` }).click();
        }
        await page.getByRole('button', { name: 'Bulk action' }).click();
        await page.getByRole('menuitem', { name: 'Approve ticked…' }).click();
        await page.getByRole('dialog').waitFor();
      },
      'bulk-blocked': async (page) => {
        for (const name of ['Medjool dates 500 g', 'Rose water 250 ml']) {
          await page.getByRole('checkbox', { name: `Select ${name}` }).click();
        }
        await page.getByRole('button', { name: 'Bulk action' }).click();
        await page.getByRole('menuitem', { name: 'Approve ticked…' }).click();
        await page.getByRole('dialog', { name: 'These rows need a closer look' }).waitFor();
      },
    },
  },
  edits: {
    ready: 'Medjool dates 500 g',
    steps: {
      list: async () => undefined,
      drawer: async (page) => {
        await page.getByRole('button', { name: 'Review Medjool dates 500 g' }).click();
        await page.getByRole('dialog', { name: 'Offer review' }).waitFor();
        await page.waitForTimeout(300);
      },
      filters: async (page) => {
        await page.getByRole('button', { name: 'Filter' }).click();
        await page.waitForTimeout(300);
      },
    },
  },
  seller: {
    ready: 'Trusted from start',
    steps: {
      card: async () => undefined,
      dialog: async (page) => {
        await page.getByRole('switch', { name: 'Trusted from start' }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('textbox', { name: /Reason/ }).fill('Long record of clean listings.');
      },
    },
  },
  categories: {
    ready: 'Food > Meat > Lamb',
    steps: {
      table: async () => undefined,
      dialog: async (page) => {
        await page.getByRole('switch', { name: 'Review stop for Food > Meat > Lamb' }).click();
        await page.getByRole('dialog').waitFor();
      },
    },
  },
  banner: { ready: 'Emergency stop is on', steps: { banner: async () => undefined } },
};
for (const [view, { ready, steps }] of Object.entries(views)) {
  if (process.env.ONLY && process.env.ONLY !== view) continue;
  for (const scheme of ['light', 'dark']) {
    for (const width of [1280, 375]) {
      for (const [step, act] of Object.entries(steps)) {
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
          deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/?view=${view}`);
        await page.evaluate(
          (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
          scheme,
        );
        await page.getByText(ready, { exact: true }).first().waitFor();
        await act(page);
        await page.waitForTimeout(300);
        const over = await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
        );
        console.log(view, step, width, scheme, 'horizontal overflow:', over);
        await page.screenshot({
          path: join(out, `${view}-${step}-${width}-${scheme}.png`),
          fullPage: step === 'list' || step === 'card' || step === 'table',
        });
        await ctx.close();
      }
    }
  }
}
await browser.close();
server.close();
