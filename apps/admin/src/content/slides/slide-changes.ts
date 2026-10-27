import type { SlideContent, SlidePlacement, SlideVersion } from './slide-types.ts';

// What approving a draft changes for buyers, as short lines: the draft against the live version
// (or against nothing for a slide that was never live). Pure data in, message ids and values out;
// the dialog turns them into words, so every text stays plain text.

export const MAX_CHANGE_LINES = 8;

export type ChangeId =
  | 'first'
  | 'text'
  | 'text-removed'
  | 'link'
  | 'link-removed'
  | 'image'
  | 'image-removed'
  | 'alt'
  | 'sponsored-on'
  | 'sponsored-off'
  | 'pinned-on'
  | 'pinned-off'
  | 'window'
  | 'position-added'
  | 'position-removed';

export interface Change {
  readonly id: ChangeId;
  /** Strings only: they are shown as text. `field` names a text field (message key `field.<field>`). */
  readonly values: Readonly<Record<string, string>>;
}

export interface ChangeWords {
  /** The label of a position key. */
  readonly position: (position: string) => string;
  /** The label of a placement's scope, such as "One category". */
  readonly scope: (placement: SlidePlacement) => string;
  /** The live window as one phrase. */
  readonly window: (startsAt: string, endsAt: string) => string;
  /** The label of a link type, such as "Category". */
  readonly link: (type: string) => string;
}

type TextField = 'title' | 'body' | 'ctaLabel';

const placementKey = (p: SlidePlacement): string =>
  [p.position, p.scope, p.scopeId ?? '', p.includeSubcategories ? 'sub' : ''].join('|');

const describe = (p: SlidePlacement, words: ChangeWords): string => {
  const base = words.position(p.position);
  return p.scope === 'all' ? base : `${base}, ${words.scope(p)}`;
};

function textOf(content: SlideContent | null, field: TextField): string {
  if (content === null) return '';
  const value =
    field === 'title' ? content.title : field === 'body' ? content.body : content.ctaLabel;
  return value ?? '';
}

/** The lines that describe `draft` against `live`, in the order buyers care about. */
export function changesOf(
  live: SlideVersion | null,
  draft: SlideVersion,
  words: ChangeWords,
): readonly Change[] {
  const content: Change[] = [];
  const link: Change[] = [];
  const flags: Change[] = [];
  const when: Change[] = [];
  const where: Change[] = [];
  const before = live?.content ?? null;
  const after = draft.content;

  if ((live?.internalName ?? '') !== draft.internalName) {
    content.push({ id: 'text', values: { field: 'internalName', value: draft.internalName } });
  }
  for (const field of ['title', 'body', 'ctaLabel'] as const) {
    const was = textOf(before, field);
    const now = textOf(after, field);
    if (was === now) continue;
    content.push(
      now === ''
        ? { id: 'text-removed', values: { field } }
        : { id: 'text', values: { field, value: now } },
    );
  }

  const linkWas = before?.link ?? null;
  const linkNow = after?.link ?? null;
  if (linkWas?.type !== linkNow?.type || linkWas?.id !== linkNow?.id) {
    link.push(
      linkNow === null
        ? { id: 'link-removed', values: {} }
        : { id: 'link', values: { type: words.link(linkNow.type), target: linkNow.id } },
    );
  }

  const imageWas = before?.image ?? null;
  const imageNow = after?.image ?? null;
  if (imageWas?.ref !== imageNow?.ref) {
    content.push(
      imageNow === null
        ? { id: 'image-removed', values: {} }
        : { id: 'image', values: { image: imageNow.ref } },
    );
  } else if (imageNow !== null && imageWas?.alt !== imageNow.alt) {
    content.push({ id: 'alt', values: { value: imageNow.alt } });
  }

  if ((live?.sponsored ?? false) !== draft.sponsored) {
    flags.push({ id: draft.sponsored ? 'sponsored-on' : 'sponsored-off', values: {} });
  }
  if ((live?.pinned ?? false) !== draft.pinned) {
    flags.push({ id: draft.pinned ? 'pinned-on' : 'pinned-off', values: {} });
  }

  if (live === null || live.startsAt !== draft.startsAt || live.endsAt !== draft.endsAt) {
    when.push({ id: 'window', values: { window: words.window(draft.startsAt, draft.endsAt) } });
  }

  const wasPlaced = new Map((live?.placements ?? []).map((p) => [placementKey(p), p]));
  const nowPlaced = new Map(draft.placements.map((p) => [placementKey(p), p]));
  for (const [key, placement] of nowPlaced) {
    if (!wasPlaced.has(key)) {
      where.push({ id: 'position-added', values: { place: describe(placement, words) } });
    }
  }
  for (const [key, placement] of wasPlaced) {
    if (!nowPlaced.has(key)) {
      where.push({ id: 'position-removed', values: { place: describe(placement, words) } });
    }
  }
  // A slide that was never live reads best by where, when and what it opens; a changed one by
  // what was edited first.
  return live === null
    ? [{ id: 'first', values: {} }, ...where, ...when, ...link, ...content, ...flags]
    : [...content, ...link, ...flags, ...when, ...where];
}
