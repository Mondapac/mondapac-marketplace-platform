import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  StorefrontSlideArchived,
  StorefrontSlideCreated,
  StorefrontSlideDraftChanged,
} from '../domain/audit';
import type { Problems } from '../domain/fields';
import {
  MAX_VERSIONS_PER_SLIDE,
  parseDraft,
  parseNewSlide,
  readContent,
  readPlacements,
  statusOf,
  storedContent,
  storedPlacements,
  type SlideContent,
  type SlideDraftInput,
  type SlidePlacement,
  type SlideStatus,
} from '../domain/slides';
import { POSITION_KEYS } from '../domain/slide-positions';
import { adminOf } from './page-flow';
import type { SlideRecord, SlideStamp, SlideVersionRecord } from './ports/slide.repository';
import type { StorefrontDependencies } from './storefront-dependencies';

// The admin side of the slide library: slides of one Market, each with insert-only versions. An
// editor creates a slide (a draft), changes the draft (every save is a new version), restores an
// earlier version, copies a slide out for another Market and archives it. Approving, pausing and
// resuming are in slide-approval-flow. Every method works inside one unit of work in the
// request's Market, so a slide of another Market is never found; every change locks the slide row
// first, and is audited.

export type SlideFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: Problems }
  | { readonly code: 'storefront.slide-not-found' }
  | { readonly code: 'storefront.slide-version-not-found' }
  | { readonly code: 'storefront.slide-archived' }
  | { readonly code: 'storefront.slide-version-limit' };

export const MAX_SLIDES_LISTED = 500;
export const MAX_SLIDE_VERSIONS_SHOWN = 50;

export interface SlideVersionView {
  readonly id: Id<'StorefrontSlideVersion'>;
  readonly versionNo: number;
  readonly internalName: string;
  readonly content: SlideContent | null;
  readonly placements: readonly SlidePlacement[];
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly createdAt: Temporal.Instant;
  readonly approvedAt: Temporal.Instant | null;
}

export interface SlideSummaryView {
  readonly id: Id<'StorefrontSlide'>;
  readonly kind: SlideRecord['kind'];
  readonly internalName: string;
  readonly status: SlideStatus;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly hasDraft: boolean;
  /** The positions of the draft, or of the live version when there is no draft. */
  readonly positions: readonly string[];
  readonly updatedAt: Temporal.Instant;
}

export interface SlideDetailView extends SlideSummaryView {
  readonly draft: SlideVersionView | null;
  readonly live: SlideVersionView | null;
  /** The draft was sent for approval. */
  readonly pending: boolean;
  /** Newest first, at most {@link MAX_SLIDE_VERSIONS_SHOWN}. */
  readonly versions: readonly {
    readonly id: Id<'StorefrontSlideVersion'>;
    readonly versionNo: number;
    readonly createdAt: Temporal.Instant;
    readonly approvedAt: Temporal.Instant | null;
  }[];
}

/** A slide as another Market's editor can create it from: what the copy action hands out. */
export interface SlideCopyPackage {
  readonly kind: SlideRecord['kind'];
  readonly internalName: string;
  readonly content: SlideContent | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly placements: readonly SlidePlacement[];
}

export function slideIdOf(value: unknown): Id<'StorefrontSlide'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'StorefrontSlide'>(value);
  return parsed.ok ? parsed.value : null;
}

export const versionIdOf = (value: unknown): Id<'StorefrontSlideVersion'> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'StorefrontSlideVersion'>(value);
  return parsed.ok ? parsed.value : null;
};

export const invalidField = (path: string, code = 'format'): SlideFailure => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

export function versionView(
  version: SlideVersionRecord,
  kind: SlideRecord['kind'],
): SlideVersionView {
  return {
    id: version.id,
    versionNo: version.versionNo,
    internalName: version.internalName,
    content: readContent(kind, version.content),
    placements: readPlacements(version.placements),
    startsAt: version.startsAt,
    endsAt: version.endsAt,
    pinned: version.pinned,
    sponsored: version.sponsored,
    createdAt: version.createdAt,
    approvedAt: version.approvedAt,
  };
}

export const statusOfSlide = (slide: SlideRecord, now: Temporal.Instant): SlideStatus =>
  statusOf(slide, now);

