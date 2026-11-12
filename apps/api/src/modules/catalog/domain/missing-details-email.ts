import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { noticeRetryAt } from './certificate-expiry-notice';

// The admin action "Email sellers" of the Missing details report (attributes A4-4, decision ت۷:
// the products stay on sale). One email per seller lists only that seller's selected products and
// the required details each one lacks. At most one email per seller and product in 7 days. The
// text is the one john approved on 11 Nov 2026 (design/attributes/a4-4-admin-screens/
// email-sellers-text.md): English only, plain text, no price, no deadline, no threat of removal.
//
// An email is queued by the admin's request and sent by a job (identity gives a seller's address
// to the `system` actor only); its notice state moves as the other catalog notices do:
//
//   pending --> sent | skipped (no usable address) | failed (attempts used up)

/** The throttle window: the same seller and product are emailed at most once in it. */
export const MISSING_DETAILS_EMAIL_WINDOW = Temporal.Duration.from({ hours: 7 * 24 });
/** Products one request may name (one page of the report at most). */
export const MISSING_DETAILS_EMAIL_PRODUCTS_MAX = 100;
/** The longest name a line of the email carries; a longer one is cut. */
const NAME_MAX = 200;

export type MissingDetailsNoticeState = 'pending' | 'sent' | 'skipped' | 'failed';

export interface MissingDetailsEmailMail {
  readonly subject: string;
  readonly text: string;
}

export interface MissingDetailsEmailFacts {
  /** The seller's store name; null greets without a name. */
  readonly sellerName: string | null;
  /** In the order the email lists them: the English catalogue names. */
  readonly products: readonly { readonly name: string; readonly details: readonly string[] }[];
  /** The seller panel's products page; null when the Market configures none. */
  readonly productsUrl: string | null;
}

/** One line of plain text: control characters and line breaks become one space, then trimmed. */
function line(value: string): string {
  const flat = value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/ {2,}/g, ' ');
  const trimmed = flat.trim();
  return [...trimmed].length > NAME_MAX
    ? `${[...trimmed].slice(0, NAME_MAX - 1).join('')}…`
    : trimmed;
}

/** The approved email (English only). The subject is singular when it names one product. */
export function missingDetailsEmailMail(facts: MissingDetailsEmailFacts): MissingDetailsEmailMail {
  const count = facts.products.length;
  const subject =
    count === 1
      ? '1 of your products needs more details'
      : `${count} of your products need more details`;
  const name = facts.sellerName === null ? '' : line(facts.sellerName);
  const text = [
    name === '' ? 'Hi,' : `Hi ${name},`,
    '',
    'We have added new required details for some product categories. The products below are still on sale, and nothing changes for buyers right now. The next time you update one of them, you will need to fill in these details:',
    '',
    ...facts.products.map(
      (product) => `- ${line(product.name)}: ${product.details.map(line).join(', ')}`,
    ),
    '',
    'Adding them now takes a minute and helps buyers find and compare your products.',
    '',
    facts.productsUrl === null
      ? 'Open your products in your seller panel.'
      : `Open your products: ${facts.productsUrl}`,
    '',
    'Questions? Reply to this email or contact seller support from your panel.',
    '',
    'The Mondapac team',
  ].join('\n');
  return { subject, text };
}

/** A selected product as the plan reads it: its owner and the codes of its missing details. */
export interface PlannedProduct {
  readonly productId: string;
  /** null for a PLATFORM product: nobody to email. */
  readonly sellerId: string | null;
  /** Codes of the required details it lacks now; empty when it is complete. */
  readonly missing: readonly string[];
}

/** An email of the same seller and product that is pending or was sent, and when. */
export interface RecentMissingDetailsEmail {
  readonly sellerId: string;
  readonly productId: string;
  /** When it was sent, or requested while it waits. */
  readonly at: Temporal.Instant;
}

export type PlannedProductStatus = 'emailed' | 'throttled' | 'no-missing-details' | 'email-pending';

export interface PlannedProductOutcome {
  readonly productId: string;
  readonly status: PlannedProductStatus;
  /** The latest email that throttles it (throttled only). */
  readonly lastEmailedAt: Temporal.Instant | null;
}

export interface PlannedSeller {
  readonly sellerId: string;
  /** `queued`: one email goes; `throttled`: none, as every candidate was emailed recently; `skipped`: nothing to send. */
  readonly status: 'queued' | 'throttled' | 'skipped';
  readonly products: readonly PlannedProductOutcome[];
  /** The products the email lists, in the selection's order. */
  readonly emailed: readonly PlannedProduct[];
}

export interface MissingDetailsEmailPlan {
  readonly sellers: readonly PlannedSeller[];
  /** Selected products nobody is emailed about: not a published product of the Market, or a PLATFORM one. */
  readonly unmatched: readonly {
    readonly productId: string;
    readonly reason: 'not-found' | 'no-seller';
  }[];
}

/**
 * Groups a selection per seller and applies the throttle: a product of a seller that was emailed
 * about it (pending or sent) less than {@link MISSING_DETAILS_EMAIL_WINDOW} ago is `throttled`. A
 * seller whose earlier email still waits for the job gets none now (`email-pending`): one pending
 * email per seller, so two admins never queue two at once. Pure; the caller reads the facts.
 */
