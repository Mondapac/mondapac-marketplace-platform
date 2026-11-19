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
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const FIRST = /^Actions for /;

// Each shot: what to do on the loaded list before the screenshot.
const steps = {
  list: async () => {},
  filter: async (page) => {
    await page.getByRole('button', { name: /^Filter/ }).click();
    await page.getByRole('dialog').waitFor();
  },
  actions: async (page) => {
    await page.getByRole('button', { name: FIRST }).first().click();
    await page.getByRole('menu').waitFor();
  },
  'no-match': async (page) => {
    const box = page.getByRole('searchbox', { name: 'Search' });
    await box.fill('zzzz');
    await box.press('Enter');
    await page.getByText('No posts match').waitFor();
  },
  'empty-view': async (page) => {
    await page.getByRole('button', { name: /^Drafts/ }).click();
    await page.getByText('No posts are drafts.').waitFor();
  },
  columns: async (page) => {
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('dialog', { name: 'Columns' }).waitFor();
  },
  sort: async (page) => {
    await page.getByRole('button', { name: /^Sort/ }).click();
    await page.getByRole('radio', { name: 'Newest first' }).waitFor();
  },
  bulk: async (page) => {
    await page
      .getByRole('checkbox', { name: /^Select / })
      .first()
      .check();
    await page.getByRole('button', { name: 'Bulk action' }).click();
    await page.getByRole('menu').waitFor();
  },
  export: async (page) => {
    await steps.bulk(page);
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await page.getByRole('dialog').waitFor();
  },
};
const everywhere = ['list'];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    const names = width === 1280 ? Object.keys(steps) : [...everywhere, 'filter', 'actions'];
    for (const name of names) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByRole('table').waitFor();
      await steps[name](page);
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({
        path: join(out, `${name}-${width}-${scheme}.png`),
        fullPage: name === 'list',
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
