import { CLAIM_WORDS_IN_LETTERS, foldForClaims, hasClaimWord } from './claim-words';

describe('claim words', () => {
  it.each([
    'ḥalāl',
    'hálal',
    'haIaI',
    'ha1al',
    'h.a.l.a.l',
    'h a l a l',
    'ح ل ا ل',
    'zabeeha',
    'dhabiha',
    'Islamic slaughter',
    'شرعی',
    'Это халяль',
    'gluten free',
    'vegetarian',
    'glatt',
    'non-GMO',
    'h͏alal',
    'kasher',
    'helal',
    'Bio',
  ])('sees a claim in "%s"', (text) => {
    expect(hasClaimWord(text)).toBe(true);
  });

  it.each(['rice', 'hall', 'heal', 'healthy snacks', 'the Isle of Man', 'tea bags 100'])(
    'sees none in "%s"',
    (text) => {
      expect(hasClaimWord(text)).toBe(false);
    },
  );

  it('reduces to letters for the letters-only list', () => {
    expect(
      CLAIM_WORDS_IN_LETTERS.test(foldForClaims('chicken h-a-l-a-l').replace(/[^\p{L}]/gu, '')),
    ).toBe(true);
    expect(foldForClaims('ḥalāl')).toBe('halal');
  });
});
