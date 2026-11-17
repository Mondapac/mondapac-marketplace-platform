import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import {
  MAX_VISIBILITY_OFFERS,
  type CultureVisibilityUnavailable,
  type OfferCultureCodes,
} from '../../contracts/catalog-cultures.facade';
import {
  resolveEffectiveMarks,
  type CultureCategoryRow,
  type EffectiveCategoryMarks,
} from '../../domain/culture-category';
import {
  visibleCultureCodes,
  type OfferCultureFacts,
  type VisibilityCulture,
} from '../../domain/culture-visibility';
import { judgeTag, type TagClaimQuery } from '../../domain/offer-tag';
import { askClaimsMany } from '../tags/ask-claims';
import type { ClaimQueryBuilder, PublishedSnapshot } from '../tags/claim-query-builder';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { CultureReader } from '../ports/culture.reader';
import type { CultureRepository } from '../ports/culture.repository';
import {
  VISIBILITY_SOURCE_BATCH,
  type SellerCertificateTypes,
  type SellerMemberCultures,
} from '../ports/culture-visibility-sources';
import type { OfferRepository } from '../ports/offer.repository';

export interface OfferCultureVisibilityInput {
  readonly offerIds: readonly string[];
}

export interface OfferCultureVisibilityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly cultureReader: CultureReader;
  readonly cultures: CultureRepository;
  readonly memberCultures: SellerMemberCultures;
  readonly certificateTypes: SellerCertificateTypes;
}

export type OfferCultureVisibilityFailure = CatalogValidationFailed | CultureVisibilityUnavailable;

/** What the read-only unit gathers for one published Offer. */
interface Gathered {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** Per culture, the effective marks of each of the product's platform categories. */
  readonly categoryMarks: ReadonlyMap<Id<'Culture'>, readonly EffectiveCategoryMarks[]>;
  /** The queries of the stored `active` tags whose type some active culture requires. */
  readonly queries: ReadonlyMap<string, readonly TagClaimQuery[]>;
  readonly storedBasis: ReadonlyMap<string, 'SELLER' | 'MANUFACTURER'>;
}

/** Any source failed: the whole answer is unavailable, never a partial or optimistic one. */
class VisibilityUnavailable extends Error {
  override readonly name = 'VisibilityUnavailable';
}

/**
 * The shared body of the `anonymous` / `system` pair: the visibility rule of ADR-0047 decision 5
 * with ADR-0048 security review M2 (multi-culture package 3a), for at most
 * {@link MAX_VISIBILITY_OFFERS} Offers of the context's Market.
 *
 * 1. One read-only unit: the Offers (only `published` ones can be visible), the Market's ACTIVE
 *    cultures and their category rows (one statement for all cultures), and, batched over the
 *    products (`publishedSnapshots`), the live paths of its published revision's
 *    platform categories, resolved per culture with `resolveEffectiveMarks`; for each stored
 *    `active` tag whose type an active culture requires, the claim queries (`ClaimQueryBuilder`,
 *    the one builder of claim queries).
 * 2. Outside any unit (the facades open their own): sellers' approved memberships; certification's
 *    valid certificate types of the sellers approved in a certified culture (M2); and
 *    `evaluateClaims` for those tags, judged as the badge is (`judgeTag`, every variant allowed, on
 *    the stored basis). A claim is never inferred: no tag, no allowed decision, no visibility.
 * 3. The pure rule (`visibleCultureCodes`) per Offer.
 *
 * Fail closed: an unknown, unpublished or other Market's Offer is visible nowhere (absent from the
 * map); any failure of a read or a facade, or an `unavailable` claim decision, answers
 * `culture-visibility.unavailable` for the whole call (the caller treats every Offer as visible
 * nowhere, or retries). Nothing is cached. Logs hold codes and counts only.
 */
