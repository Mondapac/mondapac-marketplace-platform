import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import {
  MAX_CULTURE_IDS,
  type CatalogCultureSummary,
} from '../../contracts/catalog-cultures.facade';
import type { CultureState } from '../../domain/culture';
import type { CultureReader } from '../ports/culture.reader';

export const summaryOf = (row: CultureState): CatalogCultureSummary => ({
  id: row.id,
  code: row.code,
  status: row.status,
  requiredCertificationType: row.requiredCertificationType,
  isDefault: row.isDefault,
  names: Object.fromEntries(row.names.map((entry) => [entry.locale, entry.name])),
});

export interface CulturesByIdsInput {
  readonly cultureIds: readonly string[];
}

export interface CulturesByIdsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultureReader: CultureReader;
}

/**
 * `culturesByIds` (multi-culture package 2; ADR-0047 decision 3): the cultures of the Market among
 * the requested ids, for `sellers` to check a membership request and to show a membership. Rule
 * `anonymous`: ids in, a short summary out (code, status, required type, names). The request is
 * checked whole before any read. One read-only unit.
 */
export class CulturesByIdsQuery extends UseCase<
  CulturesByIdsInput,
  readonly CatalogCultureSummary[],
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.cultures-by-ids',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CulturesByIdsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CulturesByIdsInput,
  ): Promise<Result<readonly CatalogCultureSummary[], CatalogValidationFailed>> {
    if (!Array.isArray(input?.cultureIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'cultureIds', code: 'type' }] });
    }
    const requested = new Set<Id<'Culture'>>();
    for (const value of input.cultureIds as readonly unknown[]) {
      const id = typeof value === 'string' ? parseId<'Culture'>(value) : null;
      if (id === null || !id.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'cultureIds', code: 'format' }] });
      }
      requested.add(id.value);
    }
    if (requested.size > MAX_CULTURE_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'cultureIds', code: 'length' }] });
    }
    if (requested.size === 0) return ok([]);
    return this.deps.unitOfWork.run<readonly CatalogCultureSummary[], CatalogValidationFailed>(
      context.market,
      async () => {
        const rows = await this.deps.cultureReader.byIds(context.market, [...requested]);
        return ok(rows.map(summaryOf));
      },
      { readOnly: true },
    );
  }
}
