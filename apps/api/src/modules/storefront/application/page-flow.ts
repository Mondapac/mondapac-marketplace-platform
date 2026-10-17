import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  StorefrontDraftChanged,
  StorefrontPageArchived,
  StorefrontPageCreated,
  StorefrontPagePublished,
  StorefrontPageUpdated,
} from '../domain/audit';
import type { Problems } from '../domain/fields';
import { moduleFields, MODULE_KEYS, type ModuleKey } from '../domain/modules';
import {
  parseArchive,
  parseDynamicSettings,
  parseNewPage,
  parseStoredSettings,
  parseSystemSettings,
  storedSettings,
  type Linked,
  type PendingSettings,
  type Seo,
} from '../domain/page-settings';
import {
  addPlacement,
  defaultPlacements,
  placementCount,
  publishProblems,
  readPlacements,
  removePlacement,
  reorderPlacements,
  sizeProblems,
  storedPlacements,
  updatePlacement,
  type AddInput,
  type PlacementFailure,
  type Placements,
} from '../domain/placements';
import {
  NAVIGATION_KEY,
  SYSTEM_PAGE_LIST,
  SYSTEM_PAGES,
  TEMPLATES,
  templateOf,
  type EditLevel,
  type SlotDefinition,
  type TemplateDefinition,
} from '../domain/templates';
import type { PageRecord, Stamp, VersionRecord } from './ports/page.repository';
import type { StorefrontDependencies } from './storefront-dependencies';

// The admin side of the storefront (content-management analysis 5 to 7): the page list, a page's
// settings, its draft (modules added, changed, switched on or off, removed and reordered inside
// the slots its template allows), publishing, restoring an old version and archiving. A system
// page has no row until its first change; until then buyers see its template's defaults. Every
// change locks the page row first, and is audited.

export type PageFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: Problems }
  | { readonly code: 'storefront.page-not-found' }
  | { readonly code: 'storefront.version-not-found' }
  | { readonly code: 'storefront.slot-not-found' }
  | { readonly code: 'storefront.placement-not-found' }
  /** A locked system page (checkout, confirmation, account) takes no change. */
  | { readonly code: 'storefront.page-locked' }
  | { readonly code: 'storefront.page-archived' }
  | { readonly code: 'storefront.slot-full' }
  | { readonly code: 'storefront.slug-taken' }
  /** Publish with no draft: there is nothing new to publish. */
  | { readonly code: 'storefront.nothing-to-publish' }
  /** Publish of a draft that changed after the version and time the publisher reviewed. */
  | { readonly code: 'storefront.draft-changed' };

export type PageStatus = 'default' | 'draft' | 'scheduled' | 'published' | 'ended' | 'archived';

export interface PageSummaryView {
  /** null for a system page that was never changed. */
  readonly id: Id<'StorefrontPage'> | null;
  readonly kind: 'system' | 'dynamic';
  readonly systemKey: string | null;
  readonly slug: string | null;
  /** The buyer-site path: a system page's fixed path, or `/l/<slug>`. */
  readonly path: string;
  readonly templateKey: string;
  readonly title: string;
  readonly editLevel: EditLevel;
  readonly status: PageStatus;
  readonly hasDraft: boolean;
  readonly publishedVersionNo: number | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly updatedAt: Temporal.Instant | null;
}

export interface VersionView {
  readonly id: Id<'StorefrontPageVersion'>;
  readonly versionNo: number;
  readonly state: 'draft' | 'published' | 'retired';
  readonly createdAt: Temporal.Instant;
  readonly publishedAt: Temporal.Instant | null;
}

export interface PageDetailView extends PageSummaryView {
  readonly seo: Seo;
  readonly linked: Linked | null;
  readonly startsAt: Temporal.Instant | null;
  readonly endsAt: Temporal.Instant | null;
  readonly archivedRedirect: string | null;
  readonly slots: readonly SlotDefinition[];
  /**
   * The draft, or (no draft) what a new draft would start from. `settings`: the settings the
   * draft puts on the page when it is published (null: it leaves them as they are); the page's
   * own settings above are the ones buyers see.
   */
  readonly draft: {
    readonly versionNo: number | null;
    readonly placements: Placements;
    readonly settings: PendingSettings | null;
    readonly updatedAt: Temporal.Instant | null;
  };
  readonly published: { readonly versionNo: number; readonly placements: Placements } | null;
  /** Newest first, at most {@link MAX_VERSIONS_SHOWN}. */
  readonly versions: readonly VersionView[];
}

