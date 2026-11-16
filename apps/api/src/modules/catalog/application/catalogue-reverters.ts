import type { CallContext, Clock, Id, IdGenerator } from '@mondapac/shared-kernel';
import { parseId } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { AttributeDefinitionRevertedAudit, CategoryAttributesRevertedAudit } from '../domain/audit';
import type { AttributeOption } from '../domain/attribute-definition';
import { MAX_TREE_NODES } from '../domain/category-tree';
import { ATTRIBUTE_LOAD_MAX } from './attributes/attribute-admin-views';
import { attributeIdOf, auditShapeOf, editorAccountOf } from './attributes/attribute-editor';
import { cancelOpenRelaxation } from './attributes/attribute-relaxation';
import { categoryIdOf as linkCategoryIdOf, checkFilters } from './attributes/category-links';
import { categoryIdOf, editorAccountOf as categoryEditorOf } from './categories/category-editor';
import { editDetailsInUnit } from './categories/category-write-core';
import {
  categoryDetailsOf,
  categoryDetailsValues,
  linksOf,
  linksValues,
  sameContent,
} from './catalogue-review';
import type { AttributeAdminReader } from './ports/attribute-admin.reader';
import type { AttributeDefinitionStore } from './ports/attribute-definition.store';
import type { AttributeRelaxationStore } from './ports/attribute-relaxation.store';
import type { CategoryAttributeLinkStore } from './ports/category-attribute-link.store';
import type { CategoryEditStore } from './ports/category-edit.store';
import type { PlatformCategoryRepository } from './ports/platform-category.repository';
import { linkAuditShape } from './use-cases/category-attribute-links-set.use-case';

// The reverters of area catalogue (see catalogue-review.ts): each restores the value before a
// rejected or withdrawn edit, in the open unit of that decision, as one more revision through the
// same domain path as an edit, and only while the subject still holds the value after the edit.
// A revert opens no review. It does not run the claim-text check again: it puts back text the
// check already passed when it was saved.

export interface CatalogueRevertDependencies {
  readonly store: CategoryEditStore;
  readonly categories: PlatformCategoryRepository;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly attributeStore: AttributeDefinitionStore;
  readonly relaxations: AttributeRelaxationStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A signed-in admin session, not acting as someone else (a revert is the decider's own act). */
function reverterOf(context: CallContext): Id<'Account'> {
  const account = categoryEditorOf(context);
  if (account === null) {
    throw new Error('catalog: a revert needs a signed-in admin acting as themselves');
  }
  return account;
}

/**
 * `catalog.category-details`: the names, descriptions, keywords, search-result fields and menu
 * flag of a platform category. Written back as a new revision with the same checks an admin's
 * save has (the category must be active or hidden, no sibling may hold a restored name). The
 * category image, slug, place in the tree and status are not part of an edit and are untouched.
 */
export class CategoryDetailsReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueRevertDependencies) {}

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const adminId = reverterOf(context);
    const id = categoryIdOf(request.subjectRef);
    const restore = categoryDetailsOf(request.before);
    if (!id.ok || restore === null || categoryDetailsOf(request.after) === null) return 'gone';
    const { market } = context;
    const nodes = await this.deps.store.loadAll(market, MAX_TREE_NODES + 1);
    if (nodes.length > MAX_TREE_NODES) throw new Error('catalog: the category tree is too large');
    const target = nodes.find((node) => node.id === id.value);
    if (target === undefined) return 'gone';
    const current = categoryDetailsValues(target.texts, target.seo, target.showInMenu);
    if (!sameContent(current, request.after)) return 'changed-since';
    const treeVersion = (await this.deps.categories.treeVersion(market)).version;
    try {
      const restored = await editDetailsInUnit(
        this.deps,
        context,
        adminId,
        nodes,
        id.value,
        { ...restore, version: null, revertedBy: request.requestId },
        treeVersion,
      );
      // A refusal (the category left active/hidden, a sibling took a restored name) is a change
      // since the edit: nothing was written.
      return restored.ok ? 'reverted' : 'changed-since';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/**
 * `catalog.attribute-definition`: the content of an attribute definition. The revision before the
 * edit (named in the request) is written back as the next revision. A value the edit added cannot
 * be removed (a value is never removed, so nothing that uses it breaks): it stays in the list,
 * switched off. An open two-person request to clear `material` that names the version this
 * replaces is cancelled, as an edit cancels it.
 */
export class AttributeDefinitionReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueRevertDependencies) {}

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const adminId = editorAccountOf(context);
    if (adminId === null) {
      throw new Error('catalog: a revert needs a signed-in admin acting as themselves');
    }
    const id = attributeIdOf(request.subjectRef);
    const restoreNo = request.before['revisionNo'];
    const expectedVersion = request.after['version'];
    if (id === null || typeof restoreNo !== 'number' || typeof expectedVersion !== 'number') {
      return 'gone';
    }
    const { market } = context;
    const found = await this.deps.attributeStore.findById(market, id);
    if (found === null) return 'gone';
    if (found.state.version !== expectedVersion) return 'changed-since';
    const revisions = await this.deps.attributeAdminReader.revisions(market, id, 200);
    const old = revisions.find((revision) => revision.revisionNo === restoreNo);
    if (old === undefined) return 'changed-since';

