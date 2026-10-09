import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OfferSellUnitsMap } from '../../contracts/catalog.facade';
import { parseOfferIds, type OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { OfferSellUnitsReader } from '../ports/offer-sell-units.reader';

export interface OfferSellUnitsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: OfferSellUnitsReader;
}

/**
 * The read shared by the pair (catalog design 9.1, data design 6.1 A1): the request is checked
 * whole before any read, then one read-only unit (ADR-0025) asks the store for the Offers of
 * the context's Market. The Market comes from the context only. An id that is unknown or of
 * another Market is absent. The answer carries ids, codes and flags, never a price, stock or
 * Cost (AC 6).
 */
export async function readSellUnits(
  deps: OfferSellUnitsDependencies,
  context: CallContext,
  offerIds: readonly string[],
): Promise<Result<OfferSellUnitsMap, OfferSellUnitsFailure>> {
  const ids = parseOfferIds(offerIds);
  if (!ids.ok) return ids;
  if (ids.value.size === 0) return ok(new Map());
  const requested: Id<'Offer'>[] = [...ids.value];
  return deps.unitOfWork.run<OfferSellUnitsMap, OfferSellUnitsFailure>(
    context.market,
    async () => ok(await deps.reader.read(context.market, requested)),
    { readOnly: true },
  );
}
