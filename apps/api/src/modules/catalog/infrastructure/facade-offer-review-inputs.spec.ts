import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferReviewPolicySettings, SettingsFacade } from '../../settings';
import {
  FLAGS_OFF,
  InMemorySellerReviewStandings,
} from '../../../../test/support/catalog-seller-review-fakes';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CategoryOfferReviewFlagsStore } from '../application/ports/category-offer-review-flags.store';
import {
  CategoryPathsUnavailableError,
  type CategoryPathsReader,
} from '../application/ports/category-paths.reader';
import { SAFE_OFFER_REVIEW_SETTINGS } from '../application/ports/offer-review';
import type { SellerOfferReviewFlags } from '../application/ports/seller-offer-review-flags.reader';
import type { FlaggedCategory } from '../domain/category-offer-review-flags';
import { SellerReviewStanding } from '../domain/seller-review-standing';
import { FacadeOfferReviewInputs } from './facade-offer-review-inputs';

const POLICY: OfferReviewPolicySettings = {
  mode: 'risk-based',
  probationOffers: 10,
  referenceSellers: 3,
  priceBandPercent: 50,
  samplingPercent: 5,
  certificateBadges: 'review',
  emergencyStop: false,
};
const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-00000000d001' as Id<'Product'>;
const OFFER = (n: number) => `01990000-0000-7000-8000-0000000e000${n}` as Id<'Offer'>;
const PRODUCTS = (n: number) => `01990000-0000-7000-8000-0000000d100${n}` as Id<'Product'>;

/** A unit of work that runs the body (no database). */
const UNIT: UnitOfWork = {
  run: (_market: MarketContext, body: () => Promise<unknown>) => body(),
} as unknown as UnitOfWork;

interface Rig {
  policy?: () => Promise<unknown>;
  flags?: SellerOfferReviewFlags | null | 'throw';
  standings?: InMemorySellerReviewStandings;
  flagged?: readonly FlaggedCategory[] | 'throw';
  productCategories?: readonly string[];
  /** The category tree: child to parent. */
  parents?: Readonly<Record<string, string>>;
  pathsFail?: boolean;
}

function inputsWith(rig: Rig = {}) {
  const settings = {
    offerReviewPolicy: rig.policy ?? (() => Promise.resolve(POLICY)),
  } as unknown as SettingsFacade;
  const categoryFlags = {
    listFlagged: () =>
      rig.flagged === 'throw'
        ? Promise.reject(new Error('down'))
        : Promise.resolve((rig.flagged ?? []).map((row) => ({ ...row, version: 1 }))),
    publishedCategoryIds: () => Promise.resolve(rig.productCategories ?? []),
  } as unknown as CategoryOfferReviewFlagsStore;
  const categoryPaths = {
    livePaths: (_market: MarketContext, ids: readonly string[]) => {
      if (rig.pathsFail === true) {
        return Promise.reject(new CategoryPathsUnavailableError('loop'));
      }
      return Promise.resolve(
        ids.map((leaf) => {
          const path = [leaf];
          for (let at = rig.parents?.[leaf]; at !== undefined; at = rig.parents?.[at]) {
            path.unshift(at);
          }
          return path;
        }),
      );
    },
  } as unknown as CategoryPathsReader;
  return new FacadeOfferReviewInputs({
    settings,
    sellerFlags: {
      flagsOf: () =>
        rig.flags === 'throw'
          ? Promise.reject(new Error('sellers down'))
          : Promise.resolve(rig.flags === undefined ? FLAGS_OFF : rig.flags),
    },
    unitOfWork: UNIT,
    standings: rig.standings ?? new InMemorySellerReviewStandings(),
    categoryFlags,
    categoryPaths,
  });
}

