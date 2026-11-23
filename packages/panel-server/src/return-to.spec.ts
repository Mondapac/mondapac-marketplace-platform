import { describe, expect, it } from 'vitest';
import { safeReturnTo, withReturnTo } from './return-to.ts';

describe('safeReturnTo', () => {
  it.each([
    ['/orders', '/orders'],
    ['/catalog/products?view=draft&page=2', '/catalog/products?view=draft&page=2'],
    ['/orders#row-3', '/orders'],
    ['/a/../orders', '/orders'],
  ])('keeps a path of the panel: %s', (raw, kept) => {
    expect(safeReturnTo(raw)).toBe(kept);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['home', '/'],
    ['relative', 'orders'],
    ['absolute URL', 'https://evil.example/orders'],
    ['scheme', 'javascript:alert(1)'],
    ['protocol-relative', '//evil.example/orders'],
    ['backslash', '/\\evil.example'],
    ['backslash later', '/orders\\..\\x'],
    ['tab', '/\t/evil.example'],
    ['newline', '/orders\r\nset-cookie: x=1'],
    ['too long', `/${'a'.repeat(600)}`],
    ['sign-in', '/sign-in?next=/orders'],
    ['session-ended', '/session-ended'],
    ['relay', '/api/identity/admin/session'],
    ['next internals', '/_next/static/x.js'],
    ['dot segments out to sign-in', '/orders/../sign-in'],
    ['reset password', '/reset-password'],
    ['dot segment then empty segment', '/.//evil.com'],
    ['parent segment then empty segment', '/a/..//evil.com'],
    ['encoded parent segment then empty segment', '/x/%2e%2e//evil.com'],
    ['several dot segments', '/././/evil.com/x?y=1'],
  ])('drops %s', (_name, raw) => {
    expect(safeReturnTo(raw)).toBeNull();
  });

  it('drops the flight marker of a client navigation', () => {
    expect(safeReturnTo('/orders?_rsc=abc12&view=late')).toBe('/orders?view=late');
    expect(safeReturnTo('/orders?_rsc=abc12')).toBe('/orders');
  });

  it('does not treat a path that only starts like an excluded one as excluded', () => {
    expect(safeReturnTo('/apis')).toBe('/apis');
  });
});

describe('withReturnTo', () => {
  it('adds the encoded path as next', () => {
    expect(withReturnTo('/sign-in', '/orders?view=late')).toBe(
      '/sign-in?next=%2Forders%3Fview%3Dlate',
    );
  });

  it('joins an existing query with &', () => {
    expect(withReturnTo('/sign-in?notice=session-ended', '/orders')).toBe(
      '/sign-in?notice=session-ended&next=%2Forders',
    );
  });

  it('leaves the target alone when the path is not safe or is home', () => {
    expect(withReturnTo('/sign-in', '//evil.example')).toBe('/sign-in');
    expect(withReturnTo('/sign-in', '/')).toBe('/sign-in');
    expect(withReturnTo('/sign-in', null)).toBe('/sign-in');
  });
});
