import { blockedFields, canonicalText, holdsBlockedTerm } from './content-filter';

const TERMS = ['shit', 'bad phrase', 'جنده', 'شرموطة'];

describe('content filter', () => {
  it('matches whole words only, ignoring case', () => {
    expect(holdsBlockedTerm('What SHIT is this', TERMS)).toBe(true);
    expect(holdsBlockedTerm('shiitake mushrooms', TERMS)).toBe(false);
    expect(holdsBlockedTerm('Scunthorpe classic', ['cunt'])).toBe(false);
    expect(holdsBlockedTerm('a Bad   Phrase here', TERMS)).toBe(true);
  });

  it('matches a term next to punctuation', () => {
    expect(holdsBlockedTerm('shit!', TERMS)).toBe(true);
    expect(holdsBlockedTerm('(shit)', TERMS)).toBe(true);
  });

  it('unifies Persian and Arabic letter variants, marks and joiners', () => {
    expect(holdsBlockedTerm('شرموطه', TERMS)).toBe(true); // heh for teh marbuta
    expect(holdsBlockedTerm('جَنده', TERMS)).toBe(true); // a mark inside
    expect(holdsBlockedTerm('ج‌نده', TERMS)).toBe(true); // a joiner inside
    expect(canonicalText('كيك')).toBe('کیک');
  });

  it('folds fullwidth letters and digits', () => {
    expect(holdsBlockedTerm('ｓｈｉｔ', TERMS)).toBe(true);
  });

  it('an empty list or an empty text refuses nothing', () => {
    expect(holdsBlockedTerm('shit', [])).toBe(false);
    expect(holdsBlockedTerm('', TERMS)).toBe(false);
  });

  it('names the fields, never the text', () => {
    expect(
      blockedFields({ summary: 'fine', logoAlt: 'oh shit', other: null, more: undefined }, TERMS),
    ).toEqual(['logoAlt']);
  });
});
