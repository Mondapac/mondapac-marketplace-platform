import type { Money } from '@mondapac/shared-kernel';
import type {
  BasketLine,
  BasketOption,
  BasketProposal,
  BasketStore,
  UncertainLine,
} from './plan-basket';

/** One sell unit of an Offer as the cart's add would take it (read through the cart facade). */
export interface SellUnit {
  readonly variantId: string;
  readonly unitPrice: Money;
  /** The highest quantity one cart line of the unit may hold now. */
  readonly maxQuantity: number;
}

/** The units read for each offer id; an offer that could not be read is simply absent. */
export type SellUnitsByOffer = ReadonlyMap<string, readonly SellUnit[]>;

/**
 * The unit of a product the card adds: the one whose price is the price shown; for a "from" price
 * (Variants at different prices) the cheapest unit, which is the price shown. Null when the units
 * were not read or none has that price, so the storefront does not add that line from the card.
 */
function unitFor(
  units: readonly SellUnit[] | undefined,
  price: Money,
  priceFrom: boolean,
): SellUnit | null {
  if (units === undefined) return null;
  const sameCurrency = units.filter((unit) => unit.unitPrice.currency === price.currency);
  if (priceFrom) {
    return (
      sameCurrency.reduce<SellUnit | null>(
        (cheapest, unit) =>
          cheapest === null || unit.unitPrice.amount < cheapest.unitPrice.amount ? unit : cheapest,
        null,
      ) ?? null
    );
  }
  return sameCurrency.find((unit) => unit.unitPrice.amount === price.amount) ?? null;
}

const optionWith = (option: BasketOption, units: SellUnitsByOffer): BasketOption => {
  const unit = unitFor(units.get(option.offerId), option.price, option.priceFrom);
  return { ...option, variantId: unit?.variantId ?? null, maxQuantity: unit?.maxQuantity ?? null };
};

const lineWith = (line: BasketLine, units: SellUnitsByOffer): BasketLine => {
  const unit = unitFor(units.get(line.offerId), line.price, line.priceFrom);
  return {
    ...line,
    variantId: unit?.variantId ?? null,
    maxQuantity: unit?.maxQuantity ?? null,
    alternatives: line.alternatives.map((option) => optionWith(option, units)),
  };
};

/** The offer ids of every line and option of a proposal, each once, in card order. */
export function offerIdsOf(proposal: BasketProposal): readonly string[] {
  const ids = new Set<string>();
  for (const store of proposal.stores) {
    for (const line of store.lines) {
      ids.add(line.offerId);
      for (const option of line.alternatives) ids.add(option.offerId);
    }
  }
  for (const line of proposal.uncertain) for (const option of line.options) ids.add(option.offerId);
  return [...ids];
}

/**
 * A proposal with the sell unit of each line and option filled in. Pure: only `variantId` and
 * `maxQuantity` change; the picks, quantities, prices and totals stay the planner's.
 */
export function attachSellUnits(proposal: BasketProposal, units: SellUnitsByOffer): BasketProposal {
  const stores: BasketStore[] = proposal.stores.map((store) => ({
    ...store,
    lines: store.lines.map((line) => lineWith(line, units)),
  }));
  const uncertain: UncertainLine[] = proposal.uncertain.map((line) => ({
    ...line,
    options: line.options.map((option) => optionWith(option, units)),
  }));
  return { ...proposal, stores, uncertain };
}
