import { englishLocaleOf } from './english-locale';

describe('englishLocaleOf', () => {
  it('keeps an English default locale (AU)', () => {
    expect(englishLocaleOf({ default: 'en-AU', supported: ['en-AU'] })).toBe('en-AU');
  });

  it('picks the first supported English locale when the default is not English (ZZ)', () => {
    expect(englishLocaleOf({ default: 'ja-JP', supported: ['ja-JP', 'en-US'] })).toBe('en-US');
  });

  it('falls back to the default locale when the market supports no English', () => {
    expect(englishLocaleOf({ default: 'ja-JP', supported: ['ja-JP'] })).toBe('ja-JP');
  });

  it('does not mistake a tag that only starts with "en" for English', () => {
    expect(englishLocaleOf({ default: 'ja-JP', supported: ['enx-XX', 'EN-gb'] })).toBe('EN-gb');
  });
});