export interface CatalogueView {
  readonly templates: readonly {
    readonly key: string;
    readonly scope: 'dynamic' | 'system';
    readonly linkable: readonly string[];
    readonly slots: readonly SlotDefinition[];
  }[];
  readonly modules: readonly { readonly key: ModuleKey; readonly fields: readonly string[] }[];
  readonly systemPages: readonly {
    readonly key: string;
    readonly templateKey: string;
    readonly editLevel: EditLevel;
    readonly path: string;
  }[];
}

export const MAX_PAGES_LISTED = 500;
export const MAX_VERSIONS_SHOWN = 50;

type Admin = { readonly accountId: Id<'Account'> };

export function adminOf(context: CallContext): Admin | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor : null;
}

const invalid = (path: string, code = 'format'): PageFailure => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

/** A page reference of the admin routes: a page id, or the key of a system page. */
export type PageRef =
  | { readonly kind: 'id'; readonly id: Id<'StorefrontPage'> }
  | { readonly kind: 'system'; readonly key: string };

export function pageRefOf(value: unknown): PageRef | null {
  if (typeof value !== 'string') return null;
  if (SYSTEM_PAGES.has(value)) return { kind: 'system', key: value };
  const parsed = parseId<'StorefrontPage'>(value);
  return parsed.ok ? { kind: 'id', id: parsed.value } : null;
}

export const pathOf = (page: Pick<PageRecord, 'kind' | 'systemKey' | 'slug'>): string =>
  page.kind === 'dynamic'
    ? `/l/${page.slug}`
    : (SYSTEM_PAGES.get(page.systemKey ?? '')?.path ?? '/');

function statusOf(
  page: PageRecord | null,
  publishedVersionNo: number | null,
  now: Temporal.Instant,
): PageStatus {
  if (page === null || page.kind === 'system')
    return publishedVersionNo === null ? 'default' : 'published';
  if (page.archivedAt !== null) return 'archived';
  if (publishedVersionNo === null) return 'draft';
  if (page.startsAt !== null && Temporal.Instant.compare(now, page.startsAt) < 0)
    return 'scheduled';
  if (page.endsAt !== null && Temporal.Instant.compare(now, page.endsAt) >= 0) return 'ended';
  return 'published';
}

export const editLevelOf = (page: Pick<PageRecord, 'kind' | 'systemKey'>): EditLevel =>
  page.kind === 'dynamic'
    ? 'full'
    : (SYSTEM_PAGES.get(page.systemKey ?? '')?.editLevel ?? 'locked');

/** A system page that has no row yet, as the list and the detail show it. */
function virtualSystemPage(key: string): Omit<PageSummaryView, 'status' | 'hasDraft'> {
  const definition = SYSTEM_PAGES.get(key)!;
  return {
    id: null,
    kind: 'system',
    systemKey: key,
    slug: null,
    path: definition.path,
    templateKey: definition.templateKey,
    title: key,
    editLevel: definition.editLevel,
    publishedVersionNo: null,
    publishedAt: null,
    updatedAt: null,
  };
}

function summaryOf(
  page: PageRecord,
  summary: {
    draftVersionNo: number | null;
    publishedVersionNo: number | null;
    publishedAt: Temporal.Instant | null;
  },
  now: Temporal.Instant,
): PageSummaryView {
  return {
    id: page.id,
    kind: page.kind,
    systemKey: page.systemKey,
    slug: page.slug,
    path: pathOf(page),
    templateKey: page.templateKey,
    title: page.title,
    editLevel: editLevelOf(page),
    status: statusOf(page, summary.publishedVersionNo, now),
    hasDraft: summary.draftVersionNo !== null,
    publishedVersionNo: summary.publishedVersionNo,
    publishedAt: summary.publishedAt,
    updatedAt: page.updatedAt,
  };
}

