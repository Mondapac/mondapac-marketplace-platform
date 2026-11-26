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
// name, scenario, widths, what to open
const views = [
  ['ai-models-scorecard', 'scorecard', [1280, 768, 375], 'evaluation'],
  ['ai-models-scorecard-empty', 'empty', [1280], 'evaluation'],
  ['ai-models-scorecard-failed', 'failed', [1280, 375], 'evaluation'],
  ['ai-models-preview-cost', 'scorecard', [1280, 375], 'preview'],
  ['ai-models-preview-cost-failed', 'failed', [1280], 'preview'],
];
for (const scheme of ['light', 'dark']) {
  for (const [name, scenario, widths, action] of views) {
    for (const width of widths) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/?s=${scenario}`);
      await page.evaluate(
        (s) => globalThis.document.documentElement.setAttribute('data-theme', s),
        scheme,
      );
      await page.getByRole('heading', { name: 'AI Models' }).waitFor();
      if (action === 'evaluation') {
        await page.getByRole('tab', { name: 'Evaluation' }).click();
        await page.getByText('Scorecard', { exact: true }).first().waitFor();
      } else {
        // Sonnet first for Chat, Write emptied: two first models change.
        await page.getByRole('button', { name: 'Move claude-sonnet-5-5 up' }).first().click();
        await page.getByRole('button', { name: 'Remove claude-haiku-5-5' }).nth(1).click();
        await page.getByRole('button', { name: 'Review changes' }).click();
        await page.getByText('Estimated monthly cost').waitFor();
      }
      await page.waitForTimeout(400);
      const full = action === 'evaluation';
      await page.screenshot({ path: join(out, `${name}-${width}-${scheme}.png`), fullPage: full });
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
