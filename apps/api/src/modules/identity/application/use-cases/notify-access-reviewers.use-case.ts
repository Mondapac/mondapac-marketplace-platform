import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerAccess } from '../../domain/seller-access';
import type { AccessReviewer, AccessReviewers } from '../ports/access-reviewers';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';
import type { SellerAccessRepository } from '../ports/seller-access.repository';

/** The most admins one notice goes to, in account-id order (Ali C6; Hassan Q4). */
export const MAX_REVIEWER_RECIPIENTS = 50;
/** One send may take this long; then it counts as failed and the next one starts (Hassan L2). */
export const REVIEWER_NOTICE_SEND_TIMEOUT_MS = 5_000;
/**
 * The whole fan-out may take this long, below the caller's 30-second deadline (sellers 7.3;
 * Hassan L2). When it runs out no further send starts.
 */
export const REVIEWER_NOTICE_BUDGET_MS = 20_000;

export interface NotifyAccessReviewersInput {
  /** As the caller passed it; parsed here, and never echoed when it does not parse. */
  readonly sellerId: string;
}

export type NotifyAccessReviewersOutput =
  | { readonly code: 'reviewer-notice.sent' }
  | {
      readonly code: 'reviewer-notice.skipped';
      readonly reason: 'seller.unknown' | 'seller.not-pending' | 'recipients.none';
    };

export type NotifyAccessReviewersFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'reviewer-notice.unavailable' };

export interface NotifyAccessReviewersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerAccess: SellerAccessRepository;
  readonly reviewers: AccessReviewers;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/** How one send ended. */
type SendOutcome = 'sent' | 'failed';

const UNAVAILABLE = Object.freeze({ code: 'reviewer-notice.unavailable' as const });

/**
 * The reviewer notice (identity design 8.7; `ux.md` E3; SEL-02; request R-3). Rule `system`,
 * behind `SellerAccessContract.notifyAccessReviewers`, which only `sellers` may import: its
 * `sellers.after-submission` handler calls it after an onboarding submission, so the notice
 * follows a submission, never the owner's email verification (which no subscriber of identity
 * turns into this mail).
 *
 * The Market comes only from the context. The seller must be registered in it and `pending`;
 * an unknown, foreign or unregistered seller answers `seller.unknown`, identically. The
 * recipients are the admins who may approve (`AccessReviewers`), at most
 * {@link MAX_REVIEWER_RECIPIENTS}; none is `recipients.none` with a warning
 * (`identity.reviewer-notice.no-recipients`), with no fallback mailbox. One mail per recipient,
 * one address each, fixed text without seller data, linking to the configured review queue.
 *
 * It writes nothing: two read-only units and the sends, outside any unit; no inbox, outbox or
 * audit row (8.7; Hassan Q8). It is not idempotent by itself: the caller coalesces. Sends run one
 * after another, each bounded by {@link REVIEWER_NOTICE_SEND_TIMEOUT_MS}, all of them by
 * {@link REVIEWER_NOTICE_BUDGET_MS}; when the budget runs out no further send starts. At least
 * one send accepted is `sent`, none is `unavailable`. Logs carry ids, codes and counts only.
 */
