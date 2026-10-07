import { parseEmailAddress } from './email-address';

describe('parseEmailAddress (identity design 11.2; data design 3.3)', () => {
  it('keeps the address as typed, trimmed, and normalises it: trimmed, NFC, lower-cased', () => {
    const parsed = parseEmailAddress('  Customer.One@Example.COM ');

    expect(parsed).toEqual({
      ok: true,
      value: { typed: 'Customer.One@Example.COM', normalized: 'customer.one@example.com' },
    });
  });

  it('composes a decomposed accent (NFC) and folds non-ASCII upper case', () => {
    const parsed = parseEmailAddress('Ze\u0301LIE@EX\u00c4MPLE.de');

    expect(parsed.ok && parsed.value.normalized).toBe('z\u00e9lie@ex\u00e4mple.de');
  });

  it('does no provider-specific rewriting (dots and plus tags stay)', () => {
    const parsed = parseEmailAddress('first.last+shop@gmail.com');

    expect(parsed.ok && parsed.value.normalized).toBe('first.last+shop@gmail.com');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['without @', 'customer.example.com'],
    ['with @ first', '@example.com'],
    ['with @ last', 'customer@'],
    ['with two @', 'a@b@example.com'],
    ['with inner space', 'cus tomer@example.com'],
    ['with a control character', 'customer\u0000@example.com'],
    ['with a newline', 'customer@example.com\nBcc: x@example.com'],
    ['with a bidi override', 'customer\u202e@example.com'],
    ['longer than 254 characters', `${'a'.repeat(250)}@example.com`],
    ['not a string', 42],
  ])('refuses an address %s', (_case, raw) => {
    expect(parseEmailAddress(raw)).toEqual({ ok: false, error: { code: 'email.invalid' } });
  });
});
