import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade, OfferSellUnits } from '../../catalog';
import type { InventoryFacade } from '../../inventory';
import type { PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import {
  verdictKey,
  type LineFactsSource,
  type LineVerdict,
  type SellUnitRef,
} from '../application/ports/line-facts';

const BATCH = 100;

const checkUnavailable: LineVerdict = {
  state: 'check-unavailable',
  reason: null,
  sellerId: null,
  unitPrice: null,
  taxInclusive: null,
  availability: null,
};

const unavailable = (
  reason: NonNullable<LineVerdict['reason']>,
  sellerId: Id<'Seller'> | null = null,
): LineVerdict => ({ ...checkUnavailable, state: 'unavailable', reason, sellerId });

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

/**
 * Asks catalog, sellers, pricing and inventory (cart design 3.2, 6.2): round one checks that the
 * Offer is published and listed, that the sell unit is published and that the seller may sell;
 * round two reads the price and the stock of what is left. A failed facade makes the affected
 * units `check-unavailable` (fail closed), never an exception.
 */
export class FacadeLineFacts implements LineFactsSource {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly sellers: SellersFacade,
    private readonly pricing: PricingFacade,
    private readonly inventory: InventoryFacade,
  ) {}

  async evaluate(
    context: CallContext,
    refs: readonly SellUnitRef[],
  ): Promise<ReadonlyMap<string, LineVerdict>> {
    const verdicts = new Map<string, LineVerdict>();
    if (refs.length === 0) return verdicts;
    for (const ref of refs) verdicts.set(verdictKey(ref), checkUnavailable);

    const offerIds = [...new Set(refs.map((ref) => ref.offerId))];
    // Catalog takes at most 200 Offers per call.
    const catalogAnswers = await Promise.all(
      chunks(offerIds, 200).map((ids) =>
        this.safe(() => this.catalog.offerSellUnits(context, ids)),
      ),
    );
    const sellUnitsByOffer = new Map<Id<'Offer'>, OfferSellUnits>();
    let catalogFailed = false;
    for (const answer of catalogAnswers) {
      if (answer === null || !answer.ok) {
        catalogFailed = true;
        continue;
      }
      for (const [offerId, value] of answer.value) sellUnitsByOffer.set(offerId, value);
    }
    if (catalogFailed && sellUnitsByOffer.size === 0) return verdicts;

    // Round one, part two: may the seller sell.
    const candidates: { ref: SellUnitRef; sellerId: Id<'Seller'> }[] = [];
    for (const ref of refs) {
      const offer = sellUnitsByOffer.get(ref.offerId);
      if (offer === undefined) {
        // Absent from a complete answer means unknown or deleted; from a partial one, unknown.
        if (!catalogFailed) verdicts.set(verdictKey(ref), unavailable('offer-unavailable'));
        continue;
      }
      const unit = offer.sellUnits.find((u) => u.variantId === ref.variantId);
      if (
        offer.status !== 'published' ||
        !offer.listed ||
        unit === undefined ||
        unit.state !== 'published'
      ) {
        verdicts.set(verdictKey(ref), unavailable('offer-unavailable', offer.sellerId));
        continue;
      }
      candidates.push({ ref, sellerId: offer.sellerId });
    }
    if (candidates.length === 0) return verdicts;

    const sellerIds = [...new Set(candidates.map((c) => c.sellerId))];
    const eligible = new Map<Id<'Seller'>, boolean>();
    const sellerAnswers = await Promise.all(
      chunks(sellerIds, BATCH).map((ids) =>
        this.safe(() => this.sellers.sellingEligibility(context, ids)),
      ),
    );
    for (const answer of sellerAnswers) {
      if (answer === null || !answer.ok) continue;
      for (const [sellerId, value] of answer.value) eligible.set(sellerId, value.eligible);
    }
    const sellable: typeof candidates = [];
    for (const candidate of candidates) {
      const answer = eligible.get(candidate.sellerId);
      if (answer === undefined) {
        verdicts.set(verdictKey(candidate.ref), {
          ...checkUnavailable,
          sellerId: candidate.sellerId,
        });
      } else if (!answer) {
        verdicts.set(
          verdictKey(candidate.ref),
          unavailable('seller-not-eligible', candidate.sellerId),
        );
      } else {
        sellable.push(candidate);
      }
    }
    if (sellable.length === 0) return verdicts;

    // Round two: price and stock, in parallel.
    const keys = sellable.map((c) => ({ offerId: c.ref.offerId, variantId: c.ref.variantId }));
    const [priceAnswers, stockAnswers] = await Promise.all([
      Promise.all(
        chunks(keys, 200).map((part) =>
          this.safe(() => this.pricing.effectivePrices(context, part)),
        ),
      ),
      Promise.all(
        chunks(keys, 200).map((part) =>
          this.safe(() => this.inventory.availability(context, part)),
        ),
      ),
    ]);
    const prices = new Map<string, { price: LineVerdict['unitPrice']; taxInclusive: boolean }>();
    let pricesFailed = false;
    for (const answer of priceAnswers) {
      if (answer === null || !answer.ok) {
        pricesFailed = true;
        continue;
      }
      for (const [key, value] of answer.value) {
        prices.set(key, { price: value.price, taxInclusive: value.taxInclusive });
      }
    }
    const stock = new Map<
      string,
      { status: 'in-stock' | 'low' | 'out'; onlyLeft: number | null; sellable: number }
    >();
    let stockFailed = false;
    for (const answer of stockAnswers) {
      if (answer === null || !answer.ok) {
        stockFailed = true;
        continue;
      }
      for (const [key, value] of answer.value) stock.set(key, value);
    }

    for (const { ref, sellerId } of sellable) {
      const key = verdictKey(ref);
      const price = prices.get(key);
      const level = stock.get(key);
      if ((price === undefined && pricesFailed) || (level === undefined && stockFailed)) {
        verdicts.set(key, { ...checkUnavailable, sellerId });
        continue;
      }
      if (price === undefined) {
        verdicts.set(key, unavailable('no-valid-price', sellerId));
        continue;
      }
      const availability =
        level === undefined
          ? { status: 'out' as const, onlyLeft: null }
          : { status: level.status, onlyLeft: level.onlyLeft };
      if (availability.status === 'out') {
        verdicts.set(key, {
          state: 'unavailable',
          reason: 'out-of-stock',
          sellerId,
          unitPrice: price.price,
          taxInclusive: price.taxInclusive,
          availability,
        });
        continue;
      }
      verdicts.set(key, {
        state: 'buyable',
        reason: null,
        sellerId,
        unitPrice: price.price,
        taxInclusive: price.taxInclusive,
        availability,
      });
    }
    return verdicts;
  }

  /** A facade that throws is a failed facade (fail closed). */
  private async safe<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      return null;
    }
  }
}
