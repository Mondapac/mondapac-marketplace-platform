import type { CertificationTypeCode } from './claim-types';
import {
  compactForm,
  matchClaimTerms,
  normaliseClaimText,
  prepareVocabulary,
  tokenise,
} from './claim-text-matcher';
import type { ClaimVocabularyEntry } from './claim-text-matcher';

const code = (s: string): CertificationTypeCode => s as CertificationTypeCode;

// AU-like vocabulary: terms of every locale of the Market are applied to every text.
const AU: ClaimVocabularyEntry[] = [
  { typeCode: code('halal'), terms: ['halal', 'حلال', 'halal certified'] },
  { typeCode: code('kosher'), terms: ['kosher', 'כשר'] },
  { typeCode: code('vegan'), terms: ['vegan'] },
];
// ZZ: a synthetic Market with different types, words and script.
const ZZ: ClaimVocabularyEntry[] = [
  { typeCode: code('zed-pure'), terms: ['zedpure', 'зед чисто'] },
  { typeCode: code('zed-green'), terms: ['green leaf'] },
];

const run = (vocab: ClaimVocabularyEntry[], text: string) =>
  matchClaimTerms([text], prepareVocabulary(vocab))[0]!.map((m) => `${m.typeCode}:${m.pass}`);

describe('claim text matcher', () => {
  describe('token pass', () => {
    it('matches a whole token with a span, case-insensitively', () => {
      const [m] = matchClaimTerms(['Fresh HALAL chicken'], prepareVocabulary(AU))[0]!;
      expect(m).toEqual({
        typeCode: 'halal',
        pass: 'token',
        span: { fromToken: 1, toToken: 1 },
      });
    });

    it('matches a multi-token phrase and splits tokens on punctuation', () => {
      expect(run(AU, 'Halal, certified!')).toEqual(['halal:token']);
      const [m] = matchClaimTerms(['xx halal-certified'], prepareVocabulary([AU[0]!]))[0]!;
      expect(m!.pass).toBe('token');
    });

    it('does not match a word that only contains the term (token pass)', () => {
      // "vegano" is not a token match; the compact pass is the one that may flag it.
      const m = matchClaimTerms(['vegano'], prepareVocabulary(AU))[0]!;
      expect(m.map((x) => `${x.typeCode}:${x.pass}`)).toEqual(['vegan:compact']);
    });

    it('returns an empty answer for text with no claim word, per text in order', () => {
      expect(
        matchClaimTerms(['Fresh bread', 'Kosher bread'], prepareVocabulary(AU)).map(
          (r) => r.length,
        ),
      ).toEqual([0, 1]);
    });
  });

  describe('normalisation (M8)', () => {
    it('folds width, case and compatibility forms (NFKC)', () => {
      expect(run(AU, 'ＨＡＬＡＬ')).toEqual(['halal:token']);
      expect(run(AU, 'ℌalal')).toEqual(['halal:token']);
    });

    it('removes zero-width, joiner and bidi characters', () => {
      expect(run(AU, 'ha​lal')).toEqual(['halal:token']);
      expect(run(AU, 'h‍alal')).toEqual(['halal:token']);
      expect(run(AU, '‮halal‬')).toEqual(['halal:token']);
    });

    it('removes combining marks and tatweel', () => {
      expect(run(AU, 'ha̶l̶al')).toEqual(['halal:token']);
      expect(run(AU, 'حَلَال')).toEqual(['halal:token']);
      expect(run(AU, 'حـلال')).toEqual(['halal:token']);
    });

    it('sees through look-alike letters (Cyrillic, Greek) and a capital I for an l', () => {
      expect(run(AU, 'hаlаl')).toEqual(['halal:token']); // Cyrillic а
      expect(run(AU, 'hαlαl')).toEqual(['halal:token']); // Greek α
      expect(run(AU, 'HaIaI')).toEqual(['halal:token']); // capital I
      expect(run(AU, 'kоsher')).toEqual(['kosher:token']);
    });

    it('sees through capital Greek and Cyrillic, small capitals, barred letters (Hassan)', () => {
      expect(run(AU, 'ΗALAL')).toEqual(['halal:token']);
      expect(run(AU, 'VEGAΝ')).toEqual(['vegan:token']);
      expect(run(AU, 'ʜᴀʟᴀʟ')).toEqual(['halal:token']);
      expect(run(AU, 'hałal')).toEqual(['halal:token']);
      expect(run(AU, 'ΗΑLΑL')).toEqual(['halal:token']);
    });

    it('matches capitals-only text for terms containing i (the I rule must not split them)', () => {
      const organic = [{ typeCode: code('organic'), terms: ['organic', 'organic certified'] }];
      expect(run(organic, 'ORGANIC')).toEqual(['organic:token']);
      expect(run(organic, 'Organic Certified')).toEqual(['organic:token']);
      expect(run(AU, 'HALAL CERTIFIED')).toEqual(['halal:token']);
      expect(run(organic, 'ORGANlC')).toEqual(['organic:token']);
      expect(run(organic, 'orgаnіc')).toEqual(['organic:token']); // Cyrillic а and і
    });

    it('maps squared letters', () => {
      expect(run(AU, '🅷🅰🅻🅰🅻')).toEqual(['halal:token']);
    });

    it('maps other-script digits and regional indicators', () => {
      expect(run(AU, 'ha१al')).toEqual(['halal:compact']); // Devanagari 1
      expect(run(AU, '🇭🇦🇱🇦🇱')).toEqual(['halal:token']);
    });

    it('treats Arabic and Persian letter variants as one', () => {
      expect(run([{ typeCode: code('t'), terms: ['حلالی'] }], 'حلالي')).toEqual(['t:token']);
    });

    it('is idempotent', () => {
      const once = normaliseClaimText('ＨаIа​l');
      expect(normaliseClaimText(once)).toBe(once);
    });
  });

  describe('second pass: separators removed, digits to letters', () => {
    it('catches separated letters', () => {
      expect(run(AU, 'h-a-l-a-l')).toEqual(['halal:compact']);
      expect(run(AU, 'h a l a l')).toEqual(['halal:compact']);
      expect(run(AU, 'h.a.l.a.l')).toEqual(['halal:compact']);
    });

    it('catches digit and symbol substitutions', () => {
      expect(run(AU, 'ha1al')).toEqual(['halal:compact']);
      expect(run(AU, 'h4l4l')).toEqual(['halal:compact']);
      expect(run(AU, 'k0sher')).toEqual(['kosher:compact']);
      expect(run(AU, 'v3gan')).toEqual(['vegan:compact']);
      expect(run(AU, 'h@l@l')).toEqual(['halal:compact']);
    });

    it('catches Arabic-Indic digits in a mixed text', () => {
      expect(run(AU, 'ha١al')).toEqual(['halal:compact']);
    });

    it('catches symbol, emoji, enclosing-mark and modifier separators (Hassan)', () => {
      for (const text of [
        'h★a★l★a★l',
        'h~a~l~a~l',
        'h+a+l+a+l',
        'h`a`l`a`l',
        'h🍖a🍖l🍖a🍖l',
        'h\u20ddalal',
        'ha\u02bblal',
      ]) {
        expect([text, run(AU, text).length > 0]).toEqual([text, true]);
      }
    });

    it('catches the extra leet digits and the exclamation mark', () => {
      expect(run(AU, 've9an')).toEqual(['vegan:compact']);
      expect(run(AU, 've6an')).toEqual(['vegan:compact']);
      expect(run(AU, 'ha!a!')).toEqual(['halal:compact']);
    });

    it('prefers the token pass when both would match', () => {
      expect(run(AU, 'halal')).toEqual(['halal:token']);
    });

    it('is deliberately over-inclusive (fail closed): a word containing a term is flagged', () => {
      expect(run(AU, 'shalalan')).toEqual(['halal:compact']);
    });
  });

  describe('cross-locale and two Markets', () => {
    it('applies the terms of every locale to every text', () => {
      expect(run(AU, 'منتج حلال')).toEqual(['halal:token']);
      expect(run(AU, 'כשר')).toEqual(['kosher:token']);
    });

    it('works on a synthetic Market vocabulary with a different script', () => {
      expect(run(ZZ, 'Зед Чисто shop')).toEqual(['zed-pure:token']);
      expect(run(ZZ, 'ZedPure')).toEqual(['zed-pure:token']);
      expect(run(ZZ, 'green leaf tea')).toEqual(['zed-green:token']);
      expect(run(ZZ, 'halal')).toEqual([]); // AU words mean nothing to ZZ
    });

    it('applies the compact pass, leet, look-alikes and ignorables on the ZZ vocabulary', () => {
      expect(run(ZZ, 'зед-чисто')).toEqual(['zed-pure:token']);
      expect(run(ZZ, 'z3dpure')).toEqual(['zed-pure:compact']);
      expect(run(ZZ, 'zеdрure')).toEqual(['zed-pure:token']); // Cyrillic е and р
      expect(run(ZZ, 'зе\u200bд чисто')).toEqual(['zed-pure:token']);
      expect(run(ZZ, 'g r e e n-l e a f')).toEqual(['zed-green:compact']);
    });

    it('answers several types for one text', () => {
      expect(run(AU, 'halal and vegan').sort()).toEqual(['halal:token', 'vegan:token']);
    });
  });

  describe('faults fail closed', () => {
    it('throws for a text over the cap', () => {
      expect(() => matchClaimTerms(['a'.repeat(20_001)], prepareVocabulary(AU))).toThrow(
        RangeError,
      );
    });

    it('throws when NFKC growth exceeds the cap, and for too many texts', () => {
      expect(() => matchClaimTerms(['ﷺ'.repeat(5_000)], prepareVocabulary(AU))).toThrow(RangeError);
      expect(() =>
        matchClaimTerms(
          Array.from({ length: 101 }, () => 'x'),
          prepareVocabulary(AU),
        ),
      ).toThrow(RangeError);
    });

    it('accepts exactly the caps (20000 characters, 100 texts)', () => {
      const vocab = prepareVocabulary(AU);
      expect(() => matchClaimTerms(['a'.repeat(20_000)], vocab)).not.toThrow();
      expect(() =>
        matchClaimTerms(
          Array.from({ length: 100 }, () => 'x'),
          vocab,
        ),
      ).not.toThrow();
    });

    it('handles empty inputs: empty text, empty vocabulary, no texts', () => {
      expect(run(AU, '')).toEqual([]);
      expect(run([], 'halal')).toEqual([]);
      expect(matchClaimTerms([], prepareVocabulary(AU))).toEqual([]);
      expect(run([{ typeCode: code('x'), terms: [] }], 'halal')).toEqual([]);
    });

    it('throws for a term with no matchable content', () => {
      expect(() => prepareVocabulary([{ typeCode: code('x'), terms: ['  - '] }])).toThrow(
        RangeError,
      );
      expect(() => prepareVocabulary([{ typeCode: code('x'), terms: [''] }])).toThrow(RangeError);
    });

    it('tokenise and compactForm are plain helpers', () => {
      expect(tokenise('a-b  c')).toEqual(['a', 'b', 'c']);
      expect(compactForm('h-4')).toBe('ha');
    });
  });
});
