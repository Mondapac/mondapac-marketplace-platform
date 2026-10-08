import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { withdrawn } from '../../domain/business-file-revision';
import { WITHDRAW_LIMITS } from '../../domain/rate-limits';
import {
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
} from '../draft/draft-support';
import type { DraftConflict, FileNotFound } from '../draft/draft-view';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

export type MyFileWithdrawFailure =
  | { readonly code: 'file.nothing-to-withdraw' }
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | FileNotFound
  | DraftConflict;

export interface MyFileWithdrawDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.withdraw` (sellers design 3.1, 6.2; slice 5b): the Seller Owner cancels the pending
 * submission (cause `cancelled`). Rule `permissions [sellers.business-identity.edit]`, allowed
 * while not approved. At most 10 withdrawals a day per file are reserved before the work (6.5).
 * One read-write unit: the file row is compare-and-set on the version read (it takes the row lock
 * and serialises against a save, a submission and a decision), the pending revision is closed with
 * `UPDATE … WHERE status = 'pending'` and its row count checked, and
 * `sellers.business-file-withdrawn.v1` is appended at the new version. A revision that is no
 * longer pending when the write runs (a decision got there first) is `conflict.stale`; with none
 * at all the answer is `file.nothing-to-withdraw`. The draft stays as it is.
 */
export class MyFileWithdraw extends UseCase<
  Record<string, never>,
  { readonly version: number },
  MyFileWithdrawFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-withdraw',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileWithdrawDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<{ readonly version: number }, MyFileWithdrawFailure>> {
    const result = await this.withdraw(context);
    logDraftOutcome(
      'my-file-withdraw',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'withdrawn' : result.error.code,
    );
    return result;
  }

  private async withdraw(
    context: CallContext,
  ): Promise<Result<{ readonly version: number }, MyFileWithdrawFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, revisions, outbox, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, WITHDRAW_LIMITS, owner.sellerId);
    if (!reserved.ok) return reserved;

    return unitOfWork.run<{ readonly version: number }, MyFileWithdrawFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      const pending = await revisions.findPending(market, owner.sellerId);
      if (pending === null) return err({ code: 'file.nothing-to-withdraw' });
      const now = clock.now();
      const closed = withdrawn(pending, 'cancelled', 'seller', now);
      if (!closed.ok) return err({ code: 'conflict.stale' });
      file.recordWithdrawal({ revisionId: pending.id, cause: 'cancelled', byKind: 'seller' }, now);
      if (!(await files.recordChange(market, file))) return err({ code: 'conflict.stale' });
      if (!(await revisions.saveWithdrawal(market, closed.value))) {
        return err({ code: 'conflict.stale' });
      }
      await outbox.append(context, file.pendingEvents);
      return ok({ version: file.state.version });
    });
  }
}
