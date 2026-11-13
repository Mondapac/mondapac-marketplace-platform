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
const requireFrom = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_PATH
  ? requireFrom(process.env.PLAYWRIGHT_PATH)
  : requireFrom('playwright');
const browser = await chromium.launch();
// name, scenario, text to wait for, action, what to shoot: the Category and tags card, the open
// list in the viewport, a named card, or the full page
const views = [
  ['admin-tags-card', 'form', 'Sella basmati rice', null, 'card'],
  ['admin-tags-page', 'form', 'Sella basmati rice', null, 'page'],
  ['admin-tags-list-open', 'form', 'Sella basmati rice', 'open', 'viewport'],
  ['admin-tags-list-search', 'form', 'Sella basmati rice', 'search', 'viewport'],
  ['admin-tags-refused', 'error', 'Sella basmati rice', 'save', 'page'],
  ['admin-tags-readonly', 'readonly', 'Sella basmati rice', null, 'card'],
  ['admin-tags-review-card', 'review', 'Extra virgin olive oil', null, 'review'],
  ['admin-tags-products-column', 'column', 'Lamb cutlets 500 g', null, 'page'],
];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    for (const [name, scenario, waitFor, action, shoot] of views) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/?s=${scenario}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByText(waitFor, { exact: false }).first().waitFor();
      if (action === 'open' || action === 'search') {
        await page.getByRole('combobox', { name: /Tags/ }).click();
        await page.getByRole('option', { name: /Eid/ }).waitFor();
        if (action === 'search') {
          await page.getByRole('combobox', { name: 'Search tags' }).fill('ba');
          await page.getByRole('option', { name: /Barbecue/ }).waitFor();
          await page.waitForTimeout(400);
        }
      }
      if (action === 'save') {
        await page.getByLabel('Title').fill('Sella basmati rice 2');
        await page.getByRole('button', { name: 'Save draft' }).first().click();
        await page.getByText('is archived. Remove it.').first().waitFor();
      }
      await page.waitForTimeout(300);
      const over = await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      );
      console.log(name, width, scheme, 'horizontal overflow:', over);
      const file = join(out, `${name}-${width}-${scheme}.png`);
      if (shoot === 'card') {
        await page
          .getByRole('heading', { name: 'Category and tags' })
          .locator('xpath=ancestor::section[1]')
          .screenshot({ path: file });
      } else if (shoot === 'review') {
        await page
          .getByRole('heading', { name: 'Tags', exact: true })
          .locator('xpath=ancestor::section[1]')
          .screenshot({ path: file });
      } else if (shoot === 'viewport') {
        await page.screenshot({ path: file });
      } else {
        await page.screenshot({ path: file, fullPage: true });
      }
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
