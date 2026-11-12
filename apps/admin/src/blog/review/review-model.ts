// What a reviewer compares (design A3): the version in review against the live one, shown as a
// short list of changed parts. Text only; nothing here is rendered as markup.

import type { ApiBlock, ApiContent } from '../editor/types.ts';

export type ChangeField =
  | 'title'
  | 'excerpt'
  | 'body'
  | 'cover'
  | 'category'
  | 'tags'
  | 'seo'
  | 'author'
  | 'links'
  | 'event';

export interface Change {
  readonly field: ChangeField;
  /** Plain text of the live version, or null when there is no live version or the part is new. */
  readonly before: string | null;
  /** Plain text of the version in review, or null when the part was removed. */
  readonly after: string | null;
}

/** One line per block, so a reviewer can read the body and a changed block shows up as a changed line. */
export function blockLine(block: ApiBlock): string {
  switch (block.type) {
    case 'paragraph':
      return block.text;
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`;
    case 'list':
      return block.items
        .map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item}`)
        .join('\n');
    case 'quote':
      return `“${block.text}”${block.attribution === null ? '' : ` ${block.attribution}`}`;
    case 'tip':
      return `${block.title === null ? '' : `${block.title}: `}${block.text}`;
    case 'image':
      return `[image ${block.imageId}] ${block.alt}${block.caption === null ? '' : ` / ${block.caption}`}`;
    case 'product_cards':
      return `[products] ${block.productIds.join(', ')}`;
    case 'seller_card':
      return `[seller] ${block.sellerId}`;
  }
}

const bodyText = (content: ApiContent): string => content.body.map(blockLine).join('\n\n');
const orNull = (value: string | null): string | null =>
  value === null || value === '' ? null : value;
const list = (values: readonly string[]): string | null =>
  values.length === 0 ? null : [...values].sort().join(', ');
const links = (content: ApiContent): string | null =>
  list(content.links.map((link) => `${link.type}:${link.id}`));
const event = (content: ApiContent): string | null =>
  content.event === null ? null : JSON.stringify(content.event);

/** The parts that differ. With no live version every filled part counts as new. */
export function changesOf(open: ApiContent, live: ApiContent | null): readonly Change[] {
  const parts: readonly [ChangeField, (c: ApiContent) => string | null][] = [
    ['title', (c) => orNull(c.title)],
    ['excerpt', (c) => orNull(c.excerpt)],
    ['body', (c) => orNull(bodyText(c))],
    ['cover', (c) => (c.coverImageId === null ? null : `${c.coverImageId} / ${c.coverAlt ?? ''}`)],
    ['category', (c) => c.categoryId],
    ['tags', (c) => list(c.tagIds)],
    ['seo', (c) => orNull([c.seoTitle ?? '', c.seoDescription ?? ''].join('\n').trim())],
    ['author', (c) => orNull(c.authorDisplay)],
    ['links', links],
    ['event', event],
  ];
  const changes: Change[] = [];
  for (const [field, read] of parts) {
    const after = read(open);
    const before = live === null ? null : read(live);
    if (after !== before) changes.push({ field, before, after });
  }
  return changes;
}
