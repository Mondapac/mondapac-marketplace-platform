import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogWorkQueueFacade } from '../../../catalog';
import type { IdentityFacade } from '../../../identity';
import type { SettingsFacade } from '../../../settings';
import { ADMIN_NOTICES_PER_MARKET, ADMIN_OFFER_QUEUE_BACKLOG } from '../../domain/in-app-notice';
import {
  assessBacklog,
  type OfferQueueBacklogLimits,
  type OfferQueueBacklogReason,
} from '../../domain/offer-queue-backlog';
import { offerQueueBacklogMail } from '../../domain/offer-queue-backlog-mail';
import type { InAppNoticeRepository } from '../ports/in-app-notice.repository';
import type { NotificationsPolicy } from '../ports/notifications-policy';
import type { OfferQueueBacklogRepository } from '../ports/offer-queue-backlog.repository';

export interface OfferQueueBacklogDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notices: InAppNoticeRepository;
  readonly backlog: OfferQueueBacklogRepository;
  readonly catalogQueue: CatalogWorkQueueFacade;
  readonly settings: SettingsFacade;
  readonly policy: NotificationsPolicy;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** The recipients of the backlog mail (slice 8b): identity's reviewer rule over the approve key. */
  readonly identity: Pick<IdentityFacade, 'offerReviewAlertRecipients'>;
  readonly transport: MailTransport;
}

/** One send may take this long; then it counts as failed and the next one starts. */
export const BACKLOG_MAIL_SEND_TIMEOUT_MS = 5_000;
/**
 * All sends of one alert, from the first, may take this long: well below the job's 60-second
 * run limit. When it runs out no further send starts.
 */
export const BACKLOG_MAIL_BUDGET_MS = 20_000;

/** How the backlog mail of one crossing went: counts only. */
export interface BacklogMailOutcome {
  readonly recipients: number;
  readonly sent: number;
  /** Not confirmed: rejected, or cut off by its timeout or the budget (it may still arrive). */
  readonly failed: number;
  readonly notAttempted: number;
  /** The recipient read failed: no mail was sent (the panel notice stands). */
  readonly unavailable: boolean;
}

export type RaiseOfferQueueBacklogAlertOutput =
  | {
      readonly code: 'backlog.alerted';
      readonly notices: number;
      readonly mail: BacklogMailOutcome;
    }
  /** A limit is passed, and the alert of this crossing was raised before (or by an overlapping run). */
  | { readonly code: 'backlog.already-alerted' }
  /** The queue is within both limits; `rearmed` is true when an open alert was closed. */
  | { readonly code: 'backlog.within-limits'; readonly rearmed: boolean };

/** What the unit decides; the mail counts of an alert are added after it commits. */
type Written =
  | Exclude<RaiseOfferQueueBacklogAlertOutput, { readonly code: 'backlog.alerted' }>
  | { readonly code: 'backlog.alerted'; readonly notices: number };

export type RaiseOfferQueueBacklogAlertFailure =
  { readonly code: 'access.denied' } | { readonly code: 'backlog.unavailable' };

/**
 * The Offer review queue backlog alert (risk-based Offer approval, slice 8; design section 9 c).
 * Rule `system`, run by the worker job for each hosted Market. It reads the queue through catalog
 * (count and the submission time of the oldest Offer) and the two limits through settings, each
 * before the unit (a facade call never runs inside one). The limits are strict: more than the set
 * number of Offers waiting, or the oldest waiting more than the set business hours (Monday to
 * Friday in the Market's zone). Past a limit it raises one admin notice for the crossing and no
 * more: the alert row opens once (a partial unique index makes overlapping runs raise it once),
 * and stays open until the queue is back within both limits, which re-arms it. The notice holds
 * the reason, the queue size and the wait in whole hours only, and is shown to the admins who hold
 * `catalog.product.approve`, who work the queue. A queue that cannot be read raises nothing.
 *
 * Slice 8b: after the unit that raised the notice commits, the same crossing is mailed to the
 * admins identity answers for `offerReviewAlertRecipients` (the approve key, an active second
 * factor, active and verified; at most 50). One plain-text mail per recipient with counts only.
 * The mail is at most once: it is sent only by the run that opened the alert row, so a failed
 * send is not repeated (the panel notice stands); sends run one after another, each bounded by
 * {@link BACKLOG_MAIL_SEND_TIMEOUT_MS}, all by {@link BACKLOG_MAIL_BUDGET_MS}. A mail failure
 * never changes the outcome of the alert. Logs carry counts only, never an address.
 */