/** The detail of a slide as it now stands, read inside the caller's unit. */
export async function detailOf(
  deps: StorefrontDependencies,
  context: CallContext,
  slide: SlideRecord,
): Promise<SlideDetailView> {
  const market = context.market;
  const versions = await deps.slides.versions(market, slide.id, MAX_SLIDE_VERSIONS_SHOWN);
  const find = (id: string | null) =>
    id === null ? null : (versions.find((v) => v.id === id) ?? null);
  const draftRow =
    find(slide.draftVersionId) ??
    (slide.draftVersionId === null
      ? null
      : await deps.slides.findVersion(market, slide.id, slide.draftVersionId));
  const liveRow =
    find(slide.liveVersionId) ??
    (slide.liveVersionId === null
      ? null
      : await deps.slides.findVersion(market, slide.id, slide.liveVersionId));
  const draft = draftRow === null ? null : versionView(draftRow, slide.kind);
  const live = liveRow === null ? null : versionView(liveRow, slide.kind);
  return {
    ...summaryOf(slide, draft ?? live, deps.clock.now()),
    draft,
    live,
    pending: slide.draftVersionId !== null && slide.draftVersionId === slide.submittedVersionId,
    versions: versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      createdAt: v.createdAt,
      approvedAt: v.approvedAt,
    })),
  };
}

function summaryOf(
  slide: SlideRecord,
  current: { readonly placements: readonly SlidePlacement[] } | null,
  now: Temporal.Instant,
): SlideSummaryView {
  return {
    id: slide.id,
    kind: slide.kind,
    internalName: slide.internalName,
    status: statusOf(slide, now),
    startsAt: slide.startsAt,
    endsAt: slide.endsAt,
    pinned: slide.pinned,
    sponsored: slide.sponsored,
    hasDraft: slide.draftVersionId !== null,
    positions: [...new Set((current?.placements ?? []).map((p) => p.position))],
    updatedAt: slide.updatedAt,
  };
}

/** Locks a slide for change: found in this Market, not archived. */
export async function lockForChange(
  deps: StorefrontDependencies,
  context: CallContext,
  idInput: unknown,
): Promise<
  | { readonly ok: true; readonly slide: SlideRecord }
  | { readonly ok: false; readonly error: SlideFailure }
> {
  const id = slideIdOf(idInput);
  if (id === null) return { ok: false, error: { code: 'storefront.slide-not-found' } };
  const slide = await deps.slides.lockSlide(context.market, id);
  if (slide === null) return { ok: false, error: { code: 'storefront.slide-not-found' } };
  if (slide.state === 'archived')
    return { ok: false, error: { code: 'storefront.slide-archived' } };
  return { ok: true, slide };
}

/** Inserts the next version of a slide as its draft; the version is never changed again. */
export async function insertDraftVersion(
  deps: StorefrontDependencies,
  context: CallContext,
  slide: SlideRecord,
  source: {
    readonly internalName: string;
    readonly content: unknown;
    readonly placements: unknown;
    readonly startsAt: Temporal.Instant;
    readonly endsAt: Temporal.Instant;
    readonly pinned: boolean;
    readonly sponsored: boolean;
  },
  stamp: SlideStamp,
): Promise<
  | { readonly ok: true; readonly version: SlideVersionRecord }
  | { readonly ok: false; readonly error: SlideFailure }
> {
  const last = await deps.slides.lastVersionNo(context.market, slide.id);
  if (last >= MAX_VERSIONS_PER_SLIDE) {
    return { ok: false, error: { code: 'storefront.slide-version-limit' } };
  }
  const version = {
    id: deps.ids.next<'StorefrontSlideVersion'>(),
    slideId: slide.id,
    versionNo: last + 1,
    internalName: source.internalName,
    content: source.content,
    placements: source.placements,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    pinned: source.pinned,
    sponsored: source.sponsored,
    createdAt: stamp.at,
    createdBy: stamp.by,
  };
  await deps.slides.insertVersion(context.market, version);
  return { ok: true, version: { ...version, approvedBy: null, approvedAt: null } };
}

