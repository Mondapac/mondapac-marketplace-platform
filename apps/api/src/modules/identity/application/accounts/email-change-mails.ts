// Shared parts of the two email change notices (customers admin email change).
import type { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountRepository, EmailChangeStore } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';

/** One delivery of an email change event (customers admin email change). */
export interface SendEmailChangeMailInput {
  readonly delivery: EventDelivery;
  readonly accountId: Id;
  /** When the change was asked for or confirmed: the event's instant, written in the mail. */
  readonly occurredAt: Temporal.Instant;
}

export type EmailChangeMailSkipped =
  | 'account.gone'
  | 'account.population'
  /** The warning: the request is no longer the pending one (confirmed, cancelled, replaced). */
  | 'email-change.superseded'
  /** The notice: no previous address waits (already sent, or the account's key is destroyed). */
  | 'email-change.no-previous-email';

export type SendEmailChangeMailOutput =
  | { readonly code: 'email-change-mail.sent' }
  | { readonly code: 'email-change-mail.skipped'; readonly reason: EmailChangeMailSkipped }
  | { readonly code: 'email-change-mail.already-handled' };

export type SendEmailChangeMailFailure = { readonly code: 'access.denied' };

export interface SendEmailChangeRequestedMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

export interface SendEmailChangedMailDependencies extends SendEmailChangeRequestedMailDependencies {
  readonly emailChanges: EmailChangeStore;
}

/** Marks the delivery handled in its once-only unit and answers what the handler did. */
export async function finish(
  unitOfWork: UnitOfWork,
  context: CallContext,
  delivery: EventDelivery,
  done: SendEmailChangeMailOutput,
  work: () => Promise<void> = () => Promise.resolve(),
): Promise<SendEmailChangeMailOutput> {
  const marked = await unitOfWork.runOnce(context.market, delivery, async () => {
    await work();
    return ok(undefined);
  });
  if (!marked.ok) throw new Error('send-email-change-mail: the inbox unit failed');
  return marked.value.handled ? done : { code: 'email-change-mail.already-handled' };
}

export function logEmailChangeMail(
  logger: Logger,
  name: string,
  context: CallContext,
  input: SendEmailChangeMailInput,
  output: SendEmailChangeMailOutput,
): void {
  // Ids and codes only: never an address or the body (P 12.3).
  logger.log({
    msg: `identity.${name}`,
    outcome: output.code,
    ...(output.code === 'email-change-mail.skipped' ? { reason: output.reason } : {}),
    accountId: input.accountId,
    eventId: input.delivery.eventId,
    attempt: input.delivery.attempt,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
