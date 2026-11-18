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
  type SendEmailChangeRequestedMailDependencies,
} from '../accounts/email-change-mails';

/**
 * The warning to the CURRENT address after an admin asked to change it (customers admin email
 * change; Hassan R9), from the subscription `identity.email-change-requested-mail` on
 * `identity.account-email-change-requested.v1`. Rule `system`. A notice without a button: when,
 * the new address masked by code, "nothing changes until it is confirmed", "not you? contact
 * support". Skipped when the request is no longer the pending one (Mohammad 3: confirmed already,
 * cancelled, or replaced by a newer request, which has a warning of its own). As the other
 * handlers: read-only unit, send outside any unit, `runOnce` marks the delivery (at least once).
 */
export class SendEmailChangeRequestedMail extends UseCase<
  SendEmailChangeMailInput,
  SendEmailChangeMailOutput,
  SendEmailChangeMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-email-change-requested-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendEmailChangeRequestedMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendEmailChangeRequestedMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendEmailChangeMailInput,
  ): Promise<Result<SendEmailChangeMailOutput, SendEmailChangeMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;
    const loaded = await unitOfWork.run(
      market,
      async () => ok(await accounts.findById(market, input.accountId as Id<'Account'>)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-email-change-requested-mail: the read unit failed');
    const account = loaded.value;
    const pending = account?.state.pendingEmail ?? null;
    const pendingAt = account?.state.pendingEmailRequestedAt ?? null;
    let output: SendEmailChangeMailOutput;
    if (account === null) {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'account.gone',
      });
    } else if (account.state.population !== 'customer') {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'account.population',
      });
    } else if (
      pending === null ||
      pendingAt === null ||
      pendingAt.epochMilliseconds !== input.occurredAt.epochMilliseconds
    ) {
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.skipped',
        reason: 'email-change.superseded',
      });
    } else {
      const composed = this.deps.composer.compose(market, {
        template: 'email-change-requested',
        population: 'customer',
        maskedEmail: maskEmailAddress(pending),
        changedAt: input.occurredAt,
      });
      await this.deps.transport.send({
        to: account.state.email.typed,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
      output = await finish(unitOfWork, context, input.delivery, {
        code: 'email-change-mail.sent',
      });
    }
    logEmailChangeMail(this.#logger, 'send-email-change-requested-mail', context, input, output);
    return ok(output);
  }
}