export async function offerCultureVisibility(
  deps: OfferCultureVisibilityDependencies,
  context: CallContext,
  input: OfferCultureVisibilityInput,
  logger: Logger,
): Promise<Result<OfferCultureCodes, OfferCultureVisibilityFailure>> {
  const ids = parseOfferIds(input?.offerIds);
  if (!ids.ok) return ids;
  if (ids.value.length === 0) return ok(new Map());
  try {
    return ok(await evaluate(deps, context, ids.value));
  } catch (error) {
    logger.warn({
      msg: 'catalog.culture-visibility.unavailable',
      reason: error instanceof Error ? error.name : 'unknown',
      offers: ids.value.length,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'culture-visibility.unavailable' });
  }
}

async function evaluate(
  deps: OfferCultureVisibilityDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<OfferCultureCodes> {
  const { market } = context;
  const read = await deps.unitOfWork.run<
    { readonly cultures: readonly VisibilityCulture[]; readonly offers: readonly Gathered[] },
    never
  >(
    market,
    async () => {
      const cultureStates = await deps.cultureReader.list(market, {
        status: 'active',
        search: null,
      });
      const cultures: VisibilityCulture[] = cultureStates.map((c) => ({
        id: c.id,
        code: c.code,
        status: c.status,
        displayOrder: c.displayOrder,
        requiredCertificationType: c.requiredCertificationType,
      }));
      if (cultures.length === 0) return ok({ cultures, offers: [] });
      // One statement for the rows of every active culture, one batch of product snapshots.
      const rowsByCulture = await deps.cultures.categoryRowsOf(
        market,
        cultures.map((c) => c.id),
      );
      const noRows: readonly CultureCategoryRow[] = [];
      const requiredTypes = new Set(
        cultures.flatMap((c) =>
          c.requiredCertificationType === null ? [] : [c.requiredCertificationType],
        ),
      );
      const published = (await deps.offers.findManyByIds(market, offerIds)).filter(
        (offer) => offer.state.status === 'published',
      );
      const snapshots: ReadonlyMap<string, PublishedSnapshot> =
        published.length === 0
          ? new Map()
          : await deps.claims.publishedSnapshots(
              market,
              published.map((offer) => offer.state.productId),
            );
      const offers: Gathered[] = [];
      for (const offer of published) {
        if (!offer.tagsLoaded) throw new VisibilityUnavailable('tags not loaded');
        const snapshot = snapshots.get(offer.state.productId);
        if (snapshot === undefined || snapshot.facts === null) continue;
        // A path is root first; the marks resolve from the category up.
        const chains = snapshot.facts.platformCategoryPaths.map((path) => [...path].reverse());
        const categoryMarks = new Map<Id<'Culture'>, readonly EffectiveCategoryMarks[]>(
          cultures.map((culture) => [
            culture.id,
            chains.map((chain) =>
              resolveEffectiveMarks(chain, rowsByCulture.get(culture.id) ?? noRows),
            ),
          ]),
        );
        const active = offer.tags.filter(
          (tag) => tag.status === 'active' && tag.copy !== null && requiredTypes.has(tag.typeCode),
        );
        const types = [...new Set(active.map((tag) => tag.typeCode))];
        // No handling: nothing can be asked, so no tag is allowed (the Offer may still be visible
        // where membership is enough).
        const queries =
          types.length === 0
            ? new Map<string, readonly TagClaimQuery[]>()
            : (deps.claims.queries(offer.state, snapshot.facts, types) ?? new Map());
        offers.push({
          offerId: offer.state.id,
          sellerId: offer.state.sellerId,
          categoryMarks,
          queries,
          storedBasis: new Map(active.map((tag) => [tag.typeCode, tag.copy!.basis] as const)),
        });
      }
      return ok({ cultures, offers });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new VisibilityUnavailable('read failed');
  const { cultures, offers } = read.value;
  const answer = new Map<Id<'Offer'>, readonly string[]>();
  if (offers.length === 0) return answer;

  // Memberships of every seller met.
  const sellerIds = [...new Set(offers.map((o) => o.sellerId))];
  const members = new Map<Id<'Seller'>, ReadonlySet<Id<'Culture'>>>();
  for (let at = 0; at < sellerIds.length; at += VISIBILITY_SOURCE_BATCH) {
    const batch = sellerIds.slice(at, at + VISIBILITY_SOURCE_BATCH);
    const got = await deps.memberCultures.approvedCultures(context, batch);
    if (!got.ok) throw new VisibilityUnavailable('memberships');
    for (const [sellerId, cultureIds] of got.value) members.set(sellerId, cultureIds);
  }

  // The valid certificate types of the sellers approved in a certified culture (M2).
  const certified = new Set(
    cultures.filter((c) => c.requiredCertificationType !== null).map((c) => c.id),
  );
  const needCertificates = sellerIds.filter((sellerId) =>
    [...(members.get(sellerId) ?? [])].some((cultureId) => certified.has(cultureId)),
  );
  const requiredTypeCodes = new Set(
    cultures.flatMap((c) =>
      c.requiredCertificationType === null ? [] : [c.requiredCertificationType],
    ),
  );
  const validTypes = new Map<Id<'Seller'>, ReadonlySet<string>>();
  for (let at = 0; at < needCertificates.length; at += VISIBILITY_SOURCE_BATCH) {
    const batch = needCertificates.slice(at, at + VISIBILITY_SOURCE_BATCH);
    const got = await deps.certificateTypes.validTypes(context, batch, [...requiredTypeCodes]);
    if (!got.ok) throw new VisibilityUnavailable('certificates');
    for (const [sellerId, types] of got.value) validTypes.set(sellerId, types);
  }

  // The live claim decisions of the tags that matter, asked only for a member of a certified culture.
  const asking = offers.filter((o) => o.queries.size > 0 && needCertificates.includes(o.sellerId));
  const decisions =
    asking.length === 0
      ? { ok: true as const, value: [] }
      : await askClaimsMany(
          deps.evaluator,
          context,
          asking.map((o) => o.queries),
        );
  if (!decisions.ok) throw new VisibilityUnavailable('claims');
  const allowedByOffer = new Map<Id<'Offer'>, ReadonlySet<string>>();
  asking.forEach((offer, index) => {
    const answers = decisions.value[index];
    const allowed = new Set<string>();
    for (const [typeCode, queries] of offer.queries) {
      const judged = judgeTag(queries, answers?.get(typeCode));
      if (judged.kind === 'unavailable') throw new VisibilityUnavailable('claim decision');
      if (judged.kind !== 'allowed') continue;
      if (offer.storedBasis.get(typeCode) !== judged.copy.basis) continue;
      allowed.add(typeCode);
    }
    allowedByOffer.set(offer.offerId, allowed);
  });

  for (const offer of offers) {
    const facts: OfferCultureFacts = {
      approvedCultureIds: members.get(offer.sellerId) ?? new Set(),
      sellerValidTypes: validTypes.get(offer.sellerId) ?? new Set(),
      categoryMarks: offer.categoryMarks,
      allowedTagTypes: allowedByOffer.get(offer.offerId) ?? new Set(),
    };
    answer.set(offer.offerId, visibleCultureCodes(cultures, facts));
  }
  return answer;
}

/** At most {@link MAX_VISIBILITY_OFFERS} distinct, well-formed Offer ids; else `validation.failed`. */
function parseOfferIds(offerIds: unknown): Result<readonly Id<'Offer'>[], CatalogValidationFailed> {
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
  if (ids.size > MAX_VISIBILITY_OFFERS) {
    return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'length' }] });
  }
  return ok([...ids]);
}

/** `catalog.offer-culture-visibility`: rule `anonymous` (buyer reads, the cart; in process only). */
export class OfferCultureVisibility extends UseCase<
  OfferCultureVisibilityInput,
  OfferCultureCodes,
  OfferCultureVisibilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-culture-visibility',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('OfferCultureVisibility');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferCultureVisibilityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferCultureVisibilityInput,
  ): Promise<Result<OfferCultureCodes, OfferCultureVisibilityFailure>> {
    return offerCultureVisibility(this.deps, context, input, this.#logger);
  }
}
