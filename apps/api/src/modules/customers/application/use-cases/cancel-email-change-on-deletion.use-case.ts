import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountDeletionRequestRepository } from '../ports/account-deletion-request.repository';
import type { EmailChangePeer } from '../ports/email-change-peer';

export interface CancelEmailChangeOnDeletionInput {
  /** The deletion request: the aggregate id of the deletion-requested event. */
  readonly requestId: string;
  readonly delivery: EventDelivery;
}

export type CancelEmailChangeOnDeletionOutput =
  | { readonly code: 'email-change.cancelled' }
  | { readonly code: 'email-change.none' }
  | { readonly code: 'deletion-request.gone' }
  | { readonly code: 'delivery.already-handled' };

export type CancelEmailChangeOnDeletionFailure = { readonly code: 'access.denied' };

export interface CancelEmailChangeOnDeletionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: AccountDeletionRequestRepository;
  readonly identity: Pick<EmailChangePeer, 'cancelCustomerEmailChangeForDeletion'>;
}

/**
 * `customers.cancel-email-change-on-deletion`: once a customer's account deletion is requested
 * (by the customer or by an admin), a pending sign-in email change of that account is cancelled in
 * identity (customers admin email change; Hassan R6, L2; Sajad: a merge condition), so the mailed
 * link cannot move the account to another address while it waits to be erased. Rule `system`:
 * from customers' subscriptions on its own deletion-requested events (the events carry no account
 * id; the request row has it). identity's cancel is repeat-safe; the delivery is marked handled
 * after it. A failure in identity throws, so the delivery is retried. Logged by id only.
 */
export class CancelEmailChangeOnDeletion extends UseCase<
  CancelEmailChangeOnDeletionInput,
  CancelEmailChangeOnDeletionOutput,
  CancelEmailChangeOnDeletionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.cancel-email-change-on-deletion',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CancelEmailChangeOnDeletion');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CancelEmailChangeOnDeletionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CancelEmailChangeOnDeletionInput,
  ): Promise<Result<CancelEmailChangeOnDeletionOutput, CancelEmailChangeOnDeletionFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, requests, identity } = this.deps;
    const requestId = parseId<'AccountDeletionRequest'>(input.requestId);
    const read = requestId.ok
      ? await unitOfWork.run(
          market,
          async () => ok(await requests.findById(market, requestId.value)),
          {
            readOnly: true,
          },
        )
      : ok(null);
    if (!read.ok) throw new Error('cancel-email-change-on-deletion: the read unit failed');
    let outcome: CancelEmailChangeOnDeletionOutput;
    if (read.value === null) {
      outcome = { code: 'deletion-request.gone' };
    } else {
      const cancelled = await identity.cancelCustomerEmailChangeForDeletion(
        context,
        read.value.accountId,
      );
      if (!cancelled.ok) {
        this.#logger.warn({
          msg: 'customers.cancel-email-change-on-deletion',
          outcome: cancelled.error.code,
          requestId: input.requestId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        throw new Error(
          `cancel-email-change-on-deletion: identity refused: ${cancelled.error.code}`,
        );
      }
      outcome = cancelled.value.cancelled
        ? { code: 'email-change.cancelled' }
        : { code: 'email-change.none' };
    }
    const marked = await unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('cancel-email-change-on-deletion: the inbox unit failed');
    const output: CancelEmailChangeOnDeletionOutput = marked.value.handled
      ? outcome
      : { code: 'delivery.already-handled' };
    this.#logger.log({
      msg: 'customers.cancel-email-change-on-deletion',
      outcome: output.code,
      requestId: input.requestId,
      ...(read.value === null ? {} : { accountId: read.value.accountId }),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
