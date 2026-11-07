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
// Each scene: [file name, query, what to do after the page is ready].
const scenes = [
  ['card-empty', '?scene=empty', async () => undefined],
  ['card-list', '?scene=list', async () => undefined],
  [
    'dialog-add',
    '?scene=list',
    async (page) => {
      await page.getByRole('button', { name: 'Add certificate' }).first().click();
      await page.getByLabel('Certification type').waitFor();
      await page.getByLabel('Certification type').selectOption({ label: 'Halal' });
      await page.getByLabel('Issuer').selectOption({ label: 'Halal Australia' });
      await page.getByLabel('Manufacturer · required').fill('Tilda Ltd');
      await page.getByLabel('Certificate number · required').fill('HA-2025-11873');
      await page.getByLabel('Expires · required').fill('2027-06-30');
    },
  ],
  [
    'dialog-variants',
    '?scene=list',
    async (page) => {
      await page.getByRole('button', { name: 'Add certificate' }).first().click();
      await page.getByLabel('Certification type').waitFor();
      await page.getByLabel('Certification type').selectOption({ label: 'Halal' });
      await page.getByLabel('Covers').selectOption({ label: 'Some variants' });
      await page.getByLabel('White · 5 kg').check();
    },
  ],
  [
    'drawer-details',
    '?scene=list',
    async (page) => {
      await page.getByRole('button', { name: 'Actions for Gluten free certificate' }).click();
      await page.getByRole('menuitem', { name: 'View details' }).click();
      await page.getByText('Number recorded').waitFor();
    },
  ],
];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const [name, query, act] of scenes) {
      const ctx = await browser.newContext({
        viewport: { width, height: name.startsWith('card') ? 900 : 812 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/${query}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      const card = page.getByRole('heading', { name: 'Product certifications' });
      await card.waitFor();
      if (name === 'card-list') await page.getByRole('table').waitFor();
      else if (name === 'card-empty') await page.getByText('No product certificates yet').waitFor();
      await act(page);
      await page.waitForTimeout(400);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      const file = join(out, `${name}-${width}-${scheme}.png`);
      if (name.startsWith('card')) {
        await card.locator('xpath=ancestor::section[1]').screenshot({ path: file });
      } else {
        await page.screenshot({ path: file });
      }
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
