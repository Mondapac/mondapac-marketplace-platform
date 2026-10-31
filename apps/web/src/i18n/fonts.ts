import { Figtree, Noto_Sans_Arabic, Plus_Jakarta_Sans, Vazirmatn } from 'next/font/google';

// Self-hosted at build by next/font: the browser never contacts Google for a font, so no visitor
// IP goes there before consent and a blocked Google Fonts cannot change the layout.
// The CSS stacks (app/globals.css) use the variables; Figtree and Plus Jakarta Sans stay first, so
// Latin digits and brand text keep the brand look in every language.
const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-figtree',
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
  variable: '--font-jakarta',
});

// Script fonts are not preloaded: only a page in that language uses them.
const vazirmatn = Vazirmatn({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  preload: false,
  variable: '--font-vazirmatn',
});

const notoArabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
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
