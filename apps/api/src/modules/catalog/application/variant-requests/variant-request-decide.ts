import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { VariantRequest, VariantRequestRefusal } from '../../domain/variant-request';
import type { VariantRequestStore } from '../ports/variant-request.store';
import { editorAccountOf } from '../attributes/attribute-editor';

/** The refusals every decision on a request has, besides access and the shape of the request. */
export type VariantRequestDecisionFailure =
  | VariantRequestRefusal
  | { readonly code: 'variant-request.not-found' }
  | { readonly code: 'variant-request.stale' };

/** The admin who decides: an authenticated admin, never in an acting-as session. */
export const deciderOf = editorAccountOf;

export interface VariantRequestDecideDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantRequests: VariantRequestStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * The open request of the call at the version the admin saw. A missing or other-Market request is
 * `variant-request.not-found`; one that changed since is `variant-request.stale`; one decided
 * before is `variant-request.not-open`.
 */
export async function loadOpenRequest(
  deps: { readonly variantRequests: VariantRequestStore },
  market: MarketContext,
  id: Id<'VariantRequest'>,
  version: number,
): Promise<Result<VariantRequest, VariantRequestDecisionFailure>> {
  const request = await deps.variantRequests.findById(market, id);
  if (request === null) return err({ code: 'variant-request.not-found' });
  if (request.state.version !== version) return err({ code: 'variant-request.stale' });
  if (request.state.status !== 'open') return err({ code: 'variant-request.not-open' });
  return ok(request);
}
