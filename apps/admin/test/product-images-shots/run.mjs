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
const tints = [
  '#d9c7a3',
  '#b9d2c2',
  '#c9c3e0',
  '#e3c1c1',
  '#c4d6e6',
  '#e0d8b0',
  '#cfe0c4',
  '#d8c4dc',
];
// A photo stand-in: a tinted square with its number, served for every thumbnail path.
const photo = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="${tints[n % tints.length]}"/><circle cx="120" cy="110" r="56" fill="#ffffff" opacity="0.6"/><text x="120" y="210" font-family="sans-serif" font-size="28" text-anchor="middle" fill="#333">Photo ${n + 1}</text></svg>`;
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const thumb = /\/api\/catalog\/admin\/products\/[^/]+\/images\/[^/]+-0*(\d+)\/thumb$/.exec(p);
  if (thumb) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(photo(Number(thumb[1]) - 100));
    return;
  }
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
const views = [
  ['empty', '?images=0', null],
  ['filled', '?images=4&outside=1', null],
  ['menu', '?images=4', 'menu'],
  ['delete-dialog', '?images=4', 'delete'],
  ['full', '?images=8', null],
];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const [name, query, action] of views) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/${query}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByText('Images', { exact: true }).first().waitFor();
      if (action !== null) {
        await page.getByRole('button', { name: 'Image 2 options' }).click();
        if (action === 'delete') await page.getByRole('menuitem', { name: 'Delete' }).click();
      }
      await page.waitForTimeout(400);
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
