import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_SELLER_CATEGORY_PROMOTE_MERGE } from '../../contracts/permissions';
import { SellerCategoryPromotedAudit } from '../../domain/audit';
import {
  isCategorySlug,
  isEditable,
  levelOf,
  siblingNameClashes,
} from '../../domain/category-edit';
import { PlatformCategoryCreated, SellerCategoryPromoted } from '../../domain/events';
import type { ShelfView } from '../../domain/seller-category';
import {
  checkedPlaces,
  closedInput,
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
} from '../categories/category-editor';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import {
  blockedShelfFields,
  categoryTextOf,
  lockedShelf,
  shelfIdOf,
} from '../seller-categories/seller-category-shared';

export interface SellerCategoryCommandInput {
  readonly shelfId: string;
  readonly body: unknown;
}

export interface SellerCategoryPromoted {
  /** The new platform category: the shelf's own id, created `hidden`. */
  readonly categoryId: string;
  readonly slug: string;
  readonly status: 'hidden';
  readonly treeVersion: number;
  readonly offersCleared: number;
}

export type SellerCategoryPromoteFailure =
  | CategoryWriteFailure
  | { readonly code: 'seller-category.not-found' }
  | { readonly code: 'seller-category.not-active' };

export interface SellerCategoryPromoteDependencies extends CategoryWriteDependencies {
  readonly shelves: SellerCategoryStore;
}

const KEYS = ['version', 'slug', 'treeVersion'] as const;

/**
 * `seller-category.promote` (categories C9a; CAT-53; catalog design 4.7; plan decision 5). Rule:
 * the protected key `catalog.seller-category.promote-merge`, the admin population, never an
 * acting-as session. An active shelf becomes a platform category with the same id, under the
 * shelf's platform parent, created `hidden` and last among its siblings, with the shelf's names
 * and descriptions and the free platform slug the admin gives (English). The tree rules of an add
 * apply: the level may not pass `maxCategoryDepth`, no two siblings share a name in a locale, the
 * slug is free and not retired, every text and the slug pass the claim-text check again. A
 * structural write: the body names the tree version and the shelf version the page read. The
 * shelf closes as `promoted` and leaves the seller's Offers (each Offer's version raised, a
 * `shelf-cleared` history row); no published revision changes. Audited, with events.
 */
export class SellerCategoryPromote extends UseCase<
  SellerCategoryCommandInput,
  SellerCategoryPromoted,
  SellerCategoryPromoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seller-category-promote',
    rule: { kind: 'permissions', allOf: [CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key] },
  };

  readonly #logger = new Logger('SellerCategoryPromote');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCategoryPromoteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCategoryCommandInput,
  ): Promise<Result<SellerCategoryPromoted, SellerCategoryPromoteFailure>> {
    const result = await this.#promote(context, input);
    this.#logger.log({
      msg: 'catalog.seller-category-promote',
      code: result.ok ? 'promoted' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #promote(
    context: CallContext,
    input: SellerCategoryCommandInput,
  ): Promise<Result<SellerCategoryPromoted, SellerCategoryPromoteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const shelfId = shelfIdOf(input.shelfId);
    if (shelfId === null) return err({ code: 'seller-category.not-found' });
    const body = closedInput(input.body, KEYS);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const slug = body.value['slug'];
    if (!isCategorySlug(slug)) return invalid('slug', 'format');
    const { market } = context;
    const { deps } = this;
    let maxDepth: number;
    try {
      maxDepth = deps.policy.maxCategoryDepth(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.shelves.findShelf(market, shelfId)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const seen = read.value;
    if (seen === null) return err({ code: 'seller-category.not-found' });
    const refusal = shelfRefusal(seen, version.value);
    if (refusal !== null) return err(refusal);
    // The shelf's texts become platform content: the Market's content filter applies again, as
    // on a category create (Hassan L3).
    const blocked = blockedShelfFields(seen.texts, (text) =>
      deps.contentFilter.isBlocked(market, text),
    );
    if (!blocked.ok) return blocked;
    const texts = seen.texts.map(categoryTextOf);
    const claim = await refuseClaimTexts(deps, context, checkedPlaces({ texts, slug }));
    if (claim !== null) return err(claim);

    return runStructural<SellerCategoryPromoted, SellerCategoryPromoteFailure>(
      deps,
      market,
      treeVersion.value,
      async (nodes, nextTreeVersion) => {
        const shelf = await lockedShelf(deps.shelves, market, shelfId);
        if (shelf === null) return err({ code: 'seller-category.not-found' } as const);
        const stale = shelfRefusal(shelf, version.value);
        if (stale !== null) return err(stale);
        const { sellerId, platformParentId } = shelf;
        const parentId: Id<'Category'> = platformParentId;
        const byId = new Map(nodes.map((node) => [node.id as string, node] as const));
        const parent = byId.get(parentId);
        if (parent === undefined || !isEditable(parent.status)) {
          return err({ code: 'category.parent-not-found' } as const);
        }
        const level = levelOf(byId, parentId) + 1;
        if (level > maxDepth)
          return err({ code: 'category.depth-exceeded', max: maxDepth } as const);
        const now = deps.clock.now();
        await deps.store.lockSlugs(market, [slug]);
        if (await deps.store.slugUnavailable(market, slug, null, now)) {
          return err({ code: 'category.slug-taken' } as const);
        }
        const shelfTexts = shelf.texts.map(categoryTextOf);
        const clashes = siblingNameClashes(nodes, parentId, null, shelfTexts);
        if (clashes.length > 0) {
          return err({ code: 'category.sibling-name-taken', fields: clashes } as const);
        }
        // The platform category takes the shelf's id (CAT-53: the same id into the platform tree).
        const categoryId = shelfId as string as Id<'Category'>;
        await deps.store.insert(market, {
          id: categoryId,
          revisionId: deps.ids.next<'CategoryRevision'>(),
          parentId,
          slug,
          texts: shelfTexts,
          seo: { title: null, description: null, noindex: false },
          showInMenu: true,
          authorAccountId: accountId,
          now,
        });
        if (
          !(await deps.shelves.closeShelf(market, shelfId, shelf.version, { status: 'promoted' }))
        ) {
          return err({ code: 'conflict.stale' } as const);
        }
        const offersCleared = await deps.shelves.clearShelfOnOffers(
          market,
          shelfId,
          { kind: 'admin', accountId, actingAdminAccountId: null },
          now,
        );
        await deps.audit.record(
          context,
          SellerCategoryPromotedAudit.entry(shelfId, {
            after: { sellerId, parentId, level, offersCleared },
          }),
        );
        await deps.outbox.append(context, [
          SellerCategoryPromoted.record({
            aggregateId: shelfId,
            aggregateVersion: shelf.version + 1,
            occurredAt: now,
            payload: { sellerCategoryId: shelfId, sellerId },
          }),
          PlatformCategoryCreated.record({
            aggregateId: categoryId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { categoryId },
          }),
        ]);
        return ok({
          categoryId,
          slug,
          status: 'hidden' as const,
          treeVersion: nextTreeVersion,
          offersCleared,
        });
      },
    );
  }
}

/** Why a shelf read cannot be promoted or merged at the version the page named, or null. */
export function shelfRefusal(
  shelf: ShelfView,
  expectedVersion: number,
): { readonly code: 'seller-category.not-active' } | { readonly code: 'conflict.stale' } | null {
  if (shelf.status !== 'active') return { code: 'seller-category.not-active' };
  if (shelf.version !== expectedVersion) return { code: 'conflict.stale' };
  return null;
}
