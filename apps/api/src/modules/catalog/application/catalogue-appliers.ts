import type { CallContext, Id } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  ApplyOutcome,
  ChangeImpact,
  RevertRequest,
  SystemChangeApplier,
} from '../../system-requests';
import type { EditableCategory } from '../domain/category-edit';
import { MAX_TREE_NODES } from '../domain/category-tree';
import { attributeIdOf, editorAccountOf as attributeEditorOf } from './attributes/attribute-editor';
import {
  categoryIdOf,
  editorAccountOf as categoryEditorOf,
  lockTreeInUnit,
} from './categories/category-editor';
import {
  clearRestructure,
  restructureInUnit,
  type CategoryRestructureDependencies,
  type RestructureSpec,
} from './categories/category-restructure';
import { discardInUnit } from './categories/category-write-core';
import {
  attributeActionOf,
  categoryActionOf,
  holdsCategoryState,
  productsMoveOf,
  type AttributeAction,
  type CategoryAction,
} from './catalogue-actions';
import {
  attributeRequestImpact,
  categoryRequestImpact,
  productsMoveRequestImpact,
} from './catalogue-impact';
import type { AdminCategoryReader } from './ports/admin-category.reader';
import type { AttributeAdminReader } from './ports/attribute-admin.reader';
import type { AttributeDefinitionStore } from './ports/attribute-definition.store';
import type { AttributeImpactReader } from './ports/attribute-impact.reader';
import type { AttributeRelaxationStore } from './ports/attribute-relaxation.store';
import type { CategoryProductMoveStore } from './ports/category-product-move.store';
import type { ClaimTermLocales } from './ports/claim-term-locales';
import type { ClaimTextMatcher } from './ports/claim-text-matcher';
import { FeatureSetCodeTakenError, type FeatureSetStore } from './ports/feature-set.store';
import {
  AttributeArchive,
  checkArchive,
  writeArchive,
} from './use-cases/attribute-archive.use-case';
import {
  AttributeDefinitionDiscard,
  discardAttributeInUnit,
} from './use-cases/attribute-definition-discard.use-case';
import { AttributeMerge, checkMerge, writeMerge } from './use-cases/attribute-merge.use-case';
import {
  AttributeValuesMerge,
  mergeValuesInUnit,
} from './use-cases/attribute-values-merge.use-case';
import { archiveSpec, CategoryArchive } from './use-cases/category-archive.use-case';
import { CategoryDiscard } from './use-cases/category-discard.use-case';
import { CategoryMerge, mergeSpec } from './use-cases/category-merge.use-case';
import {
  CategoryMoveProducts,
  checkProductsMove,
  startProductsMoveInUnit,
} from './use-cases/category-move-products.use-case';
import {
  createFeatureSetInUnit,
  FeatureSetCreate,
  featureSetBodyOf,
  prepareFeatureSet,
  type PreparedFeatureSet,
} from './use-cases/feature-set-create.use-case';

// The appliers of area catalogue (Admin Inbox › System requests, owner decision of 18 Nov 2026):
// a discard, merge or archive of a platform category, a move of a category's products, a discard,
// archive, merge or merge of values of an attribute definition, and a new feature set wait for a
// second admin's approval where the Market reviews the area. The approval runs `check` (before
// System requests opens its unit: the approving admin holds the action's key, and the checks that
// open a unit of their own, such as certification's check of the categories a merge or archive
// retires and the claim-text check of a feature set's names), then `apply` in the decision's open
// unit: the subject must still hold `before`, and the action is written through the same in-unit
// function the route uses, as the approving admin, naming the request in its audit row and
// emitting the same events. A refusal of the domain now is `not-permitted`, a subject changed
// since is `changed-since`, a subject that no longer exists is `gone`; nothing is written then.
//
// Known limit: the decision's unit has the default timeout, shorter than the 30 s a route's
// restructure may take, so the approval of a merge or archive that marks very many products can
// time out (and is then simply not applied; the request stays open).

/** What the appliers and the structure reverters are built from. */
export interface CatalogueStructureDependencies extends CategoryRestructureDependencies {
  readonly attributeStore: AttributeDefinitionStore;
  readonly relaxations: AttributeRelaxationStore;
  readonly impact: AttributeImpactReader;
  readonly featureSetStore: FeatureSetStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly moveStore: CategoryProductMoveStore;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly authorisation: AuthorisationCheck;
}

