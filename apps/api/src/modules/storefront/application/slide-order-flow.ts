import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { StorefrontSlideReordered } from '../domain/audit';
import type { Problems } from '../domain/fields';
import { parseReorder, reorderMismatch } from '../domain/slides';
import { adminOf } from './page-flow';
import type { SlideStamp } from './ports/slide.repository';
import { slideIdOf, type SlideFailure } from './slide-flow';
import type { StorefrontDependencies } from './storefront-dependencies';

// Reordering the live slides of a position (john, 24 Oct): an editor with storefront.slide.edit
// saves the order of the slides that are approved at one position and scope, and it takes effect
// at once with no approval. Only the order changes: the content, the window and every other field
// of a placement still need storefront.slide.publish through submit and approve.
//
// Locks: every named slide row in id order, then the position row (the same order approve and
// resume use: a slide, then its positions), so two reorders cannot wait on each other and a
// reorder cannot deadlock with an approval. The set of live slides is read after the position
// lock, so an approval that committed meanwhile is seen and a later one waits for this unit.

export type ReorderFailure =
  | SlideFailure
  /** The list is not exactly the live slides of the position and scope (it changed, or is partial). */
  | { readonly code: 'storefront.slide-order-mismatch'; readonly fields: Problems };

export interface LiveOrderView {
  readonly position: string;
  readonly scope: string;
  readonly scopeId: string | null;
  /** The slides in the order saved, first shown first. */
  readonly slideIds: readonly string[];
}

export async function reorderLiveSlides(
  deps: StorefrontDependencies,
  context: CallContext,
  body: unknown,
): Promise<Result<LiveOrderView, ReorderFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parseReorder(body);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
  const input = parsed.value;
  const where = { position: input.position, scope: input.scope, scopeId: input.scopeId };
  const stamp: SlideStamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<LiveOrderView, ReorderFailure>(context.market, async () => {
    // Slide rows first, in id order; a slide of another Market is not found, like an unknown id.
    const unknown: Problems = [];
    const ids = input.slideIds.map((raw, index) => ({ raw, index, id: slideIdOf(raw) }));
    const sorted = [...ids].sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
    for (const entry of sorted) {
      const locked =
        entry.id === null ? null : await deps.slides.lockSlide(context.market, entry.id);
      if (locked === null) unknown.push({ path: `slideIds[${entry.index}]`, code: 'not-found' });
    }
    if (unknown.length > 0) {
      return err({ code: 'validation.failed', fields: unknown.sort(byIndex) } as const);
    }

    await deps.slides.lockPositions(context.market, [input.position], stamp.at);
    const live = await deps.slides.livePlacementsAt(context.market, where, stamp.at);
    const before = live.map((placement) => placement.slideId as string);
    const mismatch = reorderMismatch(input.slideIds, before);
    if (mismatch.length > 0) {
      return err({ code: 'storefront.slide-order-mismatch', fields: mismatch } as const);
    }

    await deps.slides.setLiveOrder(
      context.market,
      where,
      ids.map((entry) => ({ slideId: entry.id as Id<'StorefrontSlide'>, sortOrder: entry.index })),
      stamp,
    );
    const snapshot = (order: readonly string[]) => ({
      scope: input.scope,
      scopeId: input.scopeId as Id | null,
      order: order as readonly Id[],
    });
    await deps.audit.record(
      context,
      StorefrontSlideReordered.entry(input.position, {
        before: snapshot(before),
        after: snapshot(input.slideIds),
      }),
    );
    return ok({ ...where, slideIds: input.slideIds });
  });
}

const byIndex = (a: { path: string }, b: { path: string }): number =>
  Number(/\d+/u.exec(a.path)?.[0]) - Number(/\d+/u.exec(b.path)?.[0]);
