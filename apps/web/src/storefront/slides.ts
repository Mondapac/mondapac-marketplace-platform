import type { HeroSlide, SlideSet } from './types.ts';

// The buyer site's check of the slider read (`GET storefront/slides`). The answer is untrusted
// data: every text is plain text, every link a site path, every image a ready-made placeholder
// of this app or a URL on our own media origin. A slide that fails any check is dropped on its
// own; the others and the page stay. The API checks the same things when a slide is saved, so a
// drop here means a bug or a tampered answer, never an editor's mistake.

export const TITLE_MAX = 60;
export const BODY_MAX = 160;
export const CTA_MAX = 24;
export const ALT_MAX = 160;

/** Positions the app knows: the most slides shown and whether autoplay is allowed there. */
export const SLIDE_POSITIONS: Readonly<
  Record<string, { readonly max: number; readonly autoplay: boolean }>
> = Object.freeze({
  'home.hero': { max: 8, autoplay: true },
  'home.mid': { max: 4, autoplay: false },
  'category.top': { max: 4, autoplay: false },
  'product.below-details': { max: 3, autoplay: false },
  'cart.below-lines': { max: 3, autoplay: false },
  'landing.top': { max: 8, autoplay: true },
});

/** The ready-made images the buyer app holds, by their key (`/placeholders/<key>.jpg`). */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'apple',
  'banana',
  'bread',
  'cheese',
  'chicken',
  'coconut',
  'egg',
  'fruits',
  'meat',
  'orange',
  'salmon',
  'watermelon',
]);

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SLIDE_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SITE_PATH = /^\/(?![/\\])[A-Za-z0-9/_.~?=&+-]*$/u;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|\bjavascript:)/iu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** Plain text of 1..max characters: no markup characters, no control characters, no URL. */
export function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || Array.from(text).length > max) return undefined;
  if (/[<>]/u.test(text) || CONTROL.test(text) || URL_LIKE.test(text)) return undefined;
  return text;
}

/** A site path only (`/offers`, `/c/meat/lamb?x=1`); never `//host`, a scheme or a dot segment. */
export function sitePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200 || !SITE_PATH.test(value)) return undefined;
  return value.split(/[/?]/u).includes('..') ? undefined : value;
}

/**
 * The URL of an image the answer names: a placeholder key becomes our own `/placeholders/` path;
 * a `url` is accepted only on the media origin (`STOREFRONT_IMAGE_ORIGIN`) with a plain path.
 */
