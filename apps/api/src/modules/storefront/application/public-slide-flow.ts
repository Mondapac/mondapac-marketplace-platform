import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { at, problem, uuid, type Problems } from '../domain/fields';
import {
  linkPath,
  nextChange,
  scopeCovers,
  showNow,
  type LinkLookups,
  type PageScope,
  type ServedPlacement,
} from '../domain/slide-public';
import { positionOf, type PositionDefinition } from '../domain/slide-positions';
import { readContent, type SlideContent } from '../domain/slides';
import { live } from './public-flow';
import type { LiveCategoryRow } from './ports/link-targets';
import { targetKey, type SlideTarget } from './ports/slide-targets';
import type { StorefrontDependencies } from './storefront-dependencies';

// What a buyer with no session reads of the slide library: the live slides of one position for
// one page, of the request's Market only. A slide is served when its placement is in the
// projection (so approved, not paused, not archived), its window holds now, its scope covers the
// page asked for, its content still passes the checks, and its link target is alive in the
// request's Market (a category, product, seller or page is checked through its owner's facade
// with the request's context; a seller that may not sell is dead). The answer says when it next
// changes, so a cache never holds it past a start or an end.

export const MAX_PUBLIC_AGE_SECONDS = 60;
/** Placements read for one position and Market; far above the sum of any position's caps. */
const MAX_PLACEMENTS_READ = 200;

export interface PublishedSlide {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly ctaLabel: string | null;
  /** A key of the buyer app's ready-made image set (media renditions come with the upload PR). */
  readonly image: {
    readonly key: string;
    readonly alt: string;
    readonly decorative: boolean;
  } | null;
  readonly textPosition: SlideContent['textPosition'];
  readonly textTone: SlideContent['textTone'];
  /** A site path; null when the slide has no link. */
  readonly href: string | null;
  readonly sponsored: boolean;
}

export interface PublishedSlides {
  readonly position: string;
  /** The position allows autoplay and every slide shown asks for it. */
  readonly autoplay: boolean;
  readonly slides: readonly PublishedSlide[];
  readonly nextChangeAt: Temporal.Instant | null;
  /** Seconds a cache may keep this answer: at most 60 and never past `nextChangeAt`. */
  readonly maxAgeSeconds: number;
}

export type PublicSlidesFailure = {
  readonly code: 'validation.failed';
  readonly fields: Problems;
};

interface Query {
  readonly position: PositionDefinition;
  readonly page: PageScope;
}

const SCOPE_PARAMS = ['category', 'product', 'seller', 'page'] as const;

function parseQuery(input: unknown): Result<Query, PublicSlidesFailure> {
  const problems: Problems = [];
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'position' && !(SCOPE_PARAMS as readonly string[]).includes(key)) {
      problem(problems, key, 'unknown-field');
    }
  }
  const position = typeof raw.position === 'string' ? positionOf(raw.position) : null;
  if (position === null)
    problem(problems, 'position', raw.position === undefined ? 'required' : 'enum');
  const page: Record<string, string> = {};
  for (const key of SCOPE_PARAMS) {
    if (raw[key] === undefined) continue;
    const id = uuid(problems, at('', key), raw[key]);
    if (id === null) continue;
    if (position !== null && !position.scopes.includes(key)) {
      problem(problems, key, 'not-allowed-here');
    } else {
      page[key] = id.toLowerCase();
    }
  }
  if (problems.length > 0 || position === null) {
    return err({ code: 'validation.failed', fields: problems });
  }
  return ok({ position, page });
}

/** The site path of each live category (`/c/<top>` or `/c/<top>/<child>`; deeper ones have no page). */
function categoryPaths(rows: readonly LiveCategoryRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, string>();
  for (const row of rows) {
    const parent = row.parentId === null ? undefined : byId.get(row.parentId);
    if (row.parentId === null) paths.set(row.id, `/c/${row.slug}`);
    else if (parent !== undefined && parent.parentId === null) {
      paths.set(row.id, `/c/${parent.slug}/${row.slug}`);
    }
  }
  return paths;
}

