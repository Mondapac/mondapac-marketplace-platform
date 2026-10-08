import { reservedWordsOf } from './reserved-words';
import { claimWordsIn, parseStoreName, storeNameKey } from './store-name';

const RESERVED_WORDS = reservedWordsOf({
  slugs: ['admin', 'api', 'mondapac'],
  claimWords: ['halal', 'official', 'verified'],
});

describe('parseStoreName', () => {
  it('keeps the name as typed and builds the key', () => {
    const result = parseStoreName('  Al  Noor   Grocers ');
    expect(result.ok && result.value.name).toBe('Al  Noor   Grocers');
    expect(result.ok && result.value.key).toBe('al noor grocers');
  });

  it('counts code points: 100 pass, 101 fail, empty fails', () => {
    expect(parseStoreName('a'.repeat(100)).ok).toBe(true);
    expect(parseStoreName('a' + '😀'.repeat(99)).ok).toBe(true);
    for (const text of ['a'.repeat(101), 'a' + '😀'.repeat(100), '', '   ', 7]) {
      expect(parseStoreName(text)).toEqual({
        ok: false,
        error: { code: 'store-name.invalid', rule: 'length' },
      });
    }
  });

  it.each(['a\u0000b', 'a‮b', 'a​b', 'a\nb', 'x⁦y'])(
    'refuses control, bidi and invisible characters in %j',
    (text) => {
      expect(parseStoreName(text)).toEqual({
        ok: false,
        error: { code: 'store-name.invalid', rule: 'characters' },
      });
    },
  );

  it('accepts Persian text with a joining non-joiner', () => {
    expect(parseStoreName('فروشگاه‌من').ok).toBe(true);
  });

  it('makes the NFKC key, so a full-width letter and a ligature match plain letters', () => {
    expect(storeNameKey('ＡＢＣ ﬁsh')).toBe('abc fish');
  });
});

describe('claimWordsIn', () => {
  it('finds claim words per token; a long one also inside the joined name', () => {
    expect(claimWordsIn('Halal  Official-Meats', RESERVED_WORDS)).toEqual(['halal', 'official']);
    expect(claimWordsIn('Halalfoods', RESERVED_WORDS)).toEqual(['halal']);
    expect(claimWordsIn('Fresh Fish', RESERVED_WORDS)).toEqual([]);
  });
});

describe('claimWordsIn: punctuation, accents and look-alikes (Hassan M1)', () => {
  it.each([
    'Halal!',
    'Halal, Meats',
    '(Halal)',
    'Halal.Meats',
    'Halal_Meats',
    "Halal's",
    'Halal/Meats',
    'Halal\u2010Meats',
    'Halal\u2013Meats',
    'HÁLÁL',
    'ＨＡＬＡＬ',
    '\u04bbаlаl',
    'ha1al',
    'H4LAL',
  ])('flags %j', (name) => {
    expect(claimWordsIn(name, RESERVED_WORDS)).toEqual(['halal']);
  });

  it('flags a word at the start or end once, whatever the case, and nothing for an empty list', () => {
    expect(claimWordsIn('Halal Fresh Halal', RESERVED_WORDS)).toEqual(['halal']);
    expect(claimWordsIn('Fresh OFFICIAL', RESERVED_WORDS)).toEqual(['official']);
    expect(claimWordsIn('Halal', reservedWordsOf({ slugs: [], claimWords: [] }))).toEqual([]);
    expect(claimWordsIn('', RESERVED_WORDS)).toEqual([]);
  });
});

describe('parseStoreName: further rules (Hassan L1 to L3, Sajad)', () => {
  it('makes a key that is NFKC-stable and idempotent', () => {
    for (const name of ['H\u0331amid', 'J\u030c', 'T\u0308', 'W\u030a', 'Straße', 'İstanbul']) {
      const key = storeNameKey(name);
      expect(key).toBe(key.normalize('NFKC'));
      expect(storeNameKey(key)).toBe(key);
    }
  });

  it('refuses a name whose key would be too long after NFKC expansion', () => {
    expect(parseStoreName('\ufdfa'.repeat(100))).toEqual({
      ok: false,
      error: { code: 'store-name.invalid', rule: 'length' },
    });
  });

  it.each(['\u2800\u2800\u2800', '\u0301\u0302', '\u3164 x'.slice(0, 1), '---'])(
    'refuses a name with no letter or digit: %j',
    (name) => {
      expect(parseStoreName(name).ok).toBe(false);
    },
  );

  it('counts the length after NFC, and collapses Unicode spaces in the key', () => {
    expect(parseStoreName('e\u0301'.repeat(100)).ok).toBe(true);
    const result = parseStoreName('A\u00a0\u2003B');
    expect(result.ok && result.value.key).toBe('a b');
  });

  it('does not echo the name in an error', () => {
    expect(JSON.stringify(parseStoreName('secret\u0000'))).not.toContain('secret');
  });
});

describe('claimWordsIn: split, joined and stroke forms (Hassan N1, N2)', () => {
  it.each([
    'Ha\u0331lal',
    'Hal\u0336al',
    'HalalMart',
    'H.a.l.a.l',
    'H a l a l',
    'Hałal',
    'ĦALAL',
    'HaIal',
    'Ηalal',
  ])('flags %j', (name) => {
    expect(claimWordsIn(name, RESERVED_WORDS)).toContain('halal');
  });

  it('does not flag honest names', () => {
    for (const name of ['Pure Foods', 'Shop 4 All', 'Allah Bakery', 'Fresh 1', 'Sea Salt 7']) {
      expect(claimWordsIn(name, RESERVED_WORDS)).toEqual([]);
    }
  });
});