/** The templates, modules and system pages, for the admin editor. Code only. */
export function viewCatalogue(context: CallContext): Result<CatalogueView, PageFailure> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  return ok({
    templates: [...TEMPLATES.values()].map((template) => ({
      key: template.key,
      scope: template.scope,
      linkable: template.linkable,
      slots: template.slots,
    })),
    modules: MODULE_KEYS.map((key) => ({ key, fields: moduleFields(key) })),
    systemPages: SYSTEM_PAGE_LIST.map((page) => ({ ...page })),
  });
}

/** Every system page (changed or not) and every dynamic page of the Market. */
export async function listPages(
  deps: StorefrontDependencies,
  context: CallContext,
): Promise<Result<readonly PageSummaryView[], PageFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const now = deps.clock.now();
  return deps.unitOfWork.run<readonly PageSummaryView[], PageFailure>(
    context.market,
    async () => {
      const rows = await deps.pages.listPages(context.market, MAX_PAGES_LISTED);
      const summaries = new Map(
        (await deps.pages.summaries(context.market)).map((entry) => [entry.pageId, entry]),
      );
      const none = { draftVersionNo: null, publishedVersionNo: null, publishedAt: null };
      const systemRows = new Map(
        rows.filter((row) => row.kind === 'system').map((row) => [row.systemKey, row]),
      );
      const system = SYSTEM_PAGE_LIST.map((definition) => {
        const row = systemRows.get(definition.key);
        return row === undefined
          ? { ...virtualSystemPage(definition.key), status: 'default' as const, hasDraft: false }
          : summaryOf(row, summaries.get(row.id) ?? none, now);
      });
      const dynamic = rows
        .filter((row) => row.kind === 'dynamic')
        .map((row) => summaryOf(row, summaries.get(row.id) ?? none, now));
      return ok([...system, ...dynamic]);
    },
    { readOnly: true },
  );
}

const versionView = (version: VersionRecord): VersionView => ({
  id: version.id,
  versionNo: version.versionNo,
  state: version.state,
  createdAt: version.createdAt,
  publishedAt: version.publishedAt,
});

/** The detail of a page as it now stands, read inside the caller's unit. */
async function detailOf(
  deps: StorefrontDependencies,
  context: CallContext,
  ref: PageRef,
): Promise<PageDetailView | null> {
  const market = context.market;
  const now = deps.clock.now();
  const page =
    ref.kind === 'id'
      ? await deps.pages.findPage(market, ref.id)
      : await deps.pages.findSystemPage(market, ref.key);
  if (page === null) {
    if (ref.kind === 'id') return null;
    const template = templateOf(SYSTEM_PAGES.get(ref.key)!.templateKey);
    let n = 0;
    return {
      ...virtualSystemPage(ref.key),
      status: 'default',
      hasDraft: false,
      seo: {},
      linked: null,
      startsAt: null,
      endsAt: null,
      archivedRedirect: null,
      slots: template.slots,
      draft: {
        versionNo: null,
        placements: defaultPlacements(template, { title: ref.key }, () => `default-${(n += 1)}`),
        settings: null,
        updatedAt: null,
      },
      published: null,
      versions: [],
    };
  }
  const template = templateOf(page.templateKey);
  const versions = await deps.pages.versions(market, page.id, MAX_VERSIONS_SHOWN);
  const draft =
    versions.find((v) => v.state === 'draft') ?? (await deps.pages.findDraft(market, page.id));
  const published =
    versions.find((v) => v.state === 'published') ??
    (await deps.pages.findPublished(market, page.id));
  let n = 0;
  const base =
    published !== null ? readPlacements(template, published.placements).placements : null;
  return {
    ...summaryOf(
      page,
      {
        draftVersionNo: draft?.versionNo ?? null,
        publishedVersionNo: published?.versionNo ?? null,
        publishedAt: published?.publishedAt ?? null,
      },
      now,
    ),
    seo: page.seo,
    linked: page.linked,
    startsAt: page.startsAt,
    endsAt: page.endsAt,
    archivedRedirect: page.archivedRedirect,
    slots: template.slots,
    draft:
      draft !== null
        ? {
            versionNo: draft.versionNo,
            placements: readPlacements(template, draft.placements).placements,
            settings: parseStoredSettings(draft.settings, page),
            updatedAt: draft.updatedAt,
          }
        : {
            versionNo: null,
            placements: base ?? defaultPlacements(template, page, () => `default-${(n += 1)}`),
            settings: null,
            updatedAt: null,
          },
    published:
      published !== null && base !== null
        ? { versionNo: published.versionNo, placements: base }
        : null,
    versions: versions.map(versionView),
  };
}