export function planMissingDetailsEmails(input: {
  readonly requested: readonly string[];
  readonly found: readonly PlannedProduct[];
  readonly recent: readonly RecentMissingDetailsEmail[];
  readonly pendingSellers: ReadonlySet<string>;
  readonly now: Temporal.Instant;
}): MissingDetailsEmailPlan {
  const since = input.now.subtract(MISSING_DETAILS_EMAIL_WINDOW);
  const byId = new Map(input.found.map((product) => [product.productId, product]));
  const latest = new Map<string, Temporal.Instant>();
  for (const recent of input.recent) {
    if (Temporal.Instant.compare(recent.at, since) <= 0) continue;
    const key = `${recent.sellerId}/${recent.productId}`;
    const known = latest.get(key);
    if (known === undefined || Temporal.Instant.compare(recent.at, known) > 0) {
      latest.set(key, recent.at);
    }
  }
  const unmatched: { productId: string; reason: 'not-found' | 'no-seller' }[] = [];
  const perSeller = new Map<
    string,
    { products: PlannedProductOutcome[]; emailed: PlannedProduct[] }
  >();
  for (const productId of [...new Set(input.requested)]) {
    const product = byId.get(productId);
    if (product === undefined) {
      unmatched.push({ productId, reason: 'not-found' });
      continue;
    }
    if (product.sellerId === null) {
      unmatched.push({ productId, reason: 'no-seller' });
      continue;
    }
    const group = perSeller.get(product.sellerId) ?? { products: [], emailed: [] };
    perSeller.set(product.sellerId, group);
    const last = latest.get(`${product.sellerId}/${productId}`) ?? null;
    if (product.missing.length === 0) {
      group.products.push({ productId, status: 'no-missing-details', lastEmailedAt: null });
    } else if (last !== null) {
      group.products.push({ productId, status: 'throttled', lastEmailedAt: last });
    } else if (input.pendingSellers.has(product.sellerId)) {
      group.products.push({ productId, status: 'email-pending', lastEmailedAt: null });
    } else {
      group.products.push({ productId, status: 'emailed', lastEmailedAt: null });
      group.emailed.push(product);
    }
  }
  const sellers = [...perSeller.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sellerId, group]): PlannedSeller => {
      const status =
        group.emailed.length > 0
          ? 'queued'
          : group.products.some((p) => p.status === 'throttled')
            ? 'throttled'
            : 'skipped';
      return { sellerId, status, products: group.products, emailed: group.emailed };
    });
  return { sellers, unmatched };
}

export interface MissingDetailsEmailState {
  readonly id: Id<'MissingDetailsEmail'>;
  readonly marketId: MarketId;
  readonly sellerId: Id<'Seller'>;
  /** The products it lists, in order. */
  readonly productIds: readonly Id<'Product'>[];
  readonly requestedByAccountId: Id<'Account'>;
  readonly requestedAt: Temporal.Instant;
  /** The rendered mail, kept so what is sent is what the admin previewed. */
  readonly subject: string;
  readonly text: string;
  readonly noticeState: MissingDetailsNoticeState;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Temporal.Instant | null;
  readonly sentAt: Temporal.Instant | null;
  readonly version: number;
}

/** One queued email to one seller. Its content never changes; only its notice state moves. */
export class MissingDetailsEmail {
  readonly #state: MissingDetailsEmailState;

  private constructor(state: MissingDetailsEmailState) {
    this.#state = state;
  }

  get state(): MissingDetailsEmailState {
    return this.#state;
  }

  static rehydrate(state: MissingDetailsEmailState): MissingDetailsEmail {
    return new MissingDetailsEmail(state);
  }

  static queue(input: {
    readonly id: Id<'MissingDetailsEmail'>;
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly productIds: readonly Id<'Product'>[];
    readonly requestedByAccountId: Id<'Account'>;
    readonly subject: string;
    readonly text: string;
    readonly now: Temporal.Instant;
  }): MissingDetailsEmail {
    if (
      input.productIds.length === 0 ||
      input.productIds.length > MISSING_DETAILS_EMAIL_PRODUCTS_MAX
    ) {
      throw new Error('MissingDetailsEmail: 1 to 100 products');
    }
    return new MissingDetailsEmail({
      id: input.id,
      marketId: input.marketId,
      sellerId: input.sellerId,
      productIds: [...input.productIds],
      requestedByAccountId: input.requestedByAccountId,
      requestedAt: input.now,
      subject: input.subject,
      text: input.text,
      noticeState: 'pending',
      noticeAttempts: 0,
      noticeNextAttemptAt: input.now,
      sentAt: null,
      version: 1,
    });
  }

  /** The mail went. Only a pending email moves. */
  sent(now: Temporal.Instant): MissingDetailsEmail | null {
    return this.#settled('sent', this.#state.noticeAttempts + 1, now);
  }

  /** Nobody to send it to (no usable address): settled without a mail. */
  skipped(): MissingDetailsEmail | null {
    return this.#settled('skipped', this.#state.noticeAttempts, null);
  }

  /** A send failed: tried again later, or `failed` once the attempts are used up. */
  failedAt(now: Temporal.Instant): MissingDetailsEmail | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    const retry = noticeRetryAt(current.noticeAttempts, now);
    const attempts = current.noticeAttempts + 1;
    if (retry === null) return this.#settled('failed', attempts, null);
    return new MissingDetailsEmail({
      ...current,
      noticeAttempts: attempts,
      noticeNextAttemptAt: retry,
      version: current.version + 1,
    });
  }

  #settled(
    state: 'sent' | 'skipped' | 'failed',
    attempts: number,
    sentAt: Temporal.Instant | null,
  ): MissingDetailsEmail | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    return new MissingDetailsEmail({
      ...current,
      noticeState: state,
      noticeAttempts: attempts,
      noticeNextAttemptAt: null,
      sentAt,
      version: current.version + 1,
    });
  }
}
