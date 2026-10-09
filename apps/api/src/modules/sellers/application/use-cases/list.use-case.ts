import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  cursorText,
  listStatusOf,
  parseListRequest,
  SEARCH_CAP,
  type ListCursor,
  type ListFieldProblem,
  type ListKind,
  type ListRequest,
  type ListTab,
} from '../../domain/seller-list';
import type { SellerStatus } from '../../domain/seller-status';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type {
  ListCounts,
  ListedSeller,
  ListPageQuery,
  SellerListRepository,
} from '../ports/seller-list.repository';
import type { OnboardingAreas } from '../ports/seller-market-formats';

/** The request is the raw JSON body: the use case checks its shape itself (`parseListRequest`). */
export type SellerListInput = unknown;

/**
 * One row of the admin list: clear fields only (sellers design 7.8; Hassan M4). No business
 * name, phone, address or number, and none of `identity`'s personal fields (owner name, sign-in
 * email), which wait for `sellerAccountSummaries`.
 */
export interface SellerListRow {
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string | null;
  /** The held slug, else the draft's; null before one is chosen. */
  readonly slug: string | null;
  /** The status of design 3.3; null when `identity` does not know the seller. */
  readonly status: SellerStatus | null;
  readonly origin: 'self' | 'invitation';
  /** The kind of the pending submission, or null when none is pending. */
  readonly kind: ListKind | null;
  /** ISO instant the pending submission was made, or null. */
  readonly submittedAt: string | null;
  readonly serviceAreaCode: string | null;
  /** IANA zone of the seller (ADR-0005), never an offset. */
  readonly timezone: string | null;
  readonly createdAt: string;
  readonly lastChangedAt: string;
}

export interface SellerListPage {
  readonly tab: ListTab;
  readonly items: readonly SellerListRow[];
  /** The `after` of the next page, or null after the last. */
  readonly next: string | null;
  readonly counts: ListCounts;
}

export type SellerListFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly ListFieldProblem[] }
  /** The search names more sellers than the list reads safely: narrow it. */
  | { readonly code: 'search.too-broad' }
  | { readonly code: 'sellers.unavailable' };

export interface SellerListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: SellerListRepository;
  readonly accessReader: SellerAccessReader;
  readonly onboardingAreas: OnboardingAreas;
}

/**
 * `sellers.list` (sellers design 6.2, 7.8; slice 6; SEL-14): the admin's list of sellers, three
 * tabs read from `sellers`' own rows ("Awaiting review", "Incomplete", "All"), with a store-name
 * or slug prefix search, a kind filter on the first, the outside-area filter on the second, and
 * the counts the tabs show. Rule `permissions [sellers.seller.view]` (platform scope), clear
 * fields only: nothing is decrypted and no key is used. The Market comes from the context and is
 * named in every statement, so a seller of another Market is never listed (AC 1).
 *
 * One read-only unit on `sellers`' tables (ADR-0025), then **one** `identity` call for the state
 * of the whole page, outside any unit (no N+1; spike 2). If `identity` cannot answer, the list is
 * `sellers.unavailable`: a row is never shown with a guessed status. The tabs that page through
 * `identity`'s state (Changes needed, Not approved, Approved, Suspended) and the owner's name and
 * email wait for `identity`'s admin read (R-6 with counts, `sellerAccountSummaries`).
 *
 * The log line holds the tab, counts and codes: never the search term or a store name.
 */
