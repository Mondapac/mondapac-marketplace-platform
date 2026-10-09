import type { Logger } from '@nestjs/common';
import type { ActorContext, CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import { AccessReasonIntegrityError } from '../ports/access-decision.repository';
import type { AccessDecisionKind } from '../../domain/access-decision';
import type { SellerAccessStateCode } from '../../domain/seller-access';

// The two R-5 reads of slice 9a (identity design 8.1; sellers request R-5; Mohammad's design,
// Hassan's conditions C1 to C7, Ali's ruling 2026-10-09): what they answer and how a failure
// becomes one code with no detail.

/** The most decisions `accessDecisionsOf` answers; one more row is read for `truncated`. */
export const MAX_ACCESS_DECISIONS = 50;

/** The most `{ sellerId, basisId }` pairs one `accessDecisionsByBasis` call takes. */
export const MAX_BASIS_PAIRS = 100;

/**
 * The reason of a decision as the admin reads it. PERSONAL DATA when `present`: only to the
 * entitled admin; never logged, cached, put in an event, an audit row or an outbox by any module.
 */
export type AccessDecisionReasonView =
  | { readonly status: 'none' }
  | { readonly status: 'present'; readonly text: string }
  /** The seller's subject key is destroyed (erasure, R-9): the row stays, its reason is gone. */
  | { readonly status: 'erased' };

export interface SellerAccessDecisionView {
  readonly decisionId: Id<'AccessDecision'>;
  readonly kind: AccessDecisionKind;
  /** The state the decision left the seller in: `reinstated` is `approved`. */
  readonly resultingState: SellerAccessStateCode;
  readonly decidedAt: Temporal.Instant;
  readonly decidedBy:
    { readonly kind: 'admin'; readonly accountId: Id<'Account'> } | { readonly kind: 'system' };
  /** Null on suspend and reinstate, and on decisions taken through the Phase 2 admin route. */
  readonly basisId: Id | null;
  readonly reason: AccessDecisionReasonView;
}

export interface SellerAccessDecisionHistory {
  readonly sellerId: Id<'Seller'>;
  /** Newest first, at most {@link MAX_ACCESS_DECISIONS}. */
  readonly decisions: readonly SellerAccessDecisionView[];
  readonly truncated: boolean;
}

export interface AccessDecisionByBasis {
  readonly sellerId: Id<'Seller'>;
  readonly basisId: Id;
  readonly decisionId: Id<'AccessDecision'>;
  readonly kind: AccessDecisionKind;
  readonly decidedAt: Temporal.Instant;
}

/** A read or key failure: nothing may be concluded from it, and the caller must not act. */
export interface AccessDecisionsUnavailable {
  readonly code: 'access-decisions.unavailable';
}

export type FieldsInvalid = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export const ACCESS_DECISIONS_UNAVAILABLE: AccessDecisionsUnavailable = Object.freeze({
  code: 'access-decisions.unavailable' as const,
});

/** The state each decision leaves the seller in (identity design 3.3). */
export const RESULTING_STATE: Readonly<Record<AccessDecisionKind, SellerAccessStateCode>> =
  Object.freeze({
    approved: 'approved',
    rejected: 'rejected',
    suspended: 'suspended',
    reinstated: 'approved',
  });

/**
 * Whether the actor is an acting-as (Login as Seller, SEL-08) session. The marker is reserved
 * as `actingAs` on the actor (identity design 3.4 row 6, 4): SEL-08 adds it, and no session
 * carries it yet. Read here by name so that the first actor that does carry one is refused by
 * these reads without a change here (Hassan C1: the marker, not only the actor kind); a seller
 * actor is refused by its population before this is asked.
 */
export function isActingAsSession(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/**
 * Logs a failed read without its detail and answers `access-decisions.unavailable` (Hassan C2).
 * An integrity failure of a sealed reason (it may mean tampering) is an error line with the
 * failed check only: never the ciphertext, a message, a cause or a value. Any other failure is
 * logged by the error's class name only.
 */
export function readFailed(
  logger: Logger,
  useCase: string,
  context: CallContext,
  error: unknown,
  sellerId: Id<'Seller'> | null,
): AccessDecisionsUnavailable {
  const common = {
    ...(sellerId === null ? {} : { sellerId }),
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  };
  try {
    if (error instanceof AccessReasonIntegrityError) {
      logger.error({
        msg: 'identity.access-decisions.integrity-failed',
        useCase,
        check: error.check,
        ...common,
      });
    } else {
      logger.warn({
        msg: 'identity.access-decisions.read-failed',
        useCase,
        error: error instanceof Error ? error.name : typeof error,
        ...common,
      });
    }
  } catch {
    // A failure to log never changes the answer.
  }
  return ACCESS_DECISIONS_UNAVAILABLE;
}
