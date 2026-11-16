import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { maskEmailAddress } from '../../domain/email-address';
import {
  finish,
  logEmailChangeMail,
  type SendEmailChangeMailFailure,
  type SendEmailChangeMailInput,
  type SendEmailChangeMailOutput,
  type SendEmailChangedMailDependencies,
} from '../accounts/email-change-mails';

/**
 * The notice to the PREVIOUS address once the customer confirmed the change (customers admin
 * email change; Mohammad 3, Hassan R9, R11), from the subscription `identity.email-changed-mail` on
 * `identity.account-email-changed.v1`. Rule `system`. The previous address is read sealed from the
 * account, where the confirmation's unit kept it (no address in the event), and cleared in the
 * delivery's once-only unit after the send. A notice without a button: when, the new address
 * masked, "not you? contact support".
 */
export class SendEmailChangedMail extends UseCase<
  SendEmailChangeMailInput,
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
    input: SendEmailChangeMailInput,
  ): Promise<Result<SendEmailChangeMailOutput, SendEmailChangeMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts, emailChanges } = this.deps;
    const accountId = input.accountId as Id<'Account'>;
    const loaded = await unitOfWork.run(
      market,
      async () => {
        const account = await accounts.findById(market, accountId);
        const previous =
          account === null ? null : await emailChanges.previousEmailOf(market, accountId);
        return ok({ account, previous });
      },
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-email-changed-mail: the read unit failed');
    const { account, previous } = loaded.value;
    let output: SendEmailChangeMailOutput;
    if (account === null) {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'account.gone',
      });
    } else if (previous === null) {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'email-change.no-previous-email',
      });
    } else {
      const composed = this.deps.composer.compose(market, {
        template: 'email-changed',
        population: 'customer',
        maskedEmail: maskEmailAddress(account.state.email),
        changedAt: input.occurredAt,
      });
      await this.deps.transport.send({
        to: previous,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
      output = await finish(
        unitOfWork,
        context,
        input.delivery,
        { code: 'email-change-mail.sent' },
        () => emailChanges.forgetPreviousEmail(market, accountId),
      );
    }
    logEmailChangeMail(this.#logger, 'send-email-changed-mail', context, input, output);
    return ok(output);
  }
}
