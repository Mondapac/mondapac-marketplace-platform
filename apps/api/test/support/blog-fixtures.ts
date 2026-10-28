import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { PostDetailView } from '../../src/modules/blog/application/post-support';
import {
  BLOG_POST_EDIT,
  BLOG_POST_PAUSE,
  BLOG_POST_PUBLISH,
  BLOG_POST_READ,
  BLOG_POST_REVIEW,
  BLOG_SELLER_POST_EDIT,
  BLOG_TAXONOMY_EDIT,
} from '../../src/modules/blog/contracts/permissions';
import { BRAND_A, COVER, PRODUCT_A, type BlogHarness } from './blog-harness';

export const WRITER = [BLOG_POST_READ.key, BLOG_POST_EDIT.key];
export const REVIEWER = [BLOG_POST_READ.key, BLOG_POST_REVIEW.key];
export const PUBLISHER = [BLOG_POST_READ.key, BLOG_POST_PUBLISH.key];
export const PAUSER = [BLOG_POST_READ.key, BLOG_POST_PAUSE.key];
export const TAXONOMY = [BLOG_POST_READ.key, BLOG_TAXONOMY_EDIT.key];
export const EVERYTHING = [
  BLOG_POST_READ.key,
  BLOG_POST_EDIT.key,
  BLOG_POST_REVIEW.key,
  BLOG_POST_PUBLISH.key,
  BLOG_POST_PAUSE.key,
  BLOG_TAXONOMY_EDIT.key,
];
export const SELLER_KEYS = [BLOG_SELLER_POST_EDIT.key];

/** The value of an ok result; a refusal fails the test with its code. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The refusal of a result; an ok result fails the test. */
export function refusal<T, E>(result: Result<T, E>): E {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

/** A category of the Market (named in the Market's default locale). */
export async function aCategory(h: BlogHarness, slug = 'recipes'): Promise<string> {
  const config = h.deps.policy.of(h.market)!;
  const created = unwrap(
    await h.cases.createCategory.execute(h.admin('taxonomist', TAXONOMY), {
      body: { slug, names: { [config.defaultLocale]: 'Recipes' } },
    }),
  );
  return created.id;
}

export interface ContentOptions {
  readonly categoryId: string;
  readonly title?: string;
  readonly links?: readonly { type: string; id: string }[];
  readonly event?: Record<string, unknown>;
  readonly extra?: Record<string, unknown>;
}

/** Content that passes the automatic checks for a news post. */
export function content(options: ContentOptions): Record<string, unknown> {
  return {
    title: options.title ?? 'Ramadan table ideas',
    excerpt: 'Simple dishes for a shared table.',
    body: [
      { type: 'paragraph', text: 'Start with dates and a light soup.' },
      { type: 'heading', level: 2, text: 'Mains' },
      { type: 'paragraph', text: 'Slow cooked lamb suits a long evening.' },
    ],
    coverImageId: COVER,
    coverAlt: 'A laid table with dates',
    categoryId: options.categoryId,
    links: options.links ?? [],
    ...(options.event === undefined ? {} : { event: options.event }),
    ...options.extra,
  };
}

/** A product post's content: it must link a product that is on sale. */
export const productContent = (categoryId: string, productId = PRODUCT_A, title?: string) =>
  content({ categoryId, title, links: [{ type: 'product', id: productId }] });

export const brandContent = (categoryId: string, brandId = BRAND_A) =>
  content({ categoryId, title: 'A brand story', links: [{ type: 'brand', id: brandId }] });

/** An event that starts in `days` days from the harness clock and lasts two hours. */
export function eventDetails(h: BlogHarness, days = 10): Record<string, unknown> {
  const starts = h.clock.now().add({ hours: days * 24 });
  const ends = starts.add({ hours: 2 });
  return {
    startsAt: starts.toString(),
    endsAt: ends.toString(),
    attendance: 'online',
  };
}

export async function createNews(
  h: BlogHarness,
  context: CallContext,
  categoryId: string,
  title?: string,
): Promise<PostDetailView> {
  return unwrap(
    await h.cases.createPost.execute(context, {
      body: { kind: 'news', content: content({ categoryId, title }) },
    }),
  );
}

/** A news post written by `writer`, sent, approved by `reviewer` and left approved. */
export async function approvedNews(
  h: BlogHarness,
  categoryId: string,
  title?: string,
): Promise<PostDetailView> {
  const created = await createNews(h, h.admin('writer', WRITER), categoryId, title);
  unwrap(await h.cases.submitPost.execute(h.admin('writer', WRITER), { post: created.id }));
  return unwrap(
    await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
      post: created.id,
      body: { versionNo: 1 },
    }),
  );
}

/** A news post taken all the way to live. */
export async function liveNews(
  h: BlogHarness,
  categoryId: string,
  title?: string,
): Promise<PostDetailView> {
  const approved = await approvedNews(h, categoryId, title);
  return unwrap(
    await h.cases.publishPost.execute(h.admin('publisher', PUBLISHER), {
      post: approved.id,
      body: { versionNo: 1 },
    }),
  );
}
