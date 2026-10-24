import type { CallContext, Result } from '@mondapac/shared-kernel';
import { err } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_PROFILE_VIEW } from '../../contracts/permissions';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';
import {
  loadStoreProfileView,
  type StoreProfileFailure,
  type StoreProfileReadDependencies,
  type StoreProfileView,
} from '../store-profile/store-profile';

export type { StoreProfileView };

/**
 * `store-profile.read` (sellers design 6.2 `my-store-profile.read`; slice 12 part 2): the
 * seller's own About text, logo and banner. Rule `permissions [sellers.store-profile.view]`,
 * approved sellers only: a seller without an approved revision gets `access.denied`, as does any
 * actor that is not a seller of this Market. The text is opened with the seller's own key.
 */
export class StoreProfileRead extends UseCase<
  Record<string, never>,
  StoreProfileView,
  StoreProfileFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-profile-read',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreProfileReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<StoreProfileView, StoreProfileFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const view = await loadStoreProfileView(this.deps, context, owner);
    logDraftOutcome(
      'store-profile-read',
      context,
      owner.sellerId,
      view.ok ? 'read' : view.error.code,
    );
    return view;
  }
}