export class RaiseOfferQueueBacklogAlert extends UseCase<
  Record<string, never>,
  RaiseOfferQueueBacklogAlertOutput,
  RaiseOfferQueueBacklogAlertFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.raise-offer-queue-backlog-alert',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RaiseOfferQueueBacklogAlert');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferQueueBacklogDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<RaiseOfferQueueBacklogAlertOutput, RaiseOfferQueueBacklogAlertFailure>> {
    const { deps } = this;
    const now = deps.clock.now();
    const queue = await deps.catalogQueue.offerReviewQueue(context, { now });
    if (!queue.ok) {
      if (queue.error.code === 'access.denied') return err({ code: 'access.denied' });
      return err({ code: 'backlog.unavailable' });
    }
    const limits = await deps.settings.offerQueueBacklogLimits(context);
    // Without the Market's own limits nothing is raised or cleared (no guess, no duplicate alert).
    if (limits === null) return err({ code: 'backlog.unavailable' });
    const assessment = assessBacklog(
      queue.value,
      limits,
      now,
      deps.policy.marketTimezone(context.market),
    );
    const { market } = context;

    const written = await deps.unitOfWork.run<Written, never>(market, async () => {
      if (assessment.reason === null) {
        return ok({
          code: 'backlog.within-limits' as const,
          rearmed: await deps.backlog.clear(market, now),
        });
      }
      const raised = await deps.backlog.raise(
        market,
        deps.ids.next<'OfferQueueBacklogAlert'>(),
        now,
        assessment.reason,
        queue.value.count,
      );
      if (!raised) return ok({ code: 'backlog.already-alerted' as const });
      await deps.notices.add(market, [
        {
          id: deps.ids.next<'InAppNotice'>(),
          owner: { audience: 'admin' },
          kind: ADMIN_OFFER_QUEUE_BACKLOG,
          params: {
            reason: assessment.reason,
            count: queue.value.count,
            hours: assessment.waitedHours,
          },
          createdAt: now,
        },
      ]);
      await deps.notices.trim(
        market,
        { audience: 'admin' },
        ADMIN_NOTICES_PER_MARKET,
        ADMIN_OFFER_QUEUE_BACKLOG,
      );
      return ok({ code: 'backlog.alerted' as const, notices: 1 });
    });
    if (!written.ok) return err({ code: 'backlog.unavailable' });
    // Counts and codes only.
    this.#logger.log({
      msg: `notifications.${written.value.code}`,
      reason: assessment.reason,
      queue: queue.value.count,
      waitedHours: assessment.waitedHours,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    const decided = written.value;
    if (decided.code !== 'backlog.alerted') return ok(decided);
    // After the commit, outside any unit: a facade call and sends never run inside one. Only the
    // run that opened the alert row gets here, so each crossing is mailed at most once.
    const mail =
      assessment.reason === null
        ? { recipients: 0, sent: 0, failed: 0, notAttempted: 0, unavailable: false }
        : await this.mail(
            context,
            assessment.reason,
            limits,
            queue.value.count,
            assessment.waitedHours,
          );
    return ok({ ...decided, mail });
  }

  /** Mails one crossing to the queue's admins; never throws, answers counts only. */
  private async mail(
    context: CallContext,
    reason: OfferQueueBacklogReason,
    limits: OfferQueueBacklogLimits,
    count: number,
    hours: number,
  ): Promise<BacklogMailOutcome> {
    const { deps } = this;
    const { market } = context;
    const fields = { marketId: market.marketId, correlationId: context.correlationId };
    let recipients: readonly string[];
    try {
      const read = await deps.identity.offerReviewAlertRecipients(context);
      if (!read.ok) throw new Error(read.error.code);
      recipients = read.value;
    } catch {
      this.#logger.error({ msg: 'notifications.backlog-mail.unavailable', ...fields });
      return { recipients: 0, sent: 0, failed: 0, notAttempted: 0, unavailable: true };
    }
    if (recipients.length === 0) {
      // Never silent: the panel notice stands, and operations see that no admin gets the mail.
      this.#logger.warn({ msg: 'notifications.backlog-mail.no-recipients', ...fields });
      return { recipients: 0, sent: 0, failed: 0, notAttempted: 0, unavailable: false };
    }
    let composed: ReturnType<typeof offerQueueBacklogMail>;
    let from: ReturnType<NotificationsPolicy['mailSender']>;
    try {
      composed = offerQueueBacklogMail({
        reason,
        limits,
        count,
        hours,
        marketId: market.marketId,
        locale: deps.policy.defaultLocale(market),
      });
      from = deps.policy.mailSender(market);
    } catch {
      // Market configuration that cannot be read: no mail, never a thrown job (Hassan L1).
      this.#logger.error({ msg: 'notifications.backlog-mail.unavailable', ...fields });
      return { recipients: 0, sent: 0, failed: 0, notAttempted: 0, unavailable: true };
    }
    const counts = await fanOut(
      deps.transport,
      recipients.map((to) => ({ to, from, subject: composed.subject, text: composed.text })),
    );
    const outcome = { recipients: recipients.length, ...counts, unavailable: false };
    const log = { msg: 'notifications.backlog-mail.sent', ...outcome, ...fields };
    if (counts.failed > 0 || counts.notAttempted > 0) this.#logger.warn(log);
    else this.#logger.log(log);
    return outcome;
  }
}

/**
 * Sends one message after another within the budget, which starts with the first send. A send
 * that has not settled within its timeout counts as failed and is no longer awaited; once the
 * budget is spent no further send starts, and every timer is cleared before it returns.
 */
async function fanOut(
  transport: MailTransport,
  messages: readonly MailMessage[],
): Promise<{ sent: number; failed: number; notAttempted: number }> {
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), BACKLOG_MAIL_BUDGET_MS);
  let sent = 0;
  let failed = 0;
  let attempted = 0;
  try {
    for (const message of messages) {
      if (budget.signal.aborted) break;
      attempted += 1;
      if ((await sendWithin(transport, message, budget.signal)) === 'sent') sent += 1;
      else failed += 1;
    }
  } finally {
    clearTimeout(budgetTimer);
  }
  return { sent, failed, notAttempted: messages.length - attempted };
}

async function sendWithin(
  transport: MailTransport,
  message: MailMessage,
  budget: AbortSignal,
): Promise<'sent' | 'failed'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Never rejects: a failure is a count, and an abandoned send cannot surface later.
  const attempt = transport.send(message).then(
    () => 'sent' as const,
    () => 'failed' as const,
  );
  const cutOff = new Promise<'failed'>((resolve) => {
    timer = setTimeout(() => resolve('failed'), BACKLOG_MAIL_SEND_TIMEOUT_MS);
    onAbort = () => resolve('failed');
    budget.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([attempt, cutOff]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) budget.removeEventListener('abort', onAbort);
  }
}
