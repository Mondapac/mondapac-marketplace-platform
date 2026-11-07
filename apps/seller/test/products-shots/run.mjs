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
const dist = process.env.SHOTS_DIST ?? join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const COLOURS = [
  '#d9b36c',
  '#b5543c',
  '#8a6a3b',
  '#c9c2a8',
  '#a14b32',
  '#d6c7a1',
  '#9aa56b',
  '#d98a9a',
];
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  // A product photo: a colour tile by the last digit of its id.
  const photo = /\/images\/[0-9a-f-]*20(\d)\/thumb$/.exec(p);
  if (photo) {
    const colour = COLOURS[Number(photo[1])] ?? '#ccc';
    res
      .writeHead(200, { 'content-type': 'image/svg+xml' })
      .end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${colour}"/><circle cx="20" cy="20" r="9" fill="#fff" fill-opacity=".45"/></svg>`,
      );
    return;
  }
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
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const plan = [
  ['list', 1280],
  ['list', 375],
  ['filtered', 1280],
  ['sheet', 375],
];
for (const [scenario, width] of plan) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`http://localhost:${port}/?s=${scenario === 'sheet' ? 'list' : scenario}`);
  await page.evaluate(() =>
    globalThis.document.documentElement.setAttribute('data-theme', 'light'),
  );
  await page.locator('tbody a').first().waitFor();
  if (scenario === 'sheet') {
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByRole('dialog', { name: 'Filter products' }).waitFor();
  }
  await page.waitForTimeout(300);
  const over = await page.evaluate(
    () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
  );
  console.log(scenario, width, 'page horizontal overflow:', over);
  await page.screenshot({
    path: join(out, `products-${scenario}-${width}-light.png`),
    fullPage: scenario !== 'sheet',
  });
  await ctx.close();
}
await browser.close();
server.close();
