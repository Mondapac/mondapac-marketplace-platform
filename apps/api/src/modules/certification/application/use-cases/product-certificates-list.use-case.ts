import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import { PRODUCT_CERTIFICATION_STATUSES } from '../../domain/product-certification';
import type { ProductCertificationStatus } from '../../domain/validity';
import {
  adminOf,
  invalid,
  productFailure,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';
import { parseTypeId } from '../registry/registry.shared';

export const MAX_PRODUCT_CERTIFICATE_PAGE = 100;
const MAX_OFFSET = 10_000;

export interface ProductCertificatesListInput {
  readonly status?: unknown;
  readonly typeId?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface ProductCertificateListItem {
  readonly id: string;
  readonly typeId: string;
  readonly status: ProductCertificationStatus;
  readonly manufacturerName: string | null;
  readonly coverageEntries: number;
  readonly pendingRevisionId: string | null;
  readonly approvedRevisionId: string | null;
  readonly lastChangedAt: string;
  readonly version: number;
}

export interface ProductCertificatesListOutput {
  readonly items: readonly ProductCertificateListItem[];
  readonly limit: number;
  readonly offset: number;
}

export type ProductCertificatesListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

function wholeIn(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/**
 * `product-certificates.list` (certification design 3.4, 7.1; slice 14): a page of the Market's
 * manufacturer certificates, newest first, filtered by status and type. Clear fields only:
 * the draft's manufacturer name and the count of the draft's coverage entries, never
 * the number. Rule: key `certification.product-certificate.view`.
 */
export class ProductCertificatesList extends UseCase<
  ProductCertificatesListInput,
  ProductCertificatesListOutput,
  ProductCertificatesListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificates-list',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificatesListInput,
  ): Promise<Result<ProductCertificatesListOutput, ProductCertificatesListFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('query', 'type');
    let status: ProductCertificationStatus | null = null;
    if (input.status !== undefined) {
      if (!(PRODUCT_CERTIFICATION_STATUSES as readonly unknown[]).includes(input.status)) {
        return invalid('status', 'unknown');
      }
      status = input.status as ProductCertificationStatus;
    }
    let typeId = null;
    if (input.typeId !== undefined) {
      typeId = parseTypeId(input.typeId);
      if (typeId === null) return invalid('typeId', 'format');
    }
    const limit = wholeIn(input.limit, 50, 1, MAX_PRODUCT_CERTIFICATE_PAGE);
    if (limit === null) return invalid('limit', 'format');
    const offset = wholeIn(input.offset, 0, 0, MAX_OFFSET);
    if (offset === null) return invalid('offset', 'format');
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(
        market,
        async () => ok(await deps.products.list(market, { status, typeId, limit, offset })),
        { readOnly: true },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificates-list', error),
      );
    if (!read.ok) return read;
    return ok({
      items: read.value.map((row) => ({
        id: row.id,
        typeId: row.typeId,
        status: row.status,
        manufacturerName: row.manufacturerName,
        coverageEntries: row.coverageEntries,
        pendingRevisionId: row.pendingRevisionId,
        approvedRevisionId: row.approvedRevisionId,
        lastChangedAt: row.lastChangedAt.toString(),
        version: row.version,
      })),
      limit,
      offset,
    });
  }
}
