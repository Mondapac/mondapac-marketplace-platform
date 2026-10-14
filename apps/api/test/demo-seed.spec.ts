import { spawnSync } from 'node:child_process';
import path from 'node:path';

// scripts/demo-seed (the local demo's sample marketplace): the production guard, which must
// refuse everything but a local development setup, and the sample data's own invariants.

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Runs a module snippet in the repository root; answers its exit status and output. */
function run(code: string, env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const guard = (urls: Record<string, string>, env: Record<string, string | undefined> = {}) =>
  run(
    `import { assertLocalDevelopment } from './scripts/demo-seed/guard.mjs';
     assertLocalDevelopment({ urls: ${JSON.stringify(urls)} });
     console.log('allowed');`,
    env,
  );

const LOCAL = {
  API: 'http://localhost:3000',
  MAIL: 'http://localhost:8025',
  DB: 'postgresql://mondapac_migrator:x@localhost:5432/mondapac',
};

describe('the demo seed production guard', () => {
  it('allows a local setup with no NODE_ENV, development or test', () => {
    expect(guard(LOCAL).out).toContain('allowed');
    expect(guard(LOCAL, { NODE_ENV: 'development' }).out).toContain('allowed');
    expect(guard(LOCAL, { NODE_ENV: 'test' }).out).toContain('allowed');
    expect(
      guard({ ...LOCAL, API: 'http://admin.localhost:3002', MAIL: 'http://127.0.0.1:8025' }).out,
    ).toContain('allowed');
  });

  it('refuses NODE_ENV=production and any other environment name', () => {
    for (const NODE_ENV of ['production', 'staging', 'Production']) {
      const answer = guard(LOCAL, { NODE_ENV });
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('refuses to run');
    }
  });

  it('refuses a database, API or mail catcher that is not on this machine', () => {
    for (const name of ['API', 'MAIL', 'DB'] as const) {
      const answer = guard({
        ...LOCAL,
        [name]: 'https://demo.example.com/x',
      });
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('not at this machine');
    }
    // A host that merely starts with "localhost" is not local.
    expect(guard({ ...LOCAL, API: 'http://localhost.evil.example:3000' }).status).not.toBe(0);
    expect(guard({ ...LOCAL, DB: 'not a url' }).status).not.toBe(0);
  });
});

describe('the demo seed sample data', () => {
  it('uses valid ABNs, one per seller, and prices and stock for every variant', () => {
    const answer = run(`
      import { SELLERS, OFFERS, PRODUCTS } from './scripts/demo-seed/data.mjs';
      const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
      const valid = (abn) => {
        const d = abn.split('').map(Number); d[0] -= 1;
        return abn.length === 11 && d.reduce((s, x, i) => s + x * weights[i], 0) % 89 === 0;
      };
      const problems = [];
      if (new Set(SELLERS.map((s) => s.abn)).size !== SELLERS.length) problems.push('abn repeated');
      for (const s of SELLERS) if (!valid(s.abn)) problems.push('bad abn ' + s.key);
      for (const [seller, offers] of Object.entries(OFFERS)) {
        const skus = new Set();
        for (const o of offers) {
          const p = PRODUCTS.find((x) => x.key === o.product);
          const n = p?.variants?.length ?? 1;
          if (!p || o.prices.length !== n || o.stock.length !== n) problems.push(seller + ' ' + o.sku);
          if (skus.has(o.sku)) problems.push('sku repeated ' + o.sku);
          skus.add(o.sku);
        }
      }
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });
});