export class SellerList extends UseCase<SellerListInput, SellerListPage, SellerListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.list',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  readonly #logger = new Logger('SellerList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerListInput,
  ): Promise<Result<SellerListPage, SellerListFailure>> {
    const result = await this.list(context, input);
    this.#logger.log({
      msg: 'sellers.list',
      outcome: result.ok ? 'listed' : result.error.code,
      ...(result.ok ? { tab: result.value.tab, rows: result.value.items.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: SellerListInput,
  ): Promise<Result<SellerListPage, SellerListFailure>> {
    const parsed = parseListRequest(input);
    if (!parsed.ok) return err(parsed.error);
    const request = parsed.value;
    const { market } = context;
    const { unitOfWork, list, accessReader, onboardingAreas } = this.deps;

    let read;
    try {
      read = await unitOfWork.run<
        {
          counts: ListCounts;
          rows: readonly ListedSeller[] | null;
        },
        never
      >(
        market,
        async () => {
          const counts = await list.counts(market);
          let onlyIds: readonly Id<'Seller'>[] | null = null;
          if (request.search !== null) {
            const found = await list.searchCandidates(market, request.search, SEARCH_CAP);
            if (found.overflow) return ok({ counts, rows: null });
            if (found.ids.length === 0) return ok({ counts, rows: [] as readonly ListedSeller[] });
            onlyIds = found.ids;
          }
          const query: ListPageQuery = {
            kind: request.kind,
            outsideArea: request.outsideArea,
            openAreaCodes: onboardingAreas.openCodes(market),
            onlyIds,
            after: request.after,
            take: request.limit + 1,
          };
          const rows =
            request.tab === 'awaiting-review'
              ? await list.awaitingReview(market, query)
              : request.tab === 'incomplete'
                ? await list.incomplete(market, query)
                : await list.all(market, query);
          return ok({ counts, rows });
        },
        { readOnly: true },
      );
      if (!read.ok) throw new Error('the read unit failed');
    } catch (error) {
      this.fail(context, 'read-failed', error);
      return err({ code: 'sellers.unavailable' });
    }
    const { counts, rows } = read.value;
    if (rows === null) return err({ code: 'search.too-broad' });

    const more = rows.length > request.limit;
    const page = more ? rows.slice(0, request.limit) : rows;

    let states;
    try {
      states = await accessReader.accessOfMany(
        context,
        page.map((row) => row.sellerId),
      );
    } catch (error) {
      this.fail(context, 'access-failed', error);
      return err({ code: 'sellers.unavailable' });
    }

    const openCodes = new Set(onboardingAreas.openCodes(market));
    const items = page.map((row) => rowOf(row, states.get(row.sellerId) ?? null, openCodes));
    const last = page[page.length - 1];
    return ok({
      tab: request.tab,
      items,
      next: more && last !== undefined ? cursorText(cursorOf(request, last)) : null,
      counts,
    });
  }

  private fail(context: CallContext, reason: string, error: unknown): void {
    this.#logger.error({
      msg: `sellers.list.${reason}`,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

function rowOf(
  row: ListedSeller,
  access: Parameters<typeof listStatusOf>[0]['access'],
  openCodes: ReadonlySet<string>,
): SellerListRow {
  const outside = row.hasAddress
    ? !(row.serviceAreaCode !== null && openCodes.has(row.serviceAreaCode))
    : null;
  return {
    sellerId: row.sellerId,
    storeName: row.storeName,
    slug: row.heldSlug ?? row.draftSlug,
    status: listStatusOf({
      access,
      hasApprovedRevision: row.hasApprovedRevision,
      pendingKind: row.pending?.kind ?? null,
      draftComplete: row.draftComplete,
      outsideServiceArea: outside,
    }),
    origin: row.origin,
    kind: row.pending?.kind ?? null,
    submittedAt: row.pending?.submittedAt.toString() ?? null,
    serviceAreaCode: row.serviceAreaCode,
    timezone: row.operatingTimezone,
    createdAt: row.createdAt.toString(),
    lastChangedAt: row.lastChangedAt.toString(),
  };
}

/** Where the next page starts: after the last row kept, in the order of its tab. */
function cursorOf(request: ListRequest, last: ListedSeller): ListCursor {
  switch (request.tab) {
    case 'all':
      return { tab: 'all', sellerId: last.sellerId };
    case 'incomplete':
      return { tab: 'incomplete', changedAt: last.lastChangedAt, sellerId: last.sellerId };
    case 'awaiting-review':
      // An awaiting-review row always has its pending submission.
      return {
        tab: 'awaiting-review',
        createdAt: last.pending!.submittedAt,
        revisionId: last.pending!.revisionId,
      };
  }
}
