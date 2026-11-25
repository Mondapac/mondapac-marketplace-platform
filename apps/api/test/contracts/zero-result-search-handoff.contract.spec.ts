import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Zero-result searches (dashboards v2, phase 2): search's noted texts reach engagement only
// through reporting's `FacadeSearchSources`, and only the storefront route asks search to note a
// text (never the buyer assistant's facade, whose texts a model chooses). These checks read the
// sources, so a new caller fails here and the review sees it.

const SRC = path.resolve(__dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Files whose text matches `pattern`, relative to `src`. */
function filesMatching(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();
}

const ADAPTER = 'modules/reporting/infrastructure/facade-search-sources.ts';

describe('the zero-result search hand-off has one caller', () => {
  it('calls engagement.searchShoppers only from the reporting adapter', () => {
    expect(filesMatching(/\.searchShoppers\s*\(/)).toEqual([ADAPTER]);
  });

  it('calls search.zeroResultTexts only from the reporting adapter', () => {
    expect(filesMatching(/\.zeroResultTexts\s*\(/)).toEqual([ADAPTER]);
  });

  it('asks search to note a zero-result text only from the storefront route', () => {
    expect(filesMatching(/noteZeroResult:\s*true/)).toEqual([
      'modules/search/presentation/search.controller.ts',
    ]);
  });
});