/** Whether the deciding admin holds what the action's own route needs (fail closed). */
export async function mayRun(
  deps: Pick<CatalogueStructureDependencies, 'authorisation'>,
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
 * What a pre-unit `check` cleared for one request, handed to the `apply` (or `revert`) that System
 * requests runs right after it in the same call. Held in memory, a few hundred requests at most.
 * Each `check` first drops what an earlier one left for the request (`forget`: a decision that
 * failed after its check never hands its result to a later one), and an entry is taken once, by
 * the same admin in the same Market as the check (Hassan L1). A missing or foreign entry means the
 * check did not run here for this decision: the caller fails closed.
 */
export class ClearedByRequest<T> {
  readonly #entries = new Map<
    string,
    { readonly accountId: string | null; readonly marketId: string; readonly value: T }
  >();

  /** Drops what an earlier check left for the request (called first by every `check`). */
  forget(requestId: Id<'SystemRequest'>): void {
    this.#entries.delete(requestId);
  }

  put(context: CallContext, requestId: Id<'SystemRequest'>, value: T): void {
    this.#entries.delete(requestId);
    this.#entries.set(requestId, {
      accountId: categoryEditorOf(context),
      marketId: context.market.marketId,
      value,
    });
    while (this.#entries.size > 256) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** The value the check cleared for this decider in this Market; undefined otherwise. */
  take(context: CallContext, requestId: Id<'SystemRequest'>): T | undefined {
    const entry = this.#entries.get(requestId);
    this.#entries.delete(requestId);
    if (entry === undefined) return undefined;
    const accountId = categoryEditorOf(context);
    if (accountId === null || entry.accountId !== accountId) return undefined;
    if (entry.marketId !== context.market.marketId) return undefined;
    return entry.value;
  }
}

/** The account of the deciding admin, who acts as themselves (never in an acting-as session). */
export function deciderOf(context: CallContext): Id<'Account'> {
  const account = categoryEditorOf(context);
  if (account === null) {
    throw new Error(
      'catalog: a system request decision needs a signed-in admin acting as themselves',
    );
  }
  return account;
}

/** A read-only snapshot of the tree, before any unit opens (the pre-unit checks). */
export async function treeSnapshot(
  deps: Pick<CatalogueStructureDependencies, 'unitOfWork' | 'store'>,
  context: CallContext,
): Promise<readonly EditableCategory[] | null> {
  const { market } = context;
  const read = await deps.unitOfWork.run<readonly EditableCategory[] | null, never>(
    market,
    async () => {
      const nodes = await deps.store.loadAll(market, MAX_TREE_NODES + 1);
      return ok(nodes.length > MAX_TREE_NODES ? null : nodes);
    },
    { readOnly: true },
  );
  return read.ok ? read.value : null;
}

/** The reason a restructure an approval runs writes on the category's revision. */
const reasonOf = (action: CategoryAction): string =>
  action.action === 'discard' ? '' : action.reason;

/**
 * The discard (`catalog.category-discard`), merge or archive (`catalog.category-restructure`) of a
 * platform category, asked for by one admin and applied by another's approval. Each kind applies
 * only its own actions (`actions`): it is registered with that action's permission key.
 */
export class CategoryActionApplier implements SystemChangeApplier {
  readonly #cleared = new ClearedByRequest<ReadonlySet<string>>();

  constructor(
    private readonly deps: CatalogueStructureDependencies,
    private readonly actions: readonly CategoryAction['action'][],
  ) {}

  #actionOf(values: unknown): CategoryAction | null {
    const action = categoryActionOf(values);
    return action !== null && this.actions.includes(action.action) ? action : null;
  }

  #spec(
    context: CallContext,
    accountId: Id<'Account'>,
    categoryId: Id<'Category'>,
    action: Exclude<CategoryAction, { action: 'discard' }>,
    requestId: Id<'SystemRequest'>,
  ): RestructureSpec {
    // The tree version is checked by the decision unit's own lock, not named by a page.
    if (action.action === 'merge') {
      return mergeSpec(this.deps, context, {
        accountId,
        sourceId: categoryId,
        targetId: action.targetId,
        treeVersion: 0,
        reason: reasonOf(action),
        maxDepth: this.deps.policy.maxCategoryDepth(context.market),
        requestId,
      });
    }
    return archiveSpec(this.deps, context, {
      accountId,
      categoryId,
      treeVersion: 0,
      reason: reasonOf(action),
      requestId,
    });
  }

  /**
   * Before the unit: the approving admin holds the action's key; for a merge or an archive, the
   * plan on a snapshot and certification's check of the categories it retires (fail closed).
   */
  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    this.#cleared.forget(request.requestId);
    const accountId = categoryEditorOf(context);
    if (accountId === null) return 'not-permitted';
    const action = this.#actionOf(request.after);
    const id = categoryIdOf(request.subjectRef);
    if (action === null || !id.ok) return 'ok'; // the apply answers `gone`
    const access =
      action.action === 'discard'
        ? CategoryDiscard.access
        : action.action === 'merge'
          ? CategoryMerge.access
          : CategoryArchive.access;
    if (!(await mayRun(this.deps, context, access))) return 'not-permitted';
    if (action.action === 'discard') return 'ok';
    try {
      // A category gone or changed since is the apply's answer (`gone`, `changed-since`), not a
      // refusal of the plan.
      const nodes = await treeSnapshot(this.deps, context);
      if (nodes === null) return 'not-permitted';
      const seen = nodes.find((node) => node.id === id.value);
      if (seen === undefined || !holdsCategoryState(seen, request.before)) return 'ok';
      const cleared = await clearRestructure(
        this.deps,
        context,
        this.#spec(context, accountId, id.value, action, request.requestId),
      );
      if (!cleared.ok) return cleared.error.code === 'category.not-found' ? 'ok' : 'not-permitted';
      this.#cleared.put(context, request.requestId, cleared.value);
      return 'ok';
    } catch {
      return 'not-permitted';
    }
  }

  /** The products, Offers and categories under the category (the request's detail page). */
  impact(context: CallContext, request: RevertRequest): Promise<ChangeImpact | null> {
    return categoryRequestImpact(this.deps, context, request.subjectRef);
  }

  async apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    const accountId = deciderOf(context);
    const action = this.#actionOf(request.after);
    const id = categoryIdOf(request.subjectRef);
    const cleared = this.#cleared.take(context, request.requestId);
    if (action === null || !id.ok) return 'gone';
    try {
      const locked = await lockTreeInUnit(this.deps, context.market);
      if (locked === null) return 'not-permitted';
      const target = locked.nodes.find((node) => node.id === id.value);
      if (target === undefined) return 'gone';
      if (!holdsCategoryState(target, request.before)) return 'changed-since';
      if (action.action === 'discard') {
        const done = await discardInUnit(
          this.deps,
          context,
          accountId,
          locked.nodes,
          id.value,
          locked.treeVersion,
          request.requestId,
        );
        return done.ok ? 'applied' : 'not-permitted';
      }
      if (cleared === undefined) return 'not-permitted';
      const done = await restructureInUnit(
        this.deps,
        context,
        this.#spec(context, accountId, id.value, action, request.requestId),
        locked.nodes,
        locked.treeVersion,
        cleared,
      );
      if (done.ok) return 'applied';
      return done.error.code === 'conflict.stale' ? 'changed-since' : 'not-permitted';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/**
 * `catalog.category-products-move`: moving every published product of a category to another. The
 * approval starts the job as the approving admin; the job then runs, audits and emails sellers as
 * any other.
 */
export class ProductsMoveApplier implements SystemChangeApplier {
  constructor(private readonly deps: CatalogueStructureDependencies) {}

  async check(context: CallContext): Promise<'ok' | 'not-permitted'> {
    if (categoryEditorOf(context) === null) return 'not-permitted';
    return (await mayRun(this.deps, context, CategoryMoveProducts.access)) ? 'ok' : 'not-permitted';
  }

  /** The published products the move would take (the request's detail page). */
  impact(context: CallContext, request: RevertRequest): Promise<ChangeImpact | null> {
    return productsMoveRequestImpact(this.deps, context, request.subjectRef);
  }

  async apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    const accountId = deciderOf(context);
    const move = productsMoveOf(request.after);
    const id = categoryIdOf(request.subjectRef);
    if (move === null || !id.ok) return 'gone';
    const { market } = context;
    let maxLevel: number;
    try {
      maxLevel = this.deps.policy.maxCategoryDepth(market);
    } catch {
      return 'not-permitted';
    }
    const checked = await checkProductsMove(this.deps, market, {
      sourceId: id.value,
      targetId: move.targetId,
      maxLevel,
    });
    if (!checked.ok) return checked.error.code === 'category.not-found' ? 'gone' : 'not-permitted';
    if (checked.value.source.status !== request.before['status']) return 'changed-since';
    const started = await startProductsMoveInUnit(this.deps, context, accountId, {
      sourceId: id.value,
      targetId: move.targetId,
      reason: move.reason,
      products: checked.value.products,
      requestId: request.requestId,
    });
    return started.ok ? 'applied' : 'not-permitted';
  }
}

