import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detail, list, saved } from './fixtures.mjs';

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
const json = (res, body) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/reviews/admin/moderation/list') return json(res, list);
  if (p.startsWith('/api/lists/admin/saved-filters')) return json(res, saved);
  if (p.startsWith('/api/reviews/admin/moderation/')) return json(res, detail);
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
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const name of ['list', 'menu', 'remove']) {
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
      await page.getByText('Not what I ordered', { exact: false }).first().waitFor();
      await page.waitForTimeout(400);
      if (name !== 'list') {
        await page
          .getByRole('button', { name: /^Actions for the 1-star review Awful/ })
          .first()
          .click();
        if (name === 'remove') {
          await page.getByRole('menuitem', { name: 'Remove…' }).click();
          await page
            .getByRole('dialog', { name: 'Remove review' })
            .getByText('Not what I ordered', { exact: false })
            .waitFor();
          await page.getByLabel('Reason').selectOption('illegal');
        }
        await page.waitForTimeout(300);
      }
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
