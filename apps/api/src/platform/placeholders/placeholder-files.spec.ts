import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ADR-0031 decision 4, the unit rule: every class under an `infrastructure/placeholders/` folder
 * carries `@FailClosedPlaceholder('<port>')`, so the start-up derivation can never miss one.
 */
const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

export function undecoratedPlaceholderClasses(files: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const classes = text.matchAll(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm);
    for (const match of classes) {
      const before = text.slice(0, match.index);
      const decorators = before.slice(before.lastIndexOf('\n\n') + 1);
      if (!/@FailClosedPlaceholder\(\s*'[^']+'\s*\)/.test(decorators)) {
        problems.push(`${relative(SRC, file)}: ${match[1]}`);
      }
    }
  }
  return problems;
}

describe('ADR-0031 decision 4: classes under infrastructure/placeholders/', () => {
  const files = sourceFiles(SRC).filter((f) =>
    f.split(/[\\/]/).join('/').includes('/infrastructure/placeholders/'),
  );

  it('all carry @FailClosedPlaceholder', () => {
    expect(undecoratedPlaceholderClasses(files)).toEqual([]);
  });

  it('the rule finds an undecorated class', () => {
    const fixture = join(__dirname, '__fixtures__', 'undecorated-placeholder.txt');
    expect(undecoratedPlaceholderClasses([fixture])).toEqual([
      expect.stringContaining('UndecoratedReader'),
    ]);
  });
});
