import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  AttributeDefinition,
  DEFAULT_DISPLAY_SETTINGS,
} from '../../src/modules/catalog/domain/attribute-definition';
import { AttributeValueSuggestion } from '../../src/modules/catalog/domain/attribute-value-suggestion';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaAttributeDefinitionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-definition.store';
import { PrismaAttributeValueSuggestionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-value-suggestion.store';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The sellers' value suggestions on PostgreSQL (catalog data design 3.30; attributes A5), for both
// Market fixtures, as the API role: the open key (one open suggestion per product and attribute),
// a decision only out of open at its version, a notice move only out of pending, the Market
// boundary and the queries; and the backstops that hold without the use case: a decision's shape,
// an immutable text, a decided row that changes its decision, a delete. Times are the real
// clock's (the guard allows decided_at only within five minutes of the statement).

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `s${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog attribute suggestions in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const admin = uuid7() as Id<'Account'>;
  const seller = uuid7() as Id<'Seller'>;
  let db: Persistence;
  let owner: Client;
  let definitions: PrismaAttributeDefinitionStore;
  let products: PrismaProductRepository;
  let store: PrismaAttributeValueSuggestionStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    definitions = new PrismaAttributeDefinitionStore(db.service);
    products = new PrismaProductRepository(db.service);
    store = new PrismaAttributeValueSuggestionStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const sqlState = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'none';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  };

  /** A published select attribute of this Market. */
  async function publishedSelect(): Promise<AttributeDefinition> {
    const built = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType: 'select',
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Pack size' },
      options: [{ code: 'small', labels: { [locale]: 'Small' }, active: true, position: 0 }],
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!built.ok) throw new Error(built.error.code);
    await write(market, () => definitions.addDraft(market, built.value, admin));
    const published = built.value.publish(locale);
    if (!published.ok) throw new Error(published.error.code);
    await write(market, () => definitions.saveStatus(market, published.value));
    return published.value;
  }

  async function draftProduct(): Promise<Product> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'SELLER',
      sellerId: seller,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `X${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: now(),
    });
    if (!created.ok) throw new Error(created.error.code);
    await write(market, () => products.add(market, created.value));
    return created.value;
  }

  const suggestionFor = (
    definition: AttributeDefinition,
    product: Product,
    label = 'Extra large',
    sellerId = seller,
  ) => {
    const built = AttributeValueSuggestion.open({
      id: uuid7() as Id<'AttributeValueSuggestion'>,
      marketId: market.marketId,
      definitionId: definition.state.id,
      sellerId,
      productId: product.state.id,
      label,
      now: now(),
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };

  async function opened(label = 'Extra large') {
    const definition = await publishedSelect();
    const product = await draftProduct();
    const suggestion = suggestionFor(definition, product, label);
    expect(await write(market, () => store.add(market, suggestion))).toBeNull();
    return { definition, product, suggestion };
  }

  it('stores a suggestion and reads it back, in its own Market only', async () => {
    const { suggestion } = await opened();
    const found = await read(market, () => store.findById(market, suggestion.state.id));
    expect(found?.state).toMatchObject({
      label: 'Extra large',
      status: 'open',
      version: 1,
      noticeState: 'none',
      sellerId: seller,
    });
    expect(await read(other, () => store.findById(other, suggestion.state.id))).toBeNull();
  });

  it('allows one open suggestion per product and attribute, and another after a decision', async () => {
    const { definition, product, suggestion } = await opened();
    const second = suggestionFor(definition, product, 'Jumbo');
    expect(await write(market, () => store.add(market, second))).toBe('suggestion.already-open');
    expect(await read(market, () => store.findById(market, second.state.id))).toBeNull();

    const decided = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!decided.ok) throw new Error(decided.error.code);
    await write(market, () => store.saveDecision(market, decided.value));
    expect(await write(market, () => store.add(market, second))).toBeNull();
  });

  it('writes a decision once, from open at its version, and a second one is stale', async () => {
    const { suggestion } = await opened();
    const approved = suggestion.approve({ accountId: admin, optionCode: 'xl', now: now() });
    const rejected = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!approved.ok || !rejected.ok) throw new Error('decide');
    await write(market, () => store.saveDecision(market, approved.value));
    const stored = await read(market, () => store.findById(market, suggestion.state.id));
    expect(stored?.state).toMatchObject({
      status: 'approved',
      optionCode: 'xl',
      version: 2,
      noticeState: 'pending',
      decidedByAccountId: admin,
    });
    await expect(write(market, () => store.saveDecision(market, rejected.value))).rejects.toThrow(
      StaleAggregateError,
    );
  });

  it('lists open suggestions, counts a seller’s, and names a product’s open attribute codes', async () => {
    const { definition, product, suggestion } = await opened();
    const listed = await read(market, () => store.listOpen(market, 500));
    expect(listed.map((row) => row.state.id)).toContain(suggestion.state.id);
    const inOther = await read(other, () => store.listOpen(other, 500));
    expect(inOther.map((row) => row.state.id)).not.toContain(suggestion.state.id);
    expect(
      await read(market, () => store.openCountOfSeller(market, seller)),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await read(market, () => store.openAttributeCodesOfProduct(market, product.state.id)),
    ).toEqual(new Set([definition.state.code]));
    const history = await read(market, () => store.listOfProduct(market, product.state.id, 20));
    expect(history.map((row) => row.state.id)).toEqual([suggestion.state.id]);
  });

  it('lists one seller’s suggestions newest first, by page and status, never another seller’s or Market’s', async () => {
    const definition = await publishedSelect();
    const lister = uuid7() as Id<'Seller'>;
    const made: AttributeValueSuggestion[] = [];
    for (const label of ['First', 'Second', 'Third']) {
      const product = await draftProduct();
      const suggestion = suggestionFor(definition, product, label, lister);
      expect(await write(market, () => store.add(market, suggestion))).toBeNull();
      made.push(suggestion);
    }
    // Another seller of the same Market: never in this seller's list.
    const stranger = suggestionFor(
      definition,
      await draftProduct(),
      'Fourth',
      uuid7() as Id<'Seller'>,
    );
    expect(await write(market, () => store.add(market, stranger))).toBeNull();
    const [first, second, third] = made.map((row) => row.state.id);
    const rejected = made[1]!.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!rejected.ok) throw new Error(rejected.error.code);
    await write(market, () => store.saveDecision(market, rejected.value));

    const page = (
      status: 'open' | 'rejected' | null,
      afterId: Id<'AttributeValueSuggestion'> | null,
      limit = 10,
    ) => read(market, () => store.listOfSeller(market, lister, { status, afterId, limit }));
    expect((await page(null, null)).map((row) => row.state.id)).toEqual([third, second, first]);
    expect((await page(null, null, 2)).map((row) => row.state.id)).toEqual([third, second]);
    expect((await page(null, second!)).map((row) => row.state.id)).toEqual([first]);
    expect((await page('rejected', null)).map((row) => row.state.id)).toEqual([second]);
    expect((await page('open', null)).map((row) => row.state.id)).toEqual([third, first]);
    expect(
      await read(other, () =>
        store.listOfSeller(other, lister, { status: null, afterId: null, limit: 10 }),
      ),
    ).toEqual([]);
  });

  it('serves due notices and moves a notice only out of pending', async () => {
    const { suggestion } = await opened();
    const decided = suggestion.map({ accountId: admin, optionCode: 'small', now: now() });
    if (!decided.ok) throw new Error(decided.error.code);
    await write(market, () => store.saveDecision(market, decided.value));
    const due = await read(market, () => store.dueNotices(market, now(), 500));
    expect(due.map((row) => row.state.id)).toContain(suggestion.state.id);
    const sent = decided.value.noticeSent();
    if (sent === null) throw new Error('sent');
    await write(market, () => store.saveNotice(market, sent));
    expect(
      (await read(market, () => store.dueNotices(market, now(), 500))).map((row) => row.state.id),
    ).not.toContain(suggestion.state.id);
    expect(
      (await read(market, () => store.findById(market, suggestion.state.id)))?.state,
    ).toMatchObject({ noticeState: 'sent', noticeAttempts: 1, noticeNextAttemptAt: null });
    await expect(write(market, () => store.saveNotice(market, sent))).rejects.toThrow(
      StaleAggregateError,
    );
  });

  describe('database backstops', () => {
    const setUp = async () => (await opened()).suggestion.state.id;
    const run = (text: string, values: unknown[]) => owner.query(text, values);

    it('refuses an approval that names no value, and a rejection with no reason', async () => {
      const id = await setUp();
      expect(
        await sqlState(
          run(
            `UPDATE catalog.attribute_value_suggestions SET status = 'approved', version = 2,
               decided_by_account_id = $2, decided_at = now(), notice_state = 'pending',
               notice_next_attempt_at = now()
             WHERE id = $1`,
            [id, admin],
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          run(
            `UPDATE catalog.attribute_value_suggestions SET status = 'rejected', version = 2,
               decided_by_account_id = $2, decided_at = now(), notice_state = 'pending',
               notice_next_attempt_at = now()
             WHERE id = $1`,
            [id, admin],
          ),
        ),
      ).toBe('23514');
    });

    it('refuses to change the seller’s text, to skip a version and to delete', async () => {
      const id = await setUp();
      expect(
        await sqlState(
          run(
            `UPDATE catalog.attribute_value_suggestions SET label = 'Other', version = 2 WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          run(
            `UPDATE catalog.attribute_value_suggestions SET status = 'rejected', reject_reason = 'No.',
               decided_by_account_id = $2, decided_at = now(), notice_state = 'pending',
               notice_next_attempt_at = now(), version = 5
             WHERE id = $1`,
            [id, admin],
          ),
        ),
      ).toBe('23001');
      expect(
        await sqlState(run('DELETE FROM catalog.attribute_value_suggestions WHERE id = $1', [id])),
      ).toBe('23001');
      expect(await sqlState(run('TRUNCATE catalog.attribute_value_suggestions', []))).not.toBe(
        'none',
      );
    });

    it('never changes a decided suggestion', async () => {
      const { suggestion } = await opened();
      const decided = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
      if (!decided.ok) throw new Error(decided.error.code);
      await write(market, () => store.saveDecision(market, decided.value));
      expect(
        await sqlState(
          run(
            `UPDATE catalog.attribute_value_suggestions SET reject_reason = 'Changed', version = 3
             WHERE id = $1`,
            [suggestion.state.id],
          ),
        ),
      ).toBe('23001');
    });
  });
});
