import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { Block } from '../domain/body';
import { POST_KINDS } from '../domain/content';
import type { PostKind, PostLink } from '../domain/content';
import { closedObject, problem } from '../domain/fields';
import type { Problems } from '../domain/fields';
import { isPublic, publicAbsence } from '../domain/lifecycle';
import { isValidSlug } from '../domain/slug';
import type { BlogDependencies } from './blog-dependencies';
import type { BlogFailure } from './failures';
import { fieldsOf, policyOf } from './post-support';
import type { EventView } from './post-support';
import { eventView } from './post-support';
import type {
  CategoryId,
  PostRecord,
  PublicRow,
  TagId,
  VersionRecord,
} from './ports/blog.repository';

// What buyers read, with no session: the live version of published posts only. A paused or archived
// post that was on the site answers 410 so that search engines drop it; one that never was, and any
// unknown address, answers 404. An old address answers where the post is now.

export interface PublicPostCard {
  readonly id: string;
  readonly kind: PostKind;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly coverImageId: string | null;
  readonly coverAlt: string | null;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly authorDisplay: string | null;
  readonly sellerId: string | null;
  readonly featured: boolean;
  readonly publishedAt: Temporal.Instant | null;
  readonly event: EventView | null;
}

export interface PublicPost extends PublicPostCard {
  readonly body: readonly Block[];
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly links: readonly PostLink[];
}

export interface PublicPage {
  readonly items: readonly PublicPostCard[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export type PublicAnswer =
  | { readonly kind: 'post'; readonly post: PublicPost }
  | { readonly kind: 'redirect'; readonly slug: string };

function authorOf(post: PostRecord, version: VersionRecord, defaultAuthor: string): string | null {
  if (post.ownerType === 'seller') return null;
  return version.content.authorDisplay ?? defaultAuthor;
}

function cardOf(row: PublicRow, defaultAuthor: string): PublicPostCard {
  const { post, version } = row;
  const content = version.content;
  return {
    id: post.id,
    kind: post.kind,
    slug: post.slug,
    title: content.title,
    excerpt: content.excerpt,
    coverImageId: content.coverImageId,
    coverAlt: content.coverAlt,
    categoryId: content.categoryId,
    tagIds: content.tagIds,
    authorDisplay: authorOf(post, version, defaultAuthor),
    sellerId: post.sellerId,
    featured: post.featured,
    publishedAt: post.publishedAt,
    event: content.event === null ? null : eventView(content.event),
  };
}

const LIST_KEYS = ['kind', 'category', 'tag', 'page'] as const;

/** Published posts, newest first; by kind, category slug or tag slug; paged by the Market's page size. */
export async function listPublished(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly query?: unknown },
): Promise<Result<PublicPage, BlogFailure>> {
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const problems: Problems = [];
  const q = input?.query ?? {};
  if (!closedObject(problems, '', q, LIST_KEYS)) return err(fieldsOf(problems));
  let kind: PostKind | undefined;
  if (q.kind !== undefined) {
    if ((POST_KINDS as readonly unknown[]).includes(q.kind)) kind = q.kind as PostKind;
    else problem(problems, 'kind', 'value');
  }
  for (const key of ['category', 'tag'] as const) {
    if (q[key] !== undefined && (typeof q[key] !== 'string' || !isValidSlugShape(q[key]))) {
      problem(problems, key, 'format');
    }
  }
  let page = 1;
  if (q.page !== undefined) {
    const parsed =
      typeof q.page === 'string' && /^\d{1,4}$/u.test(q.page) ? Number(q.page) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) problem(problems, 'page', 'value');
    else page = parsed;
  }
  if (problems.length > 0) return err(fieldsOf(problems));

  return deps.unitOfWork.run<PublicPage, BlogFailure>(
    market,
    async () => {
      let categoryId: CategoryId | undefined;
      let tagId: TagId | undefined;
      if (typeof q.category === 'string') {
        const category = await deps.posts.findCategoryBySlug(market, q.category);
        if (category === null) return ok(emptyPage(page, policy.pageSize));
        categoryId = category.id;
      }
      if (typeof q.tag === 'string') {
        const tag = await deps.posts.findTagBySlug(market, q.tag);
        if (tag === null) return ok(emptyPage(page, policy.pageSize));
        tagId = tag.id;
      }
      const rows = await deps.posts.listPublished(
        market,
        {
          ...(kind === undefined ? {} : { kind }),
          ...(categoryId === undefined ? {} : { categoryId }),
          ...(tagId === undefined ? {} : { tagId }),
        },
        { limit: policy.pageSize + 1, offset: (page - 1) * policy.pageSize },
      );
      return ok({
        items: rows
          .slice(0, policy.pageSize)
          .map((row) => cardOf(row, policy.defaultAuthorDisplay)),
        page,
        pageSize: policy.pageSize,
        hasMore: rows.length > policy.pageSize,
      });
    },
    { readOnly: true },
  );
}