/** A page's detail: settings, slots, draft, published version and version list. */
export async function viewPage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown },
  navigation = false,
): Promise<Result<PageDetailView, PageFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(input?.page);
  if (ref === null || isNavigation(ref) !== navigation)
    return err({ code: 'storefront.page-not-found' });
  return deps.unitOfWork.run<PageDetailView, PageFailure>(
    context.market,
    async () => {
      const detail = await detailOf(deps, context, ref);
      if (detail === null || (detail.systemKey === NAVIGATION_KEY) !== navigation) {
        return err({ code: 'storefront.page-not-found' } as const);
      }
      return ok(detail);
    },
    { readOnly: true },
  );
}

const isNavigation = (ref: PageRef): boolean => ref.kind === 'system' && ref.key === NAVIGATION_KEY;

/**
 * Locks the referenced page, creating a system page's row on its first change (audited). Refuses
 * a locked or archived page, and keeps the navigation to its own use cases.
 */
async function lockForChange(
  deps: StorefrontDependencies,
  context: CallContext,
  ref: PageRef,
  stamp: Stamp,
  navigation: boolean,
): Promise<
  | { readonly ok: true; readonly page: PageRecord }
  | { readonly ok: false; readonly error: PageFailure }
> {
  const market = context.market;
  let page =
    ref.kind === 'id'
      ? await deps.pages.lockPage(market, ref.id)
      : await deps.pages.findSystemPage(market, ref.key);
  if (page === null && ref.kind === 'system') {
    const definition = SYSTEM_PAGES.get(ref.key)!;
    if (definition.editLevel === 'locked')
      return { ok: false, error: { code: 'storefront.page-locked' } };
    const created: PageRecord = {
      id: deps.ids.next<'StorefrontPage'>(),
      kind: 'system',
      systemKey: ref.key,
      slug: null,
      templateKey: definition.templateKey,
      title: ref.key,
      seo: {},
      linked: null,
      startsAt: null,
      endsAt: null,
      archivedAt: null,
      archivedRedirect: null,
      createdAt: stamp.at,
      updatedAt: stamp.at,
    };
    // A concurrent first edit may insert the row first: this edit then goes onto that row.
    if (await deps.pages.insertSystemPageIfAbsent(market, created, stamp.by)) {
      await deps.audit.record(
        context,
        StorefrontPageCreated.entry(created.id, {
          after: { template: created.templateKey, linkedType: null },
        }),
      );
    }
    const row = await deps.pages.findSystemPage(market, ref.key);
    page = row === null ? null : await deps.pages.lockPage(market, row.id);
  } else if (page !== null && ref.kind === 'system') {
    page = await deps.pages.lockPage(market, page.id);
  }
  if (page === null) return { ok: false, error: { code: 'storefront.page-not-found' } };
  if ((page.systemKey === NAVIGATION_KEY) !== navigation) {
    return { ok: false, error: { code: 'storefront.page-not-found' } };
  }
  if (editLevelOf(page) === 'locked')
    return { ok: false, error: { code: 'storefront.page-locked' } };
  if (page.archivedAt !== null) return { ok: false, error: { code: 'storefront.page-archived' } };
  return { ok: true, page };
}

