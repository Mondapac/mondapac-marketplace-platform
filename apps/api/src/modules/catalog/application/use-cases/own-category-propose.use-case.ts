import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_CATEGORY_PROPOSE } from '../../contracts/permissions';
import { CategoryProposedAudit } from '../../domain/audit';
import type { CategoryEditRefusal } from '../../domain/category-edit';
import { CategoryProposed } from '../../domain/events';
import { CATEGORY_PROPOSE_LIMITS } from '../../domain/rate-limits';
import { normaliseShelfName } from '../../domain/seller-category';
import {
  categoryIdOf,
  closedInput,
  invalid,
  refuseClaimTexts,
  requiredCategoryLocales,
} from '../categories/category-editor';
import { sellerOf } from '../own-reads/own-reads.shared';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import type {
  CategoryProposalCapability,
  CategoryProposalPolicy,
} from '../ports/category-proposal-capability';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import {
  defaultNameOf,
  LIVE_PARENT,
  MAX_NORMALISED_NAME,
  blockedShelfFields,
  parseShelfTexts,
  shelfPlaces,
  type ClaimRefusal,
  type ShelfTextDependencies,
  type ShelfWriteDependencies,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';

export interface OwnCategoryProposeInput {
  readonly [key: string]: unknown;
}

export interface OwnCategoryProposed {
  readonly proposalId: string;
  /** Always `pending`: an admin decides. */
  readonly status: 'pending';
}

export type OwnCategoryProposeFailure =
  | CategoryEditRefusal
  | ClaimRefusal
  | ReserveFailure
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category-proposal.not-allowed' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'category-proposal.limit'; readonly max: number }
  | { readonly code: 'category-proposal.duplicate' };

export interface OwnCategoryProposeDependencies
  extends ShelfWriteDependencies, ShelfTextDependencies {
  readonly capability: CategoryProposalCapability;
  readonly proposalPolicy: CategoryProposalPolicy;
  readonly eligibility: SellerEligibilityReader;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
}

const KEYS = ['platformParentId', 'texts'] as const;

/**
 * `own-category.propose` (categories C9a; CAT-51, CAT-54; catalog design 4.7): a seller proposes a
 * shelf under a live platform category. Rule: the key `catalog.own-category.propose`, the seller
 * population, a seller who is approved. The seller is the session's, never the body's (Hassan M1).
 * At every command `sellers.mayProposeCategories` must answer `ok(true)` (anything else is
 * `category-proposal.not-allowed`) and the seller must be eligible to sell. Every name and
 * description passes the claim-text check in its own locale, failing closed. A seller may have at
 * most the Market's `maxPendingCategoryProposals` waiting (exact, under the seller's shelf lock) and 20
 * proposals a day; a
 * name already waiting or already a live shelf of the seller under the same parent (NFKC, case
 * folded, yeh and kaf unified) is `category-proposal.duplicate`.
 */
export class OwnCategoryPropose extends UseCase<
  OwnCategoryProposeInput,
  OwnCategoryProposed,
  OwnCategoryProposeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-category-propose',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_CATEGORY_PROPOSE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnCategoryPropose');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnCategoryProposeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnCategoryProposeInput,
  ): Promise<Result<OwnCategoryProposed, OwnCategoryProposeFailure>> {
    const result = await this.#propose(context, input);
    this.#logger.log({
      msg: 'catalog.own-category-propose',
      code: result.ok ? 'proposed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #propose(
    context: CallContext,
    input: OwnCategoryProposeInput,
  ): Promise<Result<OwnCategoryProposed, OwnCategoryProposeFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const { deps } = this;

    const parent = categoryIdOf(body.value['platformParentId']);
    if (!parent.ok) return err({ code: 'category.parent-not-found' });
    let defaultLocale: string;
    let supported: readonly string[];
    let required: readonly string[];
    let maxPending: number;
    try {
      ({ default: defaultLocale, supported } = deps.policy.locales(market));
      required = requiredCategoryLocales(market, deps.policy);
      maxPending = deps.proposalPolicy.maxPending(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const texts = parseShelfTexts(body.value['texts'], { supported, required });
    if (!texts.ok) return texts;
    const blocked = blockedShelfFields(texts.value, (text) =>
      deps.contentFilter.isBlocked(market, text),
    );
    if (!blocked.ok) return blocked;

    if (!(await deps.capability.allows(context, sellerId))) {
      return err({ code: 'category-proposal.not-allowed' });
    }
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const normalisedName = normaliseShelfName(defaultNameOf(texts.value, defaultLocale));
    // A name that NFKC widens past the column's 120 characters (U+FDFA and the like).
    if ([...normalisedName].length > MAX_NORMALISED_NAME) {
      return invalid(`texts.${defaultLocale}.name`, 'too-long');
    }
    // Counted before the claim check, so refused attempts spend the seller's daily budget too.
    const throttled = await reserveForAccount(deps, context, CATEGORY_PROPOSE_LIMITS, sellerId);
    if (throttled !== null) return err(throttled);
    const claim = await refuseClaimTexts(deps, context, shelfPlaces(texts.value));
    if (claim !== null) return err(claim as ClaimRefusal);

    const parentId: Id<'Category'> = parent.value;
    return deps.unitOfWork.run<OwnCategoryProposed, OwnCategoryProposeFailure>(market, async () => {
      // One proposal of a seller at a time, so the pending cap holds exactly (Hassan M1).
      await deps.shelves.lockSeller(market, sellerId);
      const state = await deps.shelves.platformParentState(market, parentId);
      if (state === null || !LIVE_PARENT(state.status)) {
        return err({ code: 'category.parent-not-found' } as const);
      }
      if ((await deps.shelves.pendingCount(market, sellerId)) >= maxPending) {
        return err({ code: 'category-proposal.limit', max: maxPending } as const);
      }
      if (await deps.shelves.activeShelfNamed(market, sellerId, parentId, normalisedName)) {
        return err({ code: 'category-proposal.duplicate' } as const);
      }
      const now = deps.clock.now();
      const id = deps.ids.next<'CategoryProposal'>();
      const added = await deps.shelves.addProposal(market, {
        id,
        sellerId,
        platformParentId: parentId,
        texts: texts.value,
        normalisedName,
        now,
      });
      if (added !== null) return err({ code: 'category-proposal.duplicate' } as const);
      await deps.audit.record(
        context,
        CategoryProposedAudit.entry(id, {
          after: { parentId, localeCount: texts.value.length },
        }),
      );
      await deps.outbox.append(context, [
        CategoryProposed.record({
          aggregateId: id,
          aggregateVersion: 1,
          occurredAt: now,
          payload: { proposalId: id, sellerId },
        }),
      ]);
      return ok({ proposalId: id, status: 'pending' as const });
    });
  }
}
