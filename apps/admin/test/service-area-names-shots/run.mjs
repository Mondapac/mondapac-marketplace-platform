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
  {
    stdio: 'inherit',
    env: process.env,
  },
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 375]) {
    for (const step of ['list', 'menu', 'dialog', 'empty', 'error']) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(
        `http://127.0.0.1:${port}/?state=${step === 'menu' || step === 'dialog' ? 'list' : step}`,
      );
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      if (step === 'empty') await page.getByRole('table').waitFor();
      else if (step === 'error') await page.getByText('could not be loaded').waitFor();
      else await page.getByText('Greater Brisbane').first().waitFor();
      if (step === 'menu' || step === 'dialog') {
        await page.getByRole('button', { name: 'Actions for Greater Brisbane' }).click();
        if (step === 'dialog') await page.getByRole('menuitem', { name: 'Edit names…' }).click();
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(step, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({
        path: join(out, `${step}-${width}-${scheme}.png`),
        fullPage: step !== 'menu' && step !== 'dialog',
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
