import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { maskEmailAddress, parseEmailAddress } from '../../domain/email-address';
import {
  finish,
  logEmailChangeMail,
  type SendEmailChangeMailFailure,
  type SendEmailChangeMailOutput,
  type SendEmailChangedMailDependencies,
  type SendEmailChangedMailInput,
} from '../accounts/email-change-mails';

/**
 * The notice to the PREVIOUS address once the customer confirmed the change (customers admin
 * email change; Mohammad 3, Hassan R9, R11, M1), from the subscription
 * `identity.email-changed-mail` on `identity.account-email-changed.v1`. Rule `system`. The notice
 * of exactly this change is read by the event's aggregate version (no address in the event): the
 * previous address is the recipient and the new address of this change is shown masked, so two
 * quick changes each notice their own previous address. Only that row is deleted, in the
 * delivery's once-only unit after the send; a notice another change wrote meanwhile stays. A
 * notice without a button: when, the new address masked, "not you? contact support".
 */
export class SendEmailChangedMail extends UseCase<
  SendEmailChangedMailInput,
  SendEmailChangeMailOutput,
  SendEmailChangeMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-email-changed-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendEmailChangedMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendEmailChangedMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendEmailChangedMailInput,
  ): Promise<Result<SendEmailChangeMailOutput, SendEmailChangeMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, emailChanges } = this.deps;
    const accountId = input.accountId as Id<'Account'>;
    const version = input.aggregateVersion;
    if (!Number.isSafeInteger(version) || version < 2) {
      throw new Error('send-email-changed-mail: the event has no usable aggregate version');
    }
    const loaded = await unitOfWork.run(
      market,
      async () => ok(await emailChanges.noticeOf(market, accountId, version)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-email-changed-mail: the read unit failed');
    const notice = loaded.value;
    const forget = async () => {
      await emailChanges.forgetNotice(market, accountId, version);
    };
    let output: SendEmailChangeMailOutput;
    if (notice === 'missing') {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'email-change.no-notice',
      });
    } else if (notice === 'unreadable') {
      output = await finish(
        unitOfWork,
        context,
        input.delivery,
        { code: 'email-change-mail.skipped', reason: 'email-change.notice-unreadable' },
        forget,
      );
    } else {
      const next = parseEmailAddress(notice.newEmail);
      const composed = this.deps.composer.compose(market, {
        template: 'email-changed',
        population: 'customer',
        maskedEmail: next.ok ? maskEmailAddress(next.value) : '***',
        changedAt: input.occurredAt,
      });
      await this.deps.transport.send({
        to: notice.previousEmail,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
      output = await finish(
        unitOfWork,
        context,
        input.delivery,
        { code: 'email-change-mail.sent' },
        forget,
      );
    }
    logEmailChangeMail(this.#logger, 'send-email-changed-mail', context, input, output);
    return ok(output);
  }
}
