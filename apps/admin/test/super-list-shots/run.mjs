import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'out');
const prefix = process.argv[3] ?? 'admin-products';
mkdirSync(out, { recursive: true });
execFileSync('node', [join(process.env.VITE_PATH, 'bin/vite.js'), 'build', '--config', join(here, 'vite.config.mjs')], { stdio: 'inherit' });
const dist = join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = join(dist, p === '/' || !extname(p) ? 'index.html' : p);
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const browser = await chromium.launch();
const views = [['list', null], ['menu', 'menu'], ['delete', 'delete']];
for (const scheme of ['light', 'dark']) for (const width of [1280, 768, 375]) for (const [name, action] of views) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
  await page.getByText('Sella basmati rice').first().waitFor();
  if (action) {
    await page.getByRole('button', { name: /Actions for Sella basmati rice/ }).click();
    if (action === 'delete') {
      await page.getByRole('menuitem', { name: /Delete/ }).click();
      await page.getByRole('dialog').waitFor();
    }
  }
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(name, width, scheme, 'overflow:', over);
  await page.screenshot({ path: join(out, `${prefix}-${name}-${width}-${scheme}.png`), fullPage: name === 'list' });
  await ctx.close();
}
await browser.close();
server.close();
