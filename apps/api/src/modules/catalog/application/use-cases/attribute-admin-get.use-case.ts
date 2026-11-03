import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import type {
  AttributeBounds,
  AttributeDisplaySettings,
  LocalizedText,
} from '../../domain/attribute-definition';
import {
  ATTRIBUTE_HISTORY_MAX,
  FEATURE_SET_LOAD_MAX,
  attributeIdOf,
  changesBetween,
  marketLocalesOf,
  summaryOf,
  usesOf,
  type AttributeChange,
  type AttributeSummaryView,
  type FeatureSetUse,
  type MarketLocales,
  type MarketUnit,
} from '../attributes/attribute-admin-views';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface AttributeAdminGetInput {
  readonly attributeId: unknown;
}

export interface AttributeOptionView {
  readonly code: string;
  readonly labels: LocalizedText;
  readonly active: boolean;
  readonly position: number;
  /** Products of the Market whose published revision holds this option. */
  readonly productCount: number;
}

export interface AttributeHistoryEntry {
  readonly revisionNo: number;
  readonly createdAt: string;
  /** `seed` or `admin`. */
  readonly authorKind: string;
  readonly authorAccountId: string | null;
  /** Empty for the first revision ("Created"). */
  readonly changes: readonly AttributeChange[];
}

export interface AttributeAdminGetOutput extends AttributeSummaryView {
  readonly createdByKind: string;
  readonly createdAt: string;
  readonly version: number;
  readonly bounds: AttributeBounds;
  /** Help text, page and search settings, the internal note (admin only) and the order. */
  readonly display: AttributeDisplaySettings;
  readonly options: readonly AttributeOptionView[];
  readonly productCount: number;
  readonly usedIn: readonly FeatureSetUse[];
  /** Newest first, at most {@link ATTRIBUTE_HISTORY_MAX}. */
  readonly history: readonly AttributeHistoryEntry[];
  /** True when older revisions exist than the history shows. */
  readonly historyTruncated: boolean;
  readonly locales: MarketLocales;
  /** The units the Market offers for a number-with-unit attribute (attributes A3). */
  readonly units: readonly MarketUnit[];
}

export type AttributeAdminGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'attribute.not-found' };

export interface AttributeAdminGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `attribute.admin-get` (attributes plan, package A1): one attribute of the request's Market with
 * its current revision, its values and the products that hold each, the feature sets and groups
 * that use it, and its revision history with the field-by-field changes (plan 15). A malformed id
 * is `attribute.not-found`, like an unknown one or one of another Market. Rule: the key
 * `catalog.attribute.view` and the admin population. One read-only unit.
 */
export class AttributeAdminGet extends UseCase<
  AttributeAdminGetInput,
  AttributeAdminGetOutput,
  AttributeAdminGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-admin-get',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('AttributeAdminGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeAdminGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeAdminGetInput,
  ): Promise<Result<AttributeAdminGetOutput, AttributeAdminGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-admin-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: AttributeAdminGetInput,
  ): Promise<Result<AttributeAdminGetOutput, AttributeAdminGetFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = attributeIdOf(input?.attributeId);
    if (id === null) return err({ code: 'attribute.not-found' });
    const { market } = context;
    const locales = marketLocalesOf(this.deps.policy.locales(market));
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const definition = await reader.definition(market, id);
        if (definition === null) return ok(null);
        const field = {
          code: definition.code,
          isVariantOption: definition.revision.isVariantOption,
          dataType: definition.dataType,
        };
        const [featureSets, revisions, counts, optionCounts] = [
          await reader.featureSets(market, FEATURE_SET_LOAD_MAX),
          // One more than shown: the oldest shown needs its predecessor for its changes.
          await reader.revisions(market, id, ATTRIBUTE_HISTORY_MAX + 1),
          await reader.productCounts(market, [field]),
          await reader.optionProductCounts(
            market,
            field,
            definition.revision.options.map((option) => option.code),
          ),
        ];
        return ok({ definition, featureSets, revisions, counts, optionCounts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'attribute.not-found' });
    const { definition, featureSets, revisions, counts, optionCounts } = read.value;
    const shown = revisions.slice(0, ATTRIBUTE_HISTORY_MAX);
    return ok({
      ...summaryOf(definition, locales),
      createdByKind: definition.createdByKind,
      createdAt: definition.createdAt.toString(),
      version: definition.version,
      bounds: { ...definition.revision.bounds },
      display: {
        ...definition.revision.display,
        helpText: { ...definition.revision.display.helpText },
      },
      options: [...definition.revision.options]
        .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code))
        .map((option) => ({
          code: option.code,
          labels: { ...option.labels },
          active: option.active,
          position: option.position,
          productCount: optionCounts.get(option.code) ?? 0,
        })),
      productCount: counts.get(definition.code) ?? 0,
      usedIn: usesOf(definition.code, featureSets),
      history: shown.map((revision, index) => {
        const previous = revisions[index + 1];
        return {
          revisionNo: revision.revisionNo,
          createdAt: revision.createdAt.toString(),
          authorKind: revision.authorKind,
          authorAccountId: revision.authorAccountId,
          changes: previous === undefined ? [] : changesBetween(previous, revision),
        };
      }),
      historyTruncated: revisions.length > ATTRIBUTE_HISTORY_MAX,
      locales,
      units: this.deps.policy.units(market).map((unit) => ({ ...unit })),
    });
  }
}
