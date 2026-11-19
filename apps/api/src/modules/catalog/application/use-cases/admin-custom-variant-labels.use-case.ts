import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  CustomVariantLabelRow,
  CustomVariantLabelsReader,
} from '../ports/custom-variant-labels.reader';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

export const DEFAULT_CUSTOM_LABELS_LIMIT = 50;
export const MAX_CUSTOM_LABELS_LIMIT = 100;

export interface AdminCustomVariantLabelsInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface AdminCustomVariantLabelsOutput {
  readonly items: readonly CustomVariantLabelRow[];
  /** Pass as `afterId` for the next page; null at the end. */
  readonly nextAfterId: string | null;
}

export type AdminCustomVariantLabelsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface AdminCustomVariantLabelsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly customVariantLabelsReader: CustomVariantLabelsReader;
  readonly policy: CatalogMarketPolicy;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `admin-custom-variant-labels.list` (variants V2, migration report): the variants of published
 * revisions whose stored label is not the automatic one (free labels typed before V2), per locale,
 * for the admin to see what the next revision of each will change. Read-only; existing revisions
 * are never rewritten. Rule: the key `catalog.product.view` and the admin population; the Market
 * comes from the context. One read-only unit (ADR-0025). Closed query: `afterId` and `limit`.
 */
export class AdminCustomVariantLabels extends UseCase<
  AdminCustomVariantLabelsInput,
  AdminCustomVariantLabelsOutput,
  AdminCustomVariantLabelsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-custom-variant-labels',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCustomVariantLabelsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminCustomVariantLabelsInput,
  ): Promise<Result<AdminCustomVariantLabelsOutput, AdminCustomVariantLabelsFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'afterId' && key !== 'limit') return invalid(key, 'unknown');
    }
    const empty = (value: unknown) => value === undefined || value === null || value === '';
    let afterId: string | null = null;
    if (!empty(input.afterId)) {
      if (typeof input.afterId !== 'string' || !UUID.test(input.afterId)) {
        return invalid('afterId', 'format');
      }
      afterId = input.afterId.toLowerCase();
    }
    let limit = DEFAULT_CUSTOM_LABELS_LIMIT;
    if (!empty(input.limit)) {
      const value = input.limit;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_CUSTOM_LABELS_LIMIT
      ) {
        return invalid('limit', 'range');
      }
      limit = value;
    }
    let locales: readonly string[];
    try {
      locales = this.deps.policy.locales(market).supported;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(await this.deps.customVariantLabelsReader.page(market, { afterId, limit, locales })),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ items: read.value.rows, nextAfterId: read.value.nextAfterId });
  }
}
