import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogValidationFailed, PublishedProduct } from '../../contracts/catalog.facade';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { PublishedProductReader } from '../ports/published-product.reader';

export interface PublishedProductInput {
  readonly productId: string;
  readonly locale: string;
}

export interface PublishedProductDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publishedProductReader: PublishedProductReader;
  readonly policy: CatalogMarketPolicy;
}

/** A BCP 47 tag's shape, as the locales of Market configuration are written. */
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * `publishedProduct`: the published content of one product for the buyer's product page. Rule
 * `anonymous`: published names, descriptions, categories and Variant labels are public content,
 * and the answer carries no price, stock, Cost, tag or seller data. The request is checked whole
 * before any read; one read-only unit answers (ADR-0025). The Market comes from the context only;
 * an unknown id, another Market's id and a product that is not published are all `null`.
 * Seller-entered text: callers escape it.
 */
export class PublishedProductQuery extends UseCase<
  PublishedProductInput,
  PublishedProduct | null,
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.published-product',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedProductDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedProductInput,
  ): Promise<Result<PublishedProduct | null, CatalogValidationFailed>> {
    const fields: { path: string; code: string }[] = [];
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) fields.push({ path: 'productId', code: 'format' });
    if (typeof input.locale !== 'string' || !LOCALE.test(input.locale)) {
      fields.push({ path: 'locale', code: 'format' });
    }
    if (fields.length > 0 || product === null || !product.ok) {
      return err({ code: 'validation.failed', fields });
    }
    // A Market without catalog configuration fails boot (market-config check), so this answers.
    const fallback = this.deps.policy.locales(context.market).default;
    return this.deps.unitOfWork.run<PublishedProduct | null, CatalogValidationFailed>(
      context.market,
      async () =>
        ok(
          await this.deps.publishedProductReader.read(context.market, product.value, {
            requested: input.locale,
            fallback,
          }),
        ),
      { readOnly: true },
    );
  }
}
