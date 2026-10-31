import {
  SELLER_HEALTH_FORMULA_VERSION,
  bandOfScore,
  computeSellerHealth,
  type SellerHealthInput,
  type SellerHealthSettings,
} from './seller-health';

/** Australian proposal (plan 31 Oct 2026). Rates in basis points, rating in hundredths. */
const AU: SellerHealthSettings = {
  minOrders: 10,
  minReviews: 5,
  sellerCancellations: { healthyBelow: 250, atRiskUpTo: 500, zeroAt: 1000 },
  lateReady: { healthyBelow: 400, atRiskUpTo: 1000, zeroAt: 2000 },
  lostDisputes: { healthyBelow: 50, atRiskUpTo: 100, zeroAt: 200 },
  customerRating: { healthyFrom: 400, atRiskFrom: 350, best: 500, zeroAt: 100 },
  reports: { healthyBelow: 1, atRiskUpTo: 2, zeroAt: 5 },
};

/** Synthetic Market with deliberately different numbers: a test passing only for AU is a bug. */
const SYNTHETIC: SellerHealthSettings = {
  minOrders: 20,
  minReviews: 8,
  sellerCancellations: { healthyBelow: 100, atRiskUpTo: 300, zeroAt: 600 },
  lateReady: { healthyBelow: 800, atRiskUpTo: 1500, zeroAt: 3000 },
  lostDisputes: { healthyBelow: 20, atRiskUpTo: 60, zeroAt: 150 },
  customerRating: { healthyFrom: 430, atRiskFrom: 380, best: 500, zeroAt: 200 },
  reports: { healthyBelow: 2, atRiskUpTo: 4, zeroAt: 8 },
};

const clean = (over: Partial<SellerHealthInput> = {}): SellerHealthInput => ({
  orders: 100,
  sellerCancellations: { count: 0, base: 100 },
  lateReady: { count: 0, base: 100 },
  lostDisputes: { count: 0, base: 100 },
  customerRating: { count: 20, averageHundredths: 460 },
  reports: { count: 0 },
  ...over,
});

describe('bandOfScore', () => {
  it('splits at 67 and 34', () => {
    expect(bandOfScore(100)).toBe('healthy');
    expect(bandOfScore(67)).toBe('healthy');
    expect(bandOfScore(66)).toBe('at-risk');
    expect(bandOfScore(34)).toBe('at-risk');
    expect(bandOfScore(33)).toBe('unhealthy');
    expect(bandOfScore(0)).toBe('unhealthy');
  });
});

