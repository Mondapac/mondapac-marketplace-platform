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

/**
 * The shelf column of an Offer and the shelf tables, as Prisma and as SQL name them, and the port,
 * views and relations a reader would reach them through (Hassan L5 on #842).
 */
const SHELF = new RegExp(
  [
    String.raw`\bshelfCategoryId\b`,
    String.raw`\bshelf_category_id\b`,
    String.raw`\bcatalogSellerCategory\w*\b`,
    String.raw`\bseller_categor(y|ies)\w*\b`,
    String.raw`\bcatalogCategoryProposal\w*\b`,
    String.raw`\bcreatedSellerCategory\w*\b`,
    String.raw`\bSellerCategoryStore\b`,
    String.raw`\bSELLER_CATEGORY_STORE\b`,
    String.raw`\bShelfView\b`,
  ].join('|'),
);

/** The only files that may read a shelf: the store, the Offer history snapshot, C9a's own files. */
const ALLOWED = new Set([
  'modules/catalog/infrastructure/prisma-seller-category.store.ts',
  'modules/catalog/infrastructure/prisma-offer.repository.ts',
  'modules/catalog/application/ports/seller-category.store.ts',
  'modules/catalog/application/seller-categories/seller-category-shared.ts',
  'modules/catalog/application/use-cases/category-proposal-list.use-case.ts',
  'modules/catalog/application/use-cases/own-category-proposals-list.use-case.ts',
  'modules/catalog/application/use-cases/own-offer-set-shelf.use-case.ts',
  'modules/catalog/application/use-cases/seller-category-admin-list.use-case.ts',
  'modules/catalog/application/use-cases/seller-category-promote.use-case.ts',
  'modules/catalog/domain/seller-category.ts',
  'modules/catalog/domain/claim-checked-fields.ts',
  'modules/catalog/catalog.module.ts',
  'modules/catalog/infrastructure/catalog-providers.ts',
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
