import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_PAUSE } from '../../contracts/permissions';
import { ProductResumedAudit, scopeCode } from '../../domain/audit';
import type { ClaimFacts, TagDecision } from '../../domain/offer-tag';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import {
  adminOf,
  LIFECYCLE_TIMEOUT_MS,
  lifecycleRefusal,
  MAX_LIFECYCLE_ATTEMPTS,
  offersOfProduct,
  productIdOf,
  saveOffer,
  type LifecycleDependencies,
  type LifecycleRefusal,
  RETRY_EXHAUSTED,
} from '../products/product-lifecycle';
import { askClaimsMany } from '../tags/ask-claims';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  NOTHING_ASKED,
  RETRY,
  type PreparedAsk,
} from '../tags/offer-claims';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';

export interface AdminProductResumeInput {
  readonly productId: unknown;
}

export interface AdminProductResumeOutput {
  readonly productId: string;
  /** Offers of the product that are not deleted and lost the cause `product-paused`. */
  readonly offerCount: number;
}

export type AdminProductResumeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: LifecycleRefusal }
  /** Certification could not answer: nothing changed, the product stays paused. */
  | { readonly code: 'claim.check-unavailable' }
  | typeof RETRY_EXHAUSTED;

export interface AdminProductResumeDependencies extends LifecycleDependencies {
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
}

/** One Offer as read for the ask: the version the decisions are valid for, and what was asked. */
interface Seen {
  readonly offerId: Id<'Offer'>;
  readonly version: number;
  readonly prepared: PreparedAsk;
  /** The Offer keeps a tag but nothing can be asked (no facts, no handling): fail closed. */
  readonly unanswerable: boolean;
}

/**
 * Ends the write unit without committing, to ask again: a result with an error rolls the unit
 * back, which a `RETRY` returned as a value after the first write would not.
 */
const AGAIN = Object.freeze({ code: 'resume.again' } as const);

interface Read {
  readonly productVersion: number;
  readonly seen: readonly Seen[];
}

/**
 * `admin-product.resume` (catalog design 4.1a, 8.2): an admin puts a paused product back on sale.
 * Rule: the key `catalog.product.pause` and the admin population. Clearing the cause
 * `product-paused` is an Offer reactivation entry path, so every tag of every Offer is asked
 * again through `evaluateClaims` first (ADR-0028 d5, as the clearing of `type-not-allowed`):
 * a read-only unit reads the product, its Offers and the facts of the published revision; the ask
 * runs outside any unit; then one unit locks the product at the version that was read, clears the
 * mark (`catalog.product-resumed.v1`), settles each Offer's tags on those decisions (an allowed
 * tag stays or becomes `active`, a refused one `suspended`, which keeps that Offer off sale under
 * its own cause) and clears `product-paused` (`catalog.offer-listing-changed.v1` when an Offer
 * returns to sale); one audit row. An unanswered ask refuses the resume and the product stays
 * paused (`claim.check-unavailable`, fail closed). A lost race asks again, at most three times.
 */
