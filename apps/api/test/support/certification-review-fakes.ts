import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditEntry, CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CertificateReviewRepository,
  DecisionNotice,
  DecisionWrite,
  DuplicateHint,
  OtherSubmission,
  ReviewQueueEntry,
  ReviewSnapshot,
  ReviewSubmission,
  CheckWrite,
  ConfirmationWrite,
  ScopeWrite,
  SellerOverviewRow,
} from '../../src/modules/certification/application/ports/review.repository';
import type {
  BusinessDetailsAnswer,
  ReviewSellerSource,
} from '../../src/modules/certification/application/ports/review.ports';
import type { StoredCertificate } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

const lockContext = new AsyncLocalStorage<number>();

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The admin side of one certificate in memory: one record, its submission, and a list of
 * duplicate hints the test sets. It mirrors the contract of the SQL repository (a write on a
 * moved version throws `StaleAggregateError`); the SQL itself is covered in test/db/.
 */
export class MemoryReviews implements CertificateReviewRepository {
  certificate: Mutable<StoredCertificate>;
  submission: Mutable<ReviewSubmission>;
  hints: DuplicateHint[] = [];
  /** The record's other submissions a test sets, newest first (the review page's list). */
  others: OtherSubmission[] = [];
  readonly history: ReviewSnapshot['history'][number][] = [];
  erased = 0;
  readonly marketId: string;

  constructor(marketId: string, certificate: StoredCertificate, submission: ReviewSubmission) {
    this.marketId = marketId;
    this.certificate = { ...certificate };
    this.submission = { ...submission };
  }

  private own(market: MarketContext): boolean {
    return market.marketId === this.marketId;
  }

  queue(market: MarketContext, limit: number): Promise<readonly ReviewQueueEntry[]> {
    if (!this.own(market) || this.certificate.pendingSubmissionId === null) {
      return Promise.resolve([]);
    }
    const entry: ReviewQueueEntry = {
      certificateId: this.certificate.id,
      version: this.certificate.version,
      sellerId: this.certificate.sellerId,
      typeCode: this.certificate.typeCode,
      submissionId: this.submission.id,
      submissionNo: this.submission.submissionNo,
      kind: this.submission.kind,
      submittedAt: this.submission.submittedAt,
      issuerName: this.submission.issuer?.displayName ?? null,
    };
    return Promise.resolve([entry].slice(0, limit));
  }

  snapshot(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    options: { readonly others?: boolean } = {},
  ): Promise<ReviewSnapshot | null> {
    if (!this.own(market) || certificateId !== this.certificate.id) return Promise.resolve(null);
    const pending = this.certificate.pendingSubmissionId === this.submission.id;
    const approved = this.certificate.approvedSubmissionId === this.submission.id;
    return Promise.resolve({
      certificate: {
        ...this.certificate,
        version: this.certificate.version + (lockContext.getStore() === undefined ? 0 : 1),
      },
      submission: pending || approved ? { ...this.submission } : null,
      pending,
      history: [...this.history],
      others: options.others === true ? [...this.others] : [],
    });
  }

  duplicateHints(market: MarketContext): Promise<readonly DuplicateHint[]> {
    return Promise.resolve(this.own(market) ? this.hints : []);
  }

  recordCheck(_market: MarketContext, write: CheckWrite): Promise<boolean> {
    if (this.certificate.pendingSubmissionId !== write.submissionId) return Promise.resolve(false);
    const rows = this.submission.checks.filter((c) => c.code !== write.code);
    this.submission.checks = [
      ...rows,
      {
        id: write.id,
        code: write.code,
        result: write.result,
        recordedAt: write.now,
        recordedByAccountId: write.accountId,
      },
    ];
    return Promise.resolve(true);
  }

  recordScope(_market: MarketContext, write: ScopeWrite): Promise<boolean> {
    if (this.certificate.pendingSubmissionId !== write.submissionId) return Promise.resolve(false);
    this.submission.scope = {
      locationCiphertext: write.locationCiphertext,
      scopeCiphertext: write.scopeCiphertext,
      recordedAt: write.now,
    };
    return Promise.resolve(true);
  }

