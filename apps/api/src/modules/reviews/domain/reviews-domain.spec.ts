import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { authorLabel } from './author';
import { evaluateEligibility, type PurchaseCandidate } from './eligibility';
import {
  isWithinEditWindow,
  isWithinReviewWindow,
  validateProductReviewInput,
  validateSellerRatingInput,
  windowEndsAt,
} from './rules';
import {
  averageTimes100,
  summariseSellerGroups,
  summariseStarGroups,
  summaryShownFrom,
} from './summary';
import { checkText, type TextRules } from './text-checks';

// The pure rules of reviews: the 60-day review window and the 30-day edit window, the input
// limits, the automatic text checks, the summary math and the author label. The numbers below
// are the two test Markets' own (AU 60/30, ZZ 30/7): a rule that only held for AU would be a bug.

const T0 = Temporal.Instant.from('2026-10-26T00:00:00Z');
const days = (n: number) => n * 24;
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each([
  ['AU', 60, 30],
  ['ZZ', 30, 7],
] as const)('windows in market %s (review %i days, edit %i days)', (_code, review, edit) => {
  it('closes the review window exactly `review` days after delivery', () => {
    const delivered = T0;
    expect(windowEndsAt(delivered, review)).toEqual(delivered.add({ hours: days(review) }));
    expect(isWithinReviewWindow(delivered, delivered, review)).toBe(true);
    expect(isWithinReviewWindow(delivered, delivered.add({ hours: days(review) }), review)).toBe(
      true,
    );
    expect(
      isWithinReviewWindow(
        delivered,
        delivered.add({ hours: days(review) }).add({ milliseconds: 1 }),
        review,
      ),
    ).toBe(false);
  });

  it('never opens the review window before the delivery instant', () => {
    expect(isWithinReviewWindow(T0, T0.subtract({ milliseconds: 1 }), review)).toBe(false);
  });

  it('closes the edit window `edit` days after the first submit', () => {
    expect(isWithinEditWindow(T0, T0.add({ hours: days(edit) }), edit)).toBe(true);
    expect(
      isWithinEditWindow(T0, T0.add({ hours: days(edit) }).add({ milliseconds: 1 }), edit),
    ).toBe(false);
  });

  it('closes the edit window at once when the Market allows no edits (0 days)', () => {
    expect(isWithinEditWindow(T0, T0, 0)).toBe(true);
    expect(isWithinEditWindow(T0, T0.add({ milliseconds: 1 }), 0)).toBe(false);
  });
});

