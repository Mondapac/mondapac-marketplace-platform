import {
  BUSINESS_NAME_MAX_LENGTH,
  CONTACT_EMAIL_MAX_LENGTH,
  parseBusinessName,
  parseContactEmail,
  parsePhone,
} from './draft-fields';

describe('parseBusinessName', () => {
  it('keeps the name as typed after trimming and NFC', () => {
    expect(parseBusinessName('  Al Noor Pty Ltd ')).toEqual({ ok: true, value: 'Al Noor Pty Ltd' });
    expect(parseBusinessName('Cafe\u0301 Ltd')).toEqual({ ok: true, value: 'Café Ltd' });
  });

  it('accepts 1 to 200 characters and refuses more', () => {
    expect(parseBusinessName('A').ok).toBe(true);
    expect(parseBusinessName('a'.repeat(BUSINESS_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseBusinessName('a'.repeat(BUSINESS_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: 'length',
    });
    expect(parseBusinessName('   ')).toEqual({ ok: false, error: 'length' });
  });

  it.each([
    ['a control character', 'Al\u0001Noor'],
    ['a line feed', 'Al\nNoor'],
    ['a bidi override', 'Al\u202eNoor'],
    ['a default-ignorable character', 'Al\u2060Noor'],
    ['only invisible marks', '\u0301\u0301'],
    ['a non-string', 42],
  ])('refuses %s', (_label, raw) => {
    expect(parseBusinessName(raw)).toEqual({ ok: false, error: 'characters' });
  });
});

describe('parsePhone', () => {
  it('normalises spaces, hyphens, dots and brackets away and keeps a leading plus', () => {
    expect(parsePhone(' +61 (7) 3000-0000 ')).toEqual({ ok: true, value: '+61730000000' });
    expect(parsePhone('090.1234.5678')).toEqual({ ok: true, value: '09012345678' });
  });

  it.each(['', '   ', '12', 'abc', '+61 7 3000 000x', '1+2345', '+'.repeat(2) + '12345'])(
    'refuses %j',
    (raw) => {
      expect(parsePhone(raw).ok).toBe(false);
    },
  );

  it('refuses more than 32 characters before or after normalisation', () => {
    expect(parsePhone('1'.repeat(32)).ok).toBe(false); // more digits than any number has
    expect(parsePhone(`07${' '.repeat(200)}30000000`)).toEqual({ ok: false, error: 'length' });
  });
});

describe('parseContactEmail', () => {
  it('accepts an address, trimmed, as typed', () => {
    expect(parseContactEmail(' Shop@Example.com ')).toEqual({
      ok: true,
      value: 'Shop@Example.com',
    });
  });

  it.each([
    '',
    'shop',
    'shop@',
    '@example.com',
    'sh op@example.com',
    'a@b@example.com',
    'a@example',
  ])('refuses %j', (raw) => {
    expect(parseContactEmail(raw).ok).toBe(false);
  });

  it('refuses more than 254 characters and hidden characters', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(CONTACT_EMAIL_MAX_LENGTH - 64 - 5)}.com`;
    expect(long.length).toBe(CONTACT_EMAIL_MAX_LENGTH);
    expect(parseContactEmail(long).ok).toBe(true);
    expect(parseContactEmail(`a${long}`)).toEqual({ ok: false, error: 'length' });
    expect(parseContactEmail('sh\u200bop@example.com')).toEqual({
      ok: false,
      error: 'characters',
    });
  });
});
