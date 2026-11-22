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
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});

async function fill(page) {
  await page.getByLabel('Code (required)').fill('organic');
  await page.getByLabel(/Certificate from an issuer/).check();
  await page.getByLabel('Name (required)').fill('Organic');
  await page
    .getByLabel('Description for customers (required)')
    .fill(
      'The seller holds an organic certificate from a certifying body that the platform has reviewed.',
    );
  await page.getByLabel(/Claim terms/).fill('organic\ncertified organic');
  await page.getByLabel(/^Reason/).fill('Customers keep asking for organic products.');
}

const shots = [
  { name: 'n1-list', view: 'list' },
  { name: 'n2-new', view: 'new', before: fill },
  {
    name: 'n2-new-errors',
    view: 'new',
    before: async (page) => {
      await page.getByRole('button', { name: 'Review' }).click();
    },
  },
  {
    name: 'n3-review',
    view: 'new',
    before: async (page) => {
      await fill(page);
      await page.getByRole('button', { name: 'Review' }).click();
      await page.getByText(/37 published texts/).waitFor();
    },
    viewportOnly: true,
  },
  { name: 'n4-proposed-own', view: 'proposed' },
  { name: 'n4-proposed-other', view: 'proposed-other' },
];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const shot of shots) {
      const ctx = await browser.newContext({
        viewport: { width, height: shot.viewportOnly ? 900 : 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.route('**/api/catalog/admin/claim-terms/impact-count', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ products: 30, offers: 7, total: 37, complete: true }),
        }),
      );
      await page.goto(`http://localhost:${port}/?view=${shot.view}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.waitForSelector('main h1');
      if (shot.before) await shot.before(page);
      else if (shot.view.startsWith('proposed'))
        await page.getByText(/37 published texts/).waitFor();
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(shot.name, width, scheme, 'horizontal overflow:', over);
      await page.screenshot({
        path: join(out, `${shot.name}-${width}-${scheme}.png`),
        fullPage: !shot.viewportOnly,
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
