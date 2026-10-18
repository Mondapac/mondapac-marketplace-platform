import { parseDisplayName, shortDisplayName } from './display-name';

describe('parseDisplayName (identity design 2.1, HF13; data design 3.3)', () => {
  it.each([
    ['a plain name', 'Customer One', 'Customer One'],
    ['outer spaces, trimmed', '  Aisha Rahman  ', 'Aisha Rahman'],
    ['Arabic script', 'عائشة الرحمن', 'عائشة الرحمن'],
    ['accents', 'Zoë Ñúñez', 'Zoë Ñúñez'],
    ['a zero-width joiner', 'क्\u200dष', 'क्\u200dष'],
    ['initials with dots and spaces', 'J. R. R. Smith', 'J. R. R. Smith'],
    ['an apostrophe and a hyphen', "O'Neil-Brown", "O'Neil-Brown"],
    ['exactly 100 characters', 'n'.repeat(100), 'n'.repeat(100)],
  ])('accepts %s', (_case, raw, name) => {
    expect(parseDisplayName(raw)).toEqual({ ok: true, value: name });
  });

  it('counts characters as code points: 100 emoji pass, 101 do not', () => {
    expect(parseDisplayName('😀'.repeat(100)).ok).toBe(true);
    expect(parseDisplayName('😀'.repeat(101)).ok).toBe(false);
  });

  it.each([
    ['empty', '', 'length'],
    ['blank', '   ', 'length'],
    ['101 characters', 'n'.repeat(101), 'length'],
    ['a tab', 'Customer\tOne', 'characters'],
    ['a newline', 'Customer\nOne', 'characters'],
    ['DEL', 'Customer\u007fOne', 'characters'],
    ['NEL (C1)', 'Customer\u0085One', 'characters'],
    ['a right-to-left override', 'Customer\u202eOne', 'characters'],
    ['a left-to-right isolate', 'Customer\u2066One', 'characters'],
    ['a right-to-left mark', 'Customer\u200fOne', 'characters'],
    ['an Arabic letter mark', 'Customer\u061cOne', 'characters'],
    ['a URL with a scheme', 'visit https://phish.example', 'characters'],
    ['a www host', 'www.phish', 'characters'],
    ['a bare domain', 'Buy at phish.example.com now', 'characters'],
    ['not a string', 7, 'length'],
  ])('refuses %s', (_case, raw, rule) => {
    expect(parseDisplayName(raw)).toEqual({
      ok: false,
      error: { code: 'display-name.invalid', rule },
    });
  });
});

describe('shortDisplayName (seller order notices, john 2026-10-17)', () => {
  it.each([
    ['no name', null, null],
    ['a blank name', '   ', null],
    ['one word', 'Maryam', 'Maryam'],
    ['two words', 'Maryam Rahimi', 'Maryam R.'],
    ['three words, the last initial', 'Maryam Sadat Rahimi', 'Maryam R.'],
    ['a lower-case last word', 'maryam rahimi', 'maryam R.'],
    ['Arabic script', 'عائشة الرحمن', 'عائشة ا.'],
    ['an accented initial', 'Zoë Ñúñez', 'Zoë Ñ.'],
    ['initials', 'J. R. R. Smith', 'J. S.'],
    ['a long first word, cut', `${'n'.repeat(40)} Smith`, `${'n'.repeat(30)} S.`],
  ])('%s', (_case, name, short) => {
    expect(shortDisplayName(name)).toBe(short);
  });

  it('keeps a whole grapheme as the initial', () => {
    expect(shortDisplayName('Ana émile')).toBe('Ana É.');
  });
});