describe.each(TEST_MARKET_IDS)('FacadeOfferReviewInputs in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(market, 'anonymous');
  const subject = { sellerId: SELLER, productId: PRODUCT };

  /** A standing with `count` credits in epoch 1. */
  async function standingWith(count: number, patch: { trustedAt?: Temporal.Instant } = {}) {
    const standings = new InMemorySellerReviewStandings();
    const start = SellerReviewStanding.start({ marketId: code, sellerId: SELLER, now: T0 });
    standings.rows.set(`${code}|${SELLER}`, { ...start.state, ...patch });
    for (let n = 0; n < count; n += 1) {
      await standings.credit(market, {
        sellerId: SELLER,
        epoch: 1,
        productId: PRODUCTS(n),
        offerId: OFFER(n),
        creditedAt: T0,
      });
    }
    return standings;
  }

  describe('settings', () => {
    it('passes the stored mode and badge setting through', async () => {
      for (const mode of ['all', 'risk-based', 'off'] as const) {
        const inputs = inputsWith({
          policy: () => Promise.resolve({ ...POLICY, mode, certificateBadges: 'automatic' }),
        });
        expect(await inputs.settings(context)).toEqual({
          mode,
          certificateBadges: 'automatic',
          emergencyStop: false,
        });
      }
    });

    it('answers review everything when the facade throws (fail closed)', async () => {
      const inputs = inputsWith({ policy: () => Promise.reject(new Error('settings down')) });
      expect(await inputs.settings(context)).toEqual(SAFE_OFFER_REVIEW_SETTINGS);
    });

    it('reads an unknown mode as all and an unknown badge setting as review', async () => {
      const inputs = inputsWith({
        policy: () => Promise.resolve({ ...POLICY, mode: 'bogus', certificateBadges: 'weird' }),
      });
      expect(await inputs.settings(context)).toEqual({
        mode: 'all',
        certificateBadges: 'review',
        emergencyStop: false,
      });
    });

    it('passes the emergency stop through only when it is exactly true', async () => {
      const on = inputsWith({ policy: () => Promise.resolve({ ...POLICY, emergencyStop: true }) });
      expect((await on.settings(context)).emergencyStop).toBe(true);
      const odd = inputsWith({
        policy: () => Promise.resolve({ ...POLICY, emergencyStop: 'yes' }),
      });
      expect((await odd.settings(context)).emergencyStop).toBe(false);
    });

    it('reads N, and the safe 100 when it is out of bounds or cannot be read', async () => {
      expect(await inputsWith().probationOffers(context)).toBe(10);
      for (const odd of [-1, 101, 2.5, 'ten']) {
        const inputs = inputsWith({
          policy: () => Promise.resolve({ ...POLICY, probationOffers: odd }),
        });
        expect(await inputs.probationOffers(context)).toBe(100);
      }
      const down = inputsWith({ policy: () => Promise.reject(new Error('down')) });
      expect(await down.probationOffers(context)).toBe(100);
    });
  });

  describe('facts', () => {
    it('counts a new seller as in probation, every other fact off, not degraded', async () => {
      expect(await inputsWith().facts(context, subject)).toEqual({
        emergencyStop: false,
        probation: true,
        fullReview: false,
        sensitiveCategory: false,
        degraded: false,
        stampTrust: false,
        probationOffers: 10,
      });
    });

    it('is out of probation at the target, or with a stamped trustedAt whatever N is', async () => {
      const reached = inputsWith({ standings: await standingWith(10) });
      expect(await reached.facts(context, subject)).toMatchObject({
        probation: false,
        stampTrust: true,
      });
      const stamped = inputsWith({
        standings: await standingWith(3, { trustedAt: T0 }),
        policy: () => Promise.resolve({ ...POLICY, probationOffers: 50 }),
      });
      expect(await stamped.facts(context, subject)).toMatchObject({
        probation: false,
        stampTrust: false,
      });
      const below = inputsWith({ standings: await standingWith(9) });
      expect((await below.facts(context, subject)).probation).toBe(true);
    });

    it('has no probation when N is 0, and asks for the stamp only with a standing', async () => {
      const zero = () => Promise.resolve({ ...POLICY, probationOffers: 0 });
      expect(await inputsWith({ policy: zero }).facts(context, subject)).toMatchObject({
        probation: false,
        stampTrust: false,
      });
      const known = inputsWith({ policy: zero, standings: await standingWith(0) });
      expect((await known.facts(context, subject)).stampTrust).toBe(true);
    });

    it('reads Trusted from start, the full-review flag and the seller stop', async () => {
      const inputs = inputsWith({
        flags: {
          trustedFromStart: { on: true, at: T0 },
          fullReview: { on: true, at: T0 },
          reviewStop: { on: true, at: T0 },
        },
      });
      expect(await inputs.facts(context, subject)).toMatchObject({
        probation: false,
        fullReview: true,
        emergencyStop: true,
        degraded: false,
        stampTrust: false,
      });
    });

    it('fails closed when sellers cannot answer: probation and full review, no invented stop', async () => {
      for (const flags of [null, 'throw'] as const) {
        const inputs = inputsWith({ flags, standings: await standingWith(20) });
        expect(await inputs.facts(context, subject)).toMatchObject({
          probation: true,
          fullReview: true,
          emergencyStop: false,
          degraded: true,
          stampTrust: false,
        });
      }
    });

    it('fails closed when the standing cannot be read: probation, degraded', async () => {
      const standings = await standingWith(20);
      standings.failNext = true;
      expect(await inputsWith({ standings }).facts(context, subject)).toMatchObject({
        probation: true,
        fullReview: false,
        degraded: true,
        stampTrust: false,
      });
    });

    it('applies R7 and the category stop of a category or any ancestor', async () => {
      const parents = { lamb: 'meat', meat: 'food' };
      const r7 = inputsWith({
        flagged: [{ categoryId: 'meat', alwaysReview: true, reviewStop: false }],
        productCategories: ['lamb'],
        parents,
      });
      expect(await r7.facts(context, subject)).toMatchObject({
        sensitiveCategory: true,
        emergencyStop: false,
        degraded: false,
      });
      const stop = inputsWith({
        flagged: [{ categoryId: 'food', alwaysReview: false, reviewStop: true }],
        productCategories: ['lamb'],
        parents,
      });
      expect(await stop.facts(context, subject)).toMatchObject({
        sensitiveCategory: false,
        emergencyStop: true,
      });
      const elsewhere = inputsWith({
        flagged: [{ categoryId: 'home', alwaysReview: true, reviewStop: true }],
        productCategories: ['lamb'],
        parents,
      });
      expect(await elsewhere.facts(context, subject)).toMatchObject({
        sensitiveCategory: false,
        emergencyStop: false,
      });
    });

    it('fails closed when the categories cannot be read: sensitive, degraded, no invented stop', async () => {
      for (const rig of [
        { flagged: 'throw' as const },
        {
          flagged: [{ categoryId: 'x', alwaysReview: true, reviewStop: true }],
          productCategories: ['lamb'],
          pathsFail: true,
        },
      ]) {
        expect(await inputsWith(rig).facts(context, subject)).toMatchObject({
          sensitiveCategory: true,
          emergencyStop: false,
          degraded: true,
        });
      }
    });

    it('never answers a seller another Market holds (the standing is read per Market)', async () => {
      const standings = await standingWith(20);
      const other = TEST_MARKET_IDS.find((m) => m !== code)!;
      const foreign = testCallContext(testMarketContext(other, 'default'), 'anonymous');
      expect((await inputsWith({ standings }).facts(foreign, subject)).probation).toBe(true);
    });
  });
});
