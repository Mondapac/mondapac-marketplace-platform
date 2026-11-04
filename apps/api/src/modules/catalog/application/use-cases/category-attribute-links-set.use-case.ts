import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { CategoryAttributesChangedAudit } from '../../domain/audit';
import { CategoryAttributeLink } from '../../domain/category-attribute-link';
import type { CategoryAttributeLinkRefusal } from '../../domain/category-attribute-link';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import {
  closedInput,
  editorAccountOf,
  invalid,
  type AttributeWriteFailure,
} from '../attributes/attribute-editor';
import {
  categoryIdOf,
  checkFilters,
  parseCategoryLinks,
  type FilterRefusal,
} from '../attributes/category-links';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CategoryAttributeLinkStore } from '../ports/category-attribute-link.store';

export interface CategoryAttributeLinksSetInput {
  readonly [key: string]: unknown;
}

export interface CategoryAttributeLinksSetOutput {
  readonly categoryId: string;
  readonly featureSetId: string | null;
  readonly filters: readonly string[];
  readonly revisionNo: number;
  readonly version: number;
}

export type CategoryAttributeLinksSetFailure =
  | AttributeWriteFailure
  | FilterRefusal
  | { readonly code: 'category.not-found' }
  | { readonly code: 'category.not-active' }
  | { readonly code: 'category-links.feature-set-unknown' }
  | { readonly code: 'category-links.feature-set-not-active' }
  | { readonly code: 'category-links.stale' }
  | {
      readonly code: CategoryAttributeLinkRefusal['code'];
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface CategoryAttributeLinksSetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const KEYS = ['categoryId', 'version', 'featureSetId', 'filters'] as const;

const shapeOf = (link: CategoryAttributeLink | null) => ({
  revisionNo: link?.state.revisionNo ?? 0,
  hasFeatureSet: link?.state.familyId != null,
  filterCount: link?.state.filters.length ?? 0,
});

/**
 * `category-attribute-links.set` (attributes package A4; categories C8): an admin sets the
 * feature set a platform category holds (null: it takes its parent's) and the ordered list of
 * attributes buyers may filter it by. Rule: the key `catalog.attribute.edit` (protected), the
 * admin population, never an acting-as session. The category must be active and the feature set
 * active; every filter must be an active definition that is allowed as a filter and has a
 * filterable type. The request names the version the admin saw (omitted when the category has no
 * link yet): a later one is `category-links.stale`. A change is a new insert-only revision.
 */
export class CategoryAttributeLinksSet extends UseCase<
  CategoryAttributeLinksSetInput,
  CategoryAttributeLinksSetOutput,
  CategoryAttributeLinksSetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-attribute-links-set',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryAttributeLinksSet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryAttributeLinksSetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryAttributeLinksSetInput,
  ): Promise<Result<CategoryAttributeLinksSetOutput, CategoryAttributeLinksSetFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.category-attribute-links-set',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: CategoryAttributeLinksSetInput,
  ): Promise<Result<CategoryAttributeLinksSetOutput, CategoryAttributeLinksSetFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const categoryId = categoryIdOf(body.value['categoryId']);
    if (categoryId === null) return err({ code: 'category.not-found' });
    const rawVersion = body.value['version'];
    let version: number | null = null;
    if (rawVersion !== undefined && rawVersion !== null) {
      if (
        typeof rawVersion !== 'number' ||
        !Number.isInteger(rawVersion) ||
        rawVersion < 1 ||
        rawVersion > 2_147_483_647
      ) {
        return invalid('version', 'type');
      }
      version = rawVersion;
    }
    const parsed = parseCategoryLinks(body.value);
    if (!parsed.ok) return parsed;
    const { market } = context;
    const { linkStore } = this.deps;
    try {
      return await this.deps.unitOfWork.run<
        CategoryAttributeLinksSetOutput,
        CategoryAttributeLinksSetFailure
      >(market, async () => {
        const status = await linkStore.categoryStatus(market, categoryId);
        if (status === null) return err({ code: 'category.not-found' } as const);
        if (status !== 'active') return err({ code: 'category.not-active' } as const);
        if (parsed.value.familyId !== null) {
          const set = await this.deps.attributeAdminReader.featureSet(
            market,
            parsed.value.familyId,
          );
          if (set === null) return err({ code: 'category-links.feature-set-unknown' } as const);
          if (set.status !== 'active')
            return err({ code: 'category-links.feature-set-not-active' } as const);
        }
        const definitions = new Map(
          (await this.deps.attributeAdminReader.definitions(market, ATTRIBUTE_LOAD_MAX)).map(
            (definition) => [definition.code, definition] as const,
          ),
        );
        const refused = checkFilters(parsed.value.filters, definitions);
        if (refused !== null) return err(refused);
        const existing = await linkStore.find(market, categoryId);
        if ((existing?.state.version ?? null) !== version) {
          return err({ code: 'category-links.stale' } as const);
        }
        const now = this.deps.clock.now();
        const revisionId = this.deps.ids.next<'CategoryAttributeLinkRevision'>();
        const next =
          existing === null
            ? CategoryAttributeLink.create({
                marketId: market.marketId,
                categoryId,
                revisionId,
                familyId: parsed.value.familyId,
                filters: parsed.value.filters,
                now,
              })
            : existing.revise({
                revisionId,
                familyId: parsed.value.familyId,
                filters: parsed.value.filters,
                now,
              });
        if (!next.ok) {
          const index = 'index' in next.error ? next.error.index : 0;
          return err({
            code: next.error.code,
            fields: [{ path: `filters[${index}]`, code: 'invalid' }],
          });
        }
        if (existing === null) await linkStore.add(market, next.value, accountId);
        else await linkStore.saveRevision(market, next.value, accountId);
        await this.deps.audit.record(
          context,
          CategoryAttributesChangedAudit.entry(categoryId, {
            before: shapeOf(existing),
            after: shapeOf(next.value),
          }),
        );
        const { state } = next.value;
        return ok({
          categoryId: state.categoryId,
          featureSetId: state.familyId,
          filters: state.filters,
          revisionNo: state.revisionNo,
          version: state.version,
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'category-links.stale' });
      throw error;
    }
  }
}
