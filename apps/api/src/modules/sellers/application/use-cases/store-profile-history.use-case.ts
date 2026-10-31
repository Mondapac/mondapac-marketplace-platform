import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeTrail,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_PROFILE_VIEW } from '../../contracts/permissions';
import { sellerActorOf } from '../draft/draft-support';
import { storeProfileChanges } from '../store-profile/store-profile';

export interface StoreProfileHistoryDependencies {
  readonly trail: ChangeTrail;
}

/**
 * `store-profile.history`: the changes of the seller's own store profile, newest first, from its
 * `sellers.store-profile.saved` and `sellers.store-image.changed` audit rows: when, who and which
 * field (`about`, `logo`, `banner`). Never the text, a hash or an image. Who is a current member of
 * the shop's team by display name; Mondapac staff is `platform` with no name and a former member
 * has no name (PA 10, Hassan I4). Same rule as the page it explains: `sellers.store-profile.view`,
 * approved sellers only; the seller is `ActorContext.sellerId`, never an id from the request. The
 * rows are the seller's own public store texts, not personal data, so the read writes no audit row.
 */
export class StoreProfileHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-profile-history',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreProfileHistoryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    const owner = sellerActorOf(context);
    if (owner === null) return Promise.resolve(err({ code: 'access.denied' } as const));
    return this.deps.trail.history(context, storeProfileChanges(owner.sellerId), input ?? {});
  }
}
