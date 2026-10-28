import type { PostContent } from './content';

// Copy to another Market: the editor reads a post in this Market and creates a new draft from it in
// the other (two calls, each behind the editor's own key in its Market). Only what is plain writing
// travels. Everything that points at this Market's data stays behind, because its id means nothing
// there: product and seller cards, links, the category and tags, the cover image and the images of
// the body. The editor picks those again. An event keeps its details (times and zone are facts of
// the event); its status goes back to scheduled.

const TRAVELS = new Set(['paragraph', 'heading', 'list', 'quote', 'tip']);

export interface CopyPackage {
  readonly kind: string;
  readonly content: PostContent;
  /** What was left behind, so the editor knows what to pick again. */
  readonly left: readonly ('cover' | 'images' | 'cards' | 'links' | 'category' | 'tags')[];
}

export function copyContent(kind: string, content: PostContent): CopyPackage {
  const left = new Set<CopyPackage['left'][number]>();
  const body = content.body.filter((block) => {
    if (TRAVELS.has(block.type)) return true;
    left.add(block.type === 'image' ? 'images' : 'cards');
    return false;
  });
  if (content.coverImageId !== null) left.add('cover');
  if (content.links.length > 0) left.add('links');
  if (content.categoryId !== null) left.add('category');
  if (content.tagIds.length > 0) left.add('tags');
  return {
    kind,
    content: {
      ...content,
      body,
      coverImageId: null,
      coverAlt: null,
      categoryId: null,
      tagIds: [],
      links: [],
      event:
        content.event === null
          ? null
          : { ...content.event, eventStatus: 'scheduled', statusMessage: null },
    },
    left: [...left],
  };
}
