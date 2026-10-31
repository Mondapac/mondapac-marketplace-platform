import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type {
  AuditTrailEntry,
  AuditTrailQuery,
  AuditTrailReader,
} from '../../../../platform/audit/audit-trail-reader';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerAccountAccessRefused } from '../ports/seller-account-directory';
import type { TeamMemberLabel, TeamMemberLabelSource } from '../ports/team-member-labels';
import { InMemoryStoreProfiles } from '../testing/in-memory-store-profiles';
import { StoreSettingsMinimumOrderHistory } from './store-settings-minimum-order-history.use-case';

// The minimum-order history (seller operations P-E) in memory on both Market fixtures: the audit
// reader and identity's labels are fakes. The reader on PostgreSQL is in
// test/db/sellers-minimum-order.db-spec.ts; the HTTP mapping in test/store-settings.e2e.spec.ts.

const START = Temporal.Instant.from('2026-10-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const market = (code: string): MarketContext => testMarketContext(code, 'default');
const ACTION = 'sellers.minimum-order.changed';

const MARKETS = [
  { code: 'AU', currency: 'AUD' },
  { code: 'ZZ', currency: 'JPY' },
] as const;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const profiles = new InMemoryStoreProfiles();
  /** Per seller, oldest first, as the writer appends. */
  const trails = new Map<string, AuditTrailEntry[]>();
  const queries: AuditTrailQuery[] = [];
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const auditTrail: AuditTrailReader = {
    history: (_market, query) => {
      queries.push(query);
      const newest = [...(trails.get(query.targetId) ?? [])].reverse();
      let from = 0;
      if (query.after !== null) {
        const at = newest.findIndex((row) => row.id === query.after);
        if (at < 0) return Promise.resolve(err({ code: 'cursor.unknown' as const }));
        from = at + 1;
      }
      return Promise.resolve(ok(newest.slice(from, from + query.limit)));
    },
    // The minimum-order history reads one action of one seller through `history`.
    historyOf: () => Promise.reject(new Error('historyOf is not used by this history')),
  };
  const labels = new Map<Id<'Account'>, TeamMemberLabel>();
  const labelCalls: (readonly Id<'Account'>[])[] = [];
  let labelFailure: Error | null = null;
  const teamMembers: TeamMemberLabelSource = {
    labelsOf: (_context, accountIds) => {
      labelCalls.push(accountIds);
      if (labelFailure !== null) return Promise.reject(labelFailure);
      return Promise.resolve(
        new Map(accountIds.flatMap((id) => (labels.has(id) ? [[id, labels.get(id)!]] : []))),
      );
    },
  };
  let allowed = true;
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork: UnitOfWork = {
    run: (_market, work, options) => {
      units.push(options);
      return work();
    },
    runOnce: noRunOnce,
  };
  const history = new StoreSettingsMinimumOrderHistory(createUseCaseGate(markets, authorisation), {
    unitOfWork,
    storeProfiles: profiles,
    auditTrail,
    teamMembers,
  });
  return {
    ids,
    profiles,
    trails,
    queries,
    units,
    labels,
    labelCalls,
    history,
    failLabels: (error: Error) => void (labelFailure = error),
    deny: () => void (allowed = false),
  };
}
type Setup = ReturnType<typeof setUp>;

function sellerOf(t: Setup, code: string, approved: boolean | 'no-file' = true) {
  const sellerId = t.ids.next<'Seller'>();
  const accountId = t.ids.next<'Account'>();
  if (approved !== 'no-file')
    t.profiles.put(market(code), sellerId, { approved, minimumOrder: null });
  const context: CallContext = testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'seller',
      accountId,
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
  return { sellerId, accountId, context };
}

