import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_BADGE_OFFERS,
  type CatalogValidationFailed,
  type OfferBadge,
  type OfferBadgesMap,
} from '../../contracts/catalog.facade';
import { judgeTag, type TagClaimQuery } from '../../domain/offer-tag';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import { askClaimsMany } from '../tags/ask-claims';
import type { ClaimQueryBuilder, PublishedSnapshot } from '../tags/claim-query-builder';

export interface OfferBadgesInput {
  readonly offerIds: readonly string[];
}

export interface OfferBadgesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly policy: CatalogMarketPolicy;
}

/** One Offer to ask about: its `active` tags' types and the queries per type. */
interface Asked {
  readonly offerId: Id<'Offer'>;
  readonly queries: ReadonlyMap<string, readonly TagClaimQuery[]>;
  /** The basis each stored `active` tag's copy holds, by type code. */
  readonly storedBasis: ReadonlyMap<string, 'SELLER' | 'MANUFACTURER'>;
}

/**
 * `catalog.offer-badges`: the certification badges a buyer sees on Offers (product page). Rule
 * `anonymous`; its answer is built ONLY from certification's `evaluateClaims` decision asked live
 * in this call, never from a stored copy (a stored copy can only restrict, ADR-0028 d3).
 *
 * A badge answers for (Offer, type) only when all of these hold:
 * 1. the Offer is published and listed (on sale) and has handling;
 * 2. its stored tag of the type is `active` (`rechecking`, `suspended`, `pending-publish` and
 *    `removed` never show a badge, and a type with no stored tag shows none);
 * 3. the live decisions of ALL the product's variants are allowed, echo the queries asked, and
 *    agree on one certificate and one badge (`judgeTag`, the same control as the re-ask);
 * 4. the live decision's basis equals the stored tag's basis;
 * 5. certification's active type of that code has a name in the Market's default locale and its
 *    published revision is the one the badge was decided on.
 *
 * The view is copied field by field ({@link OfferBadge}); ids, certificate data, documents and
 * policy never leave. The ask runs OUTSIDE any unit (units do not nest); the reads run in one
 * read-only unit. Any failure (the evaluator, the facts, the type names, a fault) answers no badge
 * for every Offer, never a partial or stored answer. Logs hold codes and counts only.
 */
export class OfferBadgesQuery extends UseCase<
  OfferBadgesInput,
  OfferBadgesMap,
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-badges',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('OfferBadgesQuery');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferBadgesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferBadgesInput,
  ): Promise<Result<OfferBadgesMap, CatalogValidationFailed>> {
    const ids = parseBadgeOfferIds(input.offerIds);
    if (!ids.ok) return ids;
    if (ids.value.length === 0) return ok(new Map());
    try {
      return ok(await this.#badges(context, ids.value));
    } catch (error) {
      // Fail closed: the page shows no badge rather than a stored or partial one.
      this.#logger.warn({
        msg: 'catalog.offer-badges.failed',
        reason: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return ok(new Map());
    }
  }

  async #badges(context: CallContext, offerIds: readonly Id<'Offer'>[]): Promise<OfferBadgesMap> {
    const { deps } = this;
    const { market } = context;
    const none: OfferBadgesMap = new Map();

    // 1. One read-only unit: the Offers, their `active` tags and the queries to ask.
    const read = await deps.unitOfWork.run<readonly Asked[], never>(
      market,
      async () => {
        const offers = await deps.offers.findManyByIds(market, offerIds);
        const snapshots = new Map<string, PublishedSnapshot>();
        const out: Asked[] = [];
        for (const offer of offers) {
          if (offer.state.status !== 'published' || !offer.state.listed) continue;
          const active = offer.tags.filter((tag) => tag.status === 'active' && tag.copy !== null);
          if (active.length === 0) continue;
          const productId = offer.state.productId;
          let snapshot = snapshots.get(productId);
          if (snapshot === undefined) {
            snapshot = await deps.claims.publishedSnapshot(market, productId);
            snapshots.set(productId, snapshot);
          }
          if (snapshot.facts === null) continue;
          const types = [...new Set(active.map((tag) => tag.typeCode))];
          const queries = deps.claims.queries(offer.state, snapshot.facts, types);
          if (queries === null) continue;
          out.push({
            offerId: offer.state.id,
            queries,
            storedBasis: new Map(active.map((tag) => [tag.typeCode, tag.copy!.basis] as const)),
          });
        }
        return ok(out);
      },
      { readOnly: true },
    );
    if (!read.ok || read.value.length === 0) return none;
    const asked = read.value;

    // 2. Outside any unit: the live decisions, and the type names.
    const decisions = await askClaimsMany(
      deps.evaluator,
      context,
      asked.map((item) => item.queries),
    );
    if (!decisions.ok) return none;
    const names = await deps.evaluator.typeNames(context, deps.policy.locales(market).default);
    if (!names.ok) return none;

    // 3. Judge and copy.
    const out = new Map<Id<'Offer'>, readonly OfferBadge[]>();
    asked.forEach((item, index) => {
      const answers = decisions.value[index];
      if (answers === undefined) return;
      const badges: OfferBadge[] = [];
      for (const typeCode of [...item.queries.keys()].sort()) {
        const judged = judgeTag(item.queries.get(typeCode)!, answers.get(typeCode));
        if (judged.kind !== 'allowed') continue;
        if (item.storedBasis.get(typeCode) !== judged.copy.basis) continue;
        const type = names.value.get(typeCode);
        if (type === undefined || type.typeRevisionId !== judged.badge.typeRevisionId) continue;
        badges.push({
          typeCode: judged.badge.typeCode,
          typeName: type.name,
          basis: judged.badge.basis,
          sellerClaim: judged.badge.sellerClaim,
          issuerName: judged.badge.issuer === null ? null : judged.badge.issuer.displayName,
          validUntilLocalDate: judged.badge.validUntilLocalDate,
          verifiedWithIssuer: judged.badge.verifiedWithIssuer,
        });
      }
      if (badges.length > 0) out.set(item.offerId, badges);
    });
    return out;
  }
}

/** At most {@link MAX_BADGE_OFFERS} distinct, well-formed Offer ids; else `validation.failed`. */
function parseBadgeOfferIds(
  offerIds: readonly string[],
): Result<readonly Id<'Offer'>[], CatalogValidationFailed> {
  if (!Array.isArray(offerIds)) {
    return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'type' }] });
  }
  const ids = new Set<Id<'Offer'>>();
  for (const value of offerIds as readonly unknown[]) {
    const parsed = typeof value === 'string' ? parseId<'Offer'>(value) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] });
    }
    ids.add(parsed.value);
  }
  if (ids.size > MAX_BADGE_OFFERS) {
    return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'length' }] });
  }
  return ok([...ids]);
}
