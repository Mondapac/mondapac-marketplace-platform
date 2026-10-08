import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ApprovedSellerZone } from '../../domain/seller-summary';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface ApprovedSellerZonesInput {
  readonly sellerIds: readonly string[];
}

/** One entry per distinct requested id, in first-occurrence order (sellers design 7.1a row 1). */
export type ApprovedSellerZonesAnswer = ReadonlyMap<Id<'Seller'>, ApprovedSellerZone>;

export type ApprovedSellerZonesFailure =
  SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface ApprovedSellerZonesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
}

/**
 * The one query function behind both use cases of the pair (sellers design 7.1a row 5). The actor,
 * its id, permissions and acting-as flag are not parameters, so no branch on them is possible;
 * the Market is the context's, used only to name the rows. The ids are parsed first (an empty list
 * answers an empty map without a read); then one read-only unit reads data design A18: the approved
 * pointer on `seller_files` and the revision it names, the clear zone columns only (derived on the
 * server at every address save from the operating address only, and copied at submit; nothing is
 * derived and no key is unwrapped here). An id with no approved revision, of another Market or
 * never issued answers `{ zone: null, addressZone: null }`, byte-identical to any other absent id.
 * A read that fails is `sellers.unavailable` (the consumer treats the batch as failed and fails
 * closed), never an entry of nulls.
 */
export async function approvedSellerZonesFor(
  deps: ApprovedSellerZonesDependencies,
  context: CallContext,
  sellerIds: readonly string[],
): Promise<Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure>> {
  const ids = parseSellerIds(sellerIds);
  if (!ids.ok) return ids;
  const distinct = [...ids.value];
  if (distinct.length === 0) return ok(new Map());
  const { market } = context;
  let found;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.revisions.approvedZones(market, distinct)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'sellers.unavailable' });
    found = read.value;
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
  return ok(
    new Map(
      distinct.map((sellerId): [Id<'Seller'>, ApprovedSellerZone] => {
        const zones = found.get(sellerId);
        return [
          sellerId,
          zones === undefined
            ? { zone: null, addressZone: null }
            : { zone: zones.operatingTimezone, addressZone: zones.addressTimezone },
        ];
      }),
    ),
  );
}

/**
 * `approvedSellerZones` for request actors: rule `anonymous`; its pair is the `system` case. The
 * answer is the same for every caller (request S-1 of `certification`), so this handler passes
 * only the Market's context to the query function.
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

  constructor(
    gate: UseCaseGate,
    private readonly deps: ApprovedSellerZonesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ApprovedSellerZonesInput,
  ): Promise<Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure>> {
    return approvedSellerZonesFor(this.deps, context, input.sellerIds);
  }
}
