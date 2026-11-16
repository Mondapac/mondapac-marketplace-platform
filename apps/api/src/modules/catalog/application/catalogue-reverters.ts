import type { CallContext, Clock, Id, IdGenerator } from '@mondapac/shared-kernel';
import { ok, parseId } from '@mondapac/shared-kernel';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { AttributeDefinitionRevertedAudit, CategoryAttributesRevertedAudit } from '../domain/audit';
import { publishableRefusal, type AttributeOption } from '../domain/attribute-definition';
import {
  blockedCategoryFields,
  parseCategorySeo,
  parseCategoryTexts,
} from '../domain/category-edit';
import type { ContentFilter } from '../../../platform/content-filter/content-filter';
import { MAX_TREE_NODES } from '../domain/category-tree';
import { ATTRIBUTE_LOAD_MAX } from './attributes/attribute-admin-views';
import {
  attributeIdOf,
  auditShapeOf,
  editorAccountOf,
  localizedOf,
  marketUnitsRefusal,
  refuseClaimContent,
} from './attributes/attribute-editor';
import { cancelOpenRelaxation } from './attributes/attribute-relaxation';
import { categoryIdOf as linkCategoryIdOf, checkFilters } from './attributes/category-links';
import {
  categoryIdOf,
  checkedPlaces,
  editorAccountOf as categoryEditorOf,
  refuseClaimTexts,
  requiredCategoryLocales,
} from './categories/category-editor';
import { editDetailsInUnit } from './categories/category-write-core';
import {
  categoryDetailsOf,
  categoryDetailsValues,
  linksOf,
  linksValues,
  sameContent,
} from './catalogue-review';
import type { CatalogMarketPolicy } from './ports/catalog-market-policy';
import type { ClaimTermLocales } from './ports/claim-term-locales';
import type { ClaimTextMatcher } from './ports/claim-text-matcher';
import type { AttributeAdminReader } from './ports/attribute-admin.reader';
import type { AttributeDefinitionStore } from './ports/attribute-definition.store';
import type { AttributeRelaxationStore } from './ports/attribute-relaxation.store';
import type { CategoryAttributeLinkStore } from './ports/category-attribute-link.store';
import type { CategoryEditStore } from './ports/category-edit.store';
import type { PlatformCategoryRepository } from './ports/platform-category.repository';
import { AttributeDefinitionEdit } from './use-cases/attribute-definition-edit.use-case';
import { CategoryEditDetails } from './use-cases/category-edit-details.use-case';
import {
  CategoryAttributeLinksSet,
  linkAuditShape,
} from './use-cases/category-attribute-links-set.use-case';

// The reverters of area catalogue (see catalogue-review.ts): each restores the value before a
// rejected or withdrawn edit, in the open unit of that decision, as one more revision through the
// same domain path as an edit, and only while the subject still holds the value after the edit.
// A revert opens no review. It runs the checks an edit has again, because the rules change over
// time and a value that passed when it was saved may not pass now (a claim word added to the
// vocabulary since, a locale no longer supported): the pure ones in the unit, the ones that read
// other modules (the claim vocabulary, the decider's key) in `check`, which System requests calls
// before the unit opens. Any refusal, and a check that cannot be answered, is `not-permitted`
// (fail closed) with nothing written; the request stays open. Reverts read at most the newest 200
// revisions of an attribute: an older one is `changed-since`. A revert that would clear `material`
// on a published attribute is refused by the domain (`changed-since`): that needs the two-person
// request.

export interface CatalogueRevertDependencies {
  readonly store: CategoryEditStore;
  readonly categories: PlatformCategoryRepository;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly attributeStore: AttributeDefinitionStore;
  readonly relaxations: AttributeRelaxationStore;
  readonly unitOfWork: UnitOfWork;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly contentFilter: ContentFilter;
  readonly authorisation: AuthorisationCheck;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** How many of the newest revisions of an attribute a revert reads to find the one before. */
const REVISIONS_READ = 200;

type RevisionRead = Awaited<ReturnType<AttributeAdminReader['revisions']>>[number];

/**
 * The content a revert writes: the revision before the edit, with the values the edit added kept
 * (a value is never removed) and switched off, after the ones the revision had.
 */
function restoredContent(currentOptions: readonly AttributeOption[], old: RevisionRead) {
  const wasCodes = new Set(old.options.map((option) => option.code));
  const top = old.options.reduce((most, option) => Math.max(most, option.position), -1);
  const kept: AttributeOption[] = old.options.map((option) => ({
    code: option.code,
    labels: option.labels,
    active: option.active,
    position: option.position,
  }));
  currentOptions
    .filter((option) => !wasCodes.has(option.code))
    .forEach((option, index) =>
      kept.push({
        code: option.code,
        labels: option.labels,
        active: false,
        position: top + 1 + index,
      }),
    );
  return {
    names: old.names,
    material: old.material,
    isVariantOption: old.isVariantOption,
    bounds: old.bounds,
    options: kept,
    display: old.display,
  };
}

/** A signed-in admin session, not acting as someone else (a revert is the decider's own act). */
function reverterOf(context: CallContext): Id<'Account'> {
  const account = categoryEditorOf(context);
  if (account === null) {
    throw new Error('catalog: a revert needs a signed-in admin acting as themselves');
  }
  return account;
}

/** Whether the decider holds the key the edit of this subject needs (the edit's own rule). */
async function mayEdit(
  deps: CatalogueRevertDependencies,
  context: CallContext,
  access: AccessDeclaration,
): Promise<boolean> {
  try {
    return (await deps.authorisation.check(context, access)).allowed;
  } catch {
    return false;
  }
}

/**
 * `catalog.category-details`: the names, descriptions, keywords, search-result fields and menu
 * flag of a platform category. Written back as a new revision with the same checks an admin's
 * save has (the category must be active or hidden, no sibling may hold a restored name). The
 * category image, slug, place in the tree and status are not part of an edit and are untouched.
 */
export class CategoryDetailsReverter implements SystemChangeReverter {
  constructor(private readonly deps: CatalogueRevertDependencies) {}

