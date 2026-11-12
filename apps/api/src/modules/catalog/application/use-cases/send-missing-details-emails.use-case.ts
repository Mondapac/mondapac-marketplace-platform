import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { MissingDetailsEmail } from '../../domain/missing-details-email';
import type { MissingDetailsEmailStore } from '../ports/missing-details-email.store';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';

/** The emails one run takes (each send may take up to 5 s; the job allows 120 s). */
export const MISSING_DETAILS_EMAIL_BATCH_SIZE = 20;
/** A run starts no new send after this long, so it ends within the job's `maxRunMs`. */
export const MISSING_DETAILS_EMAIL_RUN_BUDGET_MS = 90_000;

export interface SendMissingDetailsEmailsOutput {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export type SendMissingDetailsEmailsFailure = { readonly code: 'access.denied' };

export interface SendMissingDetailsEmailsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly detailsEmails: MissingDetailsEmailStore;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly clock: Clock;
}

type Step = 'sent' | 'skipped' | 'deferred' | 'failed';

/**
 * `catalog.send-missing-details-emails` (attributes A4-4): rule `system`, the job's use case, one
 * call per hosted Market. A read-only unit takes the pending "Email sellers" emails that are due;
 * each is then handled on its own, as catalog's other notices: the Seller Owner's address comes
 * through `identity`'s contact point (none: `skipped`), the stored plain-text mail (rendered when
 * the admin queued it, so it is what the dialog previewed) is sent outside any unit, then a unit
 * marks it `sent` with the time. A failed send is tried again later or, at the last attempt,
 * `failed` (an error log). Only a crash between a send and its marker sends that one email again.
 * The log holds ids, codes and counts, never an address or the text.
 */
export class SendMissingDetailsEmails extends UseCase<
  Record<string, never>,
  SendMissingDetailsEmailsOutput,
  SendMissingDetailsEmailsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.send-missing-details-emails',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendMissingDetailsEmails');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendMissingDetailsEmailsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendMissingDetailsEmailsOutput, SendMissingDetailsEmailsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const started = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () =>
        ok(await deps.detailsEmails.dueNotices(market, started, MISSING_DETAILS_EMAIL_BATCH_SIZE)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('missing-details-emails: the read unit failed');

    const counts = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    let budgetSpent = false;
    for (const email of read.value) {
      if (
        deps.clock.now().epochMilliseconds - started.epochMilliseconds >=
        MISSING_DETAILS_EMAIL_RUN_BUDGET_MS
      ) {
        budgetSpent = true;
        break;
      }
      counts[await this.#one(context, email)] += 1;
    }
    const output = { examined: read.value.length, ...counts, budgetSpent };
    const log = {
      msg: 'catalog.missing-details-emails.run',
      ...output,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (budgetSpent || counts.failed > 0) this.#logger.warn(log);
    else this.#logger.log(log);
    return ok(output);
  }

  async #one(context: CallContext, email: MissingDetailsEmail): Promise<Step> {
    const { deps } = this;
    const { market } = context;
    const mark = async (next: MissingDetailsEmail | null): Promise<void> => {
      if (next === null) return;
      const done = await deps.unitOfWork.run(market, async () => {
        await deps.detailsEmails.saveNotice(market, next);
        return ok(true);
      });
      if (!done.ok) throw new Error('missing-details-emails: the marker unit failed');
    };

    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, email.state.sellerId);
      if (to === null) {
        await mark(email.skipped());
        return 'skipped';
      }
      await deps.mailTransport.send({
        to,
        from: deps.mailSettings.sender(market),
        subject: email.state.subject,
        text: email.state.text,
      });
    } catch {
      sendFailed = true;
    }
    if (!sendFailed) {
      await mark(email.sent(deps.clock.now()));
      return 'sent';
    }
    const next = email.failedAt(deps.clock.now());
    await mark(next);
    const failed = next !== null && next.state.noticeState === 'failed';
    const base = {
      emailId: email.state.id,
      attempts: email.state.noticeAttempts + 1,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (failed) {
      this.#logger.error({ msg: 'catalog.missing-details-emails.failed', ...base });
      return 'failed';
    }
    this.#logger.warn({ msg: 'catalog.missing-details-emails.deferred', ...base });
    return 'deferred';
  }
}
