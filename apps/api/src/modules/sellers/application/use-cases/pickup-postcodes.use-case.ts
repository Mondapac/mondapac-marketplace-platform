import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface PickupPostcodesInput {
  readonly sellerIds: readonly string[];
}

export type PickupPostcodesFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface PickupPostcodesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
}

/**
 * `pickupPostcodes` (SHP-02/03): the postcode of the operating address of each seller's
 * **approved** revision, for shipping to quote the real-time carrier at checkout. The postcode is
 * the clear column copied at submission, like the ServiceArea code: nothing is decrypted and no
 * key is unwrapped, so the read writes no audit row. Rule `anonymous` (the answer is the same for
 * every caller; checkout calls it under the customer's context). A seller without an approved
 * revision, of another Market, or whose revision predates the column, is absent from the map,
 * byte-identical. A failed read is `sellers.unavailable`. At most 100 ids. Not exposed over HTTP.
 */
export class PickupPostcodes extends UseCase<
  PickupPostcodesInput,
  ReadonlyMap<Id<'Seller'>, string>,
  PickupPostcodesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.pickup-postcodes',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PickupPostcodesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PickupPostcodesInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, PickupPostcodesFailure>> {
    const ids = parseSellerIds(input?.sellerIds);
    if (!ids.ok) return ids;
    const distinct = [...ids.value];
    if (distinct.length === 0) return ok(new Map());
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.revisions.approvedZones(market, distinct)),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'sellers.unavailable' });
      const postcodes = new Map<Id<'Seller'>, string>();
      for (const [sellerId, approved] of read.value) {
        if (approved.operatingPostcode !== null)
          postcodes.set(sellerId, approved.operatingPostcode);
      }
      return ok(postcodes);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