  /** Before the unit: the decider's key, the edit's own text checks and the claim-text check. */
  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    if (!(await mayEdit(this.deps, context, CategoryEditDetails.access))) return 'not-permitted';
    const restore = categoryDetailsOf(request.before);
    if (restore === null) return 'ok'; // the revert answers `gone`
    const { market } = context;
    const { policy, contentFilter } = this.deps;
    let locales: { readonly supported: readonly string[] };
    let required: readonly string[];
    try {
      locales = policy.locales(market);
      required = requiredCategoryLocales(market, policy);
    } catch {
      return 'not-permitted';
    }
    const raw = Object.fromEntries(
      restore.texts.map((text) => [
        text.locale,
        { name: text.name, shortDescription: text.shortDescription, keywords: text.keywords },
      ]),
    );
    const texts = parseCategoryTexts(raw, { supported: locales.supported, required });
    if (!texts.ok) return 'not-permitted';
    const seo = parseCategorySeo(restore.seo);
    if (!seo.ok) return 'not-permitted';
    try {
      const blocked = blockedCategoryFields(texts.value, seo.value, (text) =>
        contentFilter.isBlocked(market, text),
      );
      if (!blocked.ok) return 'not-permitted';
    } catch {
      return 'not-permitted';
    }
    try {
      const claim = await refuseClaimTexts(
        this.deps,
        context,
        checkedPlaces({ texts: texts.value, seo: seo.value }),
      );
      return claim === null ? 'ok' : 'not-permitted';
    } catch {
      return 'not-permitted';
    }
  }

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

  /**
   * Before the unit: the decider's key, then the checks an edit has on the content the revert
   * would write (every name, help text and value label, the switched-off ones the revert keeps
   * included, goes through the claim-text check; the units the Market offers; the publish rules).
   */
  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    if (editorAccountOf(context) === null) return 'not-permitted';
    if (!(await mayEdit(this.deps, context, AttributeDefinitionEdit.access)))
      return 'not-permitted';
    const id = attributeIdOf(request.subjectRef);
    const restoreNo = request.before['revisionNo'];
    if (id === null || typeof restoreNo !== 'number') return 'ok'; // the revert answers `gone`
    const { market } = context;
    let content: ReturnType<typeof restoredContent>;
    let publishRefused: boolean;
    try {
      const read = await this.deps.unitOfWork.run<
        {
          found: NonNullable<Awaited<ReturnType<AttributeDefinitionStore['findById']>>>;
          old: Awaited<ReturnType<AttributeAdminReader['revisions']>>[number];
        } | null,
        never
      >(
        market,
        async () => {
          const found = await this.deps.attributeStore.findById(market, id);
          if (found === null) return ok(null);
          const revisions = await this.deps.attributeAdminReader.revisions(
            market,
            id,
            REVISIONS_READ,
          );
          const old = revisions.find((revision) => revision.revisionNo === restoreNo);
          return ok(old === undefined ? null : { found, old });
        },
        { readOnly: true },
      );
      if (!read.ok || read.value === null) return 'ok'; // the revert answers `gone` or `changed-since`
      content = restoredContent(read.value.found.state.options, read.value.old);
      // The Market's supported-locale rule a normal edit runs: names, help text, value labels.
      const supported = this.deps.policy.locales(market).supported;
      const localeIssues = [
        localizedOf(content.names, 'names', supported),
        localizedOf(content.display.helpText, 'helpText', supported),
        ...content.options.map((option, index) =>
          localizedOf(option.labels, `options[${index}].labels`, supported),
        ),
      ];
      if (localeIssues.some((issue) => !issue.ok)) return 'not-permitted';
      const units = marketUnitsRefusal(content.bounds, this.deps.policy.units(market));
      if (units !== null) return 'not-permitted';
      const next = read.value.found.revise({
        revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
        ...content,
        now: this.deps.clock.now(),
      });
      if (!next.ok) return 'ok'; // the domain refuses in the unit: `changed-since`
      publishRefused =
        next.value.state.status === 'active' &&
        publishableRefusal(next.value.state, this.deps.policy.locales(market).default) !== null;
    } catch {
      return 'not-permitted';
    }
    if (publishRefused) return 'not-permitted';
    try {
      return (await refuseClaimContent(this.deps, context, content)) === null
        ? 'ok'
        : 'not-permitted';
    } catch {
      return 'not-permitted';
    }
  }

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
    const revisions = await this.deps.attributeAdminReader.revisions(market, id, REVISIONS_READ);
    const old = revisions.find((revision) => revision.revisionNo === restoreNo);
    if (old === undefined) return 'changed-since';

    const next = found.revise({
      revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
      ...restoredContent(found.state.options, old),
      now: this.deps.clock.now(),
    });
    if (!next.ok) return 'changed-since';
    if (
      next.value.state.status === 'active' &&
      publishableRefusal(next.value.state, this.deps.policy.locales(market).default) !== null
    ) {
      return 'changed-since';
    }
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

  /** Before the unit: the decider holds the key the links edit needs. */
  async check(context: CallContext): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    return (await mayEdit(this.deps, context, CategoryAttributeLinksSet.access))
      ? 'ok'
      : 'not-permitted';
  }

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
