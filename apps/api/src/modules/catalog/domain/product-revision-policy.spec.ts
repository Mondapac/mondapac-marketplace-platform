import {
  classify,
  decideOutcome,
  type Classification,
  type RevisionSummary,
  type SensitiveChangesPolicy,
} from './product-revision-policy';

// AC 26 (a pending sensitive revision holds later edits), AC 36 (tax override) and Hassan H1
// (an image always goes to review). The policy is pure, so the Market is just an input: the AU
// default and the test Market's (name and tax category only, design 7.1).

const AU: SensitiveChangesPolicy = {
  platformCategories: true,
  taxCategory: true,
  name: true,
  primaryImage: true,
  anyImage: true,
  variantRemoved: true,
};
const SYNTHETIC: SensitiveChangesPolicy = {
  platformCategories: false,
  taxCategory: true,
  name: true,
  primaryImage: false,
  anyImage: false,
  variantRemoved: false,
};

const published: RevisionSummary = {
  names: { en: 'Olive oil', ar: 'زيت زيتون' },
  categoryIds: ['c1', 'c2'],
  taxCategoryCode: 'standard',
  imageIds: ['i1', 'i2'],
  variantIds: ['v1', 'v2'],
};
const change = (patch: Partial<RevisionSummary>): RevisionSummary => ({ ...published, ...patch });

describe('classify', () => {
  it('treats a product never published as sensitive', () => {
    expect(classify(null, change({ imageIds: [] }), AU)).toEqual({
      sensitive: true,
      reasons: ['never-published'],
    });
  });

  it('sends the images of a first revision to review too, in every Market (H1)', () => {
    for (const policy of [AU, SYNTHETIC]) {
      expect(classify(null, published, policy)).toEqual({
        sensitive: true,
        reasons: ['never-published', 'image-added-or-replaced'],
      });
    }
  });

  it('flags a removed primary image', () => {
    expect(classify(published, change({ imageIds: [] }), AU).reasons).toContain('primary-image');
  });

  it('finds no change in an identical revision, whatever the order of ids', () => {
    expect(
      classify(published, change({ categoryIds: ['c2', 'c1'], variantIds: ['v2', 'v1'] }), AU),
    ).toEqual({ sensitive: false, reasons: [] });
  });

  it.each([
    ['categories', change({ categoryIds: ['c1'] }), 'platform-categories'],
    ['a swapped category', change({ categoryIds: ['c1', 'c3'] }), 'platform-categories'],
    ['tax category', change({ taxCategoryCode: 'exempt' }), 'tax-category'],
    ['a name in any locale', change({ names: { ...published.names, ar: 'زيت' } }), 'name'],
    ['a new locale name', change({ names: { ...published.names, fr: "Huile d'olive" } }), 'name'],
    ['the primary image', change({ imageIds: ['i2', 'i1'] }), 'primary-image'],
    ['a removed variant', change({ variantIds: ['v1'] }), 'variant-removed'],
  ] as const)('flags %s', (_name, candidate, reason) => {
    expect(classify(published, candidate, AU)).toEqual({ sensitive: true, reasons: [reason] });
  });

  it('flags an added or replaced image whatever the Market says (H1)', () => {
    const candidate = change({ imageIds: ['i1', 'i2', 'i3'] });
    expect(classify(published, candidate, AU).reasons).toEqual(['image-added-or-replaced']);
    expect(classify(published, candidate, SYNTHETIC).reasons).toEqual(['image-added-or-replaced']);
  });

  it('does not flag a removed image, a reordering of non-primary images or an added variant', () => {
    expect(classify(published, change({ imageIds: ['i1'] }), SYNTHETIC).sensitive).toBe(false);
    expect(classify(published, change({ variantIds: ['v1', 'v2', 'v3'] }), AU).sensitive).toBe(
      false,
    );
  });

  it('reads only the fields the Market lists', () => {
    const candidate = change({ categoryIds: ['c9'], variantIds: [], imageIds: ['i2', 'i1'] });
    expect(classify(published, candidate, SYNTHETIC)).toEqual({ sensitive: false, reasons: [] });
    expect(classify(published, change({ taxCategoryCode: 'exempt' }), SYNTHETIC).reasons).toEqual([
      'tax-category',
    ]);
  });

  it('lists every reason that applies', () => {
    const candidate = change({ taxCategoryCode: 'exempt', variantIds: [], categoryIds: [] });
    expect(classify(published, candidate, AU).reasons).toEqual([
      'platform-categories',
      'tax-category',
      'variant-removed',
    ]);
  });
});

