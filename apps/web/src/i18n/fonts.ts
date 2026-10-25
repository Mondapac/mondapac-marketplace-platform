// Fonts for the scripts the Latin brand fonts do not cover. Only a page in such a language loads
// the extra stylesheet; the CSS stacks (app/globals.css, `:root[lang|=...]`) keep Figtree and
// Plus Jakarta Sans first, so Latin digits and brand text stay in the brand fonts.
const GOOGLE_FONTS = 'https://fonts.googleapis.com/css2?family=';

const SCRIPT_FONTS: Readonly<Record<string, string>> = {
  fa: `${GOOGLE_FONTS}Vazirmatn:wght@400;500;600;700&display=swap`,
  ar: `${GOOGLE_FONTS}Noto+Sans+Arabic:wght@400;500;600;700&display=swap`,
};

/** The stylesheet of the extra script font a language needs, or null (English loads none). */
export function scriptFontHref(locale: string): string | null {
  return SCRIPT_FONTS[locale.split('-')[0]!.toLowerCase()] ?? null;
}
