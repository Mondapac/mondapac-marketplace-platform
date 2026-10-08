import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { SLUG_CHECK_LIMITS } from '../../domain/rate-limits';
import { parseShopSlug } from '../../domain/shop-slug';
import {
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type { ShopSlugRepository } from '../ports/shop-slug.repository';

export interface MyFileCheckSlugInput {
  readonly slug?: unknown;
}

/**
 * The answer of a check (sellers design 14.3 Reza 3): never who holds a slug or why one is
 * reserved. `slug.available` is not a promise: a draft slug is not held (T1), the first
 * submission holds it, and a lost race answers `slug.taken` there. `slug` is the normalised
 * value for an available slug only.
 */
export type SlugCheck =
  | { readonly code: 'slug.available'; readonly slug: string }
  | { readonly code: 'slug.taken' | 'slug.reserved' | 'slug.format' };

export type MyFileCheckSlugFailure =
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | { readonly code: 'file.change-request-required' }
  | FileNotFound;

export interface MyFileCheckSlugDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly slugs: ShopSlugRepository;
  readonly policy: SellerMarketPolicy;
  readonly files: SellerFileRepository;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.check-slug` (sellers design 3.5, 6.2, 6.5; slice 2): the availability of a shop slug
 * for the Seller Owner's draft. Same access rule and ownership as the draft saves; refused on a
 * file with an approved revision (a slug never changes after approval, AC 16; none exists before
 * slice 5), never because of `identity`'s access state. The file and the slug are read in one
 * read-only unit. The slug-check
 * limit (30 a minute, 300 a day per account) is reserved first; a store that cannot answer is
 * `access.unavailable`.
 *
 * Available means: no row of this slug in the Market, or a row this seller holds. A slug another
 * seller holds, and any retired slug (never held again, brief s7), is taken. The format and the
 * Market's reserved words come first and need no read. Nothing is written but the counters.
 */
export class MyFileCheckSlug extends UseCase<
  MyFileCheckSlugInput,
  SlugCheck,
  MyFileCheckSlugFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-check-slug',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileCheckSlugDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileCheckSlugInput,
  ): Promise<Result<SlugCheck, MyFileCheckSlugFailure>> {
    const result = await this.check(context, input ?? {});
    logDraftOutcome(
      'my-file-check-slug',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }

  private async check(
    context: CallContext,
    input: MyFileCheckSlugInput,
  ): Promise<Result<SlugCheck, MyFileCheckSlugFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, slugs, policy, files } = this.deps;

    const reserved = await reserveRateLimits(
      this.deps,
      context,
      SLUG_CHECK_LIMITS,
      owner.accountId,
    );
    if (!reserved.ok) return reserved;

    const words = policy.reservedWords(market);
    if (words === null) return err({ code: 'sellers.unavailable' });
    const slug = parseShopSlug(input.slug, words);

    return unitOfWork.run<SlugCheck, MyFileCheckSlugFailure>(
      market,
      async () => {
        const file = await files.findById(market, owner.sellerId);
        if (file === null) return err({ code: 'file.not-found' });
        if (!file.draftEditable) return err({ code: 'file.change-request-required' });
        if (!slug.ok) return ok({ code: slug.error.code });
        const holder = await slugs.findBySlug(market, slug.value);
        const mine =
          holder === null || (holder.state === 'held' && holder.sellerId === owner.sellerId);
        return ok(mine ? { code: 'slug.available', slug: slug.value } : { code: 'slug.taken' });
      },
      { readOnly: true },
    );
  }
}
