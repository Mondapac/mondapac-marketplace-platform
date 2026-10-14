import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertAttributeSeed } from './checked-in-attribute-seed';
import { assertCategorySeed } from './checked-in-category-seed';
import { CatalogSeedFileError, loadFileCatalogSeeds } from './file-catalog-seed';

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'catalog-seed-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

const valid = { market: 'AU', categories: [], attributes: { definitions: [], families: [] } };

describe('the per-Market catalog seed files', () => {
  it('loads the checked-in AU file and it satisfies the seed rules', () => {
    const seeds = loadFileCatalogSeeds();
    expect(() => assertCategorySeed(seeds.categories['AU']!)).not.toThrow();
    expect(() => assertAttributeSeed(seeds.attributes['AU']!)).not.toThrow();
    expect(seeds.categories['AU']!.length).toBeGreaterThan(0);
    // The variant option the demo products use is a select option.
    expect(
      seeds.attributes['AU']!.definitions.find((definition) => definition.isVariantOption)?.options
        .length,
    ).toBeGreaterThan(0);
  });

  it('is empty when the directory is missing', () => {
    expect(loadFileCatalogSeeds('/nonexistent/catalog-seed')).toEqual({
      categories: {},
      attributes: {},
    });
  });

  it('stops on a file that is not JSON, has an unknown key or is named for another Market', () => {
    expect(() => loadFileCatalogSeeds(directoryWith({ 'AU.json': '{ not json' }))).toThrow(
      CatalogSeedFileError,
    );
    expect(() =>
      loadFileCatalogSeeds(directoryWith({ 'AU.json': { ...valid, surprise: true } })),
    ).toThrow(CatalogSeedFileError);
    expect(() => loadFileCatalogSeeds(directoryWith({ 'NZ.json': valid }))).toThrow(
      CatalogSeedFileError,
    );
  });
});
