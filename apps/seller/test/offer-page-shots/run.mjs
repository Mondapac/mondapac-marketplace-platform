import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Screenshots of the one-page offer (Offer page PR 3), not part of CI. From apps/seller:
//   VITE_PATH=<path to the vite package> node test/offer-page-shots/run.mjs <out-dir>
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
const dist = process.env.SHOTS_DIST ?? join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = join(dist, p === '/' ? 'index.html' : p);
  if (!existsSync(f)) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' })
    .end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const browser = await chromium.launch();
const plan = ['closed', 'price', 'stock', 'draft'].flatMap((s) =>
  [1280, 768, 375].map((w) => [s, w]),
);
for (const scheme of ['light', 'dark']) {
  for (const [scenario, width] of plan) {
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
    if (scenario === 'draft') {
      await page.getByLabel('Price for 1 kg').fill('34.90');
      await page.getByLabel('Price for 250 g').fill('9.90');
    }
    if (scenario !== 'closed') {
      await page
        .getByRole('button', { name: `Details for ${scenario === 'draft' ? '250 g' : '500 g'}` })
        .click();
    }
    if (scenario === 'stock') await page.getByRole('tab', { name: 'Stock' }).click();
    const over = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    console.log(scenario, width, scheme, 'page horizontal overflow:', over);
    await page.screenshot({
      path: join(out, `offer-${scenario}-${width}-${scheme}.png`),
      fullPage: true,
    });
    await ctx.close();
  }
}
await browser.close();
server.close();
