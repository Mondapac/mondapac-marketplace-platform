import type { CallContext, Result } from '@mondapac/shared-kernel';
import { err } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_PROFILE_VIEW } from '../../contracts/permissions';
import type { ClaimCheckUnavailable, StoreTextClaimCheck } from '../ports/store-text-claim-check';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';

export interface StoreProfileClaimTermsDependencies {
  readonly claimCheck: StoreTextClaimCheck;
}

/**
 * `store-profile.claim-terms`: the Market's certification claim terms (plain phrases) so the
 * About field can warn while the seller types. A read of certification's public interface, kept
 * nowhere in sellers; not a decision: `store-profile.save-about` runs the real check and stays
 * authoritative (fail closed). Rule `permissions [sellers.store-profile.view]`, approved sellers
 * only. An unavailable read is `sellers.unavailable`, never an empty list.
 */
export class StoreProfileClaimTerms extends UseCase<
  Record<string, never>,
  readonly string[],
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-profile-claim-terms',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreProfileClaimTermsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<
    Result<
      readonly string[],
      { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' }
    >
  > {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const answer: Result<readonly string[], ClaimCheckUnavailable> =
      await this.deps.claimCheck.terms(context);
    logDraftOutcome(
      'store-profile-claim-terms',
      context,
      owner.sellerId,
      answer.ok ? 'read' : 'sellers.unavailable',
    );
    return answer.ok ? answer : err({ code: 'sellers.unavailable' });
  }
}
