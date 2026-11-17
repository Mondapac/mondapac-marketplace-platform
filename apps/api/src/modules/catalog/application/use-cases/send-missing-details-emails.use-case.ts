import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MISSING_DETAILS_EMAIL_MAX_ATTEMPTS,
  missingDetailsEmail,
} from '../../domain/missing-details-email';
import type { MissingDetailsMailSettings } from '../ports/missing-details-mail-settings';
import type {
  MissingDetailsEmailStore,
  PendingMissingDetailsEmail,
} from '../ports/missing-details-email.store';
import type { OfferOwnerContact } from '../ports/offer-owner-notices';

/** Requests one run reads; a seller's products go out in one mail, so a run sends fewer mails. */
export const MISSING_DETAILS_EMAIL_BATCH = 200;
/** A run starts no new mail after this long, so it ends within the job's `maxRunMs`. */
export const MISSING_DETAILS_EMAIL_RUN_BUDGET_MS = 90_000;

export interface SendMissingDetailsEmailsOutput {
  readonly sellers: number;
  readonly sent: number;
  readonly skipped: number;
  readonly retry: number;
  readonly failed: number;
}

export type SendMissingDetailsEmailsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'missing-details-email.unconfigured' };

export interface SendMissingDetailsEmailsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly emailStore: MissingDetailsEmailStore;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly missingDetailsMailSettings: MissingDetailsMailSettings;
  readonly clock: Clock;
}

/**
 * `catalog.send-missing-details-emails` (attributes package A4-4): rule `system`, the job's use
 * case, one call per hosted Market. It takes the pending "Email sellers" requests, groups them by
 * seller and sends each seller one English mail listing that seller's products, with the Seller
 * Owner's address read through `identity` for this one send. A seller without an address settles as
 * `skipped`. A failed read or send leaves the requests pending for the next run, up to three tries,
 * then `failed` (an error log); the seller can be asked again at once, since a failed request
 * does not count for the 7-day limit. The log holds ids and counts, never an address or a name.
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
      async () => ok(await deps.emailStore.pending(market, MISSING_DETAILS_EMAIL_BATCH)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('missing-details-emails: the read unit failed');

    const page = deps.missingDetailsMailSettings.productsPage(market);
    if (read.value.length === 0)
      return ok({ sellers: 0, sent: 0, skipped: 0, retry: 0, failed: 0 });
    // Nothing is sent without the link; requests stay pending until the Market is configured.
    if (page === null) return err({ code: 'missing-details-email.unconfigured' });

    const bySeller = new Map<string, PendingMissingDetailsEmail[]>();
    for (const row of read.value) {
      const rows = bySeller.get(row.sellerId) ?? [];
      rows.push(row);
      bySeller.set(row.sellerId, rows);
    }

    const totals = { sellers: bySeller.size, sent: 0, skipped: 0, retry: 0, failed: 0 };
    for (const [sellerId, rows] of bySeller) {
      const now = deps.clock.now();
      if (
        now.epochMilliseconds - started.epochMilliseconds >=
        MISSING_DETAILS_EMAIL_RUN_BUDGET_MS
      ) {
        break;
      }
      const step = await this.#one(context, sellerId as Id<'Seller'>, rows, page);
      totals[step] += rows.length;
    }
    if (totals.failed > 0) {
      this.#logger.error({
        msg: 'catalog.missing-details-emails.run',
        ...totals,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    } else {
      this.#logger.log({
        msg: 'catalog.missing-details-emails.run',
        ...totals,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return ok(totals);
  }

  async #one(
    context: CallContext,
    sellerId: Id<'Seller'>,
    rows: readonly PendingMissingDetailsEmail[],
    page: string,
  ): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
    const { deps } = this;
    const { market } = context;
    const settleAll = async (
      end: (row: PendingMissingDetailsEmail) => Parameters<MissingDetailsEmailStore['settle']>[2],
    ): Promise<void> => {
      const done = await deps.unitOfWork.run(market, async () => {
        for (const row of rows) {
          await deps.emailStore.settle(market, row, end(row), deps.clock.now());
        }
        return ok(undefined);
      });
      if (!done.ok) throw new Error('missing-details-emails: the marker unit failed');
    };

    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, sellerId);
      if (to === null) {
        await settleAll((row) => ({
          state: 'skipped',
          outcome: 'no-address',
          attempts: row.attempts,
        }));
        return 'skipped';
      }
      const mail = missingDetailsEmail({
        sellerName: rows.find((row) => row.sellerName !== null)?.sellerName ?? null,
        products: rows.map((row) => ({
          productName: row.productName,
          missingLabels: row.missingLabels,
        })),
        productsPage: page,
      });
      await deps.mailTransport.send({
        to,
        from: deps.missingDetailsMailSettings.sender(market),
        subject: mail.subject,
        text: mail.text,
      });
    } catch {
      sendFailed = true;
    }
    if (!sendFailed) {
      await settleAll((row) => ({ state: 'sent', attempts: row.attempts + 1 }));
      return 'sent';
    }
    const last = rows.every((row) => row.attempts + 1 >= MISSING_DETAILS_EMAIL_MAX_ATTEMPTS);
    await settleAll((row) =>
      row.attempts + 1 >= MISSING_DETAILS_EMAIL_MAX_ATTEMPTS
        ? { state: 'failed', outcome: 'send-failed', attempts: row.attempts + 1 }
        : { state: 'pending', attempts: row.attempts + 1 },
    );
    this.#logger.warn({
      msg: 'catalog.missing-details-emails.send-failed',
      sellerId,
      products: rows.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return last ? 'failed' : 'retry';
  }
}