describe('product review input', () => {
  const limits = { titleMaxLength: 120, bodyMaxLength: 2000 };

  it('accepts a rating alone', () => {
    const result = validateProductReviewInput({ rating: 4 }, limits);
    expect(result).toEqual({
      ok: true,
      value: { rating: 4, title: null, body: null, anonymous: false },
    });
  });

  it.each([0, 6, 3.5, '4', null, undefined, Number.NaN])('refuses the rating %p', (rating) => {
    const result = validateProductReviewInput({ rating }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual([{ path: 'rating', code: 'range' }]);
  });

  it('counts characters, not bytes, and applies the Market limits', () => {
    const title = 'ت'.repeat(120);
    expect(validateProductReviewInput({ rating: 5, title }, limits).ok).toBe(true);
    const tooLong = validateProductReviewInput({ rating: 5, title: title + 'ت' }, limits);
    expect(tooLong.ok).toBe(false);
    expect(
      validateProductReviewInput({ rating: 5, title: 'abcdef' }, { ...limits, titleMaxLength: 5 })
        .ok,
    ).toBe(false);
    expect(validateProductReviewInput({ rating: 5, body: 'x'.repeat(2001) }, limits)).toEqual({
      ok: false,
      error: [{ path: 'body', code: 'length' }],
    });
  });

  it('trims text and turns empty text into null', () => {
    expect(
      validateProductReviewInput({ rating: 3, title: '   ', body: '  fine  ' }, limits),
    ).toEqual({ ok: true, value: { rating: 3, title: null, body: 'fine', anonymous: false } });
  });

  it('refuses hidden characters in the text', () => {
    const result = validateProductReviewInput({ rating: 3, body: 'a‮b' }, limits);
    expect(result).toEqual({ ok: false, error: [{ path: 'body', code: 'invisible-character' }] });
  });

  it('refuses a text that is not a string and an anonymous flag that is not a boolean', () => {
    const result = validateProductReviewInput({ rating: 3, title: 5, anonymous: 'yes' }, limits);
    expect(result).toEqual({
      ok: false,
      error: [
        { path: 'title', code: 'type' },
        { path: 'anonymous', code: 'type' },
      ],
    });
  });
});

describe('seller rating input', () => {
  it('accepts satisfaction with the two yes/no answers', () => {
    expect(
      validateSellerRatingInput({ satisfaction: 5, asDescribed: true, arrivedOk: true }),
    ).toEqual({
      ok: true,
      value: { satisfaction: 5, asDescribed: true, arrivedOk: true, reasonCode: null },
    });
  });

  it('takes a reason code only when the order did not arrive ok', () => {
    expect(
      validateSellerRatingInput({
        satisfaction: 2,
        asDescribed: false,
        arrivedOk: false,
        reasonCode: 'damaged',
      }),
    ).toEqual({
      ok: true,
      value: { satisfaction: 2, asDescribed: false, arrivedOk: false, reasonCode: 'damaged' },
    });
    expect(
      validateSellerRatingInput({
        satisfaction: 5,
        asDescribed: true,
        arrivedOk: true,
        reasonCode: 'damaged',
      }),
    ).toEqual({ ok: false, error: [{ path: 'reasonCode', code: 'not-allowed' }] });
  });

  it('refuses an unknown reason code and a missing answer', () => {
    expect(
      validateSellerRatingInput({
        satisfaction: 1,
        asDescribed: false,
        arrivedOk: false,
        reasonCode: 'late',
      }),
    ).toEqual({ ok: false, error: [{ path: 'reasonCode', code: 'value' }] });
    expect(validateSellerRatingInput({ satisfaction: 6, asDescribed: 'no' })).toEqual({
      ok: false,
      error: [
        { path: 'satisfaction', code: 'range' },
        { path: 'asDescribed', code: 'type' },
        { path: 'arrivedOk', code: 'type' },
      ],
    });
  });
});

describe.each([
  [
    'AU rules',
    {
      blockedTerms: ['shit', 'cunt'],
      repeatedCharRun: 8,
      repeatedWordMinTokens: 6,
      repeatedWordShareBps: 6000,
    },
  ],
  [
    'ZZ rules',
    {
      blockedTerms: ['zork', 'blarg'],
      repeatedCharRun: 5,
      repeatedWordMinTokens: 4,
      repeatedWordShareBps: 7500,
    },
  ],
] as const)('automatic text checks (%s)', (_label, rules: TextRules) => {
  const clean = {
    title: 'Lovely dates',
    body: 'Fresh, sweet and arrived well packed. Will buy again.',
  };
  const blocked = rules.blockedTerms[0]!;

  it('passes an ordinary review with no signal', () => {
    expect(checkText(clean, rules)).toEqual([]);
    expect(checkText({ title: null, body: null }, rules)).toEqual([]);
  });

  it('flags a blocked word as a whole word, in any case, in the title or the body', () => {
    expect(checkText({ title: null, body: `This is ${blocked.toUpperCase()}.` }, rules)).toEqual([
      'profanity',
    ]);
    expect(checkText({ title: `${blocked}!`, body: null }, rules)).toEqual(['profanity']);
  });

  it('does not flag a blocked word inside a longer word', () => {
    expect(checkText({ title: null, body: `a${blocked}ing and ${blocked}s` }, rules)).toEqual([]);
  });

  it('flags a phone number written with spaces, dashes, brackets or other digits', () => {
    for (const body of [
      'call me 0412 345 678',
      'ring (07) 3123-4567 now',
      'whatsapp +61 412345678',
      'call ٠٩١٢٣٤٥٦٧٨٩',
      'tel ０９０１２３４５６７８',
    ]) {
      expect(checkText({ title: null, body }, rules)).toEqual(['phone-number']);
    }
  });

  it('does not flag short numbers, prices or quantities', () => {
    expect(
      checkText({ title: null, body: 'Paid $12.50 for 3 boxes, 500g each, 2026' }, rules),
    ).toEqual([]);
  });

  it('flags an email address', () => {
    expect(checkText({ title: null, body: 'mail me at ali.k@example.com' }, rules)).toEqual([
      'email-address',
    ]);
  });

  it('flags a web address, with or without a scheme', () => {
    for (const body of [
      'see https://shop.example/x',
      'visit www.example.co',
      'cheaper at bestdates.com',
      'bit.ly/abc',
    ]) {
      expect(checkText({ title: null, body }, rules)).toEqual(['web-address']);
    }
  });

  it('does not flag ordinary full stops', () => {
    expect(checkText({ title: null, body: 'Great.Thanks. Four stars e.g. fine.' }, rules)).toEqual(
      [],
    );
  });

  it('flags a street address', () => {
    for (const body of [
      'deliver to 12 Smith Street please',
      'I live at 4/55 Queen Rd',
      'PO Box 123',
      '3丁目 12番地',
    ]) {
      expect(checkText({ title: null, body }, rules)).toEqual(['street-address']);
    }
  });

  it('flags HTML and script', () => {
    for (const body of [
      '<script>alert(1)</script>',
      'nice <b>bold</b>',
      '<img src=x onerror=alert(1)>',
      'click javascript:alert(1)',
    ]) {
      expect(checkText({ title: null, body }, rules)).toContain('markup');
    }
    expect(checkText({ title: null, body: '3 < 5 and 7 > 2' }, rules)).toEqual([]);
  });

  it('flags one character repeated, and one word repeated', () => {
    expect(
      checkText({ title: null, body: `wow${'o'.repeat(rules.repeatedCharRun)}` }, rules),
    ).toEqual(['repeated-text']);
    expect(
      checkText({ title: null, body: `wow${'o'.repeat(rules.repeatedCharRun - 2)}` }, rules),
    ).toEqual([]);
    expect(checkText({ title: null, body: 'buy buy buy buy buy buy buy now' }, rules)).toEqual([
      'repeated-text',
    ]);
    expect(checkText({ title: null, body: 'good good fine' }, rules)).toEqual([]);
  });

  it('returns every hit once, sorted', () => {
    const signals = checkText(
      { title: `${blocked}`, body: 'mail a@b.co or call 0412 345 678 <b>x</b>' },
      rules,
    );
    expect(signals).toEqual(['email-address', 'markup', 'phone-number', 'profanity']);
  });

  it('is not fooled by compatibility forms of a blocked word', () => {
    const wide = blocked.replace(/./g, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0));
    expect(checkText({ title: null, body: wide }, rules)).toEqual(['profanity']);
  });
});