  recordConfirmation(
    _market: MarketContext,
    write: ConfirmationWrite,
  ): Promise<'recorded' | 'exists'> {
    this.bump(write.expectedVersion);
    if (this.submission.confirmation !== null) return Promise.resolve('exists');
    this.submission.confirmation = {
      issuerId: write.issuerId,
      channelId: write.channelId,
      confirmedOn: write.confirmedOn,
      referenceCiphertext: write.referenceCiphertext,
      recordedAt: write.now,
    };
    return Promise.resolve('recorded');
  }

  /**
   * The lock answers a lost race like the database; the version itself moves in `decide`, so a
   * refusal after the lock (which rolls the unit back in the database) leaves nothing behind.
   */
  lockForDecision(
    _market: MarketContext,
    _id: Id<'SellerCertification'>,
    expectedVersion: number,
  ): Promise<void> {
    if (expectedVersion !== this.certificate.version) {
      throw new StaleAggregateError('seller-certification', this.certificate.id);
    }
    // The lock belongs to the async chain of the unit that took it; a refusal drops it with the
    // chain, as a rollback drops the database's version move.
    lockContext.enterWith(expectedVersion);
    return Promise.resolve();
  }

  decide(_market: MarketContext, write: DecisionWrite): Promise<void> {
    this.bump(lockContext.getStore() ?? this.certificate.version);
    this.submission.decision = {
      outcome: write.outcome,
      reasonCode: write.reasonCode,
      reasonTextCiphertext: write.reasonTextCiphertext,
      decidedAt: write.decidedAt,
      actorKind: 'admin',
    };
    this.certificate.status = write.toStatus;
    this.certificate.pendingSubmissionId = null;
    this.certificate.pendingKind = null;
    if (write.outcome === 'approved') {
      this.certificate.approvedSubmissionId = write.submissionId;
      this.certificate.approvedBoundaryAt = write.expiryBoundaryAt;
    }
    this.history.push({
      fromStatus: write.fromStatus,
      toStatus: write.toStatus,
      occurredAt: write.decidedAt,
      actorKind: 'admin',
      reasonCode: write.reasonCode,
    });
    return Promise.resolve();
  }

  overview(
    _market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    now: Temporal.Instant,
  ): Promise<readonly SellerOverviewRow[]> {
    return Promise.resolve(
      sellerIds.map((sellerId) => {
        const mine = sellerId === this.certificate.sellerId;
        const valid =
          mine &&
          this.certificate.status === 'approved' &&
          (this.certificate.approvedBoundaryAt === null ||
            this.certificate.approvedBoundaryAt.epochMilliseconds > now.epochMilliseconds);
        return {
          sellerId,
          validTypeCodes: valid ? [this.certificate.typeCode] : [],
          pendingTypeCodes:
            mine && this.certificate.pendingSubmissionId !== null
              ? [this.certificate.typeCode]
              : [],
        };
      }),
    );
  }

  decisionNotice(
    _market: MarketContext,
    submissionId: Id<'Submission'>,
  ): Promise<DecisionNotice | null> {
    const decision = this.submission.decision;
    if (decision === null || submissionId !== this.submission.id) return Promise.resolve(null);
    return Promise.resolve({
      certificateId: this.certificate.id,
      sellerId: this.certificate.sellerId,
      typeCode: this.certificate.typeCode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
    });
  }

  eraseIndexRows(): Promise<number> {
    this.erased += 1;
    return Promise.resolve(this.hints.length);
  }

  /** The lost race on the root: a write that names an old version. */
  private bump(expected: number): void {
    if (expected !== this.certificate.version) {
      throw new StaleAggregateError('seller-certification', this.certificate.id);
    }
    this.certificate.version += 1;
  }
}

/** The audit writer without a database: it keeps what it is given. */
export class RecordingAudit implements AuditWriter {
  readonly entries: (AuditEntry & { readonly context: CallContext })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry, context });
    return Promise.resolve();
  }
}

/** The `sellers` reads of the review page: a fixed store name and business details. */
export class FixedReviewSellers implements ReviewSellerSource {
  details: BusinessDetailsAnswer = {
    status: 'ok',
    details: {
      businessName: 'Example Trading Pty Ltd',
      storeName: 'Example Store',
      operatingAddress: { line1: '1 Example Street' },
      registeredAddress: null,
    },
  };
  storeNames(
    _context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    return Promise.resolve(new Map(sellerIds.map((id) => [id, 'Example Store'])));
  }
  businessDetails(): Promise<BusinessDetailsAnswer> {
    return Promise.resolve(this.details);
  }
}