/** The page's draft, created from the published version (or the template's defaults) if none. */
async function draftOf(
  deps: StorefrontDependencies,
  context: CallContext,
  page: PageRecord,
  template: TemplateDefinition,
  stamp: Stamp,
): Promise<{ readonly draft: VersionRecord; readonly placements: Placements }> {
  const market = context.market;
  const existing = await deps.pages.findDraft(market, page.id);
  if (existing !== null) {
    return {
      draft: existing,
      placements: readPlacements(template, existing.placements).placements,
    };
  }
  const published = await deps.pages.findPublished(market, page.id);
  const placements =
    published !== null
      ? readPlacements(template, published.placements).placements
      : defaultPlacements(template, page, () => deps.ids.next<'StorefrontPlacement'>());
  const id = deps.ids.next<'StorefrontPageVersion'>();
  const versionNo = (await deps.pages.lastVersionNo(market, page.id)) + 1;
  const stored = storedPlacements(placements);
  await deps.pages.insertDraft(
    market,
    { id, pageId: page.id, versionNo, placements: stored },
    stamp,
  );
  return {
    draft: {
      id,
      pageId: page.id,
      versionNo,
      state: 'draft',
      placements: stored,
      settings: null,
      createdAt: stamp.at,
      updatedAt: stamp.at,
      publishedAt: null,
    },
    placements,
  };
}

type DraftChange = (
  template: TemplateDefinition,
  placements: Placements,
  page: PageRecord,
) =>
  | { readonly ok: true; readonly value: Placements; readonly module?: ModuleKey | null }
  | { readonly ok: false; readonly error: PlacementFailure | PageFailure };

/** Runs one change of a page's draft: lock, draft, change, store, audit, answer the detail. */
export async function changeDraft(
  deps: StorefrontDependencies,
  context: CallContext,
  pageInput: unknown,
  operation: 'add' | 'update' | 'remove' | 'reorder' | 'restore' | 'replace',
  change: DraftChange,
  navigation = false,
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(pageInput);
  if (ref === null) return err({ code: 'storefront.page-not-found' });
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, ref, stamp, navigation);
    if (!locked.ok) return err(locked.error);
    const template = templateOf(locked.page.templateKey);
    const { draft, placements } = await draftOf(deps, context, locked.page, template, stamp);
    const changed = change(template, placements, locked.page);
    if (!changed.ok) return err(changed.error);
    const tooLarge = sizeProblems(changed.value);
    if (tooLarge.length > 0) return err({ code: 'validation.failed', fields: tooLarge } as const);
    await deps.pages.updateDraft(context.market, draft.id, storedPlacements(changed.value), stamp);
    await deps.pages.updatePage(context.market, locked.page.id, {}, stamp);
    await deps.audit.record(
      context,
      StorefrontDraftChanged.entry(locked.page.id, {
        after: {
          operation,
          module: changed.module ?? null,
          versionNo: draft.versionNo,
          placementCount: placementCount(changed.value),
        },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: locked.page.id }))!);
  });
}

const slotKeyOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/u.test(value) ? value : null;

/** Adds a module to a slot of the page's draft. */
export function addModule(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly slot: unknown; readonly body: AddInput },
) {
  const slot = slotKeyOf(input?.slot);
  return changeDraft(deps, context, input?.page, 'add', (template, placements) => {
    if (slot === null) return { ok: false, error: { code: 'storefront.slot-not-found' } };
    const changed = addPlacement(
      template,
      placements,
      slot,
      input.body,
      deps.ids.next<'StorefrontPlacement'>(),
    );
    return changed.ok ? { ...changed, module: input.body.module as ModuleKey } : changed;
  });
}

/** Changes a module's settings, switches it on or off, or both. */
export function updateModule(
  deps: StorefrontDependencies,
  context: CallContext,
  input: {
    readonly page: unknown;
    readonly slot: unknown;
    readonly placementId: unknown;
    readonly body: { readonly config?: unknown; readonly enabled?: unknown };
  },
) {
  const slot = slotKeyOf(input?.slot);
  return changeDraft(deps, context, input?.page, 'update', (template, placements) => {
    if (slot === null) return { ok: false, error: { code: 'storefront.slot-not-found' } };
    const changed = updatePlacement(
      template,
      placements,
      slot,
      String(input.placementId),
      input.body,
    );
    const module = (placements[slot] ?? []).find((entry) => entry.id === input.placementId)?.module;
    return changed.ok ? { ...changed, module: module ?? null } : changed;
  });
}

export function removeModule(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly slot: unknown; readonly placementId: unknown },
) {
  const slot = slotKeyOf(input?.slot);
  return changeDraft(deps, context, input?.page, 'remove', (template, placements) => {
    if (slot === null) return { ok: false, error: { code: 'storefront.slot-not-found' } };
    const module = (placements[slot] ?? []).find((entry) => entry.id === input.placementId)?.module;
    const changed = removePlacement(template, placements, slot, String(input.placementId));
    return changed.ok ? { ...changed, module: module ?? null } : changed;
  });
}