describe('summary math', () => {
  it('counts, sums and bins star ratings', () => {
    const summary = summariseStarGroups([
      { rating: 5, count: 3 },
      { rating: 4, count: 1 },
      { rating: 1, count: 2 },
    ]);
    expect(summary).toEqual({ count: 6, sum: 21, histogram: [2, 0, 0, 1, 3] });
    expect(averageTimes100(summary)).toBe(350);
  });

  it('has no average for no ratings, and rounds half up', () => {
    expect(averageTimes100(summariseStarGroups([]))).toBeNull();
    expect(averageTimes100({ count: 3, sum: 13 })).toBe(433);
    expect(averageTimes100({ count: 8, sum: 31 })).toBe(388);
  });

  it('ignores a group with a rating outside 1..5 or a count of zero', () => {
    expect(
      summariseStarGroups([
        { rating: 7, count: 4 },
        { rating: 3, count: 0 },
      ]),
    ).toEqual({ count: 0, sum: 0, histogram: [0, 0, 0, 0, 0] });
  });

  it('summarises seller ratings: rated orders, satisfied, as described, arrived ok', () => {
    const summary = summariseSellerGroups([
      { satisfaction: 5, asDescribed: true, arrivedOk: true, count: 6 },
      { satisfaction: 4, asDescribed: true, arrivedOk: false, count: 2 },
      { satisfaction: 2, asDescribed: false, arrivedOk: false, count: 2 },
    ]);
    expect(summary).toEqual({
      count: 10,
      sum: 6 * 5 + 2 * 4 + 2 * 2,
      histogram: [0, 2, 0, 2, 6],
      ratedSellerOrders: 10,
      satisfiedCount: 8,
      asDescribedYes: 8,
      arrivedOkYes: 6,
    });
  });

  it('shows a summary from the first review for products and from the Market minimum for sellers', () => {
    expect(summaryShownFrom(1, 1)).toBe(true);
    expect(summaryShownFrom(0, 1)).toBe(false);
    expect(summaryShownFrom(9, 10)).toBe(false);
    expect(summaryShownFrom(10, 10)).toBe(true);
    expect(summaryShownFrom(2, 3)).toBe(false);
    expect(summaryShownFrom(3, 3)).toBe(true);
  });
});

