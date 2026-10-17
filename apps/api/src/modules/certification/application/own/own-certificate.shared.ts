import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  ActorContext,
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Temporal,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerCertificationWithdrawn } from '../../domain/events';
import { rateVerdict, type RateLimit } from '../../domain/rate-limits';
import {
  sellerStatusOf,
  statusAfterWithdraw,
  type SellerStatusCode,
} from '../../domain/seller-certificate';
import type { CertificateTypeCatalog } from '../ports/certificate-type-catalog';
import type {
  CertificateFieldCipher,
  DocumentIntake,
  DocumentVault,
} from '../ports/document-ports';
import type { RateCounterKeys, RateCounterRepository } from '../ports/rate-counters';
import type { CertificateIndexKeys } from '../ports/review.ports';
import type { SellerZonesSource } from '../ports/claim-facts.ports';
import type {
  SellerCertificateRepository,
  StoredCertificate,
  StoredDocument,
  StoredDraft,
} from '../ports/seller-certificate.repository';

/** The ports the own-certificate use cases share; each takes the whole object and uses its part. */
export interface OwnCertificateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly certificates: SellerCertificateRepository;
  readonly types: CertificateTypeCatalog;
  readonly vault: DocumentVault;
  readonly intake: DocumentIntake;
  readonly cipher: CertificateFieldCipher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  /** The keyed indexes of the reviewer's duplicate hint (design 10.2). */
  readonly indexKeys: CertificateIndexKeys;
  readonly zones: SellerZonesSource;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Bytes of draft files one seller may hold (design 5.1: 200 MiB). */
  readonly draftQuotaBytes: number;
}

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

/**
 * Whether the actor is an acting-as (Login as Seller, SEL-08) session. The marker is reserved as
 * `actingAs` on the actor (identity design 3.4 row 6): no session carries it yet; read by name so
 * that the first one that does is refused without a change here (design 7.2, M5).
 */
export function isActingAs(actor: ActorContext): boolean {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

export interface Owner {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
}

/**
 * The seller and account of an authenticated seller actor, or null for anyone else. The seller
 * always comes from the actor, never from a request (AC 17). A write refuses an acting-as session.
 */
export function ownerOf(context: CallContext, options: { write: boolean }): Owner | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  if (actor.sellerId === null) return null;
  if (options.write && isActingAs(actor)) return null;
  return { sellerId: actor.sellerId, accountId: actor.accountId };
}

export function parseCertificateId(raw: unknown): Id<'SellerCertification'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'SellerCertification'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseDocumentId(raw: unknown): Id<'UploadedDocument'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'UploadedDocument'>(raw);
  return parsed.ok ? parsed.value : null;
}

export type RateFailure =
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

const logger = new Logger('OwnCertificate');

/**
 * Spends one attempt from each limit in its own unit and answers `null` when allowed (data design
 * 3.12). A store that cannot answer refuses with `access.unavailable`, never a pass.
 */
