import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES } from './country-codes.ts';

describe('the origin country list', () => {
  it('holds each ISO 3166-1 alpha-2 code once, and every code has a country name', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect(COUNTRY_CODES).toHaveLength(249);
    for (const code of COUNTRY_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(names.of(code)).not.toBe(code);
    }
  });
});
