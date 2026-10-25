import 'server-only';
import { apiGet, type ApiRead } from './api.ts';
import { storefrontApiConfig } from './config.ts';
import { sampleFallback } from './home-source.ts';
import { SAMPLE_HERO } from './sample-home.ts';
import { emptySet, SLIDE_POSITIONS, slideSetOf } from './slides.ts';
import type { SlideSet } from './types.ts';

// The buyer site's read of one slider position (`GET storefront/slides`, storefront slider PR 2).
// The answer is checked slide by slide (./slides.ts); a slide that fails is dropped. With
// API_BASE_URL empty, or while the read fails and the sample fallback is on (home-source's
// STOREFRONT_SAMPLE_DATA), the sample slides of the position stand in; an answer with no live slide is
// no slides, and the section is not drawn. The home page reads its hero together with the rest of
// the page (./home-source.ts), where the old top banner is the stand-in.

/** The scope of the page the slider is asked for; every id is a UUID the page already holds. */
export interface SlideScope {
  readonly category?: string;
  readonly product?: string;
  readonly seller?: string;
  readonly page?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The sample slides of a position: the home hero has some; other positions have none. */
const sampleSet = (position: string): SlideSet =>
  position === 'home.hero' ? SAMPLE_HERO : emptySet(position);

/** The path of a position's read; null for a position the app does not know or a bad id. */
export function slidesPath(position: string, scope: SlideScope = {}): string | null {
  if (SLIDE_POSITIONS[position] === undefined) return null;
  const query = [`position=${encodeURIComponent(position)}`];
  for (const key of ['category', 'product', 'seller', 'page'] as const) {
    const id = scope[key];
    if (id === undefined) continue;
    if (!UUID.test(id)) return null;
    query.push(`${key}=${encodeURIComponent(id.toLowerCase())}`);
  }
  return `storefront/slides?${query.join('&')}`;
}

export type SlidesReader = (path: string) => Promise<ApiRead<unknown>>;

/** The slides of a position for a page: the API's when API_BASE_URL is set, else the sample. */
export async function loadSlides(
  position: string,
  scope: SlideScope = {},
  read: SlidesReader = apiGet,
  env: Readonly<Record<string, string | undefined>> = process.env,
  mediaOrigin: string | null = storefrontApiConfig()?.imageOrigin ?? null,
): Promise<SlideSet> {
  const path = slidesPath(position, scope);
  if (path === null) return emptySet(position);
  const answer = await read(path);
  if (answer.kind === 'off') return sampleSet(position);
  if (answer.kind === 'failed')
    return sampleFallback(env) ? sampleSet(position) : emptySet(position);
  return slideSetOf(answer.body, position, mediaOrigin);
}
