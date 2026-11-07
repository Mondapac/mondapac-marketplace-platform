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
const states = ['list', 'filtered', 'empty', 'error', 'loading', 'viewonly'];
const widths = [1280, 768, 375];
const plan = [...states.flatMap((state) => widths.map((width) => [state, width])), ['sheet', 375]];
// Each header starts where its cells start (table layout only), and no text is cut off.
const measure = () => {
  const doc = globalThis.document.documentElement;
  const table = globalThis.document.querySelector('table');
  const misaligned = [];
  if (table && globalThis.getComputedStyle(table.querySelector('thead')).position !== 'absolute') {
    const heads = [...table.querySelectorAll('thead th')];
    const first = table.querySelector('tbody tr:has(td:nth-child(2))');
    if (first && heads.length > 1) {
      const cells = [...first.children];
      heads.forEach((th, i) => {
        const gap = Math.abs(
          th.getBoundingClientRect().left - cells[i].getBoundingClientRect().left,
        );
        if (cells[i] && gap > 1) misaligned.push(`${th.textContent}:${gap.toFixed(1)}`);
      });
    }
  }
  const clipped = [...globalThis.document.querySelectorAll('body *')]
    .filter(
      (el) => el.children.length === 0 && el.clientWidth > 2 && el.scrollWidth > el.clientWidth + 1,
    )
    .map((el) => el.textContent.slice(0, 30));
  return { scroll: doc.scrollWidth, client: doc.clientWidth, misaligned, clipped };
};
for (const theme of ['light', 'dark']) {
  for (const [scenario, width] of plan) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (error) => console.log('page error:', error.message));
    await page.goto(`http://localhost:${port}/?s=${scenario === 'sheet' ? 'list' : scenario}`);
    await page.evaluate(
      (t) => globalThis.document.documentElement.setAttribute('data-theme', t),
      theme,
    );
    const ready = {
      empty: () => page.getByText('No products yet').first().waitFor(),
      error: () => page.getByText('Products could not be loaded').first().waitFor(),
      loading: () => page.getByText('Loading products').first().waitFor({ state: 'attached' }),
    }[scenario];
    await (ready ? ready() : page.locator('tbody a').first().waitFor());
    if (scenario === 'sheet') {
      await page.getByRole('button', { name: 'Filter' }).click();
      await page.getByRole('dialog', { name: 'Filter products' }).waitFor();
    }
    await page.waitForTimeout(300);
    const m = await page.evaluate(measure);
    console.log(
      `${scenario} ${width} ${theme}: scrollWidth=${m.scroll} clientWidth=${m.client}`,
      `misaligned=[${m.misaligned}] clipped=[${m.clipped}]`,
    );
    await page.screenshot({
      path: join(out, `products-${scenario}-${width}-${theme}.png`),
      fullPage: scenario !== 'sheet',
    });
    await ctx.close();
  }
}
await browser.close();
server.close();
