import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  StorefrontSlidePaused,
  StorefrontSlidePublished,
  StorefrontSlideResumed,
  StorefrontSlideSubmitted,
} from '../domain/audit';
import type { Problems } from '../domain/fields';
import { positionOf } from '../domain/slide-positions';
import {
  capExceeded,
  readContent,
  readPlacements,
  windowProblems,
  type SlidePlacement,
  type SlideWindow,
} from '../domain/slides';
import { adminOf } from './page-flow';
import { targetKey, type SlideTarget } from './ports/slide-targets';
import type { PlacementRow, SlideRecord, SlideStamp } from './ports/slide.repository';
import {
  detailOf,
  invalidField,
  lockForChange,
  type SlideDetailView,
  type SlideFailure,
} from './slide-flow';
import type { StorefrontDependencies } from './storefront-dependencies';

// The approval side of the slide library: an editor sends a draft for approval; only a platform
// admin (storefront.slide.publish) approves it, which makes it the live version and rebuilds the
// placement projection; an editor with storefront.slide.pause stops a slide at once with no
// approval; resuming needs the publish key again. Every change locks the slide first, and the
// positions it touches while it checks their maximums (two approvals cannot both pass), and is
// audited.

const isEnded = (window: SlideWindow, now: Temporal.Instant): boolean =>
  Temporal.Instant.compare(now, window.endsAt) >= 0;

/** The positions where `placements` would put one more slide than the position allows. */
async function fullPositions(
  deps: StorefrontDependencies,
  context: CallContext,
  slide: SlideRecord,
  window: SlideWindow,
  placements: readonly SlidePlacement[],
): Promise<Problems> {
  const full: Problems = [];
  for (const [index, placement] of placements.entries()) {
    const position = positionOf(placement.position);
    if (position === null) continue;
    const placed = await deps.slides.placedAt(
      context.market,
      placement.position,
      window.startsAt,
      window.endsAt,
    );
    const candidate = {
      slideId: slide.id as string,
      ...window,
      scope: placement.scope,
      scopeId: placement.scopeId,
      includeSubcategories: placement.includeSubcategories,
    };
    if (capExceeded(candidate, placed, position.maxActive)) {
      full.push({ path: `placements[${index}].position`, code: 'full' });
    }
  }
  return full;
}

function projectionOf(
  deps: StorefrontDependencies,
  slide: SlideRecord,
  window: SlideWindow,
  placements: readonly SlidePlacement[],
): PlacementRow[] {
  return placements.map((placement) => ({
    id: deps.ids.next<'StorefrontSlidePlacement'>(),
    slideId: slide.id,
    position: placement.position,
    scope: placement.scope,
    scopeId: placement.scopeId,
    includeSubcategories: placement.includeSubcategories,
    sortOrder: placement.sortOrder,
    autoplay: placement.autoplay,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  }));
}

/**
 * The link and the scope ids of the draft that do not point at something live in this Market: a
 * page that exists and is not archived, a category in the public tree, a published product, a
 * seller who may sell. An answer that could not be had counts against the draft (fail closed).
 */
async function unresolvedTargets(
  deps: StorefrontDependencies,
  context: CallContext,
  slide: SlideRecord,
  draft: { readonly content: unknown },
  placements: readonly SlidePlacement[],
): Promise<Problems> {
  const wanted: { path: string; type: string; id: string }[] = [];
  const link = readContent(slide.kind, draft.content)?.link ?? null;
  if (link !== null) wanted.push({ path: 'content.link', type: link.type, id: link.id });
  for (const [index, placement] of placements.entries()) {
    if (placement.scope !== 'all' && placement.scopeId !== null) {
      wanted.push({
        path: `placements[${index}].scopeId`,
        type: placement.scope,
        id: placement.scopeId,
      });
    }
  }
  const failed: Problems = [];
  const toFacade: SlideTarget[] = [];
  for (const entry of wanted) {
    if (entry.type === 'page') {
      const page = await deps.pages.findPage(context.market, entry.id as Id<'StorefrontPage'>);
      if (page === null || page.archivedAt !== null) {
        failed.push({ path: entry.path, code: 'not-found' });
      }
    } else if (entry.type === 'category' || entry.type === 'product' || entry.type === 'seller') {
      toFacade.push({ type: entry.type, id: entry.id });
    }
    // A prepared search is named by a code, checked by its format when the draft was saved.
  }
  if (toFacade.length > 0) {
    const live = await deps.targets.live(context, toFacade);
    for (const entry of wanted) {
      if (entry.type !== 'category' && entry.type !== 'product' && entry.type !== 'seller')
        continue;
      const key = targetKey({ type: entry.type, id: entry.id });
      if (live === null) failed.push({ path: entry.path, code: 'unverifiable' });
      else if (!live.has(key)) failed.push({ path: entry.path, code: 'not-found' });
    }
  }
  return failed;
}

const reload = async (deps: StorefrontDependencies, context: CallContext, slide: SlideRecord) =>
  detailOf(deps, context, (await deps.slides.findSlide(context.market, slide.id))!);

/** An editor sends the draft for approval; buyers still see the live version, if any. */
export async function submitSlide(
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
    const slide = locked.slide;
    if (slide.draftVersionId === null) return err({ code: 'storefront.slide-no-draft' } as const);
    const draft = await deps.slides.findVersion(context.market, slide.id, slide.draftVersionId);
    if (draft === null) return err({ code: 'storefront.slide-no-draft' } as const);
    if (isEnded(draft, stamp.at)) return err({ code: 'storefront.slide-ended' } as const);
    await deps.slides.updateSlide(
      context.market,
      slide.id,
      { submittedVersionId: draft.id },
      stamp,
    );
    await deps.audit.record(
      context,
      StorefrontSlideSubmitted.entry(slide.id, { after: { versionNo: draft.versionNo } }),
    );
    return ok(await reload(deps, context, slide));
  });
}

