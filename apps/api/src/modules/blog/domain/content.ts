import { parseBody, productsOf, sellersOf } from './body';
import type { Block } from './body';
import { parseEventDetails } from './event-details';
import type { EventDetails } from './event-details';
import { at, closedObject, isRecord, plainText, plainTextOrEmpty, problem, uuid } from './fields';
import type { Problems } from './fields';

// The content of one version of a post: what an author types and what a version stores. Parsing
// is strict and closed (a field outside the list is refused), never throws, and returns problems
// by path and code with no value in them. Whether a product is on sale, a certification claim is
// made or an image exists is not decided here: that needs other modules and is the job of the
// automatic checks (checks.ts) and of the application.

export const POST_KINDS = ['product', 'brand', 'event', 'news'] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const OWNER_TYPES = ['platform', 'seller'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];
export const LINK_TYPES = ['product', 'seller', 'brand', 'category', 'page'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
/** The links a seller's post may carry: its own products, itself and its brand. */
export const SELLER_LINK_TYPES: readonly LinkType[] = ['product', 'seller', 'brand'];

export const CONTENT_LIMITS = Object.freeze({
  title: 120,
  excerpt: 160,
  coverAlt: 200,
  seoTitle: 70,
  seoDescription: 160,
  authorDisplay: 80,
  tags: 10,
  links: 30,
});

export interface PostLink {
  readonly type: LinkType;
  readonly id: string;
}

export interface PostContent {
  readonly title: string;
  /** May be empty in a draft; it is also the page description when no SEO text is given. */
  readonly excerpt: string;
  readonly body: readonly Block[];
  readonly coverImageId: string | null;
  readonly coverAlt: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  /** The byline override of a platform post; always null for a seller's post. */
  readonly authorDisplay: string | null;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  /** The links the author added; the cards of the body are added by {@link linksOf}. */
  readonly links: readonly PostLink[];
  /** Present exactly for an event post that has its details. */
  readonly event: EventDetails | null;
}

export interface ContentRules {
  readonly kind: PostKind;
  readonly ownerType: OwnerType;
  /** The Market's time zone: the default of an event's local times. */
  readonly timeZone: string;
}

export const CONTENT_FIELDS = [
  'title',
  'excerpt',
  'body',
  'coverImageId',
  'coverAlt',
  'seoTitle',
  'seoDescription',
  'authorDisplay',
  'categoryId',
  'tagIds',
  'links',
  'event',
] as const;

function parseLinks(problems: Problems, path: string, value: unknown, ownerType: OwnerType) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problem(problems, path, 'type');
    return [];
  }
  const links: PostLink[] = [];
  for (const [index, entry] of (value as unknown[]).entries()) {
    const entryPath = at(path, index);
    if (!closedObject(problems, entryPath, entry, ['type', 'id'])) continue;
    const type = entry.type;
    if (!(LINK_TYPES as readonly unknown[]).includes(type)) {
      problem(problems, at(entryPath, 'type'), type === undefined ? 'required' : 'value');
      continue;
    }
    if (ownerType === 'seller' && !SELLER_LINK_TYPES.includes(type as LinkType)) {
      problem(problems, at(entryPath, 'type'), 'not-allowed');
      continue;
    }
    const id = uuid(problems, at(entryPath, 'id'), entry.id);
    if (id !== null) links.push({ type: type as LinkType, id });
  }
  return links;
}

function parseTagIds(problems: Problems, path: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problem(problems, path, 'type');
    return [];
  }
  if (value.length > CONTENT_LIMITS.tags) {
    problem(problems, path, 'count');
    return [];
  }
  const ids: string[] = [];
  for (const [index, entry] of (value as unknown[]).entries()) {
    const id = uuid(problems, at(path, index), entry);
    if (id !== null) ids.push(id);
  }
  if (new Set(ids).size !== ids.length) problem(problems, path, 'duplicate');
  return ids;
}

/** Every link of a version in order: the cards of the body first, then the added ones, once each. */
export function linksOf(content: Pick<PostContent, 'body' | 'links'>): readonly PostLink[] {
  const seen = new Set<string>();
  const all: PostLink[] = [];
  const add = (link: PostLink): void => {
    const key = `${link.type}:${link.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(link);
  };
  for (const id of productsOf(content.body)) add({ type: 'product', id });
  for (const id of sellersOf(content.body)) add({ type: 'seller', id });
  for (const link of content.links) add(link);
  return all;
}

export interface ParsedContent {
  readonly content: PostContent | null;
  readonly problems: Problems;
}

/** Validates the content an author sent. Absent optional fields take their empty value. */
export function parsePostContent(input: unknown, rules: ContentRules): ParsedContent {
  const problems: Problems = [];
  if (!closedObject(problems, '', input, CONTENT_FIELDS)) return { content: null, problems };
  const title = plainText(problems, 'title', input.title, { max: CONTENT_LIMITS.title });
  const excerpt = plainTextOrEmpty(problems, 'excerpt', input.excerpt, CONTENT_LIMITS.excerpt);
  const body = parseBody(problems, 'body', input.body);
  const coverImageId =
    input.coverImageId === undefined || input.coverImageId === null
      ? null
      : uuid(problems, 'coverImageId', input.coverImageId);
  const coverAlt = plainText(problems, 'coverAlt', input.coverAlt, {
    max: CONTENT_LIMITS.coverAlt,
    optional: true,
  });
  const seoTitle = plainText(problems, 'seoTitle', input.seoTitle, {
    max: CONTENT_LIMITS.seoTitle,
    optional: true,
  });
  const seoDescription = plainText(problems, 'seoDescription', input.seoDescription, {
    max: CONTENT_LIMITS.seoDescription,
    optional: true,
  });
  let authorDisplay: string | null = null;
  if (rules.ownerType === 'seller') {
    // A seller's post carries the seller's name; the byline is not the author's to set.
    if (input.authorDisplay !== undefined && input.authorDisplay !== null) {
      problem(problems, 'authorDisplay', 'not-allowed');
    }
  } else {
    authorDisplay = plainText(problems, 'authorDisplay', input.authorDisplay, {
      max: CONTENT_LIMITS.authorDisplay,
      optional: true,
    });
  }
  const categoryId =
    input.categoryId === undefined || input.categoryId === null
      ? null
      : uuid(problems, 'categoryId', input.categoryId);
  const tagIds = parseTagIds(problems, 'tagIds', input.tagIds);
  const links = parseLinks(problems, 'links', input.links, rules.ownerType);
  let event: EventDetails | null = null;
  if (input.event !== undefined && input.event !== null) {
    if (rules.kind !== 'event') problem(problems, 'event', 'not-allowed');
    else event = parseEventDetails(problems, 'event', input.event, rules.timeZone);
  }
  if (title === null || body === null || problems.length > 0) return { content: null, problems };
  const content: PostContent = {
    title,
    excerpt,
    body,
    coverImageId,
    coverAlt,
    seoTitle,
    seoDescription,
    authorDisplay,
    categoryId,
    tagIds,
    links,
    event,
  };
  if (linksOf(content).length > CONTENT_LIMITS.links) {
    return { content: null, problems: [{ path: 'links', code: 'count' }] };
  }
  return { content, problems };
}

/** Whether a stored JSON value is a plain object: used by readers of stored rows. */
export const isStoredRecord = isRecord;
