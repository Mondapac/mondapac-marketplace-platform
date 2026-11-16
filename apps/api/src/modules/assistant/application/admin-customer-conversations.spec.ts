import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CustomerConversationsFacadeImplementation } from '../presentation/customer-conversations.facade';
import type { AssistantDependencies } from './assistant-dependencies';
import { MemoryConversations } from './testing/assistant-fakes';
import { AdminCustomerConversations } from './use-cases/admin-customer-conversations.use-case';

// The admin's read of one customer's assistant conversations (customers management phase 2b) on
// both Market fixtures: the count always and a page of dates, the customer's own conversations
// of this Market only, never a message or the turn count; a platform admin only. No model.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER = id<'Account'>(0xc2);

describe.each(TEST_MARKET_IDS)('the admin’s read of a customer’s conversations in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const elsewhere = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id<'Account'>(0xa1),
        sessionId: id<'Session'>(0xa2),
        sellerId: null,
      }),
    );

  async function setUp() {
    const conversations = new MemoryConversations();
    let n = 0;
    const start = async (m: MarketContext, accountId: Id<'Account'>, hours: number) => {
      n += 1;
      const conversation = `0199aaaa-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
      await conversations.create(m, {
        id: conversation,
        owner: { kind: 'account', accountId },
        turns: 0,
        retentionDays: 30,
        startedAt: T0.add({ hours }),
      });
      await conversations.countTurn(m, conversation, 0, T0.add({ minutes: hours * 60 + 30 }));
      await conversations.append(m, conversation, {
        role: 'buyer',
        text: 'private question',
        cards: [],
        at: T0.add({ minutes: hours * 60 + 30 }),
      });
    };
    for (const hours of [1, 2, 3]) await start(market, CUSTOMER, hours);
    await start(elsewhere, CUSTOMER, 4);
    await start(market, OTHER, 5);
    await conversations.create(market, {
      id: '0199aaaa-0000-7000-8000-0000000000ff',
      owner: { kind: 'guest', tokenHash: 'guest-hash' },
      turns: 0,
      retentionDays: 0,
      startedAt: T0,
    });
    const deps = {
      unitOfWork: new FakeUnitOfWork(),
      conversations,
    } as unknown as AssistantDependencies;
    return new CustomerConversationsFacadeImplementation(
      new AdminCustomerConversations(gate, deps),
    );
  }

  it('answers the count and a page of dates, never a message', async () => {
    const facade = await setUp();
    const page = await facade.adminCustomerConversations(admin(), {
      accountId: CUSTOMER,
      direction: 'desc',
      window: { offset: 0, limit: 2 },
    });
    expect(page).toEqual({
      ok: true,
      value: {
        total: 3,
        rows: [
          {
            startedAt: T0.add({ hours: 3 }).toString(),
            lastMessageAt: T0.add({ minutes: 210 }).toString(),
          },
          {
            startedAt: T0.add({ hours: 2 }).toString(),
            lastMessageAt: T0.add({ minutes: 150 }).toString(),
          },
        ],
      },
    });
    expect(JSON.stringify(page)).not.toContain('private');
    const oldest = await facade.adminCustomerConversations(admin(), {
      accountId: CUSTOMER,
      direction: 'asc',
      window: { offset: 2, limit: 5 },
    });
    expect(oldest).toEqual({
      ok: true,
      value: {
        total: 3,
        rows: [
          {
            startedAt: T0.add({ hours: 3 }).toString(),
            lastMessageAt: T0.add({ minutes: 210 }).toString(),
          },
        ],
      },
    });
  });

  it('refuses everyone but a platform admin, and an acting-as session', async () => {
    const facade = await setUp();
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: CUSTOMER,
        sessionId: id<'Session'>(0xa3),
        sellerId: null,
      }),
    );
    const acting = admin();
    const request = {
      accountId: CUSTOMER,
      direction: 'desc' as const,
      window: { offset: 0, limit: 5 },
    };
    for (const context of [
      testCallContext(market, 'system'),
      customer,
      { ...acting, actor: { ...acting.actor, actingAs: { sellerId: 'x' } } as never },
    ]) {
      expect(await facade.adminCustomerConversations(context, request)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
  });

  it('declares the assistant key only', () => {
    expect(AdminCustomerConversations.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['assistant.customer-conversation.view'],
    });
  });
});