    const wasCodes = new Set(old.options.map((option) => option.code));
    const top = old.options.reduce((most, option) => Math.max(most, option.position), -1);
    const kept: AttributeOption[] = old.options.map((option) => ({
      code: option.code,
      labels: option.labels,
      active: option.active,
      position: option.position,
    }));
    found.state.options
      .filter((option) => !wasCodes.has(option.code))
      .forEach((option, index) =>
        kept.push({
          code: option.code,
          labels: option.labels,
          active: false,
          position: top + 1 + index,
        }),
      );
    const next = found.revise({
      revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
      names: old.names,
      material: old.material,
      isVariantOption: old.isVariantOption,
      bounds: old.bounds,
      options: kept,
      display: old.display,
      now: this.deps.clock.now(),
    });
    if (!next.ok) return 'changed-since';
    try {
      await this.deps.attributeStore.saveRevision(market, next.value, adminId);
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
    await this.deps.audit.record(
      context,
      AttributeDefinitionRevertedAudit.entry(id, {
        before: auditShapeOf(found),
        after: { ...auditShapeOf(next.value), requestId: request.requestId },
      }),
    );
    await cancelOpenRelaxation(this.deps, context, market, id);
    return 'reverted';
  }
}

/**
 * `catalog.category-attribute-links`: the feature set a platform category holds and the filters
 * buyers may use on it. Written back as the next revision of its links, only while the category is
 * active, the feature set is still active and every filter is still an active attribute that may
 * be a filter (the checks an admin's save has).
 */
export class CategoryLinksReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueRevertDependencies) {}

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const adminId = reverterOf(context);
    const categoryId = linkCategoryIdOf(request.subjectRef);
    const restore = linksOf(request.before);
    if (categoryId === null || restore === null || linksOf(request.after) === null) return 'gone';
    const { market } = context;
    const { linkStore } = this.deps;
    const status = await linkStore.categoryStatus(market, categoryId);
    if (status === null) return 'gone';
    const existing = await linkStore.find(market, categoryId);
    if (existing === null) return 'gone';
    const current = linksValues({
      featureSetId: existing.state.familyId,
      filters: existing.state.filters,
    });
    if (!sameContent(current, request.after)) return 'changed-since';
    if (status !== 'active') return 'changed-since';

    let familyId: Id<'AttributeFamily'> | null = null;
    if (restore.featureSetId !== null) {
      const parsed = parseId<'AttributeFamily'>(restore.featureSetId);
      if (!parsed.ok) return 'gone';
      const set = await this.deps.attributeAdminReader.featureSet(market, parsed.value);
      if (set === null) return 'gone';
      if (set.status !== 'active') return 'changed-since';
      familyId = parsed.value;
    }
    const definitions = new Map(
      (await this.deps.attributeAdminReader.definitions(market, ATTRIBUTE_LOAD_MAX)).map(
        (definition) => [definition.code, definition] as const,
      ),
    );
    if (checkFilters(restore.filters, definitions) !== null) return 'changed-since';

    const next = existing.revise({
      revisionId: this.deps.ids.next<'CategoryAttributeLinkRevision'>(),
      familyId,
      filters: restore.filters,
      now: this.deps.clock.now(),
    });
    if (!next.ok) return 'changed-since';
    try {
      await linkStore.saveRevision(market, next.value, adminId);
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
    await this.deps.audit.record(
      context,
      CategoryAttributesRevertedAudit.entry(categoryId, {
        before: linkAuditShape(existing),
        after: { ...linkAuditShape(next.value), requestId: request.requestId },
      }),
    );
    return 'reverted';
  }
}