export function reorderModules(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly slot: unknown; readonly placementIds: unknown },
) {
  const slot = slotKeyOf(input?.slot);
  return changeDraft(deps, context, input?.page, 'reorder', (template, placements) => {
    if (slot === null) return { ok: false, error: { code: 'storefront.slot-not-found' } };
    return reorderPlacements(template, placements, slot, input.placementIds);
  });
}

/**
 * Restores a version: copies an earlier version's modules into the draft (the version itself is
 * kept as it was). Like {@link changeDraft}, with the version read inside the same unit after
 * the page is locked.
 */
export async function restoreVersion(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly versionId: unknown },
  navigation = false,
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(input?.page);
  if (ref === null) return err({ code: 'storefront.page-not-found' });
  const parsed =
    typeof input?.versionId === 'string' ? parseId<'StorefrontPageVersion'>(input.versionId) : null;
  if (parsed === null || !parsed.ok) return err(invalid('versionId'));
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, ref, stamp, navigation);
    if (!locked.ok) return err(locked.error);
    const source = await deps.pages.findVersion(context.market, locked.page.id, parsed.value);
    if (source === null || source.state === 'draft') {
      return err({ code: 'storefront.version-not-found' } as const);
    }
    const template = templateOf(locked.page.templateKey);
    const restored = readPlacements(template, source.placements).placements;
    const { draft } = await draftOf(deps, context, locked.page, template, stamp);
    await deps.pages.updateDraft(context.market, draft.id, storedPlacements(restored), stamp);
    await deps.pages.updatePage(context.market, locked.page.id, {}, stamp);
    await deps.audit.record(
      context,
      StorefrontDraftChanged.entry(locked.page.id, {
        after: {
          operation: 'restore',
          module: null,
          versionNo: draft.versionNo,
          placementCount: placementCount(restored),
        },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: locked.page.id }))!);
  });
}

/** An admin creates a dynamic page from a template; its draft starts with the template's defaults. */
export async function createPage(
  deps: StorefrontDependencies,
  context: CallContext,
  body: unknown,
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parseNewPage(body);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
  const settings = parsed.value;
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    if (await slugTaken(deps, context, settings.slug, null)) {
      return err({ code: 'storefront.slug-taken' } as const);
    }
    const page: PageRecord = {
      id: deps.ids.next<'StorefrontPage'>(),
      kind: 'dynamic',
      systemKey: null,
      slug: settings.slug,
      templateKey: settings.templateKey,
      title: settings.title,
      seo: settings.seo,
      linked: settings.linked,
      startsAt: settings.startsAt,
      endsAt: settings.endsAt,
      archivedAt: null,
      archivedRedirect: null,
      createdAt: stamp.at,
      updatedAt: stamp.at,
    };
    await deps.pages.insertPage(context.market, page, stamp.by);
    await draftOf(deps, context, page, templateOf(page.templateKey), stamp);
    await deps.audit.record(
      context,
      StorefrontPageCreated.entry(page.id, {
        after: { template: page.templateKey, linkedType: page.linked?.type ?? null },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: page.id }))!);
  });
}

/** True when another page holds `slug`, or it is an old slug of another page. */
async function slugTaken(
  deps: StorefrontDependencies,
  context: CallContext,
  slug: string,
  self: Id<'StorefrontPage'> | null,
): Promise<boolean> {
  const holder = await deps.pages.findBySlug(context.market, slug);
  if (holder !== null && holder.id !== self) return true;
  const redirect = await deps.pages.findRedirect(context.market, slug);
  return redirect !== null && redirect !== self;
}

/**
 * An admin changes a page's settings. They go into the page's draft and reach buyers only when a
 * platform admin publishes it (security review H-1): a dynamic page's whole settings are
 * replaced, a system page changes its title and SEO fields only.
 */
