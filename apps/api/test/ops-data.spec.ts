import { spawnSync } from 'node:child_process';
import path from 'node:path';

// scripts/ops-data (the operational test data loader, phase 2): the guards that keep it off any
// production system, and the invariants of the AU scenario's catalog structure. The strict local
// guard itself is covered by demo-seed.spec.ts (the demo seed uses the same function).

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

describe('the ops-data Stripe key guard', () => {
  // The key goes in through the environment, as the loader reads it, so the output can show
  // that the guard never prints it.
  const check = (key: string | undefined) =>
    run(
      `import { assertStripeTestKey } from './scripts/ops-data/guard.mjs';
       assertStripeTestKey(process.env.STRIPE_SECRET_KEY);
       console.log('allowed');`,
      { STRIPE_SECRET_KEY: key },
    );

  it('allows no key, a secret test key and a restricted test key', () => {
    expect(check(undefined).out).toContain('allowed');
    expect(check('').out).toContain('allowed');
    expect(check('sk_test_51abcdefgh').out).toContain('allowed');
    expect(check('rk_test_51abcdefgh').out).toContain('allowed');
  });

  it('refuses a live key or anything else, without printing it', () => {
    for (const key of [
      'sk_live_51abcdefgh',
      'rk_live_51abcdefgh',
      'pk_test_51abcdefgh',
      'not-a-stripe-key-123',
    ]) {
      const answer = check(key);
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('not a Stripe test-mode key');
      expect(answer.out).not.toContain(key);
    }
  });
});

describe('the ops-data database marker guard', () => {
  /** The guard against a stand-in client whose database-level settings are `setconfig`. */
  const check = (setconfig: string[] | null) =>
    run(
      `import { assertDatabaseMarker } from './scripts/ops-data/guard.mjs';
       const db = { query: async (sql) => {
         if (!sql.includes('pg_db_role_setting') || !sql.includes('setrole = 0')) throw new Error('unexpected query');
         return { rows: ${JSON.stringify(setconfig)} === null ? [] : [{ setconfig: ${JSON.stringify(setconfig)} }] };
       } };
       await assertDatabaseMarker(db);
       console.log('allowed');`,
    );

  it('allows a database whose own settings carry mondapac.env = ops-test', () => {
    expect(check(['mondapac.env=ops-test']).out).toContain('allowed');
    expect(check(['search_path=catalog', 'mondapac.env=ops-test']).out).toContain('allowed');
  });

  it('refuses a database without the marker or with another value', () => {
    for (const setconfig of [
      null,
      [],
      ['search_path=catalog'],
      ['mondapac.env=production'],
      ['mondapac.env=ops-test-x'],
    ]) {
      const answer = check(setconfig);
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('no operational test marker');
    }
  });
});

describe('the ops-data AU scenario', () => {
  it('names each category once, parents first, and links only known categories, sets and attributes', () => {
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const { categories, attributes, featureSets, links, cultures } = SCENARIO.catalog;
      const problems = [];
      const seen = new Set();
      for (const c of categories) {
        if (seen.has(c.slug)) problems.push('slug repeated ' + c.slug);
        if (c.parent !== null && !seen.has(c.parent)) problems.push('parent after child ' + c.slug);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) problems.push('bad slug ' + c.slug);
        seen.add(c.slug);
      }
      const codes = new Set(attributes.map((a) => a.code));
      if (codes.size !== attributes.length) problems.push('attribute code repeated');
      for (const set of featureSets) {
        const first = set.groups[0];
        if (first.groupCode !== 'core') problems.push(set.code + ': the first group is not core');
        for (const g of set.groups) for (const [code, level] of g.attributes) {
          if (!codes.has(code)) problems.push(set.code + ': unknown attribute ' + code);
          if (!['required', 'recommended', 'optional'].includes(level)) problems.push(set.code + ': bad level ' + level);
        }
      }
      const sets = new Set(featureSets.map((s) => s.code));
      for (const l of links) {
        const c = categories.find((x) => x.slug === l.category);
        if (!c || c.parent !== null) problems.push('link is not on a department ' + l.category);
        if (!sets.has(l.featureSet)) problems.push('unknown feature set ' + l.featureSet);
        for (const f of l.filters) {
          const a = attributes.find((x) => x.code === f);
          if (!a || !a.filter) problems.push(l.category + ': filter is not a filterable attribute ' + f);
        }
      }
      const departments = categories.filter((c) => c.parent === null).map((c) => c.slug);
      for (const d of departments) if (!links.some((l) => l.category === d)) problems.push('department without a feature set ' + d);
      if (cultures.filter((c) => c.isDefault).length !== 1) problems.push('not exactly one default culture');
      const words = /halal|kosher|vegan|organic|certified|authentic|official|verified/i;
      const texts = [...categories.map((c) => c.name), ...attributes.map((a) => a.name), ...cultures.map((c) => c.name + ' ' + c.description)];
      for (const t of texts) if (words.test(t)) problems.push('claim word in ' + t);
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });
});
