import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  PUBLISHED_STORE_SORTS,
  sortStores,
  type PublishedStore,
  type PublishedStoreSort,
} from '../../domain/published-store';
import {
  eligibleOnly,
  failClosed,
  MAX_PUBLISHED_STORES,
  publishedStoresLogger,
  publishedStoresOf,
  readApproved,
  type PublishedStoresDependencies,
  type PublishedStoresUnavailable,
} from '../published/read-published-stores';

export const PUBLISHED_STORE_PAGE_SIZE = { default: 24, max: 48 } as const;
export const PUBLISHED_STORE_MAX_PAGE = 100;

export interface PublishedStoreListInput {
  readonly sort?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PublishedStoreListAnswer {
  readonly items: readonly PublishedStore[];
  /** Every store of the Market that may sell now. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export type PublishedStoreListFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | PublishedStoresUnavailable;

/**
 * `sellers.published-store-list` (slice 12): the buyer site's sellers page. Rule `anonymous`: the
 * answer is the allow-listed public fields of stores that may sell now (AC 25, Hassan M5), the
 * same for every caller. Clear columns only, so no key is unwrapped. Sort `name` (default) or
 * `newest`; `page` 1 to 100, `pageSize` 1 to 48 (default 24).
 */
export class PublishedStoreList extends UseCase<
  PublishedStoreListInput,
  PublishedStoreListAnswer,
  PublishedStoreListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.published-store-list',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedStoresDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedStoreListInput,
  ): Promise<Result<PublishedStoreListAnswer, PublishedStoreListFailure>> {
    const fields: { path: string; code: string }[] = [];
    const sort = input.sort ?? 'name';
    if (!(PUBLISHED_STORE_SORTS as readonly string[]).includes(sort)) {
      fields.push({ path: 'sort', code: 'one-of' });
    }
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > PUBLISHED_STORE_MAX_PAGE) {
      fields.push({ path: 'page', code: 'range' });
    }
    const pageSize = input.pageSize ?? PUBLISHED_STORE_PAGE_SIZE.default;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > PUBLISHED_STORE_PAGE_SIZE.max
    ) {
      fields.push({ path: 'pageSize', code: 'range' });
    }
    if (fields.length > 0) return err({ code: 'validation.failed', fields });

    return failClosed(context, 'published-store-list', async () => {
      const stores = await readApproved(this.deps, context, (repository) =>
        repository.approvedStores(context.market, MAX_PUBLISHED_STORES + 1),
      );
      if (stores.length > MAX_PUBLISHED_STORES) {
        publishedStoresLogger.error({
          msg: 'sellers.published-store-list.cap-reached',
          max: MAX_PUBLISHED_STORES,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
      }
      const eligible = await eligibleOnly(
        this.deps,
        context,
        stores.slice(0, MAX_PUBLISHED_STORES),
      );
      const sorted = sortStores(eligible, sort as PublishedStoreSort);
      const slice = sorted.slice((page - 1) * pageSize, page * pageSize);
      const items = await publishedStoresOf(this.deps, context, slice);
      return { items, total: eligible.length, page, pageSize };
    });
  }
}
