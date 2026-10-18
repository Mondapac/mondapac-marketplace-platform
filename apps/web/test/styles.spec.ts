// Source checks of the storefront sheet: colours only as tokens, and the palettes a customer can
// pick each define the same brand tokens.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTES } from '../src/preferences/preferences.ts';

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
});
