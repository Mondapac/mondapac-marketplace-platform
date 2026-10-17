import type { CertificationTypeCode } from './claim-types';
import {
  compactForm,
  latinContextFold,
  matchClaimTerms,
  normaliseClaimText,
  prepareVocabulary,
  tokenise,
} from './claim-text-matcher';
import type { ClaimVocabularyEntry } from './claim-text-matcher';
import { UTS39_CONFUSABLES } from './generated/uts39-confusables';

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

    it('sees through the look-alikes the interim table missed (issue #133, Hassan PR 132)', () => {
      for (const text of ['haɩal', 'haɨal', 'HAƗAL', 'haƚal', 'haɫal', 'haɭal']) {
        expect([text, run(AU, text)]).toEqual([text, ['halal:token']]);
      }
      expect(run(AU, 'haᎥal')).toEqual(['halal:token']); // Cherokee i
      expect(run(AU, 'HAᏞAL')).toEqual(['halal:token']); // Cherokee L
      expect(run(AU, 'Ꮋalal')).toEqual(['halal:token']); // Cherokee H
      expect(run(AU, 'ꮋalal')).toEqual(['halal:token']); // Cherokee small h
      expect(run(AU, 'ha¡al')).toEqual(['halal:compact']); // inverted exclamation, leet map
    });

    it('applies the full UTS #39 table: mathematical, circled and other rarer letters', () => {
      expect(run(AU, '𝐡𝐚𝐥𝐚𝐥')).toEqual(['halal:token']);
      expect(run(AU, '𝖍𝖆𝖑𝖆𝖑')).toEqual(['halal:token']);
      expect(run(AU, 'ⓗⓐⓛⓐⓛ')).toEqual(['halal:token']);
      expect(run(AU, 'hɑlɑl')).toEqual(['halal:token']);
      expect(run(AU, 'ħalal')).toEqual(['halal:token']);
      expect(run(AU, 'ᴋosher')).toEqual(['kosher:token']);
      expect(run(ZZ, 'ƶedpure')).toEqual(['zed-pure:token']);
    });

    it('reads capital look-alikes before lower-casing (Hassan B1 on PR 378)', () => {
      for (const text of ['ᏦOSHER', 'ⲔOSHER', 'ᏦᎾᏚᎻᎬᏒ']) {
        expect([text, run(AU, text)]).toEqual([text, ['kosher:token']]);
      }
      const msc = [
        { typeCode: code('msc'), terms: ['msc'] },
        { typeCode: code('gmo-free'), terms: ['gmo free'] },
        { typeCode: code('organic'), terms: ['organic'] },
      ];
      expect(run(msc, 'ᎷSC')).toEqual(['msc:token']);
      expect(run(msc, 'ⲘSC')).toEqual(['msc:token']);
      expect(run(msc, 'GᎷO FREE')).toEqual(['gmo-free:token']);
      expect(run(msc, 'orga∩ic')).toEqual(['organic:token']);
      expect(run(AU, 'vega∩')).toEqual(['vegan:token']);
    });

    it('gives a letter and its other case one skeleton (a case edit changes nothing)', () => {
      expect(normaliseClaimText('ЗЕД ЧИСТО')).toBe(normaliseClaimText('зед чисто'));
      expect(normaliseClaimText('ᏦOSHER')).toBe(normaliseClaimText('ꮶosher'));
    });

    it('reads an Arabic letter between Latin letters as its Latin look-alike (Hassan S1)', () => {
      expect(run(AU, 'haاal')).toEqual(['halal:token']);
      expect(run(AU, 'HAﺍAL')).toEqual(['halal:token']);
      expect(run(AU, 'kهsher')).toEqual(['kosher:token']);
      expect(run(AU, 'حلال')).toEqual(['halal:token']); // Arabic words keep their own folds
    });

    it('reads non-ASCII digits as the letters they look like too (Hassan S2)', () => {
      expect(run(AU, 'k٥sher')).toEqual(['kosher:token']);
      expect(run(AU, 'k۵sher')).toEqual(['kosher:token']);
      expect(run(AU, '٧egan')).toEqual(['vegan:token']);
    });

    it('folds the Greek lunate sigmas to c before NFKC (Hassan S3)', () => {
      const organic = [{ typeCode: code('organic'), terms: ['organic certified'] }];
      expect(run(organic, 'ORGANIϹ ϹERTIFIED')).toEqual(['organic:token']);
      expect(run(organic, 'organiϲ certified')).toEqual(['organic:token']);
    });

    it('leaves ASCII and the Arabic script to the curated tables', () => {
      // UTS maps `0` to O, `%` to letters and `m` to `rn`; the token pass keeps them as written.
      expect(normaliseClaimText('100% ham')).toBe('100% ham');
      // UTS maps alef to `l` and heh to `o`: Arabic stays Arabic, so no Latin term meets it.
      expect(normaliseClaimText('حلال الله')).toBe('حلال الله');
      expect(run(AU, 'Grass-fed beef, made in Melbourne')).toEqual([]);
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
      // The visual reading of the digit (١ looks like l) matches in the token pass (Hassan S2).
      expect(run(AU, 'ha١al')).toEqual(['halal:token']);
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

// Arabic-script corpus for «حلال» (mini-review 2026-10-14, C1 to C3). The AU vocabulary above
// holds the term; every case runs against the real normaliser and both passes.
describe('claim text matcher: Arabic-script corpus', () => {
  const halal = (text: string): boolean => run(AU, text).some((m) => m.startsWith('halal:'));

  it('matches dagger alef, with and without other marks (C1)', () => {
    expect(halal('حَلَٰلًا طَيِّبًا')).toBe(true);
    expect(halal('حلٰل')).toBe(true);
  });

  it('folds the variants of C2, one case each', () => {
    expect(halal('حل١ل')).toBe(true); // Arabic-Indic one between Arabic letters
    expect(halal('حل۱ل')).toBe(true); // Persian one
    expect(halal('حڵال')).toBe(true); // U+06B5
    expect(halal('حڷال')).toBe(true); // U+06B7
    expect(halal('حڸال')).toBe(true); // U+06B8
    expect(halal('حلٲل')).toBe(true); // U+0672
    expect(halal('حلٳل')).toBe(true); // U+0673
    expect(halal('حلٵل')).toBe(true); // U+0675
  });

  it('folds a stroke between Arabic letters however it is written or hidden (Hassan M1)', () => {
    for (const stroke of ['١', '۱', '1', 'l', 'I', '|', '１', '𝟏', 'ǀ', 'ⅼ']) {
      expect(halal(`حل${stroke}ل`)).toBe(true);
    }
    for (const text of ['حلَ١ل', 'حلـ١ل', 'حل\u200d١ل', 'حل\u200c١ل', 'حل\u200f١ل', 'حل\u200f|ل']) {
      expect(halal(text)).toBe(true);
    }
  });

  it('keeps the Latin digit path (C2)', () => {
    expect(run(AU, 'ha١al')).toEqual(['halal:token']); // visual reading (Hassan S2)
    expect(run(AU, 'ha۱al')).toEqual(['halal:token']);
    expect(run(AU, 'ha1al')).toEqual(['halal:compact']);
    expect(run(AU, 'h4l4l')).toEqual(['halal:compact']);
  });

  it('matches decorated and encoded spellings (C3)', () => {
    for (const text of [
      'حـــلـــال', // tatweel run
      'حَلَّالْ', // shadda, sukun
      'حلالًا', // tanween
      'ﺣﻼﻝ', // presentation forms with the lam-alef ligature
      'ﺣﻼل',
      'ح‍لال', // ZWJ
      'ح‌لال', // ZWNJ
      'ح؜لال', // ALM
      'ح‏لال', // RLM
      'ح﻿لال', // FEFF
      '⁧حلال⁩', // isolates
      'حلالی'.replace('ی', 'ي'), // ي and ی
      'آحلال',
      'أحلال',
      'حلٱل', // wasla
      'حلآل', // madda
      'حلأل', // hamza above
      'حلإل', // hamza below
      'الحلال', // with the article
      'وحلال',
      'بالحلال',
      'ح،ل،ا،ل', // Arabic comma separators
    ]) {
      expect(halal(text)).toBe(true);
    }
  });

  it('matches kaf variants in a term that has them (C3)', () => {
    const v = [{ typeCode: code('t'), terms: ['مبارك'] }];
    expect(run(v, 'مبارک')).toEqual(['t:token']);
  });

  it('does not match other words (C3)', () => {
    for (const text of ['حلول', 'تحلیل', 'محلل', 'جلال', 'خلال', 'هلال', 'بلال', 'حلاوة']) {
      expect(halal(text)).toBe(false);
    }
  });

  it('pins the known false positives of the second pass, which fail closed (C3)', () => {
    expect(halal('حل المشكلة')).toBe(true);
    expect(halal('محل اللحوم')).toBe(true);
  });
});

describe('claim text matcher: Latin context across separators (Hassan S5)', () => {
  it('reads an Arabic look-alike between Latin letters across punctuation and spaces', () => {
    for (const text of ['ha.ا.al', 'h-a-ا-a-l', 'ha ا al', 'ha.l.al']) {
      expect([text, run(AU, text)]).toEqual([text, ['halal:compact']]);
    }
  });

  it('does not latinise an Arabic word that has no Latin letter around it', () => {
    expect(normaliseClaimText('ا')).toBe('ا');
    expect(normaliseClaimText('، ا ،')).not.toMatch(/[a-z]/);
    expect(normaliseClaimText('كتاب ا قلم')).not.toMatch(/[a-z]/);
    expect(normaliseClaimText('123 ا 456')).not.toMatch(/[a-z]/);
  });

  it('keeps the fold main had: only a directly adjacent Arabic letter blocks it (Hassan #380 H1)', () => {
    for (const text of ['halaا ب', 'halaا-بيع', 'لحم halaا ب']) {
      expect([text, run(AU, text)]).toEqual([text, ['halal:token']]);
    }
  });

  // Frozen copy of the rule on main before the separators change: the oracle.
  const mainFold = (s: string): string[] => {
    const arabic = /\p{Script=Arabic}/u;
    const arabicLetter = /(?=\p{L})\p{Script=Arabic}/u;
    const latinLetter = /(?=\p{L})\p{Script=Latin}/u;
    const chars = [...s];
    return chars.map((ch, i) => {
      if (!arabic.test(ch)) return ch;
      const before = chars[i - 1] ?? '';
      const after = chars[i + 1] ?? '';
      if (arabicLetter.test(before) || arabicLetter.test(after)) return ch;
      if (!latinLetter.test(before) && !latinLetter.test(after)) return ch;
      const prototype = UTS39_CONFUSABLES.get(ch)?.toLowerCase();
      return prototype !== undefined && /^[a-z]+$/.test(prototype) ? prototype : ch;
    });
  };

  it('folds everything main folded, on every mixed Arabic/Latin/separator string (differential)', () => {
    const alphabet = ['h', 'a', 'l', 'ا', 'ه', 'ب', ' ', '-', '.', '٠'];
    const strings: string[] = [];
    const build = (prefix: string, depth: number) => {
      strings.push(prefix);
      if (depth === 0) return;
      for (const c of alphabet) build(prefix + c, depth - 1);
    };
    build('', 5);
    let seed = 12345; // deterministic generator for longer strings
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let n = 0; n < 3000; n++) {
      let t = '';
      for (let k = 0; k < 6 + (next() % 8); k++) t += alphabet[next() % alphabet.length];
      strings.push(t);
    }
    for (const text of strings) {
      const original = [...text];
      const expected = mainFold(text);
      const actual = [...latinContextFold(text)];
      // Every prototype in this alphabet is one letter, so the strings align character by character.
      expect(actual).toHaveLength(original.length);
      for (const [i, ch] of expected.entries()) {
        if (ch !== original[i] && actual[i] !== ch) {
          throw new Error(`fold lost: ${JSON.stringify(text)} at ${i}`);
        }
      }
    }
  });

  it('does not reach across a letter of another script', () => {
    expect(normaliseClaimText('a ب ا ب a')).not.toContain('l');
  });
});

describe('claim text matcher: spans (Hassan N1)', () => {
  const kosher = prepareVocabulary([AU[1]!]);

  it('reports the span of the kosher token in the number reading of the text', () => {
    // The first reading has the tokens ٠ and k٥sher; only the visual reading finds kosher.
    const [m] = matchClaimTerms(['٠ k٥sher'], kosher)[0]!;
    expect(m).toEqual({ typeCode: 'kosher', pass: 'token', span: { fromToken: 1, toToken: 1 } });
  });

  it('is unchanged when both readings split the same way', () => {
    const [m] = matchClaimTerms(['fresh k٥sher meat'], kosher)[0]!;
    expect(m!.span).toEqual({ fromToken: 1, toToken: 1 });
  });
});

describe('claim text matcher: spans on unreliable piece counts (Hassan #380 L1)', () => {
  const kosher = prepareVocabulary([AU[1]!]);

  it('never reports the wrong token when a symbol turns into letters', () => {
    const [m] = matchClaimTerms(['™ k٥sher ٠ halal'], kosher)[0]!;
    // Correct is {1,1} (k5sher in [tm, k5sher, 0, halal]) or the widened span; never {2,2}.
    expect([
      { fromToken: 1, toToken: 1 },
      { fromToken: 0, toToken: 3 },
    ]).toContainEqual(m!.span);
  });
});

// Timing tests compare against a baseline measured in the same process, so a busy machine slows
// both sides: a wall-clock bound alone flakes under the parallel load of jest and CI.
const minMs = (fn: () => void, runs = 5): number => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe('claim text matcher: speed (Hassan S4, #380 M1)', () => {
  it.each(['長', '♪'])(
    'normalises 20,000 x %s no slower than a fixed multiple of a control',
    (ch) => {
      const text = ch.repeat(20_000);
      normaliseClaimText(text);
      normaliseClaimText(text, true);
      // Control: the same length of ASCII, which takes the fast path the memo gives other characters.
      const control = 'a'.repeat(20_000);
      const base = minMs(() => normaliseClaimText(control, true));
      for (const visual of [false, true]) {
        const ms = minMs(() => normaliseClaimText(text, visual));
        expect([ch, visual, ms < 60 * base + 100]).toEqual([ch, visual, true]);
      }
    },
  );

  it('translates visual-only matches with one piece table per text, not one per type', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const word = (i: number) => `zo${letters[i]}${letters[(i * 7) % 26]}`;
    const vocab = (n: number) =>
      prepareVocabulary(
        Array.from({ length: n }, (_, i) => ({ typeCode: code(`t${i}`), terms: [word(i)] })),
      );
    // Every word matches only in the visual reading (٥ is o); ٠ forces the readings to split apart.
    const text = (n: number) =>
      '٠ ' + Array.from({ length: n }, (_, i) => word(i).replace('o', '٥')).join(' ');
    const big = (n: number) => (text(n) + ' ').repeat(Math.floor(19_000 / (text(n).length + 1)));
    const t = big(20);
    const texts = [t, t, t]; // about 57,000 characters
    const one = vocab(1);
    const twenty = vocab(20);
    expect(matchClaimTerms(texts, twenty)[0]!).toHaveLength(20);
    const base = minMs(() => matchClaimTerms(texts, one), 3);
    const many = minMs(() => matchClaimTerms(texts, twenty), 3);
    // One table per text: 20 types cost about the same as 1; per-type tables cost about 20 times.
    expect([many < 6 * base + 50]).toEqual([true]);
  });
});
