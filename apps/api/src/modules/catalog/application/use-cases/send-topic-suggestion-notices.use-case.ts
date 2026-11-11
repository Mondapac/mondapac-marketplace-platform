import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TopicSuggestion } from '../../domain/topic-suggestion';
import { topicSuggestionNoticeMail } from '../../domain/topic-suggestion-notice';
import type { TopicReader } from '../ports/topic.reader';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';

/** The notices one run takes (each send may take up to 5 s; the job allows 120 s). */
export const SUGGESTION_NOTICE_BATCH_SIZE = 20;
/** A run starts no new send after this long, so it ends within the job's `maxRunMs`. */
export const SUGGESTION_NOTICE_RUN_BUDGET_MS = 90_000;

export interface SendTopicSuggestionNoticesOutput {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export type SendTopicSuggestionNoticesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SendTopicSuggestionNoticesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicSuggestions: TopicSuggestionStore;
  readonly topicReader: TopicReader;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

interface DueNotice {
  readonly suggestion: TopicSuggestion;
  readonly topicName: string | null;
}

type Step = 'sent' | 'skipped' | 'deferred' | 'failed';

/**
 * `catalog.send-topic-suggestion-notices` (product tags package T5): rule `system`, the
 * job's use case, one call per hosted Market. A read-only unit takes the decided suggestions whose
 * notice is due, with the topic's name; each is then handled on its own:
 * the address comes through `identity`'s contact point (none: `skipped`), one plain-text mail is
 * sent outside any unit, then a unit marks that notice `sent`. A failed read or send marks only
 * that notice for a later try or, at the last attempt, `failed` (an error log); the next notices
 * go on. Only a crash between a send and its marker sends that one notice again. The log holds
 * ids, codes and counts, never an address or the seller's text.
 */
export class SendTopicSuggestionNotices extends UseCase<
  Record<string, never>,
  SendTopicSuggestionNoticesOutput,
  SendTopicSuggestionNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.send-topic-suggestion-notices',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendTopicSuggestionNotices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendTopicSuggestionNoticesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendTopicSuggestionNoticesOutput, SendTopicSuggestionNoticesFailure>> {
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
        const due = await deps.topicSuggestions.dueNotices(
          market,
          started,
          SUGGESTION_NOTICE_BATCH_SIZE,
        );
        const notices: DueNotice[] = [];
        const topicIds = [
          ...new Set(due.flatMap(({ state }) => (state.topicId === null ? [] : [state.topicId]))),
        ];
        const briefs = new Map(
          (topicIds.length === 0 ? [] : await deps.topicReader.briefsOf(market, topicIds)).map(
            (brief) => [brief.id as string, brief],
          ),
        );
        for (const suggestion of due) {
          const brief =
            suggestion.state.topicId === null ? undefined : briefs.get(suggestion.state.topicId);
          notices.push({
            suggestion,
            topicName: brief === undefined ? null : (brief.names[locale] ?? brief.slug),
          });
        }
        return ok(notices);
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('topic-suggestion-notices: the read unit failed');

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
      msg: 'catalog.topic-suggestion-notices.run',
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
    const mark = async (next: TopicSuggestion | null): Promise<void> => {
      if (next === null) return;
      const done = await deps.unitOfWork.run(market, async () => {
        await deps.topicSuggestions.saveNotice(market, next);
        return ok(true);
      });
      if (!done.ok) throw new Error('topic-suggestion-notices: the marker unit failed');
    };

    let sendFailed = false;
    try {
      const to = await deps.ownerContacts.emailOf(context, suggestion.state.sellerId);
      if (to === null) {
        await mark(suggestion.noticeSkipped());
        return 'skipped';
      }
      const status = suggestion.state.status;
      if (status === 'open') throw new Error('topic-suggestion-notices: an open suggestion');
      const mail = topicSuggestionNoticeMail({
        status,
        label: suggestion.state.label,
        topicName: notice.topicName,
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
      this.#logger.error({ msg: 'catalog.topic-suggestion-notices.failed', ...base });
      return 'failed';
    }
    this.#logger.warn({ msg: 'catalog.topic-suggestion-notices.deferred', ...base });
    return 'deferred';
  }
}
