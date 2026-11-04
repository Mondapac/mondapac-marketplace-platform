import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ConfiguredArea, OnboardingAreas } from '../ports/seller-market-formats';
import type {
  AreaNamesApplied,
  AreaNameSource,
  EditedAreaName,
  EditedNamesByArea,
  ServiceAreaNamesRepository,
} from '../ports/service-area-names.repository';
import { ServiceAreaNamesEdit } from './service-area-names-edit.use-case';
import { ServiceAreaNamesList } from './service-area-names-list.use-case';

// Editable service area names (ADR-0041) in memory, on both Market fixtures. The PostgreSQL table
// is covered by test/db/service-area-names.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const AREA: ConfiguredArea = {
  code: 'harbour-city',
  region: 'QLD',
  names: { en: 'Harbour City' },
  sellerOnboardingEnabled: false,
  deliveryEnabled: false,
};

class Store implements ServiceAreaNamesRepository {
  readonly rows = new Map<string, EditedAreaName & { by: string }>();
  all(market: MarketContext): Promise<readonly EditedAreaName[]> {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([k]) => k.startsWith(`${market.marketId}|`))
        .map(([, v]) => v),
    );
  }
  apply(
    market: MarketContext,
    areaCode: string,
    changes: ReadonlyMap<string, string | null>,
    by: Id<'Account'>,
  ): Promise<AreaNamesApplied> {
    let set = 0;
    let restored = 0;
    for (const [locale, name] of changes) {
      const key = `${market.marketId}|${areaCode}|${locale}`;
      const held = this.rows.get(key);
      if (name === null) {
        if (held !== undefined) restored += Number(this.rows.delete(key));
      } else if (held?.name !== name) {
        this.rows.set(key, { areaCode, locale, name, by });
        set += 1;
      }
    }
    return Promise.resolve({ set, restored });
  }
}

function setUp() {
  const clock = new FixedClock(Temporal.Instant.from('2026-11-04T10:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  const store = new Store();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let held = true;
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        held ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const areas: OnboardingAreas = {
    openCodes: () => [],
    nameOf: () => null,
    all: () => [{ code: AREA.code, name: 'Harbour City' }],
    configured: () => [AREA],
  };
  let forgotten = 0;
  const areaNames: AreaNameSource = {
    edited: async (market): Promise<EditedNamesByArea> => {
      const out = new Map<string, Record<string, string>>();
      for (const row of await store.all(market)) {
        out.set(row.areaCode, { ...(out.get(row.areaCode) ?? {}), [row.locale]: row.name });
      }
      return out;
    },
    forget: () => void (forgotten += 1),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  return {
    ids,
    store,
    audits,
    forgotten: () => forgotten,
    withhold: () => void (held = false),
    list: new ServiceAreaNamesList(gate, { onboardingAreas: areas, areaNames }),
    edit: new ServiceAreaNamesEdit(gate, {
      unitOfWork,
      areaNameStore: store,
      onboardingAreas: areas,
      areaNames,
      audit,
      clock,
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

const adminOf = (t: Setup, code: string): CallContext => {
  const market = testMarketContext(code, 'default');
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId: null,
    }),
  );
};

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each([['AU'], ['ZZ']])('service area names in %s', (code) => {
  it('lists the configured names, then the edited ones', async () => {
    const t = setUp();
    const context = adminOf(t, code);
    const before = await t.list.execute(context, undefined);
    expect(before.ok && before.value.areas[0]?.names['en']).toEqual({
      name: 'Harbour City',
      configuredName: 'Harbour City',
      edited: false,
    });
    expect(before.ok && before.value.languages).toEqual(expect.arrayContaining(['en', 'fa', 'ar']));

    const edited = await t.edit.execute(context, {
      areaCode: AREA.code,
      names: { en: ' Harbour City Region ', fa: 'شهر بندری' },
    });
    expect(edited.ok && edited.value.changed).toBe(2);
    expect(edited.ok && edited.value.area.names['en']).toEqual({
      name: 'Harbour City Region',
      configuredName: 'Harbour City',
      edited: true,
    });
    expect(edited.ok && edited.value.area.names['fa']).toMatchObject({
      configuredName: null,
      edited: true,
    });
    expect(t.forgotten()).toBe(1);
    expect(t.audits).toHaveLength(1);
    expect(JSON.stringify(t.audits)).not.toContain('Harbour City Region');
  });

  it('restores the configured name with null, and writes nothing for a repeat', async () => {
    const t = setUp();
    const context = adminOf(t, code);
    await t.edit.execute(context, { areaCode: AREA.code, names: { en: 'Renamed' } });
    const again = await t.edit.execute(context, { areaCode: AREA.code, names: { en: 'Renamed' } });
    expect(again.ok && again.value.changed).toBe(0);
    expect(t.audits).toHaveLength(1);
    const restored = await t.edit.execute(context, { areaCode: AREA.code, names: { en: null } });
    expect(restored.ok && restored.value.area.names['en']?.name).toBe('Harbour City');
    expect(t.audits).toHaveLength(2);
    expect(t.store.rows.size).toBe(0);
  });

  it('audits the rows that changed, not the entries of the request', async () => {
    const t = setUp();
    const context = adminOf(t, code);
    await t.edit.execute(context, { areaCode: AREA.code, names: { en: 'Same' } });
    t.audits.length = 0;
    // en is a repeat (no change) and fa has no edit to restore: nothing changed, nothing audited.
    const noop = await t.edit.execute(context, {
      areaCode: AREA.code,
      names: { en: 'Same', fa: null },
    });
    expect(noop.ok && noop.value.changed).toBe(0);
    expect(t.audits).toHaveLength(0);
    // ar is new, en repeats, fa has no edit: one name set, none restored.
    const mixed = await t.edit.execute(context, {
      areaCode: AREA.code,
      names: { en: 'Same', fa: null, ar: 'مدينة' },
    });
    expect(mixed.ok && mixed.value.changed).toBe(1);
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({ after: { namesSet: 1, namesRestored: 0 } });
  });

  it('refuses an unknown area, a bad body and a caller without the key', async () => {
    const t = setUp();
    const context = adminOf(t, code);
    expect(await t.edit.execute(context, { areaCode: 'nowhere', names: { en: 'X' } })).toEqual({
      ok: false,
      error: { code: 'service-area.not-found' },
    });
    expect(await t.edit.execute(context, { areaCode: AREA.code, names: { de: 'X' } })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'names.de', code: 'locale' }] },
    });
    t.withhold();
    const denied = await t.edit.execute(context, { areaCode: AREA.code, names: { en: 'X' } });
    expect(!denied.ok && denied.error.code).toBe('access.denied');
    expect(t.store.rows.size).toBe(0);
  });

  it('keeps edits of one Market out of the other', async () => {
    const t = setUp();
    await t.edit.execute(adminOf(t, code), { areaCode: AREA.code, names: { en: 'Mine' } });
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const seen = await t.list.execute(adminOf(t, other), undefined);
    expect(seen.ok && seen.value.areas[0]?.names['en']?.edited).toBe(false);
  });
});
