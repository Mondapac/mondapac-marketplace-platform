import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
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
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import { OwnZoneRead } from './own-zone-read.use-case';

// The seller's own approved zone for the panel's time inputs. PostgreSQL is covered by the
// approved-zones read of the revision repository (sellers-files db spec).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const market: MarketContext = testMarketContext('AU', 'default');
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-15T10:00:00Z')));

function setUp(zones: ReadonlyMap<Id<'Seller'>, string>, fail = false) {
  const revisions = {
    approvedZones: (_market: MarketContext, sellerIds: readonly Id<'Seller'>[]) => {
      if (fail) return Promise.reject(new Error('down'));
      return Promise.resolve(
        new Map(
          sellerIds.flatMap((id) => {
            const zone = zones.get(id);
            return zone === undefined
              ? []
              : [[id, { operatingTimezone: zone, addressTimezone: zone }] as const];
          }),
        ),
      );
    },
  } as unknown as BusinessFileRevisionRepository;
  const authorisation: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
  const unitOfWork: UnitOfWork = { run: (_m, work) => work(), runOnce: noRunOnce };
  return new OwnZoneRead(createUseCaseGate(markets, authorisation), { unitOfWork, revisions });
}

const contextOf = (sellerId: Id<'Seller'>): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId,
    }),
  );

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe('sellers own-zone-read', () => {
  it('answers the zone of the acting seller only', async () => {
    const mine = ids.next<'Seller'>();
    const other = ids.next<'Seller'>();
    const read = setUp(
      new Map([
        [mine, 'Australia/Perth'],
        [other, 'Australia/Sydney'],
      ]),
    );

    expect(await read.execute(contextOf(mine), {})).toEqual({
      ok: true,
      value: { zone: 'Australia/Perth' },
    });
  });

  it('answers file.not-found when there is no approved revision', async () => {
    const read = setUp(new Map());

    expect(await read.execute(contextOf(ids.next<'Seller'>()), {})).toEqual({
      ok: false,
      error: { code: 'file.not-found' },
    });
  });

  it('answers sellers.unavailable when the read fails', async () => {
    const read = setUp(new Map(), true);

    expect(await read.execute(contextOf(ids.next<'Seller'>()), {})).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
  });

  it('refuses an actor that is not a seller', async () => {
    const read = setUp(new Map());
    const anonymous = testCallContext(market, 'anonymous', 'own-zone-test-0001');

    const result = await read.execute(anonymous, {});

    expect(result.ok).toBe(false);
  });
});
