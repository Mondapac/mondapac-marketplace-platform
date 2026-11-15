import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { newTopic, parseTopicContent } from '../../src/modules/catalog/domain/topic';
import { TopicSuggestion } from '../../src/modules/catalog/domain/topic-suggestion';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaTopicRepository } from '../../src/modules/catalog/infrastructure/prisma-topic.repository';
import { PrismaTopicSuggestionStore } from '../../src/modules/catalog/infrastructure/prisma-topic-suggestion.store';
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

// The sellers' tag suggestions on PostgreSQL (product tags T5), for both
// Market fixtures, as the API role: the open key (one open suggestion per seller and text),
// a decision only out of open at its version, a notice move only out of pending, the Market
// boundary and the queries; and the backstops that hold without the use case: a decision's shape,
// an immutable text, a decided row that changes its decision, a delete. Times are the real
// clock's (the guard allows decided_at only within five minutes of the statement).

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `s${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog topic suggestions in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const admin = uuid7() as Id<'Account'>;
  const seller = uuid7() as Id<'Seller'>;
  let db: Persistence;
  let owner: Client;
  let topics: PrismaTopicRepository;
  let products: PrismaProductRepository;
  let store: PrismaTopicSuggestionStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    topics = new PrismaTopicRepository(db.service);
    products = new PrismaProductRepository(db.service);
    store = new PrismaTopicSuggestionStore(db.service);
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

  /** An active topic of this Market, as an admin's approval makes it. */
  async function activeTopic(): Promise<Id<'Topic'>> {
    const name = `Tag ${unique()}`;
    const content = parseTopicContent(
      { group: 'use', names: { [locale]: name } },
      { required: locale, supported: [locale] },
    );
    if (!content.ok) throw new Error('content');
    const state = newTopic({
      id: uuid7() as Id<'Topic'>,
      slug: unique(),
      content: content.value,
      createdBy: admin,
      now: now(),
    });
    expect(await write(market, () => topics.add(market, state))).toBeNull();
    return state.id;
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

  const suggestionFor = (product: Product, label = 'Weekend grill', sellerId = seller) => {
    const built = TopicSuggestion.open({
      id: uuid7() as Id<'TopicSuggestion'>,
      marketId: market.marketId,
      sellerId,
      productId: product.state.id,
      label,
      now: now(),
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };

  async function opened(label = `Grill ${unique()}`) {
    const product = await draftProduct();
    const suggestion = suggestionFor(product, label);
    expect(await write(market, () => store.add(market, suggestion))).toBeNull();
    return { product, suggestion };
  }

  it('stores a suggestion and reads it back, in its own Market only', async () => {
    const { suggestion } = await opened();
    const found = await read(market, () => store.findById(market, suggestion.state.id));
    expect(found?.state.label).toContain('Grill');
    expect(found?.state).toMatchObject({
      status: 'open',
      version: 1,
      noticeState: 'none',
      sellerId: seller,
    });
    expect(await read(other, () => store.findById(other, suggestion.state.id))).toBeNull();
  });

  it('allows one open suggestion per seller and text, and another after a decision', async () => {
    const { suggestion } = await opened('Eid feast');
    const second = suggestionFor(await draftProduct(), 'EID  feast');
    expect(await write(market, () => store.add(market, second))).toBe('suggestion.already-open');
    expect(await read(market, () => store.findById(market, second.state.id))).toBeNull();

    const decided = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!decided.ok) throw new Error(decided.error.code);
    await write(market, () => store.saveDecision(market, decided.value));
    expect(await write(market, () => store.add(market, second))).toBeNull();
  });

  it('writes a decision once, from open at its version, and a second one is stale', async () => {
    const { suggestion } = await opened();
    const topicId = await activeTopic();
    const approved = suggestion.approve({ accountId: admin, topicId, now: now() });
    const rejected = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!approved.ok || !rejected.ok) throw new Error('decide');
    await write(market, () => store.saveDecision(market, approved.value));
    const stored = await read(market, () => store.findById(market, suggestion.state.id));
    expect(stored?.state).toMatchObject({
      status: 'approved',
      topicId,
      version: 2,
      noticeState: 'pending',
      decidedByAccountId: admin,
    });
    await expect(write(market, () => store.saveDecision(market, rejected.value))).rejects.toThrow(
      StaleAggregateError,
    );
  });

  it('lists open suggestions and counts a seller’s, in the Market only', async () => {
    const { product, suggestion } = await opened();
    const listed = await read(market, () => store.listOpen(market, 500));
    expect(listed.map((row) => row.state.id)).toContain(suggestion.state.id);
    const inOther = await read(other, () => store.listOpen(other, 500));
    expect(inOther.map((row) => row.state.id)).not.toContain(suggestion.state.id);
    expect(
      await read(market, () => store.openCountOfSeller(market, seller)),
    ).toBeGreaterThanOrEqual(1);
    const history = await read(market, () => store.listOfProduct(market, product.state.id, 20));
    expect(history.map((row) => row.state.id)).toEqual([suggestion.state.id]);
  });

  it('lists one seller’s suggestions newest first, by page and status, never another seller’s or Market’s', async () => {
    const lister = uuid7() as Id<'Seller'>;
    const made: TopicSuggestion[] = [];
    for (const label of ['First tag', 'Second tag', 'Third tag']) {
      const product = await draftProduct();
      const suggestion = suggestionFor(product, label, lister);
      expect(await write(market, () => store.add(market, suggestion))).toBeNull();
      made.push(suggestion);
    }
    // Another seller of the same Market: never in this seller's list.
    const stranger = suggestionFor(await draftProduct(), 'Fourth', uuid7() as Id<'Seller'>);
    expect(await write(market, () => store.add(market, stranger))).toBeNull();
    const [first, second, third] = made.map((row) => row.state.id);
    const rejected = made[1]!.reject({ accountId: admin, reason: 'No.', now: now() });
    if (!rejected.ok) throw new Error(rejected.error.code);
    await write(market, () => store.saveDecision(market, rejected.value));

    const page = (
      status: 'open' | 'rejected' | null,
      afterId: Id<'TopicSuggestion'> | null,
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
    const decided = suggestion.map({
      accountId: admin,
      topicId: await activeTopic(),
      now: now(),
    });
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

    it('refuses an approval that names no topic, and a rejection with no reason', async () => {
      const id = await setUp();
      expect(
        await sqlState(
          run(
            `UPDATE catalog.topic_suggestions SET status = 'approved', version = 2,
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
            `UPDATE catalog.topic_suggestions SET status = 'rejected', version = 2,
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
          run(`UPDATE catalog.topic_suggestions SET label = 'Other', version = 2 WHERE id = $1`, [
            id,
          ]),
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          run(
            `UPDATE catalog.topic_suggestions SET status = 'rejected', reject_reason = 'No.',
               decided_by_account_id = $2, decided_at = now(), notice_state = 'pending',
               notice_next_attempt_at = now(), version = 5
             WHERE id = $1`,
            [id, admin],
          ),
        ),
      ).toBe('23001');
      expect(await sqlState(run('DELETE FROM catalog.topic_suggestions WHERE id = $1', [id]))).toBe(
        '23001',
      );
      expect(await sqlState(run('TRUNCATE catalog.topic_suggestions', []))).not.toBe('none');
    });

    it('never changes a decided suggestion', async () => {
      const { suggestion } = await opened();
      const decided = suggestion.reject({ accountId: admin, reason: 'No.', now: now() });
      if (!decided.ok) throw new Error(decided.error.code);
      await write(market, () => store.saveDecision(market, decided.value));
      expect(
        await sqlState(
          run(
            `UPDATE catalog.topic_suggestions SET reject_reason = 'Changed', version = 3
             WHERE id = $1`,
            [suggestion.state.id],
          ),
        ),
      ).toBe('23001');
    });
  });
});
