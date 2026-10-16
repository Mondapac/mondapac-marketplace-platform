import { describe, expect, it } from 'vitest';
import { formatInstant, shortInstant } from '../catalog/format.ts';
import { exponentOf, formatMinor } from '../price/money.ts';
import { formatInZone, instantOfZoned } from '../price/zone-time.ts';
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
      expect(shortInstant('nope', locale)).toBe('-');
    }
  });

  it('writes a short instant with the year only when it is not this one', () => {
    const lastYear = `${new Date().getUTCFullYear() - 1}-10-09T23:30:00.000Z`;
    expect(shortInstant(lastYear, AU.locale)).toContain(String(new Date().getUTCFullYear() - 1));
    expect(shortInstant(lastYear, DE.locale)).toMatch(/^9\. Okt\.? \d{4}, 23:30 UTC$/);
    const thisYear = `${new Date().getUTCFullYear()}-10-09T23:30:00.000Z`;
    expect(shortInstant(thisYear, AU.locale)).not.toMatch(/\d{4}/);
  });

  it('formats minor units in the Market currency and locale', () => {
    expect(formatMinor('1999', AU.currency, AU.locale)).toBe('$19.99');
    expect(formatMinor('123450', DE.currency, DE.locale)).toMatch(/^1\.234,50\s€$/);
  });

  it('reads the currency exponent from the currency, not the locale', () => {
    expect(exponentOf('AUD')).toBe(2);
    expect(exponentOf('JPY')).toBe(0);
  });

  it('shows an instant in a zone under each locale, with its short name', () => {
    expect(formatInZone('2026-10-31T23:30:00Z', 'Australia/Sydney', AU.locale)).toMatch(
      /^1 Nov 2026, 10:30\s?am AEDT$/i,
    );
    expect(formatInZone('2026-10-31T23:30:00Z', 'Europe/Berlin', DE.locale)).toBe(
      '01.11.2026, 00:30 MEZ',
    );
    expect(formatInZone(null, 'UTC', DE.locale)).toBe('-');
  });

  it('reads wall-clock input the same whatever the Market locale is', () => {
    expect(instantOfZoned('2026-10-20T01:00', 'Australia/Sydney')).toBe('2026-10-19T14:00:00Z');
    expect(instantOfZoned('2026-10-20T01:00', 'Europe/Berlin')).toBe('2026-10-19T23:00:00Z');
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

  describe('in the seller zone', () => {
    const at = '2026-10-09T23:30:00.000Z';

    it('shows an instant in a non-UTC zone with its short name, under each Market', () => {
      expect(formatInstant(at, AU.locale, 'Australia/Brisbane')).toMatch(
        /^10 Oct 2026, 9:30\s?am AEST$/i,
      );
      // Synthetic second Market: another locale and zone.
      expect(formatInstant(at, DE.locale, 'Pacific/Auckland')).toMatch(
        /^10\.10\.2026, 12:30 (NZDT|Pacific\/Auckland)$/,
      );
      expect(shortInstant(at, AU.locale, 'Australia/Brisbane')).toMatch(
        /^10 Oct.*9:30\s?am AEST$/i,
      );
    });

    it('follows the zone across the date line and a DST change', () => {
      // Same instant is on three different days around the date line.
      expect(formatInstant('2026-12-31T11:30:00Z', AU.locale, 'Pacific/Kiritimati')).toMatch(
        /^1 Jan 2027, 1:30\s?am/i,
      );
      expect(formatInstant('2026-12-31T11:30:00Z', AU.locale, 'Pacific/Pago_Pago')).toMatch(
        /^31 Dec 2026, 12:30\s?am/i,
      );
      // Sydney clocks go forward on 2026-10-04 at 2 am: 15:59Z is 1:59 am, 16:00Z is 3:00 am.
      expect(formatInstant('2026-10-03T15:59:00Z', AU.locale, 'Australia/Sydney')).toMatch(
        /^4 Oct 2026, 1:59\s?am/i,
      );
      expect(formatInstant('2026-10-03T16:00:00Z', AU.locale, 'Australia/Sydney')).toMatch(
        /^4 Oct 2026, 3:00\s?am/i,
      );
    });

    it('decides "this year" in the seller zone, not in UTC', () => {
      const year = new Date().getUTCFullYear();
      // 23:30Z on 31 Dec is already next year in Auckland.
      expect(shortInstant(`${year}-12-31T23:30:00Z`, AU.locale, 'Pacific/Auckland')).toContain(
        String(year + 1),
      );
      expect(shortInstant(`${year}-12-31T23:30:00Z`, AU.locale, 'UTC')).not.toMatch(/\d{4}/);
    });

    it('labels with the IANA id where Intl only has an offset, never GMT+n', () => {
      expect(formatInstant(at, AU.locale, 'America/Sao_Paulo')).toMatch(
        /8:30\s?pm America\/Sao_Paulo$/i,
      );
      expect(formatInstant(at, AU.locale, 'Asia/Dubai')).toMatch(/3:30\s?am Asia\/Dubai$/i);
      expect(shortInstant(at, AU.locale, 'Asia/Dubai')).toMatch(/Asia\/Dubai$/);
      expect(formatInZone(at, 'Asia/Dubai', AU.locale)).toMatch(/Asia\/Dubai$/);
    });

    it('falls back to UTC, labelled UTC, when the zone is missing or unknown', () => {
      for (const zone of [undefined, null, '', 'Not/AZone']) {
        expect(formatInstant(at, AU.locale, zone)).toMatch(/^9 Oct 2026, 11:30\s?pm UTC$/i);
        expect(shortInstant(at, AU.locale, zone)).toMatch(/^9 Oct.*11:30\s?pm UTC$/i);
      }
    });
  });
});
