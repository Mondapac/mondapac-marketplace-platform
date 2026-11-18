import { ok } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { RecordingReview } from '../../../../test/support/system-request-fakes';
import {
  categoryDetailsOf,
  categoryDetailsValues,
  linksOf,
  linksValues,
  NO_REVIEW,
  openCatalogueReview,
  sameContent,
} from './catalogue-review';

// The pure parts of area catalogue (Admin Inbox › System requests): the values of a request and
// what reads them back, the guard for values too large to keep, and the recorder an import uses.

const market = testMarketContext('AU', 'default');
const context = testCallContext(
  market,
  testAuthenticatedActor(market, {
    population: 'admin',
    accountId: '01990000-0000-7000-8000-0000000000a1' as never,
    sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
    sellerId: null,
  }),
);
const reviewed = { reviewed: true, risk: 'medium' } as const;
const off = { reviewed: false, risk: 'low' } as const;

describe('category details values', () => {
  const seo = { title: 'Pantry', description: null, noindex: true };
  const texts = [
    { locale: 'ja-JP', name: 'パントリー', shortDescription: null, keywords: [] },
    { locale: 'en-US', name: 'Pantry', shortDescription: 'Dry goods', keywords: ['dry', 'tin'] },
  ];

  it('reads back what it wrote, whatever the order of the locales', () => {
    const values = categoryDetailsValues(texts, seo, false);
    expect(categoryDetailsOf(values)).toEqual({
      texts: [texts[1], texts[0]],
      seo,
      showInMenu: false,
    });
    expect(sameContent(values, categoryDetailsValues([...texts].reverse(), seo, false))).toBe(true);
  });

  it('keeps every list at the second level, where a request may hold one', () => {
    const values = categoryDetailsValues(texts, seo, true) as { keywords: object };
    expect(values.keywords).toEqual({ 'en-US': ['dry', 'tin'], 'ja-JP': [] });
  });

  it('reads nothing from values that are not category details', () => {
    expect(categoryDetailsOf({ rateBps: 5 })).toBeNull();
    expect(categoryDetailsOf({ ...categoryDetailsValues(texts, seo, true), noindex: 'yes' })).toBe(
      null,
    );
    expect(categoryDetailsOf(null)).toBeNull();
  });
});

describe('category links values', () => {
  it('reads back what it wrote, and nothing else', () => {
    const values = linksValues({ featureSetId: null, filters: ['colour', 'size'] });
    expect(linksOf(values)).toEqual({ featureSetId: null, filters: ['colour', 'size'] });
    expect(linksOf({ featureSetId: 7, filters: [] })).toBeNull();
    expect(linksOf({ featureSetId: null, filters: [1] })).toBeNull();
    expect(sameContent(values, { filters: ['colour', 'size'], featureSetId: null })).toBe(true);
    expect(sameContent(values, { filters: ['size', 'colour'], featureSetId: null })).toBe(false);
  });
});

describe('openCatalogueReview', () => {
  const huge = {
    names: { en: 'x'.repeat(400) },
    more: Array.from({ length: 40 }, () => 'y'.repeat(400)),
  };
  const change = (before: object, after: object) => ({
    subjectKind: 'catalog.category-details',
    subjectRef: 'abc',
    before: before as never,
    after: after as never,
    note: 'A note',
    tooLargePath: 'texts',
  });

  it('refuses values too large for a request where the area is reviewed, without calling the recorder', async () => {
    const recorder = new RecordingReview().review('catalogue');
    const answer = await openCatalogueReview(recorder, context, reviewed, change({}, huge));
    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'texts', code: 'too-large-for-review' }],
      },
    });
    expect(recorder.opened).toEqual([]);
  });

  it('lets such an edit through, unreviewed, where the area is off', async () => {
    const recorder = new RecordingReview();
    expect(await openCatalogueReview(recorder, context, off, change({}, huge))).toEqual(ok(null));
    expect(recorder.opened).toEqual([]);
  });

  it('opens the review in area catalogue for values that fit', async () => {
    const recorder = new RecordingReview().review('catalogue', 'medium');
    const answer = await openCatalogueReview(
      recorder,
      context,
      reviewed,
      change({ a: 1 }, { a: 2 }),
    );
    expect(answer.ok && answer.value).toMatchObject({ number: 1, risk: 'medium' });
    expect(recorder.opened[0]).toMatchObject({ area: 'catalogue', note: 'A note' });
  });
});

describe('NO_REVIEW (the file imports)', () => {
  it('reviews nothing and opens nothing, whatever the policy of the Market', async () => {
    expect(await NO_REVIEW.areaPolicy(context, 'catalogue')).toEqual({
      enabled: false,
      risk: 'low',
    });
    expect(
      await NO_REVIEW.openReview(context, {
        area: 'catalogue',
        subjectKind: 'catalog.category-details',
        subjectRef: 'abc',
        before: { a: 1 },
        after: { a: 2 },
        note: undefined,
      }),
    ).toEqual(ok(null));
  });
});
