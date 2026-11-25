import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  FLAGS_OFF,
  InMemorySellerReviewStandings,
  memoryProbation,
} from '../../../../test/support/catalog-seller-review-fakes';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';

const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');
const at = (minutes: number) => T0.add({ minutes });
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const product = (n: number) =>
  `01990000-0000-7000-8000-0000000d00${n.toString(16).padStart(2, '0')}` as Id<'Product'>;
const offer = (n: number) =>
  `01990000-0000-7000-8000-0000000e00${n.toString(16).padStart(2, '0')}` as Id<'Offer'>;

describe.each(TEST_MARKET_IDS)('SellerReviewProbation in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(market, 'system');
  const other = TEST_MARKET_IDS.find((m) => m !== code)!;

  async function approve(
    rig: ReturnType<typeof memoryProbation>,
    n: number,
    now = at(n),
    seller = SELLER,
  ) {
    const prepared = await rig.probation.prepare(context, seller);
    await rig.probation.recordApproval(context, prepared, {
      productId: product(n),
      offerId: offer(n),
      now,
    });
  }
  async function changesNeeded(rig: ReturnType<typeof memoryProbation>, now: Temporal.Instant) {
    const prepared = await rig.probation.prepare(context, SELLER);
    await rig.probation.recordChangesNeeded(context, prepared, now);
  }
  const standing = (rig: ReturnType<typeof memoryProbation>) =>
    rig.standings.rows.get(`${code}|${SELLER}`);

  it('creates the standing lazily and credits each approved product once per epoch', async () => {
    const rig = memoryProbation({ probationOffers: 3 });
    await approve(rig, 1);
    await approve(rig, 1, at(2)); // the same product again (delete and recreate gains nothing)
    await approve(rig, 2);
    expect(standing(rig)).toMatchObject({ epoch: 1, trustedAt: null });
    expect(rig.standings.credits.map((c) => c.productId)).toEqual([product(1), product(2)]);
    expect(rig.audits).toEqual([]);
  });

  it('stamps Trusted at the target, audits it once, and counts nothing after', async () => {
    const rig = memoryProbation({ probationOffers: 2 });
    await approve(rig, 1);
    await approve(rig, 2, at(5));
    expect(standing(rig)?.trustedAt).toEqual(at(5));
    expect(rig.audits).toEqual([
      expect.objectContaining({
        action: 'catalog.seller-review.trusted',
        targetId: SELLER,
        after: { epoch: 1, count: 2, target: 2 },
      }),
    ]);
    await approve(rig, 3);
    expect(rig.standings.credits).toHaveLength(2);
    expect(rig.audits).toHaveLength(1);
  });

  it('raises the version by exactly one per write (lock, then save)', async () => {
    const rig = memoryProbation({ probationOffers: 1 });
    await approve(rig, 1);
    // Inserted at 1, locked to 2, saved to 3.
    expect(standing(rig)?.version).toBe(3);
  });

  it('credits nothing while the seller is Trusted from start (after the last revocation)', async () => {
    const rig = memoryProbation({
      flags: { ...FLAGS_OFF, trustedFromStart: { on: true, at: T0 } },
    });
    await approve(rig, 1);
    expect(rig.standings.credits).toEqual([]);
  });

  it('counts as probation when sellers cannot answer (the stricter answer)', async () => {
    const rig = memoryProbation({ flags: null, probationOffers: 1 });
    await approve(rig, 1);
    expect(standing(rig)?.trustedAt).not.toBeNull();
  });

  it('restarts the epoch on the second Changes needed in a row and audits it', async () => {
    const rig = memoryProbation({ probationOffers: 5 });
    await approve(rig, 1);
    await changesNeeded(rig, at(10));
    expect(standing(rig)).toMatchObject({ epoch: 1, consecutiveChangesNeeded: 1 });
    await changesNeeded(rig, at(11));
    expect(standing(rig)).toMatchObject({ epoch: 2, consecutiveChangesNeeded: 0 });
    expect(rig.audits).toEqual([
      expect.objectContaining({ action: 'catalog.seller-review.restarted', after: { epoch: 2 } }),
    ]);
    // The new epoch counts from zero: the earlier product counts again.
    await approve(rig, 1, at(12));
    expect(rig.standings.credits.filter((c) => c.epoch === 2)).toHaveLength(1);
  });

  it('an approval between two Changes needed breaks the row (seller-wide)', async () => {
    const rig = memoryProbation({ probationOffers: 5 });
    await changesNeeded(rig, at(1));
    await approve(rig, 1, at(2));
    await changesNeeded(rig, at(3));
    expect(standing(rig)).toMatchObject({ epoch: 1, consecutiveChangesNeeded: 1 });
  });

  it('ignores Changes needed once Trusted, and stamps a count N was lowered under', async () => {
    let n = 5;
    const rig = memoryProbation({ probationOffers: () => n });
    await approve(rig, 1);
    await approve(rig, 2);
    n = 2;
    await changesNeeded(rig, at(20));
    expect(standing(rig)).toMatchObject({ trustedAt: at(20), consecutiveChangesNeeded: 0 });
    expect(rig.audits.map((a) => a.action)).toEqual(['catalog.seller-review.trusted']);
    // Raising N again never demotes the stamped seller.
    n = 50;
    await changesNeeded(rig, at(21));
    expect(standing(rig)).toMatchObject({ epoch: 1, trustedAt: at(20) });
  });

  it('stampTrust stamps only when the count meets N under the lock', async () => {
    const rig = memoryProbation({ probationOffers: 5 });
    await approve(rig, 1);
    await rig.probation.stampTrust(context, { sellerId: SELLER, probationOffers: 2, now: at(30) });
    expect(standing(rig)?.trustedAt).toBeNull();
    await rig.probation.stampTrust(context, { sellerId: SELLER, probationOffers: 1, now: at(31) });
    expect(standing(rig)?.trustedAt).toEqual(at(31));
  });

  it("keeps each Market's standing apart", async () => {
    const standings = new InMemorySellerReviewStandings();
    const rig = memoryProbation({ standings, probationOffers: 1 });
    const foreign = testCallContext(testMarketContext(other, 'default'), 'system');
    const prepared = await rig.probation.prepare(foreign, SELLER);
    await rig.probation.recordApproval(foreign, prepared, {
      productId: product(1),
      offerId: offer(1),
      now: at(1),
    });
    expect(standing(rig)).toBeUndefined();
    expect(standings.rows.get(`${other}|${SELLER}`)?.trustedAt).toEqual(at(1));
  });
});
