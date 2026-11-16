import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { PrismaConversationRepository } from '../../src/modules/assistant/infrastructure/prisma-conversation.repository';
import { PrismaBehaviourEventRepository } from '../../src/modules/engagement/infrastructure/prisma-behaviour-event.repository';
import type { BehaviourFacts } from '../../src/modules/engagement/domain/behaviour-event';
import { PrismaMarketingConsentRepository } from '../../src/modules/legal/infrastructure/prisma-marketing-consent.repository';
import { PrismaCartReminderRepository } from '../../src/modules/notifications/infrastructure/prisma-cart-reminder.repository';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The owners' reads behind the customer page's shopping and privacy sections (customers
// management phase 2b, part 2) on PostgreSQL as the application role, for both Market fixtures:
// one account's add-to-cart events in a range and its behaviour in counts (never the search
// text), its consent changes, its conversation dates and its reminders sent; each in both
// directions with a window and a count, never another account's or another Market's rows.

const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');
const at = (hoursAgo: number) => NOW.subtract({ hours: hoursAgo });

describe.each(TEST_MARKETS)('customer page activity reads in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const customer = randomUUID() as Id<'Account'>;
  const stranger = randomUUID() as Id<'Account'>;
  const clock = new FixedClock(NOW);
  let db: Persistence;
  let events: PrismaBehaviourEventRepository;
  let consents: PrismaMarketingConsentRepository;
  let conversations: PrismaConversationRepository;
  let reminders: PrismaCartReminderRepository;

  const write = (m: MarketContext, work: () => Promise<unknown>) =>
    db.unitOfWork.run(m, async () => {
      await work();
      return ok(undefined);
    });
  const read = <T>(m: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(m, async () => ok(await work()), { readOnly: true });

  const event = (m: MarketContext, accountId: Id<'Account'>, facts: BehaviourFacts, h: number) =>
    write(m, () =>
      events.append(m, {
        id: randomUUID() as Id<'BehaviourEvent'>,
        subject: { kind: 'account', accountId },
        facts,
        occurredAt: at(h),
      }),
    );
  const addition = (): BehaviourFacts => ({
    kind: 'added-to-cart',
    offerId: randomUUID() as Id<'Offer'>,
    variantId: randomUUID() as Id<'Variant'>,
  });
  const categoryA = randomUUID() as Id<'Category'>;
  const categoryB = randomUUID() as Id<'Category'>;

  beforeAll(async () => {
    db = createPersistence();
    events = new PrismaBehaviourEventRepository(db.service);
    consents = new PrismaMarketingConsentRepository(db.service);
    conversations = new PrismaConversationRepository(
      db.service,
      new NodeSubjectKeyService(
        new PrismaSubjectKeyStore(db.service, db.unitOfWork),
        new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
        clock,
      ),
    );
    reminders = new PrismaCartReminderRepository(db.service);

    for (const h of [1, 2, 3]) await event(market, customer, addition(), h);
    await event(market, customer, { kind: 'category-viewed', categoryId: categoryB }, 4);
    await event(market, customer, { kind: 'category-viewed', categoryId: categoryA }, 5);
    await event(market, customer, { kind: 'category-viewed', categoryId: categoryA }, 6);
    await event(
      market,
      customer,
      { kind: 'product-viewed', productId: randomUUID() as Id<'Product'>, offerId: null },
      7,
    );
    await event(market, customer, { kind: 'search-performed', query: 'secret words' }, 8);
    await event(market, customer, addition(), 24 * 400);
    await event(other, customer, addition(), 1);
    await event(market, stranger, addition(), 1);

    for (const [h, granted, source] of [
      [3, true, 'sign-up'],
      [2, false, 'unsubscribe-link'],
      [1, true, 'account'],
    ] as const) {
      await write(market, () =>
        consents.record(
          market,
          {
            id: randomUUID() as Id<'MarketingConsent'>,
            accountId: customer,
            channel: 'email',
            granted,
            source,
            changedAt: at(h),
            createdAt: at(3),
          },
          {
            id: randomUUID() as Id<'MarketingConsentChange'>,
            accountId: customer,
            channel: 'email',
            granted,
            source,
            occurredAt: at(h),
          },
        ),
      );
    }

    for (const [m, accountId, h] of [
      [market, customer, 3],
      [market, customer, 2],
      [other, customer, 1],
      [market, stranger, 1],
    ] as const) {
      await write(m, () =>
        conversations.create(m, {
          id: randomUUID(),
          owner: { kind: 'account', accountId },
          turns: 0,
          retentionDays: 0,
          startedAt: at(h),
        }),
      );
    }

    for (const [m, accountId, h, stage] of [
      [market, customer, 10, 1],
      [market, customer, 10, 2],
      [other, customer, 10, 1],
      [market, stranger, 10, 1],
    ] as const) {
      await write(m, () =>
        reminders.take(m, { accountId, cartChangedAt: at(h + 20), stage }, at(h - stage)),
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it('pages the add-to-cart events of a range and counts the behaviour, never the search text', async () => {
    const range = { from: at(24 * 365), to: null };
    const page = await read(market, () =>
      events.cartAdditionsOfAccount(market, customer, range, 'desc', { offset: 0, limit: 2 }),
    );
    expect(page.ok && page.value.map((row) => row.occurredAt)).toEqual([at(1), at(2)]);
    const older = await read(market, () =>
      events.cartAdditionsOfAccount(market, customer, { from: at(24 * 365), to: at(1) }, 'asc', {
        offset: 0,
        limit: 10,
      }),
    );
    expect(older.ok && older.value.map((row) => row.occurredAt)).toEqual([at(3), at(2)]);
    expect(
      await read(market, () => events.countCartAdditionsOfAccount(market, customer, range)),
    ).toEqual({ ok: true, value: 3 });
    const summary = await read(market, () =>
      events.summaryOfAccount(market, customer, at(24 * 365), 10),
    );
    expect(summary).toEqual({
      ok: true,
      value: {
        productViews: 1,
        categoryViews: 3,
        cartAdditions: 3,
        topCategories: [
          { categoryId: categoryA, views: 2 },
          { categoryId: categoryB, views: 1 },
        ],
      },
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('pages the consent changes by channel, newest or oldest first', async () => {
    const page = await read(market, () =>
      consents.changesOf(market, customer, null, 'desc', { offset: 0, limit: 2 }),
    );
    expect(page.ok && page.value.map((row) => row.source)).toEqual(['account', 'unsubscribe-link']);
    const first = await read(market, () =>
      consents.changesOf(market, customer, ['email'], 'asc', { offset: 0, limit: 1 }),
    );
    expect(first.ok && first.value.map((row) => [row.source, row.granted])).toEqual([
      ['sign-up', true],
    ]);
    expect(await read(market, () => consents.countChangesOf(market, customer, null))).toEqual({
      ok: true,
      value: 3,
    });
    expect(await read(other, () => consents.countChangesOf(other, customer, null))).toEqual({
      ok: true,
      value: 0,
    });
  });

  it('pages the conversation dates and counts them, this Market’s and this account’s only', async () => {
    const page = await read(market, () =>
      conversations.datesOfAccount(market, customer, 'desc', { offset: 0, limit: 5 }),
    );
    expect(page.ok && page.value.map((row) => row.startedAt)).toEqual([at(2), at(3)]);
    expect(await read(market, () => conversations.countOfAccount(market, customer))).toEqual({
      ok: true,
      value: 2,
    });
    expect(await read(other, () => conversations.countOfAccount(other, customer))).toEqual({
      ok: true,
      value: 1,
    });
  });

  it('pages the reminders sent to the account and counts them', async () => {
    const page = await read(market, () =>
      reminders.pageOfAccount(market, customer, 'asc', { offset: 0, limit: 5 }),
    );
    expect(page.ok && page.value.map((row) => [row.stage, row.takenAt])).toEqual([
      [1, at(9)],
      [2, at(8)],
    ]);
    expect(await read(market, () => reminders.countOfAccount(market, customer))).toEqual({
      ok: true,
      value: 2,
    });
  });
});