/** Appends a change row; `amount` null is "no minimum" (the side's field absent). */
function change(
  t: Setup,
  sellerId: string,
  actorId: string | null,
  before: { amount: string; currency: string } | null,
  after: { amount: string; currency: string } | null,
  minutes: number,
) {
  const row: AuditTrailEntry = {
    id: t.ids.next<'AuditLog'>(),
    occurredAt: START.add({ minutes }),
    actorType: actorId === null ? 'SYSTEM' : 'USER',
    actorId,
    before: before === null ? {} : { minimumOrder: before },
    after: after === null ? {} : { minimumOrder: after },
  };
  t.trails.set(sellerId, [...(t.trails.get(sellerId) ?? []), row]);
  return row;
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(MARKETS)('the minimum-order history in $code (seller operations P-E)', (fixture) => {
  const { code, currency } = fixture;
  const sized = (amount: string) => ({ amount, currency });
  const owner: TeamMemberLabel = {
    displayName: 'Amina Rahman',
    role: { kind: 'system', seedCode: 'seller-owner', name: null },
  };

  it('answers the changes newest first, with who, before and after, in a read-only unit', async () => {
    const t = setUp();
    const { sellerId, accountId, context } = sellerOf(t, code);
    t.labels.set(accountId, owner);
    change(t, sellerId, accountId, null, sized('2500'), 1);
    change(t, sellerId, accountId, sized('2500'), null, 2);

    const result = await t.history.execute(context, {});

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            changedAt: START.add({ minutes: 2 }),
            changedBy: owner,
            before: { amount: 2500n, currency },
            after: null,
          },
          {
            changedAt: START.add({ minutes: 1 }),
            changedBy: owner,
            before: null,
            after: { amount: 2500n, currency },
          },
        ],
        next: null,
      },
    });
    expect(t.queries).toEqual([{ action: ACTION, targetId: sellerId, after: null, limit: 21 }]);
    expect(t.units).toEqual([{ readOnly: true }]);
    expect(t.labelCalls).toEqual([[accountId]]);
  });

  it('names a former member, an admin or the system as null, and asks identity once per account', async () => {
    const t = setUp();
    const { sellerId, accountId, context } = sellerOf(t, code);
    const former = t.ids.next<'Account'>();
    t.labels.set(accountId, owner);
    change(t, sellerId, former, null, sized('100'), 1);
    change(t, sellerId, null, sized('100'), sized('200'), 2);
    change(t, sellerId, accountId, sized('200'), sized('300'), 3);
    change(t, sellerId, former, sized('300'), sized('400'), 4);

    const result = await t.history.execute(context, {});

    expect(result.ok && result.value.items.map((item) => item.changedBy)).toEqual([
      null,
      owner,
      null,
      null,
    ]);
    expect(t.labelCalls).toEqual([[former, accountId]]);
  });

  it('pages with after and limit, and says when no page follows', async () => {
    const t = setUp();
    const { sellerId, context } = sellerOf(t, code);
    const rows = [1, 2, 3, 4, 5].map((n) => change(t, sellerId, null, null, sized(`${n}00`), n));

    const first = await t.history.execute(context, { limit: 2 });
    const second = await t.history.execute(context, {
      limit: 2,
      after: first.ok ? first.value.next : null,
    });
    const last = await t.history.execute(context, {
      limit: 2,
      after: second.ok ? second.value.next : null,
    });

    const amounts = (page: typeof first) =>
      page.ok ? page.value.items.map((item) => item.after?.amount) : null;
    expect(amounts(first)).toEqual([500n, 400n]);
    expect(first.ok && first.value.next).toBe(rows[3]!.id);
    expect(amounts(second)).toEqual([300n, 200n]);
    expect(amounts(last)).toEqual([100n]);
    expect(last.ok && last.value.next).toBeNull();
  });

  it('reads only its own seller: another seller of the Market is never asked for', async () => {
    const t = setUp();
    const mine = sellerOf(t, code);
    const theirs = sellerOf(t, code);
    change(t, theirs.sellerId, theirs.accountId, null, sized('999'), 1);

    const result = await t.history.execute(mine.context, {});

    expect(result).toEqual({ ok: true, value: { items: [], next: null } });
    expect(t.queries.map((query) => query.targetId)).toEqual([mine.sellerId]);
  });

  it.each([
    ['a limit of 0', { limit: 0 }, 'limit', 'range'],
    ['a limit above 50', { limit: 51 }, 'limit', 'range'],
    ['a fractional limit', { limit: 1.5 }, 'limit', 'range'],
    ['a text limit', { limit: 'invalid' }, 'limit', 'range'],
    ['a malformed cursor', { after: 'nope' }, 'after', 'format'],
    ['a cursor of no row', { after: '01990000-0000-7000-8000-000000000999' }, 'after', 'unknown'],
  ])('refuses %s as validation.failed', async (_name, input, path, fieldCode) => {
    const t = setUp();
    const { context } = sellerOf(t, code);

    expect(await t.history.execute(context, input)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
    });
    expect(t.labelCalls).toEqual([]);
  });

  it('refuses a seller that is not approved, and one without a file, before any audit read', async () => {
    const t = setUp();
    const pending = sellerOf(t, code, false);
    const noFile = sellerOf(t, code, 'no-file');

    expect(await t.history.execute(pending.context, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await t.history.execute(noFile.context, {})).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
    expect(t.queries).toEqual([]);
  });

  it('refuses through the gate, and refuses a non-seller actor', async () => {
    const t = setUp();
    const { context } = sellerOf(t, code);
    const admin = testCallContext(
      market(code),
      testAuthenticatedActor(market(code), {
        population: 'admin',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId: null,
      }),
    );

    expect(await t.history.execute(admin, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    t.deny();
    expect(await t.history.execute(context, {})).toMatchObject({ ok: false });
    expect(t.queries).toEqual([]);
  });

  it('answers access.denied when identity refuses the actor, and sellers.unavailable when it fails', async () => {
    const t = setUp();
    const { sellerId, accountId, context } = sellerOf(t, code);
    change(t, sellerId, accountId, null, sized('100'), 1);

    t.failLabels(new SellerAccountAccessRefused('refused'));
    expect(await t.history.execute(context, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    t.failLabels(new Error('down'));
    expect(await t.history.execute(context, {})).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });
});
