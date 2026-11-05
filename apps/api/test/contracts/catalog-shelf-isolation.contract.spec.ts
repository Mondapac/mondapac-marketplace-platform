import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// A seller shelf is never a platform category (categories C9a; CAT-52, Hassan G1 on catalog's
// brief): it is never in navigation, filters, search facets, badge decisions or a product
// revision. Its only reads are the shelf store and the Offer repository's history snapshot. A new
// file of any module that reads the shelf column or the shelf tables fails here, so the review
// sees it.

const SRC = path.resolve(__dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** The shelf column of an Offer and the shelf tables, as Prisma and as SQL name them. */
const SHELF =
  /\bshelfCategoryId\b|\bshelf_category_id\b|\bcatalogSellerCategory\w*\b|\bseller_categor(y|ies)\w*\b/;

/** The only files that may read a shelf. */
const ALLOWED = new Set([
  'modules/catalog/infrastructure/prisma-seller-category.store.ts',
  'modules/catalog/infrastructure/prisma-offer.repository.ts',
]);

describe('seller shelves stay out of platform reads (CAT-52)', () => {
  const readers = sources(SRC)
    .filter((file) => SHELF.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'));

  it('finds the shelf store, so the scan is not vacuous', () => {
    expect(readers).toEqual(expect.arrayContaining([...ALLOWED]));
  });

  it('lets no search, filter, navigation, claim or revision file read a shelf', () => {
    expect(readers.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
