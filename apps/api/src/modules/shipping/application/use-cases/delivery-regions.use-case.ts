import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_REPORT_REGIONS,
  type DeliveryRegions,
  type ShippingReportingFailure,
} from '../../contracts/shipping-reporting.facade';
import type { ShippingDependencies } from '../shipping-dependencies';

interface Input {
  readonly quoteIds: unknown;
  readonly pickupSellerIds: unknown;
}

/** The ids of a list, checked whole: null when it is not a list of at most the limit of ids. */
function idsOf<T extends string>(value: unknown): Id<T>[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORT_REGIONS) return null;
  const ids = new Set<Id<T>>();
  for (const item of value as readonly unknown[]) {
    const id = parseId<T>(typeof item === 'string' ? item : '');
    if (!id.ok) return null;
    ids.add(id.value);
  }
  return [...ids];
}

/**
 * `shipping.delivery-regions`: the region (state) of the drop-off of some charged quotes and of the
 * pickup of some sellers, for reporting (dashboards v2, phase 1). Rule `system`. The postcodes are
 * read and mapped here, with the Market's `shipping.postcodeRegions`; only the region code leaves
 * shipping, so reporting never holds a postcode. The request is checked whole before any read.
 */
export class DeliveryRegionsQuery extends UseCase<
  Input,
  DeliveryRegions,
  ShippingReportingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.delivery-regions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<DeliveryRegions, ShippingReportingFailure>> {
    const quoteIds = idsOf<'DeliveryQuote'>(input?.quoteIds);
    const sellerIds = idsOf<'Seller'>(input?.pickupSellerIds);
    if (quoteIds === null || sellerIds === null) return err({ code: 'validation.failed' });
    const market = context.market;
    const regionOf = (postcode: string) => this.deps.policy.regionOfPostcode(market, postcode);

    const pickups = new Map<Id<'Seller'>, string>();
    if (sellerIds.length > 0) {
      // sellers' clear pickup postcode column (no decryption, no audit row).
      const postcodes = await this.deps.pickups.postcodesOf(context, sellerIds);
      if (!postcodes.ok) return err({ code: 'shipping.unavailable' });
      for (const [sellerId, postcode] of postcodes.value) {
        const region = regionOf(postcode);
        if (region !== null) pickups.set(sellerId, region);
      }
    }

    const quotes = new Map<string, string>();
    if (quoteIds.length > 0) {
      const read = await this.deps.unitOfWork.run<
        ReadonlyMap<Id<'DeliveryQuote'>, string>,
        ShippingReportingFailure
      >(market, async () => ok(await this.deps.quotes.dropoffPostcodesOf(market, quoteIds)), {
        readOnly: true,
      });
      if (!read.ok) return err({ code: 'shipping.unavailable' });
      for (const [quoteId, postcode] of read.value) {
        const region = regionOf(postcode);
        if (region !== null) quotes.set(quoteId, region);
      }
    }
    return ok({ quotes, pickups });
  }
}
