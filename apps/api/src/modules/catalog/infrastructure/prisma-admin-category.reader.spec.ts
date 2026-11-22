import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { INITIAL_TREE_VERSION, PrismaAdminCategoryReader } from './prisma-admin-category.reader';

// The tree version the admin category page names. On a Market whose tree nothing has written yet
// (a fresh database with the catalog seed switched off), the first create checks the page's
// version against the row it creates at 1, so the page must name 1: with 0 the first create of
// an empty Market was always refused as stale.

function readerWith(row: { version: number } | null): PrismaAdminCategoryReader {
  const prisma = {
    tx: () => ({ catalogCategoryTree: { findFirst: () => Promise.resolve(row) } }),
  } as unknown as PrismaService;
  return new PrismaAdminCategoryReader(prisma);
}

const market = { marketId: 'AU', tenantId: 'mondapac' } as unknown as MarketContext;

describe('PrismaAdminCategoryReader.treeVersion', () => {
  it('names the version the first write creates when the Market has no tree row yet', async () => {
    expect(INITIAL_TREE_VERSION).toBe(1);
    await expect(readerWith(null).treeVersion(market)).resolves.toBe(INITIAL_TREE_VERSION);
  });

  it('names the stored version otherwise', async () => {
    await expect(readerWith({ version: 7 }).treeVersion(market)).resolves.toBe(7);
  });
});