const isValidSlugShape = (value: string): boolean =>
  value.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(value);

const emptyPage = (page: number, pageSize: number): PublicPage => ({
  items: [],
  page,
  pageSize,
  hasMore: false,
});

/** One published post by address; an old address answers a redirect; 410 and 404 as above. */
export async function viewPublishedPost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly slug: unknown },
): Promise<Result<PublicAnswer, BlogFailure>> {
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  if (typeof input?.slug !== 'string' || !isValidSlug(input.slug))
    return err({ code: 'blog.not-found' });
  const slug = input.slug;
  return deps.unitOfWork.run<PublicAnswer, BlogFailure>(
    market,
    async () => {
      const direct = await deps.posts.findPostBySlug(market, slug);
      if (direct !== null)
        return answerFor(deps, market, direct, policy.defaultAuthorDisplay, false);
      const redirect = await deps.posts.findRedirect(market, slug);
      if (redirect === null) return err({ code: 'blog.not-found' });
      const target = await deps.posts.findPost(market, redirect.postId);
      if (target === null) return err({ code: 'blog.not-found' });
      return answerFor(deps, market, target, policy.defaultAuthorDisplay, true);
    },
    { readOnly: true },
  );
}

async function answerFor(
  deps: BlogDependencies,
  market: MarketContext,
  post: PostRecord,
  defaultAuthor: string,
  viaRedirect: boolean,
): Promise<Result<PublicAnswer, BlogFailure>> {
  const facts = {
    status: post.status,
    hasLive: post.liveVersionId !== null,
    everPublished: post.publishedAt !== null,
  };
  if (!isPublic(facts)) {
    return err({ code: publicAbsence(facts) === 'gone' ? 'blog.gone' : 'blog.not-found' });
  }
  if (viaRedirect) return ok({ kind: 'redirect', slug: post.slug });
  const version = await deps.posts.findVersion(
    market,
    post.id,
    post.liveVersionId as Id<'BlogPostVersion'>,
  );
  if (version === null) return err({ code: 'blog.not-found' });
  return ok({
    kind: 'post',
    post: {
      ...cardOf({ post, version }, defaultAuthor),
      body: version.content.body,
      seoTitle: version.content.seoTitle,
      seoDescription: version.content.seoDescription,
      links: version.content.links,
    },
  });
}

export interface UpcomingEvents {
  readonly items: readonly PublicPostCard[];
}

const UPCOMING_LIMIT = 20;

/** Live event posts that have not ended, soonest first. */
export async function viewUpcomingEvents(
  deps: BlogDependencies,
  context: CallContext,
): Promise<Result<UpcomingEvents, BlogFailure>> {
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const now = deps.clock.now();
  return deps.unitOfWork.run<UpcomingEvents, BlogFailure>(
    market,
    async () => {
      const rows = await deps.posts.upcomingEvents(market, now, UPCOMING_LIMIT);
      return ok({ items: rows.map((row) => cardOf(row, policy.defaultAuthorDisplay)) });
    },
    { readOnly: true },
  );
}

export interface PublicCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}
export interface PublicTaxonomy {
  readonly categories: readonly PublicCategory[];
  readonly tags: readonly { readonly id: string; readonly slug: string; readonly name: string }[];
}

/** Categories (named in the Market's default locale when the asked one is missing) and tags. */
export async function viewPublicTaxonomy(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly locale?: unknown },
): Promise<Result<PublicTaxonomy, BlogFailure>> {
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const asked =
    typeof input?.locale === 'string' && policy.supportedLocales.includes(input.locale)
      ? input.locale
      : policy.defaultLocale;
  return deps.unitOfWork.run<PublicTaxonomy, BlogFailure>(
    market,
    async () => {
      const [categories, tags] = [
        await deps.posts.listCategories(market),
        await deps.posts.listTags(market),
      ];
      return ok({
        categories: categories.map((category) => ({
          id: category.id,
          slug: category.slug,
          name:
            category.names.get(asked) ?? category.names.get(policy.defaultLocale) ?? category.slug,
        })),
        tags: tags.map((tag) => ({ id: tag.id, slug: tag.slug, name: tag.name })),
      });
    },
    { readOnly: true },
  );
}