/**
 * A platform admin approves the submitted draft the admin reviewed (`versionNo`): it becomes the
 * live version (with the approver and time on it), the slide takes its window and flags, and the
 * placement projection is rebuilt, unless the slide is paused (resuming does that). Refused when
 * a position would exceed its maximum active slides in an overlapping window.
 */
export async function approveSlide(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slide: unknown; readonly body: unknown },
): Promise<Result<SlideDetailView, SlideFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const reviewed = (input?.body as { versionNo?: unknown } | null)?.versionNo;
  if (typeof reviewed !== 'number' || !Number.isInteger(reviewed) || reviewed < 1) {
    return err(invalidField('versionNo', reviewed === undefined ? 'required' : 'format'));
  }
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<SlideDetailView, SlideFailure>(context.market, async () => {
    const locked = await lockForChange(deps, context, input.slide);
    if (!locked.ok) return err(locked.error);
    const slide = locked.slide;
    const draft =
      slide.draftVersionId === null
        ? null
        : await deps.slides.findVersion(context.market, slide.id, slide.draftVersionId);
    if (draft === null) return err({ code: 'storefront.slide-no-draft' } as const);
    if (draft.versionNo !== reviewed)
      return err({ code: 'storefront.slide-draft-changed' } as const);
    if (slide.submittedVersionId !== draft.id) {
      return err({ code: 'storefront.slide-not-submitted' } as const);
    }
    const problems = windowProblems(draft);
    const placements = readPlacements(draft.placements);
    if (placements.length === 0) problems.push({ path: 'placements', code: 'count' });
    if (problems.length > 0) return err({ code: 'validation.failed', fields: problems } as const);
    if (isEnded(draft, stamp.at)) return err({ code: 'storefront.slide-ended' } as const);

    const unresolved = await unresolvedTargets(deps, context, slide, draft, placements);
    if (unresolved.length > 0) {
      return err({ code: 'storefront.slide-link-invalid', fields: unresolved } as const);
    }

    const project = slide.state !== 'paused';
    if (project) {
      await deps.slides.lockPositions(
        context.market,
        placements.map((p) => p.position),
        stamp.at,
      );
      const full = await fullPositions(deps, context, slide, draft, placements);
      if (full.length > 0)
        return err({ code: 'storefront.slide-position-full', fields: full } as const);
    }
    await deps.slides.markApproved(context.market, draft.id, stamp);
    await deps.slides.updateSlide(
      context.market,
      slide.id,
      {
        state: project ? 'approved' : 'paused',
        liveVersionId: draft.id,
        draftVersionId: null,
        submittedVersionId: null,
        internalName: draft.internalName,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        pinned: draft.pinned,
        sponsored: draft.sponsored,
      },
      stamp,
    );
    if (project) {
      await deps.slides.replacePlacements(
        context.market,
        slide.id,
        projectionOf(deps, slide, draft, placements),
      );
    }
    await deps.audit.record(
      context,
      StorefrontSlidePublished.entry(slide.id, {
        after: {
          versionNo: draft.versionNo,
          placementCount: placements.length,
          selfApproved: draft.createdBy === admin.accountId,
        },
      }),
    );
    return ok(await reload(deps, context, slide));
  });
}

/** An editor with the pause key stops an approved slide at once: its placements are removed. */
export async function pauseSlide(
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
    const slide = locked.slide;
    if (slide.state !== 'approved' || slide.liveVersionId === null || isEnded(slide, stamp.at)) {
      return err({ code: 'storefront.slide-not-live' } as const);
    }
    const live = await deps.slides.findVersion(context.market, slide.id, slide.liveVersionId);
    await deps.slides.replacePlacements(context.market, slide.id, []);
    await deps.slides.updateSlide(context.market, slide.id, { state: 'paused' }, stamp);
    await deps.audit.record(
      context,
      StorefrontSlidePaused.entry(slide.id, { after: { versionNo: live?.versionNo ?? 0 } }),
    );
    return ok(await reload(deps, context, slide));
  });
}

/** A platform admin resumes a paused slide: its live version is served again, caps re-checked. */
export async function resumeSlide(
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
    const slide = locked.slide;
    if (slide.state !== 'paused' || slide.liveVersionId === null) {
      return err({ code: 'storefront.slide-not-paused' } as const);
    }
    if (isEnded(slide, stamp.at)) return err({ code: 'storefront.slide-ended' } as const);
    const live = await deps.slides.findVersion(context.market, slide.id, slide.liveVersionId);
    if (live === null) return err({ code: 'storefront.slide-not-paused' } as const);
    const placements = readPlacements(live.placements);
    await deps.slides.lockPositions(
      context.market,
      placements.map((p) => p.position),
      stamp.at,
    );
    const full = await fullPositions(deps, context, slide, slide, placements);
    if (full.length > 0)
      return err({ code: 'storefront.slide-position-full', fields: full } as const);
    await deps.slides.replacePlacements(
      context.market,
      slide.id,
      projectionOf(deps, slide, slide, placements),
    );
    await deps.slides.updateSlide(context.market, slide.id, { state: 'approved' }, stamp);
    await deps.audit.record(
      context,
      StorefrontSlideResumed.entry(slide.id, { after: { versionNo: live.versionNo } }),
    );
    return ok(await reload(deps, context, slide));
  });
}
