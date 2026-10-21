import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CartReminderFacade, IdleCart } from '../../../cart';
import { renderTemplate, type TemplateId } from '../../domain/message-templates';
import {
  sendMarketingMail,
  type MarketingDependencies,
  type MarketingMailOutcome,
} from '../marketing-mail-flow';
import type { CartReminderRepository } from '../ports/cart-reminder.repository';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The two reminders of one cart change (personalization 1c): idle at least `fromHours` and less
 * than `toHours`. Stage 1 stops at 12 hours, so a late stage 1 never lands just before stage 2;
 * a cart idle longer than 72 hours gets nothing more.
 */
export const CART_REMINDER_STAGES = [
  { stage: 1, fromHours: 4, toHours: 12, template: 'cart-reminder-first' },
  { stage: 2, fromHours: 24, toHours: 72, template: 'cart-reminder-second' },
] as const satisfies readonly {
  stage: 1 | 2;
  fromHours: number;
  toHours: number;
  template: TemplateId;
}[];

/** Carts read per page, and pages per stage and run; the next run continues. */
export const CART_REMINDER_PAGE_SIZE = 200;
export const MAX_CART_REMINDER_PAGES = 10;
/** A taken reminder is kept this many days (well past the 72-hour window). */
export const CART_REMINDER_RETENTION_DAYS = 30;
/** Rows deleted per unit, and units per run; the next run continues. */
export const CART_REMINDER_PURGE_BATCH = 1000;
export const MAX_CART_REMINDER_PURGE_BATCHES = 10;

export interface CartReminderDependencies extends MarketingDependencies {
  readonly carts: CartReminderFacade;
  readonly reminders: CartReminderRepository;
  readonly clock: Clock;
}

export interface SendCartRemindersOutput {
  readonly mode: 'off' | 'test' | 'live';
  readonly outcomes: Readonly<Record<MarketingMailOutcome, number>>;
  readonly purged: number;
}

export type SendCartRemindersFailure =
  { readonly code: 'access.denied' } | { readonly code: 'notifications.cart-reminders-failed' };

/**
 * `notifications.send-cart-reminders` (personalization 1c; rule `system`, run by the job
 * `notifications.cart-reminders` for each hosted Market): the abandoned-cart email. For each
 * stage it reads the idle carts of signed-in customers from `cart` (never a guest, never a cart
 * untouched since a paid order), takes the stage in `notifications.cart_reminders` and sends
 * through the marketing mail rule, which asks `legal` for the consent right before the send; so an
 * unsubscribe stops the next mail. A new cart change starts new stages. `test` mode reads and
 * mails only the configured test accounts. The first failure ends the run. A stage is taken before its send: at most once, and a failed send
 * is not repeated. Safe to run twice and concurrently.
 */
export class SendCartReminders extends UseCase<
  Record<string, never>,
  SendCartRemindersOutput,
  SendCartRemindersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-cart-reminders',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendCartReminders');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartReminderDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SendCartRemindersOutput, SendCartRemindersFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { carts, reminders, unitOfWork, policy, clock } = this.deps;
    const outcomes: Record<MarketingMailOutcome, number> = {
      sent: 0,
      'no-consent': 0,
      'no-address': 0,
      'unsubscribe-unconfigured': 0,
      'contact-unconfigured': 0,
    };
    const settings = policy.cartReminders(market);
    const mode = settings?.mode ?? 'off';
    const now = clock.now();
    let failed = false;

    // `test` reads only the test accounts' carts; with none listed it reads nothing.
    const accountIds =
      mode === 'test' ? (settings?.testAccountIds ?? []).map((id) => id as Id<'Account'>) : null;
    if (settings !== null && mode !== 'off' && (accountIds === null || accountIds.length > 0)) {
      // The first failure ends the run: a systemic one (legal, identity or the transport down)
      // must not take, and so lose, every stage due in this run.
      run: for (const stage of CART_REMINDER_STAGES) {
        let after: IdleCart | null = null;
        for (let page = 0; page < MAX_CART_REMINDER_PAGES; page += 1) {
          const idle = await carts.idleCarts(context, {
            changedAfter: now.subtract({ milliseconds: stage.toHours * HOUR_MS }),
            changedAtOrBefore: now.subtract({ milliseconds: stage.fromHours * HOUR_MS }),
            after,
            limit: CART_REMINDER_PAGE_SIZE,
            ...(accountIds === null ? {} : { accountIds }),
          });
          if (!idle.ok) {
            this.#warn(context, stage.stage, idle.error.code);
            failed = true;
            break run;
          }
          for (const cart of idle.value) {
            const outcome = await this.remind(context, stage, cart, settings.cartPage, now);
            if (outcome === 'failed') {
              failed = true;
              break run;
            }
            if (outcome !== 'taken-before') outcomes[outcome] += 1;
          }
          if (idle.value.length < CART_REMINDER_PAGE_SIZE) break;
          after = idle.value[idle.value.length - 1]!;
        }
      }
    }

    // The retention runs in every mode, so rows taken before a switch-off still leave.
    let purged = 0;
    const cutoff = now.subtract({ milliseconds: CART_REMINDER_RETENTION_DAYS * 24 * HOUR_MS });
    try {
      for (let batch = 0; batch < MAX_CART_REMINDER_PURGE_BATCHES; batch += 1) {
        const done = await unitOfWork.run(market, async () =>
          ok(await reminders.purgeTakenBefore(market, cutoff, CART_REMINDER_PURGE_BATCH)),
        );
        if (!done.ok) {
          failed = true;
          break;
        }
        purged += done.value;
        if (done.value < CART_REMINDER_PURGE_BATCH) break;
      }
    } catch {
      failed = true;
    }
    if (failed) return err({ code: 'notifications.cart-reminders-failed' });
    return ok({ mode, outcomes, purged });
  }

  /** Takes one stage of one cart change, then sends it. No address or id leaves in an error. */
  private async remind(
    context: CallContext,
    stage: (typeof CART_REMINDER_STAGES)[number],
    cart: IdleCart,
    cartPage: string,
    now: ReturnType<Clock['now']>,
  ): Promise<MarketingMailOutcome | 'taken-before' | 'failed'> {
    try {
      const taken = await this.deps.unitOfWork.run(context.market, async () =>
        ok(
          await this.deps.reminders.take(
            context.market,
            { accountId: cart.accountId, cartChangedAt: cart.lastChangedAt, stage: stage.stage },
            now,
          ),
        ),
      );
      if (!taken.ok) {
        this.#warn(context, stage.stage, 'take-refused');
        return 'failed';
      }
      if (!taken.value) return 'taken-before';
      const mail = renderTemplate(stage.template, this.deps.policy.defaultLocale(context.market), {
        lineCount: String(cart.lineCount),
        cartUrl: cartPage,
      });
      return await sendMarketingMail(this.deps, context, {
        accountId: cart.accountId,
        subject: mail.subject,
        text: mail.text,
      });
    } catch (error) {
      // The error's class only: its message may carry an address.
      this.#warn(context, stage.stage, error instanceof Error ? error.name : 'unknown');
      return 'failed';
    }
  }

  #warn(context: CallContext, stage: 1 | 2, cause: string): void {
    this.#logger.warn({
      msg: 'notifications.cart-reminders.failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      stage,
      cause,
    });
  }
}
