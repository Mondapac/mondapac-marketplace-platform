import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ESLint } from 'eslint';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const FIXTURES = path.join(__dirname, 'boundary-fixtures');

interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}

/** Runs the real dependency-cruiser configuration against the fixture tree. */
function cruiseFixtures(): Violation[] {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [
        path.join(API_ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        'src',
        '--config',
        path.join(API_ROOT, '.dependency-cruiser.cjs'),
        '--output-type',
        'json',
      ],
      { cwd: FIXTURES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    // dependency-cruiser exits non-zero when it finds violations; the report is on stdout.
    output = (error as { stdout: string }).stdout;
  }
  return (JSON.parse(output) as { summary: { violations: Violation[] } }).summary.violations;
}

describe('architecture boundaries (ADR-0008 decision 6)', () => {
  describe('dependency-cruiser', () => {
    let found: string[];

    beforeAll(() => {
      found = cruiseFixtures()
        .map((violation) => `${violation.rule.name}: ${violation.from}`)
        .sort();
    });

    it('reports every deliberate violation in the fixtures, and nothing else', () => {
      expect(found).toEqual([
        'application-does-not-know-delivery: src/modules/alpha/application/knows-delivery.ts',
        'core-does-not-import-verticals: src/platform/uses-vertical.ts',
        'domain-is-pure: src/modules/alpha/domain/does-io.ts',
        'domain-is-pure: src/modules/alpha/domain/imports-application.ts',
        'module-internals-are-private: src/platform/reaches-into-module.ts',
        'module-public-api-only: src/modules/alpha/application/reaches-into-module.ts',
        'prisma-only-in-infrastructure: src/modules/alpha/presentation/uses-prisma.ts',
      ]);
    });
  });

  describe('ESLint', () => {
    async function lintFixture(file: string): Promise<string[]> {
      const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
      const [result] = await eslint.lintFiles([path.join(FIXTURES, file)]);
      return (result?.messages ?? []).map((message) => `${message.ruleId}: ${message.message}`);
    }

    it('rejects wall-clock time in domain code', async () => {
      const messages = await lintFixture('src/modules/alpha/domain/wall-clock.ts');

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatch(/no-restricted-syntax: No raw Date in domain code/);
      expect(messages[1]).toMatch(/no-restricted-syntax: No Date.now\(\) in domain code/);
    });

    it('rejects hardcoded market identifiers in a module', async () => {
      const messages = await lintFixture('src/modules/alpha/application/hardcoded-market.ts');

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => /Market or vertical identifier/.test(message))).toBe(true);
    });

    it('rejects hardcoded vertical identifiers in platform code, including template strings', async () => {
      const messages = await lintFixture('src/platform/hardcoded-vertical.ts');

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => /Market or vertical identifier/.test(message))).toBe(true);
    });

    it('accepts market-neutral code, including words that merely contain a market code', async () => {
      await expect(lintFixture('src/modules/alpha/application/clean.ts')).resolves.toEqual([]);
    });
  });
});
