import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { VariantRequest } from '../../domain/variant-request';
import { variantRequestNoticeMail } from '../../domain/variant-request-notice';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { VariantRequestStore } from '../ports/variant-request.store';
import {
  describeOptions,
  describedAs,
  type DefinitionCache,
} from '../variant-requests/variant-requests';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';

/** The notices one run takes (each send may take up to 5 s; the job allows 120 s). */
export const VARIANT_REQUEST_NOTICE_BATCH_SIZE = 20;
/** A run starts no new send after this long, so it ends within the job's `maxRunMs`. */
export const VARIANT_REQUEST_NOTICE_RUN_BUDGET_MS = 90_000;

export interface SendVariantRequestNoticesOutput {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export type SendVariantRequestNoticesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SendVariantRequestNoticesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantRequests: VariantRequestStore;
  readonly products: ProductRepository;
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

interface DueNotice {
  readonly request: VariantRequest;
  readonly productCode: string;
  readonly described: string;
}

type Step = 'sent' | 'skipped' | 'deferred' | 'failed';

/**
 * `catalog.send-variant-request-notices` (variants plan, package V7): rule `system`, the
 * job's use case, one call per hosted Market. A read-only unit takes the decided variant requests whose
 * notice is due, with the product's code and the option values named in the default locale; each is then handled on its own:
 * the address comes through `identity`'s contact point (none: `skipped`), one plain-text mail is
 * sent outside any unit, then a unit marks that notice `sent`. A failed read or send marks only
 * that notice for a later try or, at the last attempt, `failed` (an error log); the next notices
 * go on. Only a crash between a send and its marker sends that one notice again. The log holds
 * ids, codes and counts, never an address .
 */
export class SendVariantRequestNotices extends UseCase<
  Record<string, never>,
  SendVariantRequestNoticesOutput,
  SendVariantRequestNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.send-variant-request-notices',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendVariantRequestNotices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendVariantRequestNoticesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendVariantRequestNoticesOutput, SendVariantRequestNoticesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    let locale: string;
    try {
      locale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const started = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const due = await deps.variantRequests.dueNotices(
          market,
          started,
          VARIANT_REQUEST_NOTICE_BATCH_SIZE,
        );
        const notices: DueNotice[] = [];
        const cache: DefinitionCache = new Map();
        for (const request of due) {
          const product = await deps.products.findById(market, request.state.productId);
          notices.push({
            request,
            productCode: product === null ? '' : product.state.productCode,
            described: describedAs(
              await describeOptions(deps, market, locale, request.state.optionValues, cache),
            ),
          });
        }
        return ok(notices);
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('variant-request-notices: the read unit failed');

    const counts = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    let budgetSpent = false;
    for (const notice of read.value) {
      if (
        deps.clock.now().epochMilliseconds - started.epochMilliseconds >=
        VARIANT_REQUEST_NOTICE_RUN_BUDGET_MS
      ) {
        budgetSpent = true;
        break;
      }
      counts[await this.one(context, notice)] += 1;
    }
    const output = { examined: read.value.length, ...counts, budgetSpent };
    const log = {
      msg: 'catalog.variant-request-notices.run',
      ...output,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (budgetSpent || counts.failed > 0) this.#logger.warn(log);
    else this.#logger.log(log);
    return ok(output);
  }

  private async one(context: CallContext, notice: DueNotice): Promise<Step> {
    const { deps } = this;
    const { market } = context;
    const { request } = notice;
    const mark = async (next: VariantRequest | null): Promise<void> => {
      if (next === null) return;
      const done = await deps.unitOfWork.run(market, async () => {
        await deps.variantRequests.saveNotice(market, next);
        return ok(true);
      });
      if (!done.ok) throw new Error('variant-request-notices: the marker unit failed');
    };

    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, request.state.sellerId);
      if (to === null) {
        await mark(request.noticeSkipped());
        return 'skipped';
      }
      const status = request.state.status;
      if (status === 'open') throw new Error('variant-request-notices: an open request');
      const mail = variantRequestNoticeMail({
        status,
        productCode: notice.productCode,
        described: notice.described,
        reason: request.state.declineReason,
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
      await mark(request.noticeSent());
      return 'sent';
    }
    const next = request.noticeFailedAt(deps.clock.now());
    await mark(next);
    const failed = next !== null && next.state.noticeState === 'failed';
    const base = {
      requestId: request.state.id,
      attempts: request.state.noticeAttempts + 1,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (failed) {
      this.#logger.error({ msg: 'catalog.variant-request-notices.failed', ...base });
      return 'failed';
    }
    this.#logger.warn({ msg: 'catalog.variant-request-notices.deferred', ...base });
    return 'deferred';
  }
}
