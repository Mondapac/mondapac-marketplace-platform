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
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();

const card = (page, title) =>
  page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) }).last();
const holds = (page) => card(page, 'Payout holds');
const ledger = (page) => card(page, 'Ledger');
const FIRST_HOLD = /^Actions for hold/;
const FIRST_ROW = /^Actions for ledger row/;
const typed = async (page, name, text) => {
  const dialog = page.getByRole('dialog', { name });
  await dialog.getByLabel(/^Type the (seller|hold) ID/).fill(text);
};

// Each shot: the page hash to open, and what to do on the loaded lists before the screenshot.
const steps = {
  list: { run: async () => {} },
  'ledger-filter': {
    run: async (page) => {
      await ledger(page)
        .getByRole('button', { name: /^Filter/ })
        .click();
      await page.getByRole('dialog').waitFor();
    },
  },
  'holds-filter': {
    run: async (page) => {
      await holds(page)
        .getByRole('button', { name: /^Filter/ })
        .click();
      await page.getByRole('dialog').waitFor();
    },
  },
  'ledger-actions': {
    run: async (page) => {
      await ledger(page).getByRole('button', { name: FIRST_ROW }).first().click();
      await page.getByRole('menu').waitFor();
    },
  },
  'holds-actions': {
    run: async (page) => {
      await holds(page).getByRole('button', { name: FIRST_HOLD }).first().click();
      await page.getByRole('menu').waitFor();
    },
  },
  'place-empty': {
    run: async (page) => {
      await holds(page).getByRole('button', { name: 'Place hold…' }).click();
      await page.getByRole('dialog', { name: 'Place a payout hold?' }).waitFor();
    },
  },
  'place-typed': {
    run: async (page) => {
      await steps['place-empty'].run(page);
      const dialog = page.getByRole('dialog', { name: 'Place a payout hold?' });
      await dialog.getByLabel('Reason').selectOption('bank-change');
      await typed(page, 'Place a payout hold?', '000000C1');
    },
  },
  'release-empty': {
    run: async (page) => {
      await steps['holds-actions'].run(page);
      await page.getByRole('menuitem', { name: 'Release hold…' }).click();
      await page.getByRole('dialog', { name: 'Release this payout hold?' }).waitFor();
    },
  },
  'release-typed': {
    run: async (page) => {
      await steps['release-empty'].run(page);
      const dialog = page.getByRole('dialog', { name: 'Release this payout hold?' });
      await dialog.getByLabel('Reason for releasing').selectOption('review-complete');
      await typed(page, 'Release this payout hold?', '00006000');
    },
  },
  empty: { hash: '#empty', run: async () => {}, table: false },
  'no-match': {
    hash: '#nomatch',
    table: false,
    // A filter on each list that matches nothing in the stub.
    run: async (page) => {
      const apply = async (area, field, value) => {
        await area.getByRole('button', { name: /^Filter/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Filter' });
        await dialog.getByLabel('Field').selectOption(field);
        await dialog.getByLabel('Value').selectOption(value);
        await dialog.getByRole('button', { name: 'Apply' }).click();
        await page.waitForTimeout(300);
      };
      await apply(holds(page), 'status', 'released');
      await apply(ledger(page), 'kind', 'sale');
    },
  },
};

const everywhere = ['list', 'ledger-filter', 'holds-actions'];
for (const scheme of ['light', 'dark']) {
  for (const width of [1280, 768, 375]) {
    const names = width === 1280 ? Object.keys(steps) : everywhere;
    for (const name of names) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/${steps[name].hash ?? ''}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      if (steps[name].table === false)
        await page.getByRole('heading', { name: 'Ledger', exact: true }).waitFor();
      else await page.getByRole('table').first().waitFor();
      await page.waitForTimeout(300);
      await steps[name].run(page);
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => {
        const doc = globalThis.document.documentElement;
        return {
          page: doc.scrollWidth > globalThis.innerWidth,
          // A table that scrolls sideways inside its card.
          tables: [...globalThis.document.querySelectorAll('table')].filter((t) => {
            const box = t.parentElement;
            return box !== null && box.scrollWidth > box.clientWidth + 1;
          }).length,
        };
      });
      console.log(name, width, scheme, 'horizontal overflow:', JSON.stringify(over));
      await page.screenshot({
        path: join(out, `${name}-${width}-${scheme}.png`),
        fullPage: name === 'list' || name === 'empty' || name === 'no-match',
      });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
