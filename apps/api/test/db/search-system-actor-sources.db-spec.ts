import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import { CategoryTreeQuery } from '../../src/modules/catalog/application/use-cases/category-tree.use-case';
import { CategoryTreeSystemQuery } from '../../src/modules/catalog/application/use-cases/category-tree-system.use-case';
import { PublishedStoreSlugs } from '../../src/modules/sellers/application/use-cases/published-store-slugs.use-case';
import { PublishedStoreSlugsSystem } from '../../src/modules/sellers/application/use-cases/published-store-slugs-system.use-case';
import {
  CATEGORY_TREE_SOURCE,
  type CategoryTreeSource,
} from '../../src/modules/search/application/ports/category-tree';
import {
  CATEGORY_SUBTREE_SOURCE,
  type CategorySubtreeSource,
} from '../../src/modules/search/application/ports/category-subtree';
import {
  STORE_DIRECTORY,
  type StoreDirectory,
} from '../../src/modules/search/application/ports/store-directory';
import { SyncOfferDocuments } from '../../src/modules/search/application/use-cases/sync-offer-documents.use-case';
import { createTestApp, type LogLine } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The real gate behind search's sources (fix of the empty buyer index, 22 Nov 2026). Search's
// event handlers and its rebuild run as the system actor; the gate never lets the system actor
// pass an `anonymous` rule (identity design 6.2 row 1), so catalog's category tree and sellers'
// store slugs each have a `system` twin behind the same facade method. The unit and e2e suites
// wire fakes for these ports, so only the real application shows whether the wiring passes the
// gate. Nothing here is faked: the real AppModule, the real gate, the real use cases and Postgres.

const id = <K extends string>(): Id<K> => {
  const parsed = parseId<K>(uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))));
  if (!parsed.ok) throw new Error('test setup: bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)(
  'search sources under the real gate in market %s (database)',
  (code) => {
    const market = marketOf(code);
    let app: NestExpressApplication;
    let logLines: LogLine[];

    beforeAll(async () => {
      ({ app, logLines } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    });
    afterAll(async () => {
      await app.close();
    });

    const system = (): CallContext =>
      testCallContext(market, 'system', `db-search-system-${randomUUID()}`);
    const anonymous = (): CallContext =>
      testCallContext(market, 'anonymous', `db-search-anonymous-${randomUUID()}`);
    const denialsOf = (context: CallContext) =>
      logLines.filter(
        (line) => line.msg === 'access.denied' && line.correlationId === context.correlationId,
      );

    it('the anonymous halves still refuse the system actor (why the twins exist)', async () => {
      const context = system();

      expect(await app.get(CategoryTreeQuery).execute(context, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await app.get(PublishedStoreSlugs).execute(context, { sellerIds: [id<'Seller'>()] }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('the system twins refuse a request caller (rule `system`, Hassan L-1 on #1240)', async () => {
      const context = anonymous();

      expect(await app.get(CategoryTreeSystemQuery).execute(context, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await app.get(PublishedStoreSlugsSystem).execute(context, { sellerIds: [id<'Seller'>()] }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it.each([
      ['the system actor', system],
      ['an anonymous buyer', anonymous],
    ])(
      'the category tree, the subtree and the store directory pass the gate for %s',
      async (_, make) => {
        const context = make();
        const tree = app.get<CategoryTreeSource>(CATEGORY_TREE_SOURCE, { strict: false });
        const subtree = app.get<CategorySubtreeSource>(CATEGORY_SUBTREE_SOURCE, { strict: false });
        const stores = app.get<StoreDirectory>(STORE_DIRECTORY, { strict: false });

        await tree.tree(context);
        await subtree.subtreeOf(context, id<'Category'>());
        const directory = await stores.publicStores(context, [id<'Seller'>()]);

        expect(denialsOf(context)).toEqual([]);
        // An unknown seller is absent from the answer; a refusal or a fault would be null.
        expect(directory).toEqual(new Map());
      },
    );

    it('an index sync as the system actor completes with no access.denied', async () => {
      const context = system();

      const result = await app
        .get(SyncOfferDocuments)
        .execute(context, { offerIds: [id<'Offer'>()] });

      expect(result.ok).toBe(true);
      expect(denialsOf(context)).toEqual([]);
    });
  },
);
