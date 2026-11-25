import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  OfferChangeChangesRequestedAudit,
  OfferChangeRejectedAudit,
  OfferChangeWithdrawnAudit,
} from '../domain/audit';
import type { OfferPendingChangeStatus } from '../domain/offer-pending-change';
import type { ChangeValidationFailure } from './offer-change-view';
import type { OfferPendingChangeRepository } from './ports/offer-pending-change.repository';
import type { OfferActor, OfferRepository } from './ports/offer.repository';

export interface OfferChangeDecisionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

export interface OfferChangeDecided {
  readonly changeId: string;
  readonly offerId: string;
  readonly status: OfferPendingChangeStatus;
}

export type OfferChangeDecisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer-change.not-found' }
  | { readonly code: 'offer-change.not-pending' }
  | { readonly code: 'conflict.stale' }
  | ChangeValidationFailure;

/** Which decision, and who may make it: an admin's two, or the seller's withdrawal. */
export type OfferChangeDecision =
  | { readonly kind: 'request-changes'; readonly note: string }
  | { readonly kind: 'reject'; readonly note: string }
  | { readonly kind: 'withdraw'; readonly sellerId: Id<'Seller'> };

/**
 * A decision that leaves the live Offer as it is (slice 2c): an admin requests changes or rejects
 * with a note, or the seller withdraws their own change. One unit, Offer row first (its version
 * rises once: lock order), then the conditional update of the change (`status = 'pending'`; a lost
 * race is `conflict.stale` and nothing commits), then the audit row. The seller's withdrawal finds
 * the change by its Offer and checks ownership; another seller's Offer is `offer-change.not-found`.
 */
export async function decideHeldChange(
  deps: OfferChangeDecisionDependencies,
  context: CallContext,
  target: { readonly changeId: Id<'OfferPendingChange'> } | { readonly offerId: Id<'Offer'> },
  decision: OfferChangeDecision,
): Promise<Result<OfferChangeDecided, OfferChangeDecisionFailure>> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
  const accountId = actor.accountId;
  const offerActor: OfferActor =
    decision.kind === 'withdraw' ? { kind: 'seller', accountId } : { kind: 'admin', accountId };
  try {
    return await deps.unitOfWork.run<OfferChangeDecided, OfferChangeDecisionFailure>(
      market,
      async () => {
        const change =
          'changeId' in target
            ? await deps.pendingChanges.findById(market, target.changeId)
            : await deps.pendingChanges.findOpenByOffer(market, target.offerId);
        if (change === null) return err({ code: 'offer-change.not-found' } as const);
        const offer = await deps.offers.findById(market, change.state.offerId);
        if (offer === null) return err({ code: 'offer-change.not-found' } as const);
        if (decision.kind === 'withdraw' && offer.state.sellerId !== decision.sellerId) {
          return err({ code: 'offer-change.not-found' } as const);
        }
        const now = deps.clock.now();
        const decided =
          decision.kind === 'withdraw'
            ? change.withdraw({ accountId, now })
            : decision.kind === 'reject'
              ? change.reject({ accountId, note: decision.note, now })
              : change.requestChanges({ accountId, note: decision.note, now });
        if (!decided.ok) {
          return err(
            decided.error.code === 'offer-change.note-invalid'
              ? ({
                  code: 'validation.failed',
                  fields: [{ path: 'note', code: 'length' }],
                } as const)
              : ({ code: 'offer-change.not-pending' } as const),
          );
        }
        offer.markReviewChange();
        await deps.offers.save(market, offer, offerActor);
        if (!(await deps.pendingChanges.decide(market, change))) {
          return err({ code: 'conflict.stale' } as const);
        }
        const audited = { changeId: change.state.id, fields: change.fields };
        const offerId = change.state.offerId;
        await deps.audit.record(
          context,
          decision.kind === 'withdraw'
            ? OfferChangeWithdrawnAudit.entry(offerId, { after: audited })
            : decision.kind === 'reject'
              ? OfferChangeRejectedAudit.entry(offerId, { after: audited })
              : OfferChangeChangesRequestedAudit.entry(offerId, { after: audited }),
        );
        return ok({ changeId: change.state.id, offerId, status: change.state.status });
      },
    );
  } catch (error) {
    if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
    throw error;
  }
}
