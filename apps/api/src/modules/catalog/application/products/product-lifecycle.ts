import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Clock } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';
import type { ProductRefusal } from '../../domain/product';
import type { OfferActor, OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';

// Shared by the admin product lifecycle use cases (catalog design 4.1, 4.1a): pause, resume,
// withdraw and retire. Each is one unit per product (PP 3.1): the product row first, then its
// Offers (the lock order of every publish and tag write), the events and the audit row in the
// same unit. Use cases cannot extend one another, so what they share is plain functions here.

export interface LifecycleDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly offers: OfferRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/** The admin the unit acts for; the action's key and the population are checked by the caller. */
export function adminOf(context: CallContext): { readonly accountId: Id<'Account'> } | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  return { accountId: actor.accountId };
}

/** A product id from a request: any text that is not an id is the same `product.not-found`. */
export function productIdOf(value: unknown): Id<'Product'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'Product'>(value);
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * A lifecycle unit walks every Offer of one product, so it may outlast the default 5 s: a
 * PLATFORM product can carry hundreds of Offers.
 */
export const LIFECYCLE_TIMEOUT_MS = 20_000;

/** Offers read per page while a unit walks one product's Offers. */
export const OFFER_PAGE = 200;

/** Every Offer of the product that is not deleted, with its tags, saveable in the open unit. */
export async function offersOfProduct(
  offers: OfferRepository,
  market: MarketContext,
  productId: Id<'Product'>,
): Promise<Offer[]> {
  const all: Offer[] = [];
  let afterId: Id<'Offer'> | null = null;
  for (;;) {
    const page: readonly Offer[] = await offers.listOnProduct(market, productId, {
      afterId,
      limit: OFFER_PAGE,
    });
    all.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < OFFER_PAGE) break;
    afterId = last.state.id;
  }
  return all;
}

/** Stores an Offer's change and its events, in the open unit; nothing when it did not change. */
export async function saveOffer(
  deps: Pick<LifecycleDependencies, 'offers' | 'outbox'>,
  context: CallContext,
  offer: Offer,
  accountId: Id<'Account'>,
): Promise<void> {
  if (!offer.hasChanges) return;
  const actor: OfferActor = { kind: 'admin', accountId };
  await deps.offers.save(context.market, offer, actor);
  await deps.outbox.append(context, offer.pendingEvents);
}

/** The refusals a lifecycle command answers from the domain (the guards of 4.1 and 4.1a). */
export type LifecycleRefusal =
  | 'product.not-published'
  | 'product.already-paused'
  | 'product.not-paused'
  | 'product.not-withdrawable'
  | 'product.platform-only'
  | 'product.seller-only';

const LIFECYCLE_CODES: ReadonlySet<string> = new Set<LifecycleRefusal>([
  'product.not-published',
  'product.already-paused',
  'product.not-paused',
  'product.not-withdrawable',
  'product.platform-only',
  'product.seller-only',
]);

/** Narrows a domain refusal to the ones a lifecycle command answers; any other is a defect. */
export function lifecycleRefusal(refusal: ProductRefusal): { readonly code: LifecycleRefusal } {
  if (!LIFECYCLE_CODES.has(refusal.code)) {
    throw new Error(`Lifecycle command: unexpected refusal ${refusal.code}`);
  }
  return { code: refusal.code as LifecycleRefusal };
}

/** A lost race restarts a lifecycle unit from its read, at most this many times. */
export const MAX_LIFECYCLE_ATTEMPTS = 3;

/**
 * Runs a lifecycle unit, again when it lost a race (the product or one of its Offers moved since
 * it was read: `StaleAggregateError`); {@link RETRY_EXHAUSTED} after the last attempt. The unit's
 * own refusals come back as its result.
 */
export const RETRY_EXHAUSTED = { code: 'conflict.retry' } as const;

export async function withRetry<T, F>(
  attempt: () => Promise<Result<T, F> | 'again'>,
): Promise<Result<T, F | typeof RETRY_EXHAUSTED>> {
  for (let n = 0; n < MAX_LIFECYCLE_ATTEMPTS; n += 1) {
    try {
      const outcome = await attempt();
      if (outcome !== 'again') return outcome;
    } catch (error) {
      if (!(error instanceof StaleAggregateError)) throw error;
    }
  }
  return err(RETRY_EXHAUSTED);
}
