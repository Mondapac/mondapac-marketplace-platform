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
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const shots = [
  ['13-hide-375', 2, 'Hide'],
  ['14-change-url-name-375', 2, 'Change URL name'],
  ['15-add-child-375', 2, 'Add child'],
  ['16-discard-375', 3, 'Discard'],
];
for (const scheme of ['light', 'dark']) {
  for (const [name, n, button] of shots) {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 700 },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/?n=${n}`);
    await page.evaluate(
      (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
      scheme,
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    const over = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    console.log(name, scheme, 'horizontal overflow:', over);
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
    await ctx.close();
  }
}
await browser.close();
server.close();
