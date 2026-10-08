import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ApprovedSellerZone } from '../../domain/seller-summary';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface ApprovedSellerZonesInput {
  readonly sellerIds: readonly string[];
}

/** One entry per distinct requested id, in first-occurrence order (sellers design 7.1a row 1). */
export type ApprovedSellerZonesAnswer = ReadonlyMap<Id<'Seller'>, ApprovedSellerZone>;

export type ApprovedSellerZonesFailure = SellerIdsRefused;

/**
 * The one query function behind both use cases of the pair (sellers design 7.1a row 5). It takes
 * the ids only: the actor, its id, permissions and acting-as flag are not parameters, so no
 * branch on them is possible, and the Market is not read either while no row is. **Slice 2
 * stand-in:** no approved revision exists before slice 5, so every id answers
 * `{ zone: null, addressZone: null }` and nothing is read. Slice 5 replaces this body with the
 * read of data design A18 (the approved pointer and revision, one read-only unit, `marketId` from
 * the `MarketContext`), taking the context as a parameter, and keeps the empty list and the
 * parse before any read. `addressZone` is then derived on the server from the approved
 * revision's address only, never from a client or an admin.
 */
export function approvedSellerZonesFor(
  sellerIds: readonly string[],
): Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure> {
  const ids = parseSellerIds(sellerIds);
  if (!ids.ok) return ids;
  return ok(
    new Map(
      [...ids.value].map(
        (sellerId) =>
          [sellerId, { zone: null, addressZone: null }] as [Id<'Seller'>, ApprovedSellerZone],
      ),
    ),
  );
}

/**
 * `approvedSellerZones` for request actors: rule `anonymous`; its pair is the `system` case. The
 * answer is the same for every caller (request S-1 of `certification`), so this handler passes
 * nothing of the context to the query function.
 */
export class ApprovedSellerZones extends UseCase<
  ApprovedSellerZonesInput,
  ApprovedSellerZonesAnswer,
  ApprovedSellerZonesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.approved-seller-zones',
    rule: { kind: 'anonymous' },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: ApprovedSellerZonesInput,
  ): Promise<Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure>> {
    return Promise.resolve(approvedSellerZonesFor(input.sellerIds));
  }
}
