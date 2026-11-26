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
const { chromium } = createRequire(process.env.PW_PATH ?? import.meta.url)('playwright');
const browser = await chromium.launch();

// Each view: a ready text, then named steps that act on the page before the screenshot.
// `clip` takes only the top of the page (the header row); `scroll` is whether the full page is taken.
const openDrawer = async (page, name) => {
  await page.getByRole('button', { name }).click();
  await page.getByRole('dialog', { name: 'Offer review' }).waitFor();
  await page.waitForTimeout(300);
};
// The decision bar sticks to the bottom of the drawer and no block of the diff is cut by it, even
// with the body scrolled to its end (the check Reza asked for in a real browser).
const checkBar = async (page, label) => {
  const result = await page.evaluate(() => {
    const dialog = [...globalThis.document.querySelectorAll('dialog[open]')].pop();
    const bar = dialog.querySelector('.sticky');
    const body = bar.closest('.overflow-y-auto');
    const panel = dialog.getBoundingClientRect();
    const first = bar.getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    const last = bar.getBoundingClientRect();
    const sections = [...dialog.querySelectorAll('section[aria-label]')].map((node) => ({
      name: node.getAttribute('aria-label'),
      bottom: node.getBoundingClientRect().bottom,
    }));
    const lowest = Math.max(0, ...sections.map((section) => section.bottom));
    body.scrollTop = 0;
    return {
      barBottomGap: Math.round(panel.bottom - last.bottom),
      barAtBottomBeforeScroll: Math.round(panel.bottom - first.bottom),
      lastSectionClearOfBar: lowest <= last.top + 0.5,
      scrollable: body.scrollHeight > body.clientHeight,
    };
  });
  console.log('  drawer check', label, JSON.stringify(result));
};
const filterBy = async (page, rows) => {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  let index = 0;
  for (const [field, value] of rows) {
    if (index > 0) await page.getByRole('button', { name: 'Add condition' }).click();
    await page.getByRole('combobox', { name: 'Field' }).nth(index).selectOption({ label: field });
    await page.getByRole('combobox', { name: 'Value' }).nth(index).selectOption({ label: value });
    index += 1;
  }
};
// A view of the list's views bar: a tab, a button, or (on a phone) a select of the views.
const clickView = async (page, name) => {
  for (const role of ['tab', 'button', 'radio']) {
    const target = page.getByRole(role, { name, exact: true });
    if ((await target.count()) > 0 && (await target.first().isVisible())) {
      await target.first().click();
      return;
    }
  }
  await page
    .getByRole('combobox', { name: 'Post-publication review views' })
    .selectOption({ label: name });
};
const views = {
  first: {
    ready: 'Medjool dates 500 g',
    steps: {
      list: async () => undefined,
      header: async () => undefined,
      drawer: async (page) => {
        await openDrawer(page, 'Review Lamb shoulder, halal');
        await checkBar(page, 'first drawer');
      },
      'drawer-send-back': async (page) => {
        await openDrawer(page, 'Review Lamb shoulder, halal');
        await page.getByRole('button', { name: 'Request changes' }).click();
        await page.waitForTimeout(200);
      },
      discard: async (page) => {
        await openDrawer(page, 'Review Lamb shoulder, halal');
        await page.getByRole('button', { name: 'Request changes' }).click();
        await page
          .getByRole('combobox', { name: /Reason for sending it back/ })
          .selectOption({ index: 1 });
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('dialog', { name: 'Discard what you typed?' }).waitFor();
      },
      filters: async (page) => {
        await filterBy(page, [
          ['Store', 'Date Palace'],
          ['Category', '– Meat'],
        ]);
        await page.waitForTimeout(300);
      },
      'bulk-ok': async (page) => {
        for (const name of ['Medjool dates 500 g', 'Tahini 450 g']) {
          await page.getByRole('checkbox', { name: `Select ${name}` }).click();
        }
        await page.getByRole('button', { name: 'Bulk action' }).click();
        await page.getByRole('menuitem', { name: 'Approve ticked…' }).click();
        await page.getByRole('dialog').waitFor();
      },
      'bulk-blocked': async (page) => {
        for (const name of ['Medjool dates 500 g', 'Rose water 250 ml']) {
          await page.getByRole('checkbox', { name: `Select ${name}` }).click();
        }
        await page.getByRole('button', { name: 'Bulk action' }).click();
        await page.getByRole('menuitem', { name: 'Approve ticked…' }).click();
        await page.getByRole('dialog', { name: 'These rows need a closer look' }).waitFor();
      },
    },
  },
  edits: {
    ready: 'Medjool dates 500 g',
    steps: {
      list: async () => undefined,
      drawer: async (page) => {
        await openDrawer(page, 'Review Medjool dates 500 g');
        await checkBar(page, 'edits drawer');
      },
      discard: async (page) => {
        await openDrawer(page, 'Review Medjool dates 500 g');
        await page
          .getByRole('textbox', { name: /Note to the seller/ })
          .fill('Please resend the halal certificate.');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('dialog', { name: 'Discard what you typed?' }).waitFor();
      },
      filters: async (page) => {
        await filterBy(page, [
          ['Store', 'Date Palace'],
          ['Category', '– Meat'],
        ]);
        await page.waitForTimeout(300);
      },
    },
  },
  seller: {
    ready: 'Trusted from start',
    steps: {
      card: async () => undefined,
      dialog: async (page) => {
        await page.getByRole('switch', { name: 'Trusted from start' }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('textbox', { name: /Reason/ }).fill('Long record of clean listings.');
      },
    },
  },
  categories: {
    ready: 'Food > Meat > Lamb',
    steps: {
      table: async () => undefined,
      dialog: async (page) => {
        await page.getByRole('switch', { name: 'Review stop for Food > Meat > Lamb' }).click();
        await page.getByRole('dialog').waitFor();
      },
    },
  },
  banner: { ready: 'Emergency stop is on', steps: { banner: async () => undefined } },
  // The post-publication review (slice 6): ONLY=after WIDTHS=1280,768,375 SCALE=1.
  after: {
    ready: 'Medjool dates 500 g',
    steps: {
      list: async () => undefined,
      'all-view': async (page) => {
        await clickView(page, 'All');
        await page.getByText('Sumac 100 g', { exact: true }).first().waitFor();
      },
      drawer: async (page) => {
        await openDrawer(page, 'Review Lamb shoulder, halal');
      },
      'drawer-taken-down': async (page) => {
        await clickView(page, 'All');
        await openDrawer(page, 'Review Sumac 100 g');
        await page.getByText('Claims halal on the label without a certificate.').waitFor();
      },
      'take-down': async (page) => {
        await openDrawer(page, 'Review Medjool dates 500 g');
        await page.getByRole('button', { name: 'Take down…' }).click();
        const dialog = page.getByRole('dialog', { name: 'Take this offer down?' });
        await dialog.waitFor();
        await dialog.getByRole('combobox').selectOption('description-claim');
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('textbox').fill('Claims halal on the label without a certificate.');
      },
      filters: async (page) => {
        await filterBy(page, [['Reason', 'Price: no comparison yet']]);
        await page.waitForTimeout(300);
      },
      'bulk-results': async (page) => {
        for (const name of ['Medjool dates 500 g', 'Lamb shoulder, halal', 'Tahini 450 g']) {
          await page.getByRole('checkbox', { name: `Select ${name}` }).click();
        }
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Approve ticked…' }).click();
        const dialog = page.getByRole('dialog', { name: 'Approve 3 offers?' });
        await dialog.getByRole('button', { name: 'Approve 3 offers' }).click();
        await page.getByText('Skipped rows').first().waitFor();
      },
    },
  },
};
// The other states of the After publication tab, each a view of its own (`ONLY=after` takes them all).
views['after-empty'] = {
  url: '?view=after&state=empty',
  ready: 'Nothing to check after publication.',
  steps: { list: async () => undefined },
};
views['after-error'] = {
  url: '?view=after&state=error',
  ready: 'The offers could not be loaded. Check your connection and try again.',
  steps: { list: async () => undefined },
};
views['after-loading'] = {
  url: '?view=after&state=loading',
  ready: 'Offer reviews',
  steps: { list: async (page) => page.waitForTimeout(1500) },
};
views['after-many'] = {
  url: '?view=after&state=many',
  ready: 'Medjool dates 500 g',
  steps: {
    selection: async (page) => {
      for (const name of ['Medjool dates 500 g', 'Tahini 450 g']) {
        await page.getByRole('checkbox', { name: `Select ${name}` }).click();
      }
    },
    'select-all': async (page) => {
      await page
        .getByRole('checkbox', { name: /Select all .*on this page/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Select all 60 matching' }).click();
      await page.getByText('All 60 matching offers are selected').first().waitFor();
    },
  },
};
const widths = (process.env.WIDTHS ?? '1280,375').split(',').map(Number);
const scale = Number(process.env.SCALE ?? '2');
for (const [view, { ready, steps, url }] of Object.entries(views)) {
  if (process.env.ONLY && process.env.ONLY !== view && !view.startsWith(`${process.env.ONLY}-`)) {
    continue;
  }
  for (const scheme of ['light', 'dark']) {
    for (const width of widths) {
      for (const [step, act] of Object.entries(steps)) {
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
          deviceScaleFactor: scale,
        });
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/${url ?? `?view=${view}`}`);
        await page.evaluate(
          (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
          scheme,
        );
        await page.getByText(ready, { exact: true }).first().waitFor();
        await act(page);
        await page.waitForTimeout(300);
        const over = await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
        );
        console.log(view, step, width, scheme, 'horizontal overflow:', over);
        await page.screenshot({
          path: join(out, `${view}-${step}-${width}-${scheme}.png`),
          ...(step === 'header'
            ? { clip: { x: 0, y: 0, width, height: 160 } }
            : {
                fullPage: [
                  'list',
                  'card',
                  'table',
                  'filters',
                  'banner',
                  'all-view',
                  'selection',
                  'select-all',
                ].includes(step),
              }),
        });
        await ctx.close();
      }
    }
  }
}
await browser.close();
server.close();
