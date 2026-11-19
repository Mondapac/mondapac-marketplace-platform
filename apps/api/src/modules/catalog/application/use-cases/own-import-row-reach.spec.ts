import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// No route reaches a row use case (catalog design 14c): the five `own-import.row-*` use cases are
// called by the import run only. No controller, facade, subscriber or other module refers to them,
// and the interactive draft save still spends its saves limit (it passes no options).

const MODULES = join(__dirname, '..', '..', '..');
const CATALOG = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the row use cases of the seller import', () => {
  it('are referred to by the run, the row use cases themselves and the module wiring only', () => {
    const referring = sources(MODULES)
      .filter((path) => /OwnImportRow|own-import-row-/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(MODULES, path))
      .sort();
    expect(referring).toEqual([
      'catalog/application/use-cases/own-import-row-create.use-case.ts',
      'catalog/application/use-cases/own-import-row-offer-create.use-case.ts',
      'catalog/application/use-cases/own-import-row-offer-edit.use-case.ts',
      'catalog/application/use-cases/own-import-row-save.use-case.ts',
      'catalog/application/use-cases/own-import-run.use-case.ts',
      'catalog/catalog.module.ts',
    ]);
  });

  it('are named by no controller, facade or subscriber', () => {
    for (const path of sources(join(CATALOG, 'presentation'))) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/OwnImportRow|own-import-row|ownRow/);
    }
  });

  it('leave the interactive draft save as it was: its limit is spent', () => {
    const text = readFileSync(
      join(CATALOG, 'application', 'use-cases', 'own-product-save-draft.use-case.ts'),
      'utf8',
    );
    expect(text).not.toMatch(/spendSavesLimit|refuseAll|executeAllOrNothing|NO_SAVE_BUDGET/);
  });
});
