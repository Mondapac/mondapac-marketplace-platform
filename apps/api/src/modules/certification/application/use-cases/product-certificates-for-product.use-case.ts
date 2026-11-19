import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type { ProductCertificationStatus } from '../../domain/validity';
import type {
  ProductCertificateForProductRow,
  ProductCertificationRepository,
  ProductCoverageSource,
} from '../ports/product-certification.repository';
import {
  adminOf,
  invalid,
  productFailure,
  type ValidationFailure,
} from '../product/product-certification.shared';

/** The most certificates one answer holds. */
export const MAX_CERTIFICATES_FOR_PRODUCT = 100;

/** The ports the lookup uses; `marketLocales` is null when the Market's locales are unknown. */
export interface ProductCertificatesForProductDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductCertificationRepository;
  /** The locales the Market publishes in; null fails closed (the Market is not hosted here). */
  readonly marketLocales: (market: MarketContext) => readonly string[] | null;
}

export interface ProductCertificatesForProductInput {
  readonly productId?: unknown;
}

export interface ProductCertificateForProductItem {
  readonly id: string;
  readonly typeId: string;
  readonly typeCode: string;
  /** The English name of the type's published revision; null when it has none. */
  readonly typeName: string | null;
  /** The Market's locales for which the published revision has no name. */
  readonly typeNamesMissing: readonly string[];
  readonly status: ProductCertificationStatus;
  readonly issuerName: string | null;
  /** YYYY-MM-DD, or null. */
  readonly expiryDate: string | null;
  /** The coverage of this product: the whole product, or the named variants. */
  readonly coverage: { readonly whole: boolean; readonly variantIds: readonly string[] };
  readonly rejectionReasonCode: string | null;
  readonly lastChangedAt: string;
  readonly version: number;
}

export interface ProductCertificatesForProductOutput {
  readonly items: readonly ProductCertificateForProductItem[];
}

export type ProductCertificatesForProductFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * The English name of a type: the locale `en`, else the first `en-*` locale in code order (a Market
 * names its locales with a region, for example `en-AU`); null when the type has none.
 */
export function englishNameOf(names: Readonly<Record<string, string>>): string | null {
  const exact = names['en'];
  if (exact !== undefined) return exact;
  const regional = Object.keys(names)
    .filter((locale) => locale.toLowerCase().startsWith('en-'))
    .sort()[0];
  return regional === undefined ? null : (names[regional] ?? null);
}

/**
 * The source that speaks for the product: the approved revision, else the pending one, else the
 * draft, each only when its coverage names the product. Issuer, expiry and coverage all come from
 * this one source.
 */
function sourceOf(row: ProductCertificateForProductRow): ProductCoverageSource | null {
  return row.approved ?? row.pending ?? row.draft;
}

function itemOf(
  row: ProductCertificateForProductRow,
  locales: readonly string[],
): ProductCertificateForProductItem {
  const source = sourceOf(row);
  const entries = source?.variantIds ?? [];
  const named = new Set(Object.keys(row.typeNames));
  return {
    id: row.id,
    typeId: row.typeId,
    typeCode: row.typeCode,
    typeName: englishNameOf(row.typeNames),
    typeNamesMissing: locales.filter((locale) => !named.has(locale)),
    status: row.status,
    issuerName: source?.issuerName ?? null,
    expiryDate: source?.expiryDate?.toString() ?? null,
    coverage: {
      // A whole-product entry covers every variant, whatever variants are also named.
      whole: entries.some((variantId) => variantId === null),
      variantIds: entries.flatMap((variantId) => (variantId === null ? [] : [variantId])),
    },
    rejectionReasonCode: row.rejectionReasonCode,
    lastChangedAt: row.lastChangedAt.toString(),
    version: row.version,
  };
}

/**
 * `product-certificates.for-product` (certification design 3.4, 7.1): the Market's manufacturer
 * certificates whose draft, pending revision or approved revision names the product, newest
 * first, at most 100. Clear fields only: never the certificate number or its ciphertext, never a
 * document. Rule: key `certification.product-certificate.view`.
 */
export class ProductCertificatesForProduct extends UseCase<
  ProductCertificatesForProductInput,
  ProductCertificatesForProductOutput,
  ProductCertificatesForProductFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificates-for-product',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificatesForProductDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificatesForProductInput,
  ): Promise<Result<ProductCertificatesForProductOutput, ProductCertificatesForProductFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('query', 'type');
    const parsed = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (parsed === null || !parsed.ok) return invalid('productId', 'format');
    const productId: Id<'Product'> = parsed.value;
    const { deps } = this;
    const { market } = context;
    const locales = deps.marketLocales(market);
    if (locales === null) return err({ code: 'access.unavailable' });
    const read = await deps.unitOfWork
      .run(
        market,
        async () =>
          ok(await deps.products.forProduct(market, productId, MAX_CERTIFICATES_FOR_PRODUCT)),
        { readOnly: true },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificates-for-product', error),
      );
    if (!read.ok) return read;
    return ok({ items: read.value.map((row) => itemOf(row, locales)) });
  }
}
