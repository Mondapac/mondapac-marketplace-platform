import {
  bayesTimes1000,
  boostPpm,
  MAX_WEIGHT_BPS,
  NEUTRAL_BOOST_PPM,
  priorMeanTimes1000,
  ratingRow,
  type RatingBoostSettings,
} from './rating-boost';

const AU: RatingBoostSettings = { weightBps: 1000, priorCount: 10, priorMeanTimes100: 400 };
const ZZ: RatingBoostSettings = { weightBps: 500, priorCount: 5, priorMeanTimes100: 300 };

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
] as const)('the rating boost in market %s', (_code, boost) => {
  const prior = priorMeanTimes1000(boost);

  it('puts a product with no ratings exactly at the prior mean, with no change to relevance', () => {
    expect(bayesTimes1000(0, 0, boost)).toBe(prior);
    expect(boostPpm(prior, boost)).toBe(NEUTRAL_BOOST_PPM);
  });

  it('never lets the boost leave the Market weight, and the weight never leaves 10 %', () => {
    const swing = (boost.weightBps * 100) | 0;
    for (const bayes of [0, 1000, 2500, 5000]) {
      const ppm = boostPpm(bayes, boost);
      expect(ppm).toBeGreaterThanOrEqual(NEUTRAL_BOOST_PPM - swing);
      expect(ppm).toBeLessThanOrEqual(NEUTRAL_BOOST_PPM + swing);
      expect(ppm).toBeGreaterThanOrEqual(900_000);
      expect(ppm).toBeLessThanOrEqual(1_100_000);
    }
    // A config beyond the cap (the Zod schema refuses it) is clamped here too.
    expect(boostPpm(5000, { ...boost, weightBps: 5000 })).toBe(
      boostPpm(5000, { ...boost, weightBps: MAX_WEIGHT_BPS }),
    );
    expect(boostPpm(5000, { ...boost, weightBps: 5000 })).toBeLessThanOrEqual(1_100_000);
    expect(boostPpm(0, { ...boost, weightBps: 5000 })).toBe(1_000_000 - MAX_WEIGHT_BPS * 100);
    expect(boostPpm(5000, { ...boost, weightBps: 0 })).toBe(NEUTRAL_BOOST_PPM);
  });

  it('rises with the stars and with the number of ratings at a good average', () => {
    const rows = [
      ratingRow(10, 20, boost),
      ratingRow(10, 30, boost),
      ratingRow(10, 40, boost),
      ratingRow(10, 45, boost),
    ];
    const byCount = [ratingRow(1, 5, boost), ratingRow(10, 47, boost), ratingRow(200, 940, boost)];
    for (let i = 1; i < byCount.length; i += 1) {
      expect(byCount[i]!.bayesTimes1000).toBeGreaterThan(byCount[i - 1]!.bayesTimes1000);
    }
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.bayesTimes1000).toBeGreaterThan(rows[i - 1]!.bayesTimes1000);
      expect(rows[i]!.boostPpm).toBeGreaterThanOrEqual(rows[i - 1]!.boostPpm);
    }
  });

  it('is not fooled by one five-star review against many good ones', () => {
    expect(ratingRow(1, 5, boost).bayesTimes1000).toBeLessThan(
      ratingRow(200, 940, boost).bayesTimes1000,
    );
  });

  it('keeps every stored value inside the table CHECKs', () => {
    for (const [count, sum] of [
      [1, 1],
      [1, 5],
      [3, 15],
      [1000, 5000],
      [1000, 1000],
    ] as const) {
      const row = ratingRow(count, sum, boost);
      expect(row.bayesTimes1000).toBeGreaterThanOrEqual(0);
      expect(row.bayesTimes1000).toBeLessThanOrEqual(5000);
      expect(row.boostPpm).toBeGreaterThanOrEqual(900_000);
      expect(row.boostPpm).toBeLessThanOrEqual(1_100_000);
    }
  });
});

it('computes the Bayesian average in whole thousandths, rounded', () => {
  // (10 * 4.00 + 5) / 11 = 4.0909...
  expect(bayesTimes1000(1, 5, AU)).toBe(4091);
  // (10 * 4.00 + 940) / 210 = 4.6667
  expect(bayesTimes1000(200, 940, AU)).toBe(4667);
});
