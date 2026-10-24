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

  it('sticks the page action bars above the dock by its token, never by a fixed number', () => {
    for (const selector of ['.buybar', '.cbar'])
      for (const body of rules(selector).filter((b) => b.includes('bottom:')))
        expect(body, selector).toContain('--sf-dock-height');
    expect(css).not.toMatch(/bottom:\s*calc\(78px/);
  });

  it('hides the tab bar while the on-screen keyboard is open', () => {
    expect(rules(":root[data-keyboard='open'] .tabbar")[0]).toContain('display: none');
  });

  it('keeps phone form fields at 16px or more (iOS Safari zooms into smaller ones)', () => {
    expect(css).toMatch(
      /@media \(max-width: 699\.98px\) \{\s*:is\(input, select, textarea\):not\(\[type='checkbox'\]\):not\(\[type='radio'\]\) \{\s*font-size: max\(16px, 1em\);/,
    );
  });
});
