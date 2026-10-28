import {
  approvalReason,
  approvalRewardOf,
  checkDraft,
  layerOf,
  needsFreshSecondFactor,
  parseDraft,
  platformExposure,
  platformShareBps,
  type PromotionDraft,
  type PromotionRules,
} from './promotion';

const AU_RULES: PromotionRules = {
  sellerMaxDiscountBps: 7000,
  priorApprovalDiscountBps: 5000,
  newSellerDays: 30,
  platformBudgetStepUpMinor: 200000n,
  gstRulingConfirmed: false,
};
// The synthetic Market: other limits, and the tax ruling already confirmed.
const ZZ_RULES: PromotionRules = {
  sellerMaxDiscountBps: 5000,
  priorApprovalDiscountBps: 4000,
  newSellerDays: 14,
  platformBudgetStepUpMinor: 300000n,
  gstRulingConfirmed: true,
};

const PRODUCT = '01990000-0000-7000-8000-000000001001';
const SELLER = '01990000-0000-7000-8000-0000000005e1';

const rawSale = (over: Record<string, unknown> = {}) => ({
  type: 'SELLER_SALE',
  name: 'Winter sale',
  funding: 'SELLER',
  startsAt: '2026-11-01T00:00:00Z',
  reward: { kind: 'PERCENT', bps: 2000 },
  productIds: [PRODUCT],
  ...over,
});

