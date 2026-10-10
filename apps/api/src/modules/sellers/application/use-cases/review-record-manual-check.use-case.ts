import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_FILE_REVIEW } from '../../contracts/permissions';
import { ManualRegisterCheckRecorded } from '../../domain/audit';
import {
  OBSERVED_REGISTER_OUTCOMES,
  type ObservedRegisterOutcome,
} from '../../domain/review-check';
import type { SellersUnavailable } from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { ReviewCheckRepository } from '../ports/review-check.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** The seller from the path; revision N and what the reviewer read in the register, from the body. */
export interface ReviewRecordManualCheckInput {
  readonly sellerId?: unknown;
  readonly revisionId?: unknown;
  readonly observedOutcome?: unknown;
}

export interface ManualCheckRecorded {
  readonly revisionId: Id<'BusinessFileRevision'>;
  readonly observedOutcome: ObservedRegisterOutcome;
}

export type ReviewRecordManualCheckFailure =
  | FileNotFound
  | SellersUnavailable
  | { readonly code: 'access.denied' }
  | { readonly code: 'review.not-current-revision' }
  | { readonly code: 'file.decision-in-progress' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    };

export interface ReviewRecordManualCheckDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly reviewChecks: ReviewCheckRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `review.record-manual-register-check` (sellers design 3.4, 6.2; data design 3.3; AC 31, 32;
 * slice 7a-decide): the reviewer records what they read in the official register by hand for
 * pending revision N. Rule `permissions [sellers.seller-file.review]`. One read-write unit: the
 * file row is held (its lock, no version change), so a decision cannot begin between this check
 * and its own read of the check; while a decision is in flight the check is refused
 * (`file.decision-in-progress`), and N must be the pending onboarding revision. Recording again
 * replaces the earlier reading. The audit row `sellers.register.manual-check-recorded` is written
 * in the same unit. A manual check never overrides a definite negative of the register (AC 31).
 */
export class ReviewRecordManualCheck extends UseCase<
  ReviewRecordManualCheckInput,
  ManualCheckRecorded,
  ReviewRecordManualCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.review-record-manual-check',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_FILE_REVIEW.key] },
  };

  readonly #logger = new Logger('ReviewRecordManualCheck');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewRecordManualCheckDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewRecordManualCheckInput,
  ): Promise<Result<ManualCheckRecorded, ReviewRecordManualCheckFailure>> {
    const result = await this.record(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.review-record-manual-check',
      code: result.ok ? 'recorded' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async record(
    context: CallContext,
    input: ReviewRecordManualCheckInput,
  ): Promise<Result<ManualCheckRecorded, ReviewRecordManualCheckFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const accountId = actor.accountId;
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    const fields: { path: string; code: string }[] = [];
    const revision =
      typeof input.revisionId === 'string'
        ? parseId<'BusinessFileRevision'>(input.revisionId)
        : null;
    if (revision === null || !revision.ok) fields.push({ path: 'revisionId', code: 'format' });
    const observed = (OBSERVED_REGISTER_OUTCOMES as readonly unknown[]).includes(
      input.observedOutcome,
    )
      ? (input.observedOutcome as ObservedRegisterOutcome)
      : null;
    if (observed === null) fields.push({ path: 'observedOutcome', code: 'enum' });
    if (revision === null || !revision.ok || observed === null) {
      return err({ code: 'validation.failed', fields });
    }
    const revisionId = revision.value;

    const { unitOfWork, files, revisions, reviewChecks, audit, clock } = this.deps;
    try {
      return await unitOfWork.run<ManualCheckRecorded, ReviewRecordManualCheckFailure>(
        market,
        async () => {
          const file = await files.findById(market, sellerId);
          if (file === null) return err({ code: 'file.not-found' });
          if (!(await files.hold(market, file))) return err({ code: 'conflict.stale' });
          if (file.state.decisionIntent !== null) return err({ code: 'file.decision-in-progress' });
          const current = await revisions.findById(market, sellerId, revisionId);
          if (current === null || current.status !== 'pending' || current.kind !== 'onboarding') {
            return err({ code: 'review.not-current-revision' });
          }
          await reviewChecks.recordManualRegisterCheck(market, sellerId, {
            revisionId,
            observed,
            recordedByAccountId: accountId,
            recordedAt: clock.now(),
          });
          await audit.record(
            context,
            ManualRegisterCheckRecorded.entry(sellerId, {
              after: { revisionId, observedOutcome: observed },
            }),
          );
          return ok({ revisionId, observedOutcome: observed });
        },
      );
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.review-record-manual-check.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
