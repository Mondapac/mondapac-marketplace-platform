import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoreProfileRepository } from '../ports/store-profile.repository';

export const MIN_STORE_SEARCH_LENGTH = 2;
export const MAX_STORE_SEARCH_LENGTH = 80;
/** At most this many sellers are answered; a wider match is flagged `capped`. */
export const MAX_STORE_SEARCH_MATCHES = 200;

export interface SearchStoreNamesInput {
  readonly term: string;
}

export interface SearchStoreNamesView {
  readonly sellerIds: readonly Id<'Seller'>[];
  readonly capped: boolean;
}

export type SearchStoreNamesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'sellers.unavailable' };

export interface SearchStoreNamesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeProfiles: StoreProfileRepository;
}

const logger = new Logger('SearchStoreNames');

/**
 * `searchStoreNames` (the admin order list's store-name search): the sellers whose approved
 * public store name contains the term. The store name is public, as in `sellerSummaries`, so the
 * rule is `anonymous`; callers that need an entitlement (the admin order list) check their own.
 * Only the Market's sellers with an approved revision; never a draft or a legal name. One
 * read-only unit; a failed read is `sellers.unavailable`, never an empty answer. Not over HTTP.
 */
export class SearchStoreNames extends UseCase<
  SearchStoreNamesInput,
  SearchStoreNamesView,
  SearchStoreNamesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.search-store-names',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchStoreNamesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchStoreNamesInput,
  ): Promise<Result<SearchStoreNamesView, SearchStoreNamesFailure>> {
    const raw = input?.term as unknown;
    const term = typeof raw === 'string' ? raw.trim() : null;
    if (
      term === null ||
      [...term].length < MIN_STORE_SEARCH_LENGTH ||
      [...term].length > MAX_STORE_SEARCH_LENGTH
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'term', code: 'length' }] });
    }
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await this.deps.storeProfiles.searchApprovedStoreIds(
              market,
              term,
              MAX_STORE_SEARCH_MATCHES + 1,
            ),
          ),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('the read unit failed');
      return ok({
        sellerIds: read.value.slice(0, MAX_STORE_SEARCH_MATCHES),
        capped: read.value.length > MAX_STORE_SEARCH_MATCHES,
      });
    } catch (error) {
      logger.error({
        msg: 'sellers.search-store-names.read-failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
