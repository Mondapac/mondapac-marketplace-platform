// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatClock } from '../src/format/clock.ts';
import { formatDate } from '../src/format/date.ts';
import { formatMoney } from '../src/format/money.ts';
import { fontClassNames } from '../src/i18n/fonts.ts';
import {
  DEFAULT_LOCALE,
  arrowInReadingOrder,
  directionOf,
  intlLocale,
  languageTag,
  publishedLocales,
  resolveLocale,
} from '../src/i18n/locale.ts';
import { loadMessages } from '../src/i18n/messages.ts';
import en from '../messages/en.json';

describe('request locale', () => {
  it('publishes English alone until a Market publishes more', () => {
    expect(publishedLocales()).toEqual(['en']);
  });

  it('serves guests and unknown profiles in English', () => {
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale('fa')).toBe('en'); // not published today
    expect(resolveLocale('en')).toBe('en');
  });

  it('serves a signed-in buyer in the profile language when the Market published it', () => {
    expect(resolveLocale('fa', ['en', 'fa'])).toBe('fa');
    expect(resolveLocale('ar', ['en', 'ar', 'fa'])).toBe('ar');
    expect(resolveLocale(' AR ', ['en', 'ar'])).toBe('ar');
  });

  it('falls back to English for an unpublished or garbage locale', () => {
    expect(resolveLocale('ar', ['en', 'fa'])).toBe('en');
    expect(resolveLocale('xx-nonsense-123', ['en', 'fa'])).toBe('en');
    expect(resolveLocale('../../etc/passwd', ['en', 'fa'])).toBe('en');
    expect(resolveLocale('<script>', ['en', 'fa'])).toBe('en');
    expect(resolveLocale('fa'.repeat(5000), ['en', 'fa'])).toBe('en');
    expect(DEFAULT_LOCALE).toBe('en');
  });
});

describe('direction', () => {
  it('reads Arabic-script and Hebrew languages right to left', () => {
    for (const locale of ['ar', 'fa', 'he', 'ur', 'ar-EG', 'fa-IR'])
      expect(directionOf(locale)).toBe('rtl');
  });

  it('reads everything else left to right, bad tags included', () => {
    for (const locale of ['en', 'en-AU', 'ms', 'zh-Hant', '', 'not a tag'])
      expect(directionOf(locale)).toBe('ltr');
  });

  it('knows the direction of a locale with extensions', () => {
    expect(directionOf(intlLocale('fa'))).toBe('rtl');
    expect(languageTag(intlLocale('fa'))).toBe('fa');
    expect(languageTag(intlLocale('en'))).toBe('en');
  });

  it('swaps the arrow keys of a right-to-left page and leaves other keys alone', () => {
    const page = document.createElement('div');
    page.dir = 'rtl';
    const tab = document.createElement('button');
    page.append(tab);
    expect(arrowInReadingOrder({ key: 'ArrowRight', currentTarget: tab })).toBe('ArrowLeft');
    expect(arrowInReadingOrder({ key: 'ArrowLeft', currentTarget: tab })).toBe('ArrowRight');
    expect(arrowInReadingOrder({ key: 'Home', currentTarget: tab })).toBe('Home');
    const plain = document.createElement('button');
    expect(arrowInReadingOrder({ key: 'ArrowRight', currentTarget: plain })).toBe('ArrowRight');
  });
});

describe('Latin digits and the Gregorian calendar in every language', () => {
  const money = { amount: 123456, currency: 'AUD' };

  it('formats money with Latin digits', () => {
    for (const locale of ['en', 'ar', 'fa', 'ar-EG']) {
      const text = formatMoney(money, locale);
      expect(text, locale).toMatch(/1.?234.?56/);
      expect(text, locale).not.toMatch(/[٠-٩۰-۹]/);
    }
    expect(formatMoney({ amount: 1000, currency: 'AUD' }, 'fa', { whole: true })).not.toMatch(
      /[۰-۹]/,
    );
  });

  it('formats a date in the Gregorian calendar with Latin digits', () => {
    const fa = formatDate('2026-10-19', 'fa', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });
    expect(fa).toContain('2026');
    expect(fa).not.toMatch(/[۰-۹٠-٩]/);
    // Persian calendar year 1405 would be shown without the override.
    expect(fa).not.toContain('1405');
    expect(formatDate('2026-10-19', 'ar', { dateStyle: 'medium' })).toContain('2026');
    expect(
      formatDate('2026-10-19', 'en', { day: 'numeric', month: 'short', year: 'numeric' }),
    ).toBe('Oct 19, 2026');
  });

  it('formats clock times with Latin digits', () => {
    expect(formatClock('14:30', 'fa', 'midnight')).not.toMatch(/[۰-۹٠-٩]/);
    expect(formatClock('14:30', 'en', 'midnight')).toBe('2:30 PM');
  });

  it('keeps the numbering system and calendar through the Intl locale', () => {
    const resolved = new Intl.NumberFormat(intlLocale('ar')).resolvedOptions();
    expect(resolved.numberingSystem).toBe('latn');
    expect(new Intl.DateTimeFormat(intlLocale('fa')).resolvedOptions().calendar).toBe('gregory');
    expect(new Intl.NumberFormat(intlLocale('en')).format(1234.5)).toBe('1,234.5');
  });
});

describe('message catalogues', () => {
  it('serves English for English and for a language without a catalogue', async () => {
    expect(await loadMessages('en')).toBe(en);
    expect(await loadMessages('fa')).toEqual(en);
  });

  it('lays a catalogue over English key by key', async () => {
    const title = (en as { store: { title: string } }).store.title;
    const messages = (await loadMessages('fa', () =>
      Promise.resolve({ store: { title: 'translated' } }),
    )) as { store: { title: string; description: string } };
    expect(messages.store.title).toBe('translated');
    expect(messages.store.description).toBe(
      (en as { store: { description: string } }).store.description,
    );
    expect(title).not.toBe('translated');
  });
});

describe('script fonts', () => {
  it('adds no script font for English or a Latin language', () => {
    expect(fontClassNames('en')).toBe('figtree-var jakarta-var');
    expect(fontClassNames('en-AU')).toBe('figtree-var jakarta-var');
  });

  it('adds Vazirmatn for Persian and Noto Sans Arabic for Arabic', () => {
    expect(fontClassNames('fa')).toBe('figtree-var jakarta-var vazirmatn-var');
    expect(fontClassNames('ar')).toBe('figtree-var jakarta-var noto-arabic-var');
  });
});