export function imageSrcOf(image: Json, mediaOrigin: string | null): string | undefined {
  if (typeof image.key === 'string') {
    return PLACEHOLDER_KEYS.has(image.key) ? `/placeholders/${image.key}.jpg` : undefined;
  }
  if (typeof image.url === 'string' && mediaOrigin !== null) {
    try {
      const url = new URL(image.url);
      if (
        url.origin === mediaOrigin &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        /^\/[A-Za-z0-9/_.~-]+$/u.test(url.pathname)
      ) {
        return url.href;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** One answered slide, or null when any field fails its check. */
export function slideOf(raw: unknown, mediaOrigin: string | null): HeroSlide | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || !SLIDE_ID.test(raw.id)) return null;
  const title = plainText(raw.title, TITLE_MAX);
  if (title === undefined) return null;
  const body =
    raw.body === null || raw.body === undefined ? undefined : plainText(raw.body, BODY_MAX);
  if (raw.body !== null && raw.body !== undefined && body === undefined) return null;
  let href: string | undefined;
  if (raw.href !== null && raw.href !== undefined) {
    href = sitePath(raw.href);
    if (href === undefined) return null;
  }
  let ctaLabel: string | undefined;
  if (raw.ctaLabel !== null && raw.ctaLabel !== undefined) {
    ctaLabel = plainText(raw.ctaLabel, CTA_MAX);
    // A button label with nothing to open is not shown.
    if (ctaLabel === undefined || href === undefined) return null;
  }
  const placement = raw.textPosition;
  const tone = raw.textTone;
  if (placement !== 'start' && placement !== 'center' && placement !== 'end') return null;
  if (tone !== 'light' && tone !== 'dark') return null;
  if (typeof raw.sponsored !== 'boolean') return null;
  let image: HeroSlide['image'];
  if (raw.image !== null && raw.image !== undefined) {
    if (!isObject(raw.image) || typeof raw.image.decorative !== 'boolean') return null;
    const src = imageSrcOf(raw.image, mediaOrigin);
    if (src === undefined) return null;
    const alt = raw.image.decorative ? '' : plainText(raw.image.alt, ALT_MAX);
    if (alt === undefined) return null;
    if (raw.image.decorative && raw.image.alt !== '' && raw.image.alt !== undefined) return null;
    image = { src, alt, decorative: raw.image.decorative };
  }
  return {
    id: raw.id,
    title,
    ...(body === undefined ? {} : { body }),
    ...(ctaLabel === undefined ? {} : { ctaLabel }),
    ...(href === undefined ? {} : { href }),
    ...(image === undefined ? {} : { image }),
    placement,
    tone,
    sponsored: raw.sponsored,
  };
}

export const emptySet = (position: string): SlideSet => ({ position, autoplay: false, slides: [] });

/**
 * The slides of an answer for `position`: only valid slides, no repeated id, at most the most the
 * position shows, and autoplay only where the position allows it. An answer that is not for this
 * position, or not the expected shape, is no slides at all.
 */
export function slideSetOf(body: unknown, position: string, mediaOrigin: string | null): SlideSet {
  const definition = SLIDE_POSITIONS[position];
  if (definition === undefined || !isObject(body) || body.position !== position) {
    return emptySet(position);
  }
  if (!Array.isArray(body.slides)) return emptySet(position);
  const slides: HeroSlide[] = [];
  const seen = new Set<string>();
  for (const raw of body.slides as unknown[]) {
    if (slides.length >= definition.max) break;
    const slide = slideOf(raw, mediaOrigin);
    if (slide === null || seen.has(slide.id)) continue;
    seen.add(slide.id);
    slides.push(slide);
  }
  return {
    position,
    autoplay: definition.autoplay && body.autoplay === true && slides.length > 1,
    slides,
  };
}

/**
 * The home banner module as a slide (the migration of the old top banner into the slider): used
 * only while the library holds no live slide for the hero. Its title may be longer than a slide
 * title; it is cut to the slide's length. A link that is not a site path (the old banner allowed
 * an https address) is left out with its button: slides have no external links.
 */
export function legacySlideOf(
  config: Json,
  id: string,
  placeholderKeys: ReadonlySet<string> = PLACEHOLDER_KEYS,
): HeroSlide | null {
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim() !== ''
      ? Array.from(value.trim()).slice(0, max).join('')
      : undefined;
  const title = text(config.title, TITLE_MAX);
  if (title === undefined) return null;
  const body = text(config.subtitle, BODY_MAX);
  const href = sitePath(config.href);
  const label = text(config.ctaLabel, CTA_MAX);
  const ref = isObject(config.image) ? config.image.ref : undefined;
  const alt = isObject(config.image) ? text(config.image.alt, ALT_MAX) : undefined;
  const hasImage = typeof ref === 'string' && placeholderKeys.has(ref);
  return {
    id: SLIDE_ID.test(id) ? id : 'legacy-banner',
    title,
    ...(body === undefined ? {} : { body }),
    ...(href !== undefined && label !== undefined ? { href, ctaLabel: label } : {}),
    ...(href !== undefined && label === undefined ? { href } : {}),
    ...(hasImage
      ? {
          image: {
            src: `/placeholders/${ref}.jpg`,
            alt: alt ?? '',
            decorative: alt === undefined,
          },
        }
      : {}),
    placement: 'start',
    tone: 'dark',
    sponsored: false,
  };
}
