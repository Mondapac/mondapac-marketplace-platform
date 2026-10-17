import { Logger } from '@nestjs/common';
import { err, parseId } from '@mondapac/shared-kernel';
import type {
  ActorContext,
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parsePlainText } from '@mondapac/shared-kernel';
import type { ReviewPolicy } from '../../domain/review';
import { isActingAs, type ValidationFailure } from '../own/own-certificate.shared';
import type { SellerZonesSource } from '../ports/claim-facts.ports';
import type { CertificateFieldCipher, DocumentVault } from '../ports/document-ports';
import type { CertificateReviewRepository } from '../ports/review.repository';
import type { ReviewPolicyProvider, ReviewSellerSource } from '../ports/review.ports';

/** The ports the admin review use cases share; each takes the whole object and uses its part. */
export interface ReviewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reviews: CertificateReviewRepository;
  readonly cipher: CertificateFieldCipher;
  readonly vault: DocumentVault;
  readonly audit: AuditWriter;
  readonly zones: SellerZonesSource;
  readonly sellers: ReviewSellerSource;
  readonly policies: ReviewPolicyProvider;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Whether a reviewer may read the bytes of a submitted file. Off by default until the PDF scan
   * hardening lands (`CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED`); the review page lists the files
   * either way.
   */
  readonly documentDownloadEnabled: boolean;
}

export { invalid, UNAVAILABLE } from '../own/own-certificate.shared';
export type { ValidationFailure };

export interface Reviewer {
  readonly accountId: Id<'Account'>;
}

/**
 * The admin account of the call, or null for anyone else. The population is the structural form of
 * "the reviewer is not the seller's own team": a seller account never holds a platform key. A
 * write refuses an acting-as session (design 3.2, 7.2: an admin never acts as a seller here).
 */
export function reviewerOf(context: CallContext, options: { write: boolean }): Reviewer | null {
  const { actor }: { actor: ActorContext } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (options.write && isActingAs(actor)) return null;
  return { accountId: actor.accountId };
}

export function parseSubmissionId(raw: unknown): Id<'Submission'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'Submission'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseChannelId(raw: unknown): Id<'IssuerContactChannel'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'IssuerContactChannel'>(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * A required plain text of at most `max` characters, trimmed, or the field's failure code. The
 * text has no control or format characters (the same rule as every text a person types).
 */
export function plainTextIn(
  value: unknown,
  max: number,
  options: { optional: boolean },
): { ok: true; value: string | null } | { ok: false; code: string } {
  if (value === undefined || value === null) {
    return options.optional ? { ok: true, value: null } : { ok: false, code: 'required' };
  }
  if (typeof value !== 'string') return { ok: false, code: 'type' };
  const text = value.trim();
  if (text.length === 0) {
    return options.optional ? { ok: true, value: null } : { ok: false, code: 'required' };
  }
  if (Array.from(text).length > max) return { ok: false, code: 'too-long' };
  if (!parsePlainText(text).ok) return { ok: false, code: 'invalid-character' };
  return { ok: true, value: text };
}

/** The Market's policy, or null when the Market has none (the review then fails closed). */
export function policyOf(deps: ReviewDependencies, market: MarketContext): ReviewPolicy | null {
  try {
    return deps.policies.policyFor(market);
  } catch {
    return null;
  }
}

export type ReviewStoreFailure =
  { readonly code: 'conflict.stale' } | { readonly code: 'access.unavailable' };

const logger = new Logger('CertificationReview');

/**
 * A failed unit as an answer: the lost race on the root is `conflict.stale`, anything else
 * `access.unavailable`. The log line holds the error class and the context ids only (P 12.3).
 */
export function reviewFailure(
  context: CallContext,
  msg: string,
  error: unknown,
): { ok: false; error: ReviewStoreFailure } {
  if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' }) as never;
  logger.error({
    msg,
    errorName: error instanceof Error ? error.name : 'unknown',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return err({ code: 'access.unavailable' }) as never;
}

export type { Result };
