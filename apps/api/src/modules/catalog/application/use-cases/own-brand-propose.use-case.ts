import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  Brand,
  brandNameKey,
  MAX_OPEN_PROPOSALS_PER_SELLER,
  parseBrandContent,
  suggestBrandSlug,
  type BrandRefusal,
} from '../../domain/brand';
import { closedInput, invalidFields, type ValidationFailure } from '../brands/brand-views';
import type { BrandReader } from '../ports/brand.reader';
import type { BrandRepository } from '../ports/brand.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { sellerOf } from '../own-reads/own-reads.shared';
import { SIMILAR_LIMIT } from './brand-create.use-case';

export interface OwnBrandProposeInput {
  readonly name?: unknown;
  readonly summary?: unknown;
  readonly originCountry?: unknown;
}

export interface OwnBrandProposed {
  readonly brandId: string;
  readonly slug: string;
  /** Always `draft`: the brand is inactive until an admin approves it. */
  readonly status: 'draft';
}

export type OwnBrandProposeFailure =
  | BrandRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'brand.own-brand-required' }
  | { readonly code: 'brand.proposal-limit'; readonly max: number }
  | { readonly code: 'brand.slug-taken' }
  | {
      readonly code: 'brand.near-duplicate';
      /** Active look-alikes only: a seller never learns another seller's draft. */
      readonly brands: readonly {
        readonly id: string;
        readonly slug: string;
        readonly name: string;
      }[];
    }
  | ValidationFailure;

export interface OwnBrandProposeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brands: BrandRepository;
  readonly brandReader: BrandReader;
  readonly eligibility: SellerEligibilityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const PROPOSE_KEYS = ['name', 'summary', 'originCountry'] as const;
const MAX_SLUG_PROBES = 50;

/**
 * `own-brand.propose` (catalog brand package): a seller proposes a brand. Rule: the key
 * `catalog.own-product.edit`, the seller population and a seller who may sell. The seller must own
 * at least one product marked `ownBrand` (`brand.own-brand-required`) and may have at most
 * {@link MAX_OPEN_PROPOSALS_PER_SELLER} proposals waiting (`brand.proposal-limit`). The brand is
 * created as a `draft` with the seller as proposer: it has no public page and no product resolves
 * to it until an admin approves it. A name that is a near-duplicate of a live brand is refused with
 * that brand's slug, so the seller uses it instead of proposing a twin. Only the name, a summary
 * and the origin country come from the seller; images are an admin's.
 */
export class OwnBrandPropose extends UseCase<
  OwnBrandProposeInput,
  OwnBrandProposed,
  OwnBrandProposeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-brand-propose',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnBrandPropose');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnBrandProposeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnBrandProposeInput,
  ): Promise<Result<OwnBrandProposed, OwnBrandProposeFailure>> {
    const result = await this.#propose(context, input);
    this.#logger.log({
      msg: 'catalog.own-brand-propose',
      code: result.ok ? 'proposed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #propose(
    context: CallContext,
    input: OwnBrandProposeInput,
  ): Promise<Result<OwnBrandProposed, OwnBrandProposeFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, PROPOSE_KEYS);
    if (!body.ok) return body;
    const content = parseBrandContent(body.value);
    if (!content.ok) return invalidFields(content.error);
    const { market } = context;
    const { brands } = this.deps;

    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }

    return this.deps.unitOfWork.run<OwnBrandProposed, OwnBrandProposeFailure>(market, async () => {
      if (!(await this.deps.brandReader.sellerHasOwnBrandProduct(market, sellerId))) {
        return err({ code: 'brand.own-brand-required' } as const);
      }
      if ((await brands.openProposalCount(market, sellerId)) >= MAX_OPEN_PROPOSALS_PER_SELLER) {
        return err({ code: 'brand.proposal-limit', max: MAX_OPEN_PROPOSALS_PER_SELLER } as const);
      }
      const similar = await brands.similarTo(market, {
        name: content.value.name,
        nameKey: brandNameKey(content.value.name),
        limit: SIMILAR_LIMIT,
      });
      if (similar.length > 0) {
        return err({
          code: 'brand.near-duplicate',
          brands: similar
            .filter((brand) => brand.status === 'active')
            .map(({ id, slug, name }) => ({ id, slug, name })),
        } as const);
      }
      const base = suggestBrandSlug(content.value.name);
      let free: string | null = null;
      for (let n = 1; n <= MAX_SLUG_PROBES && free === null; n += 1) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        if (!(await brands.slugTaken(market, candidate))) free = candidate;
      }
      const created = Brand.create({
        id: this.deps.ids.next<'Brand'>(),
        content: content.value,
        slug: free ?? `${base}-${this.deps.ids.next<'Brand'>().slice(-8)}`,
        origin: { kind: 'seller', sellerId },
        now: this.deps.clock.now(),
      });
      if (!created.ok) return err(created.error);
      const added = await brands.add(market, created.value);
      if (added !== null) return err({ code: added } as const);
      return ok({
        brandId: created.value.state.id,
        slug: created.value.state.slug,
        status: 'draft' as const,
      });
    });
  }
}
