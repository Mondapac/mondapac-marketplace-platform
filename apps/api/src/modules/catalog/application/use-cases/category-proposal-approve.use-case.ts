import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { CategoryProposalApprovedAudit } from '../../domain/audit';
import { CategoryProposalApproved } from '../../domain/events';
import { normaliseShelfName, shelfSlugBase } from '../../domain/seller-category';
import { closedInput, editorAccountOf, versionOf } from '../categories/category-editor';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryProposalCapability } from '../ports/category-proposal-capability';
import {
  defaultNameOf,
  LIVE_PARENT,
  proposalIdOf,
  type ShelfWriteDependencies,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';

export interface CategoryProposalDecideInput {
  readonly proposalId: string;
  readonly body: unknown;
}

export interface CategoryProposalApproved {
  readonly status: 'approved';
  readonly version: number;
  readonly sellerCategoryId: string;
  readonly slug: string;
}

export type CategoryProposalApproveFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category-proposal.not-found' }
  | { readonly code: 'category-proposal.not-pending' }
  | { readonly code: 'category-proposal.not-allowed' }
  | { readonly code: 'category-proposal.duplicate' }
  | { readonly code: 'category.parent-not-found' }
  | { readonly code: 'conflict.stale' };

export interface CategoryProposalApproveDependencies extends ShelfWriteDependencies {
  readonly capability: CategoryProposalCapability;
  readonly policy: CatalogMarketPolicy;
}

const MAX_SLUG_PROBES = 50;

/**
 * `category-proposal.approve` (categories C9a; CAT-52; catalog design 4.7). Rule: the key
 * `catalog.category-proposal.decide`, the admin population, never an acting-as session; always
 * required, whatever CAT-36 says. The body names the proposal version the page read. The seller's
 * `mayProposeCategories` is asked again and anything but `ok(true)` refuses
 * (`category-proposal.not-allowed`; Hassan M1): the revocation handler cancels the proposal. The
 * approval creates a seller shelf under the proposal's parent, never a platform category, with a
 * slug unique for the seller; a parent no longer live is `category.parent-not-found`, a live shelf
 * of the seller with the same name under that parent `category-proposal.duplicate`. One unit:
 * shelf, decision, audit, event.
 */
export class CategoryProposalApprove extends UseCase<
  CategoryProposalDecideInput,
  CategoryProposalApproved,
  CategoryProposalApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  readonly #logger = new Logger('CategoryProposalApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryProposalApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryProposalDecideInput,
  ): Promise<Result<CategoryProposalApproved, CategoryProposalApproveFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.category-proposal-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: CategoryProposalDecideInput,
  ): Promise<Result<CategoryProposalApproved, CategoryProposalApproveFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const id = proposalIdOf(input.proposalId);
    if (id === null) return err({ code: 'category-proposal.not-found' });
    const body = closedInput(input.body, ['version']);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    let defaultLocale: string;
    try {
      defaultLocale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.shelves.findProposal(market, id)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const seen = read.value;
    if (seen === null) return err({ code: 'category-proposal.not-found' });
    if (seen.status !== 'pending') return err({ code: 'category-proposal.not-pending' });
    if (seen.version !== version.value) return err({ code: 'conflict.stale' });
    // Asked outside the unit: the sellers facade opens its own.
    if (!(await deps.capability.allows(context, seen.sellerId))) {
      return err({ code: 'category-proposal.not-allowed' });
    }

    return deps.unitOfWork.run<CategoryProposalApproved, CategoryProposalApproveFailure>(
      market,
      async () => {
        const proposal = await deps.shelves.findProposal(market, id);
        if (proposal === null) return err({ code: 'category-proposal.not-found' } as const);
        if (proposal.status !== 'pending') {
          return err({ code: 'category-proposal.not-pending' } as const);
        }
        if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const { sellerId, platformParentId } = proposal;
        const parent = await deps.shelves.platformParentState(market, platformParentId);
        if (parent === null || !LIVE_PARENT(parent.status)) {
          return err({ code: 'category.parent-not-found' } as const);
        }
        const name = defaultNameOf(proposal.texts, defaultLocale);
        if (
          await deps.shelves.activeShelfNamed(
            market,
            sellerId,
            platformParentId,
            normaliseShelfName(name),
          )
        ) {
          return err({ code: 'category-proposal.duplicate' } as const);
        }
        const shelfId = deps.ids.next<'SellerCategory'>();
        const base = shelfSlugBase(name);
        let slug: string | null = null;
        for (let n = 1; n <= MAX_SLUG_PROBES && slug === null; n += 1) {
          const candidate = n === 1 ? base : `${base}-${n}`;
          if (!(await deps.shelves.slugTaken(market, sellerId, candidate))) slug = candidate;
        }
        slug ??= `${base}-${shelfId.slice(-8)}`;
        const now = deps.clock.now();
        await deps.shelves.insertShelf(market, {
          id: shelfId,
          sellerId,
          platformParentId,
          slug,
          texts: proposal.texts,
          now,
        });
        const decided = await deps.shelves.decideProposal(
          market,
          id,
          proposal.version,
          { status: 'approved', by: accountId, shelfId },
          now,
        );
        if (!decided) return err({ code: 'conflict.stale' } as const);
        const next = proposal.version + 1;
        await deps.audit.record(
          context,
          CategoryProposalApprovedAudit.entry(id, {
            after: { sellerId, sellerCategoryId: shelfId },
          }),
        );
        await deps.outbox.append(context, [
          CategoryProposalApproved.record({
            aggregateId: id,
            aggregateVersion: next,
            occurredAt: now,
            payload: { proposalId: id, sellerId, sellerCategoryId: shelfId },
          }),
        ]);
        return ok({ status: 'approved' as const, version: next, sellerCategoryId: shelfId, slug });
      },
    );
  }
}