export async function updateSettings(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly body: unknown },
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(input?.page);
  if (ref === null || isNavigation(ref)) return err({ code: 'storefront.page-not-found' });
  if (ref.kind === 'system') {
    const parsed = parseSystemSettings(input.body);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
  }
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, ref, stamp, false);
    if (!locked.ok) return err(locked.error);
    const page = locked.page;
    let pending: PendingSettings;
    if (page.kind === 'system') {
      const parsed = parseSystemSettings(input.body);
      if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems } as const);
      pending = { kind: 'system', ...parsed.value };
    } else {
      const parsed = parseDynamicSettings(input.body, page.templateKey);
      if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems } as const);
      // Checked again on publish, when the slug is taken.
      if (
        parsed.value.slug !== page.slug &&
        (await slugTaken(deps, context, parsed.value.slug, page.id))
      ) {
        return err({ code: 'storefront.slug-taken' } as const);
      }
      pending = { kind: 'dynamic', ...parsed.value };
    }
    const template = templateOf(page.templateKey);
    const { draft } = await draftOf(deps, context, page, template, stamp);
    await deps.pages.updateDraftSettings(context.market, draft.id, storedSettings(pending), stamp);
    await deps.pages.updatePage(context.market, page.id, {}, stamp);
    await deps.audit.record(
      context,
      StorefrontPageUpdated.entry(page.id, {
        after: {
          slugChanged: pending.kind === 'dynamic' && pending.slug !== page.slug,
          windowSet:
            pending.kind === 'dynamic' && (pending.startsAt !== null || pending.endsAt !== null),
        },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: page.id }))!);
  });
}

/** What the publisher reviewed: the draft's version number and last change time. */
function reviewedOf(
  body: unknown,
): { readonly versionNo: number; readonly updatedAt: Temporal.Instant } | Problems {
  const problems: Problems = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ path: '', code: 'format' }];
  }
  const { versionNo, updatedAt, ...rest } = body as Record<string, unknown>;
  for (const key of Object.keys(rest).slice(0, 5))
    problems.push({ path: key, code: 'unknown-field' });
  if (typeof versionNo !== 'number' || !Number.isInteger(versionNo) || versionNo < 1) {
    problems.push({ path: 'versionNo', code: versionNo === undefined ? 'required' : 'format' });
  }
  let reviewedAt: Temporal.Instant | null = null;
  if (typeof updatedAt === 'string' && updatedAt.length <= 40) {
    try {
      reviewedAt = Temporal.Instant.from(updatedAt);
    } catch {
      // Falls through to `format`.
    }
  }
  if (reviewedAt === null) {
    problems.push({ path: 'updatedAt', code: updatedAt === undefined ? 'required' : 'format' });
  }
  return problems.length > 0
    ? problems
    : { versionNo: versionNo as number, updatedAt: reviewedAt! };
}

/**
 * Puts a published draft's pending settings on the page row. A dynamic page's new slug must be
 * free; the old one, if buyers could reach it, then sends them to the new one.
 */
async function applySettings(
  deps: StorefrontDependencies,
  context: CallContext,
  page: PageRecord,
  pending: PendingSettings,
  wasPublished: boolean,
  stamp: Stamp,
): Promise<PageFailure | null> {
  const market = context.market;
  if (pending.kind === 'system') {
    await deps.pages.updatePage(market, page.id, { title: pending.title, seo: pending.seo }, stamp);
    return null;
  }
  const settings = {
    slug: pending.slug,
    title: pending.title,
    seo: pending.seo,
    linked: pending.linked,
    startsAt: pending.startsAt,
    endsAt: pending.endsAt,
  };
  if (settings.slug !== page.slug) {
    if (await slugTaken(deps, context, settings.slug, page.id)) {
      return { code: 'storefront.slug-taken' };
    }
    await deps.pages.deleteRedirect(market, settings.slug);
    if (wasPublished) {
      await deps.pages.insertRedirect(
        market,
        { id: deps.ids.next<'StorefrontRedirect'>(), fromSlug: page.slug!, pageId: page.id },
        stamp.at,
      );
    }
  }
  await deps.pages.updatePage(market, page.id, settings, stamp);
  return null;
}