describe('decideOutcome', () => {
  const minor: Classification = { sensitive: false, reasons: [] };
  const sensitive: Classification = { sensitive: true, reasons: ['name'] };
  const neverPublished: Classification = { sensitive: true, reasons: ['never-published'] };
  const image: Classification = { sensitive: true, reasons: ['image-added-or-replaced'] };
  const seller = (
    classification: Classification,
    approvalRequired: boolean,
    sensitiveRevisionPending = false,
  ) =>
    decideOutcome({ classification, approvalRequired, sensitiveRevisionPending, author: 'seller' });

  it('publishes a minor change of a published product at once, with approval on or off', () => {
    for (const approvalRequired of [true, false]) {
      expect(seller(minor, approvalRequired)).toEqual({
        outcome: 'published',
        publishKind: 'auto',
        sensitive: false,
        reasons: [],
      });
    }
  });

  it('holds a sensitive change and a never-published product when approval is on', () => {
    expect(seller(sensitive, true)).toMatchObject({ outcome: 'pending', reasons: ['name'] });
    expect(seller(neverPublished, true)).toMatchObject({
      outcome: 'pending',
      reasons: ['never-published'],
    });
  });

  it('publishes everything but images at once when approval is off', () => {
    expect(seller(sensitive, false)).toMatchObject({ outcome: 'published', publishKind: 'auto' });
    expect(seller(neverPublished, false)).toMatchObject({ outcome: 'published' });
  });

  it('never publishes a first revision with images at once, even with approval off (H1)', () => {
    const first = classify(null, published, AU);
    expect(seller(first, false)).toMatchObject({ outcome: 'pending', publishKind: null });
    expect(seller(first, true)).toMatchObject({ outcome: 'pending' });
  });

  it('publishes an admin revision at once, images or not (CAT-41)', () => {
    for (const author of ['admin-platform', 'tax-override'] as const) {
      expect(
        decideOutcome({
          classification: classify(null, published, AU),
          approvalRequired: true,
          sensitiveRevisionPending: true,
          author,
        }),
      ).toMatchObject({ outcome: 'published', publishKind: 'admin-authored' });
    }
  });

  it('decides the same change differently in the two Markets (AU reviews a category change)', () => {
    const moved = change({ categoryIds: ['c9'] });
    expect(seller(classify(published, moved, AU), true)).toMatchObject({ outcome: 'pending' });
    expect(seller(classify(published, moved, SYNTHETIC), true)).toMatchObject({
      outcome: 'published',
    });
  });

  it('always sends a revision that adds or replaces an image to review (H1)', () => {
    expect(seller(image, false)).toMatchObject({ outcome: 'pending', publishKind: null });
    expect(seller(image, true)).toMatchObject({ outcome: 'pending' });
  });

  it('keeps a minor change pending while a sensitive revision waits (AC 26)', () => {
    expect(seller(minor, true, true)).toEqual({
      outcome: 'pending',
      publishKind: null,
      sensitive: true,
      reasons: ['approval-required'],
    });
    expect(seller(minor, false, true)).toMatchObject({ outcome: 'published' });
  });

  it.each(['admin-platform', 'tax-override'] as const)(
    'publishes an admin %s revision at once whatever the setting (CAT-41, AC 36)',
    (author) => {
      for (const approvalRequired of [true, false]) {
        expect(
          decideOutcome({
            classification: sensitive,
            approvalRequired,
            sensitiveRevisionPending: true,
            author,
          }),
        ).toEqual({
          outcome: 'published',
          publishKind: 'admin-authored',
          sensitive: true,
          reasons: ['name'],
        });
      }
    },
  );
});
