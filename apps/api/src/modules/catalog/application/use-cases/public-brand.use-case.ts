import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isBrandSlug } from '../../domain/brand';
import type { BrandReader } from '../ports/brand.reader';

/** An active brand as the public page shows it. No account, seller or version is exposed. */
export interface PublicBrandPage {
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly originCountry: string | null;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
  readonly headerImageId: string | null;
  /** Products published in the request's Market with at least one Offer on sale. */
  readonly productCount: number;
}

export type PublicBrandFailure =
  { readonly code: 'brand.not-found' } | { readonly code: 'brand.unavailable' };

export interface PublicBrandDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `public-brand.read` (catalog brand package, B5): the public page of a brand by slug, with the
 * live count of its products in the request's Market. Rule `anonymous`. Only an ACTIVE brand
 * answers: a draft, an archived or an unknown slug is one `brand.not-found`, byte for byte. The
 * count follows the storefront's own rule for a visible product (published, with an Offer on sale),
 * so it matches what the buyer can open. One read-only unit.
 */
export class PublicBrandQuery extends UseCase<
  { readonly slug: string },
  PublicBrandPage,
  PublicBrandFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.public-brand',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublicBrandDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly slug: string },
  ): Promise<Result<PublicBrandPage, PublicBrandFailure>> {
    if (!isBrandSlug(input?.slug)) return err({ code: 'brand.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.brandReader.publicBySlug(market, input.slug)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'brand.unavailable' });
    if (read.value === null) return err({ code: 'brand.not-found' });
    const { brand, liveProductCount } = read.value;
    return ok({
      slug: brand.slug,
      name: brand.name,
      summary: brand.summary,
      originCountry: brand.originCountry,
      logoImageId: brand.logoImageId,
      logoAlt: brand.logoAlt,
      headerImageId: brand.headerImageId,
      productCount: liveProductCount,
    });
  }
}
