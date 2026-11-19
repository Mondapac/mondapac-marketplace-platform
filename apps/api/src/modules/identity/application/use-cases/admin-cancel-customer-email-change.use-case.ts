import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { AccountEmailChangeCancelledAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { StepUpRepository } from '../ports/step-up.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { AdminStepUpConsumer } from '../step-up/admin-step-up-consumer';
import {
  CUSTOMER_EMAIL_CHANGE_KEY,
  EMAIL_CHANGE_PURPOSE,
  isPlainAdmin,
} from './admin-request-customer-email-change.use-case';

export interface AdminCancelCustomerEmailChangeInput {
  readonly accountId: Id<'Account'>;
}

export type AdminCancelCustomerEmailChangeOutput = { readonly code: 'email-change.cancelled' };

export type AdminCancelCustomerEmailChangeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'account.unknown' }
  /** No change is pending for this account: nothing to cancel. */
  | { readonly code: 'email-change.none' }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string };

export interface AdminCancelCustomerEmailChangeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly links: OneTimeLinkRepository;
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `identity.admin-cancel-customer-email-change`: an admin cancels a customer's pending email
 * change (customers admin email change). Rule `permissions [customers.customer-email.change]`, as
 * the request, checked again in the unit; acting-as refused. One read-write unit: a customer
 * account of the Market (else `account.unknown`) with a pending change (else `email-change.none`);
 * the admin's fresh step-up proof spent (R4); the pending address cleared (one version step, no
 * event, Mohammad 4); the `confirm-email-change` link requested again without a mail, in the same
 * unit (R2), so a token already mailed stops working and a mail still queued is skipped as
 * superseded; the audit row `identity.account.email-change-cancelled`.
 */
export class AdminCancelCustomerEmailChange extends UseCase<
  AdminCancelCustomerEmailChangeInput,
  AdminCancelCustomerEmailChangeOutput,
  AdminCancelCustomerEmailChangeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-cancel-customer-email-change',
    rule: { kind: 'permissions', allOf: [CUSTOMER_EMAIL_CHANGE_KEY] },
  };

  readonly #logger = new Logger('AdminCancelCustomerEmailChange');
  readonly #stepUp: AdminStepUpConsumer;

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCancelCustomerEmailChangeDependencies,
  ) {
    super(gate);
    this.#stepUp = new AdminStepUpConsumer(deps);
  }

  protected async handle(
    context: CallContext,
    input: AdminCancelCustomerEmailChangeInput,
  ): Promise<Result<AdminCancelCustomerEmailChangeOutput, AdminCancelCustomerEmailChangeFailure>> {
    const result = await this.#handle(context, input);
    this.#logger.log({
      msg: 'identity.admin-cancel-customer-email-change',
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #handle(
    context: CallContext,
    input: AdminCancelCustomerEmailChangeInput,
  ): Promise<Result<AdminCancelCustomerEmailChangeOutput, AdminCancelCustomerEmailChangeFailure>> {
    const { market, actor } = context;
    if (!isPlainAdmin(context) || actor.kind !== 'authenticated') {
      return err({ code: 'access.denied' });
    }
    const { deps } = this;
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    try {
      return await deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<AdminCancelCustomerEmailChangeOutput, AdminCancelCustomerEmailChangeFailure>
        > => {
          const now = deps.clock.now();
          const reading = await readActingGrants(
            deps,
            market,
            self,
            [],
            [CUSTOMER_EMAIL_CHANGE_KEY],
          );
          if (reading === null) return err({ code: 'access.denied' });
          const account = await deps.accounts.findById(market, input.accountId);
          if (account === null || account.state.population !== 'customer') {
            return err({ code: 'account.unknown' });
          }
          if ((account.state.pendingEmail ?? null) === null) {
            return err({ code: 'email-change.none' });
          }
          const spent = await this.#stepUp.consume(context, CUSTOMER_EMAIL_CHANGE_KEY);
          if (!spent.ok) {
            const refusal = spent.error;
            if (
              refusal.code === 'second-factor.required' ||
              refusal.code === 'second-factor.enrolment-required'
            ) {
              return err({ code: refusal.code, actionKey: refusal.actionKey });
            }
            return err(
              refusal.code === 'access.unavailable'
                ? { code: 'access.unavailable' }
                : { code: 'access.denied' },
            );
          }
          account.cancelEmailChange();
          await deps.accounts.save(market, account);
          // R2: the link is requested again (no mail) in the unit of the column change.
          const link = await deps.links.findFor(market, account.state.id, EMAIL_CHANGE_PURPOSE);
          if (link !== null) {
            link.requestAgain(now, false);
            await deps.links.save(market, link);
          }
          await deps.audit.record(
            context,
            AccountEmailChangeCancelledAudit.entry(account.state.id, {
              after: { stepUpSessionId: spent.value.sessionId },
            }),
          );
          return ok({ code: 'email-change.cancelled' });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError || error instanceof TransactionConflictError) {
        return err({ code: 'access.unavailable' });
      }
      throw error;
    }
  }
}
