import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { groupBrandsAZ } from '../../domain/brand';
import { PUBLIC_BRAND_LIMIT } from '../brands/brand-views';
import type { BrandReader } from '../ports/brand.reader';

export interface PublicBrandsAzEntry {
  readonly slug: string;
  readonly name: string;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
}

export interface PublicBrandsAzSection {
  /** `A` to `Z`, or `#` for a name that does not start with a letter of the Latin alphabet. */
  readonly letter: string;
  readonly brands: readonly PublicBrandsAzEntry[];
}

export interface PublicBrandsAzPage {
  readonly sections: readonly PublicBrandsAzSection[];
  /** True when the catalogue holds more brands than one answer lists. */
  readonly truncated: boolean;
}

export type PublicBrandsAzFailure = { readonly code: 'brand.unavailable' };

export interface PublicBrandsAzDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `public-brands.list-az` (catalog brand package, `/brands`): every ACTIVE brand, grouped by the
 * first letter of its name and sorted by name within a letter. Rule `anonymous`. Only the fields a
 * brand index shows are returned. At most {@link PUBLIC_BRAND_LIMIT} brands; `truncated` says when
 * there are more. One read-only unit.
 */
export class PublicBrandsAzQuery extends UseCase<
  Record<string, never>,
  PublicBrandsAzPage,
  PublicBrandsAzFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.public-brands-az',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublicBrandsAzDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PublicBrandsAzPage, PublicBrandsAzFailure>> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.brandReader.publicActive(market, PUBLIC_BRAND_LIMIT + 1)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'brand.unavailable' });
    const truncated = read.value.length > PUBLIC_BRAND_LIMIT;
    const sections = groupBrandsAZ(read.value.slice(0, PUBLIC_BRAND_LIMIT));
    return ok({
      sections: sections.map((section) => ({
        letter: section.letter,
        brands: section.brands.map(({ slug, name, logoImageId, logoAlt }) => ({
          slug,
          name,
          logoImageId,
          logoAlt,
        })),
      })),
      truncated,
    });
  }
}
