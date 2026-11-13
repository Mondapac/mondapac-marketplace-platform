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
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const name of ['queue', 'review', 'request']) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/?view=${name === 'queue' ? 'queue' : 'review'}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByRole('heading', { level: 1 }).waitFor();
      if (name === 'request') {
        await page.getByRole('button', { name: 'Request changes' }).click();
        await page.getByRole('dialog').waitFor();
      }
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      const dialog = name === 'request' ? page.getByRole('dialog') : null;
      if (dialog) await dialog.screenshot({ path: join(out, `${name}-${width}-${scheme}.png`) });
      else
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