export class NotifyAccessReviewers extends UseCase<
  NotifyAccessReviewersInput,
  NotifyAccessReviewersOutput,
  NotifyAccessReviewersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.notify-access-reviewers',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('NotifyAccessReviewers');

  constructor(
    gate: UseCaseGate,
    private readonly deps: NotifyAccessReviewersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: NotifyAccessReviewersInput,
  ): Promise<Result<NotifyAccessReviewersOutput, NotifyAccessReviewersFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const parsed = parseId<'Seller'>(input.sellerId);
    if (!parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
    }
    const sellerId = parsed.value;
    const { market } = context;

    let seller: SellerAccess | null;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.sellerAccess.findById(market, sellerId)),
        { readOnly: true },
      );
      if (!read.ok) return this.unavailable(context, sellerId, 'seller-read-failed');
      seller = read.value;
    } catch {
      return this.unavailable(context, sellerId, 'seller-read-failed');
    }
    // A seller of another Market is not found in this one: the same answer as a never-issued id.
    if (seller === null || !seller.isRegistered) {
      return this.skipped(context, sellerId, 'seller.unknown');
    }
    if (seller.state.state !== 'pending') {
      return this.skipped(context, sellerId, 'seller.not-pending');
    }

    let reviewers: readonly AccessReviewer[];
    try {
      reviewers = await this.deps.reviewers.reviewersOf(market);
    } catch {
      return this.unavailable(context, sellerId, 'recipients-read-failed');
    }
    if (reviewers.length === 0) {
      // Fails closed, but never silently: before a deployed environment opens seller sign-up
      // this becomes an operational alert (identity design 8.7; Ali C7).
      this.#logger.warn({
        msg: 'identity.reviewer-notice.no-recipients',
        sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return this.skipped(context, sellerId, 'recipients.none');
    }
    if (reviewers.length > MAX_REVIEWER_RECIPIENTS) {
      this.#logger.error({
        msg: 'identity.reviewer-notice.recipients-capped',
        count: reviewers.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    const recipients = reviewers.slice(0, MAX_REVIEWER_RECIPIENTS);

    const url = this.deps.targets.target(market, 'admin', 'seller-review-queue');
    if (url === null) return this.unavailable(context, sellerId, 'no-review-queue-page');
    const composed = this.deps.composer.compose(market, {
      template: 'reviewer-notice',
      population: 'admin',
      url,
    });
    const from = this.deps.policy.mailSender(market);

    const counts = await this.fanOut(
      recipients.map((recipient) => ({
        to: recipient.email,
        from,
        subject: composed.subject,
        text: composed.text,
      })),
    );
    const fields = {
      sellerId,
      recipients: recipients.length,
      ...counts,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (counts.sent === 0) {
      this.#logger.warn({
        msg: 'identity.reviewer-notice.unavailable',
        reason: 'no-send-accepted',
        ...fields,
      });
      return err(UNAVAILABLE);
    }
    if (counts.failed > 0 || counts.notAttempted > 0) {
      this.#logger.warn({ msg: 'identity.reviewer-notice.sent', ...fields });
    } else {
      this.#logger.log({ msg: 'identity.reviewer-notice.sent', ...fields });
    }
    return ok({ code: 'reviewer-notice.sent' });
  }

  /**
   * Sends one message after another within the budget (Hassan L2). A send that has not settled
   * within its timeout counts as failed and is no longer awaited; once the budget is spent no
   * further send starts, and every timer is cleared before this returns.
   */
  private async fanOut(
    messages: readonly MailMessage[],
  ): Promise<{ sent: number; failed: number; notAttempted: number }> {
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), REVIEWER_NOTICE_BUDGET_MS);
    let sent = 0;
    let failed = 0;
    let attempted = 0;
    try {
      for (const message of messages) {
        if (budget.signal.aborted) break;
        attempted += 1;
        const outcome = await this.sendWithin(message, budget.signal);
        if (outcome === 'sent') sent += 1;
        else failed += 1;
      }
    } finally {
      clearTimeout(budgetTimer);
    }
    return { sent, failed, notAttempted: messages.length - attempted };
  }

  private async sendWithin(message: MailMessage, budget: AbortSignal): Promise<SendOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // Never rejects: a failure is a count, and a send abandoned at its timeout cannot surface
    // as an unhandled rejection later.
    const attempt = this.deps.transport.send(message).then(
      (): SendOutcome => 'sent',
      (): SendOutcome => 'failed',
    );
    const cutOff = new Promise<SendOutcome>((resolve) => {
      timer = setTimeout(() => resolve('failed'), REVIEWER_NOTICE_SEND_TIMEOUT_MS);
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

  private skipped(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: 'seller.unknown' | 'seller.not-pending' | 'recipients.none',
  ): Result<NotifyAccessReviewersOutput, never> {
    this.#logger.log({
      msg: 'identity.reviewer-notice.skipped',
      reason,
      sellerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ code: 'reviewer-notice.skipped', reason });
  }

  private unavailable(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: 'seller-read-failed' | 'recipients-read-failed' | 'no-review-queue-page',
  ): Result<never, NotifyAccessReviewersFailure> {
    this.#logger.error({
      msg: 'identity.reviewer-notice.unavailable',
      reason,
      sellerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(UNAVAILABLE);
  }
}
