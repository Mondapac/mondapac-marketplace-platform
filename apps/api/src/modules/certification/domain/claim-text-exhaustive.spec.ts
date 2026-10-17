import { normaliseClaimText } from './claim-text-matcher';
import { UTS39_CONFUSABLES } from './generated/uts39-confusables';

// Exhaustive checks of the skeleton over the whole code space (issue #133, Hassan on PR 378).
// Slow by design (about ten seconds): every code point, once.

/**
 * UTS rows with an ASCII letter or digit as prototype that are left alone on purpose:
 * NFKC folds ſ to s before the skeleton; the curated table puts ʋ on v (it looks like v); ˛ and
 * ͺ are marks once decomposed; ￨ is a box-drawing line after NFKC. A digit of any script is read
 * twice (as its number and as its look-alike), and an Arabic letter maps to Latin only between
 * Latin letters, so the comparison is made between Latin letters on both readings.
 */
const LEFT_ALONE = new Set(['ſ', 'ʋ', '˛', 'ͺ', '￨']);

const readings = (s: string) => [normaliseClaimText(s), normaliseClaimText(s, true)];

describe('claim text skeleton, exhaustive', () => {
  it('is idempotent for every code point, on both readings', () => {
    const changed: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const visual of [false, true]) {
        const once = normaliseClaimText(ch, visual);
        if (normaliseClaimText(once, visual) !== once) changed.push(cp.toString(16));
      }
    }
    expect(changed).toEqual([]);
  });

  it('brings every UTS look-alike of an ASCII letter or digit to that character', () => {
    const missed: string[] = [];
    for (const [from, to] of UTS39_CONFUSABLES) {
      if (!/^[A-Za-z0-9]$/.test(to) || LEFT_ALONE.has(from)) continue;
      if (/^[0-9]$/.test(from.normalize('NFKC'))) continue;
      const source = readings(`a${from}a`);
      const target = normaliseClaimText(`a${to}a`);
      if (!source.includes(target)) missed.push(`U+${from.codePointAt(0)!.toString(16)} → ${to}`);
    }
    expect(missed).toEqual([]);
  });
});