/** An editor creates a slide; its first version is the draft. */
export async function createSlide(
  deps: StorefrontDependencies,
  context: CallContext,
  body: unknown,
): Promise<Result<SlideDetailView, SlideFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parseNewSlide(body);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
  const input = parsed.value;
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(context.market, async () => {
    const slide: SlideRecord = {
      id: deps.ids.next<'StorefrontSlide'>(),
      kind: input.kind,
      internalName: input.internalName,
      state: 'draft',
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      pinned: input.pinned,
      sponsored: input.sponsored,
      liveVersionId: null,
      draftVersionId: null,
      submittedVersionId: null,
      createdAt: stamp.at,
      updatedAt: stamp.at,
    };
    await deps.slides.insertSlide(context.market, slide, stamp.by);
    const inserted = await insertDraftVersion(deps, context, slide, storedDraft(input), stamp);
    if (!inserted.ok) return err(inserted.error);
    await deps.slides.updateSlide(
      context.market,
      slide.id,
      { draftVersionId: inserted.version.id },
      stamp,
    );
    await deps.audit.record(
      context,
      StorefrontSlideCreated.entry(slide.id, {
        after: {
          kind: input.kind,
          versionNo: inserted.version.versionNo,
          placementCount: input.placements.length,
        },
      }),
    );
    const stored = (await deps.slides.findSlide(context.market, slide.id))!;
    return ok(await detailOf(deps, context, stored));
  });
}

function storedDraft(input: SlideDraftInput) {
  return {
    internalName: input.internalName,
    content: storedContent(input.content),
    placements: storedPlacements(input.placements),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    pinned: input.pinned,
    sponsored: input.sponsored,
  };
}

/** Points the slide at a new draft (and withdraws any submission); a never-approved slide shows it. */
async function setDraft(
  deps: StorefrontDependencies,
  context: CallContext,
  slide: SlideRecord,
  version: SlideVersionRecord,
  stamp: SlideStamp,
): Promise<void> {
  await deps.slides.updateSlide(
    context.market,
    slide.id,
    {
      draftVersionId: version.id,
      submittedVersionId: null,
      ...(slide.liveVersionId === null
        ? {
            internalName: version.internalName,
            startsAt: version.startsAt,
            endsAt: version.endsAt,
            pinned: version.pinned,
            sponsored: version.sponsored,
          }
        : {}),
    },
    stamp,
  );
}

/** An editor replaces the draft: the whole body again, saved as a new version. */
export async function updateSlideDraft(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown; readonly body: unknown },
): Promise<Result<SlideDetailView, SlideFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, input?.slide);
    if (!locked.ok) return err(locked.error);
    const parsed = parseDraft(locked.slide.kind, input.body);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
    const inserted = await insertDraftVersion(
      deps,
      context,
      locked.slide,
      storedDraft(parsed.value),
      stamp,
    );
    if (!inserted.ok) return err(inserted.error);
    await setDraft(deps, context, locked.slide, inserted.version, stamp);
    await deps.audit.record(
      context,
      StorefrontSlideDraftChanged.entry(locked.slide.id, {
        after: {
          operation: 'update',
          versionNo: inserted.version.versionNo,
          placementCount: parsed.value.placements.length,
        },
      }),
    );
    const stored = (await deps.slides.findSlide(context.market, locked.slide.id))!;
    return ok(await detailOf(deps, context, stored));
  });
}

/** An editor copies an earlier version into a new draft (the version itself stays as it was). */
export async function restoreSlideVersion(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown; readonly versionId: unknown },
): Promise<Result<SlideDetailView, SlideFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const versionId = versionIdOf(input?.versionId);
  if (versionId === null) return err(invalidField('versionId'));
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, input.slide);
    if (!locked.ok) return err(locked.error);
    const source = await deps.slides.findVersion(context.market, locked.slide.id, versionId);
    if (source === null) return err({ code: 'storefront.slide-version-not-found' } as const);
    const inserted = await insertDraftVersion(deps, context, locked.slide, source, stamp);
    if (!inserted.ok) return err(inserted.error);
    await setDraft(deps, context, locked.slide, inserted.version, stamp);
    await deps.audit.record(
      context,
      StorefrontSlideDraftChanged.entry(locked.slide.id, {
        after: {
          operation: 'restore',
          versionNo: inserted.version.versionNo,
          placementCount: readPlacements(source.placements).length,
        },
      }),
    );
    const stored = (await deps.slides.findSlide(context.market, locked.slide.id))!;
    return ok(await detailOf(deps, context, stored));
  });
}

export async function viewSlide(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown },
): Promise<Result<SlideDetailView, SlideFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const id = slideIdOf(input?.slide);
  if (id === null) return err({ code: 'storefront.slide-not-found' });
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(
    context.market,
    async () => {
      const slide = await deps.slides.findSlide(context.market, id);
      if (slide === null) return err({ code: 'storefront.slide-not-found' } as const);
      return ok(await detailOf(deps, context, slide));
    },
    { readOnly: true },
  );
}

