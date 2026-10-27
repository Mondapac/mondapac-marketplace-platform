import { describe, expect, it } from 'vitest';
import { changesOf, type ChangeWords } from './slide-changes.ts';
import { CATEGORY, version } from './test-data.ts';
import type { SlidePlacement } from './slide-types.ts';

const words: ChangeWords = {
  position: (position) => `P:${position}`,
  scope: (placement) => `S:${placement.scope}`,
  window: (from, to) => `W:${from}..${to}`,
  link: (type) => `L:${type}`,
};
const placement = (patch: Partial<SlidePlacement> = {}): SlidePlacement => ({
  position: 'home.hero',
  scope: 'all',
  scopeId: null,
  includeSubcategories: false,
  sortOrder: 0,
  autoplay: false,
  ...patch,
});
const ids = (live: ReturnType<typeof version> | null, draft: ReturnType<typeof version>) =>
  changesOf(live, draft, words).map((change) => change.id);

describe('changes of a draft against the live version', () => {
  it('has no line for a draft equal to the live version', () => {
    expect(changesOf(version(), version({ versionNo: 3 }), words)).toEqual([]);
  });

  it('names a changed text with its new value, and a removed one without', () => {
    const live = version();
    const draft = version({
      internalName: 'New name',
      content: { ...live.content!, title: 'New headline', body: undefined as never },
    });
    const lines = changesOf(live, draft, words);
    expect(lines).toContainEqual({
      id: 'text',
      values: { field: 'internalName', value: 'New name' },
    });
    expect(lines).toContainEqual({ id: 'text', values: { field: 'title', value: 'New headline' } });
    expect(lines).toContainEqual({ id: 'text-removed', values: { field: 'body' } });
    // Text the editor did not touch is not listed.
    expect(lines.some((line) => line.values.field === 'ctaLabel')).toBe(false);
  });

  it('lists a changed or removed link, image, description and the flags', () => {
    const live = version();
    const draft = version({
      sponsored: true,
      pinned: true,
      content: {
        ...live.content!,
        link: { type: 'seller', id: CATEGORY },
        image: { ref: 'bread', alt: 'A new description', decorative: false },
      },
    });
    expect(changesOf(live, draft, words)).toEqual([
      { id: 'alt', values: { value: 'A new description' } },
      { id: 'link', values: { type: 'L:seller', target: CATEGORY } },
      { id: 'sponsored-on', values: {} },
      { id: 'pinned-on', values: {} },
    ]);
    const bare = version({ content: { ...live.content!, link: undefined, image: undefined } });
    expect(ids(live, bare)).toEqual(['image-removed', 'link-removed']);
    expect(ids(version({ sponsored: true, pinned: true }), version())).toEqual([
      'sponsored-off',
      'pinned-off',
    ]);
  });

  it('lists a new window and added or removed placements, by position and scope', () => {
    const live = version({ placements: [placement(), placement({ position: 'home.mid' })] });
    const draft = version({
      endsAt: '2026-11-10T13:59:00Z',
      placements: [
        placement(),
        placement({ position: 'category.top', scope: 'category', scopeId: CATEGORY }),
      ],
    });
    expect(changesOf(live, draft, words)).toEqual([
      { id: 'window', values: { window: 'W:2026-10-26T14:00:00Z..2026-11-10T13:59:00Z' } },
      { id: 'position-added', values: { place: 'P:category.top, S:category' } },
      { id: 'position-removed', values: { place: 'P:home.mid' } },
    ]);
  });

  it('reads a change of scope as one removed and one added placement', () => {
    const live = version({ placements: [placement({ position: 'category.top' })] });
    const draft = version({
      placements: [placement({ position: 'category.top', scope: 'category', scopeId: CATEGORY })],
    });
    expect(ids(live, draft)).toEqual(['position-added', 'position-removed']);
  });
});

describe('changes of a slide that was never live', () => {
  it('starts with the first-version line, then where and when, and what it opens', () => {
    const draft = version({ placements: [placement(), placement({ position: 'home.mid' })] });
    const lines = ids(null, draft);
    expect(lines.slice(0, 5)).toEqual([
      'first',
      'position-added',
      'position-added',
      'window',
      'link',
    ]);
    expect(lines).toContain('text');
    expect(lines).toContain('image');
  });
});
