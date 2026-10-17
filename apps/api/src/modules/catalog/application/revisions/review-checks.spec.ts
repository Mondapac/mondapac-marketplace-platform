import { REVIEW_CHECK_CODES, requiredChecksOf } from './review-checks';

describe('requiredChecksOf (design 8.3a)', () => {
  it('requires every check on a first publication', () => {
    expect(requiredChecksOf({ firstPublication: true, reasons: ['never-published'] })).toEqual([
      ...REVIEW_CHECK_CODES,
    ]);
  });

  it('requires the photo check when an image is added or replaced (H1), whatever else', () => {
    expect(
      requiredChecksOf({ firstPublication: false, reasons: ['image-added-or-replaced'] }),
    ).toEqual(['photos-no-certification-mark']);
    expect(requiredChecksOf({ firstPublication: false, reasons: ['primary-image'] })).toEqual([
      'photos-no-certification-mark',
    ]);
  });

  it('requires a check per changed field, in a fixed order', () => {
    expect(
      requiredChecksOf({
        firstPublication: false,
        reasons: ['tax-category', 'platform-categories'],
      }),
    ).toEqual(['category-fits', 'tax-category-fits']);
  });

  it('requires nothing for a change that does not touch those fields, and ignores unknown codes', () => {
    expect(requiredChecksOf({ firstPublication: false, reasons: ['name', 'whatever'] })).toEqual(
      [],
    );
  });
});
