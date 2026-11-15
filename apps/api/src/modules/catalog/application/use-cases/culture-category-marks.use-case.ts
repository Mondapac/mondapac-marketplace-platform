import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CULTURE_READ } from '../../contracts/permissions';
import { liveTreeOf } from '../cultures/culture-references';
import { markViewsOf, type CultureCategoryMarkView } from '../cultures/culture-mark-views';
import { adminAccountOf, cultureIdOf } from '../cultures/culture-views';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { CultureRepository } from '../ports/culture.repository';

// The category marks of a culture (multi-culture package 1; ADR-0047 decisions 4 and 5): list the
// effective marks of every live category, set a row (visible, certification mark) and clear it.
// The visibility rule (package 3a, `culture-visibility`) reads them; a write announces
// `catalog.culture-category-mark-changed.v1` so search re-indexes the category's subtree.

type Denied = { readonly code: 'access.denied' };
type Unavailable = { readonly code: 'access.unavailable' };
type CultureNotFound = { readonly code: 'culture.not-found' };

export interface CultureMarkDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultures: CultureRepository;
  readonly treeReader: CategoryTreeReader;
  readonly policy: CatalogMarketPolicy;
}

export interface CultureMarkWriteDependencies extends CultureMarkDependencies {
  readonly audit: AuditWriter;
  readonly clock: Clock;
  /** `catalog.culture-category-mark-changed.v1` (package 3a): search re-indexes the subtree. */
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
}

export interface CultureCategoryMarksInput {
  readonly cultureId?: unknown;
}
export interface CultureCategoryMarksOutput {
  readonly cultureId: string;
  readonly requiredCertificationType: string | null;
  readonly items: readonly CultureCategoryMarkView[];
}

/**
 * `culture.category-marks` (multi-culture package 1): the effective visibility and certification
 * mark of every live category for one culture, with the culture's own row and where each value comes
 * from. Rule: the key `catalog.culture.read` and the admin population. One read-only unit.
 */
export class CultureCategoryMarks extends UseCase<
  CultureCategoryMarksInput,
  CultureCategoryMarksOutput,
  Denied | Unavailable | CultureNotFound
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-category-marks',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_READ.key] },
  };

  readonly #logger = new Logger('CultureCategoryMarks');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureMarkDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureCategoryMarksInput,
  ): Promise<Result<CultureCategoryMarksOutput, Denied | Unavailable | CultureNotFound>> {
    const result = await this.#read(context, input);
    this.#logger.log({
      msg: 'catalog.culture-category-marks',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #read(
    context: CallContext,
    input: CultureCategoryMarksInput,
  ): Promise<Result<CultureCategoryMarksOutput, Denied | Unavailable | CultureNotFound>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const id = cultureIdOf(input.cultureId, 'cultureId');
    if (!id.ok) return err({ code: 'culture.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run<
      CultureCategoryMarksOutput,
      Unavailable | CultureNotFound
    >(
      market,
      async () => {
        const culture = await this.deps.cultures.findById(market, id.value);
        if (culture === null) return err({ code: 'culture.not-found' } as const);
        const live = await liveTreeOf(market, this.deps);
        if (!live.ok) return live;
        const rows = await this.deps.cultures.categoryRows(market, id.value);
        return ok({
          cultureId: culture.id,
          requiredCertificationType: culture.requiredCertificationType,
          items: markViewsOf(live.value, rows),
        });
      },
      { readOnly: true },
    );
    return read.ok
      ? read
      : err(read.error.code === 'culture.not-found' ? read.error : { code: 'access.unavailable' });
  }
}
