import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  loadMarketConfigs,
  PAYOUT_TERMS_MAX_HOLD_DAYS,
  PAYOUT_TERMS_MIN_HOLD_DAYS,
  PAYOUT_TERMS_WEEKDAYS,
} from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  eligibleAtOf,
  holdDaysFor,
  localTimeToMinute,
  MAX_HOLD_DAYS,
  maskToWeekdays,
  MIN_HOLD_DAYS,
  minuteToLocalTime,
  overrideInBounds,
  parsePayoutTermsOverride,
  PAYOUT_WEEKDAYS,
  resolvePayoutTerms,
  weekdaysToMask,
  type MarketPayoutTermsConfig,
  type PayoutTermsOverride,
} from './payout-terms';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const termsOf = (marketId: MarketId) => markets.get(marketId).commissionPayouts!.payoutTerms!;

const NONE: PayoutTermsOverride = {
  weekdays: null,
  localTime: null,
  holdDaysCarrier: null,
  holdDaysSellerClick: null,
  minimumMinor: null,
  approvalMode: null,
};

describe('the code constants and the schema agree', () => {
  it('has the same hold bounds and weekdays in the domain and in the Market config schema', () => {
    expect([MIN_HOLD_DAYS, MAX_HOLD_DAYS]).toEqual([
      PAYOUT_TERMS_MIN_HOLD_DAYS,
      PAYOUT_TERMS_MAX_HOLD_DAYS,
    ]);
    expect([MIN_HOLD_DAYS, MAX_HOLD_DAYS]).toEqual([7, 60]);
    expect([...PAYOUT_WEEKDAYS]).toEqual([...PAYOUT_TERMS_WEEKDAYS]);
  });

  it('has the same bounds as the database CHECKs of the migration', () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../../../../../prisma/migrations/20261027140000_commission_payouts_terms_holds/migration.sql',
      ),
      'utf8',
    );
    const bounds = [...sql.matchAll(/BETWEEN (\d+) AND (\d+)/g)].map((m) => [m[1], m[2]]);
    const holdBounds = bounds.filter((b) => b[0] === '7');
    expect(holdBounds).toEqual([
      [String(MIN_HOLD_DAYS), String(MAX_HOLD_DAYS)],
      [String(MIN_HOLD_DAYS), String(MAX_HOLD_DAYS)],
      [String(MIN_HOLD_DAYS), String(MAX_HOLD_DAYS)],
    ]);
  });
});

describe.each(['AU', 'ZZ'] as const)('payout terms in market %s', (code) => {
  const marketId = testMarketContext(code, 'default').marketId;
  const market = termsOf(marketId);

  it('reads the Market terms from config, with no core default', () => {
    const resolved = resolvePayoutTerms(market, null);
    expect(resolved.ok && resolved.value).toEqual({
      weekdays: market.weekdays,
      localTime: market.localTime,
      holdDaysCarrier: market.holdDaysCarrier,
      holdDaysSellerClick: market.holdDaysSellerClick,
      minimumMinor: BigInt(market.minimumMinor),
      approvalMode: market.approvalMode,
      firstPayoutManual: market.firstPayoutManual,
    });
    expect(resolvePayoutTerms(null, null)).toEqual({
      ok: false,
      error: { code: 'commission-payouts.terms-unavailable' },
    });
  });

  it('lets a seller override win field by field, and keeps firstPayoutManual from config', () => {
    const resolved = resolvePayoutTerms(market, {
      ...NONE,
      holdDaysCarrier: 9,
      minimumMinor: 1234n,
      approvalMode: market.approvalMode === 'AUTO' ? 'MANUAL' : 'AUTO',
    });
    expect(resolved.ok && resolved.value).toMatchObject({
      holdDaysCarrier: 9,
      holdDaysSellerClick: market.holdDaysSellerClick,
      minimumMinor: 1234n,
      approvalMode: market.approvalMode === 'AUTO' ? 'MANUAL' : 'AUTO',
      firstPayoutManual: market.firstPayoutManual,
    });
  });

  it('fails closed on a stored override or a Market value outside the hold bounds', () => {
    for (const days of [MIN_HOLD_DAYS - 1, MAX_HOLD_DAYS + 1, 0, -1]) {
      expect(resolvePayoutTerms(market, { ...NONE, holdDaysCarrier: days }).ok).toBe(false);
      expect(resolvePayoutTerms(market, { ...NONE, holdDaysSellerClick: days }).ok).toBe(false);
      expect(overrideInBounds({ ...NONE, holdDaysCarrier: days })).toBe(false);
      expect(resolvePayoutTerms({ ...market, holdDaysCarrier: days }, null).ok).toBe(false);
      expect(resolvePayoutTerms({ ...market, holdDaysSellerClick: days }, null).ok).toBe(false);
    }
    expect(resolvePayoutTerms(market, { ...NONE, minimumMinor: 0n }).ok).toBe(false);
    const edge = resolvePayoutTerms(market, {
      ...NONE,
      holdDaysCarrier: MIN_HOLD_DAYS,
      holdDaysSellerClick: MAX_HOLD_DAYS,
    });
    expect(edge.ok).toBe(true);
  });

  it('anchors a carrier delivery on the carrier hold and a click on the seller-click hold', () => {
    const terms = resolvePayoutTerms(market, null);
    if (!terms.ok) throw new Error('terms');
    const delivered = Temporal.Instant.from('2026-10-20T03:00:00Z');
    expect(holdDaysFor('carrier', terms.value)).toBe(market.holdDaysCarrier);
    expect(holdDaysFor('seller-click', terms.value)).toBe(market.holdDaysSellerClick);
    expect(eligibleAtOf(delivered, market.holdDaysCarrier).toString()).toBe(
      delivered.add({ hours: market.holdDaysCarrier * 24 }).toString(),
    );
  });
});

