import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface OperatingZonesInput {
  readonly sellerIds: readonly string[];
}

export type OperatingZonesFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface OperatingZonesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
}

/**
 * `operatingZones` (delivery models, package 4): the IANA operating zone of each seller's
 * **approved** revision, for shipping to evaluate a same-day cut-off and a delivery window in the
 * seller's own zone (ADR-0005 decision 3). The zone is the clear column of the approved revision
 * (the same one `pickupPostcodes` reads next to the postcode): nothing is decrypted, so the read
 * writes no audit row. Rule `anonymous` (the answer is the same for every caller). A seller
 * without an approved revision, or of another Market, is absent from the map, byte-identical;
 * the consumer then falls back to the Market zone. A failed read is `sellers.unavailable`. At
 * most 100 ids. Not exposed over HTTP.
 */
export class OperatingZones extends UseCase<
  OperatingZonesInput,
  ReadonlyMap<Id<'Seller'>, string>,
  OperatingZonesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.operating-zones',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OperatingZonesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OperatingZonesInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, OperatingZonesFailure>> {
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
      const zones = new Map<Id<'Seller'>, string>();
      for (const [sellerId, approved] of read.value)
        zones.set(sellerId, approved.operatingTimezone);
      return ok(zones);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
