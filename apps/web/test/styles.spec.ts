// Source checks of the storefront sheet: colours only as tokens, and the palettes a customer can
// pick each define the same brand tokens.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTES, PALETTE_SWATCHES } from '../src/preferences/preferences.ts';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/** The body of every rule whose selector starts with `prefix`. */
function rules(prefix: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css))
    if (m[1]!.trim().startsWith(prefix)) out.push(m[2]!);
  return out;
}

describe('storefront styles', () => {
  it('writes hex colours only in the token blocks on :root', () => {
    const outside = css
      .replace(/:root(\[[^\]]*\])?\s*\{[^}]*\}/g, '')
      .split('\n')
      .filter((line) => HEX.test(line));
    expect(outside).toEqual([]);
  });

  it('gives every non-default palette the same brand tokens', () => {
    for (const code of PALETTES.filter((p) => p !== 'B')) {
      const [body] = rules(`:root[data-palette='${code}']`);
      expect(body, code).toBeDefined();
      for (const token of ['--sf-teal', '--sf-lagoon', '--sf-saffron', '--sf-mist', '--sf-ink'])
        expect(body, `${code} ${token}`).toContain(`${token}:`);
    }
  });

  it('draws the picker swatches in the same colours as the palette tokens', () => {
    for (const code of PALETTES) {
      const body =
        code === 'B'
          ? rules(':root').find((b) => b.includes('--sf-teal:'))!
          : rules(`:root[data-palette='${code}']`)[0]!;
      const token = (name: string) =>
        new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body)?.[1]?.toLowerCase();
      const [teal, lagoon, saffron] = PALETTE_SWATCHES[code].map((c) => c.toLowerCase());
      expect([token('--sf-teal'), token('--sf-lagoon'), token('--sf-saffron')], code).toEqual([
        teal,
        lagoon,
        saffron,
      ]);
    }
  });

  it('keeps the verified seal one colour in every palette (CERT-24)', () => {
    for (const code of PALETTES.filter((p) => p !== 'B'))
      expect(rules(`:root[data-palette='${code}']`)[0]).not.toContain('--sf-certified');
    expect(css).toMatch(/--sf-certified:\s*#[0-9a-fA-F]{6};/);
  });
});

describe('slider styles', () => {
  it('gives every control a 44 px target', () => {
    const [body] = rules('.slider-btn,');
    expect(body).toContain('min-width: 44px');
    expect(body).toContain('min-height: 44px');
    expect(rules('.slide-cta')[0]).toContain('min-height: 44px');
  });

  it('keeps a fixed aspect ratio on the frame and lets the track scroll with scroll-snap', () => {
    const [body] = rules('.slider-track');
    expect(body).toContain('aspect-ratio: var(--slider-ratio)');
    expect(body).toContain('scroll-snap-type: x mandatory');
  });

  it('flips the arrows in right-to-left text and uses logical placement for the text', () => {
    expect(css).toMatch(/:dir\(rtl\) \.slider-arrow\s*\{\s*transform:\s*scaleX\(-1\)/);
    const [text] = rules('.slide-text');
    expect(text).toContain('text-align: start');
    expect(rules('.slide-inner')[0]).not.toMatch(/(?:left|right)\s*:/);
  });

  it('makes no smooth scrolling in CSS (the script decides, and never with reduced motion)', () => {
    expect(css).not.toMatch(/scroll-behavior:\s*smooth/);
  });

  it('shows a visible focus ring on the slide link and the controls', () => {
    expect(css).toMatch(
      /\.slide-inner:focus-visible::after\s*\{[^}]*outline:\s*3px solid var\(--sf-ink\)[^}]*inset 0 0 0 5px var\(--sf-white\)/,
    );
    expect(css).toMatch(/\.slider-btn:focus-visible[^{]*\{[^}]*outline:\s*3px/);
  });

  it('draws the scrim from tokens of both tones', () => {
    for (const token of [
      '--sf-slide-scrim-dark',
      '--sf-slide-scrim-dark-clear',
      '--sf-slide-scrim-light',
      '--sf-slide-scrim-light-clear',
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });
});