describe('computeSellerHealth', () => {
  it('scores a flawless seller 100 and stores the formula version', () => {
    const h = computeSellerHealth(
      clean({ customerRating: { count: 20, averageHundredths: 500 } }),
      AU,
    );
    expect(h).toMatchObject({ kind: 'scored', band: 'healthy', score: 100 });
    expect(h.formulaVersion).toBe(SELLER_HEALTH_FORMULA_VERSION);
  });

  it('puts exact band edges in the worse band', () => {
    const at = (count: number) =>
      computeSellerHealth(clean({ sellerCancellations: { count, base: 1000 } }), AU).metrics[0];
    expect(at(24)).toMatchObject({ band: 'healthy' }); // 2.4%
    expect(at(25)).toMatchObject({ band: 'at-risk', score: 66 }); // 2.5%
    expect(at(50)).toMatchObject({ band: 'at-risk', score: 34 }); // 5%
    expect(at(51)).toMatchObject({ band: 'unhealthy' }); // 5.1%
    expect(at(100)).toMatchObject({ band: 'unhealthy', score: 0 }); // 10%
    expect(at(500)).toMatchObject({ band: 'unhealthy', score: 0 });
  });

  it('is linear inside the healthy band', () => {
    const m = computeSellerHealth(clean({ lostDisputes: { count: 0, base: 100 } }), AU).metrics[3];
    expect(m).toMatchObject({ score: 100 });
    const half = computeSellerHealth(clean({ lostDisputes: { count: 25, base: 10000 } }), AU)
      .metrics[3];
    expect(half).toMatchObject({ band: 'healthy', score: 84 }); // 0.25% of 0.5%
  });

  it('takes the lowest metric and names it', () => {
    const h = computeSellerHealth(
      clean({
        sellerCancellations: { count: 12, base: 1000 },
        lateReady: { count: 74, base: 1000 },
        customerRating: { count: 23, averageHundredths: 460 },
      }),
      AU,
    );
    expect(h).toMatchObject({ kind: 'scored', band: 'at-risk', lowestMetric: 'late-ready' });
  });

  it('a serious problem is not covered by good metrics', () => {
    const h = computeSellerHealth(clean({ lostDisputes: { count: 30, base: 1000 } }), AU);
    expect(h).toMatchObject({ band: 'unhealthy', lowestMetric: 'lost-disputes' });
  });

  it('breaks a tie by metric order', () => {
    const h = computeSellerHealth(
      clean({
        sellerCancellations: { count: 25, base: 1000 },
        lateReady: { count: 0, base: 1000 },
      }),
      AU,
    );
    expect(h).toMatchObject({ lowestMetric: 'seller-cancellations' });
  });

  it('rating: higher is better, needs enough reviews', () => {
    const rate = (count: number, averageHundredths: number) =>
      computeSellerHealth(clean({ customerRating: { count, averageHundredths } }), AU).metrics[2];
    expect(rate(4, 100)).toEqual({ metric: 'customer-rating', kind: 'no-data' });
    expect(rate(5, 400)).toMatchObject({ band: 'healthy', score: 67 });
    expect(rate(5, 399)).toMatchObject({ band: 'at-risk' });
    expect(rate(5, 350)).toMatchObject({ band: 'at-risk', score: 34 });
    expect(rate(5, 349)).toMatchObject({ band: 'unhealthy' });
    expect(rate(5, 500)).toMatchObject({ score: 100 });
    expect(rate(5, 100)).toMatchObject({ score: 0 });
  });

  it('reports: 0 healthy, 1-2 at risk, 3+ unhealthy; null is no data', () => {
    const rep = (count: number) =>
      computeSellerHealth(clean({ reports: { count } }), AU).metrics[4];
    expect(rep(0)).toMatchObject({ band: 'healthy', score: 100 });
    expect(rep(1)).toMatchObject({ band: 'at-risk', score: 66 });
    expect(rep(2)).toMatchObject({ band: 'at-risk', score: 34 });
    expect(rep(3)).toMatchObject({ band: 'unhealthy' });
    expect(computeSellerHealth(clean({ reports: null }), AU).metrics[4]).toEqual({
      metric: 'reports',
      kind: 'no-data',
    });
  });

  it('a metric without data does not count in the overall score', () => {
    const h = computeSellerHealth(
      clean({ reports: null, customerRating: { count: 0, averageHundredths: 0 } }),
      AU,
    );
    expect(h).toMatchObject({ kind: 'scored', band: 'healthy' });
  });

  it('is New below the minimum orders, whatever the metrics say', () => {
    expect(computeSellerHealth(clean({ orders: 9 }), AU).kind).toBe('new');
    expect(computeSellerHealth(clean({ orders: 10 }), AU).kind).toBe('scored');
  });

  it('has no overall score when no metric has data', () => {
    const h = computeSellerHealth(
      clean({
        sellerCancellations: { count: 0, base: 0 },
        lateReady: { count: 0, base: 0 },
        lostDisputes: { count: 0, base: 0 },
        customerRating: { count: 0, averageHundredths: 0 },
        reports: null,
      }),
      AU,
    );
    expect(h.kind).toBe('no-data');
  });

  it('uses the Market settings, not AU numbers', () => {
    const input = clean({ orders: 15, sellerCancellations: { count: 15, base: 1000 } }); // 1.5%
    expect(computeSellerHealth(input, AU).metrics[0]).toMatchObject({ band: 'healthy' });
    expect(computeSellerHealth(input, SYNTHETIC).kind).toBe('new'); // 15 < 20 orders
    expect(computeSellerHealth({ ...input, orders: 30 }, SYNTHETIC).metrics[0]).toMatchObject({
      band: 'at-risk',
    });
    expect(
      computeSellerHealth(
        clean({ customerRating: { count: 7, averageHundredths: 460 } }),
        SYNTHETIC,
      ).metrics[2],
    ).toEqual({ metric: 'customer-rating', kind: 'no-data' }); // 7 < 8 reviews
  });

  it('refuses nonsense input and mis-ordered settings', () => {
    expect(() => computeSellerHealth(clean({ orders: -1 }), AU)).toThrow(RangeError);
    expect(() => computeSellerHealth(clean({ lateReady: { count: 5, base: 2 } }), AU)).toThrow(
      RangeError,
    );
    expect(() =>
      computeSellerHealth(clean(), {
        ...AU,
        lateReady: { healthyBelow: 500, atRiskUpTo: 400, zeroAt: 900 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSellerHealth(clean(), {
        ...AU,
        customerRating: { ...AU.customerRating, zeroAt: 380 },
      }),
    ).toThrow(RangeError);
  });
});
