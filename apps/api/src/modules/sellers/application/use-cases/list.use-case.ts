import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AuthorisationCheck,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_VIEW } from '../../../identity';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  cursorText,
  isStateTab,
  listStatusOf,
  STATE_TABS,
  parseListRequest,
  SEARCH_CAP,
  type ListCursor,
  type ListFieldProblem,
  type ListKind,
  type ListRequest,
  type ListTab,
} from '../../domain/seller-list';
import type { SellerStatus } from '../../domain/seller-status';
import {
  SellerAccountAccessRefused,
  type SellerAccountDirectory,
  type SellerAccountEntry,
  type SellerStateCounts,
} from '../ports/seller-account-directory';
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
 * One row of the admin list (sellers design 7.8; Hassan M4): clear fields of `sellers` only, no
 * business name, phone, address or number; and, for an actor holding
 * `identity.seller-access.view`, the Seller Owner's name and sign-in address from `identity`
 * (slice 6b), which are personal data: the route answers `Cache-Control: no-store` and no log
 * line holds them.
 */
export interface SellerListRow {
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string | null;
  /** The held slug, else the draft's; null before one is chosen. */
  readonly slug: string | null;
  /**
   * The status of design 3.3; null when `identity` does not know the seller; `hidden` when the
   * actor does not also hold `identity.seller-access.view` (the status reveals the access state
   * `identity` owns, so `sellers.seller.view` alone does not show it).
   */
  readonly status: SellerStatus | 'hidden' | null;
  /** The Seller Owner; null when hidden (as `status`), unknown to `identity`, or not yet one. */
  readonly owner: { readonly displayName: string | null; readonly email: string } | null;
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

/** The counts of the `identity` state tabs (R-6); null when the actor may not see states. */
export interface StateTabCounts {
  readonly changesNeeded: number;
  readonly notApproved: number;
  readonly approved: number;
  readonly suspended: number;
}

export interface SellerListPage {
  readonly tab: ListTab;
  readonly items: readonly SellerListRow[];
  /** The `after` of the next page, or null after the last. */
  readonly next: string | null;
  readonly counts: ListCounts;
  /** With the first page of a tab; null on a later page of a file tab, and when hidden. */
  readonly stateCounts: StateTabCounts | null;
}

export type SellerListFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly ListFieldProblem[] }
  /** An `identity` state tab for an actor without `identity.seller-access.view`. */
  | { readonly code: 'access.denied' }
  /** The search names more sellers than the list reads safely: narrow it. */
  | { readonly code: 'search.too-broad' }
  | { readonly code: 'sellers.unavailable' };

export interface SellerListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: SellerListRepository;
  readonly directory: SellerAccountDirectory;
  /** Asked once per call whether the actor may see the status column (fails closed to hidden). */
  readonly authorisation: AuthorisationCheck;
  readonly onboardingAreas: OnboardingAreas;
}

/**
 * The second key of the list: the per-row `status` shows `identity`'s access state, so it needs
 * `identity.seller-access.view` besides the rule of the use case (Ali, slice 6 review). Checked
 * through the same `AuthorisationCheck` as the gate; not a use case of its own.
 */
export const LIST_STATUS_ACCESS: AccessDeclaration = {
  name: 'sellers.list-status',
  rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
};

