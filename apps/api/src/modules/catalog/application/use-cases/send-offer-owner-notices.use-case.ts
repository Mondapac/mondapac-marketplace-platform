import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  certificateExpiryNoticeMail,
  isUsableNoticeZone,
  lastValidDay,
  noticeRetryAt,
  shouldNoticeOwner,
} from '../../domain/certificate-expiry-notice';
import type {
  DueOfferOwnerNotice,
  OfferOwnerNoticeRepository,
} from '../ports/offer-owner-notice.repository';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';

/** The notices one run takes (each send may take up to 5 s; the job allows 120 s). */
export const NOTICE_BATCH_SIZE = 20;
/** A run starts no new send after this long, so it ends within the job's `maxRunMs`. */
export const NOTICE_RUN_BUDGET_MS = 90_000;

export type SendOfferOwnerNoticesOutput = {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly failed: number;
  /** The run stopped at its budget with due notices left for the next run. */
  readonly budgetSpent: boolean;
};

export type SendOfferOwnerNoticesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'market.zone-unusable' };

export interface SendOfferOwnerNoticesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notices: OfferOwnerNoticeRepository;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly clock: Clock;
}

type Step = 'sent' | 'skipped' | 'deferred' | 'failed';

/**
 * `catalog.send-offer-owner-notices` (certification request C-6; CERT-45; certification slice 15;
 * Hassan M1, Mojtaba N2): rule `system`, the job's use case, one call per hosted Market. The
 * Market zone is checked first: one that is not a usable IANA id sends nothing and fails the run
 * (Hassan I2; the day a mail names would be wrong). A read-only unit takes the due pending
 * notices; each is then handled on its own: a badge past its validity or an Owner without an
 * address settles as `skipped`; the address comes through `identity` and one plain-text mail is
 * sent outside any unit, then a unit marks that notice `sent`. A failed read or send of one notice
 * marks only that notice for a later try ({@link noticeRetryAt}) or, at the last attempt,
 * `failed` (an error log); the next notices go on. Only a crash between a send and its marker
 * sends that one notice again. The log holds ids, codes and counts, never an address.
 */
export class SendOfferOwnerNotices extends UseCase<
  Record<string, never>,
  SendOfferOwnerNoticesOutput,
  SendOfferOwnerNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.send-offer-owner-notices',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendOfferOwnerNotices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendOfferOwnerNoticesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendOfferOwnerNoticesOutput, SendOfferOwnerNoticesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const zone = deps.mailSettings.zone(market);
    if (!isUsableNoticeZone(zone)) {
      this.#logger.error({
        msg: 'catalog.offer-owner-notices.zone-unusable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'market.zone-unusable' });
    }

    const started = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.notices.due(market, started, NOTICE_BATCH_SIZE)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('offer-owner-notices: the read unit failed');

    const counts = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    let budgetSpent = false;
    for (const notice of read.value) {
      const now = deps.clock.now();
      if (now.epochMilliseconds - started.epochMilliseconds >= NOTICE_RUN_BUDGET_MS) {
        budgetSpent = true;
        break;
      }
      const step = await this.one(context, notice, zone);
      counts[step] += 1;
    }

    const output: SendOfferOwnerNoticesOutput = {
      examined: read.value.length,
      ...counts,
      budgetSpent,
    };
    const log = {
      msg: 'catalog.offer-owner-notices.run',
      ...output,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (budgetSpent || counts.failed > 0) this.#logger.warn(log);
    else this.#logger.log(log);
    return ok(output);
  }

  /** One notice: decide, send outside any unit, then mark it in a unit of its own. */
  private async one(
    context: CallContext,
    notice: DueOfferOwnerNotice,
    zone: string,
  ): Promise<Step> {
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const attempts = notice.attempts + 1;
    const settle = async (
      end: Parameters<OfferOwnerNoticeRepository['settle']>[2],
    ): Promise<void> => {
      const done = await deps.unitOfWork.run(market, async () =>
        ok(await deps.notices.settle(market, notice.id, end, deps.clock.now())),
      );
      if (!done.ok) throw new Error('offer-owner-notices: the marker unit failed');
    };

    if (!shouldNoticeOwner(notice.validUntil, now)) {
      await settle({ state: 'skipped', outcome: 'past-validity', attempts: notice.attempts });
      return 'skipped';
    }
    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, notice.sellerId);
      if (to === null) {
        await settle({ state: 'skipped', outcome: 'no-address', attempts: notice.attempts });
        return 'skipped';
      }
      const mail = certificateExpiryNoticeMail({
        typeCode: notice.typeCode,
        offers: notice.offers,
        lastDay: lastValidDay(notice.validUntil, zone),
        zone,
      });
      await deps.mailTransport.send({
        to,
        from: deps.mailSettings.sender(market),
        subject: mail.subject,
        text: mail.text,
      });
    } catch {
      sendFailed = true;
    }
    if (!sendFailed) {
      await settle({ state: 'sent', attempts });
      return 'sent';
    }

    // The address read or the send failed for this Owner only: try it again later, or give up.
    const retryAt = noticeRetryAt(notice.attempts, now);
    const base = {
      noticeId: notice.id,
      attempts,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (retryAt === null) {
      await settle({ state: 'failed', outcome: 'send-failed', attempts });
      this.#logger.error({ msg: 'catalog.offer-owner-notices.failed', ...base });
      return 'failed';
    }
    const done = await deps.unitOfWork.run(market, async () =>
      ok(await deps.notices.defer(market, notice.id, { attempts, nextAttemptAt: retryAt })),
    );
    if (!done.ok) throw new Error('offer-owner-notices: the marker unit failed');
    this.#logger.warn({
      msg: 'catalog.offer-owner-notices.deferred',
      ...base,
      nextAttemptAt: retryAt.toString(),
    });
    return 'deferred';
  }
}
