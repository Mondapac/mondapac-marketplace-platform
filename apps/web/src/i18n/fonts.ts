import localFont from 'next/font/local';

// Self-hosted: the woff2 files live in the repo (./font-files, SIL Open Font License, licence text
// next to them), so `next build` never needs the internet and the browser never contacts Google
// for a font (no visitor IP goes there before consent; a blocked Google Fonts cannot change layout).
// The CSS stacks (app/globals.css) use the variables; Figtree and Plus Jakarta Sans stay first, so
// Latin digits and brand text keep the brand look in every language.
const figtree = localFont({
  src: [
    { path: './font-files/figtree-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './font-files/figtree-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './font-files/figtree-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './font-files/figtree-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-figtree',
});

const jakarta = localFont({
  src: [
    {
      path: './font-files/plus-jakarta-sans-latin-600-normal.woff2',
      weight: '600',
      style: 'normal',
    },
    {
      path: './font-files/plus-jakarta-sans-latin-700-normal.woff2',
      weight: '700',
      style: 'normal',
    },
    {
      path: './font-files/plus-jakarta-sans-latin-800-normal.woff2',
      weight: '800',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-jakarta',
});

// Script fonts are not preloaded: only a page in that language uses them.
const vazirmatn = localFont({
  src: [
    { path: './font-files/vazirmatn-arabic-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './font-files/vazirmatn-arabic-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './font-files/vazirmatn-arabic-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './font-files/vazirmatn-arabic-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  variable: '--font-vazirmatn',
});

const notoArabic = localFont({
  src: [
    {
      path: './font-files/noto-sans-arabic-arabic-400-normal.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: './font-files/noto-sans-arabic-arabic-500-normal.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: './font-files/noto-sans-arabic-arabic-600-normal.woff2',
      weight: '600',
      style: 'normal',
    },
    {
      path: './font-files/noto-sans-arabic-arabic-700-normal.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  display: 'swap',
  preload: false,
  variable: '--font-noto-arabic',
});

const SCRIPT_FONTS: Readonly<Record<string, string>> = {
  fa: vazirmatn.variable,
  ar: notoArabic.variable,
};

/** The class names (CSS variables) of the fonts a page in this language needs, for `<html>`. */
export function fontClassNames(locale: string): string {
  const script = SCRIPT_FONTS[locale.split('-')[0]!.toLowerCase()];
  return script === undefined
    ? `${figtree.variable} ${jakarta.variable}`
    : `${figtree.variable} ${jakarta.variable} ${script}`;
}