/** The asked category and its ancestors, nearest first. */
function chainOf(rows: readonly LiveCategoryRow[], category: string | undefined): string[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: string[] = [];
  let current = category === undefined ? undefined : byId.get(category);
  while (current !== undefined && chain.length < 16) {
    chain.push(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

export async function viewPublishedSlides(
  deps: StorefrontDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<PublishedSlides, PublicSlidesFailure>> {
  const parsed = parseQuery(input);
  if (!parsed.ok) return err(parsed.error);
  const { position, page } = parsed.value;
  const now = deps.clock.now();

  // 1. Our own rows, in one read-only unit of the request's Market.
  const read = await deps.unitOfWork.run<
    { placements: readonly ServedPlacement[]; contents: Map<string, SlideContent> },
    never
  >(
    context.market,
    async () => {
      const placements = await deps.slides.servedAt(
        context.market,
        position.key,
        now,
        MAX_PLACEMENTS_READ,
      );
      const versions = await deps.slides.versionsByIds(context.market, [
        ...new Set(placements.map((p) => p.liveVersionId)),
      ] as Id<'StorefrontSlideVersion'>[]);
      const contents = new Map<string, SlideContent>();
      for (const version of versions) {
        const placement = placements.find((p) => p.liveVersionId === version.id);
        const content =
          placement === undefined ? null : readContent(placement.kind, version.content);
        if (content !== null) contents.set(version.slideId, content);
      }
      return ok({ placements, contents });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new Error('the read unit failed');
  const { contents } = read.value;

  // 2. The tree decides which category scopes cover this page (a category with subcategories).
  let degraded = false;
  const needsTree =
    page.category !== undefined || [...contents.values()].some((c) => c.link?.type === 'category');
  const tree = needsTree ? await deps.links.categories(context) : [];
  if (tree === null) degraded = true;
  const rows = tree ?? [];
  const chain = chainOf(rows, page.category);

  const candidates = read.value.placements.filter((p) => scopeCovers(p, page, chain));
  const next = nextChange(candidates, now);
  const shown = showNow(candidates, now).filter((p) => contents.has(p.slideId));

  // 3. Link targets and scope sellers, each through its owner, for the request's Market.
  const links = shown.flatMap((p) => {
    const link = contents.get(p.slideId)?.link;
    return link === null || link === undefined ? [] : [link];
  });
  const idsOf = (type: string) => [
    ...new Set(links.filter((l) => l.type === type).map((l) => l.id.toLowerCase())),
  ];
  const scopeSellers = [
    ...new Set(
      shown.filter((p) => p.scope === 'seller' && p.scopeId !== null).map((p) => p.scopeId!),
    ),
  ];
  const sellerIds = [...new Set([...idsOf('seller'), ...scopeSellers])];
  const productIds = idsOf('product');
  const pageIds = idsOf('page');

  // One rule of liveness for every target: the SlideTargets port (the same one approval uses).
  const wanted: SlideTarget[] = [
    ...idsOf('category').map((id) => ({ type: 'category' as const, id })),
    ...productIds.map((id) => ({ type: 'product' as const, id })),
    ...sellerIds.map((id) => ({ type: 'seller' as const, id })),
  ];
  const aliveKeys =
    wanted.length === 0 ? new Set<string>() : await deps.targets.live(context, wanted);
  if (aliveKeys === null) degraded = true;
  const alive = (type: SlideTarget['type'], id: string): boolean =>
    aliveKeys?.has(targetKey({ type, id })) ?? false;
  const products = new Set(productIds.filter((id) => alive('product', id)));
  const liveSellers = sellerIds.filter((id) => alive('seller', id));
  const slugs =
    liveSellers.length === 0
      ? new Map<string, string>()
      : await deps.links.sellerSlugs(context, liveSellers);
  if (slugs === null) degraded = true;
  const sellers = slugs ?? new Map<string, string>();
  const pages = new Map<string, string>();
  if (pageIds.length > 0) {
    await deps.unitOfWork.run(
      context.market,
      async () => {
        for (const id of pageIds) {
          const record = await deps.pages.findPage(context.market, id as Id<'StorefrontPage'>);
          if (
            record === null ||
            record.kind !== 'dynamic' ||
            record.slug === null ||
            !live(record, now)
          ) {
            continue;
          }
          if ((await deps.pages.findPublished(context.market, record.id)) !== null) {
            pages.set(id, record.slug);
          }
        }
        return ok(undefined);
      },
      { readOnly: true },
    );
  }
  const lookups: LinkLookups = {
    categories: new Map([...categoryPaths(rows)].filter(([id]) => alive('category', id))),
    products,
    sellers,
    pages,
  };

  // 4. Drop what cannot be shown, then cap.
  const slides: PublishedSlide[] = [];
  const kept: ServedPlacement[] = [];
  for (const placement of shown) {
    const content = contents.get(placement.slideId)!;
    if (placement.scope === 'seller' && !lookups.sellers.has(placement.scopeId!)) continue;
    let href: string | null = null;
    if (content.link !== null) {
      href = linkPath({ type: content.link.type, id: content.link.id.toLowerCase() }, lookups);
      if (href === null) continue;
    }
    slides.push({
      id: placement.slideId,
      kind: placement.kind,
      title: content.title,
      body: content.body,
      ctaLabel: content.ctaLabel,
      image:
        content.image === null
          ? null
          : {
              key: content.image.ref,
              alt: content.image.alt,
              decorative: content.image.decorative,
            },
      textPosition: content.textPosition,
      textTone: content.textTone,
      href,
      sponsored: placement.sponsored,
    });
    kept.push(placement);
    if (slides.length === position.maxActive) break;
  }

  const untilChange =
    next === null
      ? MAX_PUBLIC_AGE_SECONDS
      : Math.max(0, Math.floor(next.epochMilliseconds / 1000 - now.epochMilliseconds / 1000));
  return ok({
    position: position.key,
    autoplay: position.autoplay && kept.length > 0 && kept.every((p) => p.autoplay),
    slides,
    nextChangeAt: next,
    maxAgeSeconds: degraded ? 0 : Math.min(MAX_PUBLIC_AGE_SECONDS, untilChange),
  });
}
