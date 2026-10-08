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
    expect(parseStoreName('😀'.repeat(100)).ok).toBe(true);
    for (const text of ['a'.repeat(101), '😀'.repeat(101), '', '   ', 7]) {
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
  it('finds claim words per token and never as substrings', () => {
    expect(claimWordsIn('Halal  Official-Meats', RESERVED_WORDS)).toEqual(['halal', 'official']);
    expect(claimWordsIn('Halalfoods', RESERVED_WORDS)).toEqual([]);
    expect(claimWordsIn('Fresh Fish', RESERVED_WORDS)).toEqual([]);
  });
});
