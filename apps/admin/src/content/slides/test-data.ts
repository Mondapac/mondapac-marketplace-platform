import type { SlideDetail, SlideSummary, SlideVersion } from './slide-types.ts';

export const ID = '0190a000-0000-7000-8000-0000000000a1';
export const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';

export const summary = (patch: Partial<SlideSummary> & { id: string }): SlideSummary => ({
  kind: 'promotion',
  internalName: 'Slide',
  status: 'live',
  startsAt: '2026-10-23T20:00:00Z',
  endsAt: '2026-10-26T13:59:00Z',
  pinned: false,
  sponsored: false,
  hasDraft: false,
  positions: ['home.hero'],
  updatedAt: '2026-10-22T00:00:00Z',
  ...patch,
});

export const version = (patch: Partial<SlideVersion> = {}): SlideVersion => ({
  id: '0190a000-0000-7000-8000-0000000000b1',
  versionNo: 2,
  internalName: 'Diwali sweets week',
  content: {
    title: 'Diwali sweets, delivered',
    body: 'Barfi, ladoo and jalebi.',
    ctaLabel: 'Shop sweets',
    image: { ref: 'bread', alt: 'A tray of sweets', decorative: false },
    textPosition: 'start',
    textTone: 'light',
    link: { type: 'category', id: CATEGORY },
  },
  placements: [
    {
      position: 'home.hero',
      scope: 'all',
      scopeId: null,
      includeSubcategories: false,
      sortOrder: 0,
      autoplay: false,
    },
  ],
  startsAt: '2026-10-26T14:00:00Z',
  endsAt: '2026-11-03T13:59:00Z',
  pinned: false,
  sponsored: false,
  createdAt: '2026-10-24T00:00:00Z',
  approvedAt: null,
  ...patch,
});

export const detail = (patch: Partial<SlideDetail> = {}): SlideDetail => ({
  ...summary({ id: ID, internalName: 'Diwali sweets week', status: 'scheduled' }),
  hasDraft: true,
  draft: version({ versionNo: 3 }),
  live: version({ versionNo: 2, approvedAt: '2026-10-24T01:00:00Z' }),
  pending: false,
  versions: [],
  ...patch,
});