function parsed(raw: unknown): PromotionDraft {
  const result = parseDraft(raw);
  if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const seller = { kind: 'seller', sellerId: SELLER } as never;
const platform = { kind: 'platform' } as const;

describe('parseDraft', () => {
  it('reads a seller sale', () => {
    const draft = parsed(rawSale({ capMinor: '3000', budgetMinor: '100000', code: undefined }));
    expect(draft).toMatchObject({
      type: 'SELLER_SALE',
      name: 'Winter sale',
      combinable: true,
      testMode: false,
      specialCampaign: false,
      reward: { kind: 'PERCENT', bps: 2000 },
      capMinor: 3000n,
      budgetMinor: 100000n,
      productIds: [PRODUCT],
    });
  });

  it('normalises a code to upper case', () => {
    const draft = parsed(rawSale({ type: 'CART_CODE', code: ' welcome-10 ', productIds: [] }));
    expect(draft.code).toBe('WELCOME-10');
  });

  it('reports paths and codes only, never the value', () => {
    const result = parseDraft({
      type: 'NOPE',
      name: '',
      funding: 'SELLER',
      startsAt: 'yesterday',
      reward: { kind: 'FIXED', amountMinor: '12.5' },
      budgetMinor: '-1',
      productIds: ['not-an-id'],
      zones: ['bad zone'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(
      expect.arrayContaining([
        { path: 'type', code: 'value' },
        { path: 'name', code: 'value' },
        { path: 'startsAt', code: 'value' },
        { path: 'reward.amountMinor', code: 'value' },
        { path: 'budgetMinor', code: 'value' },
        { path: 'productIds.0', code: 'value' },
        { path: 'zones.0', code: 'value' },
      ]),
    );
    expect(JSON.stringify(result.error)).not.toContain('12.5');
  });

  it('refuses a body that is not an object and an over-long name', () => {
    expect(parseDraft([])).toEqual({ ok: false, error: [{ path: '', code: 'type' }] });
    const long = parseDraft(rawSale({ name: 'x'.repeat(121) }));
    expect(long.ok).toBe(false);
  });

  it('refuses a fraction or a number sent for an amount, and too many targets', () => {
    expect(parseDraft(rawSale({ capMinor: 30 })).ok).toBe(false);
    const many = Array.from({ length: 501 }, () => PRODUCT);
    expect(parseDraft(rawSale({ productIds: many })).ok).toBe(false);
  });
});

describe.each([
  ['AU', AU_RULES],
  ['ZZ', ZZ_RULES],
] as const)('checkDraft in market %s', (_code, rules) => {
  const codes = (draft: PromotionDraft, owner: Parameters<typeof checkDraft>[1]) =>
    checkDraft(draft, owner, rules).map((i) => `${i.path}:${i.code}`);

  it('accepts a seller sale within the seller maximum', () => {
    expect(codes(parsed(rawSale()), seller)).toEqual([]);
  });

  it('refuses a seller discount above the Market maximum', () => {
    const over = rules.sellerMaxDiscountBps + 1;
    expect(codes(parsed(rawSale({ reward: { kind: 'PERCENT', bps: over } })), seller)).toEqual([
      'reward.bps:exceeds-seller-maximum',
    ]);
    expect(
      codes(
        parsed(rawSale({ reward: { kind: 'PERCENT', bps: rules.sellerMaxDiscountBps } })),
        seller,
      ),
    ).toEqual([]);
  });

  it('keeps a seller to its own money and own kinds of promotion', () => {
    expect(codes(parsed(rawSale({ funding: 'PLATFORM' })), seller)).toContain(
      'funding:seller-money-only',
    );
    expect(
      codes(parsed(rawSale({ type: 'FREE_SHIPPING', minSpendMinor: '5000' })), seller),
    ).toContain('type:not-allowed');
    expect(codes(parsed(rawSale({ specialCampaign: true })), seller)).toContain(
      'specialCampaign:not-allowed',
    );
    expect(codes(parsed(rawSale({ productIds: [] })), seller)).toContain('productIds:required');
  });

  it('wants a code on a code promotion and nowhere else', () => {
    expect(codes(parsed(rawSale({ type: 'CART_CODE', productIds: [] })), seller)).toContain(
      'code:required',
    );
    expect(codes(parsed(rawSale({ code: 'SALE-2026' })), seller)).toContain('code:not-allowed');
  });

  it('wants a total budget on a platform promotion and a split on a co-funded one', () => {
    const base = {
      type: 'CART_DISCOUNT',
      funding: 'PLATFORM',
      productIds: [],
      testMode: true,
    };
    expect(codes(parsed(rawSale({ ...base })), platform)).toContain('budgetMinor:required');
    expect(codes(parsed(rawSale({ ...base, budgetMinor: '100000' })), platform)).toEqual([]);
    const co = { ...base, type: 'CO_FUNDED_CAMPAIGN', funding: 'CO_FUNDED', budgetMinor: '100000' };
    expect(codes(parsed(rawSale(co)), platform)).toContain('platformSplitBps:required');
    expect(codes(parsed(rawSale({ ...co, platformSplitBps: 5000 })), platform)).toEqual([]);
    expect(
      codes(parsed(rawSale({ ...base, budgetMinor: '1', platformSplitBps: 5000 })), platform),
    ).toContain('platformSplitBps:not-allowed');
  });

  it('holds the seller share of a co-funded percent reward to the seller maximum', () => {
    const co = {
      type: 'CO_FUNDED_CAMPAIGN',
      funding: 'CO_FUNDED',
      productIds: [],
      budgetMinor: '100000',
      testMode: true,
    };
    // The seller pays (10000 - split) / 10000 of the discount: 90 % x 100 % is far over the maximum.
    expect(
      codes(
        parsed(rawSale({ ...co, platformSplitBps: 1000, reward: { kind: 'PERCENT', bps: 10000 } })),
        platform,
      ),
    ).toContain('reward.bps:exceeds-seller-maximum');
    // At the boundary it is accepted: a full discount with the platform paying the rest of the
    // maximum leaves the seller exactly the maximum.
    const max = rules.sellerMaxDiscountBps;
    const full = { kind: 'PERCENT', bps: 10000 };
    expect(
      codes(parsed(rawSale({ ...co, platformSplitBps: 10000 - max, reward: full })), platform),
    ).not.toContain('reward.bps:exceeds-seller-maximum');
    expect(
      codes(parsed(rawSale({ ...co, platformSplitBps: 10000 - max - 1, reward: full })), platform),
    ).toContain('reward.bps:exceeds-seller-maximum');
  });

  it('keeps platform money in test mode until the tax ruling is confirmed in the Market', () => {
    const live = rawSale({
      type: 'CART_DISCOUNT',
      funding: 'PLATFORM',
      productIds: [],
      budgetMinor: '100000',
      testMode: false,
    });
    expect(codes(parsed(live), platform).includes('testMode:required')).toBe(
      !rules.gstRulingConfirmed,
    );
    expect(codes(parsed({ ...live, testMode: true }), platform)).toEqual([]);
  });

  it('wants a spend threshold on free shipping, platform-funded', () => {
    const shipping = {
      type: 'FREE_SHIPPING',
      funding: 'PLATFORM',
      productIds: [],
      budgetMinor: '100000',
      testMode: true,
      reward: { kind: 'PERCENT', bps: 10000 },
      zones: ['Z1'],
    };
    expect(codes(parsed(rawSale(shipping)), platform)).toContain('minSpendMinor:required');
    expect(codes(parsed(rawSale({ ...shipping, minSpendMinor: '5000' })), platform)).toEqual([]);
  });

  it('refuses an end before the start', () => {
    expect(codes(parsed(rawSale({ endsAt: '2026-10-01T00:00:00Z' })), seller)).toContain(
      'endsAt:before-start',
    );
  });
});

describe('layers and funding', () => {
  it('maps types and owners to layers', () => {
    expect(layerOf('SELLER_SALE', 'seller')).toBe('ITEM');
    expect(layerOf('CO_FUNDED_CAMPAIGN', platform)).toBe('ITEM');
    expect(layerOf('CART_DISCOUNT', 'seller')).toBe('SELLER_CART');
    expect(layerOf('CART_CODE', platform)).toBe('PLATFORM_CART');
    expect(layerOf('FIRST_ORDER', platform)).toBe('PLATFORM_CART');
    expect(layerOf('FREE_SHIPPING', platform)).toBe('SHIPPING');
  });

  it('derives the platform share', () => {
    expect(platformShareBps('SELLER', null)).toBe(0);
    expect(platformShareBps('PLATFORM', null)).toBe(10000);
    expect(platformShareBps('CO_FUNDED', 3000)).toBe(3000);
  });
});

describe.each([
  ['AU', AU_RULES],
  ['ZZ', ZZ_RULES],
] as const)('approvalReason in market %s', (_code, rules) => {
  const pct = (bps: number) => ({ kind: 'PERCENT', bps }) as const;

  it('lets an established seller go live with a moderate discount', () => {
    expect(
      approvalReason({ sellerActiveDays: rules.newSellerDays, reward: pct(1000) }, rules),
    ).toBeNull();
    expect(
      approvalReason({ sellerActiveDays: 400, reward: pct(rules.priorApprovalDiscountBps) }, rules),
    ).toBeNull();
  });

  it('asks for approval from a new seller or an unknown age', () => {
    expect(
      approvalReason({ sellerActiveDays: rules.newSellerDays - 1, reward: pct(100) }, rules),
    ).toBe('NEW_SELLER');
    expect(approvalReason({ sellerActiveDays: null, reward: pct(100) }, rules)).toBe('NEW_SELLER');
  });

  it('asks for approval above the discount threshold', () => {
    expect(
      approvalReason(
        { sellerActiveDays: 400, reward: pct(rules.priorApprovalDiscountBps + 1) },
        rules,
      ),
    ).toBe('HIGH_DISCOUNT');
  });
});

describe('needsFreshSecondFactor', () => {
  const draft = (over: Partial<PromotionDraft> = {}) => ({
    funding: 'PLATFORM' as const,
    platformSplitBps: null,
    budgetMinor: 200000n,
    specialCampaign: false,
    testMode: false,
    ...over,
  });

  it('is not needed at or below the threshold', () => {
    expect(needsFreshSecondFactor(null, draft(), AU_RULES)).toBe(false);
  });

  it('is needed for a new platform budget above the threshold, and when a budget grows past it', () => {
    expect(needsFreshSecondFactor(null, draft({ budgetMinor: 200001n }), AU_RULES)).toBe(true);
    expect(
      needsFreshSecondFactor(
        draft({ budgetMinor: 150000n }),
        draft({ budgetMinor: 250000n }),
        AU_RULES,
      ),
    ).toBe(true);
  });

  it('is not needed when an edit leaves a large budget as it was or lowers it', () => {
    const big = draft({ budgetMinor: 500000n });
    expect(needsFreshSecondFactor(big, big, AU_RULES)).toBe(false);
    expect(needsFreshSecondFactor(big, draft({ budgetMinor: 400000n }), AU_RULES)).toBe(false);
  });

  it('counts only the platform share of a co-funded budget', () => {
    const co = draft({ funding: 'CO_FUNDED', platformSplitBps: 2500, budgetMinor: 600000n });
    expect(platformExposure('CO_FUNDED', 2500, 600000n)).toBe(150000n);
    expect(needsFreshSecondFactor(null, co, AU_RULES)).toBe(false);
    expect(needsFreshSecondFactor(null, { ...co, budgetMinor: 900000n }, AU_RULES)).toBe(true);
  });

  it('never applies to a seller-funded promotion', () => {
    expect(
      needsFreshSecondFactor(null, draft({ funding: 'SELLER', budgetMinor: 99999999n }), AU_RULES),
    ).toBe(false);
  });

  it('is needed to flag a special campaign, once', () => {
    const special = draft({ specialCampaign: true, budgetMinor: 1000n });
    expect(needsFreshSecondFactor(null, special, AU_RULES)).toBe(true);
    expect(needsFreshSecondFactor(draft({ budgetMinor: 1000n }), special, AU_RULES)).toBe(true);
    expect(needsFreshSecondFactor(special, special, AU_RULES)).toBe(false);
  });

  it('counts the whole budget as new money when a promotion leaves test mode', () => {
    const test = draft({ testMode: true, budgetMinor: 250000n });
    expect(needsFreshSecondFactor(test, test, AU_RULES)).toBe(false);
    expect(needsFreshSecondFactor(test, { ...test, testMode: false }, AU_RULES)).toBe(true);
  });
});

// Phase 2 types.
const PRODUCT_2 = '01990000-0000-7000-8000-000000001002';
const base = {
  startsAt: '2026-11-01T00:00:00Z',
  endsAt: '2026-11-08T00:00:00Z',
};
const rawTiered = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'TIERED_CART',
  name: 'Spend more',
  funding: 'PLATFORM',
  budgetMinor: '100000',
  testMode: true,
  tiers: [
    { thresholdMinor: '10000', reward: { kind: 'FIXED', amountMinor: '1500' } },
    { thresholdMinor: '5000', reward: { kind: 'FIXED', amountMinor: '500' } },
  ],
  ...over,
});
const rawBxgy = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'BUY_X_GET_Y',
  name: 'Buy 2 get 1',
  funding: 'SELLER',
  buyQty: 2,
  getQty: 1,
  reward: { kind: 'PERCENT', bps: 10000 },
  productIds: [PRODUCT],
  ...over,
});
const rawMulti = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'MULTI_BUY',
  name: '3 for 10',
  funding: 'SELLER',
  groupQty: 3,
  groupPriceMinor: '1000',
  productIds: [PRODUCT],
  ...over,
});
const rawBundle = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'BUNDLE',
  name: 'Breakfast set',
  funding: 'SELLER',
  reward: { kind: 'FIXED', amountMinor: '400' },
  bundleItems: [
    { productId: PRODUCT, quantity: 1 },
    { productId: PRODUCT_2, quantity: 2 },
  ],
  ...over,
});
const rawFlash = (over: Record<string, unknown> = {}) => ({
  type: 'FLASH_SALE',
  name: 'Tonight only',
  funding: 'SELLER',
  reward: { kind: 'PERCENT', bps: 3000 },
  productIds: [PRODUCT],
  flash: {
    unitLimit: 50,
    timeZone: 'Australia/Brisbane',
    startsLocal: '2026-11-01T18:00',
    endsLocal: '2026-11-01T21:00',
  },
  ...over,
});
const rawBatch = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'BATCH_CODE',
  name: 'Newsletter codes',
  funding: 'PLATFORM',
  reward: { kind: 'FIXED', amountMinor: '500' },
  budgetMinor: '100000',
  testMode: true,
  ...over,
});