const attributeAccess = (action: AttributeAction): AccessDeclaration =>
  action.action === 'discard'
    ? AttributeDefinitionDiscard.access
    : action.action === 'archive'
      ? AttributeArchive.access
      : action.action === 'merge'
        ? AttributeMerge.access
        : AttributeValuesMerge.access;

/**
 * The discard (`catalog.attribute-discard`), archive (never of a `material` attribute: that has its
 * own two-person request), merge or merge of values (`catalog.attribute-restructure`) of an
 * attribute definition. Each kind applies only its own actions (`actions`).
 */
export class AttributeActionApplier implements SystemChangeApplier {
  constructor(
    private readonly deps: CatalogueStructureDependencies,
    private readonly actions: readonly AttributeAction['action'][],
  ) {}

  #actionOf(values: unknown): AttributeAction | null {
    const action = attributeActionOf(values);
    return action !== null && this.actions.includes(action.action) ? action : null;
  }

  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    if (attributeEditorOf(context) === null) return 'not-permitted';
    const action = this.#actionOf(request.after);
    if (action === null) return 'ok'; // the apply answers `gone`
    return (await mayRun(this.deps, context, attributeAccess(action))) ? 'ok' : 'not-permitted';
  }

  /** What the attribute reaches, as its impact dialog shows (the request's detail page). */
  impact(context: CallContext, request: RevertRequest): Promise<ChangeImpact | null> {
    return attributeRequestImpact(this.deps, context, request.subjectRef);
  }

  async apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    deciderOf(context);
    const action = this.#actionOf(request.after);
    const id = attributeIdOf(request.subjectRef);
    if (action === null || id === null) return 'gone';
    const { market } = context;
    const { deps } = this;
    try {
      const found = await deps.attributeStore.findById(market, id);
      if (found === null) return 'gone';
      const { before } = request;
      if (
        found.state.version !== action.version ||
        before['version'] !== found.state.version ||
        before['status'] !== found.state.status ||
        before['material'] !== found.state.material
      ) {
        return 'changed-since';
      }
      let outcome: { readonly ok: true } | { readonly ok: false; readonly error: { code: string } };
      if (action.action === 'discard') {
        outcome = await discardAttributeInUnit(deps, context, found, request.requestId);
      } else if (action.action === 'archive') {
        const checked = await checkArchive(deps, market, found);
        outcome = checked.ok
          ? await writeArchive(deps, context, found, request.requestId)
          : checked;
      } else if (action.action === 'merge-values') {
        outcome = await mergeValuesInUnit(
          deps,
          context,
          found,
          { source: action.source, target: action.target },
          request.requestId,
        );
      } else {
        const target = await deps.attributeStore.findById(market, action.targetId);
        if (target === null) return 'not-permitted';
        if (target.state.version !== action.targetVersion) return 'changed-since';
        const plan = await checkMerge(deps, market, found, target, action.options);
        outcome = plan.ok
          ? await writeMerge(deps, context, found, action.targetId, plan.value, request.requestId)
          : plan;
      }
      if (outcome.ok) return 'applied';
      return outcome.error.code === 'attribute.stale' ? 'changed-since' : 'not-permitted';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'changed-since';
      throw error;
    }
  }
}

