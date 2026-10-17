import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';
import { judgeTag, type TagClaimQuery, type TagDecision } from '../../domain/offer-tag';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnOfferFinder } from '../ports/own-offer-finder';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  hashesOf,
  MAX_CLAIM_ATTEMPTS,
  parseRequestedTags,
  sellerTagActor,
  type PreparedAsk,
} from '../tags/offer-claims';
import { isActingAsSession } from '../acting-as';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type {
  FrozenSubmission,
  SubmitClaims,
  SubmitProduct,
  SubmitProductFailure,
  SubmitProductOutput,
} from '../revisions/submit-product.service';

/** The request as the route passes it. */
export interface OwnProductSubmitInput {
  readonly productId: string;
  readonly replacePending: boolean;
  /** Badge requests of a first submit (design 5.1a point 6); absent is none. Closed schema. */
  readonly requestedTags?: unknown;
}

export type OwnProductSubmitFailure =
  | Exclude<SubmitProductFailure, { readonly code: 'claim.inputs-changed' }>
  | { readonly code: 'tag.type-unknown' }
  | { readonly code: 'conflict.retry' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'type.not-allowed' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnProductSubmitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly submit: SubmitProduct;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly offerFinder: OwnOfferFinder;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The statuses the T4 check asks (design 4.2 row 1): a suspended tag is not allowed already. */
const T4_STATUSES: ReadonlySet<string> = new Set(['active', 'rechecking']);

/**
 * `own-product.submit` (catalog design 4.2 row 1, 8.2; OFR-01): a seller submits the working copy
 * of their own SELLER product. Rule: the key `catalog.own-product.edit`, the seller population and
 * a seller who may sell. The request names the product and whether a pending revision may be
 * replaced; the author, outcome, revision number and content come from stored state and the
 * Market's configuration. Before {@link SubmitProduct} runs, the stored product's type must be one
 * the seller may sell (SEL-12; an error from the reader is `access.unavailable`, ADR-0031). A
 * product of another seller, a PLATFORM product and an unknown id answer a byte-identical
 * `product.not-found`. The seller's revision publishes at once or waits for review by the
 * Market's `approvalRequired` and the classification of 4.3.
 *
 * Claims (design 4.2 row 1, 5.1a; X-2): the queries name the frozen revision being submitted
 * (its id is minted before the asks and stored with it), never the working copy.
 * - Never published: `requestedTags` (closed: at most 20 distinct active type codes) are asked
 *   for the seller's Offer of the product; one not allowed refuses the whole submit
 *   (`claim.requested-tag-not-allowed`, per type the reason code). In the submit unit the
 *   `pending-publish` tags become exactly the requested set, without badge data; the Offer is not
 *   listed and only the publish re-ask can make them `active` (points 2, 3, 6).
 * - Already published: the T4 check asks every `active` or `rechecking` tag of the Offer against
 *   the frozen revision and refuses the submit (`claim.tags-would-be-lost`) when one would no
 *   longer be allowed; it stores nothing (point 4). `requestedTags` is refused there
 *   (`validation.failed`): `own-offer.add-tag` is the path.
 * An `unavailable` answer refuses (`claim.check-unavailable`). A lost race submits again, at most
 * three times, then `conflict.retry`. A non-empty `requestedTags` must be refused in an acting-as
 * session (Hassan M1); the actor has no acting-as field until SEL-08 (open carry).
 */
export class OwnProductSubmit extends UseCase<
  OwnProductSubmitInput,
  SubmitProductOutput,
  OwnProductSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-submit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductSubmitInput,
  ): Promise<Result<SubmitProductOutput, OwnProductSubmitFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnProductSubmitFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (typeof input.replacePending !== 'boolean') return fail('replacePending', 'type');
    const requested = parseRequestedTags(input.requestedTags);
    if (!requested.ok) return fail(requested.error.path, requested.error.code);

    // SEL-12 on the stored type; ownership is answered here and again inside the submit.
    const typeCode = await this.deps.unitOfWork.run(
      market,
      async () => {
        const found = await this.deps.products.findById(market, product.value);
        return ok(
          found !== null && found.state.scope === 'SELLER' && found.state.ownerSellerId === sellerId
            ? found.state.typeCode
            : null,
        );
      },
      { readOnly: true },
    );
    if (!typeCode.ok) return err({ code: 'access.unavailable' });
    if (typeCode.value === null) return err({ code: 'product.not-found' });
    const allowed = await this.deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode.value)) return err({ code: 'type.not-allowed' });

    if (requested.value.length > 0) {
      // Badge requests are not offered in an acting-as session (Hassan M1 of 5.1a, L1).
      if (isActingAsSession(actor)) return err({ code: 'access.denied' });
      const active = await this.deps.evaluator.activeTypeCodes(context);
      if (!active.ok) return err(active.error);
      if (requested.value.some((code) => !active.value.has(code))) {
        return err({ code: 'tag.type-unknown' });
      }
    }

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const result = await claimsFailClosed(() =>
        this.deps.submit.execute(context, {
          productId: product.value,
          replacePending: input.replacePending,
          revisionId: this.deps.ids.next<'ProductRevision'>(),
          claims: this.#claims(context, sellerId, requested.value),
        }),
      );
      if (!result.ok && result.error.code === 'claim.inputs-changed') continue;
      return result as Result<SubmitProductOutput, OwnProductSubmitFailure>;
    }
    return err({ code: 'conflict.retry' });
  }

  /** The claim steps of one submit attempt; what `ask` learns is kept only for its `settle`. */
  #claims(
    context: CallContext,
    sellerId: Id<'Seller'>,
    requested: readonly string[],
  ): SubmitClaims {
    const { deps } = this;
    const { market, actor } = context;
    // `pending`: the pending-publish set to write. `t4`: nothing to write, but the Offer must be
    // the one T4 asked about (its version, or still none), else the submit asks again (Hassan M1).
    let plan:
      | {
          readonly kind: 'pending';
          readonly offerVersion: number;
          readonly types: readonly string[];
          readonly decisions: ReadonlyMap<string, readonly TagDecision[]>;
          readonly hash: (canonical: string) => string;
        }
      | { readonly kind: 't4'; readonly offerVersion: number | null }
      | null = null;

    return {
      ask: async (frozen: FrozenSubmission) => {
        plan = null;
        const firstSubmit = frozen.product.state.publishedRevisionId === null;
        if (!firstSubmit && requested.length > 0) {
          return err({
            code: 'validation.failed',
            fields: [{ path: 'requestedTags', code: 'published' }],
          });
        }
        const read = await deps.unitOfWork.run<
          {
            readonly offer: Offer;
            readonly types: readonly string[];
            readonly hasPending: boolean;
            readonly prepared: PreparedAsk | null | 'no-handling';
          } | null,
          never
        >(
          market,
          async () => {
            const offer = await deps.offerFinder.findOwnOnProduct(
              market,
              sellerId,
              frozen.product.state.id,
            );
            if (offer === null) return ok(null);
            const types = firstSubmit
              ? requested
              : offer.tags.filter((tag) => T4_STATUSES.has(tag.status)).map((t) => t.typeCode);
            const hasPending = offer.tags.some((tag) => tag.status === 'pending-publish');
            if (types.length === 0) return ok({ offer, types, hasPending, prepared: null });
            if (offer.state.handling === null) {
              return ok({ offer, types, hasPending, prepared: 'no-handling' });
            }
            const facts = await deps.claims.revisionFacts(
              market,
              frozen.product,
              frozen.revisionId,
              frozen.content,
              false,
            );
            const queries = deps.claims.queries(offer.state, facts, types);
            return ok({
              offer,
              types,
              hasPending,
              prepared: queries === null ? null : { facts, queries, productVersion: null },
            });
          },
          { readOnly: true },
        );
        if (!read.ok) return err({ code: 'access.unavailable' });
        if (read.value === null) {
          if (!firstSubmit) plan = { kind: 't4', offerVersion: null };
          return requested.length > 0
            ? err({
                code: 'validation.failed',
                fields: [{ path: 'requestedTags', code: 'no-offer' }],
              })
            : ok(undefined);
        }
        const { offer, types, hasPending, prepared } = read.value;
        if (prepared === 'no-handling') return err({ code: 'offer.handling-missing' });
        if (!firstSubmit) plan = { kind: 't4', offerVersion: offer.state.version };
        if (types.length === 0) {
          // A first submit with no request still clears the pending set of an earlier submit.
          if (firstSubmit && hasPending) {
            plan = {
              kind: 'pending',
              offerVersion: offer.state.version,
              types: [],
              decisions: new Map(),
              hash: () => {
                throw new Error('own-product.submit: nothing was asked');
              },
            };
          }
          return ok(undefined);
        }
        if (prepared === null) return err({ code: 'claim.check-unavailable' });
        const asked = await askPrepared(deps.evaluator, context, prepared);
        if (!asked.ok) return err(asked.error);
        // Judged here, before the submit unit, so a refusal stores nothing; the domain judges the
        // same decisions again in the unit (5.1a point 6; T4, point 4).
        const refused: { typeCode: string; reason: string }[] = [];
        for (const typeCode of types) {
          const verdict = judgeTag(
            prepared.queries.get(typeCode) as readonly TagClaimQuery[],
            asked.value.get(typeCode),
          );
          if (verdict.kind === 'unavailable' || verdict.kind === 'stale') {
            return err({ code: 'claim.check-unavailable' });
          }
          if (verdict.kind === 'not-allowed') refused.push({ typeCode, reason: verdict.reason });
        }
        if (!firstSubmit) {
          // T4: refuse or let through; nothing is stored (the settle only re-checks the Offer).
          if (refused.length > 0) {
            plan = null;
            return err({ code: 'claim.tags-would-be-lost', tags: refused });
          }
          return ok(undefined);
        }
        if (refused.length > 0) {
          return err({ code: 'claim.requested-tag-not-allowed', tags: refused });
        }
        plan = {
          kind: 'pending',
          offerVersion: offer.state.version,
          types,
          decisions: asked.value,
          hash: hashesOf(prepared),
        };
        return ok(undefined);
      },

      settle: async (frozen: FrozenSubmission) => {
        if (plan === null) return ok(undefined);
        if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
        const offer = await deps.offerFinder.findOwnOnProduct(
          market,
          sellerId,
          frozen.product.state.id,
        );
        if (plan.kind === 't4') {
          return (offer?.state.version ?? null) === plan.offerVersion
            ? ok(undefined)
            : err({ code: 'claim.inputs-changed' });
        }
        if (offer === null || offer.state.version !== plan.offerVersion) {
          return err({ code: 'claim.inputs-changed' });
        }
        const facts = await deps.claims.revisionFacts(
          market,
          frozen.product,
          frozen.revisionId,
          frozen.content,
          false,
        );
        const set = offer.setPendingPublishTags({
          tags: plan.types.map((typeCode) => ({ tagId: deps.ids.next<'OfferTag'>(), typeCode })),
          facts,
          decisions: plan.decisions,
          entryPath: 'revision-submit',
          actor: sellerTagActor(actor),
          hash: plan.hash,
          now: deps.clock.now(),
        });
        if (!set.ok) {
          switch (set.error.code) {
            case 'claim.inputs-changed':
              return err({ code: 'claim.inputs-changed' });
            case 'claim.tag-not-allowed':
              return err({ code: 'claim.requested-tag-not-allowed', tags: set.error.tags });
            case 'offer.handling-missing':
              return err({ code: 'offer.handling-missing' });
            case 'tag.exists':
              return err({
                code: 'validation.failed',
                fields: [{ path: 'requestedTags', code: 'duplicate' }],
              });
            default:
              return err({ code: 'claim.check-unavailable' });
          }
        }
        await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
        return ok(undefined);
      },
    };
  }
}