describe('author label', () => {
  it('shows the short name read at read time', () => {
    expect(authorLabel({ accountId: id<'Account'>(1), anonymous: false }, 'Maryam R.')).toEqual({
      kind: 'named',
      name: 'Maryam R.',
    });
  });
  it('shows "Verified buyer" when the author chose to be anonymous, never the name', () => {
    expect(authorLabel({ accountId: id<'Account'>(1), anonymous: true }, 'Maryam R.')).toEqual({
      kind: 'verified-buyer',
    });
  });
  it('shows "Verified buyer" when no name is known', () => {
    expect(authorLabel({ accountId: id<'Account'>(1), anonymous: false }, undefined)).toEqual({
      kind: 'verified-buyer',
    });
  });
  it('shows "Former customer" once the account link was dropped, anonymous or not', () => {
    expect(authorLabel({ accountId: null, anonymous: false }, 'Maryam R.')).toEqual({
      kind: 'former-customer',
    });
    expect(authorLabel({ accountId: null, anonymous: true }, undefined)).toEqual({
      kind: 'former-customer',
    });
  });
});

describe('eligibility (verified buyers only)', () => {
  const product = id<'Product'>(0x10);
  const other = id<'Product'>(0x11);
  const purchase = (
    n: number,
    deliveredDaysAgo: number,
    productId = product,
  ): PurchaseCandidate => ({
    sellerOrderId: id<'SellerOrder'>(n),
    sellerId: id<'Seller'>(0x50 + n),
    offerId: id<'Offer'>(0x70 + n),
    productId,
    deliveredAt: T0.subtract({ hours: days(deliveredDaysAgo) }),
  });

  it('is eligible with a delivered purchase of the product inside the window', () => {
    const result = evaluateEligibility([purchase(1, 10)], product, T0, 60);
    expect(result.kind).toBe('eligible');
  });

  it('picks the latest delivered purchase, which a second purchase of the product makes the new "bought from"', () => {
    const result = evaluateEligibility(
      [purchase(1, 40), purchase(2, 5), purchase(3, 20)],
      product,
      T0,
      60,
    );
    expect(result).toEqual({ kind: 'eligible', purchase: purchase(2, 5) });
  });

  it('is window-closed when the only purchases are older than the window', () => {
    expect(evaluateEligibility([purchase(1, 61)], product, T0, 60).kind).toBe('window-closed');
    expect(evaluateEligibility([purchase(1, 31)], product, T0, 30).kind).toBe('window-closed');
    expect(evaluateEligibility([purchase(1, 30)], product, T0, 30).kind).toBe('eligible');
  });

  it('uses an older purchase only while it is inside the window, a newer one otherwise', () => {
    const result = evaluateEligibility([purchase(1, 70), purchase(2, 59)], product, T0, 60);
    expect(result).toEqual({ kind: 'eligible', purchase: purchase(2, 59) });
  });

  it('is not eligible for a product the account never had delivered', () => {
    expect(evaluateEligibility([purchase(1, 5, other)], product, T0, 60).kind).toBe('not-eligible');
    expect(evaluateEligibility([], product, T0, 60).kind).toBe('not-eligible');
  });
});