/**
 * `sellers.list` (sellers design 6.2, 7.8; slice 6; SEL-14): the admin's list of sellers, three
 * tabs read from `sellers`' own rows ("Awaiting review", "Incomplete", "All"), with a store-name
 * or slug prefix search, a kind filter on the first, the outside-area filter on the second, and
 * the counts the tabs show. Rule `permissions [sellers.seller.view]` (platform scope), clear
 * fields only: nothing is decrypted and no key is used. The Market comes from the context and is
 * named in every statement, so a seller of another Market is never listed (AC 1).
 *
 * The `status` and the owner of a row, the counts of the state tabs and the state tabs themselves
 * are only for an actor that also holds `identity.seller-access.view`; otherwise the status is
 * `hidden`, the owner and the state counts null, a state tab `access.denied`, and `identity` is
 * not called at all.
 *
 * A tab of `sellers` (slice 6): one read-only unit on `sellers`' tables (ADR-0025), then outside
 * any unit one `identity` call for the state counts and, when the page has rows, **one**
 * `sellerAccountSummaries` call for the state and owner of the whole page (no N+1; spike 2). A
 * state tab (slice 6b: Changes needed, Approved, Suspended; "Not approved" joins with 7b): one
 * `identity` call for a page of ids in the state, newest first, with the counts, then the unit
 * reads those sellers' files, then one `sellerAccountSummaries` call. If `identity` cannot answer,
 * the list is `sellers.unavailable`: a row is never shown with a guessed status. A seller
 * `identity` pages but `sellers` has no file for is left out of that page.
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
    const { directory } = this.deps;
    const showStatus = await this.mayShowStatus(context);

    if (isStateTab(request.tab)) {
      if (!showStatus) return err({ code: 'access.denied' });
      const before = request.after?.tab === request.tab ? request.after.sellerId : null;
      let idPage;
      try {
        idPage = await directory.idsByState(context, {
          state: STATE_TABS[request.tab].state,
          before,
          limit: request.limit,
          reapplyLimitReached: STATE_TABS[request.tab].reapplyLimitReached,
        });
      } catch (error) {
        return this.identityFailed(context, error);
      }
      const read = await this.readFiles(context, request, idPage.sellerIds);
      if (!read.ok) return read;
      const page = read.value.rows ?? [];
      const decorated = await this.decorate(context, page, true);
      if (!decorated.ok) return decorated;
      return ok({
        tab: request.tab,
        items: decorated.value,
        next: idPage.next === null ? null : cursorText({ tab: request.tab, sellerId: idPage.next }),
        counts: read.value.counts,
        stateCounts: stateTabCounts(idPage),
      });
    }

    const read = await this.readFiles(context, request, null);
    if (!read.ok) return read;
    const { counts, rows } = read.value;
    if (rows === null) return err({ code: 'search.too-broad' });

    const more = rows.length > request.limit;
    const page = more ? rows.slice(0, request.limit) : rows;

    // The state counts with the first page only: a later page does not group the Market again.
    let stateCounts: StateTabCounts | null = null;
    if (showStatus && request.after === null) {
      try {
        const answer = await directory.idsByState(context, {
          state: null,
          before: null,
          limit: 0,
          reapplyLimitReached: null,
        });
        stateCounts = stateTabCounts(answer);
      } catch (error) {
        return this.identityFailed(context, error);
      }
    }
    const decorated = await this.decorate(context, page, showStatus);
    if (!decorated.ok) return decorated;
    const last = page[page.length - 1];
    return ok({
      tab: request.tab,
      items: decorated.value,
      next: more && last !== undefined ? cursorText(cursorOf(request, last)) : null,
      counts,
      stateCounts,
    });
  }

  /**
   * The one read-only unit on `sellers`' tables: the counts and either the page of a `sellers`
   * tab (`rows` null when the search is too broad) or, for a state tab, the files of `stateIds`
   * in their order (newest first, as `identity` pages them).
   */
  private async readFiles(
    context: CallContext,
    request: ListRequest,
    stateIds: readonly Id<'Seller'>[] | null,
  ): Promise<
    Result<{ counts: ListCounts; rows: readonly ListedSeller[] | null }, SellerListFailure>
  > {
    const { market } = context;
    const { unitOfWork, list, onboardingAreas } = this.deps;
    const query = (onlyIds: readonly Id<'Seller'>[] | null, take: number): ListPageQuery => ({
      kind: request.kind,
      outsideArea: request.outsideArea,
      openAreaCodes: onboardingAreas.openCodes(market),
      onlyIds,
      after: stateIds === null ? request.after : null,
      take,
    });
    try {
      const read = await unitOfWork.run<
        { counts: ListCounts; rows: readonly ListedSeller[] | null },
        never
      >(
        market,
        async () => {
          const counts = await list.counts(market);
          if (stateIds !== null) {
            const files =
              stateIds.length === 0 ? [] : await list.all(market, query(stateIds, stateIds.length));
            // In `identity`'s order, whatever the order of the read.
            const byId = new Map(files.map((file) => [file.sellerId, file]));
            const rows = stateIds.flatMap((sellerId) => byId.get(sellerId) ?? []);
            return ok({ counts, rows });
          }
          let onlyIds: readonly Id<'Seller'>[] | null = null;
          if (request.search !== null) {
            const found = await list.searchCandidates(market, request.search, SEARCH_CAP);
            if (found.overflow) return ok({ counts, rows: null });
            if (found.ids.length === 0) return ok({ counts, rows: [] as readonly ListedSeller[] });
            onlyIds = found.ids;
          }
          const pageQuery = query(onlyIds, request.limit + 1);
          const rows =
            request.tab === 'awaiting-review'
              ? await list.awaitingReview(market, pageQuery)
              : request.tab === 'incomplete'
                ? await list.incomplete(market, pageQuery)
                : await list.all(market, pageQuery);
          return ok({ counts, rows });
        },
        { readOnly: true },
      );
      if (!read.ok) throw new Error('the read unit failed');
      return read;
    } catch (error) {
      this.fail(context, 'read-failed', error);
      return err({ code: 'sellers.unavailable' });
    }
  }

  /** The rows of a page, with state and owner from one `identity` call when the actor may see them. */
  private async decorate(
    context: CallContext,
    page: readonly ListedSeller[],
    showStatus: boolean,
  ): Promise<Result<readonly SellerListRow[], SellerListFailure>> {
    let accounts: ReadonlyMap<Id<'Seller'>, SellerAccountEntry> = new Map();
    if (showStatus && page.length > 0) {
      try {
        accounts = await this.deps.directory.accountsOf(
          context,
          page.map((row) => row.sellerId),
        );
      } catch (error) {
        return this.identityFailed(context, error);
      }
    }
    const openCodes = new Set(this.deps.onboardingAreas.openCodes(context.market));
    return ok(
      page.map((row) =>
        rowOf(row, showStatus ? (accounts.get(row.sellerId) ?? null) : 'hidden', openCodes),
      ),
    );
  }

  private async mayShowStatus(context: CallContext): Promise<boolean> {
    try {
      return (await this.deps.authorisation.check(context, LIST_STATUS_ACCESS)).allowed;
    } catch (error) {
      this.fail(context, 'status-check-failed', error);
      return false;
    }
  }

  /** `identity` refused the actor (403, a warning), or could not answer (503, an error). */
  private identityFailed(context: CallContext, error: unknown): Result<never, SellerListFailure> {
    if (error instanceof SellerAccountAccessRefused) {
      this.#logger.warn({
        msg: 'sellers.list.access-refused',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.denied' });
    }
    this.fail(context, 'access-failed', error);
    return err({ code: 'sellers.unavailable' });
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

function stateTabCounts(answer: {
  readonly counts: SellerStateCounts;
  readonly rejectedLimitReached: number;
}): StateTabCounts {
  const { counts, rejectedLimitReached } = answer;
  return {
    changesNeeded: counts[STATE_TABS['changes-needed'].state] - rejectedLimitReached,
    notApproved: rejectedLimitReached,
    approved: counts[STATE_TABS.approved.state],
    suspended: counts[STATE_TABS.suspended.state],
  };
}

function rowOf(
  row: ListedSeller,
  account: SellerAccountEntry | null | 'hidden',
  openCodes: ReadonlySet<string>,
): SellerListRow {
  const outside = row.hasAddress
    ? !(row.serviceAreaCode !== null && openCodes.has(row.serviceAreaCode))
    : null;
  return {
    sellerId: row.sellerId,
    storeName: row.storeName,
    slug: row.heldSlug ?? row.draftSlug,
    status:
      account === 'hidden'
        ? 'hidden'
        : listStatusOf({
            access: account?.state ?? null,
            reapplyLimitReached: account?.reapplyLimitReached ?? null,
            hasApprovedRevision: row.hasApprovedRevision,
            pendingKind: row.pending?.kind ?? null,
            draftComplete: row.draftComplete,
            outsideServiceArea: outside,
          }),
    owner: account === 'hidden' || account === null ? null : account.owner,
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
    case 'changes-needed':
    case 'not-approved':
    case 'approved':
    case 'suspended':
      return { tab: request.tab, sellerId: last.sellerId };
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