export class AdminProductResume extends UseCase<
  AdminProductResumeInput,
  AdminProductResumeOutput,
  AdminProductResumeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-product-resume',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_PAUSE.key] },
  };

  readonly #logger = new Logger('AdminProductResume');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminProductResumeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductResumeInput,
  ): Promise<Result<AdminProductResumeOutput, AdminProductResumeFailure>> {
    const result = await this.#resume(context, input);
    this.#logger.log({
      msg: 'catalog.admin-product-resume',
      code: result.ok ? 'resumed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #resume(
    context: CallContext,
    input: AdminProductResumeInput,
  ): Promise<Result<AdminProductResumeOutput, AdminProductResumeFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    const productId = productIdOf(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    for (let attempt = 0; attempt < MAX_LIFECYCLE_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await claimsFailClosed(() =>
          this.#attempt(context, admin.accountId, productId),
        );
        if (outcome !== RETRY) return outcome;
      } catch (error) {
        if (!(error instanceof StaleAggregateError)) throw error;
      }
    }
    return err(RETRY_EXHAUSTED);
  }

  async #attempt(
    context: CallContext,
    accountId: Id<'Account'>,
    productId: Id<'Product'>,
  ): Promise<Result<AdminProductResumeOutput, AdminProductResumeFailure> | typeof RETRY> {
    const { market } = context;
    const { deps } = this;

    // 1. Read: the product, its Offers and what to ask (no write, no lock).
    const read = await deps.unitOfWork.run<
      Read,
      { readonly code: 'product.not-found' } | { readonly code: LifecycleRefusal }
    >(
      market,
      async () => {
        const product = await deps.products.findById(market, productId);
        if (product === null) return err({ code: 'product.not-found' as const });
        if (product.state.pausedAt === null) return err({ code: 'product.not-paused' as const });
        const snapshot = await deps.claims.publishedSnapshot(market, productId);
        const offers = await offersOfProduct(deps.offers, market, productId);
        const seen: Seen[] = offers.map((offer) => {
          const base = { offerId: offer.state.id, version: offer.state.version };
          const types = keptTagTypes(offer);
          if (types.length === 0) return { ...base, prepared: NOTHING_ASKED, unanswerable: false };
          const queries =
            snapshot.facts === null || snapshot.productVersion === null
              ? null
              : deps.claims.queries(offer.state, snapshot.facts, types);
          // `queries` is null when the Offer has no handling: nothing can be allowed.
          if (queries === null) return { ...base, prepared: NOTHING_ASKED, unanswerable: true };
          return {
            ...base,
            prepared: { facts: snapshot.facts, queries, productVersion: snapshot.productVersion },
            unanswerable: false,
          };
        });
        return ok({ productVersion: product.state.version, seen });
      },
      { readOnly: true },
    );
    if (!read.ok) return err(read.error);
    const { productVersion, seen } = read.value;
    if (seen.some((item) => item.unanswerable)) return err({ code: 'claim.check-unavailable' });

    // 2. Ask, outside any unit, for every Offer that keeps a tag.
    const asking = seen.filter((item) => item.prepared.queries.size > 0);
    const asked =
      asking.length === 0
        ? ok([] as Map<string, readonly TagDecision[]>[])
        : await askClaimsMany(
            deps.evaluator,
            context,
            asking.map((item) => item.prepared.queries),
          );
    if (!asked.ok) return err({ code: 'claim.check-unavailable' });
    const decisionsOf = new Map(asking.map((item, index) => [item.offerId, asked.value[index]!]));

    // 3. One unit: the product locked at the version read, the mark cleared, the Offers settled.
    const written = await deps.unitOfWork.run<
      AdminProductResumeOutput | typeof RETRY,
      | { readonly code: 'product.not-found' }
      | { readonly code: 'claim.check-unavailable' }
      | { readonly code: LifecycleRefusal }
      | typeof AGAIN
    >(
      market,
      async () => {
        if (!(await deps.products.lockAtVersion(market, productId, productVersion))) {
          return ok(RETRY);
        }
        const product = await deps.products.findById(market, productId);
        if (product === null) return err({ code: 'product.not-found' as const });
        const now = deps.clock.now();
        const resumed = product.resume({ now });
        if (!resumed.ok) return err(lifecycleRefusal(resumed.error));
        const offers = await offersOfProduct(deps.offers, market, productId);
        const known = new Map(seen.map((item) => [item.offerId, item]));
        if (offers.length !== seen.length) return ok(RETRY);
        // Decisions are valid only for the Offers as they were asked about.
        for (const offer of offers) {
          if (known.get(offer.state.id)?.version !== offer.state.version) return ok(RETRY);
        }
        // The facts again, under the product lock at the version the ask was prepared on. Read
        // before the product is saved: the save raises its version, and the lock is at the old one.
        const factsOf = new Map<Id<'Offer'>, ClaimFacts | null>();
        for (const offer of offers) {
          if (!decisionsOf.has(offer.state.id)) continue;
          const facts = await factsInUnit(
            deps.claims,
            market,
            productId,
            known.get(offer.state.id)!.prepared,
          );
          if (facts === RETRY) return ok(RETRY);
          factsOf.set(offer.state.id, facts);
        }
        await deps.products.save(market, product);
        await deps.outbox.append(context, product.pendingEvents);
        for (const offer of offers) {
          const item = known.get(offer.state.id)!;
          const decisions = decisionsOf.get(offer.state.id);
          if (decisions !== undefined) {
            const settled = offer.settleTags({
              facts: factsOf.get(offer.state.id) ?? null,
              decisions,
              entryPath: 'offer-reactivated',
              actor: { kind: 'admin', accountId },
              hash: hashesOf(item.prepared),
              now,
            });
            if (!settled.ok) {
              if (settled.error.code === 'claim.inputs-changed') return err(AGAIN);
              return err({ code: 'claim.check-unavailable' as const });
            }
          }
          offer.changeCauses({ clear: ['product-paused'], now });
          await saveOffer(deps, context, offer, accountId);
        }
        await deps.audit.record(
          context,
          ProductResumedAudit.entry(productId, {
            before: { paused: true },
            after: {
              paused: false,
              scope: scopeCode(product.state.scope),
              offerCount: offers.length,
            },
          }),
        );
        return ok({ productId, offerCount: offers.length });
      },
      { timeoutMs: LIFECYCLE_TIMEOUT_MS },
    );
    if (!written.ok) {
      return written.error.code === 'resume.again' ? RETRY : err(written.error);
    }
    if (written.value === RETRY) return RETRY;
    return ok(written.value);
  }
}
