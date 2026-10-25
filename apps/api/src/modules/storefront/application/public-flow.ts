import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { isSlug, type Linked, type Seo } from '../domain/page-settings';
import {
  defaultPlacements,
  readPlacements,
  servedSlots,
  type ServedSlot,
} from '../domain/placements';
import { NAVIGATION_KEY, SYSTEM_PAGES, templateOf } from '../domain/templates';
import type { PageRecord } from './ports/page.repository';
import type { StorefrontDependencies } from './storefront-dependencies';

// What a buyer with no session reads (content-management analysis 8): the published layout of a
// system page, of a live dynamic page, or of the approved navigation. Only published or approved
// versions are ever answered; a system page never published answers its template's defaults, so
// the site works before anyone edits it. A dynamic page is live while it is published, not
// archived and inside its live window; an old or archived slug answers where to go instead. The
// answer holds layout and settings only: product, category and seller data are read by the buyer
// app from their own routes, so they are re-checked on every read.

export type PublicFailure = { readonly code: 'storefront.page-not-found' };

export interface PublishedPageView {
  readonly kind: 'system' | 'dynamic';
  readonly key: string | null;
  readonly slug: string | null;
  readonly templateKey: string;
  /** null for a system page: the buyer app names it in the buyer's language. */
  readonly title: string | null;
  readonly seo: Seo;
  readonly linked: Linked | null;
  /** null: the template's defaults (never published). */
  readonly versionNo: number | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly slots: readonly ServedSlot[];
}

export type PublishedAnswer =
  | { readonly kind: 'page'; readonly page: PublishedPageView }
  /** The slug is an old or archived one: the buyer app sends the buyer to `to` (a site path). */
  | { readonly kind: 'redirect'; readonly to: string };

const notFound = (): Result<never, PublicFailure> => err({ code: 'storefront.page-not-found' });

export function live(page: PageRecord, now: Temporal.Instant): boolean {
  if (page.archivedAt !== null) return false;
  if (page.startsAt !== null && Temporal.Instant.compare(now, page.startsAt) < 0) return false;
  return page.endsAt === null || Temporal.Instant.compare(now, page.endsAt) < 0;
}

async function publishedView(
  deps: StorefrontDependencies,
  context: CallContext,
  page: PageRecord,
): Promise<PublishedPageView | null> {
  const published = await deps.pages.findPublished(context.market, page.id);
  if (published === null) return null;
  const template = templateOf(page.templateKey);
  return {
    kind: page.kind,
    key: page.systemKey,
    slug: page.slug,
    templateKey: page.templateKey,
    title: page.kind === 'system' ? null : page.title,
    seo: page.seo,
    linked: page.linked,
    versionNo: published.versionNo,
    publishedAt: published.publishedAt,
    slots: servedSlots(template, readPlacements(template, published.placements).placements),
  };
}

function defaultView(key: string): PublishedPageView {
  const definition = SYSTEM_PAGES.get(key)!;
  const template = templateOf(definition.templateKey);
  let n = 0;
  return {
    kind: 'system',
    key,
    slug: null,
    templateKey: template.key,
    title: null,
    seo: {},
    linked: null,
    versionNo: null,
    publishedAt: null,
    slots: servedSlots(
      template,
      defaultPlacements(template, { title: key }, () => `default-${(n += 1)}`),
    ),
  };
}

/** The published layout of a system page (the navigation has its own read). */
export async function viewPublishedSystemPage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly key: unknown },
  navigation = false,
): Promise<Result<PublishedAnswer, PublicFailure>> {
  const key = navigation ? NAVIGATION_KEY : input?.key;
  if (typeof key !== 'string' || !SYSTEM_PAGES.has(key)) return notFound();
  if (!navigation && key === NAVIGATION_KEY) return notFound();
  return deps.unitOfWork.run<PublishedAnswer, PublicFailure>(
    context.market,
    async () => {
      const page = await deps.pages.findSystemPage(context.market, key);
      const view = page === null ? null : await publishedView(deps, context, page);
      return ok({ kind: 'page', page: view ?? defaultView(key) });
    },
    { readOnly: true },
  );
}

/** The published layout of a live dynamic page at `/l/<slug>`, or where an old slug now goes. */
export async function viewPublishedDynamicPage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly slug: unknown },
): Promise<Result<PublishedAnswer, PublicFailure>> {
  const slug = input?.slug;
  if (!isSlug(slug)) return notFound();
  const now = deps.clock.now();
  return deps.unitOfWork.run<PublishedAnswer, PublicFailure>(
    context.market,
    async () => {
      const page = await deps.pages.findBySlug(context.market, slug);
      if (page !== null) {
        if (page.archivedAt !== null) {
          return page.archivedRedirect === null
            ? notFound()
            : ok({ kind: 'redirect', to: page.archivedRedirect });
        }
        if (!live(page, now)) return notFound();
        const view = await publishedView(deps, context, page);
        return view === null ? notFound() : ok({ kind: 'page', page: view });
      }
      const target = await deps.pages.findRedirect(context.market, slug);
      if (target === null) return notFound();
      const current = await deps.pages.findPage(context.market, target);
      if (current === null || current.slug === null) return notFound();
      if (current.archivedAt !== null) {
        return current.archivedRedirect === null
          ? notFound()
          : ok({ kind: 'redirect', to: current.archivedRedirect });
      }
      // Only to a page buyers can see now, so an old slug never tells of an unpublished one.
      if (!live(current, now)) return notFound();
      if ((await deps.pages.findPublished(context.market, current.id)) === null) return notFound();
      return ok({ kind: 'redirect', to: `/l/${current.slug}` });
    },
    { readOnly: true },
  );
}