/**
 * A platform admin publishes a page's draft (or, `navigation`, approves the navigation draft):
 * the draft must be the one they reviewed (its version number and last change time, security
 * review M-1) and fill every slot's minimum. Its pending settings go onto the page; the version
 * buyers saw is kept as `retired`.
 */
export async function publishPage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly body: unknown },
  navigation = false,
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(input?.page);
  if (ref === null) return err({ code: 'storefront.page-not-found' });
  const reviewed = reviewedOf(input.body);
  if (Array.isArray(reviewed)) return err({ code: 'validation.failed', fields: reviewed });
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    if (
      ref.kind === 'system' &&
      (await deps.pages.findSystemPage(context.market, ref.key)) === null
    ) {
      if (SYSTEM_PAGES.get(ref.key)!.editLevel === 'locked') {
        return err({ code: 'storefront.page-locked' } as const);
      }
      if (isNavigation(ref) !== navigation)
        return err({ code: 'storefront.page-not-found' } as const);
      return err({ code: 'storefront.nothing-to-publish' } as const);
    }
    const locked = await lockForChange(deps, context, ref, stamp, navigation);
    if (!locked.ok) return err(locked.error);
    const page = locked.page;
    const draft = await deps.pages.findDraft(context.market, page.id);
    if (draft === null) return err({ code: 'storefront.nothing-to-publish' } as const);
    if (draft.versionNo !== reviewed.versionNo || !draft.updatedAt.equals(reviewed.updatedAt)) {
      return err({ code: 'storefront.draft-changed' } as const);
    }
    const pending = parseStoredSettings(draft.settings, page);
    const linked = pending?.kind === 'dynamic' ? pending.linked : page.linked;
    const template = templateOf(page.templateKey);
    const { placements } = readPlacements(template, draft.placements);
    const problems = publishProblems(template, placements, linked?.type ?? null);
    if (problems.length > 0) return err({ code: 'validation.failed', fields: problems } as const);
    const wasPublished = (await deps.pages.findPublished(context.market, page.id)) !== null;
    if (pending !== null) {
      const refused = await applySettings(deps, context, page, pending, wasPublished, stamp);
      if (refused !== null) return err(refused);
    } else {
      await deps.pages.updatePage(context.market, page.id, {}, stamp);
    }
    // The stored draft is rewritten as checked now, so what is published is what was checked.
    await deps.pages.updateDraft(context.market, draft.id, storedPlacements(placements), stamp);
    await deps.pages.publishDraft(context.market, page.id, draft.id, stamp);
    await deps.audit.record(
      context,
      StorefrontPagePublished.entry(page.id, {
        after: {
          versionNo: draft.versionNo,
          placementCount: placementCount(placements),
          navigation,
        },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: page.id }))!);
  });
}

/** A platform admin archives a dynamic page; its URL then sends buyers to `redirectTo`, or is gone. */
export async function archivePage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly page: unknown; readonly body: unknown },
): Promise<Result<PageDetailView, PageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const ref = pageRefOf(input?.page);
  if (ref === null) return err({ code: 'storefront.page-not-found' });
  if (ref.kind === 'system') return err({ code: 'storefront.page-locked' });
  const parsed = parseArchive(input.body);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PageDetailView, PageFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, ref, stamp, false);
    if (!locked.ok) return err(locked.error);
    if (locked.page.kind !== 'dynamic') return err({ code: 'storefront.page-locked' } as const);
    // A landing page sends buyers only to a landing page that is still up (no redirect loop).
    const target = /^\/l\/([a-z0-9-]+)$/u.exec(parsed.value.redirectTo ?? '')?.[1];
    if (target !== undefined) {
      const to = await deps.pages.findBySlug(context.market, target);
      if (to === null || to.id === locked.page.id || to.archivedAt !== null) {
        return err(invalid('redirectTo', 'not-live'));
      }
    }
    await deps.pages.updatePage(
      context.market,
      locked.page.id,
      { archivedAt: stamp.at, archivedRedirect: parsed.value.redirectTo },
      stamp,
    );
    await deps.audit.record(
      context,
      StorefrontPageArchived.entry(locked.page.id, {
        after: { redirected: parsed.value.redirectTo !== null },
      }),
    );
    return ok((await detailOf(deps, context, { kind: 'id', id: locked.page.id }))!);
  });
}
