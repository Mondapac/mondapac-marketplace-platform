import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AttributeValueSuggestion } from '../../domain/attribute-value-suggestion';
import { suggestionNoticeMail } from '../../domain/attribute-suggestion-notice';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';

/** The notices one run takes (each send may take up to 5 s; the job allows 120 s). */
export const SUGGESTION_NOTICE_BATCH_SIZE = 20;
/** A run starts no new send after this long, so it ends within the job's `maxRunMs`. */
export const SUGGESTION_NOTICE_RUN_BUDGET_MS = 90_000;

export interface SendAttributeSuggestionNoticesOutput {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export type SendAttributeSuggestionNoticesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SendAttributeSuggestionNoticesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly attributeStore: AttributeDefinitionStore;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

interface DueNotice {
  readonly suggestion: AttributeValueSuggestion;
  readonly attributeName: string;
  readonly optionLabel: string | null;
}

type Step = 'sent' | 'skipped' | 'deferred' | 'failed';

/**
 * `catalog.send-attribute-suggestion-notices` (attributes plan, package A5): rule `system`, the
 * job's use case, one call per hosted Market. A read-only unit takes the decided suggestions whose
 * notice is due, with the attribute's name and the value's label; each is then handled on its own:
 * the address comes through `identity`'s contact point (none: `skipped`), one plain-text mail is
 * sent outside any unit, then a unit marks that notice `sent`. A failed read or send marks only
 * that notice for a later try or, at the last attempt, `failed` (an error log); the next notices
 * go on. Only a crash between a send and its marker sends that one notice again. The log holds
 * ids, codes and counts, never an address or the seller's text.
 */
export class SendAttributeSuggestionNotices extends UseCase<
  Record<string, never>,
  SendAttributeSuggestionNoticesOutput,
  SendAttributeSuggestionNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.send-attribute-suggestion-notices',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendAttributeSuggestionNotices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendAttributeSuggestionNoticesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendAttributeSuggestionNoticesOutput, SendAttributeSuggestionNoticesFailure>> {
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
        const due = await deps.suggestions.dueNotices(
          market,
          started,
          SUGGESTION_NOTICE_BATCH_SIZE,
        );
        const notices: DueNotice[] = [];
        for (const suggestion of due) {
          const definition = await deps.attributeStore.findById(
            market,
            suggestion.state.definitionId,
          );
          const code = suggestion.state.optionCode;
          const option =
            definition === null || code === null
              ? undefined
              : definition.state.options.find((candidate) => candidate.code === code);
          notices.push({
            suggestion,
            attributeName:
              definition === null ? '' : (definition.state.names[locale] ?? definition.state.code),
            optionLabel: option === undefined ? null : (option.labels[locale] ?? option.code),
          });
        }
        return ok(notices);
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('attribute-suggestion-notices: the read unit failed');

    const counts = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    let budgetSpent = false;
    for (const notice of read.value) {
      if (
        deps.clock.now().epochMilliseconds - started.epochMilliseconds >=
        SUGGESTION_NOTICE_RUN_BUDGET_MS
      ) {
        budgetSpent = true;
        break;
      }
      counts[await this.one(context, notice)] += 1;
    }
    const output = { examined: read.value.length, ...counts, budgetSpent };
    const log = {
      msg: 'catalog.attribute-suggestion-notices.run',
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
    const { suggestion } = notice;
    const mark = async (next: AttributeValueSuggestion | null): Promise<void> => {
      if (next === null) return;
      const done = await deps.unitOfWork.run(market, async () => {
        await deps.suggestions.saveNotice(market, next);
        return ok(true);
      });
      if (!done.ok) throw new Error('attribute-suggestion-notices: the marker unit failed');
    };

    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, suggestion.state.sellerId);
      if (to === null) {
        await mark(suggestion.noticeSkipped());
        return 'skipped';
      }
      const status = suggestion.state.status;
      if (status === 'open') throw new Error('attribute-suggestion-notices: an open suggestion');
      const mail = suggestionNoticeMail({
        status,
        attributeName: notice.attributeName,
        label: suggestion.state.label,
        optionLabel: notice.optionLabel,
        reason: suggestion.state.rejectReason,
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
      await mark(suggestion.noticeSent());
      return 'sent';
    }
    const next = suggestion.noticeFailedAt(deps.clock.now());
    await mark(next);
    const failed = next !== null && next.state.noticeState === 'failed';
    const base = {
      suggestionId: suggestion.state.id,
      attempts: suggestion.state.noticeAttempts + 1,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (failed) {
      this.#logger.error({ msg: 'catalog.attribute-suggestion-notices.failed', ...base });
      return 'failed';
    }
    this.#logger.warn({ msg: 'catalog.attribute-suggestion-notices.deferred', ...base });
    return 'deferred';
  }
}
