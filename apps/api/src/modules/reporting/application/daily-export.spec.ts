import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { openGate } from '../../../../test/support/system-only-denial';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { ExceljsSheetWriter } from '../../../platform/list-export';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../platform/unit-of-work/unit-of-work';
import type { AdminKpiReader } from './ports/admin-kpi-reader';
import type { MarketZone } from './ports/market-zone';
import { ExportMarketplaceDaily } from './use-cases/export-marketplace-daily.use-case';

// The marketplace daily export on both Market fixtures, below HTTP: the rows and the audit row
// are in one read-write unit, an audit refusal sends no file, XLSX is offered, and the Market's
// today is the zone's day.

const id = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id;

async function text(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe.each(TEST_MARKETS)('ExportMarketplaceDaily in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id(0xa1) as never,
      sessionId: id(0xa2) as never,
      sellerId: null,
    }),
  );
  let units: UnitOfWorkOptions[];
  let audited: AuditEntry[];
  let failAudit: boolean;
  const unitOfWork = {
    run: (_m: unknown, work: () => Promise<unknown>, options: UnitOfWorkOptions = {}) => {
      units.push(options);
      return work();
    },
  } as unknown as UnitOfWork;
  const reader = {
    dailyTotals: () => Promise.resolve({ days: [], refreshedAt: null }),
  } as unknown as AdminKpiReader;
  const zone = (name: string): MarketZone => ({ zoneOf: () => name, currencyOf: () => 'XXX' });
  const build = (zoneName = 'Australia/Brisbane') =>
    new ExportMarketplaceDaily(openGate(), {
      unitOfWork,
      reader,
      zone: zone(zoneName),
      // Already the 22nd in Brisbane, still the 21st in Honolulu.
      clock: new FixedClock(Temporal.Instant.from('2026-11-21T23:30:00Z')),
      sheetWriter: new ExceljsSheetWriter(),
      audit: {
        record: (_context, entry) => {
          if (failAudit) return Promise.reject(new Error('refused'));
          audited.push(entry);
          return Promise.resolve();
        },
      },
    });

  beforeEach(() => {
    units = [];
    audited = [];
    failAudit = false;
  });

  it('reads and audits in one read-write unit, a day per row', async () => {
    const result = await build().execute(admin, { period: 'today' });
    expect(result.ok).toBe(true);
    expect(units).toEqual([{}]);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.after).toMatchObject({ period: 'today', days: 1, rowCount: 1 });
    const file = result.ok ? await text(result.value.chunks) : '';
    expect(file.split('\r\n')[1]).toBe('2026-11-22,XXX,0,0,0,0,0,0,0,0,0,0');
  });

  it("takes today in the Market's zone", async () => {
    const result = await build('Pacific/Honolulu').execute(admin, { period: 'today' });
    expect(result.ok && result.value.filename).toBe('marketplace-daily-2026-11-21-2026-11-21.csv');
  });

  it('sends no file when the audit row is refused', async () => {
    failAudit = true;
    const result = await build().execute(admin, { period: '7d' });
    expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });

  it('offers XLSX', async () => {
    const result = await build().execute(admin, { period: '30d', format: 'xlsx' });
    expect(result.ok && result.value.filename).toBe('marketplace-daily-2026-10-24-2026-11-22.xlsx');
    expect(audited[0]!.after).toMatchObject({ format: 'xlsx', rowCount: 30 });
  });

  it('refuses a seller session before any unit', async () => {
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id(0xb1) as never,
        sessionId: id(0xb2) as never,
        sellerId: id(0xb3) as never,
      }),
    );
    expect(await build().execute(seller, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(units).toEqual([]);
  });
});
