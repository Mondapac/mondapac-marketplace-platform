import {
  approvalReason,
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