describe('phase 2 types: parseDraft', () => {
  it('derives the reward of a tiered cart from its highest tier and sorts the tiers', () => {
    const draft = parsed(rawTiered());
    expect(draft.tiers.map((t) => t.thresholdMinor)).toEqual([5000n, 10000n]);
    expect(draft.reward).toEqual({ kind: 'FIXED', amount: 1500n });
    expect(parseDraft(rawTiered({ reward: { kind: 'FIXED', amountMinor: '1' } })).ok).toBe(false);
    expect(parseDraft(rawTiered({ tiers: [] })).ok).toBe(false);
    expect(parseDraft(rawTiered({ tiers: undefined })).ok).toBe(false);
  });

  it('derives the reward of a multi-buy from its group price', () => {
    const draft = parsed(rawMulti());
    expect(draft).toMatchObject({ groupQty: 3, reward: { kind: 'FIXED', amount: 1000n } });
    expect(parseDraft(rawMulti({ groupPriceMinor: undefined })).ok).toBe(false);
  });

  it('takes the products of a bundle from its items', () => {
    const draft = parsed(rawBundle());
    expect(draft.productIds).toEqual([PRODUCT, PRODUCT_2]);
    expect(draft.bundleItems).toEqual([
      { productId: PRODUCT, quantity: 1 },
      { productId: PRODUCT_2, quantity: 2 },
    ]);
    expect(parseDraft(rawBundle({ productIds: [PRODUCT] })).ok).toBe(false);
    expect(parseDraft(rawBundle({ bundleItems: undefined })).ok).toBe(false);
    const twice = parseDraft(
      rawBundle({
        bundleItems: [
          { productId: PRODUCT, quantity: 1 },
          { productId: PRODUCT, quantity: 1 },
        ],
      }),
    );
    expect(twice.ok).toBe(false);
  });

  it('writes a flash window in the owning zone and stores the instants', () => {
    // Brisbane is UTC+10 all year: 18:00 to 21:00 local is 08:00 to 11:00 UTC.
    const draft = parsed(rawFlash());
    expect(draft.startsAt.toString()).toBe('2026-11-01T08:00:00Z');
    expect(draft.endsAt?.toString()).toBe('2026-11-01T11:00:00Z');
    expect(draft).toMatchObject({ flashUnitLimit: 50, flashTimeZone: 'Australia/Brisbane' });
    // The same wall-clock window in another zone is another instant.
    const berlin = parsed(
      rawFlash({ flash: { ...(rawFlash().flash as object), timeZone: 'Europe/Berlin' } }),
    );
    expect(berlin.startsAt.toString()).toBe('2026-11-01T17:00:00Z');
    // Plain instants work too, with the zone kept.
    const instants = parsed(
      rawFlash({
        ...base,
        flash: { unitLimit: 5, timeZone: 'Pacific/Auckland' },
      }),
    );
    expect(instants.startsAt.toString()).toBe('2026-11-01T00:00:00Z');
  });

  it('refuses a flash window that does not exist or happens twice in the zone, and an unknown zone', () => {
    const flash = (over: object) => ({ ...(rawFlash().flash as object), ...over });
    // Sydney clocks go forward on 2026-10-04 at 02:00 (the hour 02:00-03:00 does not exist) and
    // back on 2027-04-04 at 03:00 (02:00-03:00 happens twice).
    for (const startsLocal of ['2026-10-04T02:30', '2027-04-04T02:30']) {
      const result = parseDraft(
        rawFlash({
          flash: flash({
            timeZone: 'Australia/Sydney',
            startsLocal,
            endsLocal: '2027-04-05T12:00',
          }),
        }),
      );
      expect(result.ok ? [] : result.error).toContainEqual({
        path: 'flash.startsLocal',
        code: 'value',
      });
    }
    expect(parseDraft(rawFlash({ flash: flash({ timeZone: 'Not/AZone' }) })).ok).toBe(false);
    expect(parseDraft(rawFlash({ flash: flash({ unitLimit: 0 }) })).ok).toBe(false);
    expect(parseDraft(rawFlash({ flash: flash({ unitLimit: undefined }) })).ok).toBe(false);
    // Local times and instants together are ambiguous.
    expect(parseDraft(rawFlash({ startsAt: '2026-11-01T00:00:00Z' })).ok).toBe(false);
  });

  it('keeps the usual limits on the unit numbers', () => {
    expect(parseDraft(rawBxgy({ buyQty: 0 })).ok).toBe(false);
    expect(parseDraft(rawBxgy({ getQty: 1.5 })).ok).toBe(false);
    expect(parseDraft(rawBxgy({ buyQty: 100000 })).ok).toBe(false);
    expect(parseDraft(rawBxgy({ maxRepeatsPerOrder: -1 })).ok).toBe(false);
  });
});