/**
 * `catalog.feature-set-create`: a new feature set (a feature set has no delete, so its create
 * waits for approval). The approval reads the content again with the same checks as the route
 * (the claim-text check of every name before the unit; the attributes, the code and the domain
 * rules in it).
 */
export class FeatureSetCreateApplier implements SystemChangeApplier {
  readonly #prepared = new ClearedByRequest<PreparedFeatureSet>();

  constructor(private readonly deps: CatalogueStructureDependencies) {}

  async check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    this.#prepared.forget(request.requestId);
    if (attributeEditorOf(context) === null) return 'not-permitted';
    if (!(await mayRun(this.deps, context, FeatureSetCreate.access))) return 'not-permitted';
    const body = featureSetBodyOf(request.after);
    if (body === null) return 'ok'; // the apply answers `gone`
    try {
      const prepared = await prepareFeatureSet(this.deps, context, body);
      if (!prepared.ok) return 'not-permitted';
      this.#prepared.put(context, request.requestId, prepared.value);
      return 'ok';
    } catch {
      return 'not-permitted';
    }
  }

  async apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    const accountId = deciderOf(context);
    const prepared = this.#prepared.take(context, request.requestId);
    if (featureSetBodyOf(request.after) === null) return 'gone';
    if (prepared === undefined) return 'not-permitted';
    try {
      const created = await createFeatureSetInUnit(
        this.deps,
        context,
        accountId,
        prepared,
        request.requestId,
      );
      if (created.ok) return 'applied';
      return created.error.code === 'feature-set.code-taken' ? 'changed-since' : 'not-permitted';
    } catch (error) {
      if (error instanceof FeatureSetCodeTakenError) return 'changed-since';
      throw error;
    }
  }
}
