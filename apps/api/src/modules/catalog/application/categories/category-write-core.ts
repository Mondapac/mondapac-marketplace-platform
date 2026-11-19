import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  canDiscard,
  levelOf,
  planHide,
  planReorder,
  siblingNameClashes,
  type CategorySeo,
  type CategoryText,
  type EditableCategory,
} from '../../domain/category-edit';
import {
  PlatformCategoryCreatedAudit,
  PlatformCategoryDetailsChangedAudit,
  PlatformCategoryDetailsRevertedAudit,
  PlatformCategoryDiscardedAudit,
  PlatformCategoryHiddenAudit,
  PlatformCategoryReorderedAudit,
} from '../../domain/audit';
import { PlatformCategoryCreated } from '../../domain/events';
import {
  announceChanged,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from './category-editor';

// The in-unit bodies of Add and Edit details (categories C3a), shared with the file import (C7a):
// "rows go through the same editor use cases as C3, no second write path". Both run inside the
// unit the caller opened, with the tree already read under the structural lock; neither opens a
// unit, checks claim text (the caller does, before the unit) or raises the tree version.
// Discard, Hide and Reorder are here too: Admin Inbox › System requests applies an approved
// discard, and undoes a reviewed create or reorder, through them (`requestId` names the request
// in the audit row; null for an admin's own action).

type CoreDependencies = Pick<
  CategoryWriteDependencies,
  'store' | 'clock' | 'ids' | 'audit' | 'outbox'
>;

export interface CreateSpec {
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly texts: readonly CategoryText[];
  readonly seo: CategorySeo;
  readonly showInMenu: boolean;
  readonly maxDepth: number;
  /**
   * True when the caller holds the tree row lock (a structural unit): every writer of a slug takes
   * that lock first, so the per-slug advisory lock adds nothing and a file of thousands of rows
   * would hold thousands of them. The slug check below still runs.
   */
  readonly slugsLocked?: boolean;
}

/** A created category and the tree as it now stands (the caller threads it to the next write). */
export interface Created {
  readonly category: CategoryWriteView;
  readonly node: EditableCategory;
}

/** `platform-category.create` inside the open unit (plan decision 5: created hidden, last). */
export async function createCategoryInUnit(
  deps: CoreDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  nodes: readonly EditableCategory[],
  spec: CreateSpec,
  treeVersion: number,
): Promise<Result<Created, CategoryWriteFailure>> {
  const { market } = context;
  const { store, clock, ids } = deps;
  const byId = new Map(nodes.map((node) => [node.id as string, node] as const));
  if (spec.parentId !== null) {
    const parent = byId.get(spec.parentId);
    if (parent === undefined || (parent.status !== 'active' && parent.status !== 'hidden')) {
      return err({ code: 'category.parent-not-found' });
    }
  }
  const level = levelOf(byId, spec.parentId) + 1;
  if (level > spec.maxDepth) return err({ code: 'category.depth-exceeded', max: spec.maxDepth });
  if (spec.slugsLocked !== true) await store.lockSlugs(market, [spec.slug]);
  if (await store.slugUnavailable(market, spec.slug, null, clock.now())) {
    return err({ code: 'category.slug-taken' });
  }
  const clashes = siblingNameClashes(nodes, spec.parentId, null, spec.texts);
  if (clashes.length > 0) return err({ code: 'category.sibling-name-taken', fields: clashes });
  const now = clock.now();
  const id = ids.next<'Category'>();
  await store.insert(market, {
    id,
    revisionId: ids.next<'CategoryRevision'>(),
    parentId: spec.parentId,
    slug: spec.slug,
    texts: spec.texts,
    seo: spec.seo,
    showInMenu: spec.showInMenu,
    authorAccountId: accountId,
    now,
  });
  await deps.audit.record(
    context,
    PlatformCategoryCreatedAudit.entry(id, {
      after: { status: 'hidden', level, localeCount: spec.texts.length },
    }),
  );
  await deps.outbox.append(context, [
    PlatformCategoryCreated.record({
      aggregateId: id,
      aggregateVersion: 1,
      occurredAt: now,
      payload: { categoryId: id },
    }),
  ]);
  const position =
    nodes
      .filter((node) => node.parentId === spec.parentId)
      .reduce((most, node) => Math.max(most, node.position), 0) + 1;
  return ok({
    category: { id, slug: spec.slug, status: 'hidden', version: 1, revisionNo: 1, treeVersion },
    node: {
      id,
      parentId: spec.parentId,
      slug: spec.slug,
      status: 'hidden',
      hiddenById: null,
      position,
      version: 1,
      revisionNo: 1,
      createdByKind: 'admin',
      showInMenu: spec.showInMenu,
      imageId: null,
      seo: spec.seo,
      texts: spec.texts,
    },
  });
}

export interface EditSpec {
  readonly texts: readonly CategoryText[];
  readonly seo: CategorySeo;
  readonly showInMenu: boolean;
  /** The version the admin saw; null when the caller holds the tree locked and has no version to name. */
  readonly version: number | null;
  /**
   * Set only by the revert of a reviewed edit (System requests): the audit row then says the
   * details came back by that request, not that an admin saved them.
   */
  readonly revertedBy?: Id<'SystemRequest'>;
}

/** `platform-category.edit-details` inside the open unit (a save that changes nothing writes nothing). */
export async function editDetailsInUnit(
  deps: CoreDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  nodes: readonly EditableCategory[],
  targetId: Id<'Category'>,
  spec: EditSpec,
  treeVersion: number,
): Promise<Result<Created, CategoryWriteFailure>> {
  const { market } = context;
  const target = nodes.find((node) => node.id === targetId);
  if (target === undefined) return err({ code: 'category.not-found' });
  if (target.status !== 'active' && target.status !== 'hidden') {
    return err({ code: 'category.not-editable' });
  }
  if (spec.version !== null && target.version !== spec.version) {
    return err({ code: 'conflict.stale' });
  }
  const clashes = siblingNameClashes(nodes, target.parentId, target.id, spec.texts);
  if (clashes.length > 0) return err({ code: 'category.sibling-name-taken', fields: clashes });
  const unchanged =
    JSON.stringify(target.texts) === JSON.stringify(spec.texts) &&
    JSON.stringify(target.seo) === JSON.stringify(spec.seo) &&
    target.showInMenu === spec.showInMenu;
  const view = (version: number, revisionNo: number): CategoryWriteView => ({
    id: target.id,
    slug: target.slug,
    status: target.status,
    version,
    revisionNo,
    treeVersion,
  });
  if (unchanged) return ok({ category: view(target.version, target.revisionNo), node: target });
  const newVersion = await deps.store.apply(market, {
    category: target,
    revisionId: deps.ids.next<'CategoryRevision'>(),
    kind: 'details-changed',
    texts: spec.texts,
    patch: { seo: spec.seo, showInMenu: spec.showInMenu },
    authorAccountId: accountId,
    now: deps.clock.now(),
  });
  const shape = (
    revisionNo: number,
    texts: readonly CategoryText[],
    showInMenu: boolean,
    seo: CategorySeo,
  ) => ({
    revisionNo,
    localeCount: texts.length,
    showInMenu,
    noindex: seo.noindex,
    seoTitleSet: seo.title !== null,
    seoDescriptionSet: seo.description !== null,
  });
  const was = shape(target.revisionNo, target.texts, target.showInMenu, target.seo);
  const now = shape(target.revisionNo + 1, spec.texts, spec.showInMenu, spec.seo);
  await deps.audit.record(
    context,
    spec.revertedBy === undefined
      ? PlatformCategoryDetailsChangedAudit.entry(target.id, { before: was, after: now })
      : PlatformCategoryDetailsRevertedAudit.entry(target.id, {
          before: was,
          after: { ...now, requestId: spec.revertedBy },
        }),
  );
  await announceChanged(deps, context, target.id, newVersion);
  return ok({
    category: view(newVersion, target.revisionNo + 1),
    node: {
      ...target,
      version: newVersion,
      revisionNo: target.revisionNo + 1,
      texts: spec.texts,
      seo: spec.seo,
      showInMenu: spec.showInMenu,
    },
  });
}

/** `platform-category.discard` inside the open unit (only a category that never went live). */
export async function discardInUnit(
  deps: CoreDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  nodes: readonly EditableCategory[],
  targetId: Id<'Category'>,
  treeVersion: number,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Created, CategoryWriteFailure>> {
  const { market } = context;
  const { store, ids, clock } = deps;
  const target = nodes.find((node) => node.id === targetId);
  if (target === undefined) return err({ code: 'category.not-found' });
  const facts = await store.discardFacts(market, target.id);
  if (!canDiscard(nodes, target, facts)) return err({ code: 'category.not-discardable' });
  const version = await store.apply(market, {
    category: target,
    revisionId: ids.next<'CategoryRevision'>(),
    kind: 'discarded',
    texts: target.texts,
    patch: { status: 'archived', hiddenById: null },
    authorAccountId: accountId,
    now: clock.now(),
  });
  await deps.audit.record(
    context,
    PlatformCategoryDiscardedAudit.entry(target.id, {
      before: { status: 'hidden' },
      after: { status: 'archived', requestId },
    }),
  );
  await announceChanged(deps, context, target.id, version);
  return ok({
    category: {
      id: target.id,
      slug: target.slug,
      status: 'archived',
      version,
      revisionNo: target.revisionNo + 1,
      treeVersion,
    },
    node: { ...target, status: 'archived', hiddenById: null, version },
  });
}

/** `platform-category.hide` inside the open unit (the hide cascades to live descendants). */
export async function hideInUnit(
  deps: CoreDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  nodes: readonly EditableCategory[],
  targetId: Id<'Category'>,
  treeVersion: number,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Created, CategoryWriteFailure>> {
  const { market } = context;
  const { store, ids, clock } = deps;
  const target = nodes.find((node) => node.id === targetId);
  if (target === undefined) return err({ code: 'category.not-found' });
  const plan = planHide(nodes, target);
  if (!plan.ok) return plan;
  const at = clock.now();
  let version = target.version;
  for (const change of plan.value) {
    const node = nodes.find((entry) => entry.id === change.id)!;
    const newVersion = await store.apply(market, {
      category: node,
      revisionId: ids.next<'CategoryRevision'>(),
      kind: 'hidden',
      texts: node.texts,
      patch: { status: change.status, hiddenById: change.hiddenById },
      authorAccountId: accountId,
      now: at,
    });
    if (node.id === target.id) version = newVersion;
    await announceChanged(deps, context, node.id, newVersion);
  }
  await deps.audit.record(
    context,
    PlatformCategoryHiddenAudit.entry(target.id, {
      before: { status: 'active' },
      after: { status: 'hidden', cascaded: plan.value.length - 1, requestId },
    }),
  );
  return ok({
    category: {
      id: target.id,
      slug: target.slug,
      status: 'hidden',
      version,
      revisionNo: target.revisionNo + 1,
      treeVersion,
    },
    node: { ...target, status: 'hidden', hiddenById: null, version },
  });
}

/** What a reorder changed: the category and the sibling it swapped places with. */
export interface Reordered {
  readonly category: CategoryWriteView;
  readonly target: EditableCategory;
  readonly neighbour: EditableCategory;
}

/** `platform-category.reorder` inside the open unit: swaps places with the sibling that way. */
export async function reorderInUnit(
  deps: CoreDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  nodes: readonly EditableCategory[],
  targetId: Id<'Category'>,
  direction: 'up' | 'down',
  treeVersion: number,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Reordered, CategoryWriteFailure>> {
  const { market } = context;
  const { store, ids, clock } = deps;
  const target = nodes.find((node) => node.id === targetId);
  if (target === undefined) return err({ code: 'category.not-found' });
  const neighbour = planReorder(nodes, target, direction);
  if (!neighbour.ok) return neighbour;
  const at = clock.now();
  await store.swapPositions(market, target, neighbour.value);
  const version = await store.apply(market, {
    category: target,
    revisionId: ids.next<'CategoryRevision'>(),
    kind: 'reordered',
    texts: target.texts,
    patch: {},
    authorAccountId: accountId,
    now: at,
  });
  const other = await store.apply(market, {
    category: neighbour.value,
    revisionId: ids.next<'CategoryRevision'>(),
    kind: 'reordered',
    texts: neighbour.value.texts,
    patch: {},
    authorAccountId: accountId,
    now: at,
  });
  await deps.audit.record(
    context,
    PlatformCategoryReorderedAudit.entry(target.id, {
      before: { position: target.position },
      after: { position: neighbour.value.position, requestId },
    }),
  );
  await announceChanged(deps, context, target.id, version);
  await announceChanged(deps, context, neighbour.value.id, other);
  return ok({
    category: {
      id: target.id,
      slug: target.slug,
      status: target.status,
      version,
      revisionNo: target.revisionNo + 1,
      treeVersion,
    },
    target,
    neighbour: neighbour.value,
  });
}