describe('the fixtures differ', () => {
  it('gives AU the owner values and ZZ its own, in its own currency units', () => {
    expect(termsOf(testMarketContext('AU', 'default').marketId)).toEqual({
      weekdays: ['TUE'],
      localTime: '10:00',
      holdDaysCarrier: 7,
      holdDaysSellerClick: 14,
      minimumMinor: 5000,
      approvalMode: 'AUTO',
      firstPayoutManual: true,
    });
    const zz: MarketPayoutTermsConfig = termsOf(testMarketContext('ZZ', 'default').marketId);
    expect(zz).not.toEqual(termsOf(testMarketContext('AU', 'default').marketId));
    expect(zz.holdDaysCarrier).not.toBe(7);
    expect(markets.get(testMarketContext('ZZ', 'default').marketId).defaultCurrency).toBe('JPY');
  });

  it('rejects a Market config with out-of-bounds hold days or an unknown key (strict schema)', () => {
    // The bounds are enforced where the file is loaded, not only on write.
    const valid = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../../config/markets/AU.json'), 'utf8'),
    ) as { commissionPayouts: { payoutTerms: Record<string, unknown> } };
    const load = (patch: Record<string, unknown>) => {
      const dir = path.join(tmpdir(), `terms-${Math.random().toString(16).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const config = JSON.parse(JSON.stringify(valid)) as typeof valid;
      Object.assign(config.commissionPayouts.payoutTerms, patch);
      writeFileSync(path.join(dir, 'AU.json'), JSON.stringify(config));
      return () => loadMarketConfigs([dir], [testMarketContext('AU', 'default').marketId]);
    };
    expect(load({})).not.toThrow();
    expect(load({ holdDaysCarrier: 6 })).toThrow();
    expect(load({ holdDaysSellerClick: 61 })).toThrow();
    expect(load({ extra: 1 })).toThrow();
    expect(load({ localTime: '24:00' })).toThrow();
    expect(load({ weekdays: ['TUE', 'TUE'] })).toThrow();
    expect(load({ minimumMinor: 0 })).toThrow();
    expect(load({ approvalMode: 'SOMETIMES' })).toThrow();
    expect(load({ firstPayoutManual: 'yes' })).toThrow();
  });
});

describe('parsing an admin override', () => {
  it('accepts a partial override and reads absent or null fields as the Market value', () => {
    const parsed = parsePayoutTermsOverride({
      holdDaysCarrier: 10,
      localTime: '09:30',
      weekdays: ['FRI', 'MON'],
      approvalMode: null,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        weekdays: ['MON', 'FRI'],
        localTime: '09:30',
        holdDaysCarrier: 10,
        holdDaysSellerClick: null,
        minimumMinor: null,
        approvalMode: null,
      },
    });
  });

  it.each([
    [{}, [{ path: '', code: 'empty' }]],
    [{ holdDaysCarrier: 6 }, [{ path: 'holdDaysCarrier', code: 'range' }]],
    [{ holdDaysSellerClick: 61 }, [{ path: 'holdDaysSellerClick', code: 'range' }]],
    [{ holdDaysSellerClick: 14.5 }, [{ path: 'holdDaysSellerClick', code: 'range' }]],
    [{ holdDaysCarrier: '7' }, [{ path: 'holdDaysCarrier', code: 'range' }]],
    [{ minimumMinor: 0 }, [{ path: 'minimumMinor', code: 'range' }]],
    [{ minimumMinor: '5000' }, [{ path: 'minimumMinor', code: 'range' }]],
    [{ weekdays: [] }, [{ path: 'weekdays', code: 'format' }]],
    [{ weekdays: ['TUE', 'TUE'] }, [{ path: 'weekdays', code: 'format' }]],
    [{ weekdays: ['XXX'] }, [{ path: 'weekdays', code: 'format' }]],
    [{ localTime: '9:30' }, [{ path: 'localTime', code: 'format' }]],
    [{ localTime: '24:00' }, [{ path: 'localTime', code: 'format' }]],
    [{ approvalMode: 'auto' }, [{ path: 'approvalMode', code: 'format' }]],
    [null, [{ path: '', code: 'type' }]],
  ])('refuses %j', (input, problems) => {
    expect(parsePayoutTermsOverride(input)).toEqual({ ok: false, error: problems });
  });

  it('round-trips weekdays and the local time through their stored forms', () => {
    for (let mask = 1; mask <= 127; mask += 1) {
      expect(weekdaysToMask(maskToWeekdays(mask))).toBe(mask);
    }
    expect(weekdaysToMask(['MON'])).toBe(1);
    expect(weekdaysToMask(['TUE'])).toBe(2);
    for (const minute of [0, 59, 600, 870, 1439]) {
      expect(localTimeToMinute(minuteToLocalTime(minute))).toBe(minute);
    }
    expect(localTimeToMinute('10:00')).toBe(600);
  });
});
