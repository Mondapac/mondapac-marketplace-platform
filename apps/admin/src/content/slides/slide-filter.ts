import type { SlideKind, SlideSummary } from './slide-types.ts';

export interface ListFilter {
  readonly kind: SlideKind | 'all';
  readonly search: string;
}

/** The filters that act in the browser: the slide's type and a part of its internal name. */
export function filterSlides(
  slides: readonly SlideSummary[],
  filter: ListFilter,
): readonly SlideSummary[] {
  const needle = filter.search.trim().toLocaleLowerCase();
  return slides.filter(
    (slide) =>
      (filter.kind === 'all' || slide.kind === filter.kind) &&
      (needle === '' || slide.internalName.toLocaleLowerCase().includes(needle)),
  );
}
