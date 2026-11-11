import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  levelOf,
  siblingNameClashes,
  type CategorySeo,
  type CategoryText,
  type EditableCategory,
} from '../../domain/category-edit';
import {
  PlatformCategoryCreatedAudit,
  PlatformCategoryDetailsChangedAudit,
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
  await store.lockSlugs(market, [spec.slug]);
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
  await deps.audit.record(
    context,
    PlatformCategoryDetailsChangedAudit.entry(target.id, {
      before: {
        revisionNo: target.revisionNo,
        localeCount: target.texts.length,
        showInMenu: target.showInMenu,
        noindex: target.seo.noindex,
        seoTitleSet: target.seo.title !== null,
        seoDescriptionSet: target.seo.description !== null,
      },
      after: {
        revisionNo: target.revisionNo + 1,
        localeCount: spec.texts.length,
        showInMenu: spec.showInMenu,
        noindex: spec.seo.noindex,
        seoTitleSet: spec.seo.title !== null,
        seoDescriptionSet: spec.seo.description !== null,
      },
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
