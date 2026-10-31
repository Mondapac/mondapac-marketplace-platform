import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { EvaluateClaims } from '../application/use-cases/evaluate-claims.use-case';
import type { EvaluateClaimsSystem } from '../application/use-cases/evaluate-claims-system.use-case';
import type { CertificationTypes } from '../application/use-cases/certification-types.use-case';
import type { CertificationTypesSystem } from '../application/use-cases/certification-types-system.use-case';
import type { CertifiedCategories } from '../application/use-cases/certified-categories.use-case';
import type { SellerCertificateOverview } from '../application/use-cases/seller-certificate-overview.use-case';
import type { ClaimTermList } from '../application/use-cases/claim-term-list.use-case';
import type { MatchClaimTerms } from '../application/use-cases/match-claim-terms.use-case';
import type { MatchClaimTermsSystem } from '../application/use-cases/match-claim-terms-system.use-case';
import type {
  CertificationFacade,
  CertificationTypeView,
  CertificationUnavailable,
  CertificationValidationFailed,
  ClaimTextInput,
  SellerCertificateOverviewRow,
} from '../contracts/certification.facade';
import type { ClaimTermMatch } from '../domain/claim-text-matcher';
import type { ClaimDecision, ClaimQuery } from '../domain/claim-types';

/** The use cases behind the facade, two per method (the `anonymous` and `system` pair). */
export interface CertificationFacadeUseCases {
  readonly evaluateClaims: EvaluateClaims;
  readonly evaluateClaimsSystem: EvaluateClaimsSystem;
  readonly claimTermList: ClaimTermList;
  readonly matchClaimTerms: MatchClaimTerms;
  readonly matchClaimTermsSystem: MatchClaimTermsSystem;
  readonly certificationTypes: CertificationTypes;
  readonly certificationTypesSystem: CertificationTypesSystem;
  readonly sellerCertificateOverview: SellerCertificateOverview;
  readonly certifiedCategories: CertifiedCategories;
}

type Failure = AccessDenied | CertificationValidationFailed | CertificationUnavailable;

/**
 * The implementation of {@link CertificationFacade} (design 8.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs. The one
 * decision here is which of the pair; the gate still checks the rule.
 */
export class CertificationFacadeImplementation implements CertificationFacade {
  constructor(private readonly useCases: CertificationFacadeUseCases) {}

  evaluateClaims(
    context: CallContext,
    queries: readonly ClaimQuery[],
  ): Promise<Result<readonly ClaimDecision[], AccessDenied | CertificationValidationFailed>> {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.evaluateClaimsSystem
        : this.useCases.evaluateClaims;
    return useCase.execute(context, { queries });
  }

  matchClaimTerms(
    context: CallContext,
    texts: readonly ClaimTextInput[],
  ): Promise<Result<readonly (readonly ClaimTermMatch[])[], Failure>> {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.matchClaimTermsSystem
        : this.useCases.matchClaimTerms;
    return useCase.execute(context, { texts });
  }

  async claimTermList(
    context: CallContext,
  ): Promise<Result<readonly string[], AccessDenied | CertificationUnavailable>> {
    const result = await this.useCases.claimTermList.execute(context, {});
    if (result.ok) return result;
    return result.error.code === 'access.denied'
      ? err(result.error)
      : err({ code: 'certification.unavailable' });
  }

  certificationTypes(
    context: CallContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<Result<readonly CertificationTypeView[], Failure>> {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.certificationTypesSystem
        : this.useCases.certificationTypes;
    return useCase.execute(context, { filter });
  }

  async certifiedCategoryIds(
    context: CallContext,
  ): Promise<Result<readonly Id<'Category'>[], AccessDenied | CertificationUnavailable>> {
    const result = await this.useCases.certifiedCategories.execute(context, {});
    if (result.ok) return result;
    return result.error.code === 'access.denied'
      ? err(result.error)
      : err({ code: 'certification.unavailable' });
  }

  async sellerCertificateOverview(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<Result<readonly SellerCertificateOverviewRow[], Failure>> {
    const result = await this.useCases.sellerCertificateOverview.execute(context, { sellerIds });
    if (result.ok) return result;
    const { error } = result;
    if (error.code === 'access.denied' || error.code === 'validation.failed') {
      return err(error);
    }
    return err({ code: 'certification.unavailable' });
  }
}
