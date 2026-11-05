import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { allActivityIds } from '../../domain/seller-business-activities';
import { sellerActorOf } from '../draft/draft-support';
import type { SellerBusinessActivityRepository } from '../ports/seller-business-activity.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface SellerBusinessActivitiesInput {
  readonly sellerIds: readonly string[];
}

/** What a seller carries: `activityIds` lists every assigned activity, the main one first. */
export interface SellerBusinessActivitiesAnswer {
  readonly mainActivityId: Id<'BusinessActivity'> | null;
  readonly activityIds: readonly Id<'BusinessActivity'>[];
}

export type SellerBusinessActivitiesMap = ReadonlyMap<Id<'Seller'>, SellerBusinessActivitiesAnswer>;

export type SellerBusinessActivitiesFailure =
  SellerIdsRefused | { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface SellerBusinessActivitiesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly businessActivities: SellerBusinessActivityRepository;
}

/**
 * `sellerBusinessActivities` (ADR-0040 decision 4; package 4a), the one query function behind both
 * use cases of the pair: per distinct requested seller (at most 100, refused whole above), the main
 * activity and every assigned activity, in one read-only unit on `sellers`' own rows. One entry per
 * requested id: a seller with no activity, an unknown id and another Market's id are all
 * `{ mainActivityId: null, activityIds: [] }`, byte-identical, so a caller that reads "none" refuses
 * (fail closed). A read error is `sellers.unavailable`: no partial answer.
 */
export async function sellerBusinessActivitiesFor(
  deps: SellerBusinessActivitiesDependencies,
  context: CallContext,
  requested: readonly string[],
): Promise<Result<SellerBusinessActivitiesMap, SellerBusinessActivitiesFailure>> {
  const ids = parseSellerIds(requested);
  if (!ids.ok) return ids;
  const distinct = [...ids.value];
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.businessActivities.find(market, distinct)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'sellers.unavailable' });
    return ok(
      new Map(
        distinct.map((sellerId) => {
          const held = read.value.get(sellerId);
          return [
            sellerId,
            held === undefined
              ? { mainActivityId: null, activityIds: [] }
              : { mainActivityId: held.mainActivityId, activityIds: allActivityIds(held) },
          ] as const;
        }),
      ),
    );
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/**
 * `sellerBusinessActivities` for request actors: rule `own-resources`. Only the seller's own
 * request actor is answered, and only for its own seller id; every other request actor (an admin,
 * a customer, another seller's account) and any list that names another seller is
 * `access.denied`, before any read. Its pair is the `system` case.
 */
export class SellerBusinessActivities extends UseCase<
  SellerBusinessActivitiesInput,
  SellerBusinessActivitiesMap,
  SellerBusinessActivitiesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-business-activities',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerBusinessActivitiesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerBusinessActivitiesInput,
  ): Promise<Result<SellerBusinessActivitiesMap, SellerBusinessActivitiesFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const ids = parseSellerIds(input?.sellerIds);
    if (!ids.ok) return ids;
    if ([...ids.value].some((sellerId) => sellerId !== owner.sellerId)) {
      return err({ code: 'access.denied' });
    }
    return sellerBusinessActivitiesFor(this.deps, context, input.sellerIds);
  }
}
