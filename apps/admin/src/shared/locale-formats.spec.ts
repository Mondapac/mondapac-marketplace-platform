import { describe, expect, it } from 'vitest';
import { percentOf } from '../commission/types.ts';
import { formatMoney, percentChange } from '../pricing/format.ts';
import { exponentOf, formatMinor } from '../shipping/money.ts';
import { formatInstant, shortInstant } from './format.ts';
import { dateFormat, numberFormat } from './intl.ts';

// Two Market fixtures (CLAUDE.md): AU, and a synthetic Market with another locale and currency.
const AU = { locale: 'en-AU', currency: 'AUD' };
const DE = { locale: 'de-DE', currency: 'EUR' };

describe('formats follow the Market locale', () => {
  it('formats an instant in UTC under each locale', () => {
    expect(formatInstant('2026-10-09T23:30:00.000Z', AU.locale)).toMatch(
      /^9 Oct 2026, 11:30\s?pm UTC$/i,
    );
    expect(formatInstant('2026-10-09T23:30:00.000Z', DE.locale)).toMatch(
      /^09\.10\.2026, 23:30 UTC$/,
    );
  });

  it('keeps the dash for a missing or bad instant in every locale', () => {
    for (const { locale } of [AU, DE]) {
      expect(formatInstant(null, locale)).toBe('-');
      expect(formatInstant('nope', locale)).toBe('-');
      expect(shortInstant(null, locale)).toBe('-');
      expect(shortInstant('nope', locale)).toBe('-');
    }
  });

  it('writes a short instant with the year only when it is not this one', () => {
    const lastYear = `${new Date().getUTCFullYear() - 1}-10-09T23:30:00.000Z`;
    expect(shortInstant(lastYear, AU.locale)).toContain(String(new Date().getUTCFullYear() - 1));
    expect(shortInstant(lastYear, DE.locale)).toMatch(/^9\. Okt\.? \d{4}, 23:30$/);
    const thisYear = `${new Date().getUTCFullYear()}-10-09T23:30:00.000Z`;
    expect(shortInstant(thisYear, AU.locale)).not.toMatch(/\d{4}/);
  });

  it('formats minor units in the Market currency and locale', () => {
    expect(formatMinor('1999', AU.currency, AU.locale)).toBe('$19.99');
    expect(formatMinor('123450', DE.currency, DE.locale)).toMatch(/^1\.234,50\s€$/);
    expect(formatMoney({ amount: '1999', currency: AU.currency }, AU.locale)).toBe('$19.99');
    expect(formatMoney({ amount: '1999', currency: DE.currency }, DE.locale)).toMatch(/^19,99\s€$/);
    expect(formatMoney({ amount: 'x', currency: DE.currency }, DE.locale)).toBe('-');
  });

  it('reads the currency exponent from the currency, not the locale', () => {
    expect(exponentOf('AUD')).toBe(2);
    expect(exponentOf('JPY')).toBe(0);
  });

  it('formats percentages in the Market locale', () => {
    expect(percentOf(1250, AU.locale)).toBe('12.5');
    expect(percentOf(1250, DE.locale)).toBe('12,5');
    expect(percentChange('2280', '1000', AU.locale)).toBe('+128%');
    expect(percentChange('2280', '1000', DE.locale)).toMatch(/^\+128\s%$/);
    expect(percentChange('x', '1000', DE.locale)).toBeNull();
  });
});

describe('Intl format cache', () => {
  it('reuses a formatter per locale and options', () => {
    const options = { dateStyle: 'medium' } as const;
    expect(dateFormat('en-AU', options)).toBe(dateFormat('en-AU', options));
    expect(dateFormat('en-AU', options)).not.toBe(dateFormat('de-DE', options));
    const money = { style: 'currency', currency: 'AUD' } as const;
    expect(numberFormat('en-AU', money)).toBe(numberFormat('en-AU', money));
    expect(numberFormat('en-AU', money)).not.toBe(numberFormat('de-DE', money));
  });
});
