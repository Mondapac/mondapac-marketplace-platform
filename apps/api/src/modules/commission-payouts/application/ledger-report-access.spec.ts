import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { LedgerReportDependencies } from './ledger-report-flow';
import type { LedgerReportReader } from './ports/ledger-report.reader';
import { LedgerEntriesRecordedQuery } from './use-cases/ledger-entries-recorded.use-case';
import { LedgerReportEntriesQuery } from './use-cases/ledger-report-entries.use-case';

// Reporting's reads of the seller ledger (dashboards v2, phase 1, PR 4) are rule `system`: only
// reporting's worker reaches them. A platform admin, a seller or a customer is `access.denied`
// before any read, even with every permission granted, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each(TEST_MARKETS)('the ledger report reads in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let reads: number;
  let deps: LedgerReportDependencies;

  beforeEach(() => {
    reads = 0;
    const reader: LedgerReportReader = {
      entriesOf: () => {
        reads += 1;
        return Promise.resolve([]);
      },
      entriesRecorded: () => {
        reads += 1;
        return Promise.resolve({ entries: [], next: null } as never);
      },
    };
    deps = {
      unitOfWork: {
        run: (_market: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as LedgerReportDependencies['unitOfWork'],
      reader,
    };
  });

  const actor = (population: 'admin' | 'seller' | 'customer', n: number) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(n),
        sessionId: id(0x1000 + n),
        sellerId: population === 'seller' ? id(0x5e11) : null,
      }),
    );
  const entriesInput = { sellerOrderIds: [id<'SellerOrder'>(0x50)] };
  const recordedInput = {
    window: { from: null, to: Temporal.Instant.from('2026-11-22T00:00:00Z') },
    after: null,
    limit: 10,
  };

  it.each([
    ['a platform admin', 'admin', 0xa1],
    ['a seller', 'seller', 0xb1],
    ['a customer', 'customer', 0xc1],
  ] as const)('refuses %s on both reads', async (_label, population, n) => {
    const context = actor(population, n);
    expect(
      await new LedgerReportEntriesQuery(gate, deps).execute(context, entriesInput),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(
      await new LedgerEntriesRecordedQuery(gate, deps).execute(context, recordedInput),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(reads).toBe(0);
  });

  it('answers the system actor', async () => {
    const context = testCallContext(market, 'system');
    expect(
      await new LedgerReportEntriesQuery(gate, deps).execute(context, entriesInput),
    ).toMatchObject({ ok: true });
    expect(
      await new LedgerEntriesRecordedQuery(gate, deps).execute(context, recordedInput),
    ).toMatchObject({ ok: true });
    expect(reads).toBe(2);
  });
});