describe.each([
  ['AU', AU_RULES],
  ['ZZ', ZZ_RULES],
] as const)('phase 2 types: checkDraft in market %s', (_code, rules) => {
  const codes = (draft: PromotionDraft, owner: Parameters<typeof checkDraft>[1]) =>
    checkDraft(draft, owner, rules).map((i) => `${i.path}:${i.code}`);
  // Platform money stays in test mode until the Market's ruling is confirmed.
  const platformDraft = (raw: Record<string, unknown>) => ({
    ...raw,
    testMode: !rules.gstRulingConfirmed,
  });

  it('lets a seller make the seller types and an admin the platform ones, not the reverse', () => {
    expect(codes(parsed(rawBxgy()), seller)).toEqual([]);
    expect(codes(parsed(rawMulti()), seller)).toEqual([]);
    expect(codes(parsed(rawBundle()), seller)).toEqual([]);
    expect(codes(parsed(rawFlash()), seller)).toEqual([]);
    expect(codes(parsed(rawTiered(platformDraft({}))), platform)).toEqual([]);
    expect(codes(parsed(rawBatch(platformDraft({}))), platform)).toEqual([]);
    expect(
      codes(
        parsed(rawFlash(platformDraft({ funding: 'PLATFORM', budgetMinor: '50000' }))),
        platform,
      ),
    ).toEqual([]);

    expect(codes(parsed(rawTiered({ funding: 'SELLER' })), seller)).toContain('type:not-allowed');
    expect(codes(parsed(rawBatch({ funding: 'SELLER' })), seller)).toContain('type:not-allowed');
    expect(
      codes(
        parsed(rawBxgy({ funding: 'PLATFORM', budgetMinor: '1000', testMode: true })),
        platform,
      ),
    ).toContain('type:not-allowed');
    expect(
      codes(
        parsed(rawMulti({ funding: 'PLATFORM', budgetMinor: '1000', testMode: true })),
        platform,
      ),
    ).toContain('type:not-allowed');
    expect(
      codes(
        parsed(rawBundle({ funding: 'PLATFORM', budgetMinor: '1000', testMode: true })),
        platform,
      ),
    ).toContain('type:not-allowed');
  });

  it('names the products of every item offer, and no code on a batch', () => {
    expect(codes(parsed(rawBxgy({ productIds: [] })), seller)).toContain('productIds:required');
    expect(codes(parsed(rawMulti({ productIds: [] })), seller)).toContain('productIds:required');
    expect(codes(parsed(rawFlash({ productIds: [] })), seller)).toContain('productIds:required');
    expect(codes(parsed(rawBatch(platformDraft({ code: 'SOMETHING' }))), platform)).toContain(
      'code:not-allowed',
    );
  });

  it('wants rising tiers of one kind, each fixed amount below its threshold', () => {
    const tiers = (list: unknown[]) =>
      codes(parsed(rawTiered(platformDraft({ tiers: list }))), platform);
    expect(
      tiers([
        { thresholdMinor: '5000', reward: { kind: 'PERCENT', bps: 500 } },
        { thresholdMinor: '10000', reward: { kind: 'FIXED', amountMinor: '900' } },
      ]),
    ).toContain('tiers.1.reward:mixed-kinds');
    expect(
      tiers([
        { thresholdMinor: '5000', reward: { kind: 'FIXED', amountMinor: '500' } },
        { thresholdMinor: '10000', reward: { kind: 'FIXED', amountMinor: '500' } },
      ]),
    ).toContain('tiers.1.reward:not-increasing');
    expect(
      tiers([{ thresholdMinor: '5000', reward: { kind: 'FIXED', amountMinor: '5000' } }]),
    ).toContain('tiers.0.reward.amountMinor:exceeds-threshold');
    expect(
      tiers([
        { thresholdMinor: '5000', reward: { kind: 'PERCENT', bps: 500 } },
        { thresholdMinor: '10000', reward: { kind: 'PERCENT', bps: 400 } },
      ]),
    ).toContain('tiers.1.reward:not-increasing');
    expect(codes(parsed(rawTiered(platformDraft({ minSpendMinor: '100' }))), platform)).toContain(
      'minSpendMinor:not-allowed',
    );
  });

  it('refuses the fields of another type and a flash sale without a real end', () => {
    expect(codes(parsed(rawBxgy({ groupQty: 3 })), seller)).toContain('groupQty:not-allowed');
    expect(codes(parsed(rawSale({ buyQty: 2 })), seller)).toContain('buyQty:not-allowed');
    expect(codes(parsed(rawSale({ maxRepeatsPerOrder: 2 })), seller)).toContain(
      'maxRepeatsPerOrder:not-allowed',
    );
    expect(
      codes(parsed(rawSale({ flash: { unitLimit: 5, timeZone: 'Australia/Brisbane' } })), seller),
    ).toContain('flash:not-allowed');
    expect(
      codes(
        parsed(
          rawFlash({
            flash: { unitLimit: 5, timeZone: 'Australia/Brisbane' },
            startsAt: '2026-11-01T00:00:00Z',
          }),
        ),
        seller,
      ),
    ).toContain('endsAt:required');
    expect(codes(parsed(rawMulti({ groupQty: 1 })), seller)).toContain('groupQty:value');
    expect(
      codes(parsed(rawBundle({ bundleItems: [{ productId: PRODUCT, quantity: 1 }] })), seller),
    ).toContain('bundleItems:too-few');
    expect(codes(parsed(rawBundle({ reward: { kind: 'PERCENT', bps: 1000 } })), seller)).toContain(
      'reward.kind:value',
    );
  });

  it('reads "buy X get Y" against the seller maximum as the share of a group it takes off', () => {
    // Buy 2 get 1 free is 3333 bps of a group: inside every Market's maximum.
    expect(codes(parsed(rawBxgy()), seller)).toEqual([]);
    // Buy 1 get 1 free is 5000 bps: at ZZ's maximum, which is allowed.
    const half = codes(parsed(rawBxgy({ buyQty: 1, getQty: 1 })), seller);
    expect(half).toEqual([]);
    // Buy 1 get 3 free is 7500 bps: above both Markets' maximum.
    expect(codes(parsed(rawBxgy({ buyQty: 1, getQty: 3 })), seller)).toEqual([
      'getQty:exceeds-seller-maximum',
    ]);
  });

  it('asks a new seller, and a deep "buy X get Y", for approval like a percent sale', () => {
    const facts = (draft: PromotionDraft, days: number | null) =>
      approvalReason({ sellerActiveDays: days, reward: approvalRewardOf(draft) }, rules);
    expect(facts(parsed(rawBxgy()), 400)).toBeNull();
    expect(facts(parsed(rawBxgy()), 1)).toBe('NEW_SELLER');
    // 5000 bps of a group is above ZZ's approval threshold (4000) and not above AU's (5000).
    expect(facts(parsed(rawBxgy({ buyQty: 1, getQty: 1 })), 400)).toBe(
      rules.priorApprovalDiscountBps < 5000 ? 'HIGH_DISCOUNT' : null,
    );
    // A group price and an amount off a set cannot be compared with a price here.
    expect(facts(parsed(rawMulti()), 400)).toBeNull();
    expect(facts(parsed(rawBundle()), 400)).toBeNull();
  });

  it('keeps the funding of the platform types and the layers', () => {
    expect(layerOf('TIERED_CART', platform)).toBe('PLATFORM_CART');
    expect(layerOf('BATCH_CODE', platform)).toBe('PLATFORM_CART');
    for (const type of ['BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'FLASH_SALE'] as const) {
      expect(layerOf(type, 'seller')).toBe('ITEM');
    }
    expect(codes(parsed(rawTiered(platformDraft({ budgetMinor: undefined }))), platform)).toContain(
      'budgetMinor:required',
    );
  });
});
