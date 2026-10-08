import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMarketConfigs } from '../src/platform/market-config/market-config';
import { testMarketId } from './support/test-config';

// scripts/dev-panels-market.mjs (local panel development, scripts/dev-local.bat): the Market
// file it writes must pass the start-up validation, the per-population `allowedOrigins`
// included (identity design 6.4). Only AU has a checked-in file under config/markets/.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AU = testMarketId('AU');

function generate(env: Record<string, string> = {}): string {
  const out = mkdtempSync(path.join(tmpdir(), 'dev-markets-'));
  execFileSync(process.execPath, ['scripts/dev-panels-market.mjs', 'AU'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, DEV_MARKETS_OUT_DIR: out },
    stdio: 'pipe',
  });
  return out;
}

describe('scripts/dev-panels-market.mjs', () => {
  it('writes an AU file that loads, with each panel origin on its own list', () => {
    const market = loadMarketConfigs([generate()], [AU]).get(AU)!;

    expect(market.allowedOrigins).toEqual({
      admin: ['http://admin.localhost:3002'],
      seller: ['http://seller.localhost:3001'],
      customer: [],
    });
    expect(market.identity.links.targets.seller?.['sign-in']).toMatch(
      /^http:\/\/seller\.localhost:3001\//,
    );
    expect(market.identity.links.targets.admin?.['seller-review-queue']).toMatch(
      /^http:\/\/admin\.localhost:3002\//,
    );
  });

  it('falls back to an empty customer list when the source has no valid one (the old flat shape)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dev-markets-src-'));
    const source = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'config/markets/AU.json'), 'utf8'),
    ) as Record<string, unknown>;
    mkdirSync(path.join(root, 'config/markets'), { recursive: true });
    writeFileSync(
      path.join(root, 'config/markets/AU.json'),
      JSON.stringify({ ...source, allowedOrigins: ['https://old.example'] }),
    );
    const out = mkdtempSync(path.join(tmpdir(), 'dev-markets-'));
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/dev-panels-market.mjs'), 'AU'], {
      cwd: root,
      env: { ...process.env, DEV_MARKETS_OUT_DIR: out },
      stdio: 'pipe',
    });

    expect(loadMarketConfigs([out], [AU]).get(AU)!.allowedOrigins.customer).toEqual([]);
  });

  it('accepts other loopback panel origins', () => {
    const out = generate({
      SELLER_PANEL_ORIGIN: 'http://127.0.0.1:4001',
      ADMIN_PANEL_ORIGIN: 'http://admin.localhost:4002',
    });

    expect(loadMarketConfigs([out], [AU]).get(AU)!.allowedOrigins).toMatchObject({
      admin: ['http://admin.localhost:4002'],
      seller: ['http://127.0.0.1:4001'],
    });
  });
});