export async function reserveLimits(
  deps: Pick<OwnCertificateDependencies, 'unitOfWork' | 'counters' | 'counterKeys' | 'clock'>,
  context: CallContext,
  limits: readonly { readonly limit: RateLimit; readonly subject: string }[],
): Promise<RateFailure | null> {
  const { market } = context;
  try {
    const counters = limits.map(({ limit, subject }) => ({
      limit,
      keyHash: deps.counterKeys.keyOf(market, limit.kind, subject),
    }));
    const now = deps.clock.now();
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(await deps.counters.reserve(market, counters, now)),
    );
    if (!reserved.ok) return { code: 'access.unavailable' };
    const verdict = rateVerdict(
      limits.map((item) => item.limit),
      reserved.value,
      now,
    );
    if (verdict.allowed) return null;
    logger.warn({
      msg: 'certification.request-throttled',
      kinds: limits.map((item) => item.limit.kind),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
  } catch {
    logger.error({
      msg: 'certification.rate-counters-unavailable',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return { code: 'access.unavailable' };
  }
}

/** What a seller sees of a certificate in a list: clear fields only (design 7.1). */
export interface CertificateSummary {
  readonly certificateId: string;
  readonly typeCode: string;
  /** The status code of design 3.3. */
  readonly status: SellerStatusCode;
  /** The record's own status, for the panel's actions. */
  readonly recordStatus: string;
  /**
   * For `approved-expiring` and `approved-renewal-changes-needed`: the instant the approved
   * certificate stops counting.
   */
  readonly submitBy: string | null;
  readonly editable: boolean;
  /** True while the record never had a submission (it can be deleted). */
  readonly deletable: boolean;
  /** True while a submission waits for review (it can be withdrawn). */
  readonly withdrawable: boolean;
  readonly createdAt: string;
  readonly lastChangedAt: string;
}

export interface DocumentView {
  readonly documentId: string;
  readonly position: number;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly createdAt: string;
}

export function summaryOf(
  stored: StoredCertificate,
  editable: boolean,
  now: Temporal.Instant,
): CertificateSummary {
  const status = sellerStatusOf(
    {
      status: stored.status,
      pendingKind: stored.pendingKind,
      approvedBoundaryAt: stored.approvedBoundaryAt,
      hasApproval: stored.approvedSubmissionId !== null,
      approvedIssuerState: stored.approvedIssuerState,
      issuerRequestOpen: stored.issuerRequestOpen,
      latestOutcome: stored.latestOutcome,
    },
    now,
  );
  return {
    certificateId: stored.id,
    typeCode: stored.typeCode,
    status: status.code,
    recordStatus: stored.status,
    submitBy: status.submitBy === null ? null : status.submitBy.toString(),
    editable,
    deletable: stored.submissionCount === 0,
    withdrawable: stored.pendingSubmissionId !== null,
    createdAt: stored.createdAt.toString(),
    lastChangedAt: stored.lastChangedAt.toString(),
  };
}

export function documentViewOf(document: StoredDocument): DocumentView {
  return {
    documentId: document.id,
    position: document.position,
    mediaType: document.mediaType,
    byteSize: document.byteSize,
    pageCount: document.pageCount,
    createdAt: document.createdAt.toString(),
  };
}

export type StoreFailure =
  { readonly code: 'conflict.stale' } | { readonly code: 'access.unavailable' };

/**
 * A failed unit as an answer: the lost race on the root is `conflict.stale`, anything else
 * `access.unavailable`. The log line holds the error class and the context ids only (P 12.3).
 */
export function storeFailure(
  context: CallContext,
  msg: string,
  error: unknown,
): { ok: false; error: StoreFailure } {
  if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' }) as never;
  logger.error({
    msg,
    errorName: error instanceof Error ? error.name : 'unknown',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return err({ code: 'access.unavailable' }) as never;
}

/** The result of a read-only unit that failed to open or run. */
export const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' } as const);

/**
 * An edit of a field or a file that the pending submission holds, sent without the seller's
 * confirmation (design 3.2 row 2; the panel's "Save and withdraw your submission?" dialog). Nothing
 * is written; the same request with `withdrawPending` withdraws the submission and saves the edit.
 */
export interface EditWithdrawsFailure {
  readonly code: 'certificate.edit-withdraws-submission';
}

/** The seller's confirmation flag: absent means not confirmed; anything but a boolean is invalid. */
export function parseWithdrawPending(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return false;
  return typeof raw === 'boolean' ? raw : null;
}

const editLogger = new Logger('OwnCertificateEdit');

/**
 * Withdraw by edit (design 3.2 row 2, slice 8), in the caller's open unit: the pending submission
 * leaves the queue with the decision `withdrawn` (cause `edited`), the record keeps its approved
 * submission untouched (a renewal withdrawn never weakens or extends what is valid) or goes back to
 * `draft` when it was never approved, one history row and the event
 * `seller-certification-withdrawn.v1` are written. `draft`, when given, is written in the same
 * root update (one version step). The root's version guard refuses a record that moved since it
 * was read (a reviewer's decision included). Answers the root's version after the write.
 */
export async function withdrawForEdit(
  deps: Pick<OwnCertificateDependencies, 'certificates' | 'outbox' | 'ids'>,
  context: CallContext,
  owner: Owner,
  stored: StoredCertificate,
  now: Temporal.Instant,
  draft?: StoredDraft,
): Promise<number> {
  const submissionId = stored.pendingSubmissionId;
  if (submissionId === null) throw new Error('withdraw by edit: nothing is pending');
  const { market } = context;
  await deps.certificates.withdraw(market, {
    certificateId: stored.id,
    expectedVersion: stored.version,
    submissionId,
    cause: 'edited',
    ...(draft === undefined ? {} : { draft }),
    accountId: owner.accountId,
    decidedAt: now,
    fromStatus: stored.status,
    toStatus: statusAfterWithdraw(stored.status, stored.approvedSubmissionId !== null),
    historyId: deps.ids.next<'CertificationHistory'>(),
  });
  await deps.outbox.append(context, [
    SellerCertificationWithdrawn.record({
      aggregateId: stored.id,
      aggregateVersion: stored.version + 1,
      occurredAt: now,
      payload: {
        sellerCertificationId: stored.id,
        sellerId: owner.sellerId,
        submissionId,
        cause: 'edited',
      },
    }),
  ]);
  editLogger.log({
    msg: 'certification.submission-withdrawn-by-edit',
    certificateId: stored.id,
    submissionId,
    kind: stored.pendingKind,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return stored.version + 1;
}
