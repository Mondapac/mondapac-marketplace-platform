import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import { EMAIL_CHANGE_PURPOSE } from './admin-request-customer-email-change.use-case';

export interface CancelCustomerEmailChangeForDeletionInput {
  /** As the caller passed it; parsed here. */
  readonly accountId: string;
}

/** Whether a pending change was cancelled; false when none was pending (or no such customer). */
export type CancelCustomerEmailChangeForDeletionOutput = { readonly cancelled: boolean };

export type CancelCustomerEmailChangeForDeletionFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface CancelCustomerEmailChangeForDeletionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly clock: Clock;
}

/**
 * `identity.cancel-customer-email-change-for-deletion`: a customer's account deletion was
 * requested (by the customer or by an admin), so a pending sign-in email change of that account is
 * cancelled (customers admin email change; Hassan R6, L2; Sajad: a merge condition). Rule
 * `system`: customers calls it from its subscriber on its own deletion-requested events, with the
 * Market's system actor from the dispatcher. One read-write unit, as the admin's cancel without
 * the step-up: the pending address cleared (one version step, no event) and the
 * `confirm-email-change` link requested again without a mail, so a mailed token stops working.
 * Repeat-safe: nothing pending answers `cancelled: false`. Logged by id only; no audit row (the
 * deletion request is audited by customers).
 */
export class CancelCustomerEmailChangeForDeletion extends UseCase<
  CancelCustomerEmailChangeForDeletionInput,
  CancelCustomerEmailChangeForDeletionOutput,
  CancelCustomerEmailChangeForDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.cancel-customer-email-change-for-deletion',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CancelCustomerEmailChangeForDeletion');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CancelCustomerEmailChangeForDeletionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CancelCustomerEmailChangeForDeletionInput,
  ): Promise<
    Result<CancelCustomerEmailChangeForDeletionOutput, CancelCustomerEmailChangeForDeletionFailure>
  > {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const raw = input?.accountId as unknown;
    const parsed = typeof raw === 'string' ? parseId<'Account'>(raw) : null;
    if (parsed === null || !parsed.ok) return ok({ cancelled: false });
    const accountId = parsed.value;
    const { deps } = this;
    let result: Result<
      CancelCustomerEmailChangeForDeletionOutput,
      CancelCustomerEmailChangeForDeletionFailure
    >;
    try {
      result = await deps.unitOfWork.run<CancelCustomerEmailChangeForDeletionOutput, never>(
        market,
        async () => {
          const account = await deps.accounts.findById(market, accountId);
          if (account === null || account.state.population !== 'customer') {
            return ok({ cancelled: false });
          }
          if (!account.cancelEmailChange()) return ok({ cancelled: false });
          await deps.accounts.save(market, account);
          // R2: the link is requested again (no mail) in the unit of the column change.
          const link = await deps.links.findFor(market, accountId, EMAIL_CHANGE_PURPOSE);
          if (link !== null) {
            link.requestAgain(deps.clock.now(), false);
            await deps.links.save(market, link);
          }
          return ok({ cancelled: true });
        },
      );
    } catch (error) {
      if (!(error instanceof StaleAggregateError || error instanceof TransactionConflictError)) {
        throw error;
      }
      result = err({ code: 'access.unavailable' });
    }
    this.#logger.log({
      msg: 'identity.cancel-customer-email-change-for-deletion',
      outcome: result.ok ? (result.value.cancelled ? 'cancelled' : 'none') : result.error.code,
      accountId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
