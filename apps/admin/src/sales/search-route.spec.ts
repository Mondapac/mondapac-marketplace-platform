import { describe, expect, it } from 'vitest';
import { isUuid, routeSearch } from './search-route.ts';

const ID = '0190A000-0000-7000-8000-000000000001';

describe('routeSearch', () => {
  it('asks for nothing from an empty box', () => {
    expect(routeSearch('')).toEqual({ kind: 'none' });
    expect(routeSearch('   ')).toEqual({ kind: 'none' });
  });

  it('sends a UUID as q, in any case and with spaces around it trimmed', () => {
    expect(routeSearch(`  ${ID} `)).toEqual({ kind: 'q', value: ID });
    expect(routeSearch(ID.toLowerCase())).toEqual({ kind: 'q', value: ID.toLowerCase() });
    expect(isUuid(ID)).toBe(true);
    expect(isUuid('0190a000')).toBe(false);
  });

  it('sends a name of 2 characters or more as search', () => {
    expect(routeSearch('Al')).toEqual({ kind: 'search', value: 'Al' });
    expect(routeSearch(' Cedar Lane ')).toEqual({ kind: 'search', value: 'Cedar Lane' });
  });

  it('asks for nothing from one character, and says so', () => {
    expect(routeSearch('A')).toEqual({ kind: 'too-short' });
  });

  it('keeps to 80 characters', () => {
    const route = routeSearch('x'.repeat(120));
    expect(route.kind === 'search' && route.value.length).toBe(80);
  });

  it('sends exact text as q as typed, trimmed, spaces inside kept, from one character', () => {
    expect(routeSearch('  AB 12  34 ', { exact: true })).toEqual({ kind: 'q', value: 'AB 12  34' });
    expect(routeSearch('7', { exact: true })).toEqual({ kind: 'q', value: '7' });
    expect(routeSearch('', { exact: true })).toEqual({ kind: 'none' });
  });

  it('sends text with an exact prefix as q (Refunds: re_)', () => {
    const options = { exactPrefixes: ['re_'] };
    expect(routeSearch('re_3Abc', options)).toEqual({ kind: 'q', value: 're_3Abc' });
    expect(routeSearch('rex', options)).toEqual({ kind: 'search', value: 'rex' });
  });
});
