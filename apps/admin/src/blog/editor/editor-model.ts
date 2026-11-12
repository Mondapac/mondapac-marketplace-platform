// The editor's working copy of a version and its way to and from the API body. Blocks the editor
// has no control for (image, product cards, seller card) travel as `kept` blocks: shown, movable
// and removable, never altered, so saving the text never loses them.

import type { ApiBlock, ApiContent, ApiLink } from './types.ts';

export type EditBlock =
  | { readonly key: string; readonly type: 'paragraph'; readonly text: string }
  | { readonly key: string; readonly type: 'heading'; readonly level: 2 | 3; readonly text: string }
  | {
      readonly key: string;
      readonly type: 'list';
      readonly ordered: boolean;
      readonly text: string;
    }
  | { readonly key: string; readonly type: 'quote'; readonly text: string; readonly by: string }
  | { readonly key: string; readonly type: 'tip'; readonly title: string; readonly text: string }
  | { readonly key: string; readonly type: 'kept'; readonly block: ApiBlock };

export type TextBlockType = 'paragraph' | 'heading' | 'list' | 'quote' | 'tip';
export const TEXT_BLOCK_TYPES: readonly TextBlockType[] = [
  'paragraph',
  'heading',
  'list',
  'quote',
  'tip',
];

export interface Draft {
  readonly title: string;
  readonly excerpt: string;
  readonly blocks: readonly EditBlock[];
  readonly coverImageId: string;
  readonly coverAlt: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly authorDisplay: string;
  readonly categoryId: string;
  readonly tagIds: readonly string[];
  readonly slug: string;
  /** What the editor never edits and sends back as it came. */
  readonly links: readonly ApiLink[];
  readonly event: Readonly<Record<string, unknown>> | null;
}

let counter = 0;
export const newKey = (): string => `b${++counter}`;

/** One list item per non-empty line. */
export const itemsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function blockFromApi(block: ApiBlock): EditBlock {
  const key = newKey();
  switch (block.type) {
    case 'paragraph':
      return { key, type: 'paragraph', text: block.text };
    case 'heading':
      return { key, type: 'heading', level: block.level, text: block.text };
    case 'list':
      return { key, type: 'list', ordered: block.ordered, text: block.items.join('\n') };
    case 'quote':
      return { key, type: 'quote', text: block.text, by: block.attribution ?? '' };
    case 'tip':
      return { key, type: 'tip', title: block.title ?? '', text: block.text };
    default:
      return { key, type: 'kept', block };
  }
}

export function emptyBlock(type: TextBlockType): EditBlock {
  const key = newKey();
  switch (type) {
    case 'paragraph':
      return { key, type, text: '' };
    case 'heading':
      return { key, type, level: 2, text: '' };
    case 'list':
      return { key, type, ordered: false, text: '' };
    case 'quote':
      return { key, type, text: '', by: '' };
    case 'tip':
      return { key, type, title: '', text: '' };
  }
}

export function draftOf(content: ApiContent, slug: string): Draft {
  return {
    title: content.title,
    excerpt: content.excerpt,
    blocks: content.body.map(blockFromApi),
    coverImageId: content.coverImageId ?? '',
    coverAlt: content.coverAlt ?? '',
    seoTitle: content.seoTitle ?? '',
    seoDescription: content.seoDescription ?? '',
    authorDisplay: content.authorDisplay ?? '',
    categoryId: content.categoryId ?? '',
    tagIds: content.tagIds,
    slug,
    links: content.links,
    event: content.event,
  };
}

function blockBody(block: EditBlock): ApiBlock {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', text: block.text.trim() };
    case 'heading':
      return { type: 'heading', level: block.level, text: block.text.trim() };
    case 'list':
      return { type: 'list', ordered: block.ordered, items: itemsOf(block.text) };
    case 'quote':
      return {
        type: 'quote',
        text: block.text.trim(),
        attribution: block.by.trim() === '' ? null : block.by.trim(),
      };
    case 'tip':
      return {
        type: 'tip',
        title: block.title.trim() === '' ? null : block.title.trim(),
        text: block.text.trim(),
      };
    case 'kept':
      return block.block;
  }
}

/** A text block that has nothing in it is left out of what is saved. */
const isBlank = (block: EditBlock): boolean => {
  switch (block.type) {
    case 'list':
      return itemsOf(block.text).length === 0;
    case 'kept':
      return false;
    default:
      return block.text.trim() === '';
  }
};

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The `content` of a save-draft body. */
export function contentOf(draft: Draft): ApiContent {
  return {
    title: draft.title.trim(),
    excerpt: draft.excerpt.trim(),
    body: draft.blocks.filter((block) => !isBlank(block)).map(blockBody),
    coverImageId: orNull(draft.coverImageId),
    coverAlt: orNull(draft.coverAlt),
    seoTitle: orNull(draft.seoTitle),
    seoDescription: orNull(draft.seoDescription),
    authorDisplay: orNull(draft.authorDisplay),
    categoryId: orNull(draft.categoryId),
    tagIds: draft.tagIds,
    links: draft.links,
    event: draft.event,
  };
}

/** Whether the working copy differs from what is saved (what the unsaved bar asks). */
export function isDirty(draft: Draft, saved: Draft): boolean {
  return (
    JSON.stringify(contentOf(draft)) !== JSON.stringify(contentOf(saved)) ||
    draft.slug.trim() !== saved.slug
  );
}

export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
