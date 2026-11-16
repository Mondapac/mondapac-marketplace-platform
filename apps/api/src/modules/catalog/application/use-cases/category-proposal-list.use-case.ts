import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { listPage, pageWindow, type ListPagingMode } from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { normaliseShelfName } from '../../domain/seller-category';
import { closedInput, editorAccountOf } from '../categories/category-editor';
import { readCatalogListInput } from '../lists/catalog-list-input';
import type { CategoryProposalView } from '../../domain/seller-category';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import {
  proposalBodyOf,
  type ProposalBody,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';

/** One sort, by the time of the proposal: `asc` (default) puts the one waiting longest first. */
export const PROPOSAL_SORTS = ['created'] as const;
export const PROPOSAL_PAGE_DEFAULT = 25;
export const PROPOSAL_PAGE_MAX = 50;
export const PROPOSAL_MAX_PAGE = 100;

/**
 * The row actions of the Actions menu (the plan's table, row 12): `approve` and `reject` decide
 * with the list's own key, and a waiting proposal is the only row the list holds.
 */
export const PROPOSAL_ACTIONS: readonly string[] = ['approve', 'reject'];

export interface CategoryProposalListItem extends ProposalBody {
  /** The seller's store name; null when sellers cannot name the seller. */
  readonly storeName: string | null;
  readonly actions: readonly string[];
}

export interface CategoryProposalListAnswer {
  /** By time, oldest first by default. */
  readonly items: readonly CategoryProposalListItem[];
  /** The `afterId` of the next page of the cursor read; null on the last page and on a page read. */
  readonly nextAfterId: string | null;
  /** Waiting proposals matching over all pages; null in `prev-next` mode and on a cursor read. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

export interface CategoryProposalListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: SellerCategoryStore;
  readonly sellerNames: SellerNamesReader;
}

type Failure =
  ValidationFailure | { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

interface ProposalPageRead {
  readonly rows: readonly CategoryProposalView[];
  readonly nextAfterId: string | null;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

/**
 * `category-proposal.list` (categories C9a; ux FP8 row 4; super list 12): the Market's waiting
 * proposals, oldest first by default, searched by the proposed name (`q`), read by page number or
 * Previous and Next, or by cursor as the older panel does (at most 50 a page). Rule: the key
 * `catalog.category-proposal.decide`, the admin population, never an acting-as session. Store
 * names come from `sellerSummaries`; a seller it cannot name shows without one.
 */
export class CategoryProposalList extends UseCase<unknown, CategoryProposalListAnswer, Failure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-list',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryProposalListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CategoryProposalListAnswer, Failure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input ?? {}, [
      'q',
      'afterId',
      'limit',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (!body.ok) return body;
    const read = readCatalogListInput(body.value, {
      sorts: PROPOSAL_SORTS,
      defaultSort: 'created',
      defaultDirection: () => 'asc',
      pageDefault: PROPOSAL_PAGE_DEFAULT,
      pageMax: PROPOSAL_PAGE_MAX,
      maxPage: PROPOSAL_MAX_PAGE,
      cursorIdOf: (value) =>
        typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null,
    });
    if (!read.ok) return read;
    const { market } = context;
    const { shelves } = this.deps;
    const nameKey = read.value.q === null ? null : normaliseShelfName(read.value.q);
    const unit = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ProposalPageRead, never>> => {
        if (read.value.mode === 'cursor') {
          const found = await shelves.listPending(market, {
            after: read.value.afterId as Id<'CategoryProposal'> | null,
            limit: read.value.limit + 1,
          });
          const rows = found.slice(0, read.value.limit);
          return ok({
            rows,
            nextAfterId:
              found.length > read.value.limit ? (rows[rows.length - 1]?.id ?? null) : null,
            total: null,
            page: 1,
            pageSize: read.value.limit,
            paging: 'prev-next',
            hasNext: found.length > read.value.limit,
          });
        }
        const paged = read.value.paged;
        const window = pageWindow(paged);
        const filter = { nameKey };
        const total = paged.paging === 'pages' ? await shelves.countPending(market, filter) : null;
        const found =
          total !== null && window.offset >= total
            ? []
            : await shelves.pagePending(market, {
                ...filter,
                direction: paged.direction,
                offset: window.offset,
                limit: window.limit,
              });
        const shown = listPage(found, paged, total);
        return ok({
          rows: shown.items,
          // The current panel pages by cursor: on its order (oldest first) a page read names the
          // cursor of the next page too.
          nextAfterId:
            shown.hasNext && paged.direction === 'asc' && nameKey === null
              ? (shown.items[shown.items.length - 1]?.id ?? null)
              : null,
          total: shown.total,
          page: shown.page,
          pageSize: shown.pageSize,
          paging: shown.paging,
          hasNext: shown.hasNext,
        });
      },
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    const { rows, ...rest } = unit.value;
    const names = await this.deps.sellerNames.storeNames(context, [
      ...new Set(rows.map((row) => row.sellerId)),
    ]);
    return ok({
      items: rows.map((row) => ({
        ...proposalBodyOf(row),
        storeName: names.get(row.sellerId) ?? null,
        actions: PROPOSAL_ACTIONS,
      })),
      ...rest,
    });
  }
}