const STATUSES: readonly SlideStatus[] = [
  'draft',
  'pending',
  'scheduled',
  'live',
  'ended',
  'paused',
  'archived',
];

/** The slides of the Market, newest first; optionally only one status and/or one position. */
export async function listSlides(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly state?: unknown; readonly position?: unknown },
): Promise<Result<readonly SlideSummaryView[], SlideFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const problems: Problems = [];
  const state = input?.state ?? undefined;
  const position = input?.position ?? undefined;
  if (state !== undefined && !STATUSES.includes(state as SlideStatus)) {
    problems.push({ path: 'state', code: 'enum' });
  }
  if (position !== undefined && !POSITION_KEYS.includes(position as string)) {
    problems.push({ path: 'position', code: 'enum' });
  }
  if (problems.length > 0) return err({ code: 'validation.failed', fields: problems });
  const now = deps.clock.now();
  return deps.unitOfWork.run<readonly SlideSummaryView[], SlideFailure>(
    context.market,
    async () => {
      const slides = await deps.slides.listSlides(context.market, MAX_SLIDES_LISTED);
      const ids = slides.flatMap((s) => {
        const current = s.draftVersionId ?? s.liveVersionId;
        return current === null ? [] : [current];
      });
      const versions = new Map(
        (await deps.slides.versionsByIds(context.market, ids)).map((v) => [v.id as string, v]),
      );
      const summaries = slides.map((slide) => {
        const current = versions.get(slide.draftVersionId ?? slide.liveVersionId ?? '');
        return summaryOf(
          slide,
          current === undefined ? null : { placements: readPlacements(current.placements) },
          now,
        );
      });
      return ok(
        summaries.filter(
          (s) =>
            (state === undefined || s.status === state) &&
            (position === undefined || s.positions.includes(position as string)),
        ),
      );
    },
    { readOnly: true },
  );
}

/**
 * What an editor of another Market needs to create the same slide there. There is no cross-Market
 * admin (ADR-0018), so the copy is two steps, each in its own Market: this read (storefront.slide.
 * read here), then `createSlide` there (storefront.slide.edit there). Scopes are reset to "all":
 * their ids belong to this Market's catalogue.
 */
export async function prepareSlideCopy(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown },
): Promise<Result<SlideCopyPackage, SlideFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const id = slideIdOf(input?.slide);
  if (id === null) return err({ code: 'storefront.slide-not-found' });
  return deps.unitOfWork.run<SlideCopyPackage, SlideFailure>(
    context.market,
    async () => {
      const slide = await deps.slides.findSlide(context.market, id);
      if (slide === null) return err({ code: 'storefront.slide-not-found' } as const);
      const current = await deps.slides.versionsByIds(
        context.market,
        [slide.draftVersionId ?? slide.liveVersionId].filter((v) => v !== null),
      );
      const version = current[0];
      if (version === undefined)
        return err({ code: 'storefront.slide-version-not-found' } as const);
      const seen = new Set<string>();
      const placements: SlidePlacement[] = [];
      for (const placement of readPlacements(version.placements)) {
        if (seen.has(placement.position)) continue;
        seen.add(placement.position);
        placements.push({ ...placement, scope: 'all', scopeId: null, includeSubcategories: false });
      }
      return ok({
        kind: slide.kind,
        internalName: version.internalName,
        content: readContent(slide.kind, version.content),
        startsAt: version.startsAt.toString(),
        endsAt: version.endsAt.toString(),
        pinned: version.pinned,
        sponsored: version.sponsored,
        placements,
      });
    },
    { readOnly: true },
  );
}

/** An editor archives a slide: it is never served again and takes no further change. */
export async function archiveSlide(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown },
): Promise<Result<SlideDetailView, SlideFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, input?.slide);
    if (!locked.ok) return err(locked.error);
    await deps.slides.replacePlacements(context.market, locked.slide.id, []);
    await deps.slides.updateSlide(
      context.market,
      locked.slide.id,
      { state: 'archived', draftVersionId: null, submittedVersionId: null },
      stamp,
    );
    await deps.audit.record(
      context,
      StorefrontSlideArchived.entry(locked.slide.id, {
        after: { wasApproved: locked.slide.liveVersionId !== null },
      }),
    );
    const stored = (await deps.slides.findSlide(context.market, locked.slide.id))!;
    return ok(await detailOf(deps, context, stored));
  });
}
