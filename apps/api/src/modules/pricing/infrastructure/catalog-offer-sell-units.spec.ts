import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { CatalogFacade, OfferSellUnits } from '../../catalog';
import { OfferSellUnitsUnavailableError } from '../application/ports/offer-sell-units';
import { CatalogOfferSellUnits } from './catalog-offer-sell-units';

// pricing's view of catalog's `offerSellUnits` (pricing design 5.2, 6.1 CF1; P-1): a deleted
// Offer has no priceable Variant, an extra key is ignored, a refusal or a failure throws, and the
// caller's context goes through unchanged. Both Market fixtures.

describe.each(['AU', 'ZZ'])('CatalogOfferSellUnits in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(
    new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z')),
  );
  const context = testCallContext(market, 'anonymous');

  function facade(answer: Awaited<ReturnType<CatalogFacade['offerSellUnits']>>) {
    const calls: { context: CallContext; ids: readonly Id<'Offer'>[] }[] = [];
    const catalog: CatalogFacade = {
      offerSellUnits: (ctx, offerIds) => {
        calls.push({ context: ctx, ids: offerIds });
        return Promise.resolve(answer);
      },
    };
    return { calls, source: new CatalogOfferSellUnits(catalog) };
  }

  const offer = (status: OfferSellUnits['status'], variants: Id<'Variant'>[]): OfferSellUnits => ({
    sellerId: ids.next<'Seller'>(),
    productId: ids.next<'Product'>(),
    status,
    listed: false,
    sellUnits: variants.map((variantId) => ({ variantId, state: 'proposed' as const })),
  });

  it('maps each requested Offer, with its sell units as the priceable Variants', async () => {
    const id = ids.next<'Offer'>();
    const variant = ids.next<'Variant'>();
    const answer = offer('draft', [variant]);
    const { calls, source } = facade(ok(new Map([[id, answer]])));

    const views = await source.sellUnitsOf(context, [id]);
    expect(views.get(id)).toEqual({
      sellerId: answer.sellerId,
      productId: answer.productId,
      deleted: false,
      priceableVariantIds: new Set([variant]),
    });
    expect(calls).toEqual([{ context, ids: [id] }]);
  });

  it('gives a deleted Offer no priceable Variant, whatever the answer lists', async () => {
    const id = ids.next<'Offer'>();
    const { source } = facade(ok(new Map([[id, offer('deleted', [ids.next<'Variant'>()])]])));
    const view = (await source.sellUnitsOf(context, [id])).get(id);
    expect(view?.deleted).toBe(true);
    expect(view?.priceableVariantIds.size).toBe(0);
  });

  it('ignores an Offer it did not ask for, and leaves an unanswered one absent', async () => {
    const asked = ids.next<'Offer'>();
    const extra = ids.next<'Offer'>();
    const { source } = facade(ok(new Map([[extra, offer('published', [])]])));
    const views = await source.sellUnitsOf(context, [asked]);
    expect(views.size).toBe(0);
  });

  it("answers absent for every Offer behind catalog's fail-closed placeholder (ADR-0031)", async () => {
    const { source } = facade(ok(new Map()));
    expect((await source.sellUnitsOf(context, [ids.next<'Offer'>()])).size).toBe(0);
  });

  it('throws on a refusal, and refuses more than 200 ids whole without calling catalog', async () => {
    const { source } = facade(err({ code: 'batch.too-large' }));
    await expect(source.sellUnitsOf(context, [ids.next<'Offer'>()])).rejects.toBeInstanceOf(
      OfferSellUnitsUnavailableError,
    );
    const quiet = facade(ok(new Map()));
    const many = Array.from({ length: 201 }, () => ids.next<'Offer'>());
    await expect(quiet.source.sellUnitsOf(context, many)).rejects.toBeInstanceOf(
      OfferSellUnitsUnavailableError,
    );
    expect(quiet.calls).toEqual([]);
  });
});
