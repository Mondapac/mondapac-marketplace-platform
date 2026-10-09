import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { SAVE_LIMITS, SLUG_CHECK_LIMITS } from '../../domain/rate-limits';
import { parseShopSlug } from '../../domain/shop-slug';
import {
  draftRequirementsOf,
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import {
  draftSaved,
  type DraftConflict,
  type DraftSaved,
  type FileNotFound,
} from '../draft/draft-view';
import { withdrawPendingOnEdit } from '../draft/withdraw-on-edit';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type { ShopSlugRepository } from '../ports/shop-slug.repository';

/** The slug as the seller sends it (UX F13 step 5). The request has no seller id or Market. */
export interface MyFileSaveSlugInput {
  readonly slug?: unknown;
}

export type MyFileSaveSlugFailure =
  | { readonly code: 'slug.format' | 'slug.reserved' | 'slug.taken' }
  | { readonly code: 'file.change-request-required' }
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSaveSlugDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly slugs: ShopSlugRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly policy: SellerMarketPolicy;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.save-slug` (sellers design 6.2; Q-M25): the Seller Owner saves the shop slug of the
 * draft. Rule `permissions [sellers.business-identity.edit]`, allowed while the seller is not
 * approved; the owner is `ActorContext.sellerId`. In order:
 *
 * 1. the saves limit and the slug-check limit of 6.5 are both reserved before any work (a save
 *    refuses `slug.taken`, so it is a probe as a check is); a store that cannot answer is
 *    `access.unavailable`;
 * 2. the Market's reserved words are read (none: `sellers.unavailable`);
 * 3. the slug is parsed: `slug.format` or `slug.reserved`, nothing written;
 * 4. one read-write unit loads the file, refuses a slug another seller holds or any retired slug
 *    (`slug.taken`; advisory, the insert of the first submission is the authority, T1), saves the
 *    slug in the aggregate and writes it over the version it read (`conflict.stale` on a lost
 *    race). The slug the draft already has is a no-op: no write, no new version.
 *
 * A different slug releases the slug the seller's earlier submission held (never public, so it
 * is deleted, not retired; data design 3.5) and withdraws the pending submission, in the same
 * unit. The save itself writes no audit row; the log line holds the outcome code only, never the
 * slug.
 */
export class MyFileSaveSlug extends UseCase<
  MyFileSaveSlugInput,
  DraftSaved,
  MyFileSaveSlugFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-save-slug',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSaveSlugDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSaveSlugInput,
  ): Promise<Result<DraftSaved, MyFileSaveSlugFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'my-file-save-slug',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyFileSaveSlugInput,
  ): Promise<Result<DraftSaved, MyFileSaveSlugFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, slugs, policy, clock } = this.deps;

    const reserved = await reserveRateLimits(
      this.deps,
      context,
      [...SAVE_LIMITS, ...SLUG_CHECK_LIMITS],
      owner.accountId,
    );
    if (!reserved.ok) return reserved;

    const words = policy.reservedWords(market);
    const requirements = draftRequirementsOf(policy, market);
    if (words === null || requirements === null) return err({ code: 'sellers.unavailable' });
    const slug = parseShopSlug(input.slug, words);
    if (!slug.ok) return slug;

    return unitOfWork.run<DraftSaved, MyFileSaveSlugFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      if (!file.draftEditable) return err({ code: 'file.change-request-required' });
      const holder = await slugs.findBySlug(market, slug.value);
      const mine =
        holder === null || (holder.state === 'held' && holder.sellerId === owner.sellerId);
      if (!mine) return err({ code: 'slug.taken' });
      const applied = file.saveSlug(slug.value, clock.now(), requirements);
      if (!applied.ok) return applied;
      if (file.state.version === file.persistedVersion) return ok(draftSaved(file, requirements));
      if (!(await files.saveDraft(market, file))) return err({ code: 'conflict.stale' });
      // A different slug releases the one the first submission held, if any (I-S1; Q-M21): a
      // held row is never public before approval, and a pending submission is withdrawn.
      await slugs.releaseUnpublished(market, owner.sellerId);
      const edit = await withdrawPendingOnEdit(this.deps, context, file);
      if (edit === 'lost') return err({ code: 'conflict.stale' });
      return ok(draftSaved(file, requirements, edit === 'withdrawn'));
    });
  }
}
