// The storefront's screen widths (src/shell/breakpoints.ts): globals.css may use the canonical
// edges and, until their layouts are reworked, the older values listed here; any other width in a
// media query fails this test, so a new stray breakpoint cannot slip in.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, CANONICAL_WIDTHS, below, from, under } from '../src/shell/breakpoints.ts';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/**
 * Widths older than the four ranges. Each stays until its layout is reworked; do not add to this
 * list without saying why in the pull request. The key is the width, the value is the reason.
 */
const LEGACY_WIDTHS: Readonly<Record<number, string>> = {
  420: 'one-column seller grid on a narrow phone',
  520: 'smaller halal seal on cards',
  600: 'two-column footer trust band',
  760: 'Deliver to dialog becomes a full-screen sheet (also NARROW in deliver-modal.tsx)',
  999.98: 'cart, checkout and product: the one-column layout under 1000px (pairs with 1000)',
  1000: 'cart, checkout and product: the two-column layout from 1000px (also WIDE in seller-card.tsx)',
  1000.98: 'seller page: the tablet layout runs to 1000px (the desktop layout starts at 1001px)',
  1100: 'wider product grid',
  1140: 'page area wide enough for the larger grid beside the 240px rail',
  1600: 'widest product grid',
};

/** Every width a media query of `source` tests, with the query it comes from. */
function mediaWidths(source: string): { width: number; query: string }[] {
  const found: { width: number; query: string }[] = [];
  for (const match of source.matchAll(/@media([^{]+)\{/g)) {
    const query = match[1]!.trim();
    for (const feature of query.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g))
      found.push({ width: Number(feature[2]), query });
    // A range spelling (`width >= 700px`) is not used; refuse it rather than skip it.
    expect(query, 'use min-width / max-width in a media query').not.toMatch(/\bwidth\s*[<>=]/);
  }
  return found;
}

describe('breakpoints', () => {
  it('names four ranges: phone under 700, tablet 700, desktop 900, wide 1340', () => {
    expect(BREAKPOINTS).toEqual({ tablet: 700, desktop: 900, wide: 1340 });
    expect(CANONICAL_WIDTHS).toEqual([699.98, 700, 899.98, 900, 1339.98, 1340]);
    expect(below(700)).toBe(699.98);
    expect(from('desktop')).toBe('(min-width: 900px)');
    expect(under('tablet')).toBe('(max-width: 699.98px)');
  });

  it('uses only canonical widths and the listed older ones in globals.css media queries', () => {
    const allowed = new Set([...CANONICAL_WIDTHS, ...Object.keys(LEGACY_WIDTHS).map(Number)]);
    const stray = mediaWidths(css).filter(({ width }) => !allowed.has(width));
    expect(stray).toEqual([]);
  });

  it('spells a range edge one way: min-width at the edge, max-width a hundredth below', () => {
    for (const { width, query } of mediaWidths(css)) {
      if (CANONICAL_WIDTHS.includes(width)) continue;
      // An older value is never the 1px-off spelling of a canonical edge (701, 700.98, 900.98, ...).
      for (const edge of Object.values(BREAKPOINTS))
        expect(Math.abs(width - edge) < 2 && width !== edge, `${width} in ${query}`).toBe(false);
    }
  });

  it('keeps the older list honest: every entry is still used', () => {
    const used = new Set(mediaWidths(css).map(({ width }) => width));
    for (const width of Object.keys(LEGACY_WIDTHS).map(Number))
      expect(
        used.has(width),
        `${width} is no longer in a media query: remove it from the list`,
      ).toBe(true);
  });

  it('uses every canonical edge', () => {
    const used = new Set(mediaWidths(css).map(({ width }) => width));
    for (const edge of Object.values(BREAKPOINTS)) {
      expect(used.has(edge), `min-width: ${edge}px`).toBe(true);
    }
    expect(used.has(below(BREAKPOINTS.tablet))).toBe(true);
    expect(used.has(below(BREAKPOINTS.desktop))).toBe(true);
  });

  it('keeps every matchMedia width in the code canonical or listed', () => {
    const allowed = new Set([...CANONICAL_WIDTHS, ...Object.keys(LEGACY_WIDTHS).map(Number)]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);
    const stray: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g))
        if (!allowed.has(Number(match[2]))) stray.push(`${file}: ${match[0]}`);
    }
    expect(stray).toEqual([]);
  });
});
